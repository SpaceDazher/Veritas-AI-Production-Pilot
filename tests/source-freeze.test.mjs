import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateFrozenSourceManifest, verifyFrozenSourceSnapshots } from '../src/source-freeze.mjs';

test('source manifest freezes five authoritative public sources and explicitly has no local-only inputs', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../pilot/source-selection-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateFrozenSourceManifest(manifest), []);
  assert.equal(manifest.status, 'FROZEN');
  assert.equal(manifest.sources.length, 5);
  assert.deepEqual(manifest.localOnlySources, []);
  assert(manifest.sources.every((source) => source.authority === 'primary'));
});

test('every frozen source snapshot matches size and SHA-256 recorded in the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../pilot/source-selection-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(verifyFrozenSourceSnapshots(manifest, new URL('..', import.meta.url)), []);
});

test('source validation rejects duplicates private content and mutable paths', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../pilot/source-selection-manifest.json', import.meta.url), 'utf8'));
  const duplicate = { ...manifest, sources: [...manifest.sources, manifest.sources[0]] };
  assert(validateFrozenSourceManifest(duplicate).some((issue) => issue.includes('duplicate')));
  assert(validateFrozenSourceManifest({ ...manifest, containsPrivateContent: true }).includes('private-content-forbidden'));
  const unsafe = structuredClone(manifest);
  unsafe.sources[0].snapshotPath = '../outside.bin';
  assert(validateFrozenSourceManifest(unsafe).includes('unsafe-snapshot-path'));
});
