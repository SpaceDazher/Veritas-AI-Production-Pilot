import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFailedPilotAttemptEvidence } from '../src/pilot-run-artifacts.mjs';
import { getPersistentTaskSnapshot } from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexPath = path.join(root, 'results', 'pilot-run', 'codex-solution.json');
const evidencePath = path.join(root, 'evidence', 'pilot-run-attempt-v1.json');
if (!fs.existsSync(codexPath)) throw new Error('v1 Codex artifact is missing');
const codexArtifactSha256 = createHash('sha256').update(fs.readFileSync(codexPath)).digest('hex');
const evidence = buildFailedPilotAttemptEvidence({
  taskSnapshot: getPersistentTaskSnapshot('S2-001-AI-PRODUCTION-TASK-v1'),
  codexArtifactSha256,
});
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ path: 'evidence/pilot-run-attempt-v1.json', status: evidence.status, digest: evidence.failureEvidenceDigest }, null, 2)}\n`);
