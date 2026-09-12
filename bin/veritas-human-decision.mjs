#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordPersistentHumanDecision } from '../src/postgres-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--execute')) {
  process.stderr.write('{"error":"HUMAN_DECISION_NOT_AUTHORIZED","message":"The repository owner must explicitly authorize execution."}\n');
  process.exit(2);
}
const inputIndex = process.argv.indexOf('--input');
if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('--input <repository-local-json> is required');
const inputPath = path.resolve(root, process.argv[inputIndex + 1]);
if (inputPath !== root && !inputPath.startsWith(`${root}${path.sep}`)) throw new Error('human decision input escapes repository');
const decision = JSON.parse(await readFile(inputPath, 'utf8'));
const result = recordPersistentHumanDecision(decision);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
