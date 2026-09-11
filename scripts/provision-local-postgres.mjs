import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROVISIONING_CONTRACT = Object.freeze({
  host: '127.0.0.1',
  port: 55432,
  serverVersion: '17.11',
  authentication: 'scram-sha-256',
  systemService: false,
  archiveSha256: '6EABDF00D2893713B75DB4336A23C3FDF505F056E217EC6E2E95D901750CFEA3',
});

export const runtimeRecordIsValid = (record) => Boolean(
  record
  && record.schemaVersion === 1
  && record.host === PROVISIONING_CONTRACT.host
  && record.port === PROVISIONING_CONTRACT.port
  && record.database === 'veritas_pilot'
  && record.applicationRole === 'veritas_app'
  && typeof record.password === 'string'
  && record.password.length >= 24
  && record.serverVersion === PROVISIONING_CONTRACT.serverVersion
  && /^[a-f0-9]{64}$/.test(record.migrationSha256 ?? '')
  && record.ready === true
);

export const buildChildEnvironment = (source = process.env, prependedPath = '', extra = {}) => {
  const environment = {};
  for (const key of ['SYSTEMROOT', 'SystemDrive', 'ProgramData', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (typeof source[key] === 'string' && source[key].length > 0) environment[key] = source[key];
  }
  environment.PATH = prependedPath
    ? `${prependedPath};${source.PATH ?? ''}`
    : source.PATH ?? '';
  return { ...environment, ...extra };
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = path.join(projectRoot, '.local');
const distributionRoot = path.join(localRoot, 'postgresql17', 'pgsql');
const binaryRoot = path.join(distributionRoot, 'bin');
const dataRoot = path.join(localRoot, 'pgdata');
const runtimePath = path.join(localRoot, 'postgres-runtime.json');
const logPath = path.join(localRoot, 'postgres.log');
const migrationPath = path.join(projectRoot, 'migrations', '001_control_plane.sql');

const executable = (name) => path.join(binaryRoot, `${name}.exe`);
const randomPassword = () => randomBytes(32).toString('base64url');

const run = (program, args, extraEnvironment = {}) => {
  const result = spawnSync(program, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: buildChildEnvironment(process.env, binaryRoot, extraEnvironment),
  });
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-2000);
    throw new Error(`${path.basename(program)} failed with status ${result.status}: ${diagnostic}`);
  }
  return result.stdout.trim();
};

export const provisionLocalPostgres = () => {
  if (process.platform !== 'win32') throw new Error('This bounded provisioner supports Windows only');
  for (const name of ['initdb', 'pg_ctl', 'psql', 'createdb', 'postgres']) {
    if (!fs.existsSync(executable(name))) throw new Error(`Missing PostgreSQL binary: ${name}`);
  }
  if (fs.existsSync(dataRoot) || fs.existsSync(runtimePath)) {
    throw new Error('Local PostgreSQL state already exists; refusing to overwrite it');
  }

  fs.mkdirSync(localRoot, { recursive: true });
  const adminPassword = randomPassword();
  const applicationPassword = randomPassword();
  const passwordFile = path.join(localRoot, 'initdb-password.tmp');
  const roleFile = path.join(localRoot, 'create-role.tmp.sql');
  let serverStarted = false;
  try {
    fs.writeFileSync(passwordFile, adminPassword, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    run(executable('initdb'), [
      `--pgdata=${dataRoot}`,
      '--username=veritas_admin',
      '--encoding=UTF8',
      '--auth-host=scram-sha-256',
      '--auth-local=scram-sha-256',
      `--pwfile=${passwordFile}`,
    ]);
    fs.appendFileSync(path.join(dataRoot, 'postgresql.conf'), [
      '',
      "listen_addresses = '127.0.0.1'",
      `port = ${PROVISIONING_CONTRACT.port}`,
      'max_connections = 20',
      "password_encryption = 'scram-sha-256'",
      '',
    ].join('\n'), 'utf8');
    run(executable('pg_ctl'), [
      `--pgdata=${dataRoot}`,
      `--log=${logPath}`,
      '--options', `-p ${PROVISIONING_CONTRACT.port} -h ${PROVISIONING_CONTRACT.host}`,
      '--wait', 'start',
    ]);
    serverStarted = true;

    fs.writeFileSync(roleFile, [
      'CREATE ROLE veritas_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      `PASSWORD '${applicationPassword}';`,
      '',
    ].join(' '), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    run(executable('psql'), [
      '--host', PROVISIONING_CONTRACT.host, '--port', String(PROVISIONING_CONTRACT.port),
      '--username', 'veritas_admin', '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1',
      '--file', roleFile,
    ], { PGPASSWORD: adminPassword });
    run(executable('createdb'), [
      '--host', PROVISIONING_CONTRACT.host, '--port', String(PROVISIONING_CONTRACT.port),
      '--username', 'veritas_admin', '--owner', 'veritas_app', 'veritas_pilot',
    ], { PGPASSWORD: adminPassword });
    run(executable('psql'), [
      '--host', PROVISIONING_CONTRACT.host, '--port', String(PROVISIONING_CONTRACT.port),
      '--username', 'veritas_app', '--dbname', 'veritas_pilot', '--set', 'ON_ERROR_STOP=1',
      '--file', migrationPath,
    ], { PGPASSWORD: applicationPassword });

    const proof = run(executable('psql'), [
      '--host', PROVISIONING_CONTRACT.host, '--port', String(PROVISIONING_CONTRACT.port),
      '--username', 'veritas_app', '--dbname', 'veritas_pilot', '--tuples-only', '--no-align',
      '--command', "SELECT current_setting('server_version') || '|' || current_database() || '|' || current_user || '|' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public');",
    ], { PGPASSWORD: applicationPassword });
    const [serverVersion, database, applicationRole, tableCountText] = proof.split('|');
    const migrationSha256 = createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
    const record = {
      schemaVersion: 1,
      host: PROVISIONING_CONTRACT.host,
      port: PROVISIONING_CONTRACT.port,
      database,
      applicationRole,
      password: applicationPassword,
      serverVersion,
      migrationSha256,
      publicTableCount: Number(tableCountText),
      ready: serverVersion === PROVISIONING_CONTRACT.serverVersion
        && database === 'veritas_pilot'
        && applicationRole === 'veritas_app'
        && Number(tableCountText) >= 8,
    };
    if (!runtimeRecordIsValid(record)) throw new Error('Live PostgreSQL proof did not satisfy the provisioning contract');
    fs.writeFileSync(runtimePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { ...record, password: '[REDACTED]', runtimePath: path.relative(projectRoot, runtimePath).replaceAll('\\', '/') };
  } catch (error) {
    if (serverStarted) {
      spawnSync(executable('pg_ctl'), [`--pgdata=${dataRoot}`, '--wait', 'stop'], { windowsHide: true, encoding: 'utf8' });
    }
    throw error;
  } finally {
    for (const temporaryPath of [passwordFile, roleFile]) {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(provisionLocalPostgres(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: 'POSTGRES_PROVISION_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
