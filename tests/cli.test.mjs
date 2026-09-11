import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('discovery is machine-readable and honestly reports blockers', () => {
  const result = spawnSync(process.execPath, ['bin/veritas-pilot.mjs', 'discover'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.contractVersion, '1.0.0-draft');
  assert.equal(output.executionEnabled, false);
  assert.equal(output.maxConcurrentJobs, 1);
  assert.deepEqual(output.missingPrerequisites, ['dedicated-postgresql']);
});

test('state-changing CLI commands fail closed while prerequisites are missing', () => {
  const result = spawnSync(process.execPath, ['bin/veritas-pilot.mjs', 'claim'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BLOCKED_ENVIRONMENT/);
});
