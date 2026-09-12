import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVISIONING_CONTRACT, buildChildEnvironment, computeMigrationSetSha256, runtimeRecordIsValid } from '../scripts/provision-local-postgres.mjs';
import { LIFECYCLE_ACTIONS, buildLifecycleInvocation, buildLifecycleSpawnOptions } from '../scripts/postgres-lifecycle.mjs';

test('local PostgreSQL provisioning is bounded and non-production', () => {
  assert.equal(PROVISIONING_CONTRACT.host, '127.0.0.1');
  assert.equal(PROVISIONING_CONTRACT.port, 55432);
  assert.equal(PROVISIONING_CONTRACT.serverVersion, '17.11');
  assert.equal(PROVISIONING_CONTRACT.authentication, 'scram-sha-256');
  assert.equal(PROVISIONING_CONTRACT.systemService, false);
  assert.match(PROVISIONING_CONTRACT.archiveSha256, /^[A-F0-9]{64}$/);
  assert.match(computeMigrationSetSha256(), /^[a-f0-9]{64}$/);
});

test('runtime record validation is content-bound and rejects missing proof', () => {
  const record = {
    schemaVersion: 1,
    host: '127.0.0.1',
    port: 55432,
    database: 'veritas_pilot',
    applicationRole: 'veritas_app',
    password: 'local-secret-not-committed',
    serverVersion: '17.11',
    migrationSha256: 'a'.repeat(64),
    ready: true,
  };
  assert.equal(runtimeRecordIsValid(record), true);
  assert.equal(runtimeRecordIsValid({ ...record, host: '0.0.0.0' }), false);
  assert.equal(runtimeRecordIsValid({ ...record, migrationSha256: null }), false);
  assert.equal(runtimeRecordIsValid({ ...record, ready: false }), false);
});

test('child environment keeps required Windows paths without forwarding secrets', () => {
  const environment = buildChildEnvironment({
    PATH: 'system-path',
    SYSTEMROOT: 'C:\\Windows',
    SystemDrive: 'C:',
    ProgramData: 'C:\\ProgramData',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\test',
    OPENAI_API_KEY: 'must-not-pass',
  }, 'postgres-bin', { PGPASSWORD: 'runtime-only' });
  assert.equal(environment.SystemDrive, 'C:');
  assert.equal(environment.ProgramData, 'C:\\ProgramData');
  assert.equal(environment.PGPASSWORD, 'runtime-only');
  assert.equal('OPENAI_API_KEY' in environment, false);
});

test('PostgreSQL lifecycle exposes bounded start status and stop operations', () => {
  assert.deepEqual(LIFECYCLE_ACTIONS, ['start', 'status', 'stop']);
  const paths = {
    pgCtl: 'D:\\pilot\\bin\\pg_ctl.exe',
    dataRoot: 'D:\\pilot\\pgdata',
    logPath: 'D:\\pilot\\postgres.log',
  };
  assert.deepEqual(buildLifecycleInvocation('start', paths), {
    program: paths.pgCtl,
    args: [
      `--pgdata=${paths.dataRoot}`,
      `--log=${paths.logPath}`,
      '--options', '-p 55432 -h 127.0.0.1',
      '--wait', 'start',
    ],
  });
  assert.deepEqual(buildLifecycleInvocation('status', paths), {
    program: paths.pgCtl,
    args: [`--pgdata=${paths.dataRoot}`, 'status'],
  });
  assert.deepEqual(buildLifecycleInvocation('stop', paths), {
    program: paths.pgCtl,
    args: [`--pgdata=${paths.dataRoot}`, '--wait', 'stop'],
  });
  assert.throws(() => buildLifecycleInvocation('restart', paths), /Unsupported PostgreSQL lifecycle action/);
});

test('lifecycle closes stdio handles so a detached Windows server cannot hold the CLI open', () => {
  const options = buildLifecycleSpawnOptions({ PATH: 'safe-path', OPENAI_API_KEY: 'must-not-pass' }, 'postgres-bin');
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(options.env.PATH, 'postgres-bin;safe-path');
  assert.equal('OPENAI_API_KEY' in options.env, false);
});
