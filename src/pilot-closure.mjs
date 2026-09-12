import { canonicalHash } from './canonical.mjs';
import { verifyPilotRunDigest } from './pilot-run-artifacts.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const closureDigestInput = (manifest) => {
  const copy = structuredClone(manifest);
  delete copy.closureDigest;
  return copy;
};
const linkedEvents = (events) => Array.isArray(events) && events.length >= 2
  && events.every((event, index) => HEX64.test(event.event_hash ?? '')
    && HEX64.test(event.previous_hash ?? '')
    && (index === 0 || event.previous_hash === events[index - 1].event_hash));

export const buildPilotClosureManifest = ({ pilotRunManifest, closureSnapshot, migrationSha256, executionCommitSha = null }) => {
  if (!verifyPilotRunDigest(pilotRunManifest)) throw new Error('pilot run digest is invalid');
  const task = closureSnapshot?.task;
  const events = closureSnapshot?.events;
  const decisions = closureSnapshot?.decisions;
  if (task?.id !== pilotRunManifest.taskId || task.status !== 'DONE' || task.revision !== 7) throw new Error('closure task is not DONE at revision 7');
  if (task.submission_digest !== pilotRunManifest.submissionDigest) throw new Error('closure task submission digest is stale');
  if (!linkedEvents(events) || events.length !== pilotRunManifest.eventCount + 1) throw new Error('closure audit chain is invalid');
  if (events[0].previous_hash !== pilotRunManifest.priorGlobalEventHash
      || events[0].event_hash !== pilotRunManifest.firstEventHash
      || events[pilotRunManifest.eventCount - 1].event_hash !== pilotRunManifest.lastEventHash
      || events.at(-1).previous_hash !== pilotRunManifest.lastEventHash
      || events.at(-1).event_type !== 'HUMAN_DECISION_RECORDED'
      || events.at(-1).task_revision !== 7) throw new Error('closure audit chain does not extend the reviewed run');
  if (!Array.isArray(decisions) || decisions.length !== 1) throw new Error('closure requires exactly one human decision');
  const decision = decisions[0];
  if (decision.actor_id !== 'repository-owner') throw new Error('closure decision must be made by repository-owner');
  if (decision.decision !== 'APPROVE' || decision.decision_scope !== 'solution') throw new Error('closure requires solution approval');
  if (decision.task_id !== task.id || decision.task_revision !== 6 || decision.artifact_digest !== pilotRunManifest.submissionDigest) {
    throw new Error('closure human decision digest or revision is stale');
  }
  if (!HEX64.test(migrationSha256 ?? '')) throw new Error('closure migration binding is invalid');
  if (executionCommitSha !== null && !/^[a-f0-9]{40}$/.test(executionCommitSha)) throw new Error('execution commit binding is invalid');
  const manifest = {
    schemaVersion: 1,
    pilotRunDigest: pilotRunManifest.pilotRunDigest,
    executionCommitSha,
    taskId: task.id,
    status: task.status,
    taskRevision: task.revision,
    submissionDigest: task.submission_digest,
    eventCount: events.length,
    priorGlobalEventHash: events[0].previous_hash,
    firstEventHash: events[0].event_hash,
    reviewedRunLastEventHash: pilotRunManifest.lastEventHash,
    closureEventHash: events.at(-1).event_hash,
    chainLinked: true,
    humanDecisionRecorded: true,
    decision: {
      decisionId: decision.decision_id,
      actorId: decision.actor_id,
      value: decision.decision,
      scope: decision.decision_scope,
      artifactDigest: decision.artifact_digest,
      reason: decision.reason,
      recordedAt: decision.recorded_at,
    },
    decisionPathMigrationSha256: migrationSha256,
    incrementalPaidApiBudgetAuthorizedUsd: 0,
    observedIncrementalProviderChargeUsd: pilotRunManifest.observedIncrementalProviderChargeUsd,
    productionDeploymentAuthorized: false,
    productionDeployed: false,
    targetDisposition: 'SOLUTION_APPROVED_PRODUCTION_NOT_AUTHORIZED',
    verdict: 'PASS_WITH_LIMITS',
    limitations: [
      ...pilotRunManifest.limitations,
      'human approval used an operator-mediated local session rather than production identity infrastructure',
    ],
  };
  return { ...manifest, closureDigest: canonicalHash(manifest) };
};

export const verifyPilotClosureDigest = (manifest) => {
  try {
    return HEX64.test(manifest.closureDigest ?? '') && canonicalHash(closureDigestInput(manifest)) === manifest.closureDigest;
  } catch {
    return false;
  }
};
