import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalHash } from '../src/canonical.mjs';
import { PilotEngine, PilotError } from '../src/pilot-engine.mjs';

const base = (operation, overrides = {}) => ({
  contractVersion: '1.0.0-draft',
  operationId: `op-${operation}-0001`,
  operation,
  actorId: 'agent-codex',
  taskId: 'TASK-001',
  expectedRevision: 2,
  arguments: {},
  ...overrides,
});

const setup = () => {
  let now = 1_000;
  const engine = new PilotEngine({
    clock: () => now,
    leaseTtlMs: 100,
    authorizeAgentOperation: ({ actorId }) => actorId === 'agent-codex',
    authorizeHumanDecision: ({ actorId, authenticationProof }) =>
      actorId === 'owner' && authenticationProof === 'verified-by-host',
  });
  engine.seedTask({ taskId: 'TASK-001', goalId: 'GOAL-001', title: 'Implement the smallest safe vertical slice' });
  engine.markReady({ taskId: 'TASK-001', expectedRevision: 1 });
  return { engine, advance: (ms) => { now += ms; } };
};

const claim = (engine, overrides = {}) => engine.dispatch(base('claim', {
  arguments: { idempotencyKey: 'idem-claim-0001', leaseTtlMs: 100 },
  ...overrides,
}));

test('canonical hashing is order-independent and rejects non-finite values', () => {
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
  assert.throws(() => canonicalHash({ score: Number.NaN }), /finite/);
});

test('host seeds a task and only the host can make it READY', () => {
  const { engine } = setup();
  assert.equal(engine.getTask('TASK-001').status, 'READY');
  assert.equal(engine.getTask('TASK-001').revision, 2);
  assert.throws(() => engine.dispatch(base('ready', { operationId: 'op-ready-0001' })), /unsupported/i);
});

test('one active lease is enforced across the pilot', () => {
  const { engine } = setup();
  engine.seedTask({ taskId: 'TASK-002', goalId: 'GOAL-001', title: 'Second task' });
  engine.markReady({ taskId: 'TASK-002', expectedRevision: 1 });
  claim(engine);
  assert.throws(() => claim(engine, {
    operationId: 'op-claim-0002',
    taskId: 'TASK-002',
    arguments: { idempotencyKey: 'idem-claim-0002', leaseTtlMs: 100 },
  }), (error) => error instanceof PilotError && error.code === 'ACTIVE_JOB_EXISTS');
});

test('idempotency replays the same request and rejects altered payload', () => {
  const { engine } = setup();
  const first = claim(engine);
  const replay = claim(engine);
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.leaseId, first.result.leaseId);
  assert.throws(() => claim(engine, {
    arguments: { idempotencyKey: 'changed-key', leaseTtlMs: 100 },
  }), (error) => error instanceof PilotError && error.code === 'IDEMPOTENCY_CONFLICT');
});

