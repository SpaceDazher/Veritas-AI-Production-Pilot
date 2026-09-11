import { canonicalHash } from './canonical.mjs';

export const parseVersion = (stdout) => {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || lines[0].length === 0 || lines[0].length > 256) return null;
  return lines[0];
};

const probe = (run, executable) => {
  let result;
  try {
    result = run(executable, ['--version']);
  } catch {
    return { available: false, version: null, versionVerified: false };
  }
  const version = result?.status === 0 ? parseVersion(result.stdout) : null;
  return { available: version !== null, version, versionVerified: version !== null };
};

const digestInput = (observation) => ({
  schemaVersion: observation.schemaVersion,
  decisionInput: observation.decisionInput,
  hostClass: observation.hostClass,
  node: observation.node,
  codex: observation.codex,
  pi: observation.pi,
  psql: observation.psql,
  docker: observation.docker,
  dedicatedPostgresql: observation.dedicatedPostgresql,
  paidApiBudgetUsd: observation.paidApiBudgetUsd,
});

export const verifyEnvironmentDigest = (observation) => {
  try {
    return /^[a-f0-9]{64}$/.test(observation.environmentDigest ?? '')
      && canonicalHash(digestInput(observation)) === observation.environmentDigest;
  } catch {
    return false;
  }
};

export const buildEnvironmentObservation = ({ run, nodeVersion, platform, architecture }) => {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  const decisionInput = {
    schemaVersion: 1,
    decisionInput: true,
    hostClass: `${platform}-${architecture}-local-development`,
    node: { available: true, version: String(nodeVersion).replace(/^v/, '') },
    codex: probe(run, 'codex'),
    pi: probe(run, 'pi'),
    psql: probe(run, 'psql'),
    docker: probe(run, 'docker'),
    dedicatedPostgresql: { available: false, verified: false },
    paidApiBudgetUsd: 0,
  };
  const missing = [
    !decisionInput.pi.available && 'pi-cli',
    !decisionInput.dedicatedPostgresql.available && 'dedicated-postgresql',
  ].filter(Boolean);
  return {
    ...decisionInput,
    environmentDigest: canonicalHash(digestInput(decisionInput)),
    missingPrerequisites: missing,
    verdict: missing.length === 0 ? 'READY_FOR_AUTHORIZATION' : 'BLOCKED_ENVIRONMENT',
  };
};
