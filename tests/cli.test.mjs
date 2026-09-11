import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('discovery is machine-readable and reports the persistent CLI ready for the bounded pilot', () => {
  const result = spawnSync(process.execPath, ['bin/veritas-pilot.mjs', 'discover'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.contractVersion, '1.0.0-draft');
  assert.equal(output.executionEnabled, true);
  assert.equal(output.maxConcurrentJobs, 1);
  assert.deepEqual(output.missingPrerequisites, []);
  assert.equal(output.status, 'READY');
});

test('state-changing CLI commands require a repository-local JSON input file', () => {
  const result = spawnSync(process.execPath, ['bin/veritas-pilot.mjs', 'claim'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /INVALID_REQUEST/);
  assert.doesNotMatch(result.stderr, /NOT_IMPLEMENTED/);
});
