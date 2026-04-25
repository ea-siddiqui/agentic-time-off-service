import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BalanceCache } from '../entities/balance-cache.entity';
import { TimeOffRequest, TimeOffRequestStatus } from '../entities/time-off-request.entity';
import { HcmAdapterService } from '../hcm-adapter/hcm-adapter.service';

export interface SubmitTimeOffDto {
  employeeId: string;
  locationId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  idempotencyKey: string;
  forceError?: boolean;
}

/**
 * Core domain service for time-off lifecycle orchestration.
 *
 * Why the design is intentionally strict:
 * - Idempotency prevents duplicate request creation during client retries.
 * - Per-employee async locking serializes verify-then-write operations to avoid
 *   race conditions where concurrent submissions can oversubscribe balance.
 * - Cache is treated as an optimization only; live HCM verification remains the
 *   source of truth before persistence.
 */
@Injectable()
export class TimeOffService {
  private readonly employeeLockMap = new Map<string, Promise<void>>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepository: Repository<TimeOffRequest>,
    @InjectRepository(BalanceCache)
    private readonly balanceCacheRepository: Repository<BalanceCache>,
    private readonly dataSource: DataSource,
    private readonly hcmAdapter: HcmAdapterService,
  ) {}

  /**
   * Implements TRD real-time submission flow:
   * cache pre-check -> HCM verification -> atomic persistence as PENDING.
   *
   * Idempotency is checked first so retrying the same request returns the original
   * entity and avoids duplicate HCM calls or duplicate DB writes.
   */
  async submitRequest(dto: SubmitTimeOffDto): Promise<TimeOffRequest> {
    this.validateSubmitDto(dto);

    return this.withEmployeeLock(dto.employeeId, async () => {
      const existing = await this.requestRepository.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return existing;
      }

      const cached = await this.balanceCacheRepository.findOne({
        where: {
          employeeId: dto.employeeId,
          locationId: dto.locationId,
          leaveType: dto.leaveType,
        },
      });

      if (cached && this.isFresh(cached) && !cached.isStale && cached.balanceDays < dto.daysRequested) {
        throw new BadRequestException('Insufficient balance (cached).');
      }

      const hcmBalance = await this.hcmAdapter.getBalance(dto.employeeId, dto.locationId, dto.leaveType, {
        forceError: dto.forceError,
      });
      if (hcmBalance.days - dto.daysRequested < 0) {
        throw new BadRequestException('Insufficient balance (HCM verified).');
      }

      return this.dataSource.transaction(async (manager) => {
        const request = manager.create(TimeOffRequest, {
          id: crypto.randomUUID(),
          employeeId: dto.employeeId,
          locationId: dto.locationId,
          leaveType: dto.leaveType,
          startDate: dto.startDate,
          endDate: dto.endDate,
          daysRequested: dto.daysRequested,
          status: TimeOffRequestStatus.PENDING,
          idempotencyKey: dto.idempotencyKey,
          hcmVerifiedAt: new Date(),
          hcmBalanceSnapshot: hcmBalance.days,
        });

        await manager.save(TimeOffRequest, request);

        const balanceRecord = await manager.findOne(BalanceCache, {
          where: {
            employeeId: dto.employeeId,
            locationId: dto.locationId,
            leaveType: dto.leaveType,
          },
        });

        if (balanceRecord) {
          balanceRecord.balanceDays = hcmBalance.days - dto.daysRequested;
          balanceRecord.lastSyncedAt = new Date();
          balanceRecord.syncSource = 'REALTIME';
          balanceRecord.isStale = false;
          await manager.save(BalanceCache, balanceRecord);
        } else {
          const created = manager.create(BalanceCache, {
            id: crypto.randomUUID(),
            employeeId: dto.employeeId,
            locationId: dto.locationId,
            leaveType: dto.leaveType,
            balanceDays: hcmBalance.days - dto.daysRequested,
            lastSyncedAt: new Date(),
            syncSource: 'REALTIME',
            isStale: false,
          });
          await manager.save(BalanceCache, created);
        }

        return request;
      });
    });
  }

  /**
   * Returns balance using cache-aside behavior.
   *
   * The cache is used for low-latency reads, but stale/missing records are refreshed
   * from HCM to keep read paths consistent with submission-time truth.
   */
  async getBalance(employeeId: string, locationId: string, leaveType: string): Promise<BalanceCache> {
    const cached = await this.balanceCacheRepository.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (cached && this.isFresh(cached) && !cached.isStale) {
      return cached;
    }

    const fresh = await this.hcmAdapter.getBalance(employeeId, locationId, leaveType);
    const now = new Date();

    if (cached) {
      cached.balanceDays = fresh.days;
      cached.lastSyncedAt = now;
      cached.syncSource = 'REALTIME';
      cached.isStale = false;
      return this.balanceCacheRepository.save(cached);
    }

    return this.balanceCacheRepository.save(
      this.balanceCacheRepository.create({
        id: crypto.randomUUID(),
        employeeId,
        locationId,
        leaveType,
        balanceDays: fresh.days,
        lastSyncedAt: now,
        syncSource: 'REALTIME',
        isStale: false,
      }),
    );
  }

  /**
   * Approves a pending request after a second live HCM check.
   *
   * The re-verification protects against balance drift between submission and
   * manager action, which is explicitly called out in the TRD.
   */
  async approveRequest(requestId: string, managerId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepository.findOne({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Time-off request not found.');
    }

    if (request.status !== TimeOffRequestStatus.PENDING) {
      throw new ConflictException(`Cannot approve request in status ${request.status}.`);
    }

    const hcmBalance = await this.hcmAdapter.getBalance(request.employeeId, request.locationId, request.leaveType);
    if (hcmBalance.days - request.daysRequested < 0) {
      throw new BadRequestException('Insufficient balance at approval time.');
    }

    const deduction = await this.hcmAdapter.deductBalance({
      employeeId: request.employeeId,
      locationId: request.locationId,
      leaveType: request.leaveType,
      days: request.daysRequested,
      requestId: request.id,
    });

    return this.dataSource.transaction(async (manager) => {
      request.status = TimeOffRequestStatus.APPROVED;
      request.hcmDeductionId = deduction.deductionId;
      request.approvedBy = managerId;
      request.approvedAt = new Date();

      await manager.save(TimeOffRequest, request);

      const cacheRecord = await manager.findOne(BalanceCache, {
        where: {
          employeeId: request.employeeId,
          locationId: request.locationId,
          leaveType: request.leaveType,
        },
      });

      const updatedBalance = hcmBalance.days - request.daysRequested;
      if (cacheRecord) {
        cacheRecord.balanceDays = updatedBalance;
        cacheRecord.lastSyncedAt = new Date();
        cacheRecord.syncSource = 'REALTIME';
        cacheRecord.isStale = false;
        await manager.save(BalanceCache, cacheRecord);
      } else {
        await manager.save(
          BalanceCache,
          manager.create(BalanceCache, {
            id: crypto.randomUUID(),
            employeeId: request.employeeId,
            locationId: request.locationId,
            leaveType: request.leaveType,
            balanceDays: updatedBalance,
            lastSyncedAt: new Date(),
            syncSource: 'REALTIME',
            isStale: false,
          }),
        );
      }

      return request;
    });
  }

  /**
   * Serializes critical sections by employeeId.
   *
   * Why lock per employee:
   * - Multiple concurrent submissions for the same person can all pass against the
   *   same upstream balance snapshot without serialization.
   * - Queueing by employee forces a fresh verify-then-commit sequence for each call.
   */
  private async withEmployeeLock<T>(employeeId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.employeeLockMap.get(employeeId) ?? Promise.resolve();

    let release: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.employeeLockMap.set(employeeId, queued);

    await previous;
    try {
      return await action();
    } finally {
      release!();
      if (this.employeeLockMap.get(employeeId) === queued) {
        this.employeeLockMap.delete(employeeId);
      }
    }
  }

  /**
   * Guards API contract before side effects.
   *
   * Early validation keeps failure modes explicit and prevents expensive HCM/DB
   * work for structurally invalid requests.
   */
  private validateSubmitDto(dto: SubmitTimeOffDto): void {
    if (!dto.employeeId || !dto.locationId || !dto.leaveType) {
      throw new BadRequestException('employeeId, locationId, and leaveType are required.');
    }
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException('startDate and endDate are required.');
    }
    if (!dto.idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required.');
    }
    if (dto.daysRequested <= 0) {
      throw new BadRequestException('daysRequested must be greater than zero.');
    }

    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw new BadRequestException('Invalid date range.');
    }
  }

  private isFresh(record: BalanceCache): boolean {
    return Date.now() - record.lastSyncedAt.getTime() <= this.cacheTtlMs;
  }
}
