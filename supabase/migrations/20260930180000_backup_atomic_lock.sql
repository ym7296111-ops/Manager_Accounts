-- Atomic, idempotent job claim for the cloud backup worker.
--
-- Builds on 20260930170000_backup_system_schema.sql, which only *records* backup
-- requests. The trusted worker (.github/workflows/database-backup-worker.yml) needs
-- two more things to execute them safely:
--
--   1. Execution telemetry on public.backup_logs
--        started_at                stamped by the claim below
--        finished_at               stamped by a trigger when a job reaches completed/failed
--        artifact_size_bytes       size of the stored .sql.gz
--        artifact_checksum_sha256  SHA-256 of the stored .sql.gz (integrity fingerprint)
--
--   2. public.admin_claim_next_backup_job()
--        A SECURITY DEFINER RPC that atomically moves the oldest `queued` request to
--        `running` and hands its identity to the worker. It is the ONLY sanctioned way
--        for a job to enter `running`.
--
-- Caller model ("admin via GitHub"): the worker runs inside GitHub Actions, bound to
-- the protected `production` environment, and calls this RPC through the Supabase API
-- with the project's service key (legacy `service_role` JWT or `sb_secret_*` key).
-- Both resolve to the Postgres role `service_role`, so that role is the administrator
-- identity this RPC recognises. Human users (anon / authenticated) can never claim a
-- job: a browser-triggered claim would leave a `running` row with no worker behind it.
--
-- Return contract (jsonb):
--   {"id": "<uuid>", "backup_type": "manual" | "automatic"}   a job was claimed
--   null                                                     nothing to do
--
-- `null` is returned both when nothing is queued and while another job is `running`,
-- so calling the RPC repeatedly (retries, overlapping schedules, the DST-repeated
-- 02:00 hour) can never hand the same work to two workers (idempotent lock).
--
-- Errors: 42501 (insufficient_privilege) when the caller is not the service role.

-- ---------------------------------------------------------------------------
-- 1) Execution telemetry on backup_logs
-- ---------------------------------------------------------------------------
-- Table-level grants from the previous migration (select for authenticated, select/
-- insert/update for service_role) automatically cover the new columns.
alter table public.backup_logs
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists artifact_size_bytes bigint,
  add column if not exists artifact_checksum_sha256 text;

alter table public.backup_logs
  add constraint backup_artifact_size_positive
    check (artifact_size_bytes is null or artifact_size_bytes > 0),
  add constraint backup_artifact_checksum_format
    check (artifact_checksum_sha256 is null or artifact_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  -- A completed backup must be verifiable. NOT VALID keeps this migration safe on
  -- databases that already hold hand-edited rows: the rule is enforced for every new or
  -- updated row without rescanning (or rejecting) history, so a legacy completed row
  -- must carry a size and checksum the next time it is updated.
  add constraint backup_completed_has_integrity
    check (status <> 'completed' or (artifact_size_bytes is not null and artifact_checksum_sha256 is not null))
    not valid;

comment on column public.backup_logs.started_at is
  'Set by admin_claim_next_backup_job() when the worker takes the job (queued -> running).';
comment on column public.backup_logs.finished_at is
  'Stamped by the database (backup_logs_stamp_finished) when the job reaches completed or failed.';
comment on column public.backup_logs.artifact_size_bytes is
  'Size in bytes of the gzip-compressed SQL export stored at artifact_path.';
comment on column public.backup_logs.artifact_checksum_sha256 is
  'Lower-case hex SHA-256 of the stored artifact; verify it before any restore.';

-- The database clock owns every lifecycle timestamp: started_at is stamped by the claim
-- RPC and finished_at here, so the worker never sends a time of its own and runner clock
-- skew can never produce a job that finishes before it starts.
create or replace function public.backup_logs_stamp_finished()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('completed', 'failed') and new.status is distinct from old.status then
    new.finished_at := coalesce(new.finished_at, now());
  end if;
  return new;
end;
$$;

revoke execute on function public.backup_logs_stamp_finished() from public, anon, authenticated;

create trigger backup_logs_stamp_finished
  before update of status on public.backup_logs
  for each row execute function public.backup_logs_stamp_finished();

-- ---------------------------------------------------------------------------
-- 2) Atomic claim RPC
-- ---------------------------------------------------------------------------
create or replace function public.admin_claim_next_backup_job()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- An abandoned lease is recovered only after this long. It MUST stay greater than
  -- the worker workflow's job timeout (75 minutes) so a live run can never be reaped.
  c_lease_timeout constant interval := interval '2 hours';
  v_id uuid;
  v_type text;
begin
  -- (1) Caller gate. Inside a SECURITY DEFINER function current_user is the owner,
  --     but the `role` setting still holds the role PostgREST switched to after
  --     verifying the API key, so it identifies the real caller for legacy JWT keys
  --     and for opaque sb_secret_* keys alike. EXECUTE is additionally restricted to
  --     service_role below; this check keeps the function closed even if a blanket
  --     GRANT or a default privilege ever re-opens it to other roles.
  if current_setting('role', true) is distinct from 'service_role' then
    raise exception 'backup worker forbidden' using errcode = '42501';
  end if;

  -- (2) Serialise with every other claim and with admin_trigger_manual_backup(),
  --     which takes the same gate. The "no other job is running" rule below spans
  --     rows, which row locks alone cannot protect.
  perform pg_advisory_xact_lock(hashtextextended('backup_request_gate', 0));

  -- (3) Recover an abandoned lease. A hard-killed runner can never report back, and a
  --     `running` row blocks every future request (unique active-request index and the
  --     lock below), so a job that outlived any possible run is failed explicitly.
  update public.backup_logs
     set status = 'failed',
         error_summary = 'Backup worker lease expired: the run never reported a result.'
   where status = 'running'
     and coalesce(started_at, requested_at) < now() - c_lease_timeout;

  -- (4) Idempotent lock: while a job is running, nobody else may start one.
  if exists (select 1 from public.backup_logs where status = 'running') then
    return null;
  end if;

  -- (5) Atomic claim of the oldest queued request. SKIP LOCKED plus the status
  --     re-check make the statement safe even if the gate above were ever removed.
  update public.backup_logs as b
     set status = 'running',
         started_at = now()
   where b.id = (
           select q.id
             from public.backup_logs as q
            where q.status = 'queued'
            order by q.requested_at, q.id
            limit 1
              for update skip locked
         )
     and b.status = 'queued'
  returning b.id, b.backup_type into v_id, v_type;

  if not found then
    return null;
  end if;

  return jsonb_build_object('id', v_id, 'backup_type', v_type);
end;
$$;

comment on function public.admin_claim_next_backup_job() is
  'Backup worker only (service_role). Atomically moves the oldest queued backup_logs row to running, stamps started_at and returns {id, backup_type}; returns NULL when nothing is queued or another job is still running.';

-- New functions inherit EXECUTE for anon/authenticated from the platform's default
-- privileges, so the revoke must be explicit.
revoke all on function public.admin_claim_next_backup_job() from public, anon, authenticated;
grant execute on function public.admin_claim_next_backup_job() to service_role;
