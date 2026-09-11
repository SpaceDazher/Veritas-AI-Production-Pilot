#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const [brief, contract, environment] = await Promise.all([
  loadJson('pilot/task-brief.json'),
  loadJson('contracts/adapter-contract.json'),
  loadJson('evidence/environment-manifest.json'),
]);
const missingPrerequisites = [!environment.pi?.available && 'pi-cli', !environment.dedicatedPostgresql?.available && 'dedicated-postgresql'].filter(Boolean);
const executionEnabled = brief.executionAuthorized === true && missingPrerequisites.length === 0;
const operation = process.argv[2] ?? 'discover';

if (operation === 'discover') {
  process.stdout.write(`${JSON.stringify({ contractVersion: contract.contractVersion, executionEnabled, maxConcurrentJobs: contract.limits.maxConcurrentJobs, paidApiBudgetUsd: contract.limits.paidApiBudgetUsd, operations: contract.operations, missingPrerequisites, status: executionEnabled ? 'READY' : 'BLOCKED_ENVIRONMENT' }, null, 2)}\n`);
  process.exit(0);
}
if (!executionEnabled) {
  process.stderr.write(`${JSON.stringify({ error: 'BLOCKED_ENVIRONMENT', message: 'State-changing operations are disabled until the frozen prerequisites are satisfied.', missingPrerequisites })}\n`);
  process.exit(2);
}
process.stderr.write(`${JSON.stringify({ error: 'NOT_IMPLEMENTED', message: 'The persistent PostgreSQL command path is not available in this local contract-only environment.' })}\n`);
process.exit(2);
