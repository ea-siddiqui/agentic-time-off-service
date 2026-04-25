# ExampleHR Time-Off Microservice

NestJS + TypeORM microservice for real-time time-off request validation, approval, and balance caching as specified in the TRD.

## Tech Stack

- **Framework**: NestJS (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/typeorm`)
- **Language**: TypeScript
- **Database**: SQLite (`sqlite3`) with TypeORM (`typeorm`)
- **Validation & Transformation**: `class-validator`, `class-transformer`
- **Testing**: Jest (`jest`, `ts-jest`) and Supertest (`supertest`)
- **Concurrency Control**: In-process per-employee async lock implemented in `TimeOffService` (`Map<string, Promise<void>>`)
- **Resilience Control**: In-process circuit breaker implemented in `HcmAdapterService` (`CLOSED` / `OPEN` / `HALF_OPEN`, timeout + failure threshold)

## Key Features

- **Resilience (Circuit Breaker)**: Outbound HCM calls are wrapped with circuit-breaker logic (`CLOSED` / `OPEN` / `HALF_OPEN`) to fail fast during upstream outages and protect service latency.
- **Reliability (Idempotency)**: Request submission is guarded by `idempotencyKey` so client retries return the same result without creating duplicate requests or duplicate upstream side effects.
- **Concurrency (Per-Employee Serialized Locks)**: Critical submit flow is serialized per `employeeId` to prevent race conditions where concurrent requests oversubscribe available leave.

## How to Run

- `npm install` (Install dependencies)
- `npm run build` (Compile TypeScript)
- `npm run test` (Run the full test suite)

## Architectural Note

This service follows a **Cache-Aside with Real-time HCM Verification** pattern from the TRD:

- `BalanceCache` is used for low-latency reads and optimistic pre-checks.
- `submitRequest` and approval paths still perform live HCM verification before mutating request state.
- Cache entries are refreshed from verified HCM values to keep local data useful while preserving external source-of-truth guarantees.

The production integrity model is intentionally built on three controls that work together:

- **Circuit Breaker** to prevent cascading failures when HCM is unstable.
- **Idempotency** to guarantee safe client retry behavior.
- **Per-Employee Serialized Locks** to prevent concurrent oversubscription during verify-then-commit flows.

## Project Structure (Key Areas)

- `src/hcm-adapter/` - upstream HCM integration and circuit-breaker behavior
- `src/time-off/` - request submission, approval, idempotency, and lock orchestration
- `src/mock-hcm/` - deterministic mock upstream endpoints for resilience and integration testing
- `src/entities/` - TypeORM entities for requests, employees, cache, and idempotency
- `test/` - e2e and integration test suites
