import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPilotRunManifest,
  parseCodexSolution,
  parsePiReview,
  verifyPilotRunDigest,
} from '../src/pilot-run-artifacts.mjs';

const solution = () => ({
  schemaVersion: 1,
  taskId: 'S2-001-AI-PRODUCTION-TASK-v1',
  role: 'codex-implementer',
  objective: 'Create a bounded production-candidate delivery blueprint for an AI application.',
  assumptions: ['No production deployment is authorized.', 'Existing subscription CLIs only.'],
  architecture: ['Human approval gate', 'Provider-neutral model adapter', 'Observable application service'],
  deliveryStages: [
    { name: 'specification', outcome: 'Frozen acceptance contract', verification: 'Schema and mutation checks' },
    { name: 'implementation', outcome: 'Versioned candidate', verification: 'Unit and integration checks' },
    { name: 'evaluation', outcome: 'Measured evidence', verification: 'Frozen corpus and rerun' },
  ],
  metrics: [{ name: 'correctness', target: 'all hard gates pass', measurement: 'executable acceptance suite' }],
  risks: [{ risk: 'model output is untrusted', mitigation: 'schema validation and human review' }],
  productionDeploymentAuthorized: false,
  finalApprovalClaimed: false,
});

const review = () => ({
  schemaVersion: 1,
  taskId: 'S2-001-AI-PRODUCTION-TASK-v1',
  role: 'pi-independent-reviewer',
  verdict: 'PASS_WITH_LIMITS',
  verifiedCriteria: ['human authority preserved', 'production deployment remains disabled'],
  findings: ['The artifact is a blueprint, not a deployed application.'],
  requiredChanges: [],
  productionApproval: false,
  authorityClaims: [],
});

test('pilot artifacts accept exact bounded outputs and reject authority expansion', () => {
  assert.equal(parseCodexSolution(JSON.stringify(solution())).role, 'codex-implementer');
  assert.equal(parsePiReview(JSON.stringify(review())).verdict, 'PASS_WITH_LIMITS');
  assert.equal(parseCodexSolution(JSON.stringify({ ...solution(), productionDeploymentAuthorized: true })), null);
  assert.equal(parsePiReview(JSON.stringify({ ...review(), authorityClaims: ['DONE'] })), null);
  assert.equal(parsePiReview(JSON.stringify({ ...review(), extra: true })), null);
});

test('pilot run manifest is digest-bound and remains awaiting human decision', () => {
  const manifest = buildPilotRunManifest({
    taskSnapshot: { task: { id: 'S2-001-AI-PRODUCTION-TASK-v1', status: 'IN_REVIEW', revision: 6, submission_digest: 'a'.repeat(64) }, events: [
      { previous_hash: '0'.repeat(64), event_hash: 'b'.repeat(64) },
      { previous_hash: 'b'.repeat(64), event_hash: 'c'.repeat(64) },
    ] },
    codex: { processId: 101, model: 'gpt-5.6-sol', outputSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64) },
    pi: { processId: 202, model: 'glm-5.3-flash', provider: 'zai-coding-cn', reviewVerdict: 'PASS_WITH_LIMITS', outputSha256: 'f'.repeat(64), artifactSha256: '1'.repeat(64) },
    sourceManifestSha256: '2'.repeat(64), environmentDigest: '3'.repeat(64), migrationSha256: '4'.repeat(64),
  });
  assert.equal(manifest.verdict, 'AWAITING_HUMAN_DECISION');
  assert.equal(manifest.productionDeployed, false);
  assert.equal(manifest.incrementalPaidApiBudgetAuthorizedUsd, 0);
  assert.equal(manifest.observedIncrementalProviderChargeUsd, null);
  assert(manifest.limitations.includes('subscription CLIs expose no per-call billing telemetry'));
  assert.equal(manifest.processSeparated, true);
  assert.equal(verifyPilotRunDigest(manifest), true);
  assert.equal(verifyPilotRunDigest({ ...manifest, productionDeployed: true }), false);
  assert.throws(() => buildPilotRunManifest({
    taskSnapshot: { task: { id: 'S2-001-AI-PRODUCTION-TASK-v1', status: 'DONE', revision: 7 }, events: [] },
    codex: { processId: 101 }, pi: { processId: 202 }, sourceManifestSha256: '2'.repeat(64), environmentDigest: '3'.repeat(64), migrationSha256: '4'.repeat(64),
  }), /IN_REVIEW/);
});
