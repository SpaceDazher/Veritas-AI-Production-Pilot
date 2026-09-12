BEGIN;

ALTER TABLE human_decision
  ADD COLUMN IF NOT EXISTS decision_scope text NOT NULL DEFAULT 'solution'
  CHECK (decision_scope = 'solution');

CREATE OR REPLACE FUNCTION pilot_record_human_decision(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task pilot_task%ROWTYPE;
  v_existing human_decision%ROWTYPE;
  v_actor_type text;
  v_decision text;
  v_task_revision bigint;
  v_artifact_digest char(64);
  v_target_status text;
BEGIN
  PERFORM pilot_assert_exact_keys(
    p_payload,
    ARRAY['schemaVersion', 'decisionId', 'taskId', 'taskRevision', 'actorId', 'decision', 'decisionScope', 'artifactDigest', 'reason'],
    'human decision'
  );
  IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 9
     OR p_payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR p_payload->>'actorId' IS DISTINCT FROM 'repository-owner'
     OR p_payload->>'decisionScope' IS DISTINCT FROM 'solution'
     OR p_payload->>'decision' NOT IN ('APPROVE', 'REVISE', 'REJECT')
     OR coalesce(p_payload->>'artifactDigest', '') !~ '^[a-f0-9]{64}$'
     OR coalesce(btrim(p_payload->>'decisionId'), '') = ''
     OR coalesce(btrim(p_payload->>'taskId'), '') = ''
     OR coalesce(btrim(p_payload->>'reason'), '') = ''
     OR jsonb_typeof(p_payload->'taskRevision') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: human decision shape or authority';
  END IF;
  v_decision := p_payload->>'decision';
  v_task_revision := (p_payload->>'taskRevision')::bigint;
  v_artifact_digest := p_payload->>'artifactDigest';
  IF v_task_revision < 1 THEN RAISE EXCEPTION 'INVALID_REQUEST: taskRevision'; END IF;

  PERFORM 1 FROM scheduler_lock WHERE id = 1 AND purpose = 'one-active-job' FOR UPDATE;
  SELECT * INTO v_existing FROM human_decision WHERE decision_id = p_payload->>'decisionId';
  IF FOUND THEN
    IF v_existing.task_id IS DISTINCT FROM p_payload->>'taskId'
       OR v_existing.task_revision IS DISTINCT FROM v_task_revision
       OR v_existing.actor_id IS DISTINCT FROM p_payload->>'actorId'
       OR v_existing.decision IS DISTINCT FROM v_decision
       OR v_existing.decision_scope IS DISTINCT FROM p_payload->>'decisionScope'
       OR v_existing.artifact_digest IS DISTINCT FROM v_artifact_digest
       OR v_existing.reason IS DISTINCT FROM p_payload->>'reason' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: human decision id';
    END IF;
    SELECT * INTO v_task FROM pilot_task WHERE id = v_existing.task_id;
    RETURN jsonb_build_object('replayed', true, 'decision', to_jsonb(v_existing), 'task', to_jsonb(v_task));
  END IF;

  SELECT p.actor_type INTO v_actor_type
    FROM principal p
   WHERE p.actor_id = p_payload->>'actorId' AND p.enabled = true;
  IF v_actor_type IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'HUMAN_APPROVAL_REQUIRED: enabled human principal';
  END IF;
  SELECT * INTO v_task FROM pilot_task WHERE id = p_payload->>'taskId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF v_task.status IS DISTINCT FROM 'IN_REVIEW'
     OR v_task.revision IS DISTINCT FROM v_task_revision
     OR v_task.submission_digest IS DISTINCT FROM v_artifact_digest THEN
    RAISE EXCEPTION 'HUMAN_APPROVAL_REQUIRED: stale or unbound submission';
  END IF;
  IF EXISTS (SELECT 1 FROM human_decision WHERE task_id = v_task.id AND task_revision = v_task.revision) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: task revision already decided';
  END IF;

  INSERT INTO human_decision (
    decision_id, task_id, task_revision, actor_id, decision,
    artifact_digest, reason, decision_scope
  ) VALUES (
    p_payload->>'decisionId', v_task.id, v_task.revision,
    p_payload->>'actorId', v_decision, v_artifact_digest,
    p_payload->>'reason', p_payload->>'decisionScope'
  ) RETURNING * INTO v_existing;

  v_target_status := CASE v_decision
    WHEN 'APPROVE' THEN 'DONE'
    WHEN 'REVISE' THEN 'READY'
    WHEN 'REJECT' THEN 'FAILED'
  END;
  UPDATE pilot_task
     SET status = v_target_status, revision = revision + 1, updated_at = clock_timestamp()
   WHERE id = v_task.id
  RETURNING * INTO v_task;
  PERFORM pilot_append_event(
    v_task.id,
    v_task.revision,
    p_payload->>'actorId',
    'HUMAN_DECISION_RECORDED',
    jsonb_build_object(
      'decisionId', v_existing.decision_id,
      'decision', v_decision,
      'decisionScope', v_existing.decision_scope,
      'artifactDigest', v_existing.artifact_digest,
      'reason', v_existing.reason,
      'targetStatus', v_target_status
    )
  );
  RETURN jsonb_build_object('replayed', false, 'decision', to_jsonb(v_existing), 'task', to_jsonb(v_task));
END;
$$;

COMMIT;
