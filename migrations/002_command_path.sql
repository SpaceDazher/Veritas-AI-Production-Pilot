BEGIN;

INSERT INTO principal (actor_id, actor_type, identity_digest)
VALUES
  ('host', 'host', encode(sha256(convert_to('host', 'UTF8')), 'hex')),
  ('codex-local', 'agent', encode(sha256(convert_to('codex-local', 'UTF8')), 'hex')),
  ('pi-local', 'agent', encode(sha256(convert_to('pi-local', 'UTF8')), 'hex')),
  ('repository-owner', 'human', encode(sha256(convert_to('repository-owner', 'UTF8')), 'hex'))
ON CONFLICT (actor_id) DO NOTHING;

INSERT INTO adapter_capability (actor_id, operation)
SELECT actor_id, operation
FROM (VALUES ('codex-local'), ('pi-local')) AS actor(actor_id)
CROSS JOIN (VALUES
  ('discover'), ('claim'), ('start'), ('heartbeat'), ('checkpoint'),
  ('submit-for-review'), ('fail'), ('cancel')
) AS capability(operation)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pilot_assert_exact_keys(p_value jsonb, p_allowed text[], p_context text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: % must be an object', p_context;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_value) AS key
    WHERE NOT (key = ANY(p_allowed))
  ) THEN
    RAISE EXCEPTION 'INVALID_REQUEST: % contains unknown fields', p_context;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pilot_append_event(
  p_task_id text,
  p_task_revision bigint,
  p_actor_id text,
  p_event_type text,
  p_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_hash char(64) := repeat('0', 64);
  v_material jsonb;
  v_event_hash char(64);
  v_event_id text;
BEGIN
  SELECT event_hash INTO v_previous_hash
    FROM audit_event
   ORDER BY sequence DESC
   LIMIT 1;
  v_previous_hash := coalesce(v_previous_hash, repeat('0', 64));
  v_material := jsonb_build_object(
    'taskId', p_task_id,
    'taskRevision', p_task_revision,
    'actorId', p_actor_id,
    'eventType', p_event_type,
    'previousHash', v_previous_hash,
    'data', p_data
  );
  v_event_hash := encode(sha256(convert_to(v_material::text, 'UTF8')), 'hex');
  v_event_id := 'evt-' || left(v_event_hash, 24);
  INSERT INTO audit_event (
    event_id, task_id, task_revision, actor_id, event_type,
    previous_hash, event_hash, event_data
  ) VALUES (
    v_event_id, p_task_id, p_task_revision, p_actor_id, p_event_type,
    v_previous_hash, v_event_hash, p_data
  );
  RETURN jsonb_build_object('eventId', v_event_id, 'eventHash', v_event_hash, 'previousHash', v_previous_hash);
END;
$$;

CREATE OR REPLACE FUNCTION pilot_seed_task(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task pilot_task%ROWTYPE;
BEGIN
  PERFORM pilot_assert_exact_keys(p_payload, ARRAY['taskId', 'goalId', 'title'], 'seed payload');
  IF coalesce(btrim(p_payload->>'taskId'), '') = ''
     OR coalesce(btrim(p_payload->>'goalId'), '') = ''
     OR coalesce(btrim(p_payload->>'title'), '') = '' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: taskId, goalId and title are required';
  END IF;
  PERFORM 1 FROM scheduler_lock WHERE id = 1 FOR UPDATE;
  SELECT * INTO v_task FROM pilot_task WHERE id = p_payload->>'taskId';
  IF FOUND THEN
    IF v_task.goal_id IS DISTINCT FROM p_payload->>'goalId'
       OR v_task.title IS DISTINCT FROM p_payload->>'title' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: task id already exists with different content';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'task', to_jsonb(v_task));
  END IF;
  INSERT INTO pilot_task (id, goal_id, title, status)
  VALUES (p_payload->>'taskId', p_payload->>'goalId', p_payload->>'title', 'BACKLOG')
  RETURNING * INTO v_task;
  PERFORM pilot_append_event(v_task.id, v_task.revision, 'host', 'TASK_SEEDED', jsonb_build_object('status', v_task.status));
  RETURN jsonb_build_object('replayed', false, 'task', to_jsonb(v_task));
END;
$$;

CREATE OR REPLACE FUNCTION pilot_mark_ready(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task pilot_task%ROWTYPE;
  v_expected_revision bigint;
BEGIN
  PERFORM pilot_assert_exact_keys(p_payload, ARRAY['taskId', 'expectedRevision'], 'ready payload');
  IF jsonb_typeof(p_payload->'expectedRevision') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: expectedRevision is required';
  END IF;
  v_expected_revision := (p_payload->>'expectedRevision')::bigint;
  PERFORM 1 FROM scheduler_lock WHERE id = 1 FOR UPDATE;
  SELECT * INTO v_task FROM pilot_task WHERE id = p_payload->>'taskId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF v_task.revision IS DISTINCT FROM v_expected_revision THEN RAISE EXCEPTION 'STALE_REVISION'; END IF;
  IF v_task.status NOT IN ('BACKLOG', 'BLOCKED') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
  UPDATE pilot_task
     SET status = 'READY', revision = revision + 1, updated_at = clock_timestamp()
   WHERE id = v_task.id
  RETURNING * INTO v_task;
  PERFORM pilot_append_event(v_task.id, v_task.revision, 'host', 'TASK_READY', jsonb_build_object('status', v_task.status));
  RETURN jsonb_build_object('task', to_jsonb(v_task));
END;
$$;

CREATE OR REPLACE FUNCTION pilot_dispatch(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation text;
  v_operation_id text;
  v_actor_id text;
  v_task_id text;
  v_expected_revision bigint;
  v_arguments jsonb;
  v_idempotency_key text;
  v_request_hash char(64);
  v_task pilot_task%ROWTYPE;
  v_lease task_lease%ROWTYPE;
  v_prior operation_dedup%ROWTYPE;
  v_ttl_ms bigint;
  v_response jsonb;
  v_submission_digest char(64);
BEGIN
  PERFORM pilot_assert_exact_keys(
    p_command,
    ARRAY['contractVersion', 'operationId', 'operation', 'actorId', 'taskId', 'expectedRevision', 'arguments'],
    'command'
  );
  IF (SELECT count(*) FROM jsonb_object_keys(p_command)) <> 7
     OR p_command->>'contractVersion' IS DISTINCT FROM '1.0.0-draft' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: command shape or contractVersion';
  END IF;
  v_operation := p_command->>'operation';
  v_operation_id := p_command->>'operationId';
  v_actor_id := p_command->>'actorId';
  v_task_id := p_command->>'taskId';
  v_arguments := p_command->'arguments';
  IF jsonb_typeof(p_command->'expectedRevision') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_REQUEST: expectedRevision'; END IF;
  v_expected_revision := (p_command->>'expectedRevision')::bigint;
  IF v_expected_revision < 1 THEN RAISE EXCEPTION 'INVALID_REQUEST: expectedRevision'; END IF;
  IF v_operation NOT IN ('claim', 'start', 'heartbeat', 'checkpoint', 'submit-for-review', 'fail', 'cancel') THEN
    RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
  END IF;
  IF coalesce(btrim(v_operation_id), '') = '' OR coalesce(btrim(v_actor_id), '') = '' OR coalesce(btrim(v_task_id), '') = '' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: identifiers are required';
  END IF;
  IF jsonb_typeof(v_arguments) IS DISTINCT FROM 'object' OR coalesce(btrim(v_arguments->>'idempotencyKey'), '') = '' THEN
    RAISE EXCEPTION 'INVALID_REQUEST: arguments and idempotencyKey are required';
  END IF;
  v_idempotency_key := v_arguments->>'idempotencyKey';
  v_request_hash := encode(sha256(convert_to(p_command::text, 'UTF8')), 'hex');

  PERFORM 1 FROM scheduler_lock WHERE id = 1 AND purpose = 'one-active-job' FOR UPDATE;
  SELECT * INTO v_prior FROM operation_dedup WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_prior.request_hash IS DISTINCT FROM v_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_set(v_prior.response_json, '{replayed}', 'true'::jsonb);
  END IF;
  IF EXISTS (SELECT 1 FROM operation_dedup WHERE idempotency_key = v_idempotency_key) THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal p
    JOIN adapter_capability c ON c.actor_id = p.actor_id
    WHERE p.actor_id = v_actor_id AND p.actor_type = 'agent' AND p.enabled = true AND c.operation = v_operation
  ) THEN RAISE EXCEPTION 'CAPABILITY_DENIED'; END IF;
  SELECT * INTO v_task FROM pilot_task WHERE id = v_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF v_task.revision IS DISTINCT FROM v_expected_revision THEN RAISE EXCEPTION 'STALE_REVISION'; END IF;

  IF v_operation = 'claim' THEN
    PERFORM pilot_assert_exact_keys(v_arguments, ARRAY['idempotencyKey', 'leaseTtlMs'], 'claim arguments');
    IF v_task.status IS DISTINCT FROM 'READY' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
    UPDATE task_lease SET released_at = clock_timestamp(), release_reason = 'EXPIRED'
     WHERE released_at IS NULL AND expires_at <= clock_timestamp();
    IF EXISTS (SELECT 1 FROM task_lease WHERE released_at IS NULL) THEN RAISE EXCEPTION 'ACTIVE_JOB_EXISTS'; END IF;
    v_ttl_ms := coalesce((v_arguments->>'leaseTtlMs')::bigint, 30000);
    IF v_ttl_ms < 1 OR v_ttl_ms > 900000 THEN RAISE EXCEPTION 'INVALID_REQUEST: leaseTtlMs'; END IF;
    INSERT INTO task_lease (lease_id, task_id, actor_id, expires_at)
    VALUES ('lease-' || left(v_request_hash, 24), v_task.id, v_actor_id, clock_timestamp() + (v_ttl_ms * interval '1 millisecond'))
    RETURNING * INTO v_lease;
    UPDATE pilot_task SET status = 'CLAIMED', revision = revision + 1, updated_at = clock_timestamp()
     WHERE id = v_task.id RETURNING * INTO v_task;
    PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'TASK_CLAIMED', jsonb_build_object('leaseId', v_lease.lease_id, 'fencingToken', v_lease.fencing_token, 'expiresAt', v_lease.expires_at));
    v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task), 'lease', to_jsonb(v_lease)));
  ELSE
    IF v_operation IN ('start', 'heartbeat') THEN
      PERFORM pilot_assert_exact_keys(v_arguments, ARRAY['idempotencyKey', 'leaseId', 'fencingToken'], v_operation || ' arguments');
    ELSIF v_operation = 'checkpoint' THEN
      PERFORM pilot_assert_exact_keys(v_arguments, ARRAY['idempotencyKey', 'leaseId', 'fencingToken', 'checkpoint'], 'checkpoint arguments');
    ELSIF v_operation = 'submit-for-review' THEN
      PERFORM pilot_assert_exact_keys(v_arguments, ARRAY['idempotencyKey', 'leaseId', 'fencingToken', 'artifacts', 'checks'], 'submit arguments');
    ELSE
      PERFORM pilot_assert_exact_keys(v_arguments, ARRAY['idempotencyKey', 'leaseId', 'fencingToken', 'reason'], v_operation || ' arguments');
    END IF;
    SELECT * INTO v_lease FROM task_lease WHERE lease_id = v_arguments->>'leaseId' FOR UPDATE;
    IF NOT FOUND OR v_lease.task_id IS DISTINCT FROM v_task.id OR v_lease.actor_id IS DISTINCT FROM v_actor_id OR v_lease.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'LEASE_REQUIRED';
    END IF;
    IF jsonb_typeof(v_arguments->'fencingToken') IS DISTINCT FROM 'number'
       OR v_lease.fencing_token IS DISTINCT FROM (v_arguments->>'fencingToken')::bigint THEN RAISE EXCEPTION 'STALE_FENCE'; END IF;
    IF clock_timestamp() >= v_lease.expires_at THEN RAISE EXCEPTION 'LEASE_EXPIRED'; END IF;

    IF v_operation = 'start' THEN
      IF v_task.status IS DISTINCT FROM 'CLAIMED' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
      UPDATE pilot_task SET status = 'RUNNING', revision = revision + 1, updated_at = clock_timestamp()
       WHERE id = v_task.id RETURNING * INTO v_task;
      PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'TASK_STARTED', jsonb_build_object('leaseId', v_lease.lease_id, 'fencingToken', v_lease.fencing_token));
      v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task), 'lease', to_jsonb(v_lease)));
    ELSIF v_operation = 'heartbeat' THEN
      IF v_task.status IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
      UPDATE task_lease SET expires_at = clock_timestamp() + interval '30 seconds' WHERE lease_id = v_lease.lease_id RETURNING * INTO v_lease;
      PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'LEASE_HEARTBEAT', jsonb_build_object('leaseId', v_lease.lease_id, 'expiresAt', v_lease.expires_at));
      v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task), 'lease', to_jsonb(v_lease)));
    ELSIF v_operation = 'checkpoint' THEN
      IF v_task.status IS DISTINCT FROM 'RUNNING' OR NOT (v_arguments ? 'checkpoint') THEN RAISE EXCEPTION 'INVALID_REQUEST: checkpoint'; END IF;
      UPDATE pilot_task SET revision = revision + 1, updated_at = clock_timestamp()
       WHERE id = v_task.id RETURNING * INTO v_task;
      PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'CHECKPOINT_RECORDED', jsonb_build_object('checkpointDigest', encode(sha256(convert_to((v_arguments->'checkpoint')::text, 'UTF8')), 'hex')));
      v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task)));
    ELSIF v_operation = 'submit-for-review' THEN
      IF v_task.status IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
      IF jsonb_typeof(v_arguments->'artifacts') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_arguments->'artifacts') < 1
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_arguments->'artifacts') artifact
           WHERE jsonb_typeof(artifact) IS DISTINCT FROM 'object'
              OR coalesce(artifact->>'path', '') = ''
              OR coalesce(artifact->>'sha256', '') !~ '^[a-f0-9]{64}$'
              OR artifact->>'path' LIKE '/%'
              OR artifact->>'path' ~ '^[A-Za-z]:[\\/]'
              OR replace(artifact->>'path', E'\\\\', '/') ~ '(^|/)\.\.(/|$)'
              OR EXISTS (SELECT 1 FROM jsonb_object_keys(artifact) key WHERE key NOT IN ('path', 'sha256'))
         ) THEN RAISE EXCEPTION 'ARTIFACTS_REQUIRED'; END IF;
      IF jsonb_typeof(v_arguments->'checks') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_arguments->'checks') < 1
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_arguments->'checks') check_item
           WHERE jsonb_typeof(check_item) IS DISTINCT FROM 'object'
              OR coalesce(check_item->>'name', '') = ''
              OR check_item->'passed' IS DISTINCT FROM 'true'::jsonb
              OR EXISTS (SELECT 1 FROM jsonb_object_keys(check_item) key WHERE key NOT IN ('name', 'passed'))
         ) THEN RAISE EXCEPTION 'CHECK_FAILED'; END IF;
      v_submission_digest := encode(sha256(convert_to(jsonb_build_object('artifacts', v_arguments->'artifacts', 'checks', v_arguments->'checks')::text, 'UTF8')), 'hex');
      UPDATE pilot_task SET status = 'IN_REVIEW', revision = revision + 1, submission_digest = v_submission_digest, updated_at = clock_timestamp()
       WHERE id = v_task.id RETURNING * INTO v_task;
      UPDATE task_lease SET released_at = clock_timestamp(), release_reason = 'SUBMITTED' WHERE lease_id = v_lease.lease_id;
      PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'TASK_SUBMITTED_FOR_REVIEW', jsonb_build_object('leaseId', v_lease.lease_id, 'submissionDigest', v_submission_digest, 'artifacts', v_arguments->'artifacts', 'checks', v_arguments->'checks'));
      v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task), 'submissionDigest', v_submission_digest));
    ELSE
      IF v_task.status NOT IN ('CLAIMED', 'RUNNING') OR coalesce(btrim(v_arguments->>'reason'), '') = '' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
      UPDATE pilot_task SET status = CASE WHEN v_operation = 'fail' THEN 'FAILED' ELSE 'CANCELLED' END, revision = revision + 1, updated_at = clock_timestamp()
       WHERE id = v_task.id RETURNING * INTO v_task;
      UPDATE task_lease SET released_at = clock_timestamp(), release_reason = upper(v_operation) WHERE lease_id = v_lease.lease_id;
      PERFORM pilot_append_event(v_task.id, v_task.revision, v_actor_id, 'TASK_' || v_task.status, jsonb_build_object('reason', v_arguments->>'reason'));
      v_response := jsonb_build_object('replayed', false, 'result', jsonb_build_object('task', to_jsonb(v_task)));
    END IF;
  END IF;

  INSERT INTO operation_dedup (operation_id, idempotency_key, actor_id, task_id, expected_revision, request_hash, response_json)
  VALUES (v_operation_id, v_idempotency_key, v_actor_id, v_task_id, v_expected_revision, v_request_hash, v_response);
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION pilot_task_snapshot(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task pilot_task%ROWTYPE;
BEGIN
  PERFORM pilot_assert_exact_keys(p_payload, ARRAY['taskId'], 'snapshot payload');
  SELECT * INTO v_task FROM pilot_task WHERE id = p_payload->>'taskId';
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'events', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.sequence) FROM audit_event e WHERE e.task_id = v_task.id), '[]'::jsonb)
  );
END;
$$;

COMMIT;
