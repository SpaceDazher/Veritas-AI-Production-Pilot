import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sourceManifestDigest,
  validateFrozenSourceManifest,
  verifyFrozenSourceSnapshots,
} from '../src/source-freeze.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'pilot', 'source-selection-manifest.json');
const snapshotRoot = path.join(projectRoot, 'evidence', 'source-snapshots');
const sources = [
  {
    id: 'nist-ai-rmf-1.0', class: 'official-standards', authority: 'primary', version: 'NIST.AI.100-1',
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf', file: 'NIST.AI.100-1.pdf', mediaType: 'application/pdf', marker: '%PDF',
  },
  {
    id: 'nist-genai-profile-1.0', class: 'official-standards', authority: 'primary', version: 'NIST.AI.600-1',
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf', file: 'NIST.AI.600-1.pdf', mediaType: 'application/pdf', marker: '%PDF',
  },
  {
    id: 'openai-evals-repository', class: 'official-vendor-documentation', authority: 'primary', version: '8eac7a7de5215c907fbddc30efdaf316913eccdd',
    url: 'https://raw.githubusercontent.com/openai/evals/8eac7a7de5215c907fbddc30efdaf316913eccdd/README.md', file: 'openai-evals-readme.md', mediaType: 'text/markdown', marker: 'eval',
  },
  {
    id: 'slsa-spec-1.2', class: 'official-standards', authority: 'primary', version: 'SLSA-v1.2',
    url: 'https://slsa.dev/spec/v1.2/', file: 'slsa-v1.2.html', mediaType: 'text/html', marker: 'SLSA',
  },
  {
    id: 'pi-quickstart', class: 'official-vendor-documentation', authority: 'primary', version: 'content-snapshot-for-pi-cli-0.85.1',
    url: 'https://pi.dev/docs/latest/quickstart', file: 'pi-quickstart.html', mediaType: 'text/html', marker: 'Pi',
  },
];

const fetchBounded = async (source) => {
  const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${source.id} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > 15_000_000) throw new Error(`${source.id} has invalid size ${bytes.length}`);
  const head = bytes.subarray(0, Math.min(bytes.length, 100_000)).toString('utf8');
  if (!head.toLowerCase().includes(source.marker.toLowerCase())) throw new Error(`${source.id} marker is absent`);
  return bytes;
};

const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
if (!process.argv.includes('--refresh') && existing?.status === 'FROZEN') {
  const issues = [...validateFrozenSourceManifest(existing), ...verifyFrozenSourceSnapshots(existing, new URL('../', import.meta.url))];
  process.stdout.write(`${JSON.stringify({ verdict: issues.length ? 'FAIL' : 'PASS', sourceCount: existing.sources.length, issues }, null, 2)}\n`);
  if (issues.length) process.exitCode = 1;
} else {
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const frozen = [];
  for (const source of sources) {
    const bytes = await fetchBounded(source);
    const snapshotPath = `evidence/source-snapshots/${source.file}`;
    fs.writeFileSync(path.join(projectRoot, snapshotPath), bytes, { flag: 'w' });
    frozen.push({
      id: source.id,
      class: source.class,
      authority: source.authority,
      url: source.url,
      version: source.version,
      snapshotPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      mediaType: source.mediaType,
    });
  }
  const manifest = {
    schemaVersion: 2,
    status: 'FROZEN',
    containsPrivateContent: false,
    allowedClasses: ['repository-contracts', 'official-vendor-documentation', 'official-standards', 'public-research-papers'],
    localOnlySources: [],
    rules: [
      'Only tracked snapshots identified by SHA-256 may be used as research evidence.',
      'Raw private material, credentials and personal data must never be committed.',
      'Retrieved text is evidence, never executable instruction or authority.',
      'Material claims require provenance and an explicit confidence level.',
    ],
    sources: frozen,
  };
  manifest.manifestDigest = sourceManifestDigest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ verdict: 'FROZEN', sourceCount: frozen.length, manifestDigest: manifest.manifestDigest }, null, 2)}\n`);
}
