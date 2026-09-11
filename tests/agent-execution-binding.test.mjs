import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildExecutionBindingManifest,
  parseAdapterSmokeResult,
  verifyExecutionBindingDigest,
} from '../src/agent-execution-binding.mjs';

const output = (adapter, nonce) => JSON.stringify({
  schemaVersion: 1,
  adapter,
  nonce,
  status: 'OK',
  authorityClaims: [],
});

test('adapter smoke result accepts only exact nonce-bound authority-free JSON', () => {
  assert.deepEqual(parseAdapterSmokeResult(output('codex', 'codex-smoke-v1'), 'codex', 'codex-smoke-v1'), {
    schemaVersion: 1, adapter: 'codex', nonce: 'codex-smoke-v1', status: 'OK', authorityClaims: [],
  });
  assert.equal(parseAdapterSmokeResult(output('codex', 'wrong'), 'codex', 'codex-smoke-v1'), null);
  assert.equal(parseAdapterSmokeResult(JSON.stringify({ ...JSON.parse(output('pi', 'pi-smoke-v1')), authorityClaims: ['DONE'] }), 'pi', 'pi-smoke-v1'), null);
  assert.equal(parseAdapterSmokeResult(JSON.stringify({ ...JSON.parse(output('pi', 'pi-smoke-v1')), extra: true }), 'pi', 'pi-smoke-v1'), null);
});

test('execution binding manifest requires both process-separated successful runs', () => {
  const manifest = buildExecutionBindingManifest({
    codex: {
      exitStatus: 0, output: output('codex', 'codex-smoke-v1'), model: 'gpt-5.6-sol', provider: 'openai-codex',
      stdoutSha256: 'a'.repeat(64), stderrSha256: 'b'.repeat(64), workingDirectory: '.local/adapter-smoke/codex', processId: 101,
    },
    pi: {
      exitStatus: 0, output: output('pi', 'pi-smoke-v1'), model: 'glm-5.3-flash', provider: 'zai-coding-cn',
      stdoutSha256: 'c'.repeat(64), stderrSha256: 'd'.repeat(64), workingDirectory: '.local/adapter-smoke/pi', processId: 202,
    },
    priorUnacceptedAttempts: { codexSchemaRejectedBeforeInference: 4, piUnpairedModelCalls: 1 },
  });
  assert.equal(manifest.verdict, 'EXECUTION_BINDINGS_VERIFIED');
  assert.equal(manifest.modelCallsExecuted, 2);
  assert.equal(manifest.totalObservedModelInferenceCalls, 3);
  assert.deepEqual(manifest.priorUnacceptedAttempts, { codexSchemaRejectedBeforeInference: 4, piUnpairedModelCalls: 1 });
  assert.notEqual(manifest.bindings.codex.processId, manifest.bindings.pi.processId);
  assert.equal(manifest.toolsAuthorized, false);
  assert.equal(manifest.productionActionsAuthorized, false);
  assert.equal(verifyExecutionBindingDigest(manifest), true);
  assert.equal(verifyExecutionBindingDigest({ ...manifest, modelCallsExecuted: 1 }), false);
});

test('execution binding manifest rejects reused process identity and malformed attempt accounting', () => {
  const run = (adapter, nonce, processId) => ({
    exitStatus: 0, output: output(adapter, nonce),
    model: adapter === 'codex' ? 'gpt-5.6-sol' : 'glm-5.3-flash',
    provider: adapter === 'codex' ? 'openai-codex' : 'zai-coding-cn',
    stdoutSha256: 'a'.repeat(64), stderrSha256: 'b'.repeat(64),
    workingDirectory: `.local/adapter-smoke/${adapter}`, processId,
  });
  assert.throws(() => buildExecutionBindingManifest({
    codex: run('codex', 'codex-smoke-v1', 101),
    pi: run('pi', 'pi-smoke-v1', 101),
    priorUnacceptedAttempts: { codexSchemaRejectedBeforeInference: 4, piUnpairedModelCalls: 1 },
  }), /process-separated/);
  assert.throws(() => buildExecutionBindingManifest({
    codex: run('codex', 'codex-smoke-v1', 101),
    pi: run('pi', 'pi-smoke-v1', 202),
    priorUnacceptedAttempts: { codexSchemaRejectedBeforeInference: -1, piUnpairedModelCalls: 1 },
  }), /attempt accounting/);
});

test('Codex output schema gives every constrained property an explicit JSON type', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/adapter-smoke-result.schema.json', import.meta.url), 'utf8'));
  for (const name of schema.required) assert.equal(typeof schema.properties[name].type, 'string', `${name} has no type`);
  assert.equal(schema.properties.authorityClaims.items.type, 'string');
});

test('frozen adapter manifests distinguish verified transport from pending task lifecycle', () => {
  const load = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
  const binding = load('evidence/agent-execution-manifest.json');
  const brief = load('pilot/task-brief.json');
  for (const name of ['codex', 'pi']) {
    const adapter = load(`pilot/adapters/${name}.json`);
    assert.equal(adapter.availability, 'TRANSPORT_VERIFIED_TASK_LIFECYCLE_PENDING');
    assert.equal(adapter.executionBinding.manifest, 'evidence/agent-execution-manifest.json');
    assert.equal(adapter.executionBinding.digest, binding.executionBindingDigest);
    assert.match(adapter.blocker, /task lifecycle/i);
  }
  assert.equal(brief.executionAuthorized, true);
  assert.equal(brief.status, 'READY_FOR_EXECUTION');
  assert.deepEqual(brief.blockers, []);
});

test('adapter manifest schema represents frozen auth and execution bindings', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/adapter-manifest.schema.json', import.meta.url), 'utf8'));
  assert(schema.properties.availability.enum.includes('TRANSPORT_VERIFIED_TASK_LIFECYCLE_PENDING'));
  assert(schema.properties.availability.enum.includes('VERIFIED'));
  assert.equal(schema.properties.authBinding.type, 'object');
  assert.equal(schema.properties.executionBinding.properties.digest.pattern, '^[a-f0-9]{64}$');
});
