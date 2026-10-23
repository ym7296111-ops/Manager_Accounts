-- Task 4.2: durable idempotency and a minimal mail delivery log.
--
-- The table is worker-owned. It stores request metadata, a rendered-content hash and a stable
-- error class only; it never stores template variables, message bodies, provider response text,
-- credentials, or raw exception messages. `content_hash` stays nullable while a row is pending or
-- when processing fails before rendering completes.

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  request_key text not null,
  template_key text not null,
  locale text not null,
  recipient_email text not null,
  status text not null default 'pending',
  content_hash text,
  error_class text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_deliveries_request_key_key unique (request_key),
  constraint notification_deliveries_status_check
    check (status in ('pending', 'completed', 'failed')),
  -- Error classes are machine identifiers only, never raw error/provider messages or values.
  constraint notification_deliveries_error_class_check
    check (
      error_class is null
      or (
        error_class ~ '^[A-Z][A-Z0-9_]{0,63}$'
        and error_class !~ '[[:cntrl:]]'
      )
    ),
  constraint notification_deliveries_latency_check
    check (latency_ms is null or latency_ms >= 0)
);

comment on table public.notification_deliveries is
  'Worker-only notification delivery log and durable idempotency key registry. Stores no rendered message or template variable values.';
comment on column public.notification_deliveries.request_key is
  'Globally unique worker request key; the unique constraint prevents concurrent duplicate processing.';
comment on column public.notification_deliveries.content_hash is
  'SHA-256 hash of rendered content. Nullable until rendering succeeds; message content itself is never stored.';
comment on column public.notification_deliveries.error_class is
  'Stable uppercase error category only (for example TPL01 or MAIL03); raw messages and values are forbidden.';

-- Enable and force RLS as defense in depth. Deliberately create no RLS policies: browser roles
-- cannot read or write delivery history. The trusted Worker uses the service_role key; Supabase's
-- service_role bypasses RLS, but is still restricted here to the required table privileges.
alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

revoke all on table public.notification_deliveries
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.notification_deliveries to service_role;
