import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../src/canonical.mjs';

import {
  buildPsqlInvocation,
  validatePersistentCommand,
} from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('durable migration exposes atomic host and agent command functions', () => {
  const sql = readFileSync(path.join(root, 'migrations', '002_command_path.sql'), 'utf8');
  for (const fn of ['pilot_seed_task', 'pilot_mark_ready', 'pilot_dispatch', 'pilot_task_snapshot']) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\b`, 'i'));
  }
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /operation_dedup/i);
  assert.match(sql, /fencing_token/i);
  assert.match(sql, /one-active-job/i);
  assert.match(sql, /sha256\(/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
});

test('persistent command validation rejects unknown fields before database execution', () => {
  const command = {
    contractVersion: '1.0.0-draft', operationId: 'op-1', operation: 'claim',
    actorId: 'codex-local', taskId: 'task-1', expectedRevision: 2,
    arguments: { idempotencyKey: 'idem-1', leaseTtlMs: 30_000 },
  };
  assert.deepEqual(validatePersistentCommand(command), command);
  assert.throws(() => validatePersistentCommand({ ...command, authority: 'DONE' }), /unknown fields/);
  assert.throws(() => validatePersistentCommand({ ...command, expectedRevision: 0 }), /expectedRevision/);
  assert.throws(() => validatePersistentCommand({ ...command, operation: 'approve' }), /unsupported operation/);
});

test('psql invocation is shell-free credential-free and binds one JSON payload', () => {
  const invocation = buildPsqlInvocation({
    executable: 'D:/pilot/psql.exe', runtime: {
      host: '127.0.0.1', port: 55432, database: 'veritas_pilot', applicationRole: 'veritas_app', password: 'runtime-only-secret',
    }, payload: { taskId: 'task-1' }, functionName: 'pilot_task_snapshot',
  });
  assert.equal(invocation.program, 'D:/pilot/psql.exe');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.PGPASSWORD, 'runtime-only-secret');
  assert.equal(invocation.args.some((value) => value.includes('runtime-only-secret')), false);
  assert.deepEqual(invocation.args.slice(-2), ['--file', '-']);
  assert.match(invocation.options.input, /pilot_task_snapshot\(:'payload'::jsonb\)/);
  assert.equal(invocation.options.input.includes('runtime-only-secret'), false);
});

test('tracked PostgreSQL command-path evidence is content-bound and stops at review', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'evidence', 'postgres-command-path-manifest.json'), 'utf8'));
  const digest = manifest.evidenceDigest;
  delete manifest.evidenceDigest;
  assert.equal(canonicalHash(manifest), digest);
  assert.equal(manifest.status, 'IN_REVIEW');
  assert.equal(manifest.chainLinked, true);
  assert.equal(manifest.modelExecuted, false);
  assert.equal(manifest.eventCount, 6);
});
