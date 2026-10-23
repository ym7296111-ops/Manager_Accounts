-- Notification carriers & secrets (Phase 1 of the Notifications / SMTP screen).
--
-- Source of truth: docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md
--   * §1.2.1  public.notification_transports — typed carrier row(s), never a KV jsonb blob.
--   * §1.3    public.notification_transport_secrets — ciphertext-only store, ZERO RLS policies.
--   * §1.5    Path A = pgsodium (+vault) inside the database; Path B = envelope encryption
--             outside the database. This migration detects the environment and never fails
--             because an extension is missing.
--   * §1.6    C1..C12 contract (no secrets in KV, no jsonb secrets, one enabled default,
--             no client decrypt path, value-free errors and audit metadata).
--   * §3.2    Policy matrix: zero write policies; `authenticated` reaches the data through
--             SECURITY DEFINER RPCs only; `service_role` owns the secrets table.
--   * §3.4    Error contract. The study labels are MAIL01..MAIL04 / SEC01; PostgreSQL
--             SQLSTATE is exactly five characters, so MAIL01 is raised as SQLSTATE 'MAIL1'
--             (TPL01..TPL05 and SEC01 are already five characters).
--   * §3.5    Audit values are appended at the tail of public.audit_action.
--
-- Amendment (approved review): the carrier table keeps the study's `config jsonb`
-- expansion slot (§1.2.1), but it is fenced by an immutable whitelist validator:
--   * the operational knobs the study listed there (quota, throttle, timeout, retry
--     policy, max recipients) are typed columns instead — one source of truth;
--   * `config` accepts {headers} today, refuses unknown keys, and refuses
--     credential-shaped values (C2/C10);
--   * future expansion = extend the whitelist in a new migration + mirror check.
--
-- Deliberate Path B note: if pgsodium/vault are not usable, the migration still succeeds and
-- registers an `external` key. In that mode the database never encrypts: the sending worker
-- (Phase 3) stores ciphertext through admin_store_email_secret(), and the in-database password
-- RPC answers MAIL03 (no details) instead of pretending to work.
--
-- pgcrypto schema (CI finding): Supabase installs pgcrypto into the dedicated `extensions`
-- schema, which is deliberately NOT on the migration search_path — an unqualified `digest()`
-- therefore fails with `42883 function digest(text, unknown) does not exist` while the local
-- offline fixture (bare PostgreSQL, pgcrypto in `public`) hides the bug. Every pgcrypto call
-- in these migrations is schema-qualified as `extensions.<fn>` (the Supabase convention), and
-- the offline fixture preinstalls pgcrypto into `extensions` so it mirrors the platform.
--
-- Roles that may call what:
--   authenticated + settings.manage : can_manage_email_transport, admin_get_email_transport,
--                                     admin_update_email_transport, admin_set_email_password,
--                                     admin_clear_email_password
--   service_role only               : admin_store_email_secret (Path B write path)

-- ---------------------------------------------------------------------------
-- 1) Audit enum values (tail only — the study's D9 decision)
-- ---------------------------------------------------------------------------
-- PostgreSQL 12+ allows ADD VALUE inside a transaction. The values are only
-- referenced at RPC runtime, never by a statement of this migration.
alter type public.audit_action add value if not exists 'email.transport_updated';
alter type public.audit_action add value if not exists 'email.credentials_rotated';

-- ---------------------------------------------------------------------------
-- 2) Key registry — typed, non-secret metadata about where the DEK lives
-- ----------------------------------------------------------------------------- The registry exists so public.notification_transport_secrets can reference a
-- stable local id instead of assuming the `vault` schema is present (Path B has
-- no vault at all). vault_secret_id intentionally has NO foreign key: it points
-- at vault.secrets(id) when key_source='vault', and the vault schema may not
-- exist in every environment.
create table if not exists public.notification_encryption_keys (
  id uuid primary key default gen_random_uuid(),
  key_version integer not null unique check (key_version >= 1),
  key_source text not null check (key_source in ('vault', 'external')),
  vault_secret_id uuid,
  kms_key_id text
    check (
      kms_key_id is null
      or (char_length(kms_key_id) between 1 and 200 and kms_key_id !~ '[[:cntrl:]]')
    ),
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  rotated_at timestamptz,
  constraint notification_encryption_keys_source_matches_material check (
    (key_source = 'vault' and vault_secret_id is not null and kms_key_id is null)
    or (key_source = 'external' and vault_secret_id is null)
  )
);

create unique index if not exists notification_encryption_keys_current_idx
  on public.notification_encryption_keys (is_current)
  where is_current;

comment on table public.notification_encryption_keys is
  'Non-secret registry of notification transport DEKs. Material lives in vault (Path A) or outside the database entirely (Path B); this table only records which key version a ciphertext was produced with.';
comment on column public.notification_encryption_keys.vault_secret_id is
  'vault.secrets(id) when key_source=vault. No FK on purpose: the vault schema is optional (Path B).';
comment on column public.notification_encryption_keys.kms_key_id is
  'External key reference (KMS ARN or MAIL_MASTER_KEY_VERSION label). Never key material.';

alter table public.notification_encryption_keys enable row level security;
alter table public.notification_encryption_keys force row level security;

-- Zero policies: no API role reads this table directly (service_role bypasses
-- RLS for the future worker; `authenticated` only sees key_version through the
-- masked snapshot RPC).
revoke all on table public.notification_encryption_keys
  from public, anon, authenticated, service_role;
grant select on table public.notification_encryption_keys to service_role;

