import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = () => readFileSync(path.join(root, 'migrations/001_control_plane.sql'), 'utf8');

test('PostgreSQL schema owns canonical state, leases, replay and evidence', () => {
  const sql = migration();
  for (const table of ['principal', 'adapter_capability', 'pilot_task', 'task_lease', 'operation_dedup', 'audit_event', 'human_decision', 'scheduler_lock']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`, 'i'));
  }
  assert.match(sql, /CREATE UNIQUE INDEX one_unreleased_pilot_lease/i);
  assert.match(sql, /WHERE released_at IS NULL/i);
  assert.match(sql, /idempotency_key text NOT NULL UNIQUE/i);
  assert.match(sql, /expected_revision bigint NOT NULL/i);
  assert.match(sql, /fencing_token bigint NOT NULL/i);
});

test('PostgreSQL schema uses database time and append-only decision evidence', () => {
  const sql = migration();
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /CREATE TRIGGER audit_event_append_only/i);
  assert.match(sql, /CREATE TRIGGER human_decision_append_only/i);
  assert.match(sql, /UPDATE OR DELETE/i);
  assert.match(sql, /artifact_digest char\(64\) NOT NULL/i);
  assert.match(sql, /CREATE TRIGGER human_decision_authority/i);
  assert.match(sql, /actor_type\s+IS DISTINCT FROM\s+'human'/i);
  assert.match(sql, /CREATE TRIGGER task_lease_authority/i);
  assert.match(sql, /actor_type\s+IS DISTINCT FROM\s+'agent'/i);
});

test('migration contains no destructive reset or broad grants', () => {
  const sql = migration();
  assert.doesNotMatch(sql, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.doesNotMatch(sql, /GRANT\s+ALL/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
});
