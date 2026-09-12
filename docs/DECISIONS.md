# Owner decisions

| Decision | Value |
|---|---|
| Veritas merge | Keep PR #13 open until the pilots finish |
| Execution branch | Run from `codex/s2-001-product-contract` before merge |
| Pilot repository | Public `SpaceDazher/Veritas-AI-Production-Pilot` |
| Required adapters | Codex, pi, provider-neutral CLI |
| First lifecycle | `BACKLOG` through `IN_REVIEW`; never agent-controlled `DONE` |
| Parallel jobs | 1 |
| Paid API budget | USD 0 |
| Model access | Existing subscription/local CLIs only |
| State store | Dedicated local PostgreSQL |
| Budget owner | Repository owner |
| Final decision owner | Repository owner |
| Research question | Launching AI applications from zero to production |
| Private material | Local-only; raw content and credentials never committed |

These decisions define the pilot, not a production authorization. Changing a
row requires an explicit owner decision and a versioned task-brief revision.