-- ---------------------------------------------------------------------------
-- 2b) Carrier config validator (study §1.2.1 `config jsonb` slot + C10)
-- ---------------------------------------------------------------------------
-- The `config jsonb` column is an expansion slot for NON-SECRET provider knobs
-- only. Every operational knob the study listed is already a typed column, so
-- duplicating them here is refused: two sources of truth for a quota is a bug.
--
-- Whitelist today: { headers }
--   headers : object, <= 16 entries, header-name pattern, value <= 512 chars,
--             no CR/LF, no credential-ish pattern, no long base64/hex blob.
--
-- To extend: add the key here + a migration + a matching audit-mirror check.
-- Nothing else may be stored in this column (study C10: "no secrets in jsonb").
create or replace function public.notification_transport_config_is_valid(p_config jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_allowed_keys constant text[] := array['headers'];
  v_forbidden_headers constant text[] := array[
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-smtp-password',
    'x-amz-security-token', 'x-goog-api-key', 'smtp-password', 'password'
  ];
  v_key text;
  v_group jsonb;
  v_header text;
  v_value jsonb;
  v_text text;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    return false;
  end if;

  -- (1) Whitelist: any key outside the documented set invalidates the row.
  if exists (
    select 1
      from jsonb_object_keys(p_config) as k
     where k <> all (v_allowed_keys)
  ) then
    return false;
  end if;

  -- (2) `headers` — the only accepted group.
  if p_config ? 'headers' then
    v_group := p_config -> 'headers';
    if v_group is null or jsonb_typeof(v_group) <> 'object' then
      return false;
    end if;
    if (select count(*) from jsonb_object_keys(v_group)) > 16 then
      return false;
    end if;

    for v_header, v_value in select key, value from jsonb_each(v_group) loop
      if v_header !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$' then
        return false;
      end if;
      if lower(v_header) = any (v_forbidden_headers) then
        return false;
      end if;
      if jsonb_typeof(v_value) <> 'string' then
        return false;
      end if;

      v_text := v_value #>> '{}';
      -- Length cap + no header injection (CR/LF) + no control characters.
      if char_length(v_text) < 1
         or char_length(v_text) > 512
         or v_text ~ '[[:cntrl:]]' then
        return false;
      end if;
      -- Suspicious credential shapes: names, schemes, PEM blocks, long blobs.
      if v_text ~* '(password|passwd|secret|token|api[_-]?key|bearer[[:space:]]|basic[[:space:]]|private[_-]?key)'
         or v_text ~ '^-----BEGIN'
         or v_text ~ '^[A-Za-z0-9+/]{40,}={0,2}$'
         or v_text ~ '^[0-9a-fA-F]{40,}$' then
        return false;
      end if;
    end loop;
  end if;

  return true;
end;
$$;

revoke all on function public.notification_transport_config_is_valid(jsonb)
  from public, anon, authenticated;
-- service_role needs EXECUTE even though it never calls it directly: a CHECK
-- constraint runs with the privileges of the writing role, and the worker owns
-- its own writes (the alternative is a constraint that fails with 42501 instead
-- of explaining the real problem).
grant execute on function public.notification_transport_config_is_valid(jsonb)
  to service_role;

comment on function public.notification_transport_config_is_valid(jsonb) is
  'Whitelist + anti-secret validator for notification_transports.config (study C10). Immutable so it can back a CHECK constraint.';

-- ---------------------------------------------------------------------------
-- 3) Carriers — typed columns + one guarded, non-secret jsonb expansion slot
-- ---------------------------------------------------------------------------
create table if not exists public.notification_transports (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z][a-z0-9_-]{1,40}$'),
  -- Open textual catalogue (study: no closed enum, one migration per provider must never
  -- be required). Behaviour is keyed by the sender adapter, not by the provider name.
  provider_type text not null default 'smtp_generic'
    check (provider_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  host text not null
    check (host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'),
  port integer not null default 587
    check (port between 1 and 65535),
  -- Username is deliberately NOT a secret (study D4): it is shown to the manager and is not
  -- displayed in any provider error path. The password is the only secret.
  username text
    check (
      username is null
      or (char_length(username) between 1 and 320 and username !~ '[[:cntrl:]]')
    ),
  sender_email text not null
    check (sender_email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'),
  sender_name text not null
    check (char_length(btrim(sender_name)) between 2 and 80 and sender_name !~ '[[:cntrl:]]'),
  reply_to_email text
    check (
      reply_to_email is null
      or reply_to_email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
    ),
  tls_mode text not null default 'starttls'
    check (tls_mode in ('starttls', 'implicit_tls', 'none')),
  auth_mode text not null default 'login'
    check (auth_mode in ('login', 'plain', 'xoauth2', 'none')),
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  -- Typed columns: the operational knobs the study listed (no dual source).
  max_recipients_per_message integer not null default 50
    check (max_recipients_per_message between 1 and 1000),
  daily_quota integer not null default 200
    check (daily_quota between 1 and 100000),
  throttle_per_minute integer not null default 30
    check (throttle_per_minute between 1 and 10000),
  timeout_ms integer not null default 10000
    check (timeout_ms between 1000 and 120000),
  retry_max_attempts integer not null default 3
    check (retry_max_attempts between 0 and 10),
  retry_backoff_ms integer not null default 5000
    check (retry_backoff_ms between 0 and 3600000),
  -- The study's per-provider expansion slot (§1.2.1) — NON-SECRET only.
  -- Guarded by three CHECKs: object shape, size cap, and a whitelist validator
  -- that also refuses credential-shaped values (study C2/C10).
  config jsonb not null default '{}'::jsonb,
  constraint notification_transports_config_object
    check (jsonb_typeof(config) = 'object'),
  constraint notification_transports_config_size
    check (octet_length(config::text) <= 4096),
  constraint notification_transports_config_whitelist
    check (public.notification_transport_config_is_valid(config)),
  last_test_status text
    check (last_test_status is null or last_test_status in ('ok', 'failed')),
  last_test_at timestamptz,
  -- Error CLASS only (never raw provider text, which can leak identifiers).
  last_test_detail text
    check (
      last_test_detail is null
      or (char_length(last_test_detail) <= 200 and last_test_detail !~ '[[:cntrl:]]')
    ),
  -- Rotation counter for the secret row; never decreases, never reset by "clear".
  secrets_version integer not null default 0 check (secrets_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null
);

-- Safety net for environments where the pre-amendment version of this file had
-- already been applied: the column and its three guards are added idempotently,
-- so an upgrade is as safe as a fresh `db reset`.
alter table public.notification_transports
  add column if not exists config jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notification_transports_config_object'
  ) then
    alter table public.notification_transports
      add constraint notification_transports_config_object
      check (jsonb_typeof(config) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'notification_transports_config_size'
  ) then
    alter table public.notification_transports
      add constraint notification_transports_config_size
      check (octet_length(config::text) <= 4096);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'notification_transports_config_whitelist'
  ) then
    alter table public.notification_transports
      add constraint notification_transports_config_whitelist
      check (public.notification_transport_config_is_valid(config));
  end if;
end;
$$;

-- At most ONE enabled default carrier for transactional mail (study C3). This
-- is the index half of the guarantee; guard_notification_transport_writes()
-- adds the transactional half because a partial index alone cannot explain
-- itself to the manager with a stable error code.
create unique index if not exists notification_transports_one_enabled_default_idx
  on public.notification_transports (is_default)
  where is_default and is_enabled;

create index if not exists notification_transports_enabled_idx
  on public.notification_transports (is_enabled)
  where is_enabled;

drop trigger if exists notification_transports_set_updated_at on public.notification_transports;
create trigger notification_transports_set_updated_at
  before update on public.notification_transports
  for each row execute function public.set_updated_at();

comment on table public.notification_transports is
  'Typed SMTP/HTTPS carrier configuration (Phase 1). Credentials live in public.notification_transport_secrets; `config` is a whitelisted, NON-SECRET provider expansion slot; writes go through SECURITY DEFINER RPCs only.';
comment on column public.notification_transports.config is
  'NON-SECRET per-provider expansion slot (study §1.2.1). Whitelist today: {headers}. Backed by three CHECKs: object shape, <= 4096 bytes, and notification_transport_config_is_valid() which refuses unknown keys plus credential-shaped values (C10). Never credentials: those belong to notification_transport_secrets.';
comment on column public.notification_transports.is_default is
  'Marks the transactional default. At most one row may be (is_default AND is_enabled); enforced by a partial unique index plus a guard trigger.';
comment on column public.notification_transports.tls_mode is
  'starttls | implicit_tls | none. none is for local development only; production boot-checks reject it (study C4).';
comment on column public.notification_transports.secrets_version is
  'Optimistic-lock counter for the credential row. Bumped by the credential RPCs only; never decreased. Typed operational columns are the source of truth; config never duplicates them.';

alter table public.notification_transports enable row level security;
alter table public.notification_transports force row level security;

-- Zero policies: the masked snapshot RPC is the only read path for API roles
-- (study §3.2 and P4/P9 — the absence of a policy IS the refusal).
revoke all on table public.notification_transports
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.notification_transports to service_role;

-- ---------------------------------------------------------------------------
-- 4) Secrets — ciphertext only, ZERO policies of any kind
-- ---------------------------------------------------------------------------
create table if not exists public.notification_transport_secrets (
  transport_id uuid primary key
    references public.notification_transports (id) on delete cascade,
  -- The type check is a real guard: if a future migration ever tries to widen
  -- this column (jsonb/text), existing rows make the change impossible.
  secret_ciphertext bytea not null
    check (pg_typeof(secret_ciphertext) = 'bytea'::regtype and octet_length(secret_ciphertext) >= 16),
  wrapped_key bytea,
  kms_key_id text
    check (
      kms_key_id is null
      or (char_length(kms_key_id) between 1 and 200 and kms_key_id !~ '[[:cntrl:]]')
    ),
  key_id uuid references public.notification_encryption_keys (id),
  cipher text not null
    check (cipher in ('xsalsa20-poly1305', 'aes-256-gcm', 'chacha20-poly1305')),
  nonce bytea not null check (octet_length(nonce) between 12 and 24),
  tag bytea check (tag is null or octet_length(tag) between 12 and 16),
  -- sha256 of the plaintext for comparison only ("did the secret really change?").
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  encoding text not null default 'utf8-bytes' check (encoding = 'utf8-bytes'),
  secrets_version integer not null check (secrets_version >= 1),
  rotate_by timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  -- Exactly one provenance: a vault-registered key (Path A) or an external
  -- key reference (Path B). A row with no provenance is a developer mistake.
  constraint notification_transport_secrets_key_provenance check (
    (key_id is not null and kms_key_id is null)
    or (key_id is null and kms_key_id is not null)
  )
);

