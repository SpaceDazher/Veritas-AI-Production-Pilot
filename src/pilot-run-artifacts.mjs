import { canonicalHash } from './canonical.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const SOLUTION_KEYS = ['schemaVersion', 'taskId', 'role', 'objective', 'assumptions', 'architecture', 'deliveryStages', 'metrics', 'risks', 'productionDeploymentAuthorized', 'finalApprovalClaimed'];
const REVIEW_KEYS = ['schemaVersion', 'taskId', 'role', 'verdict', 'verifiedCriteria', 'findings', 'requiredChanges', 'productionApproval', 'authorityClaims'];

const exactKeys = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const strings = (value, minimum = 0) => Array.isArray(value) && value.length >= minimum && value.every((item) => typeof item === 'string' && item.trim() !== '');
const records = (value, keys, minimum = 1) => Array.isArray(value) && value.length >= minimum && value.every((item) => exactKeys(item, keys) && keys.every((key) => typeof item[key] === 'string' && item[key].trim() !== ''));
const parse = (text) => {
  if (typeof text !== 'string' || text.length > 100_000) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  const payload = fenced ? fenced[1].trim() : trimmed;
  try { return JSON.parse(payload); } catch { return null; }
};

export const parseCodexSolution = (text) => {
  const value = parse(text);
  if (!exactKeys(value, SOLUTION_KEYS)
      || value.schemaVersion !== 1
      || value.taskId !== 'S2-001-AI-PRODUCTION-TASK-v2'
      || value.role !== 'codex-implementer'
      || typeof value.objective !== 'string' || value.objective.trim().length < 20
      || !strings(value.assumptions, 2)
      || !strings(value.architecture, 3)
      || !records(value.deliveryStages, ['name', 'outcome', 'verification'], 3)
      || !records(value.metrics, ['name', 'target', 'measurement'])
      || !records(value.risks, ['risk', 'mitigation'])
      || value.productionDeploymentAuthorized !== false
      || value.finalApprovalClaimed !== false) return null;
  return value;
};

export const parsePiReview = (text) => {
  const value = parse(text);
  if (!exactKeys(value, REVIEW_KEYS)
      || value.schemaVersion !== 1
      || value.taskId !== 'S2-001-AI-PRODUCTION-TASK-v2'
      || value.role !== 'pi-independent-reviewer'
      || !['PASS_WITH_LIMITS', 'REVISE'].includes(value.verdict)
      || !strings(value.verifiedCriteria, 2)
      || !strings(value.findings, 1)
      || !strings(value.requiredChanges, 0)
      || value.productionApproval !== false
      || !Array.isArray(value.authorityClaims) || value.authorityClaims.length !== 0) return null;
  return value;
};

const verifyTaskEventSlice = (events) => Array.isArray(events) && events.length >= 2
  && events.every((event, index) => HEX64.test(event.event_hash ?? '')
    && HEX64.test(event.previous_hash ?? '')
    && (index === 0 || event.previous_hash === events[index - 1].event_hash));

export const buildFailedPilotAttemptEvidence = ({ taskSnapshot, codexArtifactSha256 }) => {
  if (taskSnapshot?.task?.id !== 'S2-001-AI-PRODUCTION-TASK-v1' || taskSnapshot.task.status !== 'FAILED') {
    throw new Error('failed pilot evidence requires the terminal v1 task');
  }
  if (!Number.isInteger(taskSnapshot.task.revision) || !verifyTaskEventSlice(taskSnapshot.events)) {
    throw new Error('failed pilot audit evidence is invalid');
  }
  if (!HEX64.test(codexArtifactSha256 ?? '')) throw new Error('failed pilot Codex artifact binding is invalid');
  const terminalReason = taskSnapshot.task.terminal_reason ?? taskSnapshot.events.at(-1)?.event_data?.reason;
  if (typeof terminalReason !== 'string' || terminalReason.trim() === '') throw new Error('failed pilot terminal reason is missing');
  const evidence = {
    schemaVersion: 1,
    decisionInput: false,
    taskId: taskSnapshot.task.id,
    status: taskSnapshot.task.status,
    taskRevision: taskSnapshot.task.revision,
    terminalReason,
    eventCount: taskSnapshot.events.length,
    priorGlobalEventHash: taskSnapshot.events[0].previous_hash,
    firstEventHash: taskSnapshot.events[0].event_hash,
    lastEventHash: taskSnapshot.events.at(-1).event_hash,
    chainLinked: true,
    failureStage: 'pi-output-contract',
    codexArtifactSha256,
    piRawPersisted: false,
    modelCallsExecuted: 2,
    productionDeployed: false,
    humanDecisionRecorded: false,
    disposition: 'RETRY_AS_NEW_TASK_REVISION',
  };
  return { ...evidence, failureEvidenceDigest: canonicalHash(evidence) };
};

