import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEnvironmentObservation } from '../src/environment-probe.mjs';
import { buildChildEnvironment, runtimeRecordIsValid } from './provision-local-postgres.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localPsql = path.join(projectRoot, '.local', 'postgresql17', 'pgsql', 'bin', 'psql.exe');
const runtimePath = path.join(projectRoot, '.local', 'postgres-runtime.json');
const migrationPath = path.join(projectRoot, 'migrations', '001_control_plane.sql');

const run = (executable, args) => {
  const useNpmPi = process.platform === 'win32' && executable === 'pi' && process.env.APPDATA;
  const useLocalPsql = executable === 'psql' && fs.existsSync(localPsql);
  const resolved = useNpmPi ? process.execPath : useLocalPsql ? localPsql : executable;
  const resolvedArgs = useNpmPi
    ? [path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'), ...args]
    : args;
  return spawnSync(resolved, resolvedArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
  });
};

const databaseProbe = () => {
  if (!fs.existsSync(runtimePath) || !fs.existsSync(localPsql)) return { status: 1, stdout: '', migrationSha256: null };
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const migrationSha256 = createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  if (!runtimeRecordIsValid(runtime) || runtime.migrationSha256 !== migrationSha256) {
    return { status: 1, stdout: '', migrationSha256: null };
  }
  const result = spawnSync(localPsql, [
    '--host', runtime.host, '--port', String(runtime.port), '--username', runtime.applicationRole,
    '--dbname', runtime.database, '--tuples-only', '--no-align',
    '--command', "SELECT current_setting('server_version') || '|' || current_database() || '|' || current_user || '|' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public');",
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: buildChildEnvironment(process.env, '', { PGPASSWORD: runtime.password }),
  });
  return { status: result.status, stdout: result.stdout, migrationSha256 };
};

const observation = buildEnvironmentObservation({
  run,
  databaseProbe,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
