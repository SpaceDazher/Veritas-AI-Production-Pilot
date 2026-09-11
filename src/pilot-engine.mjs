import { canonicalHash, deepClone } from './canonical.mjs';

const ZERO_HASH = '0'.repeat(64);
const COMMAND_FIELDS = new Set(['contractVersion', 'operationId', 'operation', 'actorId', 'taskId', 'expectedRevision', 'arguments']);
const HUMAN_FIELDS = new Set(['actorId', 'actorType', 'authenticationProof', 'taskId', 'expectedRevision', 'decision', 'artifactDigest', 'reason']);
const ARGUMENT_FIELDS = {
  claim: new Set(['idempotencyKey', 'leaseTtlMs']),
  start: new Set(['idempotencyKey', 'leaseId', 'fencingToken']),
  heartbeat: new Set(['idempotencyKey', 'leaseId', 'fencingToken']),
  checkpoint: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'checkpoint']),
  'submit-for-review': new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'artifacts', 'checks']),
  fail: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'reason']),
  cancel: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'reason']),
};

export class PilotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PilotError';
    this.code = code;
  }
}

const requiredString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new PilotError('INVALID_REQUEST', `${name} must be a non-empty string`);
};

const exactFields = (value, allowed, context) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PilotError('INVALID_REQUEST', `${context} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new PilotError('INVALID_REQUEST', `${context} has unknown fields: ${unknown.join(', ')}`);
};

const validArtifact = (artifact) => {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
  if (Object.keys(artifact).some((key) => !['path', 'sha256'].includes(key))) return false;
  if (typeof artifact.path !== 'string' || artifact.path.length === 0) return false;
  const normalized = artifact.path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) return false;
  return /^[a-f0-9]{64}$/.test(artifact.sha256 ?? '');
};

export class PilotEngine {
  #tasks = new Map();
  #leases = new Map();
  #operations = new Map();
  #idempotencyKeys = new Map();
  #journal = [];
  #fencingToken = 0;
  #clock;
  #leaseTtlMs;
  #authorizeAgentOperation;
  #authorizeHumanDecision;

  constructor({ clock = Date.now, leaseTtlMs = 30_000, authorizeAgentOperation = () => false, authorizeHumanDecision = () => false } = {}) {
    if (typeof clock !== 'function' || typeof authorizeAgentOperation !== 'function' || typeof authorizeHumanDecision !== 'function' || !Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) throw new PilotError('INVALID_REQUEST', 'clock, agent and human authorizers, and a positive finite leaseTtlMs are required');
    this.#clock = clock;
    this.#leaseTtlMs = leaseTtlMs;
    this.#authorizeAgentOperation = authorizeAgentOperation;
    this.#authorizeHumanDecision = authorizeHumanDecision;
  }

  seedTask({ taskId, goalId, title }) {
    requiredString(taskId, 'taskId');
    requiredString(goalId, 'goalId');
    requiredString(title, 'title');
    if (this.#tasks.has(taskId)) throw new PilotError('INVALID_REQUEST', 'task already exists');
    const task = { id: taskId, goalId, title, status: 'BACKLOG', revision: 1 };
    this.#tasks.set(taskId, task);
    this.#append('TASK_SEEDED', task, 'host', { status: task.status });
    return deepClone(task);
  }

  markReady({ taskId, expectedRevision }) {
    const task = this.#task(taskId);
    this.#expectRevision(task, expectedRevision);
    if (!['BACKLOG', 'BLOCKED'].includes(task.status)) throw new PilotError('INVALID_TRANSITION', `${task.status} cannot transition to READY`);
    task.status = 'READY';
    task.revision += 1;
    this.#append('TASK_READY', task, 'host', { status: task.status });
    return deepClone(task);
  }

  getTask(taskId) { return deepClone(this.#task(taskId)); }
  getJournal() { return deepClone(this.#journal); }

  dispatch(command) {
    this.#validateCommand(command);
    let authorized = false;
    try {
      authorized = this.#authorizeAgentOperation(deepClone(command)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) throw new PilotError('CAPABILITY_DENIED', 'the actor is not authorized for this operation');
    const requestHash = canonicalHash(command);
    const prior = this.#operations.get(command.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new PilotError('IDEMPOTENCY_CONFLICT', 'operationId was already used with a different payload');
      return { replayed: true, result: deepClone(prior.result) };
    }
    const priorOperationId = this.#idempotencyKeys.get(command.arguments.idempotencyKey);
    if (priorOperationId) throw new PilotError('IDEMPOTENCY_CONFLICT', `idempotencyKey was already consumed by ${priorOperationId}`);
    const handler = {
      claim: () => this.#claim(command), start: () => this.#start(command),
      heartbeat: () => this.#heartbeat(command), checkpoint: () => this.#checkpoint(command),
      'submit-for-review': () => this.#submit(command), fail: () => this.#finish(command, 'FAILED'),
      cancel: () => this.#finish(command, 'CANCELLED'),
    }[command.operation];
    const result = handler();
    this.#operations.set(command.operationId, { requestHash, result: deepClone(result) });
    this.#idempotencyKeys.set(command.arguments.idempotencyKey, command.operationId);
    return { replayed: false, result: deepClone(result) };
  }

  recordHumanDecision(decision) {
    exactFields(decision, HUMAN_FIELDS, 'human decision');
    requiredString(decision.actorId, 'actorId');
    requiredString(decision.taskId, 'taskId');
    requiredString(decision.reason, 'reason');
    let authorized = false;
    if (decision.actorType === 'human') {
      try {
        authorized = this.#authorizeHumanDecision(deepClone(decision)) === true;
      } catch {
        authorized = false;
      }
    }
    if (!authorized) throw new PilotError('HUMAN_APPROVAL_REQUIRED', 'an independently authenticated human is required');
    const task = this.#task(decision.taskId);
    this.#expectRevision(task, decision.expectedRevision);
    if (task.status !== 'IN_REVIEW') throw new PilotError('INVALID_TRANSITION', 'only an IN_REVIEW task can receive a decision');
    if (decision.artifactDigest !== task.submissionDigest) throw new PilotError('ARTIFACT_BINDING_MISMATCH', 'decision is not bound to the current submission');
    const status = { APPROVE: 'DONE', REVISE: 'READY', REJECT: 'FAILED' }[decision.decision];
    if (!status) throw new PilotError('INVALID_REQUEST', 'unsupported human decision');
    task.status = status;
    task.revision += 1;
    task.humanDecision = { actorId: decision.actorId, decision: decision.decision, artifactDigest: decision.artifactDigest, reason: decision.reason };
    this.#append('HUMAN_DECISION_RECORDED', task, decision.actorId, task.humanDecision);
    return deepClone(task);
  }

  #validateCommand(command) {
    exactFields(command, COMMAND_FIELDS, 'command');
    for (const field of ['contractVersion', 'operationId', 'operation', 'actorId', 'taskId']) requiredString(command[field], field);
    if (command.contractVersion !== '1.0.0-draft') throw new PilotError('INVALID_REQUEST', 'unsupported contractVersion');
    const allowed = ARGUMENT_FIELDS[command.operation];
    if (!allowed) throw new PilotError('UNSUPPORTED_OPERATION', `unsupported operation: ${command.operation}`);
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) throw new PilotError('INVALID_REQUEST', 'expectedRevision must be a positive integer');
    exactFields(command.arguments, allowed, 'arguments');
    requiredString(command.arguments.idempotencyKey, 'arguments.idempotencyKey');
  }

  #claim(command) {
    const task = this.#task(command.taskId);
    this.#expectRevision(task, command.expectedRevision);
    if (task.status !== 'READY') throw new PilotError('INVALID_TRANSITION', 'only READY tasks can be claimed');
    const active = [...this.#leases.values()].find((lease) => !lease.released && this.#clock() < lease.expiresAt);
    if (active) throw new PilotError('ACTIVE_JOB_EXISTS', 'the one-job pilot already has an active lease');
    const ttl = command.arguments.leaseTtlMs ?? this.#leaseTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new PilotError('INVALID_REQUEST', 'leaseTtlMs must be positive and finite');
    this.#fencingToken += 1;
    const lease = { leaseId: `lease-${this.#fencingToken}-${task.id}`, taskId: task.id, actorId: command.actorId, fencingToken: this.#fencingToken, expiresAt: this.#clock() + ttl, released: false };
    this.#leases.set(lease.leaseId, lease);
    task.status = 'CLAIMED';
    task.revision += 1;
    task.leaseId = lease.leaseId;
    task.fencingToken = lease.fencingToken;
    this.#append('TASK_CLAIMED', task, command.actorId, { leaseId: lease.leaseId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt });
    return { task: deepClone(task), ...deepClone(lease) };
  }

  #start(command) {
    const { task, lease } = this.#leased(command, 'CLAIMED');
    task.status = 'RUNNING';
    task.revision += 1;
    this.#append('TASK_STARTED', task, command.actorId, { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
    return { task: deepClone(task), lease: deepClone(lease) };
  }

  #heartbeat(command) {
    const { task, lease } = this.#leased(command, 'RUNNING');
    lease.expiresAt = this.#clock() + this.#leaseTtlMs;
    this.#append('LEASE_HEARTBEAT', task, command.actorId, { leaseId: lease.leaseId, expiresAt: lease.expiresAt });
    return { task: deepClone(task), lease: deepClone(lease) };
  }

  #checkpoint(command) {
    const { task, lease } = this.#leased(command, 'RUNNING');
    if (command.arguments.checkpoint === undefined) throw new PilotError('INVALID_REQUEST', 'checkpoint is required');
    const checkpointDigest = canonicalHash(command.arguments.checkpoint);
    task.revision += 1;
    task.checkpointDigest = checkpointDigest;
    this.#append('CHECKPOINT_RECORDED', task, command.actorId, { leaseId: lease.leaseId, checkpointDigest });
    return { task: deepClone(task), checkpointDigest };
  }

  #submit(command) {
    const { task, lease } = this.#leased(command, 'RUNNING');
    const { artifacts, checks } = command.arguments;
    if (!Array.isArray(artifacts) || !artifacts.length || artifacts.some((item) => !validArtifact(item))) throw new PilotError('ARTIFACTS_REQUIRED', 'at least one valid, repository-relative artifact is required');
    if (!Array.isArray(checks) || !checks.length) throw new PilotError('CHECKS_REQUIRED', 'at least one executable check is required');
    for (const check of checks) {
      exactFields(check, new Set(['name', 'passed']), 'check');
      requiredString(check.name, 'check.name');
      if (check.passed !== true) throw new PilotError('CHECK_FAILED', 'all submitted checks must pass');
    }
    task.status = 'IN_REVIEW';
    task.revision += 1;
    task.submissionDigest = canonicalHash({ artifacts, checks });
    task.artifacts = deepClone(artifacts);
    task.checks = deepClone(checks);
    lease.released = true;
    this.#append('TASK_SUBMITTED_FOR_REVIEW', task, command.actorId, { leaseId: lease.leaseId, submissionDigest: task.submissionDigest });
    return { task: deepClone(task), submissionDigest: task.submissionDigest };
  }

  #finish(command, status) {
    const { task, lease } = this.#leased(command, ['CLAIMED', 'RUNNING']);
    requiredString(command.arguments.reason, 'arguments.reason');
    task.status = status;
    task.revision += 1;
    lease.released = true;
    this.#append(`TASK_${status}`, task, command.actorId, { reason: command.arguments.reason });
    return { task: deepClone(task) };
  }

  #leased(command, expectedStatus) {
    const task = this.#task(command.taskId);
    this.#expectRevision(task, command.expectedRevision);
    const validStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!validStatuses.includes(task.status)) throw new PilotError('INVALID_TRANSITION', `${task.status} is not valid for ${command.operation}`);
    requiredString(command.arguments.leaseId, 'arguments.leaseId');
    const lease = this.#leases.get(command.arguments.leaseId);
    if (!lease || lease.taskId !== task.id || lease.actorId !== command.actorId || lease.released) throw new PilotError('LEASE_REQUIRED', 'a live task lease owned by the actor is required');
    if (!Number.isInteger(command.arguments.fencingToken) || command.arguments.fencingToken !== lease.fencingToken) throw new PilotError('STALE_FENCE', 'fencing token does not match the active lease');
    if (this.#clock() >= lease.expiresAt) throw new PilotError('LEASE_EXPIRED', 'lease has expired');
    return { task, lease };
  }

  #task(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new PilotError('TASK_NOT_FOUND', `task not found: ${taskId}`);
    return task;
  }

  #expectRevision(task, expectedRevision) {
    if (task.revision !== expectedRevision) throw new PilotError('STALE_REVISION', `expected revision ${expectedRevision}; current revision is ${task.revision}`);
  }

  #append(eventType, task, actorId, data) {
    const event = { sequence: this.#journal.length + 1, eventType, taskId: task.id, actorId, taskRevision: task.revision, observedAtMs: this.#clock(), previousHash: this.#journal.at(-1)?.eventHash ?? ZERO_HASH, data };
    event.eventHash = canonicalHash(event);
    this.#journal.push(event);
  }
}
