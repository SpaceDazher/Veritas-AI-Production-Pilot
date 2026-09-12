import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPilotClosureManifest } from '../src/pilot-closure.mjs';
import { getPersistentClosureSnapshot } from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pilotRunManifest = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'pilot-run-manifest.json'), 'utf8'));
const runtime = JSON.parse(fs.readFileSync(path.join(root, '.local', 'postgres-runtime.json'), 'utf8'));
const commit = spawnSync('git', ['rev-parse', 'b7ffefc^{commit}'], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
if (commit.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(commit.stdout ?? '')) throw new Error('pilot execution commit is unavailable');
const manifest = buildPilotClosureManifest({
  pilotRunManifest,
  closureSnapshot: getPersistentClosureSnapshot(pilotRunManifest.taskId),
  migrationSha256: runtime.migrationSha256,
  executionCommitSha: commit.stdout.trim(),
});
const outputPath = path.join(root, 'evidence', 'pilot-closure-manifest.json');
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ path: 'evidence/pilot-closure-manifest.json', verdict: manifest.verdict, targetDisposition: manifest.targetDisposition, closureDigest: manifest.closureDigest }, null, 2)}\n`);
