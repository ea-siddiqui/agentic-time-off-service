import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { BalanceCache } from '../entities/balance-cache.entity';
import { TimeOffService } from './time-off.service';
import type { SubmitTimeOffDto } from './time-off.service';

interface ApproveTimeOffDto {
  managerId: string;
}

/**
 * HTTP boundary for time-off use cases.
 *
 * Controllers remain thin by design: they translate transport details
 * (headers, params, body) into application service calls that enforce
 * concurrency, idempotency, and resilience invariants.
 */
@Controller('time-off')
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  /**
   * Submits a time-off request.
   *
   * `x-force-error` is accepted to intentionally drive HCM failures in integration
   * tests, validating circuit-breaker behavior end-to-end.
   */
  @Post()
  submitRequest(
    @Body() body: SubmitTimeOffDto,
    @Headers('x-force-error') forceErrorHeader?: string,
  ): Promise<TimeOffRequest> {
    return this.timeOffService.submitRequest({
      ...body,
      forceError: body.forceError ?? forceErrorHeader === 'true',
    });
  }

  /**
   * Reads balance for one employee/location/leave type tuple.
   *
   * Uses cache-aside semantics from the service layer.
   */
  @Get('balance/:employeeId')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveType') leaveType: string,
  ): Promise<BalanceCache> {
    return this.timeOffService.getBalance(employeeId, locationId, leaveType);
  }

  /**
   * Approves a pending request by manager identity.
   *
   * Approval logic includes a second HCM verification before deduction.
   */
  @Patch(':id/approve')
  approveRequest(@Param('id') id: string, @Body() body: ApproveTimeOffDto): Promise<TimeOffRequest> {
    return this.timeOffService.approveRequest(id, body.managerId);
  }
}