drop trigger if exists notification_transport_secrets_set_updated_at
  on public.notification_transport_secrets;
create trigger notification_transport_secrets_set_updated_at
  before update on public.notification_transport_secrets
  for each row execute function public.set_updated_at();

comment on table public.notification_transport_secrets is
  'CipherSuite-only store for carrier credentials. NO RLS policies exist by design (study §1.3 / P4): with force-RLS the absence of policies means no API role can read it. Writes happen through SECURITY DEFINER RPCs (authenticated) or admin_store_email_secret (service_role, Path B). Never added to supabase_realtime.';
comment on column public.notification_transport_secrets.secret_ciphertext is
  'AEAD ciphertext only. Never plaintext, never text/jsonb (type-pinned by CHECK). A guard trigger rejects plaintext-shaped payloads.';
comment on column public.notification_transport_secrets.content_fingerprint is
  'sha256 of the plaintext, comparison only. Only the first 8 hex characters are ever shown or audited.';
comment on column public.notification_transport_secrets.key_id is
  'Path A: notification_encryption_keys(id) whose vault secret encrypted this payload.';
comment on column public.notification_transport_secrets.kms_key_id is
  'Path B: external key reference produced by the sending worker. Never key material.';

alter table public.notification_transport_secrets enable row level security;
alter table public.notification_transport_secrets force row level security;

-- The explicit absence of policies on this table is part of the contract.
-- Never add one without amending the design study and the audit mirror.
revoke all on table public.notification_transport_secrets
  from public, anon, authenticated, service_role;
-- service_role gets insert/select/update only: deleting a credential is a
-- deliberate act performed by the sanctioned RPC, not a generic table power.
grant select, insert, update on table public.notification_transport_secrets to service_role;

-- ---------------------------------------------------------------------------
-- 5) Guard triggers
-- ---------------------------------------------------------------------------
-- 5a) Carriers: enabling requires stored credentials; one enabled default;
--     the rotation counter never decreases.
create or replace function public.guard_notification_transport_writes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.is_enabled then
    if not exists (
      select 1
        from public.notification_transport_secrets s
       where s.transport_id = new.id
    ) then
      raise exception 'invalid_field'
        using errcode = '22023',
              detail = 'field: is_enabled',
              hint = 'store credentials before enabling the transport';
    end if;
  end if;

  if new.is_default and new.is_enabled then
    if exists (
      select 1
        from public.notification_transports t
       where t.is_default
         and t.is_enabled
         and t.id <> new.id
    ) then
      raise exception 'invalid_field'
        using errcode = '22023',
              detail = 'field: is_default',
              hint = 'only one enabled default transport is allowed';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.secrets_version < old.secrets_version then
    raise exception 'invalid_field'
      using errcode = '22023',
            detail = 'field: secrets_version',
            hint = 'the rotation counter never decreases';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_notification_transport_writes()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_transports_guard_writes on public.notification_transports;
create trigger notification_transports_guard_writes
  before insert or update on public.notification_transports
  for each row execute function public.guard_notification_transport_writes();

-- 5b) Secrets: structural AEAD checks + a plaintext-shaped payload refusal +
--     "no silent overwrite" (version must increase by exactly one).
create or replace function public.guard_notification_secret_writes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_text text;
  v_printable boolean := false;
begin
  if new.cipher = 'xsalsa20-poly1305' then
    if octet_length(new.nonce) <> 24 then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: nonce',
              hint = 'xsalsa20-poly1305 requires a 24-byte nonce';
    end if;
  else
    if octet_length(new.nonce) <> 12 then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: nonce',
              hint = 'aes-256-gcm and chacha20-poly1305 require a 12-byte nonce';
    end if;
  end if;

  if new.nonce = decode(repeat('00', octet_length(new.nonce)), 'hex') then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: nonce',
            hint = 'an all-zero nonce is never produced by the sanctioned writers';
  end if;

  -- Best-effort structural refusal of "developer stored the password itself".
  -- Random ciphertext is virtually never printable UTF-8; a plaintext secret is.
  begin
    v_text := convert_from(new.secret_ciphertext, 'UTF8');
    v_printable := v_text !~ '[^[:print:][:space:]]';
  exception
    when others then
      v_printable := false; -- not valid UTF-8: looks like ciphertext
  end;

  if v_printable then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: secret_ciphertext',
            hint = 'plaintext-shaped payloads are refused; store AEAD ciphertext only';
  end if;

  if tg_op = 'UPDATE' then
    if new.transport_id <> old.transport_id then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: transport_id';
    end if;
    if new.secrets_version <> old.secrets_version + 1 then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: secrets_version',
              hint = 'credential rotation must bump the version by exactly one';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_notification_secret_writes()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_transport_secrets_guard_writes
  on public.notification_transport_secrets;
create trigger notification_transport_secrets_guard_writes
  before insert or update on public.notification_transport_secrets
  for each row execute function public.guard_notification_secret_writes();

-- 5c) app_settings: reserved secret namespaces are refused (study C1 / MAIL04).
create or replace function public.guard_app_settings_reserved_keys()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.key ~ '^(email|smtp|mail)\.' or new.key ~ '^notifications\.smtp' then
    -- No key name in the message: a reserved namespace attempt must not echo
    -- caller-supplied text back through PostgREST.
    raise exception 'MAIL04: secret_in_kv_rejected'
      using errcode = 'MAIL4',
            hint = 'credentials belong to notification_transport_secrets';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_app_settings_reserved_keys()
  from public, anon, authenticated, service_role;

drop trigger if exists app_settings_guard_reserved_keys on public.app_settings;
create trigger app_settings_guard_reserved_keys
  before insert or update on public.app_settings
  for each row execute function public.guard_app_settings_reserved_keys();

