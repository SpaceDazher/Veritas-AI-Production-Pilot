import { canonicalHash } from './canonical.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const RESULT_KEYS = ['schemaVersion', 'adapter', 'nonce', 'status', 'authorityClaims'];

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const parseAdapterSmokeResult = (text, adapter, nonce) => {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!exactKeys(value, RESULT_KEYS)) return null;
  if (value.schemaVersion !== 1 || value.adapter !== adapter || value.nonce !== nonce || value.status !== 'OK') return null;
  if (!Array.isArray(value.authorityClaims) || value.authorityClaims.length !== 0) return null;
  return value;
};

const validateRun = (name, run, nonce, expectedModel, expectedProvider) => {
  if (run?.exitStatus !== 0) throw new Error(`${name} smoke process did not exit successfully`);
  if (!Number.isInteger(run.processId) || run.processId <= 0) throw new Error(`${name} smoke process identity missing`);
  if (run.model !== expectedModel || run.provider !== expectedProvider) throw new Error(`${name} model/provider binding mismatch`);
  if (!HEX64.test(run.stdoutSha256 ?? '') || !HEX64.test(run.stderrSha256 ?? '')) throw new Error(`${name} transcript digest missing`);
  if (typeof run.workingDirectory !== 'string' || !run.workingDirectory.startsWith('.local/adapter-smoke/')) throw new Error(`${name} working directory is not isolated`);
  const result = parseAdapterSmokeResult(run.output, name, nonce);
  if (!result) throw new Error(`${name} returned an invalid or authority-expanding result`);
  return {
    processId: run.processId,
    provider: run.provider,
    model: run.model,
    exitStatus: run.exitStatus,
    workingDirectory: run.workingDirectory,
    stdoutSha256: run.stdoutSha256,
    stderrSha256: run.stderrSha256,
    result,
    resultSha256: canonicalHash(result),
  };
};

const digestInput = (manifest) => {
  const copy = structuredClone(manifest);
  delete copy.executionBindingDigest;
  return copy;
};

const validateAttemptAccounting = (value) => {
  const keys = ['codexSchemaRejectedBeforeInference', 'piUnpairedModelCalls'];
  if (!exactKeys(value, keys) || keys.some((key) => !Number.isInteger(value[key]) || value[key] < 0)) {
    throw new Error('prior attempt accounting is invalid');
  }
  return structuredClone(value);
};

export const buildExecutionBindingManifest = ({ codex, pi, priorUnacceptedAttempts }) => {
  const codexBinding = validateRun('codex', codex, 'codex-smoke-v1', 'gpt-5.6-sol', 'openai-codex');
  const piBinding = validateRun('pi', pi, 'pi-smoke-v1', 'glm-5.3-flash', 'zai-coding-cn');
  if (codexBinding.processId === piBinding.processId) throw new Error('adapter smokes were not process-separated');
  if (codexBinding.workingDirectory === piBinding.workingDirectory) throw new Error('adapter smoke working directories were not isolated');
  const attempts = validateAttemptAccounting(priorUnacceptedAttempts);
  const manifest = {
    schemaVersion: 1,
    decisionInput: true,
    bindings: {
      codex: codexBinding,
      pi: piBinding,
    },
    processSeparated: true,
    workingDirectoriesIsolated: true,
    priorUnacceptedAttempts: attempts,
    modelCallsExecuted: 2,
    totalObservedModelInferenceCalls: 2 + attempts.piUnpairedModelCalls,
    toolsAuthorized: false,
    productionActionsAuthorized: false,
    incrementalPaidApiBudgetAuthorizedUsd: 0,
    accessClasses: ['chatgpt-subscription', 'zai-coding-plan-china'],
    rawTranscriptsCommitted: false,
    verdict: 'EXECUTION_BINDINGS_VERIFIED',
  };
  return { ...manifest, executionBindingDigest: canonicalHash(digestInput(manifest)) };
};

export const verifyExecutionBindingDigest = (manifest) => {
  try {
    return HEX64.test(manifest.executionBindingDigest ?? '')
      && canonicalHash(digestInput(manifest)) === manifest.executionBindingDigest;
  } catch {
    return false;
  }
};
