import { Body, Controller, Get, Headers, InternalServerErrorException, Post, Query } from '@nestjs/common';

interface DeductRequestBody {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  requestId: string;
}

/**
 * Deterministic in-process Mock HCM API.
 *
 * Why this exists:
 * - Integration tests need predictable upstream responses without external setup.
 * - Forced error toggles allow explicit resilience-path verification.
 */
@Controller('mock-hcm')
export class MockHcmController {
  /**
   * Returns a synthetic balance response.
   *
   * `leaveType=LOW_BALANCE` intentionally simulates constrained availability for
   * insufficient-balance testing.
   */
  @Get('balance')
  getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Query('leaveType') leaveType: string,
    @Query('force-error') forceErrorQuery: string,
    @Headers('x-force-error') forceErrorHeader: string,
  ): { employeeId: string; locationId: string; leaveType: string; days: number } {
    this.throwIfForcedError(forceErrorQuery, forceErrorHeader);
    const days = leaveType === 'LOW_BALANCE' ? 5 : 10;

    return {
      employeeId,
      locationId,
      leaveType,
      days,
    };
  }

  /**
   * Returns a synthetic deduction response keyed by requestId.
   *
   * The generated deduction id mirrors idempotent HCM behavior expected by the TRD.
   */
  @Post('deduct')
  deductBalance(
    @Body() body: DeductRequestBody,
    @Query('force-error') forceErrorQuery: string,
    @Headers('x-force-error') forceErrorHeader: string,
  ): { deductionId: string; employeeId: string; remainingDays: number } {
    this.throwIfForcedError(forceErrorQuery, forceErrorHeader);

    return {
      deductionId: `deduct-${body.requestId}`,
      employeeId: body.employeeId,
      remainingDays: Math.max(0, 10 - body.days),
    };
  }

  /**
   * Shared test hook to emulate upstream 500 failures.
   */
  private throwIfForcedError(forceErrorQuery?: string, forceErrorHeader?: string): void {
    if (forceErrorQuery === 'true' || forceErrorHeader === 'true') {
      throw new InternalServerErrorException('Forced mock HCM error for circuit breaker testing.');
    }
  }
}
