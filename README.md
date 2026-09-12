# Veritas AI Production Pilot

Public S2-001 pilot for taking an AI application from a frozen task brief to a
production-candidate evidence pack. The pilot is intentionally fail-closed:
agents may implement and recommend, while a human owns budget and final
approval.

Current status: **PASS_WITH_LIMITS — SOLUTION_APPROVED_PRODUCTION_NOT_AUTHORIZED**.
The bounded v2 task ran through real Codex and Pi processes, persisted six
execution events in the project-local PostgreSQL `17.11` database, stopped at
`IN_REVIEW`, and was then approved by the named human owner through a separate
digest-bound path. The task is `DONE` at revision 7. Production deployment was
not executed or authorized, and subscription CLIs did not expose per-call
billing telemetry.

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
npm run postgres:migrate
npm run probe:postgres-command
npm run postgres:stop
```

The in-memory engine is a test oracle. State-changing CLI operations now use
the project-local PostgreSQL command path and repository-local JSON inputs;
every mutation is revision-, lease-, fence-, capability- and idempotency-bound.
The real task, evidence pack and human decision are recorded. Agent execution
is disabled after closure; any production deployment requires a new explicit
authorization and a separate acceptance scope.

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

`npm run pilot:run` produced the immutable review input in
`evidence/pilot-run-manifest.json`. The separately recorded human decision is
bound to its submission digest in `evidence/pilot-closure-manifest.json`.

The project-local database is deliberately not installed as a Windows service.
Its lifecycle commands are explicit and idempotent; `probe:environment` remains
read-only and reports a stopped database as unavailable.

See [the pilot charter](docs/PILOT_CHARTER.md), [execution plan](docs/EXECUTION_PLAN.md),
and the machine-readable [task brief](pilot/task-brief.json).