const digestInput = (manifest) => {
  const copy = structuredClone(manifest);
  delete copy.pilotRunDigest;
  return copy;
};

export const buildPilotRunManifest = ({ taskSnapshot, codex, pi, sourceManifestSha256, environmentDigest, migrationSha256 }) => {
  if (taskSnapshot?.task?.status !== 'IN_REVIEW') throw new Error('pilot task must stop at IN_REVIEW');
  if (!Number.isInteger(taskSnapshot.task.revision) || !HEX64.test(taskSnapshot.task.submission_digest ?? '')) throw new Error('task submission binding is invalid');
  if (!Array.isArray(taskSnapshot.events) || taskSnapshot.events.length < 2) throw new Error('task audit evidence is incomplete');
  const chainLinked = verifyTaskEventSlice(taskSnapshot.events);
  if (!chainLinked) throw new Error('task audit chain is stale');
  for (const [name, run] of [['codex', codex], ['pi', pi]]) {
    if (!Number.isInteger(run?.processId) || run.processId <= 0) throw new Error(`${name} process identity is invalid`);
    if (![run.outputSha256, run.artifactSha256].every((value) => HEX64.test(value ?? ''))) throw new Error(`${name} output binding is invalid`);
  }
  if (codex.processId === pi.processId) throw new Error('pilot agent processes are not separated');
  if (![sourceManifestSha256, environmentDigest, migrationSha256].every((value) => HEX64.test(value ?? ''))) throw new Error('pilot input binding is invalid');
  const manifest = {
    schemaVersion: 1,
    decisionInput: true,
    taskId: taskSnapshot.task.id,
    status: taskSnapshot.task.status,
    taskRevision: taskSnapshot.task.revision,
    submissionDigest: taskSnapshot.task.submission_digest,
    eventCount: taskSnapshot.events.length,
    priorGlobalEventHash: taskSnapshot.events[0].previous_hash,
    firstEventHash: taskSnapshot.events[0].event_hash,
    lastEventHash: taskSnapshot.events.at(-1).event_hash,
    chainLinked,
    agents: { codex: structuredClone(codex), pi: structuredClone(pi) },
    processSeparated: true,
    sourceManifestSha256,
    environmentDigest,
    migrationSha256,
    modelCallsExecuted: 2,
    incrementalPaidApiBudgetAuthorizedUsd: 0,
    observedIncrementalProviderChargeUsd: null,
    productionDeployed: false,
    humanDecisionRecorded: false,
    rawTranscriptsCommitted: false,
    limitations: [
      'the output is a reviewed blueprint, not a deployed application',
      'subscription CLIs expose no per-call billing telemetry',
      'both agent processes ran on the same host',
    ],
    verdict: 'AWAITING_HUMAN_DECISION',
  };
  return { ...manifest, pilotRunDigest: canonicalHash(manifest) };
};

export const verifyPilotRunDigest = (manifest) => {
  try {
    return HEX64.test(manifest.pilotRunDigest ?? '') && canonicalHash(digestInput(manifest)) === manifest.pilotRunDigest;
  } catch { return false; }
};
