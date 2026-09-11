import { canonicalHash } from './canonical.mjs';

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const parsePiAuthCheck = (stdout) => {
  if (typeof stdout !== 'string' || stdout.length > 1024) return null;
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!exactKeys(value, ['status', 'provider', 'authType'])) return null;
  if (value.status !== 'ready' || value.provider !== 'zai-coding-cn' || value.authType !== 'api_key') return null;
  return { status: value.status, provider: value.provider, authType: value.authType };
};

export const parseCodexLoginStatus = (stdout) => (
  stdout === 'Logged in using ChatGPT\n' || stdout === 'Logged in using ChatGPT\r\n'
    ? { status: 'ready', authMode: 'chatgpt-subscription' }
    : null
);

const digestInput = (observation) => ({
  schemaVersion: observation.schemaVersion,
  decisionInput: observation.decisionInput,
  codex: observation.codex,
  pi: observation.pi,
  modelCallsExecuted: observation.modelCallsExecuted,
  credentialsEmitted: observation.credentialsEmitted,
  verdict: observation.verdict,
});

export const buildAgentAuthObservation = ({ codexOutput, piOutput }) => {
  const codex = parseCodexLoginStatus(codexOutput) ?? { status: 'unverified', authMode: null };
  const pi = parsePiAuthCheck(piOutput) ?? { status: 'unverified', provider: null, authType: null };
  const observation = {
    schemaVersion: 1,
    decisionInput: true,
    codex,
    pi,
    modelCallsExecuted: 0,
    credentialsEmitted: false,
    verdict: codex.status === 'ready' && pi.status === 'ready'
      ? 'AUTH_READY_EXECUTION_UNVERIFIED'
      : 'BLOCKED_AUTH',
  };
  return { ...observation, authDigest: canonicalHash(digestInput(observation)) };
};

export const verifyAgentAuthDigest = (observation) => {
  try {
    return /^[a-f0-9]{64}$/.test(observation.authDigest ?? '')
      && canonicalHash(digestInput(observation)) === observation.authDigest;
  } catch {
    return false;
  }
};
