import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

/**
 * Minimal root controller for service health smoke checks.
 */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Returns a static response used by baseline app tests.
   */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
