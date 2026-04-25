import { Injectable } from '@nestjs/common';

/**
 * Baseline application service used by starter health endpoint.
 */
@Injectable()
export class AppService {
  /**
   * Provides a deterministic message for quick smoke validation.
   */
  getHello(): string {
    return 'Hello World!';
  }
}
