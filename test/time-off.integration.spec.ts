import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { BalanceCache } from '../src/entities/balance-cache.entity';
import { Employee } from '../src/entities/employee.entity';
import { TimeOffRequest, TimeOffRequestStatus } from '../src/entities/time-off-request.entity';
import { HcmAdapterService } from '../src/hcm-adapter/hcm-adapter.service';

describe('TimeOff Integration', () => {
  let app: INestApplication<App>;
  let employeeRepository: Repository<Employee>;
  let requestRepository: Repository<TimeOffRequest>;
  let balanceRepository: Repository<BalanceCache>;
  let hcmAdapter: HcmAdapterService;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.MOCK_HCM_BASE_URL = 'http://127.0.0.1:3000';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(3000);

    employeeRepository = moduleFixture.get<Repository<Employee>>(getRepositoryToken(Employee));
    requestRepository = moduleFixture.get<Repository<TimeOffRequest>>(getRepositoryToken(TimeOffRequest));
    balanceRepository = moduleFixture.get<Repository<BalanceCache>>(getRepositoryToken(BalanceCache));
    hcmAdapter = moduleFixture.get(HcmAdapterService);
    dataSource = moduleFixture.get(DataSource);
    await dataSource.synchronize(true);
  });

  beforeEach(async () => {
    await requestRepository.clear();
    await balanceRepository.clear();
    await employeeRepository.clear();

    await employeeRepository.save(
      employeeRepository.create({
        id: 'emp-001',
        name: 'Test Employee',
        email: 'emp-001@example.com',
        locationId: 'loc-nyc',
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('Test Case 1 (Happy Path): creates PENDING request and updates BalanceCache', async () => {
    const payload = {
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveType: 'ANNUAL',
      startDate: '2026-05-10',
      endDate: '2026-05-11',
      daysRequested: 2,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };

    const response = await request(app.getHttpServer()).post('/time-off').send(payload).expect(201);

    expect(response.body.status).toBe(TimeOffRequestStatus.PENDING);

    const dbRequest = await requestRepository.findOneBy({ id: response.body.id });
    expect(dbRequest).not.toBeNull();
    expect(dbRequest?.status).toBe(TimeOffRequestStatus.PENDING);

    const cache = await balanceRepository.findOneBy({
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveType: 'ANNUAL',
    });
    expect(cache).not.toBeNull();
    expect(cache?.balanceDays).toBe(8);
    expect(cache?.syncSource).toBe('REALTIME');
  });

  it('Test Case 2 (Insufficient Balance): returns 400 when requesting above HCM balance', async () => {
    const payload = {
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveType: 'LOW_BALANCE',
      startDate: '2026-05-10',
      endDate: '2026-05-12',
      daysRequested: 10,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    };

    await request(app.getHttpServer()).post('/time-off').send(payload).expect(400);
  });

  it('Test Case 3 (Resilience): returns 503 when force-error=true is set', async () => {
    const payload = {
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveType: 'ANNUAL',
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      daysRequested: 1,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    };

    await request(app.getHttpServer())
      .post('/time-off')
      .set('x-force-error', 'true')
      .send(payload)
      .expect(503);
  });

  it("Test Case 4 (Idempotency): returns identical response and doesn't call HCM twice", async () => {
    const payload = {
      employeeId: 'emp-001',
      locationId: 'loc-nyc',
      leaveType: 'ANNUAL',
      startDate: '2026-05-15',
      endDate: '2026-05-15',
      daysRequested: 1,
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    };

    const getBalanceSpy = jest.spyOn(hcmAdapter, 'getBalance');

    const first = await request(app.getHttpServer()).post('/time-off').send(payload).expect(201);
    const second = await request(app.getHttpServer()).post('/time-off').send(payload).expect(201);

    expect(second.body).toEqual(first.body);
    expect(getBalanceSpy).toHaveBeenCalledTimes(1);

    getBalanceSpy.mockRestore();
  });
});
