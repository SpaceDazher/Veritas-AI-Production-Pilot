import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChildEnvironment, runtimeRecordIsValid } from '../scripts/provision-local-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, '.local', 'postgres-runtime.json');
const psqlPath = path.join(root, '.local', 'postgresql17', 'pgsql', 'bin', 'psql.exe');
const COMMAND_FIELDS = new Set(['contractVersion', 'operationId', 'operation', 'actorId', 'taskId', 'expectedRevision', 'arguments']);
const OPERATIONS = new Set(['claim', 'start', 'heartbeat', 'checkpoint', 'submit-for-review', 'fail', 'cancel']);
const ARGUMENT_FIELDS = {
  claim: new Set(['idempotencyKey', 'leaseTtlMs']),
  start: new Set(['idempotencyKey', 'leaseId', 'fencingToken']),
  heartbeat: new Set(['idempotencyKey', 'leaseId', 'fencingToken']),
  checkpoint: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'checkpoint']),
  'submit-for-review': new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'artifacts', 'checks']),
  fail: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'reason']),
  cancel: new Set(['idempotencyKey', 'leaseId', 'fencingToken', 'reason']),
};
const DATABASE_FUNCTIONS = new Set(['pilot_seed_task', 'pilot_mark_ready', 'pilot_dispatch', 'pilot_task_snapshot', 'pilot_record_human_decision']);
const HUMAN_DECISION_FIELDS = new Set(['schemaVersion', 'decisionId', 'taskId', 'taskRevision', 'actorId', 'decision', 'decisionScope', 'artifactDigest', 'reason']);

const exactObject = (value, fields, name) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) throw new Error(`${name} has unknown fields: ${unknown.join(', ')}`);
};
const requiredString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
};

export const validatePersistentCommand = (command) => {
  exactObject(command, COMMAND_FIELDS, 'command');
  for (const field of ['contractVersion', 'operationId', 'operation', 'actorId', 'taskId']) requiredString(command[field], field);
  if (command.contractVersion !== '1.0.0-draft') throw new Error('unsupported contractVersion');
  if (!OPERATIONS.has(command.operation)) throw new Error(`unsupported operation: ${command.operation}`);
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) throw new Error('expectedRevision must be a positive integer');
  exactObject(command.arguments, ARGUMENT_FIELDS[command.operation], 'arguments');
  requiredString(command.arguments.idempotencyKey, 'arguments.idempotencyKey');
  return structuredClone(command);
};

export const validateHumanDecision = (decision) => {
  exactObject(decision, HUMAN_DECISION_FIELDS, 'human decision');
  if (decision.schemaVersion !== 1) throw new Error('unsupported human decision schemaVersion');
  for (const field of ['decisionId', 'taskId', 'actorId', 'decision', 'decisionScope', 'artifactDigest', 'reason']) requiredString(decision[field], field);
  if (!Number.isInteger(decision.taskRevision) || decision.taskRevision < 1) throw new Error('taskRevision must be a positive integer');
  if (decision.actorId !== 'repository-owner') throw new Error('human decision requires repository-owner');
  if (!['APPROVE', 'REVISE', 'REJECT'].includes(decision.decision)) throw new Error('unsupported human decision');
  if (decision.decisionScope !== 'solution') throw new Error('human decision scope must be solution');
  if (!/^[a-f0-9]{64}$/.test(decision.artifactDigest)) throw new Error('artifactDigest must be a lowercase SHA-256');
  return structuredClone(decision);
};

export const buildPsqlInvocation = ({ executable, runtime, payload, functionName }) => {
  if (!DATABASE_FUNCTIONS.has(functionName)) throw new Error(`unsupported database function: ${functionName}`);
  const serialized = JSON.stringify(payload);
  if (serialized.length > 1_000_000) throw new Error('database payload exceeds 1 MB');
  return {
    program: executable,
    args: [
      '--host', runtime.host,
      '--port', String(runtime.port),
      '--username', runtime.applicationRole,
      '--dbname', runtime.database,
      '--set', 'ON_ERROR_STOP=1',
      '--tuples-only', '--no-align', '--quiet',
      `--set=payload=${serialized}`,
      '--file', '-',
    ],
    options: {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      shell: false,
      maxBuffer: 2_000_000,
      input: `SELECT ${functionName}(:'payload'::jsonb);\n`,
      env: buildChildEnvironment(process.env, '', { PGPASSWORD: runtime.password }),
    },
  };
};

const loadRuntime = () => {
  if (!fs.existsSync(runtimePath) || !fs.existsSync(psqlPath)) throw new Error('local PostgreSQL runtime is unavailable');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  if (!runtimeRecordIsValid(runtime)) throw new Error('local PostgreSQL runtime record is invalid');
  return runtime;
};

export const callPostgresFunction = (functionName, payload, { execute = spawnSync } = {}) => {
  const invocation = buildPsqlInvocation({ executable: psqlPath, runtime: loadRuntime(), payload, functionName });
  const result = execute(invocation.program, invocation.args, invocation.options);
  if (result.status !== 0) {
    const diagnostic = `${result.stderr ?? ''}`.trim().slice(-2000);
    throw new Error(`PostgreSQL ${functionName} failed: ${diagnostic || `status ${result.status ?? 'unknown'}`}`);
  }
  const text = `${result.stdout ?? ''}`.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PostgreSQL ${functionName} returned non-JSON output`);
  }
};

export const dispatchPersistentCommand = (command, options) => callPostgresFunction('pilot_dispatch', validatePersistentCommand(command), options);
export const seedPersistentTask = (payload, options) => callPostgresFunction('pilot_seed_task', payload, options);
export const markPersistentTaskReady = (payload, options) => callPostgresFunction('pilot_mark_ready', payload, options);
export const getPersistentTaskSnapshot = (taskId, options) => callPostgresFunction('pilot_task_snapshot', { taskId }, options);
export const recordPersistentHumanDecision = (decision, options) => callPostgresFunction('pilot_record_human_decision', validateHumanDecision(decision), options);