-- Structural backstop, NOT VALID so a client database that already contains a
-- legacy `email.*` key does not block the migration. It still protects every
-- new write, and the trigger above supplies the MAIL04 contract code.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_reserved_secret_namespaces'
  ) then
    alter table public.app_settings
      add constraint app_settings_reserved_secret_namespaces
      check (key !~ '^(email|smtp|mail)\.' and key !~ '^notifications\.smtp')
      not valid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Capability helper (same template as can_manage_app_identity)
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_email_transport()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
     );
$$;

revoke all on function public.can_manage_email_transport() from public, anon;
grant execute on function public.can_manage_email_transport() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) Masked snapshot (internal; never granted to an API role)
-- ---------------------------------------------------------------------------
-- Returns exactly what §1.8 allows: never ciphertext, never the full
-- fingerprint, never a raw nonce. The credential is a write-only field.
create or replace function public.notification_transport_snapshot(p_transport_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'provider_type', t.provider_type,
    'host', t.host,
    'port', t.port,
    'username', t.username,
    'sender_email', t.sender_email,
    'sender_name', t.sender_name,
    'reply_to_email', t.reply_to_email,
    'tls_mode', t.tls_mode,
    'auth_mode', t.auth_mode,
    'is_enabled', t.is_enabled,
    'is_default', t.is_default,
    'max_recipients_per_message', t.max_recipients_per_message,
    'daily_quota', t.daily_quota,
    'throttle_per_minute', t.throttle_per_minute,
    'timeout_ms', t.timeout_ms,
    'retry_max_attempts', t.retry_max_attempts,
    'retry_backoff_ms', t.retry_backoff_ms,
    'config', t.config,
    'last_test_status', t.last_test_status,
    'last_test_at', t.last_test_at,
    'last_test_detail', t.last_test_detail,
    'secrets_version', t.secrets_version,
    'has_password', (s.transport_id is not null),
    'fingerprint', case when s.transport_id is not null
                        then left(s.content_fingerprint, 8) end,
    'key_version', k.key_version,
    'key_source', k.key_source,
    'tls_insecure', (t.tls_mode = 'none'),
    'warnings', to_jsonb(array_remove(array[
      case when t.tls_mode = 'none' then 'tls_disabled'::text end,
      case when t.port = 25 then 'port_25_discouraged'::text end,
      case when t.port = 465 and t.tls_mode <> 'implicit_tls' then 'port_465_expects_implicit_tls'::text end,
      case when t.port = 587 and t.tls_mode <> 'starttls' then 'port_587_expects_starttls'::text end,
      case when t.auth_mode = 'xoauth2' then 'xoauth2_not_supported_yet'::text end,
      case when not t.is_enabled then 'disabled'::text end
    ], null)),
    'created_at', t.created_at,
    'updated_at', t.updated_at
  )
  from public.notification_transports t
  left join public.notification_transport_secrets s on s.transport_id = t.id
  left join public.notification_encryption_keys k on k.id = s.key_id
 where t.id = p_transport_id;
$$;

revoke all on function public.notification_transport_snapshot(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) Read RPC — masked snapshot of the effective carrier
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_email_transport()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.can_manage_email_transport() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  -- Effective carrier: the enabled default first, then any enabled row, then
  -- the oldest configured row. Multi-carrier selection stays a UI concern.
  select t.id
    into v_id
    from public.notification_transports t
   order by (t.is_default and t.is_enabled) desc, t.is_enabled desc, t.created_at asc
   limit 1;

  if v_id is null then
    raise exception 'transport_not_found' using errcode = 'P0002';
  end if;

  return public.notification_transport_snapshot(v_id);
end;
$$;

revoke all on function public.admin_get_email_transport()
  from public, anon, service_role;
grant execute on function public.admin_get_email_transport() to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Write RPC — the ONLY sanctioned carrier writer
-- ---------------------------------------------------------------------------
-- Contract (study §1.8, with typed discrete parameters instead of free jsonb):
--   * NULL means "keep the current value" on update / "use the documented
--     default" on first insert.
--   * Passing an empty string clears a nullable text field (username,
--     reply_to_email).
--   * p_expected_updated_at is the optimistic lock; a mismatch raises MAIL01.
-- Errors: 42501 capability · 22023 invalid value (detail = "field: <name>") ·
--         MAIL1 stale snapshot · MAIL2 structural payload · P0002 not found.
-- Safety net: if the pre-amendment version of this migration had been applied,
-- the old overload (without p_config) is removed so there is exactly one writer.
drop function if exists public.admin_update_email_transport(
  text, text, text, integer, text, text, text, text, text, text, boolean, boolean,
  integer, integer, integer, integer, integer, integer, timestamptz
);

