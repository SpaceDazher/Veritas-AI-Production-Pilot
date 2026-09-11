import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { buildAgentAuthObservation } from '../src/agent-auth-probe.mjs';
import { buildChildEnvironment } from './provision-local-postgres.mjs';

const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const piEntry = path.join(appData, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const environment = buildChildEnvironment(process.env);

const codex = spawnSync('codex', ['login', 'status'], {
  encoding: 'utf8', windowsHide: true, timeout: 10_000, env: environment,
});
const pi = spawnSync(process.execPath, [
  piEntry, 'auth', 'check', '--provider', 'zai-coding-cn', '--json', '--no-refresh',
], {
  encoding: 'utf8', windowsHide: true, timeout: 10_000, env: environment,
});

const observation = buildAgentAuthObservation({
  codexOutput: codex.status === 0 ? (codex.stdout || codex.stderr) : '',
  piOutput: pi.status === 0 ? pi.stdout : '',
});
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
if (observation.verdict === 'BLOCKED_AUTH') process.exitCode = 1;
