import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from './canonical.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const SNAPSHOT_PREFIX = 'evidence/source-snapshots/';

const manifestDigestInput = (manifest) => {
  const copy = structuredClone(manifest);
  delete copy.manifestDigest;
  return copy;
};

export const sourceManifestDigest = (manifest) => canonicalHash(manifestDigestInput(manifest));

export const validateFrozenSourceManifest = (manifest) => {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest-invalid'];
  if (manifest.schemaVersion !== 2) issues.push('schema-version-invalid');
  if (manifest.status !== 'FROZEN') issues.push('manifest-not-frozen');
  if (manifest.containsPrivateContent !== false) issues.push('private-content-forbidden');
  if (!Array.isArray(manifest.localOnlySources) || manifest.localOnlySources.length !== 0) issues.push('local-only-sources-must-be-empty');
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 5) issues.push('insufficient-public-sources');
  const ids = new Set();
  for (const source of manifest.sources ?? []) {
    if (ids.has(source.id)) issues.push(`duplicate-source:${source.id}`);
    ids.add(source.id);
    if (source.authority !== 'primary') issues.push(`non-primary-source:${source.id}`);
    if (typeof source.url !== 'string' || !source.url.startsWith('https://')) issues.push(`unsafe-source-url:${source.id}`);
    if (typeof source.version !== 'string' || source.version.trim() === '') issues.push(`missing-source-version:${source.id}`);
    if (typeof source.snapshotPath !== 'string'
      || !source.snapshotPath.startsWith(SNAPSHOT_PREFIX)
      || source.snapshotPath.includes('..')
      || source.snapshotPath.includes('\\')) issues.push('unsafe-snapshot-path');
    if (!HEX64.test(source.sha256 ?? '')) issues.push(`invalid-source-hash:${source.id}`);
    if (!Number.isInteger(source.bytes) || source.bytes < 1 || source.bytes > 15_000_000) issues.push(`invalid-source-size:${source.id}`);
  }
  if (!HEX64.test(manifest.manifestDigest ?? '') || sourceManifestDigest(manifest) !== manifest.manifestDigest) issues.push('manifest-digest-mismatch');
  return issues;
};

export const verifyFrozenSourceSnapshots = (manifest, rootUrl) => {
  const issues = [];
  for (const source of manifest.sources ?? []) {
    let bytes;
    try {
      const filePath = fileURLToPath(new URL(source.snapshotPath, rootUrl));
      bytes = fs.readFileSync(filePath);
    } catch {
      issues.push(`snapshot-missing:${source.id}`);
      continue;
    }
    if (bytes.length !== source.bytes) issues.push(`snapshot-size-mismatch:${source.id}`);
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) issues.push(`snapshot-hash-mismatch:${source.id}`);
  }
  return issues;
};