create or replace function public.admin_update_email_transport(
  p_slug text default null,
  p_provider_type text default null,
  p_host text default null,
  p_port integer default null,
  p_username text default null,
  p_sender_email text default null,
  p_sender_name text default null,
  p_reply_to_email text default null,
  p_tls_mode text default null,
  p_auth_mode text default null,
  p_is_enabled boolean default null,
  p_is_default boolean default null,
  p_max_recipients_per_message integer default null,
  p_daily_quota integer default null,
  p_throttle_per_minute integer default null,
  p_timeout_ms integer default null,
  p_retry_max_attempts integer default null,
  p_retry_backoff_ms integer default null,
  p_config jsonb default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_slug text;
  v_provider_type text;
  v_host text;
  v_port integer;
  v_username text;
  v_sender_email text;
  v_sender_name text;
  v_reply_to text;
  v_tls_mode text;
  v_auth_mode text;
  v_is_enabled boolean;
  v_is_default boolean;
  v_max_recipients integer;
  v_daily_quota integer;
  v_throttle integer;
  v_timeout integer;
  v_retry_attempts integer;
  v_retry_backoff integer;
  v_config jsonb;
  v_row public.notification_transports%rowtype;
  v_exists boolean := false;
  v_changed text[] := array[]::text[];
  v_before jsonb;
  v_after jsonb;
  v_host_changed boolean := false;
  v_sender_changed boolean := false;
  v_username_changed boolean := false;
  v_reply_to_changed boolean := false;
  v_config_changed boolean := false;
begin
  if v_actor is null or not public.can_manage_email_transport() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  if p_slug is null or btrim(p_slug) = '' then
    raise exception 'MAIL02: invalid_transport_payload'
      using errcode = 'MAIL2', detail = 'reason: slug_required';
  end if;
  v_slug := btrim(p_slug);
  if v_slug !~ '^[a-z][a-z0-9_-]{1,40}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: slug';
  end if;

  select t.*
    into v_row
    from public.notification_transports t
   where t.slug = v_slug
   for update;
  v_exists := found;

  if not v_exists and p_expected_updated_at is not null then
    raise exception 'MAIL02: invalid_transport_payload'
      using errcode = 'MAIL2', detail = 'reason: transport_not_found';
  end if;

  if v_exists
     and p_expected_updated_at is not null
     and v_row.updated_at <> p_expected_updated_at then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;

  -- ---- validate every field manually, before any constraint can echo a value
  v_provider_type := coalesce(
    nullif(btrim(coalesce(p_provider_type, '')), ''),
    case when v_exists then v_row.provider_type else 'smtp_generic' end
  );
  if v_provider_type !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: provider_type';
  end if;

  v_host := nullif(btrim(coalesce(p_host, v_row.host)), '');
  if v_host is null then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: host';
  end if;
  if v_host !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: host';
  end if;

  v_port := coalesce(p_port, case when v_exists then v_row.port else 587 end);
  if v_port is null or v_port not between 1 and 65535 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: port';
  end if;

  v_tls_mode := coalesce(
    nullif(btrim(coalesce(p_tls_mode, '')), ''),
    case when v_exists then v_row.tls_mode else 'starttls' end
  );
  if v_tls_mode not in ('starttls', 'implicit_tls', 'none') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: tls_mode';
  end if;

  v_auth_mode := coalesce(
    nullif(btrim(coalesce(p_auth_mode, '')), ''),
    case when v_exists then v_row.auth_mode else 'login' end
  );
  if v_auth_mode not in ('login', 'plain', 'xoauth2', 'none') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: auth_mode';
  end if;

  v_sender_email := lower(nullif(btrim(coalesce(p_sender_email, v_row.sender_email)), ''));
  if v_sender_email is null
     or v_sender_email !~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
     or char_length(v_sender_email) > 320 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: sender_email';
  end if;

  v_sender_name := nullif(btrim(coalesce(p_sender_name, v_row.sender_name)), '');
  if v_sender_name is null
     or char_length(v_sender_name) not between 2 and 80
     or v_sender_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: sender_name';
  end if;

  -- Empty string clears the nullable fields; NULL keeps the current value.
  if p_reply_to_email is not null and btrim(p_reply_to_email) = '' then
    v_reply_to := null;
  else
    v_reply_to := lower(nullif(btrim(coalesce(p_reply_to_email, v_row.reply_to_email)), ''));
  end if;
  if v_reply_to is not null
     and (v_reply_to !~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$'
          or char_length(v_reply_to) > 320) then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: reply_to_email';
  end if;

  if p_username is not null and btrim(p_username) = '' then
    v_username := null;
  else
    v_username := nullif(btrim(coalesce(p_username, v_row.username)), '');
  end if;
  if v_username is not null
     and (char_length(v_username) > 320 or v_username ~ '[[:cntrl:]]') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: username';
  end if;

  v_is_enabled := coalesce(p_is_enabled, case when v_exists then v_row.is_enabled else false end);
  -- A newly created carrier is never the default unless the caller says so;
  -- the seeded `default-smtp` row is the documented starting default.
  v_is_default := coalesce(p_is_default, case when v_exists then v_row.is_default else false end);

  v_max_recipients := coalesce(
    p_max_recipients_per_message,
    case when v_exists then v_row.max_recipients_per_message else 50 end
  );
  if v_max_recipients not between 1 and 1000 then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: max_recipients_per_message';
  end if;

  v_daily_quota := coalesce(p_daily_quota, case when v_exists then v_row.daily_quota else 200 end);
  if v_daily_quota not between 1 and 100000 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: daily_quota';
  end if;

  v_throttle := coalesce(
    p_throttle_per_minute,
    case when v_exists then v_row.throttle_per_minute else 30 end
  );
  if v_throttle not between 1 and 10000 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: throttle_per_minute';
  end if;

  v_timeout := coalesce(p_timeout_ms, case when v_exists then v_row.timeout_ms else 10000 end);
  if v_timeout not between 1000 and 120000 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: timeout_ms';
  end if;

  v_retry_attempts := coalesce(
    p_retry_max_attempts,
    case when v_exists then v_row.retry_max_attempts else 3 end
  );
  if v_retry_attempts not between 0 and 10 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: retry_max_attempts';
  end if;

  v_retry_backoff := coalesce(
    p_retry_backoff_ms,
    case when v_exists then v_row.retry_backoff_ms else 5000 end
  );
  if v_retry_backoff not between 0 and 3600000 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: retry_backoff_ms';
  end if;

  -- config: NULL keeps the current value, {} clears it, an object replaces it.
  -- Whitelist + anti-secret checks happen BEFORE any write so the error carries
  -- a field name only, never a value (study C10 / §3.4).
  if p_config is null then
    v_config := case when v_exists then v_row.config else '{}'::jsonb end;
  else
    if jsonb_typeof(p_config) <> 'object' then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: config', hint = 'config must be a json object';
    end if;
    if octet_length(p_config::text) > 4096 then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: config', hint = 'config is too large';
    end if;
    if not public.notification_transport_config_is_valid(p_config) then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: config',
              hint = 'whitelist: headers; unknown keys and credential-shaped values are refused';
    end if;
    v_config := p_config;
  end if;

  -- Enabling without stored credentials is refused here with a stable code,
  -- and again by the guard trigger as the transactional backstop.
  if v_is_enabled and not exists (
    select 1
      from public.notification_transport_secrets s
      join public.notification_transports t on t.id = s.transport_id
     where t.slug = v_slug
  ) then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: is_enabled',
            hint = 'store credentials before enabling the transport';
  end if;

  if v_exists then
    v_host_changed := v_host is distinct from v_row.host;
    v_sender_changed :=
      v_sender_email is distinct from v_row.sender_email
      or v_sender_name is distinct from v_row.sender_name
      or v_reply_to is distinct from v_row.reply_to_email;
    v_username_changed := v_username is distinct from v_row.username;
    v_reply_to_changed := v_reply_to is distinct from v_row.reply_to_email;
    v_config_changed := v_config is distinct from v_row.config;
  else
    v_host_changed := true;
    v_sender_changed := true;
    v_username_changed := true;
    v_reply_to_changed := true;
    v_config_changed := true;
  end if;

  if v_exists then
    if v_provider_type is distinct from v_row.provider_type then v_changed := array_append(v_changed, 'provider_type'); end if;
    if v_host is distinct from v_row.host then v_changed := array_append(v_changed, 'host'); end if;
    if v_port is distinct from v_row.port then v_changed := array_append(v_changed, 'port'); end if;
    if v_username is distinct from v_row.username then v_changed := array_append(v_changed, 'username'); end if;
    if v_sender_email is distinct from v_row.sender_email then v_changed := array_append(v_changed, 'sender_email'); end if;
    if v_sender_name is distinct from v_row.sender_name then v_changed := array_append(v_changed, 'sender_name'); end if;
    if v_reply_to is distinct from v_row.reply_to_email then v_changed := array_append(v_changed, 'reply_to_email'); end if;
    if v_tls_mode is distinct from v_row.tls_mode then v_changed := array_append(v_changed, 'tls_mode'); end if;
    if v_auth_mode is distinct from v_row.auth_mode then v_changed := array_append(v_changed, 'auth_mode'); end if;
    if v_is_enabled is distinct from v_row.is_enabled then v_changed := array_append(v_changed, 'is_enabled'); end if;
    if v_is_default is distinct from v_row.is_default then v_changed := array_append(v_changed, 'is_default'); end if;
    if v_max_recipients is distinct from v_row.max_recipients_per_message then
      v_changed := array_append(v_changed, 'max_recipients_per_message');
    end if;
    if v_daily_quota is distinct from v_row.daily_quota then v_changed := array_append(v_changed, 'daily_quota'); end if;
    if v_throttle is distinct from v_row.throttle_per_minute then v_changed := array_append(v_changed, 'throttle_per_minute'); end if;
    if v_timeout is distinct from v_row.timeout_ms then v_changed := array_append(v_changed, 'timeout_ms'); end if;
    if v_retry_attempts is distinct from v_row.retry_max_attempts then
      v_changed := array_append(v_changed, 'retry_max_attempts');
    end if;
    if v_retry_backoff is distinct from v_row.retry_backoff_ms then
      v_changed := array_append(v_changed, 'retry_backoff_ms');
    end if;
    if v_config is distinct from v_row.config then v_changed := array_append(v_changed, 'config'); end if;

    -- Identical re-write is a no-op: no UPDATE, no audit row.
    if cardinality(v_changed) = 0 then
      return public.notification_transport_snapshot(v_row.id);
    end if;

    -- Captured BEFORE the UPDATE so the audit trail holds a real diff.
    v_before := jsonb_build_object(
      'provider_type', v_row.provider_type,
      'port', v_row.port,
      'tls_mode', v_row.tls_mode,
      'auth_mode', v_row.auth_mode,
      'is_enabled', v_row.is_enabled,
      'is_default', v_row.is_default,
      'max_recipients_per_message', v_row.max_recipients_per_message,
      'daily_quota', v_row.daily_quota,
      'throttle_per_minute', v_row.throttle_per_minute,
      'timeout_ms', v_row.timeout_ms,
      'retry_max_attempts', v_row.retry_max_attempts,
      'retry_backoff_ms', v_row.retry_backoff_ms,
      'config_keys', to_jsonb(coalesce(
        (select array_agg(k order by k) from jsonb_object_keys(v_row.config) as k), '{}'::text[]
      ))
    );

    update public.notification_transports
       set provider_type = v_provider_type,
           host = v_host,
           port = v_port,
           username = v_username,
           sender_email = v_sender_email,
           sender_name = v_sender_name,
           reply_to_email = v_reply_to,
           tls_mode = v_tls_mode,
           auth_mode = v_auth_mode,
           is_enabled = v_is_enabled,
           is_default = v_is_default,
           max_recipients_per_message = v_max_recipients,
           daily_quota = v_daily_quota,
           throttle_per_minute = v_throttle,
           timeout_ms = v_timeout,
           retry_max_attempts = v_retry_attempts,
           retry_backoff_ms = v_retry_backoff,
           config = v_config,
           updated_by = v_actor
     where id = v_row.id
    returning * into v_row;
  else
    insert into public.notification_transports (
      slug, provider_type, host, port, username,
      sender_email, sender_name, reply_to_email,
      tls_mode, auth_mode, is_enabled, is_default,
      max_recipients_per_message, daily_quota, throttle_per_minute,
      timeout_ms, retry_max_attempts, retry_backoff_ms, config,
      created_by, updated_by
    )
    values (
      v_slug, v_provider_type, v_host, v_port, v_username,
      v_sender_email, v_sender_name, v_reply_to,
      v_tls_mode, v_auth_mode, v_is_enabled, v_is_default,
      v_max_recipients, v_daily_quota, v_throttle,
      v_timeout, v_retry_attempts, v_retry_backoff, v_config,
      v_actor, v_actor
    )
    returning * into v_row;

    v_changed := array['created'];
    v_before := null;
  end if;

  -- Masked before/after: operational scalars and booleans only. Host, username
  -- and e-mail addresses never enter the audit trail (study C8).
  v_after := jsonb_build_object(
    'provider_type', v_row.provider_type,
    'port', v_row.port,
    'tls_mode', v_row.tls_mode,
    'auth_mode', v_row.auth_mode,
    'is_enabled', v_row.is_enabled,
    'is_default', v_row.is_default,
    'max_recipients_per_message', v_row.max_recipients_per_message,
    'daily_quota', v_row.daily_quota,
    'throttle_per_minute', v_row.throttle_per_minute,
    'timeout_ms', v_row.timeout_ms,
    'retry_max_attempts', v_row.retry_max_attempts,
    'retry_backoff_ms', v_row.retry_backoff_ms,
    'config_keys', to_jsonb(coalesce(
      (select array_agg(k order by k) from jsonb_object_keys(v_row.config) as k), '{}'::text[]
    ))
  );

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'email.transport_updated'::public.audit_action,
    'notification_transports',
    v_row.id::text,
    jsonb_build_object(
      'transition', case when v_exists then 'updated' else 'created' end,
      'changed_fields', to_jsonb(v_changed),
      'before', v_before,
      'after', v_after,
      'secrets_version', v_row.secrets_version,
      'host_changed', v_host_changed,
      'sender_changed', v_sender_changed,
      'username_changed', v_username_changed,
      'reply_to_changed', v_reply_to_changed,
      'config_changed', v_config_changed
    )
  );

  return public.notification_transport_snapshot(v_row.id);
