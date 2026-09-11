import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { buildEnvironmentObservation } from '../src/environment-probe.mjs';

const run = (executable, args) => {
  const useNpmPi = process.platform === 'win32' && executable === 'pi' && process.env.APPDATA;
  const resolved = useNpmPi ? process.execPath : executable;
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

const observation = buildEnvironmentObservation({
  run,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
