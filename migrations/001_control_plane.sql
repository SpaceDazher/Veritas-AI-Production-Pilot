BEGIN;

CREATE TABLE principal (
    actor_id text PRIMARY KEY,
    actor_type text NOT NULL CHECK (actor_type IN ('agent', 'human', 'host')),
    enabled boolean NOT NULL DEFAULT true,
    identity_digest char(64) NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE adapter_capability (
    actor_id text NOT NULL REFERENCES principal(actor_id),
    operation text NOT NULL CHECK (operation IN (
        'discover', 'claim', 'start', 'heartbeat', 'checkpoint',
        'submit-for-review', 'fail', 'cancel'
    )),
    PRIMARY KEY (actor_id, operation)
);

CREATE TABLE scheduler_lock (
    id smallint PRIMARY KEY CHECK (id = 1),
    purpose text NOT NULL CHECK (purpose = 'one-active-job')
);
INSERT INTO scheduler_lock (id, purpose) VALUES (1, 'one-active-job');

CREATE TABLE pilot_task (
    id text PRIMARY KEY,
    goal_id text NOT NULL,
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    status text NOT NULL CHECK (status IN (
        'BACKLOG', 'READY', 'CLAIMED', 'RUNNING', 'BLOCKED',
        'IN_REVIEW', 'DONE', 'FAILED', 'CANCELLED'
    )),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    submission_digest char(64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (submission_digest IS NULL OR submission_digest ~ '^[a-f0-9]{64}$')
);

CREATE SEQUENCE fencing_token_sequence AS bigint START WITH 1;

CREATE TABLE task_lease (
    lease_id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES pilot_task(id),
    actor_id text NOT NULL REFERENCES principal(actor_id),
    fencing_token bigint NOT NULL DEFAULT nextval('fencing_token_sequence'),
    acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    released_at timestamptz,
    release_reason text,
    CHECK (expires_at > acquired_at),
    CHECK ((released_at IS NULL AND release_reason IS NULL) OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX one_unreleased_pilot_lease
    ON task_lease ((true))
    WHERE released_at IS NULL;

CREATE TABLE operation_dedup (
    operation_id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    actor_id text NOT NULL REFERENCES principal(actor_id),
    task_id text NOT NULL REFERENCES pilot_task(id),
    expected_revision bigint NOT NULL,
    request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    response_json jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE audit_event (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    task_id text NOT NULL REFERENCES pilot_task(id),
    task_revision bigint NOT NULL,
    actor_id text NOT NULL REFERENCES principal(actor_id),
    event_type text NOT NULL,
    previous_hash char(64) NOT NULL CHECK (previous_hash ~ '^[a-f0-9]{64}$'),
    event_hash char(64) NOT NULL UNIQUE CHECK (event_hash ~ '^[a-f0-9]{64}$'),
    event_data jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE human_decision (
    decision_id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES pilot_task(id),
    task_revision bigint NOT NULL,
    actor_id text NOT NULL REFERENCES principal(actor_id),
    decision text NOT NULL CHECK (decision IN ('APPROVE', 'REVISE', 'REJECT')),
    artifact_digest char(64) NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (task_id, task_revision)
);

CREATE OR REPLACE FUNCTION reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; UPDATE OR DELETE is forbidden', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_human_decision_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actor_type text;
    current_status text;
    current_revision bigint;
    current_digest char(64);
BEGIN
    SELECT p.actor_type INTO actor_type
      FROM principal p
     WHERE p.actor_id = NEW.actor_id AND p.enabled = true;
    IF actor_type IS DISTINCT FROM 'human' THEN
        RAISE EXCEPTION 'human decision requires an enabled human principal';
    END IF;

    SELECT t.status, t.revision, t.submission_digest
      INTO current_status, current_revision, current_digest
      FROM pilot_task t
     WHERE t.id = NEW.task_id
     FOR UPDATE;
    IF current_status IS DISTINCT FROM 'IN_REVIEW'
       OR current_revision IS DISTINCT FROM NEW.task_revision
       OR current_digest IS DISTINCT FROM NEW.artifact_digest THEN
        RAISE EXCEPTION 'human decision is stale or not bound to the current submission';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_task_lease_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actor_type text;
BEGIN
    SELECT p.actor_type INTO actor_type
      FROM principal p
     WHERE p.actor_id = NEW.actor_id AND p.enabled = true;
    IF actor_type IS DISTINCT FROM 'agent' THEN
        RAISE EXCEPTION 'task lease requires an enabled agent principal';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM adapter_capability c
         WHERE c.actor_id = NEW.actor_id AND c.operation = 'claim'
    ) THEN
        RAISE EXCEPTION 'agent lacks claim capability';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER human_decision_authority
BEFORE INSERT ON human_decision
FOR EACH ROW EXECUTE FUNCTION enforce_human_decision_authority();

CREATE TRIGGER task_lease_authority
BEFORE INSERT OR UPDATE ON task_lease
FOR EACH ROW EXECUTE FUNCTION enforce_task_lease_authority();

CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER human_decision_append_only
BEFORE UPDATE OR DELETE ON human_decision
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