exception
  when others then
    -- Deliberate, value-free errors are re-raised untouched. Anything else is
    -- sanitized: PostgreSQL constraint messages can echo entire rows, which
    -- must never reach PostgREST (study §3.4).
    if sqlstate in ('42501', '22023', 'MAIL1', 'MAIL2', 'MAIL3', 'MAIL4', 'SEC01', 'P0002') then
      raise;
    end if;
    raise exception 'email_config_update_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_update_email_transport(
  text, text, text, integer, text, text, text, text, text, text, boolean, boolean,
  integer, integer, integer, integer, integer, integer, jsonb, timestamptz
) from public, anon, service_role;
grant execute on function public.admin_update_email_transport(
  text, text, text, integer, text, text, text, text, text, text, boolean, boolean,
  integer, integer, integer, integer, integer, integer, jsonb, timestamptz
) to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Credential RPCs
-- ---------------------------------------------------------------------------
-- 10a) Path A: encrypt in-database with the current vault DEK.
--      Never returns plaintext, never logs a value; MAIL03 when the key
--      material or the pgsodium/vault privileges are not available.
create or replace function public.admin_set_email_password(
  p_new_password text,
  p_expected_secrets_version integer default null,
  p_expected_updated_at timestamptz default null,
  p_transport_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.notification_transports%rowtype;
  v_key public.notification_encryption_keys%rowtype;
  v_secret public.notification_transport_secrets%rowtype;
  v_wrapped text;
  v_key_bytes bytea;
  v_nonce bytea;
  v_ciphertext bytea;
  v_fingerprint text;
  v_slug text;
  v_previous_fingerprint text;
begin
  if v_actor is null or not public.can_manage_email_transport() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  if p_new_password is null
     or char_length(p_new_password) not between 1 and 1024
     or p_new_password ~ '[[:cntrl:]]' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: new_password';
  end if;

  v_slug := nullif(btrim(coalesce(p_transport_slug, '')), '');
  select t.*
    into v_row
    from public.notification_transports t
   where (v_slug is null and t.id = (
            select t2.id
              from public.notification_transports t2
             order by (t2.is_default and t2.is_enabled) desc, t2.is_enabled desc, t2.created_at asc
             limit 1
          ))
      or (v_slug is not null and t.slug = v_slug)
   for update;

  if not found then
    raise exception 'transport_not_found' using errcode = 'P0002';
  end if;

  if p_expected_secrets_version is not null
     and v_row.secrets_version <> p_expected_secrets_version then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;
  if p_expected_updated_at is not null and v_row.updated_at <> p_expected_updated_at then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;

  -- Path A readiness: extension, privileges on the crypto function, vault view.
  if to_regprocedure('pgsodium.crypto_secretbox(bytea, bytea, bytea)') is null
     or not has_function_privilege(
              current_user, 'pgsodium.crypto_secretbox(bytea, bytea, bytea)', 'execute')
     or to_regclass('vault.decrypted_secrets') is null
     or not has_table_privilege(current_user, 'vault.decrypted_secrets', 'select') then
    raise exception 'MAIL03: encryption_material_unavailable' using errcode = 'MAIL3';
  end if;

  select k.*
    into v_key
    from public.notification_encryption_keys k
   where k.is_current;
  if not found or v_key.key_source <> 'vault' or v_key.vault_secret_id is null then
    raise exception 'MAIL03: encryption_material_unavailable' using errcode = 'MAIL3';
  end if;

  -- Dynamic SQL on purpose: the vault schema may not exist at all (Path B).
  -- A static reference would make this function fail static analysis (and the
  -- CI `supabase db lint` gate) in environments without the extension, so the
  -- object is resolved at runtime, after the readiness checks above.
  execute 'select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = $1'
     into v_wrapped
    using v_key.vault_secret_id;
  if v_wrapped is null then
    raise exception 'MAIL03: encryption_material_unavailable' using errcode = 'MAIL3';
  end if;

  begin
    v_key_bytes := decode(v_wrapped, 'hex');
  exception
    when others then
      raise exception 'MAIL03: encryption_material_unavailable' using errcode = 'MAIL3';
  end;
  if octet_length(v_key_bytes) <> 32 then
    raise exception 'MAIL03: encryption_material_unavailable' using errcode = 'MAIL3';
  end if;

  select s.content_fingerprint
    into v_previous_fingerprint
    from public.notification_transport_secrets s
   where s.transport_id = v_row.id;

  v_fingerprint := encode(extensions.digest(p_new_password, 'sha256'), 'hex');
  v_nonce := extensions.gen_random_bytes(24);
  -- Dynamic SQL on purpose (same reason as the vault read above), and the key
  -- travels as a bound parameter: it never appears as a literal in the
  -- statement text, so it cannot leak through logs or pg_stat_statements
  -- (study §1.4 / threat T6).
  execute 'select pgsodium.crypto_secretbox($1, $2, $3)'
     into v_ciphertext
    using convert_to(p_new_password, 'UTF8'), v_nonce, v_key_bytes;

  insert into public.notification_transport_secrets (
    transport_id, secret_ciphertext, wrapped_key, kms_key_id, key_id,
    cipher, nonce, tag, content_fingerprint, encoding, secrets_version,
    created_by, updated_by
  )
  values (
    v_row.id, v_ciphertext, null, null, v_key.id,
    'xsalsa20-poly1305', v_nonce, null, v_fingerprint, 'utf8-bytes',
    v_row.secrets_version + 1,
    v_actor, v_actor
  )
  on conflict (transport_id) do update
    set secret_ciphertext = excluded.secret_ciphertext,
        wrapped_key = excluded.wrapped_key,
        kms_key_id = excluded.kms_key_id,
        key_id = excluded.key_id,
        cipher = excluded.cipher,
        nonce = excluded.nonce,
        tag = excluded.tag,
        content_fingerprint = excluded.content_fingerprint,
        encoding = excluded.encoding,
        secrets_version = excluded.secrets_version,
        updated_by = excluded.updated_by
  returning * into v_secret;

  update public.notification_transports
     set secrets_version = v_row.secrets_version + 1,
         updated_by = v_actor
   where id = v_row.id
  returning * into v_row;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'email.credentials_rotated'::public.audit_action,
    'notification_transport_secrets',
    v_row.id::text,
    jsonb_build_object(
      'transport_slug', v_row.slug,
      'transition', 'rotated',
      'content_fingerprint', left(v_fingerprint, 8),
      'previous_fingerprint', left(v_previous_fingerprint, 8),
      'secrets_version', v_row.secrets_version,
      'key_version', v_key.key_version,
      'key_source', v_key.key_source
    )
  );

  return jsonb_build_object(
    'transport_id', v_row.id,
    'slug', v_row.slug,
    'has_password', true,
    'fingerprint', left(v_fingerprint, 8),
    'cipher', v_secret.cipher,
    'key_version', v_key.key_version,
    'key_source', v_key.key_source,
    'secrets_version', v_row.secrets_version,
    'updated_at', v_row.updated_at
  );
