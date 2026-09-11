# Veritas AI Production Pilot

Public S2-001 pilot for taking an AI application from a frozen task brief to a
production-candidate evidence pack. The pilot is intentionally fail-closed:
agents may implement and recommend, while a human owns budget and final
approval.

Current status: **BLOCKED_PREREQUISITES**. The local host has Codex `0.153.4`,
Pi `0.85.1`, Node.js `22.23.2`, and a verified project-local PostgreSQL `17.11`
database on loopback. Provider authentication/task execution and the exact
source freeze are verified. A two-process, authority-free transport smoke has
run through real Codex and Pi CLIs. The persistent PostgreSQL task lifecycle is
still incomplete; no end-to-end pilot run or production deployment is claimed.

## Implemented reference slice

The repository now contains a deterministic in-memory control-plane oracle for
the first board workflow. It provides canonical hashing, optimistic revisions,
one active lease with fencing, idempotent command replay, a hash-chained journal,
checked artifact submission to `IN_REVIEW`, injected agent authorization, and an
independently authenticated human-only transition to `DONE`.

```powershell
npm test
npm run discovery
npm run verify:sources
npm run probe:execution
npm run postgres:start
npm run postgres:status
npm run postgres:stop
```

The in-memory engine is a test oracle, not the durable runtime. State-changing
CLI operations remain fail-closed until the persistent command path is
available and the real task reaches `IN_REVIEW`. Evidence-pack publication and
a human pilot decision are later steps.

`npm run probe:environment` performs bounded `--version` discovery only. It
does not invoke a model. The first PostgreSQL schema is frozen in
`migrations/001_control_plane.sql`; it is applied and verified against the
project-local PostgreSQL server. The server is a test dependency, not a
production deployment.

`npm run probe:auth` performs credential-free readiness checks only: Codex
login status and Pi provider status with `--no-refresh`. It does not emit a
credential or invoke a model.

`npm run probe:execution` is an explicitly authorized, single-use transport
probe. It performs one bounded call through each existing subscription CLI,
disables tools and production actions, records only structured results and
digests, and refuses to run again after a verified manifest exists.

`npm run verify:sources` performs an offline size/SHA-256 verification of the
five tracked primary-source snapshots. The public pilot imports no local-only
or private source material.

The project-local database is deliberately not installed as a Windows service.
Its lifecycle commands are explicit and idempotent; `probe:environment` remains
read-only and reports a stopped database as unavailable.

See [the pilot charter](docs/PILOT_CHARTER.md), [execution plan](docs/EXECUTION_PLAN.md),
and the machine-readable [task brief](pilot/task-brief.json).
