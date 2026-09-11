import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../src/canonical.mjs';
import {
  dispatchPersistentCommand,
  getPersistentTaskSnapshot,
  markPersistentTaskReady,
  seedPersistentTask,
} from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskId = 'S2-001-PERSISTENT-COMMAND-PROBE-v1';
const actorId = 'codex-local';
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const command = (operation, expectedRevision, arguments_) => ({
  contractVersion: '1.0.0-draft',
  operationId: `probe-${operation}-v1`,
  operation,
  actorId,
  taskId,
  expectedRevision,
  arguments: { idempotencyKey: `probe-idem-${operation}-v1`, ...arguments_ },
});

let existing = null;
try { existing = getPersistentTaskSnapshot(taskId); } catch { /* first run */ }
if (!existing) {
  seedPersistentTask({ taskId, goalId: 'S2-001-PERSISTENT-COMMAND-PROBE', title: 'Verify PostgreSQL command lifecycle without model execution' });
  markPersistentTaskReady({ taskId, expectedRevision: 1 });
  const claimed = dispatchPersistentCommand(command('claim', 2, { leaseTtlMs: 120_000 }));
  const lease = claimed.result.lease;
  dispatchPersistentCommand(command('start', 3, { leaseId: lease.lease_id, fencingToken: lease.fencing_token }));
  dispatchPersistentCommand(command('checkpoint', 4, {
    leaseId: lease.lease_id,
    fencingToken: lease.fencing_token,
    checkpoint: { kind: 'command-path-probe', modelExecuted: false },
  }));
  dispatchPersistentCommand(command('submit-for-review', 5, {
    leaseId: lease.lease_id,
    fencingToken: lease.fencing_token,
    artifacts: [{ path: 'README.md', sha256: sha256(path.join(root, 'README.md')) }],
    checks: [{ name: 'postgres-command-path', passed: true }],
  }));
  existing = getPersistentTaskSnapshot(taskId);
}

const events = existing.events;
const chainLinked = events.every((event, index) => event.previous_hash === (index === 0 ? '0'.repeat(64) : events[index - 1].event_hash));
if (existing.task.status !== 'IN_REVIEW' || existing.task.revision !== 6 || events.length !== 6 || !chainLinked) {
  throw new Error('persistent command path did not replay to the expected IN_REVIEW state');
}
const runtime = JSON.parse(fs.readFileSync(path.join(root, '.local', 'postgres-runtime.json'), 'utf8'));
const evidence = {
  schemaVersion: 1,
  decisionInput: true,
  verdict: 'PASS',
  taskId,
  status: existing.task.status,
  revision: existing.task.revision,
  eventCount: events.length,
  chainLinked,
  firstEventHash: events[0].event_hash,
  lastEventHash: events.at(-1).event_hash,
  migrationSha256: runtime.migrationSha256,
  databaseBinding: '127.0.0.1:55432/veritas_pilot',
  modelExecuted: false,
};
const manifest = { ...evidence, evidenceDigest: canonicalHash(evidence) };
fs.writeFileSync(path.join(root, 'evidence', 'postgres-command-path-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ verdict: manifest.verdict, taskId, status: manifest.status, revision: manifest.revision, eventCount: manifest.eventCount, chainLinked, modelExecuted: false, evidenceDigest: manifest.evidenceDigest }, null, 2)}\n`);
