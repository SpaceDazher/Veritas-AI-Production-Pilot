import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { buildEnvironmentObservation, parseVersion, verifyEnvironmentDigest } from '../src/environment-probe.mjs';

test('version parsing accepts a single bounded line and rejects ambiguous output', () => {
  assert.equal(parseVersion('codex-cli 0.153.4\r\n'), 'codex-cli 0.153.4');
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('line one\nline two'), null);
  assert.equal(parseVersion('x'.repeat(257)), null);
});

test('environment observation is content-addressed and does not execute agents', () => {
  const calls = [];
  const run = (executable, args) => {
    calls.push([executable, args]);
    const outputs = {
      codex: { status: 0, stdout: 'codex-cli 0.153.4\n', stderr: '' },
      pi: { status: null, stdout: '', stderr: 'ENOENT' },
      psql: { status: null, stdout: '', stderr: 'ENOENT' },
      docker: { status: null, stdout: '', stderr: 'ENOENT' },
    };
    return outputs[executable];
  };
  const observation = buildEnvironmentObservation({ run, nodeVersion: 'v22.23.2', platform: 'win32', architecture: 'x64' });
  assert.deepEqual(calls, [
    ['codex', ['--version']], ['pi', ['--version']], ['psql', ['--version']], ['docker', ['--version']],
  ]);
  assert.equal(observation.codex.version, 'codex-cli 0.153.4');
  assert.equal(observation.codex.available, true);
  assert.equal(observation.pi.available, false);
  assert.equal(observation.dedicatedPostgresql.available, false);
  assert.match(observation.environmentDigest, /^[a-f0-9]{64}$/);
  assert.equal('observedAt' in observation, false);
});

test('failed or multiline version probes fail closed', () => {
  const run = () => ({ status: 1, stdout: 'untrusted\nextra', stderr: 'failure' });
  const observation = buildEnvironmentObservation({ run, nodeVersion: 'v22.23.2', platform: 'win32', architecture: 'x64' });
  assert.equal(observation.codex.available, false);
  assert.equal(observation.codex.version, null);
});

test('tracked environment observation has a valid decision-input digest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../evidence/environment-manifest.json', import.meta.url), 'utf8'));
  assert.equal(verifyEnvironmentDigest(manifest), true);
  assert.equal(verifyEnvironmentDigest({ ...manifest, hostClass: 'forged-host' }), false);
});
