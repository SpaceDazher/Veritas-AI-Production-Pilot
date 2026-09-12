import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExecutionBindingManifest } from '../src/agent-execution-binding.mjs';
import { buildChildEnvironment } from './provision-local-postgres.mjs';

if (!process.argv.includes('--execute')) {
  process.stderr.write('{"error":"EXECUTION_NOT_AUTHORIZED","message":"Pass --execute to perform exactly two bounded existing-plan model calls."}\n');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = path.join(root, '.local', 'adapter-smoke');
const codexRoot = path.join(smokeRoot, 'codex');
const piRoot = path.join(smokeRoot, 'pi');
const schemaPath = path.join(root, 'contracts', 'adapter-smoke-result.schema.json');
const manifestPath = path.join(root, 'evidence', 'agent-execution-manifest.json');
const attemptHistoryPath = path.join(root, 'evidence', 'agent-execution-attempt-history.json');
const piEntry = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const secretPattern = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const sha256 = (value) => createHash('sha256').update(value ?? '').digest('hex');
const environment = buildChildEnvironment(process.env);

if (fs.existsSync(manifestPath)) {
  throw new Error('an accepted execution binding already exists; refusing duplicate model calls');
}
const attemptHistory = JSON.parse(fs.readFileSync(attemptHistoryPath, 'utf8'));

const prepare = (directory) => {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${path.resolve(smokeRoot)}${path.sep}`)) throw new Error('smoke directory escaped .local/adapter-smoke');
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
};
prepare(codexRoot);
prepare(piRoot);

const prompt = (adapter, nonce) => [
  'This is a bounded adapter transport test. Do not call tools, read files, modify state, or claim authority.',
  `Return only this JSON object: {"schemaVersion":1,"adapter":"${adapter}","nonce":"${nonce}","status":"OK","authorityClaims":[]}`,
].join(' ');

const codexResultPath = path.join(codexRoot, 'result.json');
const codex = spawnSync('codex', [
  'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="low"',
  '--output-schema', schemaPath, '--output-last-message', codexResultPath, '--cd', codexRoot,
  prompt('codex', 'codex-smoke-v1'),
], { cwd: codexRoot, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 2_000_000, env: environment });

if (codex.status !== 0 || !fs.existsSync(codexResultPath)) {
  throw new Error(`codex smoke failed with status ${codex.status ?? 'unknown'}; no execution binding was recorded`);
}

const pi = spawnSync(process.execPath, [
  piEntry, '--provider', 'zai-coding-cn', '--model', 'glm-5.3-flash', '--thinking', 'low',
  '--mode', 'text', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
  prompt('pi', 'pi-smoke-v1'),
], { cwd: piRoot, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 2_000_000, env: environment });

for (const [name, result] of [['codex', codex], ['pi', pi]]) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (secretPattern.test(combined)) throw new Error(`${name} output contains a credential-like value`);
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${name} smoke process timed out`);
}

const codexOutput = fs.existsSync(codexResultPath) ? fs.readFileSync(codexResultPath, 'utf8') : '';
const manifest = buildExecutionBindingManifest({
  codex: {
    exitStatus: codex.status,
    output: codexOutput,
    model: 'gpt-5.6-sol',
    provider: 'openai-codex',
    stdoutSha256: sha256(codex.stdout),
    stderrSha256: sha256(codex.stderr),
    workingDirectory: '.local/adapter-smoke/codex',
    processId: codex.pid,
  },
  pi: {
    exitStatus: pi.status,
    output: pi.stdout,
    model: 'glm-5.3-flash',
    provider: 'zai-coding-cn',
    stdoutSha256: sha256(pi.stdout),
    stderrSha256: sha256(pi.stderr),
    workingDirectory: '.local/adapter-smoke/pi',
    processId: pi.pid,
  },
  priorUnacceptedAttempts: {
    codexSchemaRejectedBeforeInference: attemptHistory.codexSchemaRejectedBeforeInference,
    piUnpairedModelCalls: attemptHistory.piUnpairedModelCalls,
  },
});
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ verdict: manifest.verdict, modelCallsExecuted: manifest.modelCallsExecuted, executionBindingDigest: manifest.executionBindingDigest }, null, 2)}\n`);
