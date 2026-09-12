import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildAgentAuthObservation,
  parseCodexLoginStatus,
  parsePiAuthCheck,
  verifyAgentAuthDigest,
} from '../src/agent-auth-probe.mjs';

test('auth parsers accept only bounded credential-free readiness output', () => {
  assert.deepEqual(parsePiAuthCheck('{"status":"ready","provider":"zai-coding-cn","authType":"api_key"}\n'), {
    status: 'ready', provider: 'zai-coding-cn', authType: 'api_key',
  });
  assert.equal(parsePiAuthCheck('{"status":"ready","provider":"zai-coding-cn","authType":"api_key","credential":"secret"}'), null);
  assert.equal(parsePiAuthCheck('{"status":"ready","provider":"other","authType":"api_key"}'), null);
  assert.deepEqual(parseCodexLoginStatus('Logged in using ChatGPT\n'), { status: 'ready', authMode: 'chatgpt-subscription' });
  assert.equal(parseCodexLoginStatus('token=secret'), null);
});

test('auth observation is content-addressed and records that no model call or credential output occurred', () => {
  const observation = buildAgentAuthObservation({
    codexOutput: 'Logged in using ChatGPT\n',
    piOutput: '{"status":"ready","provider":"zai-coding-cn","authType":"api_key"}\n',
  });
  assert.equal(observation.verdict, 'AUTH_READY_EXECUTION_UNVERIFIED');
  assert.equal(observation.modelCallsExecuted, 0);
  assert.equal(observation.credentialsEmitted, false);
  assert.equal(verifyAgentAuthDigest(observation), true);
  assert.equal(verifyAgentAuthDigest({ ...observation, credentialsEmitted: true }), false);
});

test('tracked auth observation matches its decision-input digest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../evidence/agent-auth-manifest.json', import.meta.url), 'utf8'));
  assert.equal(verifyAgentAuthDigest(manifest), true);
  assert.equal(manifest.verdict, 'AUTH_READY_EXECUTION_UNVERIFIED');
});
