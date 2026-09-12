#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dispatchPersistentCommand,
  getPersistentTaskSnapshot,
  markPersistentTaskReady,
  seedPersistentTask,
} from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const [brief, contract, environment] = await Promise.all([
  loadJson('pilot/task-brief.json'),
  loadJson('contracts/adapter-contract.json'),
  loadJson('evidence/environment-manifest.json'),
]);
const missingPrerequisites = [!environment.pi?.available && 'pi-cli', !environment.dedicatedPostgresql?.available && 'dedicated-postgresql'].filter(Boolean);
const blockers = Array.isArray(brief.blockers) ? brief.blockers : [];
const executionEnabled = brief.executionAuthorized === true && missingPrerequisites.length === 0 && blockers.length === 0;
const status = missingPrerequisites.length > 0
  ? 'BLOCKED_ENVIRONMENT'
  : blockers.length > 0 ? 'BLOCKED_PREREQUISITES'
    : executionEnabled ? 'READY' : 'BLOCKED_AUTHORIZATION';
const operation = process.argv[2] ?? 'discover';

const emitError = (error, fallback = 'PERSISTENT_COMMAND_FAILED') => {
  const known = [
    'INVALID_REQUEST', 'UNSUPPORTED_OPERATION', 'INVALID_TRANSITION', 'TASK_NOT_FOUND',
    'CAPABILITY_DENIED', 'STALE_REVISION', 'LEASE_REQUIRED', 'LEASE_EXPIRED',
    'STALE_FENCE', 'ACTIVE_JOB_EXISTS', 'IDEMPOTENCY_CONFLICT', 'ARTIFACTS_REQUIRED',
    'CHECK_FAILED', 'HUMAN_APPROVAL_REQUIRED',
  ];
  const code = known.find((candidate) => `${error.message}`.includes(candidate)) ?? fallback;
  process.stderr.write(`${JSON.stringify({ error: code, message: `${error.message}`.slice(0, 2000) })}\n`);
  process.exit(2);
};

const readInput = async () => {
  const index = process.argv.indexOf('--input');
  if (index < 0 || !process.argv[index + 1]) throw new Error('INVALID_REQUEST: --input <repository-local-json> is required');
  const inputPath = path.resolve(root, process.argv[index + 1]);
  if (inputPath !== root && !inputPath.startsWith(`${root}${path.sep}`)) throw new Error('INVALID_REQUEST: input path escapes repository');
  return JSON.parse(await readFile(inputPath, 'utf8'));
};

if (operation === 'discover') {
  process.stdout.write(`${JSON.stringify({ contractVersion: contract.contractVersion, executionEnabled, maxConcurrentJobs: contract.limits.maxConcurrentJobs, paidApiBudgetUsd: contract.limits.paidApiBudgetUsd, operations: contract.operations, missingPrerequisites, status }, null, 2)}\n`);
  process.exit(0);
}
if (!executionEnabled) {
  process.stderr.write(`${JSON.stringify({ error: status, message: 'State-changing operations are disabled until the frozen prerequisites and authorization are satisfied.', missingPrerequisites })}\n`);
  process.exit(2);
}
try {
  const input = await readInput();
  const result = operation === 'seed'
    ? seedPersistentTask(input)
    : operation === 'ready'
      ? markPersistentTaskReady(input)
      : operation === 'snapshot'
        ? getPersistentTaskSnapshot(input.taskId)
        : contract.operations.includes(operation)
          ? dispatchPersistentCommand(input)
          : (() => { throw new Error(`UNSUPPORTED_OPERATION: ${operation}`); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  emitError(error);
}
