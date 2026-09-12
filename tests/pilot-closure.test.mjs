import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPilotClosureManifest, verifyPilotClosureDigest } from '../src/pilot-closure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = JSON.parse(readFileSync(path.join(root, 'evidence', 'pilot-run-manifest.json'), 'utf8'));

const closureSnapshot = () => ({
  task: { id: run.taskId, status: 'DONE', revision: 7, submission_digest: run.submissionDigest },
  events: [
    { previous_hash: run.priorGlobalEventHash, event_hash: run.firstEventHash, event_type: 'TASK_SEEDED', task_revision: 1 },
    { previous_hash: run.firstEventHash, event_hash: '1'.repeat(64), event_type: 'TASK_READY', task_revision: 2 },
    { previous_hash: '1'.repeat(64), event_hash: '2'.repeat(64), event_type: 'TASK_CLAIMED', task_revision: 3 },
    { previous_hash: '2'.repeat(64), event_hash: '3'.repeat(64), event_type: 'TASK_STARTED', task_revision: 4 },
    { previous_hash: '3'.repeat(64), event_hash: '4'.repeat(64), event_type: 'CHECKPOINT_RECORDED', task_revision: 5 },
    { previous_hash: '4'.repeat(64), event_hash: run.lastEventHash, event_type: 'TASK_SUBMITTED_FOR_REVIEW', task_revision: 6 },
    { previous_hash: run.lastEventHash, event_hash: '5'.repeat(64), event_type: 'HUMAN_DECISION_RECORDED', task_revision: 7 },
  ],
  decisions: [{
    decision_id: 'decision-s2-001-solution-v2', task_id: run.taskId, task_revision: 6,
    actor_id: 'repository-owner', decision: 'APPROVE', decision_scope: 'solution',
    artifact_digest: run.submissionDigest, reason: 'Repository owner approved the bounded solution blueprint with its limits.',
    recorded_at: '2026-09-12T05:23:20.577166-05:00',
  }],
});

test('closure binds the human solution approval without granting production authority', () => {
  const closure = buildPilotClosureManifest({
    pilotRunManifest: run,
    closureSnapshot: closureSnapshot(),
    migrationSha256: 'a'.repeat(64),
  });
  assert.equal(closure.verdict, 'PASS_WITH_LIMITS');
  assert.equal(closure.targetDisposition, 'SOLUTION_APPROVED_PRODUCTION_NOT_AUTHORIZED');
  assert.equal(closure.humanDecisionRecorded, true);
  assert.equal(closure.productionDeploymentAuthorized, false);
  assert.equal(verifyPilotClosureDigest(closure), true);
  assert.equal(verifyPilotClosureDigest({ ...closure, productionDeploymentAuthorized: true }), false);
});

test('closure rejects stale or non-human approval evidence', () => {
  const wrongActor = closureSnapshot();
  wrongActor.decisions[0].actor_id = 'codex-local';
  assert.throws(() => buildPilotClosureManifest({ pilotRunManifest: run, closureSnapshot: wrongActor, migrationSha256: 'a'.repeat(64) }), /repository-owner/);
  const stale = closureSnapshot();
  stale.decisions[0].artifact_digest = '0'.repeat(64);
  assert.throws(() => buildPilotClosureManifest({ pilotRunManifest: run, closureSnapshot: stale, migrationSha256: 'a'.repeat(64) }), /digest/);
});

test('tracked closure manifest verifies and preserves the production boundary', () => {
  const closure = JSON.parse(readFileSync(path.join(root, 'evidence', 'pilot-closure-manifest.json'), 'utf8'));
  assert.equal(verifyPilotClosureDigest(closure), true);
  assert.equal(closure.status, 'DONE');
  assert.equal(closure.decision.value, 'APPROVE');
  assert.equal(closure.decision.scope, 'solution');
  assert.equal(closure.productionDeploymentAuthorized, false);
  assert.equal(closure.productionDeployed, false);
});
