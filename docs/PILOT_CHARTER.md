# S2-001 AI Production Pilot Charter

## Question

How can a reproducible, highly autonomous process take an AI application from
an initial problem statement to a production-candidate release while keeping
quality, safety, cost, latency, reliability, provenance, and human authority
measurable?

## Outcome

The pilot must produce a concrete, checked delivery path rather than an essay:

`brief → research → specification → plan → implementation → evaluation → security review → production-like verification → human decision`

The first implementation task is the smallest useful orchestration slice: two
real agent adapters (Codex and pi) plus a provider-neutral CLI must move one
task through `BACKLOG → READY → CLAIMED → RUNNING → IN_REVIEW`. No agent may
move it to `DONE`.

## Authority

- The repository owner is both budget owner and final decision owner.
- Agents may implement, test, challenge, and recommend.
- Paid API budget is exactly USD 0 for this pilot.
- Existing subscription/local CLIs are allowed after their executable and
  identity are verified locally.
- Production deployment, private-source import, permission expansion, and
  human approval impersonation are prohibited.

## Execution boundary

The pilot runs from a feature branch before Veritas PR #13 is merged. It uses a
dedicated local PostgreSQL database and permits only one concurrent job. A
production-like local result is not a production certification.

## Current disposition

`PASS_WITH_LIMITS`: Codex and Pi executed the bounded v2 task in separate
processes, PostgreSQL retained the revision/fence/audit evidence, and the agents
stopped at `IN_REVIEW`. The repository owner then approved the exact submission
digest for scope `solution`, moving the task to `DONE`. The result proves the
minimal pilot lifecycle, not production readiness: no deployment occurred,
per-call subscription billing telemetry was unavailable, and the human action
used an operator-mediated local session rather than production identity
infrastructure.