exception
  when others then
    if sqlstate in ('42501', '22023', 'MAIL1', 'MAIL2', 'MAIL3', 'MAIL4', 'SEC01', 'P0002') then
      raise;
    end if;
    raise exception 'email_password_update_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_set_email_password(text, integer, timestamptz, text)
  from public, anon, service_role;
grant execute on function public.admin_set_email_password(text, integer, timestamptz, text)
  to authenticated;

-- 10b) Path B: the sending worker (service_role) stores ciphertext it produced
--      outside the database. The database never sees the plaintext or the key.
create or replace function public.admin_store_email_secret(
  p_transport_slug text,
  p_cipher text,
  p_ciphertext bytea,
  p_nonce bytea,
  p_content_fingerprint text,
  p_key_version integer default null,
  p_tag bytea default null,
  p_wrapped_key bytea default null,
  p_kms_key_id text default null,
  p_expected_secrets_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.notification_transports%rowtype;
  v_key public.notification_encryption_keys%rowtype;
  v_slug text;
  v_previous_fingerprint text;
  v_kms_key_id text;
begin
  v_slug := nullif(btrim(coalesce(p_transport_slug, '')), '');
  if v_slug is null then
    raise exception 'MAIL02: invalid_transport_payload'
      using errcode = 'MAIL2', detail = 'reason: slug_required';
  end if;

  if p_cipher is null
     or p_cipher not in ('xsalsa20-poly1305', 'aes-256-gcm', 'chacha20-poly1305') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: cipher';
  end if;
  if p_ciphertext is null or octet_length(p_ciphertext) < 16 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: secret_ciphertext';
  end if;
  if p_nonce is null
     or (p_cipher = 'xsalsa20-poly1305' and octet_length(p_nonce) <> 24)
     or (p_cipher <> 'xsalsa20-poly1305' and octet_length(p_nonce) <> 12) then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: nonce';
  end if;
  if p_content_fingerprint is null
     or p_content_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: content_fingerprint';
  end if;

  v_kms_key_id := nullif(btrim(coalesce(p_kms_key_id, '')), '');

  select t.*
    into v_row
    from public.notification_transports t
   where t.slug = v_slug
   for update;
  if not found then
    raise exception 'transport_not_found' using errcode = 'P0002';
  end if;

  if p_expected_secrets_version is not null
     and v_row.secrets_version <> p_expected_secrets_version then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;

  if p_key_version is null then
    raise exception 'MAIL02: invalid_transport_payload'
      using errcode = 'MAIL2', detail = 'reason: key_version_required';
  end if;
  select k.*
    into v_key
    from public.notification_encryption_keys k
   where k.key_version = p_key_version;
  if not found then
    raise exception 'SEC01: unknown_key_version' using errcode = 'SEC01';
  end if;

  -- Path B provenance: the worker must name the external key it used.
  v_kms_key_id := coalesce(v_kms_key_id, v_key.kms_key_id);
  if v_key.key_source <> 'external' or v_kms_key_id is null then
    raise exception 'SEC01: unknown_key_version' using errcode = 'SEC01';
  end if;

  select s.content_fingerprint
    into v_previous_fingerprint
    from public.notification_transport_secrets s
   where s.transport_id = v_row.id;

  insert into public.notification_transport_secrets (
    transport_id, secret_ciphertext, wrapped_key, kms_key_id, key_id,
    cipher, nonce, tag, content_fingerprint, encoding, secrets_version,
    created_by, updated_by
  )
  values (
    v_row.id, p_ciphertext, p_wrapped_key, v_kms_key_id, null,
    p_cipher, p_nonce, p_tag, p_content_fingerprint, 'utf8-bytes',
    v_row.secrets_version + 1,
    v_actor, v_actor
  )
  on conflict (transport_id) do update
    set secret_ciphertext = excluded.secret_ciphertext,
        wrapped_key = excluded.wrapped_key,
        kms_key_id = excluded.kms_key_id,
        key_id = excluded.key_id,
        cipher = excluded.cipher,
        nonce = excluded.nonce,
        tag = excluded.tag,
        content_fingerprint = excluded.content_fingerprint,
        encoding = excluded.encoding,
        secrets_version = excluded.secrets_version,
        updated_by = excluded.updated_by;

  update public.notification_transports
     set secrets_version = v_row.secrets_version + 1,
         updated_by = v_actor
   where id = v_row.id
  returning * into v_row;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'email.credentials_rotated'::public.audit_action,
    'notification_transport_secrets',
    v_row.id::text,
    jsonb_build_object(
      'transport_slug', v_row.slug,
      'transition', 'stored_external',
      'content_fingerprint', left(p_content_fingerprint, 8),
      'previous_fingerprint', left(v_previous_fingerprint, 8),
      'secrets_version', v_row.secrets_version,
      'key_version', v_key.key_version,
      'key_source', v_key.key_source
    )
  );

  return jsonb_build_object(
    'transport_id', v_row.id,
    'slug', v_row.slug,
    'has_password', true,
    'fingerprint', left(p_content_fingerprint, 8),
    'cipher', p_cipher,
    'key_version', v_key.key_version,
    'key_source', v_key.key_source,
    'secrets_version', v_row.secrets_version,
    'updated_at', v_row.updated_at
  );
