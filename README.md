# ExampleHR Time-Off Microservice

A production-grade NestJS microservice that manages employee time-off requests while preserving strict synchronization with an external Human Capital Management (HCM) system.

This project addresses a core distributed-systems challenge: maintaining local state that must remain consistent with a remote source of truth under concurrency, retries, and upstream failures.

## Architectural Overview

The central risk is balance drift. ExampleHR is not the only actor modifying HCM balances (for example, work anniversaries or policy refreshes), so a cached value can become stale at any time.

To handle this, the service implements a **Cache-Aside with Real-time HCM Verification** pattern:

- **Pessimistic verification on writes**: request submission and approval paths require live HCM balance verification.
- **Defensive domain checks**: the service enforces arithmetic guards locally, even when upstream responses are incomplete.
- **Dimensional precision**: balances are scoped by `employeeId`, `locationId`, and `leaveType`.

## Tech Stack

- **Framework**: NestJS (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/typeorm`)
- **Language**: TypeScript
- **Database**: SQLite (`sqlite3`) with TypeORM (`typeorm`)
- **Validation & Transformation**: `class-validator`, `class-transformer`
- **Testing**: Jest (`jest`, `ts-jest`) and Supertest (`supertest`)
- **Concurrency Control**: in-process per-employee serialized async lock in `TimeOffService` (`Map<string, Promise<void>>`)
- **Resilience Control**: in-process circuit breaker in `HcmAdapterService` (`CLOSED` / `OPEN` / `HALF_OPEN`, timeout + failure threshold)

## Key Engineering Controls

### 1) Resilience (Circuit Breaker)

Outbound HCM calls are protected by a circuit breaker to prevent cascading failures.  
When the upstream is unstable, the service fails fast with predictable behavior rather than degrading into long tail-latency.

### 2) Concurrency (Per-Employee Serialized Locks)

The `submitRequest` verify-then-commit flow is serialized per `employeeId`.  
This prevents race conditions where concurrent requests can over-allocate the same leave balance window.

### 3) Reliability (Idempotency)

Submission is guarded by `idempotencyKey`.  
If clients retry the same request, the existing result is replayed and duplicate side effects are avoided.

### 4) Integration Testing (Mock HCM)

The repository includes a built-in Mock HCM controller used by integration/e2e tests to simulate:

- normal balance responses
- low-balance conditions
- forced 500 errors for resilience-path verification

## How to Run

- `npm install` (Install dependencies)
- `npm run build` (Compile TypeScript)
- `npm run test` (Run the full test suite)

Optional local runtime:

- `npm run start:dev` (Start the microservice locally)

## Methodology

This codebase was delivered using an **agentic development workflow**:

- **Architecture-first**: the TRD defines invariants, flow contracts, and failure handling rules.
- **Implementation-through-constraints**: services, entities, and controllers are generated and iterated against those constraints.
- **Validation-driven quality**: integration and e2e tests are used to confirm resilience, concurrency, and idempotency behavior end-to-end.

## Deliverables Included

- Complete microservice implementation (`NestJS + TypeORM + SQLite`)
- `TimeOff_Microservice_TRD.md` with architecture and requirements
- Integration and e2e test suite with mock upstream behavior
