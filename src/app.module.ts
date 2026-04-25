import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BalanceCache } from './entities/balance-cache.entity';
import { Employee } from './entities/employee.entity';
import { IdempotencyLog } from './entities/idempotency-log.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { HcmAdapterService } from './hcm-adapter/hcm-adapter.service';
import { MockHcmController } from './mock-hcm/mock-hcm.controller';
import { TimeOffController } from './time-off/time-off.controller';
import { TimeOffService } from './time-off/time-off.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'data/timeoff.db',
      entities: [Employee, TimeOffRequest, BalanceCache, IdempotencyLog],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([TimeOffRequest, BalanceCache, Employee, IdempotencyLog]),
  ],
  controllers: [AppController, TimeOffController, MockHcmController],
  providers: [AppService, TimeOffService, HcmAdapterService],
})
export class AppModule {}
