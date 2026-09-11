import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

const brief = read('pilot/task-brief.json');
const contract = read('contracts/adapter-contract.json');
const cases = read('pilot/acceptance-cases.json');
const environment = read('evidence/environment-manifest.json');
const adapters = ['codex', 'pi', 'generic-cli'].map((name) => read(`pilot/adapters/${name}.json`));

assert.equal(brief.status, 'BLOCKED_PREREQUISITES');
assert.equal(brief.executionAuthorized, false);
assert.equal(brief.constraints.maxConcurrentJobs, 1);
assert.equal(brief.constraints.paidApiBudgetUsd, 0);
assert.equal(brief.constraints.agentFinalApprovalAuthorized, false);
assert.deepEqual(brief.workflow, ['BACKLOG', 'READY', 'CLAIMED', 'RUNNING', 'IN_REVIEW']);
assert.equal(contract.limits.maxConcurrentJobs, 1);
assert.equal(contract.limits.paidApiBudgetUsd, 0);
assert.equal(contract.limits.finalApprovalByAgent, false);
assert.deepEqual(contract.humanOnlyStates, ['DONE']);
assert(!contract.agentWritableStates.includes('DONE'));
assert.equal(new Set(contract.operations).size, contract.operations.length);
assert.equal(cases.status, 'NOT_RUN');
assert.equal(cases.cases.length, 12);
assert.equal(new Set(cases.cases.map((item) => item.id)).size, cases.cases.length);
assert(cases.cases.every((item) => item.status !== 'PASS'));
assert.equal(environment.pi.available, true);
assert.equal(environment.pi.versionVerified, true);
assert.equal(environment.dedicatedPostgresql.available, true);
assert.equal(environment.dedicatedPostgresql.verified, true);
assert.equal(environment.verdict, 'READY_FOR_AUTHORIZATION');
assert.deepEqual(adapters.map((adapter) => adapter.kind), ['codex', 'pi', 'generic-cli']);
assert(adapters.every((adapter) => adapter.authority === 'IMPLEMENT_AND_SUBMIT_FOR_REVIEW_ONLY'));
assert(adapters.every((adapter) => adapter.contractVersion === contract.contractVersion));

const ignored = new Set(['.git', '.local', 'node_modules']);
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  if (ignored.has(entry.name)) return [];
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
for (const file of walk(root)) {
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const pattern of secretPatterns) assert(!pattern.test(text), `secret-like value in ${path.relative(root, file)}`);
}

const evidence = {
  verdict: 'PASS_CONTRACT_BLOCKED_EXECUTION',
  assertions: 26,
  taskBriefSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'pilot/task-brief.json'))).digest('hex'),
  adapterContractSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'contracts/adapter-contract.json'))).digest('hex'),
  limitations: brief.blockers,
};
console.log(JSON.stringify(evidence, null, 2));
