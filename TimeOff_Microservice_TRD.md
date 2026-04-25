# Technical Requirement Document (TRD)
## Time-Off Microservice — ExampleHR Platform

| Field | Value |
|---|---|
| **Version** | 1.1.0 — Final Draft |
| **Status** | Ready for Engineering Review |
| **Author** | Senior Backend Architecture Team |
| **Date** | April 25, 2026 |
| **Stack** | NestJS · SQLite · TypeORM |
| **Submission Package** | `.zip` archive uploaded via official submission form |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Context & User Personas](#2-system-context--user-personas)
3. [System Architecture](#3-system-architecture)
4. [Data Models & Schema](#4-data-models--schema)
5. [API Specification](#5-api-specification-rest-endpoints)
6. [Core Flows](#6-core-flows)
7. [Concurrency & Race Condition Handling](#7-concurrency--race-condition-handling)
8. [Sync Strategy](#8-sync-strategy)
9. [Resilience Patterns](#9-resilience-patterns)
10. [Error Handling Strategy](#10-error-handling-strategy)
11. [Alternatives Considered](#11-alternatives-considered)
12. [Testing Strategy & Agentic Workflow](#12-testing-strategy--agentic-workflow)
13. [Submission Package & Local Verification](#13-submission-package--local-verification)
14. [Non-Functional Requirements](#14-non-functional-requirements)
15. [Open Questions & Future Work](#15-open-questions--future-work)

---

## 1. Executive Summary

The Time-Off Microservice is a dedicated backend service that acts as the authoritative orchestration layer between ExampleHR (the employee-facing UI) and a third-party Human Capital Management (HCM) system such as Workday or SAP SuccessFactors. The HCM remains the canonical **Source of Truth** for all leave balances. This service manages the full lifecycle of a time-off request — from initial submission through manager approval or rejection — while providing a resilient, eventually consistent local cache layer to guarantee responsiveness even under partial HCM unavailability.

The central engineering challenge is **balance sync integrity**: the HCM modifies balances independently of ExampleHR (e.g., on work anniversaries, year-start resets), meaning any locally cached balance is potentially stale at any moment. This service must defend against over-deduction and under-reporting while maintaining a user experience that feels fast and reliable.

> **Key Invariant:** Real-time HCM balance verification is mandatory on every write operation. This step cannot be bypassed, regardless of how fresh the local cache is.

This document covers the full architectural design, data model, API contract, sync strategy, resilience patterns, testing strategy, and submission verification requirements. It is intended to be handed directly to an agentic development workflow — all code snippets in this document are **pseudocode / specification contracts**, not hand-written implementations. No production code is authored by a human engineer.

---

## 2. System Context & User Personas

### 2.1 System Boundary

The microservice sits as a dedicated orchestration layer between the ExampleHR frontend and the HCM. It owns the request lifecycle state machine and the local balance cache, but delegates all source-of-truth balance authority to the HCM.

```
┌──────────────────────────────────────────────────────────────┐
│                      ExampleHR Platform                       │
│                                                               │
│  ┌─────────────┐   REST/JSON    ┌───────────────────────┐    │
│  │  Employee   │ ─────────────▶ │                       │    │
│  │  UI (SPA)   │                │  Time-Off             │    │
│  └─────────────┘                │  Microservice         │    │
│                                 │  (NestJS + SQLite)    │    │
│  ┌─────────────┐                │                       │    │
│  │  Manager    │ ─────────────▶ │                       │    │
│  │  Dashboard  │                └───────────┬───────────┘    │
│  └─────────────┘                            │                │
└────────────────────────────────────────────-┼────────────────┘
                                              │ HTTP/REST
                                              ▼
                               ┌──────────────────────────┐
                               │       HCM System          │
                               │  (Workday / SAP / etc.)  │
                               │                          │
                               │  · Real-time Balance API │
                               │  · Batch Sync Endpoint   │
                               └──────────────────────────┘
```

| Component | Responsibility |
|---|---|
| ExampleHR SPA | Employee and manager-facing UI; calls this microservice exclusively |
| Time-Off Microservice | Request lifecycle, cache-aside balance reads, HCM orchestration |
| HCM (Workday/SAP) | Source of Truth for leave balances; exposes real-time + batch APIs |
| SQLite (BalanceCache) | Local read-through cache for high-frequency balance lookups |

### 2.2 User Personas

#### Employee
- Primary user of the time-off request flow.
- Expects to see their accurate, up-to-date leave balance immediately on page load.
- Expects instant feedback — success or a clear error message — when submitting a leave request.
- Must not be allowed to over-request beyond their HCM-verified balance.
- Has access to a manual **"Refresh Balance"** action that forces real-time HCM verification, bypassing the cache.

#### Manager
- Reviews and approves or rejects pending time-off requests from direct reports.
- Must have confidence that the balance displayed at the time of request submission was genuinely HCM-verified, not just cached.
- Requires a clear audit trail: when was the balance verified, and from which source?
- Balance is re-verified against the HCM at the moment of approval, protecting against changes that occurred between submission and approval.

### 2.3 Balance Dimensions

Per the product specification, all balances are scoped to **three composite dimensions** that together form the unique key for any balance record:

- `employeeId` — the unique identifier of the employee in the HCM.
- `locationId` — the physical or organizational location affecting leave policy (e.g., legal jurisdiction, regional office).
- `leaveType` — the category of leave (e.g., `ANNUAL`, `SICK`, `UNPAID`).

> **Composite Key Rule:** Every balance record, time-off request, cache entry, and HCM API call must carry all three dimensions. Any operation missing one or more dimensions is rejected at the input validation layer before reaching any business logic.

This is consistent with the HCM batch payload format, which groups balance data by `(employeeId, locationId, leaveType)` as its atomic unit of account.

---

## 3. System Architecture

### 3.1 Architectural Principles

The service is designed around three non-negotiable principles:

1. **Defensive Validation First** — Never trust a locally cached balance for a write operation. Always verify against the HCM before committing a deduction, and apply our own arithmetic guard regardless of the HCM response code.
2. **Degrade Gracefully** — If the HCM is unreachable, the service must protect users from stale-data decisions via a Circuit Breaker. Reads continue from cache with a staleness flag; writes are blocked with a clear user-facing message.
3. **Idempotency by Default** — Every mutating operation is keyed with a client-supplied idempotency token to prevent duplicate commits under retry conditions, network timeouts, or agent re-runs.

### 3.2 Layered Architecture (NestJS Modules)

The agent is instructed to scaffold the following module structure:

```
src/
├── time-off/
│   ├── time-off.module.ts
│   ├── time-off.controller.ts       # HTTP layer: routes, DTO validation, guards
│   ├── time-off.service.ts          # Orchestration: full request lifecycle logic
│   ├── time-off.repository.ts       # SQLite data access via TypeORM
│   └── dto/
│       ├── create-request.dto.ts
│       ├── approve-request.dto.ts
│       └── reject-request.dto.ts
│
├── balance/
│   ├── balance.module.ts
│   ├── balance.service.ts           # Cache-Aside logic, TTL management
│   ├── balance.repository.ts        # SQLite access for BalanceCache entity
│   └── sync/
│       ├── sync.controller.ts       # POST /sync/balances handler
│       └── sync.service.ts          # Batch upsert logic, conflict resolution
│
├── hcm/
│   ├── hcm.module.ts
│   ├── hcm-adapter.interface.ts     # IHcmAdapter contract (interface only)
│   ├── hcm-http.adapter.ts          # Concrete HTTP implementation
│   ├── hcm-circuit-breaker.ts       # Circuit Breaker state machine
│   └── hcm-retry.policy.ts          # Exponential backoff + jitter
│
├── common/
│   ├── guards/
│   │   └── idempotency.guard.ts
│   ├── interceptors/
│   │   └── logging.interceptor.ts
│   └── filters/
│       └── hcm-exception.filter.ts
│
├── database/
│   ├── database.module.ts           # TypeORM SQLite config, WAL mode
│   └── migrations/                  # TypeORM migration files
│
└── health/
    └── health.controller.ts         # /health and /health/hcm endpoints
```

### 3.3 Adapter Pattern for HCM Integration

The HCM integration is fully encapsulated behind an `IHcmAdapter` interface. This decouples all core business logic from any specific HCM vendor's API design, making it trivial to swap vendors, version the API, or inject test doubles without changing a single line of service code.

```
[PSEUDOCODE — SPEC CONTRACT]

interface IHcmAdapter {
  getBalance(employeeId, locationId, leaveType) → HcmBalanceResponse
  deductBalance(employeeId, locationId, leaveType, days, idempotencyKey) → HcmDeductResponse
  restoreBalance(employeeId, locationId, leaveType, days, idempotencyKey) → void
  batchGetBalances(filters[]) → HcmBatchBalanceResponse[]
}

HcmBalanceResponse:  { employeeId, locationId, leaveType, days: number, asOf: ISO8601 }
HcmDeductResponse:   { deductionId: string, remainingDays: number }
```

The `HcmHttpAdapter` is the production implementation. In the test environment, a `MockHcmAdapter` (or a running mock NestJS server) fulfills this interface. The concrete adapter is injected via NestJS's DI container using a provider token — business logic never imports a concrete adapter class directly.

### 3.4 Cache-Aside Strategy

The local SQLite `BalanceCache` table is the **read-through layer** for high-frequency balance lookups such as dashboard page loads. It is never treated as authoritative for write operations.

| Operation Type | Cache Role | HCM Role |
|---|---|---|
| Read — dashboard load | Primary source if `last_synced_at` within TTL and `is_stale = 0` | Fallback on cache miss or staleness |
| Read — force refresh | Bypassed entirely | Always called; cache updated afterward |
| Write — request submit | Optimistic pre-check only (early reject for obviously stale low balances) | **Mandatory real-time verification before any DB write** |
| Write — approve | Cache consulted for display only | Re-verified live; deduction committed via HCM API |
| Write — cancel / reject | Invalidated after operation | Balance restore (if previously deducted) called on HCM |
| Batch sync ingest | Bulk upsert target | Source of batch payload pushed to POST /sync/balances |

> Cache TTL is configurable via `BALANCE_CACHE_TTL_SECONDS` environment variable (default: `300` seconds / 5 minutes).

---

## 4. Data Models & Schema

All schemas target SQLite with TypeORM. The agent must generate TypeORM entity classes and migration files from these specifications.

### 4.1 Employee

```sql
[SPEC — agent generates TypeORM entity and migration]

CREATE TABLE employee (
  id            TEXT PRIMARY KEY,           -- HCM-issued employee ID (not auto-generated)
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  location_id   TEXT NOT NULL,              -- Default location for leave policy
  manager_id    TEXT,                       -- Self-referencing FK (nullable for top-level)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manager_id) REFERENCES employee(id)
);
```

### 4.2 TimeOffRequest

The central entity tracking the full lifecycle of a request. The `idempotency_key` uniqueness constraint is enforced at the database level — not just in application code — to guarantee exactly-once semantics even under concurrent agent retries.

```sql
[SPEC — agent generates TypeORM entity and migration]

CREATE TABLE time_off_request (
  id                    TEXT PRIMARY KEY,         -- UUID v4, generated by service
  employee_id           TEXT NOT NULL,            -- FK → employee.id
  location_id           TEXT NOT NULL,            -- Dimension: denormalized for audit completeness
  leave_type            TEXT NOT NULL,            -- Dimension: 'ANNUAL' | 'SICK' | 'UNPAID'
  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,
  days_requested        REAL NOT NULL,            -- Supports 0.5 for half-day increments
  status                TEXT NOT NULL DEFAULT 'PENDING',
                                                  -- 'PENDING'|'APPROVED'|'REJECTED'|'CANCELLED'
  idempotency_key       TEXT NOT NULL UNIQUE,     -- Client-supplied UUID; prevents duplicate submission
  hcm_deduction_id      TEXT,                    -- HCM's transaction reference (set on deduction)
  hcm_verified_at       DATETIME,                -- Timestamp of HCM balance check at submission
  hcm_balance_snapshot  REAL,                    -- Exact HCM balance at time of verification (audit)
  approved_by           TEXT,                    -- FK → employee.id (the approving manager)
  approved_at           DATETIME,
  rejected_by           TEXT,                    -- FK → employee.id (the rejecting manager)
  rejected_at           DATETIME,
  rejection_reason      TEXT,
  cancelled_at          DATETIME,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (approved_by) REFERENCES employee(id),
  FOREIGN KEY (rejected_by) REFERENCES employee(id)
);

CREATE UNIQUE INDEX idx_idempotency ON time_off_request(idempotency_key);
CREATE INDEX idx_employee_status ON time_off_request(employee_id, status);
CREATE INDEX idx_location_leave ON time_off_request(location_id, leave_type);
```

**Status Lifecycle:**

```
                  ┌──────────────────┐
         ┌───────▶│    APPROVED      │ (terminal — HCM deducted)
         │        └──────────────────┘
[PENDING]─┤
         │        ┌──────────────────┐
         ├───────▶│    REJECTED      │ (terminal — no HCM deduction)
         │        └──────────────────┘
         │
         │        ┌──────────────────┐
         └───────▶│    CANCELLED     │ (terminal — HCM restored if already deducted)
                  └──────────────────┘
```

Status transitions are enforced in the service layer. Any attempt to transition from a terminal state raises a `InvalidStatusTransitionException`.

### 4.3 BalanceCache

```sql
[SPEC — agent generates TypeORM entity and migration]

CREATE TABLE balance_cache (
  id              TEXT PRIMARY KEY,             -- UUID v4
  employee_id     TEXT NOT NULL,                -- Dimension 1
  location_id     TEXT NOT NULL,                -- Dimension 2
  leave_type      TEXT NOT NULL,                -- Dimension 3
  balance_days    REAL NOT NULL,
  last_synced_at  DATETIME NOT NULL,            -- When this record was last pulled from HCM
  sync_source     TEXT NOT NULL,                -- 'REALTIME' | 'BATCH' | 'MANUAL'
  is_stale        INTEGER NOT NULL DEFAULT 0,   -- 1 = force-invalidated; triggers re-fetch on next read
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, location_id, leave_type) -- Composite key: all three dimensions required
);

CREATE INDEX idx_balance_lookup ON balance_cache(employee_id, location_id, leave_type);
CREATE INDEX idx_stale_sweep ON balance_cache(is_stale, last_synced_at);
```

### 4.4 IdempotencyLog

```sql
[SPEC — agent generates TypeORM entity and migration]

CREATE TABLE idempotency_log (
  idempotency_key   TEXT PRIMARY KEY,
  endpoint          TEXT NOT NULL,              -- e.g. 'POST /api/v1/requests'
  response_body     TEXT NOT NULL,              -- Full JSON response, cached for replay
  status_code       INTEGER NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at        DATETIME NOT NULL           -- TTL: 24 hours from creation
);

CREATE INDEX idx_idempotency_expiry ON idempotency_log(expires_at);
```

A background cleanup job (runs every hour) purges expired idempotency log entries to prevent unbounded table growth.

---

## 5. API Specification (REST Endpoints)

All endpoints are versioned under `/api/v1`. Authentication is handled upstream by an API Gateway or Auth middleware. The caller's `employeeId` and `role` are injected via a verified JWT claim; the service never trusts client-supplied identity fields for authorization decisions.

### 5.1 Balance Endpoints

| Method | Path | Auth Role | Description |
|---|---|---|---|
| `GET` | `/api/v1/balances/:employeeId` | Employee, Manager | Get all balances for an employee (Cache-Aside) |
| `GET` | `/api/v1/balances/:employeeId/verify` | Employee, Manager | Force real-time HCM verification (bypass cache) |

**GET /balances/:employeeId — Query params:** `locationId` (required), `leaveType` (optional, returns all types if omitted)

**GET /balances/:employeeId — Response (200):**
```json
{
  "employeeId": "emp-001",
  "locationId": "loc-nyc",
  "balances": [
    {
      "leaveType": "ANNUAL",
      "balanceDays": 12.5,
      "lastSyncedAt": "2026-04-25T10:00:00Z",
      "syncSource": "REALTIME",
      "isStale": false
    },
    {
      "leaveType": "SICK",
      "balanceDays": 5.0,
      "lastSyncedAt": "2026-04-25T10:00:00Z",
      "syncSource": "BATCH",
      "isStale": false
    }
  ]
}
```

### 5.2 Time-Off Request Endpoints

| Method | Path | Auth Role | Description |
|---|---|---|---|
| `POST` | `/api/v1/requests` | Employee | Submit a new time-off request (triggers HCM verification) |
| `GET` | `/api/v1/requests/:requestId` | Employee, Manager | Get a specific request by ID |
| `GET` | `/api/v1/requests` | Employee, Manager | List requests; supports `?employeeId=&status=&locationId=` filters |
| `PATCH` | `/api/v1/requests/:requestId/approve` | Manager | Approve a PENDING request (triggers HCM deduction) |
| `PATCH` | `/api/v1/requests/:requestId/reject` | Manager | Reject a PENDING request (no HCM balance change) |
| `DELETE` | `/api/v1/requests/:requestId` | Employee | Cancel a PENDING request (restores balance if deducted) |

**POST /requests — Request Body:**
```json
{
  "employeeId": "emp-001",
  "locationId": "loc-nyc",
  "leaveType": "ANNUAL",
  "startDate": "2026-05-01",
  "endDate": "2026-05-03",
  "daysRequested": 3,
  "idempotencyKey": "a8f3c2b1-7e4d-4a9f-b2c3-1d5e6f7a8b9c"
}
```

**POST /requests — Response (201 Created):**
```json
{
  "requestId": "req-550e8400-e29b-41d4-a716-446655440000",
  "status": "PENDING",
  "hcmVerifiedAt": "2026-04-25T10:01:23Z",
  "hcmBalanceSnapshot": 12.5,
  "message": "Request submitted. Awaiting manager approval."
}
```

**PATCH /requests/:id/reject — Request Body:**
```json
{
  "rejectionReason": "Team already at minimum staffing for this period."
}
```

### 5.3 Sync Endpoints

| Method | Path | Auth Role | Description |
|---|---|---|---|
| `POST` | `/api/v1/sync/balances` | Internal / HCM system | Ingest full batch balance payload from HCM |
| `GET` | `/api/v1/sync/status` | Internal | Last sync metadata: syncId, timestamp, processed/skipped/flagged counts |

**POST /sync/balances — Request Body:**
```json
{
  "syncId": "hcm-batch-20260425-001",
  "generatedAt": "2026-04-25T00:00:00Z",
  "balances": [
    {
      "employeeId": "emp-001",
      "locationId": "loc-nyc",
      "leaveType": "ANNUAL",
      "balanceDays": 15.0
    },
    {
      "employeeId": "emp-001",
      "locationId": "loc-nyc",
      "leaveType": "SICK",
      "balanceDays": 5.0
    }
  ]
}
```

**POST /sync/balances — Response (200):**
```json
{
  "syncId": "hcm-batch-20260425-001",
  "processed": 248,
  "skipped": 12,
  "flagged": 3,
  "message": "3 PENDING requests flagged for re-verification due to balance changes."
}
```

### 5.4 Health Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service liveness check |
| `GET` | `/health/hcm` | HCM circuit breaker state and last probe result |

**GET /health/hcm — Response:**
```json
{
  "circuitBreaker": {
    "state": "CLOSED",
    "failureCount": 0,
    "lastProbeAt": "2026-04-25T10:00:00Z",
    "lastProbeResult": "SUCCESS"
  },
  "hcmReachable": true
}
```

---

## 6. Core Flows

### 6.1 Real-Time Request Submission Flow

This is the most critical and most heavily guarded path in the system.

```
Employee → POST /api/v1/requests
           │
           ▼
[1] Idempotency Check
    · Query idempotency_log WHERE idempotency_key = ?
    · If found and not expired → return cached HTTP response immediately (HTTP 200)
    · If found and expired → treat as new submission
    · If not found → proceed
           │
           ▼
[2] Input Validation (NestJS class-validator DTO)
    · All three dimensions present: employeeId, locationId, leaveType
    · startDate <= endDate; neither date in the past
    · daysRequested > 0; consistent with date range
    · idempotencyKey is a valid UUID v4
    · Reject with HTTP 400 on any validation failure
           │
           ▼
[3] Local Cache Optimistic Pre-Check
    · Query balance_cache WHERE (employeeId, locationId, leaveType)
    · If cache record exists AND last_synced_at > NOW() - TTL AND is_stale = 0:
        AND cached balance < daysRequested:
          → return HTTP 422 "Insufficient balance (cached — HCM verification skipped)"
    · In all other cases → proceed to HCM verification
    · NOTE: A "sufficient" cached balance does NOT skip HCM verification
           │
           ▼
[4] HCM Real-Time Balance Verification  ← MANDATORY; cannot be skipped
    · Check Circuit Breaker state
        OPEN → return HTTP 503 with Retry-After header; halt here
        CLOSED or HALF-OPEN → proceed
    · Call HcmAdapter.getBalance(employeeId, locationId, leaveType)
        Timeout (> 5s) → increment failure counter; return HTTP 503
        HTTP 4xx/5xx → return HTTP 422 with translated HCM error message
    · Defensive arithmetic guard (regardless of HCM response code):
        IF hcmBalance.days - daysRequested < 0:
          → return HTTP 422 "Insufficient balance (HCM verified)"
    · Snapshot hcmBalance.days value for audit
           │
           ▼
[5] Database Transaction (atomic)
    · INSERT INTO time_off_request (status = 'PENDING', hcm_verified_at, hcm_balance_snapshot, ...)
    · INSERT INTO idempotency_log (idempotency_key, response_body, status_code = 201, expires_at)
    · UPSERT INTO balance_cache (fresh HCM value, sync_source = 'REALTIME')
    · COMMIT
    · On DB error → ROLLBACK; return HTTP 500; do NOT call HCM deduction
           │
           ▼
[6] Return HTTP 201 Created
    { requestId, status: "PENDING", hcmVerifiedAt, hcmBalanceSnapshot }
```

### 6.2 Manager Approval Flow

```
Manager → PATCH /api/v1/requests/:requestId/approve
           │
           ▼
[1] Load TimeOffRequest; verify status = 'PENDING'
    · If not PENDING → return HTTP 409 "Cannot approve a request in status X"
    · Verify caller's JWT role = Manager and managerId matches employee's manager_id
           │
           ▼
[2] Re-verify HCM Balance (second live check at approval time)
    · Protects against balance changes between submission and approval
    · Same Circuit Breaker and defensive guard as the submission flow
    · If balance is now insufficient → return HTTP 422; request remains PENDING
           │
           ▼
[3] HCM Deduction
    · Call HcmAdapter.deductBalance(employeeId, locationId, leaveType, days, requestId)
    · requestId serves as the HCM-side idempotency key
    · On HCM error → return HTTP 422; request remains PENDING (manager can retry)
    · Capture returned deductionId
           │
           ▼
[4] Database Transaction (atomic)
    · UPDATE time_off_request SET status = 'APPROVED', hcm_deduction_id, approved_by, approved_at
    · UPSERT INTO balance_cache (updated balance = snapshot - days_requested, is_stale = 0)
    · COMMIT
           │
           ▼
[5] Return HTTP 200 with updated request object
```

### 6.3 Manager Rejection Flow

```
Manager → PATCH /api/v1/requests/:requestId/reject
           │
           ▼
[1] Load request; verify status = 'PENDING'
[2] No HCM call required — no balance was ever deducted at PENDING stage
[3] DB Transaction:
    · UPDATE status = 'REJECTED', rejected_by, rejected_at, rejection_reason
    · COMMIT
[4] Return HTTP 200 with updated request
```

### 6.4 Employee Cancellation Flow

```
Employee → DELETE /api/v1/requests/:requestId
           │
           ▼
[1] Load request; verify status = 'PENDING'
    · Only PENDING requests can be cancelled by the employee
    · APPROVED requests require a different "recall" process (out of v1 scope)
           │
           ▼
[2] Check if HCM deduction has been made
    · hcm_deduction_id IS NULL → no deduction was made (PENDING before approval)
      → skip HCM restore call; proceed to step 4
    · hcm_deduction_id IS NOT NULL → deduction exists; must restore
           │
           ▼
[3] HCM Balance Restore (only if hcm_deduction_id present)
    · Call HcmAdapter.restoreBalance(employeeId, locationId, leaveType, days, idempotencyKey)
    · Use original idempotency_key prefixed with "restore-" to make it distinct
    · Retry with exponential backoff (max 3 attempts) before failing
    · Only proceed to DB update after successful HCM confirmation
           │
           ▼
[4] DB Transaction:
    · UPDATE status = 'CANCELLED', cancelled_at
    · If balance was restored: UPSERT balance_cache (increment by days_requested)
    · COMMIT
[5] Return HTTP 200
```

---

## 7. Concurrency & Race Condition Handling

### 7.1 The Work Anniversary Race Condition

This is the primary architectural challenge this service must solve. Consider the following timeline:

| Time | Actor | Event |
|---|---|---|
| T₀ | Employee | Has 10 days cached. Submits request for 9 days. |
| T₁ | HCM | Work anniversary fires. Balance updated to 15 days in HCM. |
| T₂ | Service | HCM real-time check reads 15 days → request passes. |
| T₃ | Service | Request committed as PENDING; cache updated to 15 days. |
| T₄ | Employee (concurrent) | Same employee submits second request for 8 days simultaneously. |
| T₅ | Service | Both requests pass HCM check (both read 15 days before either deducts). |
| **Problem** | | **Both requests are committed; 9 + 8 = 17 days deducted from a 15-day balance.** |

### 7.2 Mitigations

#### Per-Employee Serialized Deduction Gate

An in-process per-employee async lock ensures that concurrent requests for the same `employeeId` are serialized through the HCM-verify-then-commit path. Only one request can hold the lock at a time; others queue and re-check the balance from HCM once the lock is released.

```
[PSEUDOCODE — SPEC CONTRACT]

function submitRequest(dto):
  return employeeLockMap.withLock(dto.employeeId, async () => {
    hcmBalance = await hcmAdapter.getBalance(dto.employeeId, dto.locationId, dto.leaveType)
    defensiveGuard(hcmBalance.days, dto.daysRequested)   // throws if insufficient
    return db.transaction(() => {
      insert TimeOffRequest(status = PENDING)
      upsert BalanceCache(balance = hcmBalance.days)
    })
  })
```

If this service is later scaled horizontally, the in-process lock must be replaced with a distributed lock (e.g., Redis `SETNX` with TTL). This is flagged in Section 15.

#### Database-Level Idempotency Constraint

The `UNIQUE` constraint on `idempotency_key` in `time_off_request` acts as a final safety net. Even if application-level serialization has a bug, the database will reject a duplicate key insertion and the transaction will roll back cleanly.

#### HCM Deduction Idempotency

Every `deductBalance` call passes `requestId` as the HCM-side idempotency key. If the same deduction is attempted twice (e.g., due to a network timeout + retry), the HCM will recognize the duplicate and return the original `deductionId` without deducting twice. The service additionally tracks `hcm_deduction_id` and will refuse to re-attempt a deduction if it is already populated on the request record.

#### Optimistic Locking on BalanceCache

The `updated_at` column acts as a version field on `balance_cache`. When updating the cache after an HCM read, the update condition is:

```sql
UPDATE balance_cache
SET balance_days = ?, last_synced_at = ?, updated_at = NOW()
WHERE employee_id = ? AND location_id = ? AND leave_type = ?
AND updated_at = <version_read_at_query_time>
```

If a concurrent process has already updated the record (version mismatch), the update affects 0 rows and the service retries the read-modify-write cycle with the freshest value, rather than blindly overwriting.

---

## 8. Sync Strategy

### 8.1 Real-Time Balance Read (Cache-Aside with TTL)

For read-only balance display such as employee dashboard loads, the service applies the following decision tree on every request:

```
getBalance(employeeId, locationId, leaveType):
  record = query balance_cache WHERE (employeeId, locationId, leaveType)

  if record exists
    AND record.last_synced_at > NOW() - BALANCE_CACHE_TTL_SECONDS
    AND record.is_stale = 0:
      return { ...record, isStale: false }    ← cache hit

  hcmBalance = hcmAdapter.getBalance(employeeId, locationId, leaveType)
  upsert balance_cache (hcmBalance.days, last_synced_at = NOW(), sync_source = 'REALTIME', is_stale = 0)
  return { ...hcmBalance, isStale: false }    ← fresh from HCM

  [on HCM failure with circuit breaker OPEN]:
  if record exists:
    return { ...record, isStale: true }       ← stale fallback with warning
  else:
    throw HcmUnavailableException             ← no fallback available
```

### 8.2 Batch Sync — POST /sync/balances

The HCM pushes a full corpus of balance data to this endpoint on scheduled triggers such as year-start resets, work anniversaries, and bulk policy changes. This is the primary mechanism for keeping the local cache consistent without requiring ExampleHR to poll the HCM continuously.

**Processing Logic:**

```
POST /sync/balances:
  [1] Validate payload schema
      · Required: syncId, generatedAt (ISO8601), balances[]
      · Each balance item: employeeId, locationId, leaveType, balanceDays
      · Reject HTTP 400 on schema violations

  [2] Idempotency check on syncId
      · Query idempotency_log WHERE idempotency_key = 'sync-' + syncId
      · If found → return HTTP 200 { message: "Already applied", syncId }

  [3] Begin DB transaction
      For each balance record in payload:
        · Fetch current cache record for (employeeId, locationId, leaveType)
        · Conflict resolution:
            IF cache.last_synced_at > payload.generatedAt:
              → SKIP this record (no back-dating; local record is newer)
            ELSE:
              → UPSERT balance_cache SET balance_days, last_synced_at, sync_source='BATCH', is_stale=0
      COMMIT

  [4] Post-sync PENDING request audit
      · Query all PENDING time_off_request records for employees whose balances changed
      · For each: IF new_balance < days_requested → flag request (add metadata note)
      · Return flagged count in response; flagged requests are NOT auto-rejected

  [5] Log idempotency_log entry for this syncId
  [6] Return HTTP 200 { processed, skipped, flagged }
```

**Conflict Resolution Rule Summary:**

| Condition | Action |
|---|---|
| `payload.generatedAt` > `cache.last_synced_at` | Apply update (newer data wins) |
| `payload.generatedAt` <= `cache.last_synced_at` | Skip (no back-dating) |
| No existing cache record | Always insert |

### 8.3 Sync Drift Detection (Background Job)

A scheduled background task (`@Cron('0 */6 * * *')` — every 6 hours) runs a drift audit:

1. Sample up to 200 active employees with recently cached balances.
2. For each, call `HcmAdapter.getBalance()` and compare against `balance_cache.balance_days`.
3. If `|hcmBalance - cachedBalance| > DRIFT_THRESHOLD_DAYS` (configurable, default `0.5`):
   - Mark the cache record `is_stale = 1`.
   - Emit a structured log event: `{ level: 'warn', event: 'BALANCE_DRIFT_DETECTED', employeeId, delta }`.
4. Stale-marked records are re-fetched from HCM on the next read request.

The drift detector does not auto-correct balances — it only marks records stale. Actual correction happens on the next live read request, ensuring the correction is confirmed by a fresh HCM call rather than inferred.

---

## 9. Resilience Patterns

### 9.1 Circuit Breaker Pattern

The `HcmCircuitBreaker` wraps every outbound call to the HCM adapter. It uses a three-state machine to prevent cascading failures when the HCM is experiencing degraded service.

```
CLOSED ──(5 consecutive failures)──▶ OPEN ──(30s timeout)──▶ HALF-OPEN
  ▲                                                               │
  └──────────────────(2 consecutive successes)────────────────────┘
```

| Parameter | Default | Override Env Var |
|---|---|---|
| `failureThreshold` | 5 | `HCM_CB_FAILURE_THRESHOLD` |
| `successThreshold` | 2 | `HCM_CB_SUCCESS_THRESHOLD` |
| `openTimeout` | 30s | `HCM_CB_OPEN_TIMEOUT_SECONDS` |
| `requestTimeout` | 5s | `HCM_REQUEST_TIMEOUT_SECONDS` |

**Per-state behavior:**

| State | Read requests | Write requests | Sync requests |
|---|---|---|---|
| CLOSED | Served live from HCM | Verified live; proceed normally | Processed normally |
| OPEN | Return stale cache with `isStale: true` | HTTP 503 + `Retry-After` header | Queued; retried after timeout |
| HALF-OPEN | One probe allowed; result closes or reopens | Blocked (same as OPEN) | Blocked |

The `GET /health/hcm` endpoint exposes current circuit breaker state for monitoring dashboards and alerting systems.

### 9.2 Retry Policy

All outbound HCM calls use exponential backoff with jitter:

| Parameter | Value |
|---|---|
| Max retries | 3 |
| Base delay | 500ms |
| Max delay | 5,000ms |
| Jitter factor | ±20% of computed delay |
| Retryable status codes | 429, 500, 502, 503, 504 |
| Non-retryable | 400, 401, 403, 404, 422 |

Deduction calls are only retried if the HCM error is explicitly retryable **and** the `hcm_deduction_id` on the request record is still `NULL`, confirming that no prior deduction was committed.

### 9.3 HCM Downtime Handling Summary

| Scenario | Service Behavior |
|---|---|
| HCM returns 5xx | Retry up to 3x; increment circuit breaker failure counter |
| HCM timeout | Treated as failure; circuit breaker incremented |
| Circuit breaker OPEN | Balance reads: stale cache + `isStale: true`. Writes: HTTP 503. |
| HCM returns and CB resets | Stale cache entries re-fetched on next read; writes resume normally |
| HCM permanently unavailable | Operations team alerted via structured log; manual intervention required |

---

## 10. Error Handling Strategy

### 10.1 Consistent Error Response Envelope

All errors across all endpoints return the following structure:

```json
{
  "statusCode": 422,
  "error": "INSUFFICIENT_BALANCE",
  "message": "Employee emp-001 has 3.0 days of ANNUAL leave available at loc-nyc; 5.0 days requested.",
  "details": {
    "employeeId": "emp-001",
    "locationId": "loc-nyc",
    "leaveType": "ANNUAL",
    "availableBalance": 3.0,
    "requestedDays": 5.0,
    "verifiedAt": "2026-04-25T10:01:23Z",
    "source": "HCM_REALTIME"
  }
}
```

### 10.2 Defined Error Codes

| HTTP Status | Error Code | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or malformed request fields; missing dimensions |
| 409 | `INVALID_STATUS_TRANSITION` | Attempt to act on a terminal-status request |
| 409 | `DUPLICATE_IDEMPOTENCY_KEY` | Idempotency key used with different payload |
| 422 | `INSUFFICIENT_BALANCE` | HCM-verified or defensively computed balance too low |
| 422 | `INVALID_HCM_DIMENSION` | HCM rejected the employeeId/locationId/leaveType combination |
| 422 | `HCM_REQUEST_REJECTED` | HCM returned a non-retryable business-logic error |
| 503 | `HCM_UNAVAILABLE` | Circuit breaker OPEN; HCM unreachable or timing out |

### 10.3 Defensive Balance Guard

The service always applies its own arithmetic guard, independent of the HCM response code. This addresses the specification requirement that HCM errors on insufficient balance are not always guaranteed:

```
[PSEUDOCODE — SPEC CONTRACT]

function defensiveGuard(hcmBalance, daysRequested):
  if (hcmBalance - daysRequested) < 0:
    throw InsufficientBalanceException({
      available: hcmBalance,
      requested: daysRequested,
      source: 'HCM_REALTIME'
    })
```

This guard fires before any DB transaction begins. No write operation — including request insertion — proceeds if the balance arithmetic fails, regardless of whether the HCM returned an explicit error response.

### 10.4 HCM Error Translation

When the HCM returns a structured error (e.g., `"Dimension combination not found"`), the `HcmExceptionFilter` translates it into the standard error envelope while storing the raw HCM response body in a structured log field `hcm_raw_error` for debugging. The translated message is safe to surface to the end user.

---

## 11. Alternatives Considered

### 11.1 Webhooks vs. Polling vs. Hybrid for Balance Updates

| Criterion | Webhooks (HCM pushes) | Polling (Service pulls) | Hybrid Batch Push + RT Verify ✓ |
|---|---|---|---|
| **Update latency** | Near real-time (< 1s) | Up to polling interval (e.g. 5–60 min) | Batch: scheduled; individual writes: real-time |
| **HCM load** | Minimal (HCM-initiated) | High (constant polling regardless of change frequency) | Low (batch-driven + on-demand reads only) |
| **Infrastructure complexity** | High (inbound TLS, webhook registry, replay/retry on HCM side) | Low (outbound HTTP only) | Medium (batch endpoint + RT adapter) |
| **HCM vendor support** | Not universal | Always available | Batch: most enterprise HCMs support bulk export; RT API: always available |
| **Failure model** | Missed webhooks are silently lost without HCM retry | Polling always recovers on next interval | Batch re-sendable (idempotent syncId); RT verified at every write |
| **Scalability** | Excellent — event-driven | Poor — polling load grows linearly with employee count | Good — batch amortizes cost; RT only on demand |
| **Estimated implementation effort** | High (~3–4 weeks for webhook infrastructure + retry + signature validation) | Low (~1 week) | Medium (~2 weeks for batch endpoint + RT adapter) |

**Decision: Hybrid (Batch Push + Real-Time Verification)**

The hybrid approach wins on practicality and correctness. Polling is ruled out due to its inherent staleness window and poor scalability. Full webhooks require HCM vendor support and significant inbound infrastructure that is not universally available and takes significant effort to build reliably. The hybrid gives us HCM-driven bulk updates (via batch) at low infrastructure cost, while real-time verification at the point of every write guarantees correctness for the operations that matter most. If the HCM vendor adds outbound webhook support in future, the batch endpoint can be repurposed as a webhook receiver with no changes to the write path.

### 11.2 GraphQL vs. REST

| Criterion | GraphQL | REST ✓ |
|---|---|---|
| **Query flexibility** | High (clients request exactly needed fields) | Low (server defines response shape) |
| **HTTP-level caching** | Difficult (single endpoint, complex cache keys) | Straightforward (`GET /balances/:id` → standard CDN/proxy cache) |
| **Tooling maturity** | Good but heavier (schema stitching, resolvers, DataLoader) | Excellent (OpenAPI, swagger-ui, standard middleware ecosystem) |
| **Learning curve** | Higher (new query language, N+1 problem mitigation) | Lower (standard HTTP verbs) |
| **Endpoint count** | Irrelevant (single `/graphql`) | ~9 endpoints — well within manageable range |
| **Type safety** | Excellent (auto-generated client types from schema) | Good (OpenAPI code generation) |
| **Fit for bounded domain** | Overkill — benefit is realized at 20+ interconnected resource types | Natural fit for a service with clear resource boundaries |

**Decision: REST**

The time-off domain has clear resource boundaries (`requests`, `balances`, `sync`). REST is simpler to HTTP-cache, document with OpenAPI, and reason about for an operations team. GraphQL's primary advantage — flexible client-driven queries — is not needed when the UI clients are known and stable. The ~9 endpoint count does not justify the GraphQL toolchain overhead.

### 11.3 Eventual Consistency vs. Strong Consistency for Reads

| Criterion | Strong Consistency (always read HCM) | Eventual Consistency — Cache-Aside ✓ |
|---|---|---|
| **Balance accuracy for reads** | Always exact (0ms staleness) | Up to TTL seconds stale (default 5 min) |
| **Read latency** | High — HCM RTT (estimated 100–500ms p95 based on typical enterprise HCM SLAs) | Low — SQLite query (< 5ms p95) |
| **HCM load for reads** | 100% of all dashboard loads hit the HCM | Only cache misses and force-refreshes hit the HCM (estimated 10–20% of reads in steady state) |
| **Behaviour during HCM downtime** | Service is non-functional for all read operations | Reads continue from stale cache; writes are blocked with clear messaging |
| **Write correctness** | Strong (always verified) | Strong (HCM verification is mandatory on all writes regardless of cache state) |
| **User experience** | Dependent on HCM availability and latency | Fast dashboard loads; "Refresh" action available for users who need real-time accuracy |

**Decision: Eventual consistency for reads, strong consistency for writes.**

This is the standard and most pragmatic pattern for systems where the Source of Truth is a third-party external service. The 5-minute staleness window for read-only balance display is acceptable — employees are informed of their balance at submission time through a live HCM check. The "Refresh Balance" button provides an escape valve for users who need real-time accuracy before deciding to submit. Strong consistency on all reads would make the service non-functional during any HCM maintenance window, which is an unacceptable trade-off.

### 11.4 SQLite vs. PostgreSQL

| Criterion | SQLite ✓ (specified) | PostgreSQL |
|---|---|---|
| **Infrastructure** | Zero — embedded in process | Separate server process; connection pooling required |
| **Concurrent readers** | Supported (WAL mode) | Excellent (MVCC) |
| **Concurrent writers** | Single writer at a time (SQLite WAL) | Multiple concurrent writers (row-level locking) |
| **Horizontal scaling** | Not supported — single file | Supported (read replicas, connection poolers) |
| **Advisory locks** | Not native; emulated via transactions | Native `pg_advisory_lock` |
| **Migration tooling** | Supported by TypeORM | Supported by TypeORM |
| **Production readiness** | Suitable for single-instance microservice | Required if service scales horizontally |
| **Estimated throughput ceiling** | ~500–1,000 write TPS in WAL mode | 5,000–20,000+ write TPS |

**Decision: SQLite (as specified)**

SQLite is appropriate for a single-process microservice at current scale. The TypeORM ORM abstracts the dialect — migration to PostgreSQL is a configuration change and a new `ormconfig`, not a code rewrite. The scale threshold at which SQLite's single-writer limitation becomes a bottleneck is well above the expected peak write load for a time-off service serving an SMB or mid-market customer base. Horizontal scaling considerations are flagged in Section 15.

---

## 12. Testing Strategy & Agentic Workflow

### 12.1 Philosophy: Contract-First, Agent-Executed

All test files are authored as specifications **before** any production code is generated. The agentic development workflow is:

1. Architect writes the TRD (this document) and the full test suite specification.
2. Agent reads TRD + test specs; scaffolds the NestJS module structure.
3. Agent generates implementation code that satisfies the test contracts.
4. Automated validation runs tests; failing tests are fed back to the agent for correction.
5. No human engineer writes production code at any step.

> All code snippets in this TRD — including those in earlier sections — are **pseudocode / specification contracts**. They describe what the implementation must do, not how it does it. The agent is responsible for producing correct, idiomatic NestJS + TypeORM implementations from these contracts.

**Test pyramid targets:**

```
         ┌─────────────────────────┐
         │   E2E Tests (10–15)     │  Full stack against running Mock HCM server
         ├─────────────────────────┤
         │ Integration Tests (40–60)│  Module interactions, DB layer, full request lifecycle
         ├─────────────────────────┤
         │   Unit Tests (80–120)   │  Services, adapters, guards in pure isolation
         └─────────────────────────┘
```

### 12.2 Mock HCM Server — Design & Deployment

#### Design

A dedicated NestJS application (`apps/mock-hcm/`) serves as the test double for the HCM system. It exposes all required HCM API surfaces and supports **runtime scenario injection** — tests configure the mock's behavior via a `POST /__config/scenario` control endpoint without restarting the server.

```
[PSEUDOCODE — SPEC CONTRACT for mock-hcm controller]

POST /__config/scenario
Body: {
  employeeId: string,
  locationId: string,
  leaveType: string,
  balance: number,           // balance to return
  shouldTimeout: boolean,    // delay response past requestTimeout
  shouldError500: boolean,   // return HTTP 500
  shouldReturnInvalidDim: boolean,  // return HCM dimension error
  deductionIsIdempotent: boolean    // second deduct returns same deductionId
}

GET /balance/:employeeId/:locationId/:leaveType
  · If scenario.shouldTimeout → delay 10s (exceeds 5s requestTimeout)
  · If scenario.shouldError500 → HTTP 500 { error: "HCM Internal Error" }
  · If scenario.shouldReturnInvalidDim → HTTP 422 { error: "Invalid dimension combination" }
  · Default → HTTP 200 { days: scenario.balance ?? 10, employeeId, locationId, leaveType }

POST /deduct
  · Apply same failure scenarios
  · If idempotent scenario and same idempotencyKey seen before → return original deductionId
  · Default → HTTP 200 { deductionId: uuid(), remainingDays: scenario.balance - body.days }

POST /restore
  · Default → HTTP 200 { restoredDays: body.days }

POST /batch
  · Accept array of balance records; store in-memory; return on subsequent GET calls
```

#### Deployment for Local Development

The mock server is configured as a separate app in the NestJS monorepo and started via:

```bash
# Start mock HCM server on port 3001
npm run start:mock-hcm

# Start main microservice pointing at mock
HCM_BASE_URL=http://localhost:3001 npm run start:dev
```

#### Automated Validation Pipeline (Platform-Agnostic)

The mock server runs as a background service step in an automated validation pipeline, started before the test suite and torn down after:

```yaml
[SPEC — agent generates validation pipeline configuration]

pipeline:
  stages:
    - run: npm install
    - run: npm run build
    - run: npm run test
      env:
        HCM_BASE_URL: http://localhost:3001
        DATABASE_URL: ':memory:'
```

#### Docker Compose (Integration / Manual Testing)

```yaml
[SPEC — agent generates docker-compose.yml]

services:
  time-off-service:
    build: .
    ports:
      - "3000:3000"
    environment:
      HCM_BASE_URL: http://mock-hcm:3001
      DATABASE_URL: /data/timeoff.db
      BALANCE_CACHE_TTL_SECONDS: 300
    volumes:
      - ./data:/data
    depends_on:
      - mock-hcm

  mock-hcm:
    build:
      context: .
      dockerfile: apps/mock-hcm/Dockerfile
    ports:
      - "3001:3001"
```

### 12.3 nock for Unit-Level HCM Mocking

For unit tests that must run without any network dependency, `nock` intercepts outbound HTTP calls at the Node.js layer. This allows the circuit breaker, retry policy, and error handling to be exercised in complete isolation:

```
[PSEUDOCODE — SPEC CONTRACT]

// Simulate connection refused (triggers circuit breaker)
nock('http://hcm.example.com')
  .get('/balance/emp-001/loc-nyc/ANNUAL')
  .replyWithError({ code: 'ECONNREFUSED' })

// Simulate 500 error
nock('http://hcm.example.com')
  .post('/deduct')
  .reply(500, { error: 'HCM Internal Error' })

// Simulate timeout
nock('http://hcm.example.com')
  .get('/balance/emp-001/loc-nyc/ANNUAL')
  .delay(10000)        // 10s delay exceeds 5s requestTimeout
  .reply(200, { days: 10 })
```

### 12.4 Key Test Cases

#### Unit Tests — BalanceService
- `getBalance()` returns cached record when `last_synced_at` is within TTL and `is_stale = 0`
- `getBalance()` calls HCM and updates cache when cache record is absent
- `getBalance()` calls HCM and updates cache when `last_synced_at` has expired
- `getBalance()` calls HCM and updates cache when `is_stale = 1`, regardless of TTL
- `getBalance()` returns stale record with `isStale: true` when circuit breaker is OPEN and record exists
- `getBalance()` throws `HcmUnavailableException` when circuit breaker is OPEN and no cache record exists
- Cache UPSERT correctly stores all three dimensions: `employeeId`, `locationId`, `leaveType`

#### Unit Tests — TimeOffService
- `submitRequest()` throws `InsufficientBalanceException` when HCM balance is below `daysRequested`
- `submitRequest()` throws `InsufficientBalanceException` even when HCM returns HTTP 200 but balance is insufficient (defensive guard)
- `submitRequest()` validates all three dimensions are present; throws `ValidationError` if any missing
- `submitRequest()` returns the cached idempotency response on duplicate `idempotencyKey`
- `submitRequest()` serializes concurrent requests for the same `employeeId`; only one proceeds when combined total exceeds balance
- `approveRequest()` throws `InvalidStatusTransitionException` if request is not PENDING
- `approveRequest()` re-verifies HCM balance before deduction; rejects if now insufficient
- `rejectRequest()` updates status to REJECTED without calling HCM
- `cancelRequest()` does not call `restoreBalance` when `hcm_deduction_id` is NULL
- `cancelRequest()` calls `restoreBalance` with correct idempotency key when `hcm_deduction_id` is set

#### Unit Tests — HcmCircuitBreaker
- Circuit breaker transitions from CLOSED to OPEN after `failureThreshold` consecutive failures
- Circuit breaker transitions from OPEN to HALF-OPEN after `openTimeout` elapses
- Circuit breaker transitions from HALF-OPEN to CLOSED after `successThreshold` consecutive successes
- Circuit breaker transitions from HALF-OPEN back to OPEN on a single failure
- Calls in OPEN state fail fast with `CircuitOpenException` without calling HCM

#### Integration Tests — Request Lifecycle
- Full `POST → PENDING → APPROVED` flow: DB state assertions at each step; `hcm_deduction_id` populated after approval
- Full `POST → PENDING → REJECTED` flow: status is REJECTED; `hcm_deduction_id` remains NULL
- Full `POST → PENDING → CANCELLED` flow: status CANCELLED; no `restoreBalance` called (no prior deduction)
- Batch sync `POST /sync/balances` correctly UPSERTs cache for all three leave types
- Batch sync with `generatedAt` older than `cache.last_synced_at` does not overwrite the newer record
- Duplicate `syncId` returns 200 without re-processing
- PENDING requests with `days_requested > new_balance` after batch sync are correctly flagged in response

#### Integration Tests — Concurrency
- Two simultaneous `submitRequest` calls for the same employee, same leave type; combined days exceed balance; exactly one succeeds and one receives `InsufficientBalanceException`
- Work anniversary scenario: HCM balance updated mid-flight between cache read and HCM verification; the HCM-verified value (not the cached value) is used for the arithmetic guard

#### E2E Tests — Resilience (against running mock HCM server)
- Scenario: mock returns 500 five times consecutively → circuit breaker opens → 6th request returns HTTP 503 without hitting mock
- Scenario: circuit breaker is OPEN → balance read returns stale cache with `isStale: true` in response body
- Scenario: circuit breaker is OPEN → `submitRequest` returns HTTP 503 with `Retry-After` header
- Scenario: circuit breaker OPEN → 30s elapses → mock returns 200 twice → circuit breaker closes → writes resume normally
- Scenario: mock configured to timeout → retry policy fires 3 times with exponential backoff → final failure after max retries
- Scenario: mock deduction returns 503 (retryable) → service retries → succeeds on 3rd attempt → single `hcm_deduction_id` stored

#### E2E Tests — Sync & Drift
- `POST /sync/balances` with valid payload → correct balance reflected on subsequent `GET /balances/:id`
- `GET /balances/:employeeId/verify` bypasses cache and always calls mock HCM
- Drift detection: mock balance manually changed; drift cron marks record `is_stale = 1`; next `GET /balances` re-fetches from mock

### 12.5 Coverage Requirements & Reporting

| Layer | Minimum Line Coverage | Minimum Branch Coverage |
|---|---|---|
| Services (business logic) | 90% | 85% |
| HCM adapters | 85% | 80% |
| Controllers | 80% | 75% |
| Guards & interceptors | 80% | 75% |
| **Overall project** | **85%** | **80%** |

**Coverage enforcement in Jest config:**

```
[SPEC — agent generates jest.config.ts]

coverageThreshold: {
  global: {
    lines: 85,
    branches: 80,
    functions: 85,
    statements: 85
  },
  './src/time-off/time-off.service.ts': {
    lines: 90,
    branches: 85
  }
}
```

**Coverage report generation and validation:**

- `npm run test:cov` generates LCOV and HTML reports into the `/coverage` directory.
- The HTML report (`/coverage/lcov-report/index.html`) is stored as part of validation output for reviewer inspection.
- The LCOV report (`/coverage/lcov.info`) is retained for tooling-compatible quality checks.
- Any validation run that drops overall line coverage below 85% or branch coverage below 80% must be treated as a failed submission check.

---

## 13. Submission Package & Local Verification

### 13.1 Deliverables

The final project is submitted as a `.zip` archive via the official submission form.

The `.zip` package must include:

1. Full source code (`/src`, `/test`, configuration files)
2. `README.md` with setup/run instructions
3. `TimeOff_Microservice_TRD.md` (this document)

### 13.2 Runtime and Tooling Snapshot (Current Implementation)

| Category | Implemented |
|---|---|
| Framework | NestJS |
| Language | TypeScript |
| ORM | TypeORM |
| Database | SQLite (`data/timeoff.db`) |
| Validation libraries | `class-validator`, `class-transformer` |
| Test stack | Jest + Supertest |

### 13.3 Standard Local Verification Steps

- `npm install` (Install dependencies)
- `npm run build` (Compile TypeScript)
- `npm run test` (Run the full test suite)

### 13.4 Architecture Consistency Check (Core Integrity Controls)

This implementation is considered valid only when these three controls are present and active:

1. **Circuit Breaker (Resilience):**
   - HCM calls fail fast when upstream is unstable (`CLOSED` / `OPEN` / `HALF_OPEN`)
   - Write paths return HTTP 503 on HCM unavailability

2. **Idempotency (Reliability):**
   - Request submission uses `idempotencyKey`
   - Duplicate submissions with the same key replay the existing result and avoid duplicate side effects

3. **Per-Employee Serialized Locks (Concurrency Integrity):**
   - Submission flow serializes verify-then-commit operations per `employeeId`
   - Prevents concurrent over-allocation against the same HCM balance window

---

## 14. Non-Functional Requirements

| Requirement | Target | Notes |
|---|---|---|
| Balance read latency (cached) | < 50ms p95 | SQLite query; no network I/O |
| Balance read latency (HCM live) | < 500ms p95 | Dependent on HCM SLA; circuit breaker protects against tail latency |
| Request submission latency | < 1,000ms p95 | Includes one HCM round-trip |
| Service availability | 99.9% (excl. HCM downtime) | Read traffic continues during HCM downtime |
| HCM downtime tolerance | Reads from stale cache; writes blocked with HTTP 503 | Circuit breaker auto-recovers when HCM returns |
| Idempotency window | 24 hours | Expired entries cleaned by hourly background job |
| Cache TTL (default) | 300 seconds (5 minutes) | Configurable per deployment |
| Audit log retention | 7 years | Regulatory compliance; `time_off_request` records must not be hard-deleted |
| Test line coverage | ≥ 85% overall | Enforced in automated/local validation checks |
| Test branch coverage | ≥ 80% overall | Enforced in automated/local validation checks |
| Coverage report | HTML + LCOV output | Generated during validation runs |

---

## 15. Open Questions & Future Work

| Item | Detail | Priority |
|---|---|---|
| **Horizontal scaling — distributed lock** | The per-employee in-process lock (§7.2) must be replaced with a Redis `SETNX`-based distributed lock if this service runs as multiple instances. SQLite would also need to migrate to PostgreSQL at that point. | High (before any horizontal scale-out) |
| **HCM Webhook Support** | If the HCM vendor adds outbound webhook support, `POST /sync/balances` can be repurposed as an authenticated webhook receiver. The write path (real-time verification) requires no changes. | Medium |
| **Hourly Leave Granularity** | The schema stores `days_requested` as `REAL`, supporting 0.5 increments. Full hourly granularity requires the HCM API to support sub-day values and the UI to collect `hoursRequested`. | Medium |
| **Notification Service Integration** | On status transitions (APPROVED, REJECTED, CANCELLED), this service should emit a domain event to a notification microservice. A stub event emitter is included in the v1 design; the event bus integration is deferred. | Medium |
| **Manager Delegation** | If the approving manager is themselves on leave, approval delegation must be handled. Out of scope for v1 — requires a separate delegation policy module. | Low |
| **APPROVED request recall** | Employees currently cannot cancel an APPROVED request. A recall flow (which requires manager counter-approval and HCM balance restoration) is deferred to v2. | Low |

---

*End of Technical Requirement Document*

*This document is the single source of truth for the agentic development workflow. It must be read alongside the OpenAPI specification (`openapi.yaml`, to be generated by the agent from §5) and the test suite (`/test/**/*.spec.ts`, to be generated by the agent from §12) as a complete engineering package.*

*Submission format: `.zip` archive via official submission form.*