exception
  when others then
    if sqlstate in ('42501', '22023', 'MAIL1', 'MAIL2', 'MAIL3', 'MAIL4', 'SEC01', 'P0002') then
      raise;
    end if;
    raise exception 'email_secret_store_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_store_email_secret(
  text, text, bytea, bytea, text, integer, bytea, bytea, text, integer
) from public, anon, authenticated;
grant execute on function public.admin_store_email_secret(
  text, text, bytea, bytea, text, integer, bytea, bytea, text, integer
) to service_role;

-- 10c) Explicit clear (never merged with the carrier update). Clearing also
--      disables the carrier: an enabled transport without credentials is a
--      state the guard trigger refuses anyway.
create or replace function public.admin_clear_email_password(
  p_expected_secrets_version integer default null,
  p_expected_updated_at timestamptz default null,
  p_transport_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.notification_transports%rowtype;
  v_secret public.notification_transport_secrets%rowtype;
  v_slug text;
begin
  if v_actor is null or not public.can_manage_email_transport() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  v_slug := nullif(btrim(coalesce(p_transport_slug, '')), '');
  select t.*
    into v_row
    from public.notification_transports t
   where (v_slug is null and t.id = (
            select t2.id
              from public.notification_transports t2
             order by (t2.is_default and t2.is_enabled) desc, t2.is_enabled desc, t2.created_at asc
             limit 1
          ))
      or (v_slug is not null and t.slug = v_slug)
   for update;
  if not found then
    raise exception 'transport_not_found' using errcode = 'P0002';
  end if;

  if p_expected_secrets_version is not null
     and v_row.secrets_version <> p_expected_secrets_version then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;
  if p_expected_updated_at is not null and v_row.updated_at <> p_expected_updated_at then
    raise exception 'MAIL01: stale_transport_snapshot' using errcode = 'MAIL1';
  end if;

  select s.*
    into v_secret
    from public.notification_transport_secrets s
   where s.transport_id = v_row.id;
  if not found then
    return public.notification_transport_snapshot(v_row.id); -- idempotent no-op
  end if;

  update public.notification_transports
     set is_enabled = false,
         secrets_version = v_row.secrets_version + 1,
         updated_by = v_actor
   where id = v_row.id
  returning * into v_row;

  delete from public.notification_transport_secrets where transport_id = v_row.id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'email.credentials_rotated'::public.audit_action,
    'notification_transport_secrets',
    v_row.id::text,
    jsonb_build_object(
      'transport_slug', v_row.slug,
      'transition', 'cleared',
      'content_fingerprint', null,
      'previous_fingerprint', left(v_secret.content_fingerprint, 8),
      'secrets_version', v_row.secrets_version,
      'key_version', null,
      'key_source', null
    )
  );

  return public.notification_transport_snapshot(v_row.id);
exception
  when others then
    if sqlstate in ('42501', '22023', 'MAIL1', 'MAIL2', 'MAIL3', 'MAIL4', 'SEC01', 'P0002') then
      raise;
    end if;
    raise exception 'email_password_clear_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_clear_email_password(integer, timestamptz, text)
  from public, anon, service_role;
grant execute on function public.admin_clear_email_password(integer, timestamptz, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 11) Environment detection + first key registration (never fails the migration)
-- ---------------------------------------------------------------------------
do $$
declare
  v_path_a boolean := false;
  v_secret_id uuid;
begin
  -- (1) Try to make pgsodium available without ever failing the migration.
  --     Supabase ships it pre-installed; a bare PostgreSQL may not have it.
  if not exists (select 1 from pg_extension where extname = 'pgsodium') then
    begin
      create extension if not exists pgsodium;
    exception
      when others then
        v_path_a := false; -- Path B: encryption material lives outside the database.
    end;
  end if;

  -- (2) Path A needs BOTH the AEAD function and the vault schema.
  v_path_a := to_regprocedure('pgsodium.crypto_secretbox(bytea, bytea, bytea)') is not null
              and exists (select 1 from pg_namespace where nspname = 'vault');

  -- (3) Provision the first DEK inside vault when Path A is available. The DEK
  --     is generated here, per environment, and never appears in the repository.
  if v_path_a then
    begin
      select vault.create_secret(
               encode(extensions.gen_random_bytes(32), 'hex'),
               'notification-transport-dek-v1',
               'Phase 1 DEK for notification transport secrets (Path A)'
             )
        into v_secret_id;
    exception
      when others then
        v_path_a := false;
        v_secret_id := null;
    end;
  end if;

  -- (4) Register the current key version exactly once. Re-running the
  --     migration never rotates an existing key.
  if not exists (select 1 from public.notification_encryption_keys) then
    insert into public.notification_encryption_keys (
      key_version, key_source, vault_secret_id, kms_key_id, is_current
    )
    values (
      1,
      case when v_path_a then 'vault' else 'external' end,
      v_secret_id,
      null,
      true
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12) Seed the default carrier (disabled until credentials exist)
-- ---------------------------------------------------------------------------
insert into public.notification_transports (
  slug, provider_type, host, port, username,
  sender_email, sender_name, reply_to_email,
  tls_mode, auth_mode, is_enabled, is_default
)
values (
  'default-smtp', 'smtp_generic', 'localhost', 587, null,
  'no-reply@example.invalid', 'نظام الإدارة', null,
  'starttls', 'login', false, true
)
on conflict (slug) do nothing;
