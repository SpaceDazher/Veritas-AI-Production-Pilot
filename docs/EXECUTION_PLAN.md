# Execution plan

## Phase 0 — prerequisites

1. Install and identify the real `pi` CLI.
2. Provision a dedicated local PostgreSQL instance and non-production role.
3. Verify Codex and pi can run without paid API usage.
4. Freeze executable versions and environment hashes.

Observed local status: Pi `0.85.1`, Codex `0.153.4`, Node `22.23.2`, and a
loopback-only PostgreSQL `17.11` database are version-verified. The database
migration has been applied. Codex subscription and Pi `zai-coding-cn`
authentication are verified without emitting credentials or invoking a model.
Five primary public sources are frozen as tracked SHA-256-bound snapshots;
local-only inputs are explicitly empty. A bounded, authority-free transport
smoke has executed successfully through real Codex and Pi processes, with
separate PIDs and no raw transcripts committed. Persistent task lifecycle
execution through PostgreSQL remains open, so completion remains fail-closed.

## Phase 1 — contract tests

Validate adapter discovery, supported operations, error taxonomy, state
transitions, idempotency, revision checks, fencing, and the human-only final
gate. Mutation tests must demonstrate that unknown fields and authority
expansion fail closed.

## Phase 2 — generic CLI

Implement the provider-neutral commands `discover`, `claim`, `start`,
`heartbeat`, `checkpoint`, `submit-for-review`, `fail`, and `cancel`. The CLI
must emit structured JSON and never parse human prose as authority.

## Phase 3 — real adapters

Implement Codex and pi adapters against the same frozen contract. Each adapter
must publish an identity, capability set, executable version, and environment
digest. A missing or inconsistent capability blocks scheduling.

## Phase 4 — one-job runner

Persist canonical task/run/event state in PostgreSQL. Claim atomically, enforce
one active lease, use database time, and reject stale fencing tokens. Unknown
side-effect outcomes enter reconciliation.

## Phase 5 — end-to-end pilot

Run one frozen task through both real adapters and the generic CLI. Record raw
events, transcripts with secret redaction, artifacts, checks, resource usage,
and failure reasons. Stop at `IN_REVIEW`.

## Phase 6 — evaluation and adversarial replay

Measure correctness, task quality/non-inferiority, cost, latency, recovery,
replay safety, and false completion. Execute separate-process reruns and probes
for duplicate claim, stale lease, forged completion, missing artifacts,
permission expansion, prompt injection, and unknown outcomes.

## Phase 7 — human decision

Package all evidence and limitations. Only the named human decision owner may
record `APPROVE`, `REVISE`, or `REJECT`. The result remains research evidence,
not production deployment authority.
