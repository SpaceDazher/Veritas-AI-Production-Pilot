import { spawnSync } from 'node:child_process';

import { buildEnvironmentObservation } from '../src/environment-probe.mjs';

const run = (executable, args) => spawnSync(executable, args, {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10_000,
  env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
});

const observation = buildEnvironmentObservation({
  run,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
