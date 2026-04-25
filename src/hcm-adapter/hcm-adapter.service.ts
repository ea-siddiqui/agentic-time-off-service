import { Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface HcmBalance {
  days: number;
}

export interface HcmDeductionResult {
  deductionId: string;
}

/**
 * Isolates all HCM communication behind resilience controls.
 *
 * Why this exists:
 * - The Time-Off domain must fail safely when HCM is unstable.
 * - A circuit breaker prevents repeated slow/failing upstream calls from cascading
 *   latency across request submission and approval endpoints.
 * - This adapter centralizes timeout, failure counting, and protocol translation so
 *   business services stay focused on domain invariants.
 */
@Injectable()
export class HcmAdapterService {
  private readonly baseUrl = process.env.MOCK_HCM_BASE_URL ?? 'http://localhost:3000';
  private readonly timeoutMs = 5000;
  private readonly failureThreshold = 3;
  private readonly resetTimeoutMs = 30000;

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private openedAt: number | null = null;

  /**
   * Reads real-time balance from Mock HCM.
   *
   * A live read is required even when cache appears sufficient to enforce the TRD's
   * defensive arithmetic guard against stale or drifted balances.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    options?: { forceError?: boolean },
  ): Promise<HcmBalance> {
    const url = new URL('/mock-hcm/balance', this.baseUrl);
    url.searchParams.set('employeeId', employeeId);
    url.searchParams.set('locationId', locationId);
    url.searchParams.set('leaveType', leaveType);
    if (options?.forceError) {
      url.searchParams.set('force-error', 'true');
    }

    const response = await this.request(url.toString(), { method: 'GET' });
    const payload = (await response.json()) as { days?: number; balanceDays?: number };
    const days = payload.days ?? payload.balanceDays;

    if (typeof days !== 'number') {
      throw new UnprocessableEntityException('Mock HCM returned an invalid balance payload.');
    }

    return { days };
  }

  /**
   * Triggers HCM-side deduction using requestId as idempotency key.
   *
   * Keeping this call in the adapter guarantees one consistent contract for all
   * approval flows and allows retry/circuit behavior to evolve independently.
   */
  async deductBalance(params: {
    employeeId: string;
    locationId: string;
    leaveType: string;
    days: number;
    requestId: string;
  }): Promise<HcmDeductionResult> {
    const response = await this.request(`${this.baseUrl}/mock-hcm/deduct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const payload = (await response.json()) as { deductionId?: string };
    if (!payload.deductionId) {
      throw new UnprocessableEntityException('Mock HCM did not return a deductionId.');
    }

    return { deductionId: payload.deductionId };
  }

  /**
   * Executes HTTP calls under circuit-breaker control.
   *
   * Why OPEN/HALF_OPEN/CLOSED:
   * - CLOSED: normal traffic with failure observation.
   * - OPEN: fail-fast to protect caller throughput while upstream is degraded.
   * - HALF_OPEN: controlled probe after cool-down to determine recovery.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (!this.openedAt || now - this.openedAt < this.resetTimeoutMs) {
        throw new ServiceUnavailableException('HCM circuit is OPEN. Retry later.');
      }

      this.state = 'HALF_OPEN';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.status === 500) {
        this.recordFailure();
        throw new ServiceUnavailableException('Mock HCM is unavailable (HTTP 500).');
      }

      if (!response.ok) {
        this.recordSuccess();
        const errorText = await response.text();
        throw new UnprocessableEntityException(errorText || 'Mock HCM request failed.');
      }

      this.recordSuccess();
      return response;
    } catch (error: unknown) {
      const isAbortError =
        error instanceof DOMException
          ? error.name === 'AbortError'
          : typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            (error as { name?: string }).name === 'AbortError';

      if (isAbortError) {
        this.recordFailure();
        throw new ServiceUnavailableException('Mock HCM request timed out.');
      }

      if (error instanceof ServiceUnavailableException || error instanceof UnprocessableEntityException) {
        throw error;
      }

      this.recordFailure();
      throw new ServiceUnavailableException('Mock HCM request failed.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordSuccess(): void {
    this.failureCount = 0;
    this.openedAt = null;
    this.state = 'CLOSED';
  }

  private recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
