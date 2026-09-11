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

const probeDatabase = (databaseProbe) => {
  if (typeof databaseProbe !== 'function') return { available: false, verified: false };
  let result;
  try {
    result = databaseProbe();
  } catch {
    return { available: false, verified: false };
  }
  const lines = typeof result?.stdout === 'string' ? result.stdout.trim().split(/\r?\n/) : [];
  const fields = lines.length === 1 ? lines[0].split('|') : [];
  const [serverVersion, database, applicationRole, tableCountText] = fields;
  const tableCount = Number(tableCountText);
  const valid = result?.status === 0
    && fields.length === 4
    && serverVersion === '17.11'
    && database === 'veritas_pilot'
    && applicationRole === 'veritas_app'
    && Number.isInteger(tableCount)
    && tableCount >= 8
    && /^[a-f0-9]{64}$/.test(result.migrationSha256 ?? '');
  return valid ? {
    available: true,
    verified: true,
    serverVersion,
    database,
    applicationRole,
    publicTableCount: tableCount,
    migrationSha256: result.migrationSha256,
  } : { available: false, verified: false };
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

export const buildEnvironmentObservation = ({ run, databaseProbe, nodeVersion, platform, architecture }) => {
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
    dedicatedPostgresql: probeDatabase(databaseProbe),
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
