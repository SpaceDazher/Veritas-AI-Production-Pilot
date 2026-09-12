import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChildEnvironment, computeMigrationSetSha256, runtimeRecordIsValid } from './provision-local-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, '.local', 'postgres-runtime.json');
const migrationPaths = ['002_command_path.sql', '003_human_decision_path.sql'].map((name) => path.join(root, 'migrations', name));
const psqlPath = path.join(root, '.local', 'postgresql17', 'pgsql', 'bin', 'psql.exe');

if (!fs.existsSync(runtimePath) || !fs.existsSync(psqlPath)) throw new Error('local PostgreSQL runtime is unavailable');
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
if (!runtimeRecordIsValid(runtime)) throw new Error('local PostgreSQL runtime record is invalid');

for (const migrationPath of migrationPaths) {
  const result = spawnSync(psqlPath, [
    '--host', runtime.host, '--port', String(runtime.port), '--username', runtime.applicationRole,
    '--dbname', runtime.database, '--set', 'ON_ERROR_STOP=1', '--file', migrationPath,
  ], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000, shell: false,
    env: buildChildEnvironment(process.env, '', { PGPASSWORD: runtime.password }),
  });
  if (result.status !== 0) throw new Error(`migration failed (${path.basename(migrationPath)}): ${`${result.stderr ?? ''}`.trim().slice(-2000)}`);
}

const updated = { ...runtime, migrationSha256: computeMigrationSetSha256() };
fs.writeFileSync(runtimePath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ verdict: 'PASS', migrationSha256: updated.migrationSha256 }, null, 2)}\n`);