test('idempotency keys cannot be reused through a different operation id', () => {
  const { engine, advance } = setup();
  claim(engine);
  engine.seedTask({ taskId: 'TASK-002', goalId: 'GOAL-001', title: 'Second task' });
  engine.markReady({ taskId: 'TASK-002', expectedRevision: 1 });
  advance(100);
  assert.throws(() => claim(engine, {
    operationId: 'op-claim-0002',
    taskId: 'TASK-002',
    arguments: { idempotencyKey: 'idem-claim-0001', leaseTtlMs: 100 },
  }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('unknown command fields fail closed', () => {
  const { engine } = setup();
  assert.throws(() => engine.dispatch({ ...base('claim'), permissionGrant: 'admin' }), (error) =>
    error instanceof PilotError && error.code === 'INVALID_REQUEST');
});

test('an unregistered agent cannot claim work by naming itself in the request', () => {
  const { engine } = setup();
  engine.authorizeAgentOperation = () => true;
  assert.throws(() => claim(engine, { actorId: 'agent-unregistered' }), (error) =>
    error instanceof PilotError && error.code === 'CAPABILITY_DENIED');
  assert.equal(engine.getTask('TASK-001').status, 'READY');
});

test('stale revision and stale fencing token are rejected', () => {
  const { engine } = setup();
  const leased = claim(engine).result;
  assert.throws(() => engine.dispatch(base('start', {
    operationId: 'op-start-stale-revision',
    expectedRevision: 2,
    arguments: { idempotencyKey: 'idem-start-0001', leaseId: leased.leaseId, fencingToken: leased.fencingToken },
  })), (error) => error.code === 'STALE_REVISION');
  assert.throws(() => engine.dispatch(base('start', {
    operationId: 'op-start-stale-fence',
    expectedRevision: 3,
    arguments: { idempotencyKey: 'idem-start-0002', leaseId: leased.leaseId, fencingToken: leased.fencingToken - 1 },
  })), (error) => error.code === 'STALE_FENCE');
});

test('expired lease fails closed', () => {
  const { engine, advance } = setup();
  const leased = claim(engine).result;
  advance(100);
  engine.clock = () => 1_000;
  assert.throws(() => engine.dispatch(base('start', {
    operationId: 'op-start-expired',
    expectedRevision: 3,
    arguments: { idempotencyKey: 'idem-start-expired', leaseId: leased.leaseId, fencingToken: leased.fencingToken },
  })), (error) => error.code === 'LEASE_EXPIRED');
});

test('a real agent path stops at IN_REVIEW with checked artifacts', () => {
  const { engine } = setup();
  const leased = claim(engine).result;
  engine.dispatch(base('start', {
    operationId: 'op-start-0001',
    expectedRevision: 3,
    arguments: { idempotencyKey: 'idem-start-0001', leaseId: leased.leaseId, fencingToken: leased.fencingToken },
  }));
  const result = engine.dispatch(base('submit-for-review', {
    operationId: 'op-submit-0001',
    expectedRevision: 4,
    arguments: {
      idempotencyKey: 'idem-submit-0001',
      leaseId: leased.leaseId,
      fencingToken: leased.fencingToken,
      artifacts: [{ path: 'dist/result.json', sha256: 'a'.repeat(64) }],
      checks: [{ name: 'unit', passed: true }],
    },
  })).result;
  assert.equal(result.task.status, 'IN_REVIEW');
  assert.equal(result.task.revision, 5);
  assert.match(result.task.submissionDigest, /^[a-f0-9]{64}$/);
});

test('missing artifacts or failed checks cannot enter review', () => {
  const { engine } = setup();
  const leased = claim(engine).result;
  engine.dispatch(base('start', {
    operationId: 'op-start-0001', expectedRevision: 3,
    arguments: { idempotencyKey: 'idem-start-0001', leaseId: leased.leaseId, fencingToken: leased.fencingToken },
  }));
  assert.throws(() => engine.dispatch(base('submit-for-review', {
    operationId: 'op-submit-empty', expectedRevision: 4,
    arguments: { idempotencyKey: 'idem-empty', leaseId: leased.leaseId, fencingToken: leased.fencingToken, artifacts: [], checks: [] },
  })), (error) => error.code === 'ARTIFACTS_REQUIRED');
  assert.throws(() => engine.dispatch(base('submit-for-review', {
    operationId: 'op-submit-expanded-check', expectedRevision: 4,
    arguments: {
      idempotencyKey: 'idem-expanded-check', leaseId: leased.leaseId, fencingToken: leased.fencingToken,
      artifacts: [{ path: 'dist/result.json', sha256: 'a'.repeat(64) }],
      checks: [{ name: 'unit', passed: true, authorityGrant: 'admin' }],
    },
  })), (error) => error.code === 'INVALID_REQUEST');
});

test('only an authenticated human bound to the submission may mark DONE', () => {
  const { engine } = setup();
  const leased = claim(engine).result;
  engine.dispatch(base('start', {
    operationId: 'op-start-0001', expectedRevision: 3,
    arguments: { idempotencyKey: 'idem-start-0001', leaseId: leased.leaseId, fencingToken: leased.fencingToken },
  }));
  const reviewed = engine.dispatch(base('submit-for-review', {
    operationId: 'op-submit-0001', expectedRevision: 4,
    arguments: {
      idempotencyKey: 'idem-submit-0001', leaseId: leased.leaseId, fencingToken: leased.fencingToken,
      artifacts: [{ path: 'dist/result.json', sha256: 'b'.repeat(64) }], checks: [{ name: 'unit', passed: true }],
    },
  })).result.task;
  engine.authorizeHumanDecision = () => true;
  assert.throws(() => engine.recordHumanDecision({
    actorId: 'agent-codex', actorType: 'agent', authenticationProof: 'verified-by-host', taskId: reviewed.id,
    expectedRevision: reviewed.revision, decision: 'APPROVE', artifactDigest: reviewed.submissionDigest, reason: 'self approve',
  }), (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');
  assert.throws(() => engine.recordHumanDecision({
    actorId: 'owner', actorType: 'human', authenticationProof: 'invalid', taskId: reviewed.id,
    expectedRevision: reviewed.revision, decision: 'APPROVE', artifactDigest: reviewed.submissionDigest, reason: 'unverified caller claim',
  }), (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');
  assert.throws(() => engine.recordHumanDecision({
    actorId: 'owner', actorType: 'human', authenticationProof: 'verified-by-host', taskId: reviewed.id,
    expectedRevision: reviewed.revision, decision: 'APPROVE', artifactDigest: 'c'.repeat(64), reason: 'wrong artifact',
  }), (error) => error.code === 'ARTIFACT_BINDING_MISMATCH');
  const approved = engine.recordHumanDecision({
    actorId: 'owner', actorType: 'human', authenticationProof: 'verified-by-host', taskId: reviewed.id,
    expectedRevision: reviewed.revision, decision: 'APPROVE', artifactDigest: reviewed.submissionDigest, reason: 'verified evidence',
  });
  assert.equal(approved.status, 'DONE');
});

test('journal is append-only to callers and hash chained', () => {
  const { engine } = setup();
  claim(engine);
  const journal = engine.getJournal();
  assert(journal.length >= 3);
  for (let index = 0; index < journal.length; index += 1) {
    assert.equal(journal[index].sequence, index + 1);
    assert.equal(journal[index].previousHash, index === 0 ? '0'.repeat(64) : journal[index - 1].eventHash);
  }
  journal[0].eventType = 'tampered';
  assert.notEqual(engine.getJournal()[0].eventType, 'tampered');
});
