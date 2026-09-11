import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROVISIONING_CONTRACT, buildChildEnvironment } from './provision-local-postgres.mjs';

export const LIFECYCLE_ACTIONS = Object.freeze(['start', 'status', 'stop']);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binaryRoot = path.join(projectRoot, '.local', 'postgresql17', 'pgsql', 'bin');
const defaultPaths = Object.freeze({
  pgCtl: path.join(binaryRoot, 'pg_ctl.exe'),
  dataRoot: path.join(projectRoot, '.local', 'pgdata'),
  logPath: path.join(projectRoot, '.local', 'postgres.log'),
});

export const buildLifecycleInvocation = (action, paths = defaultPaths) => {
  if (!LIFECYCLE_ACTIONS.includes(action)) {
    throw new Error(`Unsupported PostgreSQL lifecycle action: ${action}`);
  }
  if (action === 'start') {
    return {
      program: paths.pgCtl,
      args: [
        `--pgdata=${paths.dataRoot}`,
        `--log=${paths.logPath}`,
        '--options', `-p ${PROVISIONING_CONTRACT.port} -h ${PROVISIONING_CONTRACT.host}`,
        '--wait', 'start',
      ],
    };
  }
  if (action === 'stop') {
    return { program: paths.pgCtl, args: [`--pgdata=${paths.dataRoot}`, '--wait', 'stop'] };
  }
  return { program: paths.pgCtl, args: [`--pgdata=${paths.dataRoot}`, 'status'] };
};

export const buildLifecycleSpawnOptions = (source = process.env, prependedPath = binaryRoot) => ({
  cwd: projectRoot,
  windowsHide: true,
  timeout: 120_000,
  stdio: ['ignore', 'ignore', 'ignore'],
  env: buildChildEnvironment(source, prependedPath),
});

const execute = (invocation, spawn = spawnSync) => spawn(
  invocation.program,
  invocation.args,
  buildLifecycleSpawnOptions(),
);

export const manageLocalPostgres = (action, { spawn = spawnSync, paths = defaultPaths } = {}) => {
  if (!LIFECYCLE_ACTIONS.includes(action)) buildLifecycleInvocation(action, paths);
  if (!fs.existsSync(paths.pgCtl)) throw new Error('Local pg_ctl is missing; run provision:postgres first');
  if (!fs.existsSync(paths.dataRoot)) throw new Error('Local PostgreSQL data directory is missing; run provision:postgres first');

  const statusInvocation = buildLifecycleInvocation('status', paths);
  const before = execute(statusInvocation, spawn);
  const wasRunning = before.status === 0;
  if (action === 'status') return { action, state: wasRunning ? 'running' : 'stopped', changed: false };
  if (action === 'start' && wasRunning) return { action, state: 'running', changed: false };
  if (action === 'stop' && !wasRunning) return { action, state: 'stopped', changed: false };

  const result = execute(buildLifecycleInvocation(action, paths), spawn);
  if (result.status !== 0) {
    throw new Error(`pg_ctl ${action} failed with status ${result.status}; inspect .local/postgres.log`);
  }
  const after = execute(statusInvocation, spawn);
  const isRunning = after.status === 0;
  const expectedRunning = action === 'start';
  if (isRunning !== expectedRunning) throw new Error(`PostgreSQL did not reach expected ${expectedRunning ? 'running' : 'stopped'} state`);
  return { action, state: isRunning ? 'running' : 'stopped', changed: true };
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const action = process.argv[2] ?? 'status';
    process.stdout.write(`${JSON.stringify(manageLocalPostgres(action), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: 'POSTGRES_LIFECYCLE_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
