# Veritas AI Production Pilot

Public S2-001 pilot for taking an AI application from a frozen task brief to a
production-candidate evidence pack. The pilot is intentionally fail-closed:
agents may implement and recommend, while a human owns budget and final
approval.

Current status: **BLOCKED_ENVIRONMENT**. The local host has Codex and Node.js,
but no `pi` CLI and no dedicated PostgreSQL/Docker runtime. No real pilot run
or production deployment is claimed.

## Implemented reference slice

The repository now contains a deterministic in-memory control-plane oracle for
the first board workflow. It provides canonical hashing, optimistic revisions,
one active lease with fencing, idempotent command replay, a hash-chained journal,
checked artifact submission to `IN_REVIEW`, injected agent authorization, and an
independently authenticated human-only transition to `DONE`.

```powershell
npm test
npm run discovery
```

The in-memory engine is a test oracle, not the durable runtime. State-changing
CLI operations remain fail-closed until a dedicated PostgreSQL instance and the
required Codex/pi/generic adapters are available and frozen. PostgreSQL storage,
real adapter execution, evidence-pack publication, and a human pilot decision
are the next implementation steps.

See [the pilot charter](docs/PILOT_CHARTER.md), [execution plan](docs/EXECUTION_PLAN.md),
and the machine-readable [task brief](pilot/task-brief.json).
