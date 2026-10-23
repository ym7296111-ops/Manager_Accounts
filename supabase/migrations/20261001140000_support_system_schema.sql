-- Support & Maintenance ticketing system schema (screen 4 of the settings screens).
--
--   1. Enums:
--        * public.ticket_status   ('opened', 'in_progress', 'resolved', 'closed')
--        * public.ticket_priority ('low', 'medium', 'high')
--        * public.audit_action    +'support.ticket_status_updated', +'support.ticket_replied'
--   2. Tables:
--        * public.tickets         (with generated identity ticket_number and last_activity_at)
--        * public.ticket_replies  (immutable chronological thread bound to tickets)
--   3. Row Level Security & Privilege Isolation:
--        * ENABLE + FORCE ROW LEVEL SECURITY on both tables.
--        * Direct INSERT/UPDATE/DELETE/TRUNCATE revoked from anon, authenticated, and service_role.
--        * Defense-in-depth trigger guard blocking direct DML outside SECURITY DEFINER owners.
--        * Owners read only their own tickets and replies; support agents (super_admin / '*')
--          and holders of 'support.manage' read all tickets and replies.
--   4. Atomic SECURITY DEFINER RPCs (set search_path = pg_catalog, public):
--        * public.create_support_ticket(p_subject, p_description, p_priority)
--        * public.add_ticket_reply(p_ticket_id, p_body)
--        * public.update_ticket_status(p_ticket_id, p_status, p_priority)

-- ---------------------------------------------------------------------------
-- 1) Enums & Audit actions
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
       and t.typname = 'ticket_status'
  ) then
    create type public.ticket_status as enum ('opened', 'in_progress', 'resolved', 'closed');
  end if;

  if not exists (
    select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
       and t.typname = 'ticket_priority'
  ) then
    create type public.ticket_priority as enum ('low', 'medium', 'high');
  end if;
end;
$$;

alter type public.audit_action add value if not exists 'support.ticket_created';
alter type public.audit_action add value if not exists 'support.ticket_status_updated';
alter type public.audit_action add value if not exists 'support.ticket_replied';

-- ---------------------------------------------------------------------------
-- 2) Support authorization helper
-- ---------------------------------------------------------------------------
create or replace function public.is_support_agent()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_active_user()
     and (public.is_admin() or public.has_permission('support.manage'));
$$;

revoke all on function public.is_support_agent() from public, anon;
grant execute on function public.is_support_agent() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Core support tables: public.tickets & public.ticket_replies
-- ---------------------------------------------------------------------------
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number bigint generated always as identity unique,
  user_id uuid not null references public.profiles (id) on delete cascade,
  assigned_to uuid references auth.users (id) on delete set null,
  subject text not null check (char_length(btrim(subject)) between 5 and 200),
  description text not null check (char_length(btrim(description)) between 10 and 5000),
  status public.ticket_status not null default 'opened',
  priority public.ticket_priority not null default 'medium',
  last_activity_at timestamptz not null default now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tickets_user_last_activity_idx
  on public.tickets (user_id, last_activity_at desc);

create index tickets_status_priority_activity_idx
  on public.tickets (status, priority, last_activity_at desc);

create trigger tickets_set_updated_at
  before update on public.tickets
  for each row execute function public.set_updated_at();

create table public.ticket_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete restrict,
  is_support_reply boolean not null default false,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index ticket_replies_ticket_created_idx
  on public.ticket_replies (ticket_id, created_at asc);

-- ---------------------------------------------------------------------------
-- 4) Row Level Security, Privilege Revocation & Write-Protection Trigger
-- ---------------------------------------------------------------------------
alter table public.tickets enable row level security;
alter table public.tickets force row level security;

alter table public.ticket_replies enable row level security;
alter table public.ticket_replies force row level security;

revoke all on table public.tickets, public.ticket_replies
  from public, anon, authenticated, service_role;

grant select on table public.tickets, public.ticket_replies
  to authenticated, service_role;

create or replace function public.guard_support_writes()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('postgres', 'supabase_admin') then
    raise exception 'support tables are write-protected; use sanctioned support RPCs'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_support_writes()
  from public, anon, authenticated, service_role;

drop trigger if exists tickets_guard_writes on public.tickets;
create trigger tickets_guard_writes
  before insert or update or delete on public.tickets
  for each row execute function public.guard_support_writes();

drop trigger if exists ticket_replies_guard_writes on public.ticket_replies;
create trigger ticket_replies_guard_writes
  before insert or update or delete on public.ticket_replies
  for each row execute function public.guard_support_writes();

create policy tickets_select_owner_or_support
  on public.tickets
  for select
  to authenticated
  using (
    public.is_active_user()
    and (auth.uid() = user_id or public.is_support_agent())
  );

create policy ticket_replies_select_visible_ticket
  on public.ticket_replies
  for select
  to authenticated
  using (
    public.is_active_user()
    and exists (
      select 1
        from public.tickets as t
       where t.id = ticket_replies.ticket_id
         and (t.user_id = auth.uid() or public.is_support_agent())
    )
  );

-- Allow authorized support agents (including non-super_admin holders of support.manage)
-- to read requester profiles and role assignments when embedding ticket metadata.
drop policy if exists "Support agents read profiles" on public.profiles;
create policy "Support agents read profiles"
  on public.profiles
  for select
  to authenticated
  using (public.is_support_agent());

drop policy if exists "Support agents read user roles" on public.user_roles;
create policy "Support agents read user roles"
  on public.user_roles
  for select
  to authenticated
  using (public.is_support_agent());

-- ---------------------------------------------------------------------------
-- 5) SECURITY DEFINER RPCs
-- ---------------------------------------------------------------------------

-- (a) Create a new support ticket (derives user_id strictly from auth.uid())
create or replace function public.create_support_ticket(
  p_subject text,
  p_description text,
  p_priority public.ticket_priority default 'medium'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_subject text := btrim(coalesce(p_subject, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_priority public.ticket_priority := coalesce(p_priority, 'medium'::public.ticket_priority);
  v_ticket public.tickets%rowtype;
begin
  if v_actor is null or not public.is_active_user() then
    raise exception 'create_support_ticket: active authenticated user required'
      using errcode = '42501';
  end if;

  if char_length(v_subject) not between 5 and 200 then
    raise exception 'create_support_ticket: subject must be between 5 and 200 characters'
      using errcode = '22023';
  end if;

  if char_length(v_description) not between 10 and 5000 then
    raise exception 'create_support_ticket: description must be between 10 and 5000 characters'
      using errcode = '22023';
  end if;

  insert into public.tickets (
    user_id,
    subject,
    description,
    status,
    priority,
    last_activity_at
  )
  values (
    v_actor,
    v_subject,
    v_description,
    'opened'::public.ticket_status,
    v_priority,
    now()
  )
  returning * into v_ticket;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'support.ticket_created'::public.audit_action,
    'tickets',
    v_ticket.id::text,
    jsonb_build_object(
      'ticket_number', v_ticket.ticket_number,
      'priority', v_ticket.priority,
      'subject', v_ticket.subject
    )
  );

  return jsonb_build_object(
    'id', v_ticket.id,
    'ticket_number', v_ticket.ticket_number,
    'user_id', v_ticket.user_id,
    'subject', v_ticket.subject,
    'description', v_ticket.description,
    'status', v_ticket.status,
    'priority', v_ticket.priority,
    'last_activity_at', v_ticket.last_activity_at,
    'created_at', v_ticket.created_at,
    'updated_at', v_ticket.updated_at
  );
end;
$$;

revoke all on function public.create_support_ticket(text, text, public.ticket_priority)
  from public, anon, service_role;
grant execute on function public.create_support_ticket(text, text, public.ticket_priority)
  to authenticated;

-- (b) Add a reply to an existing ticket (blocks closed tickets, derives sender & support identity)
create or replace function public.add_ticket_reply(
  p_ticket_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_is_support boolean;
  v_ticket public.tickets%rowtype;
  v_reply public.ticket_replies%rowtype;
begin
  if v_actor is null or not public.is_active_user() then
    raise exception 'add_ticket_reply: active authenticated user required'
      using errcode = '42501';
  end if;

  if p_ticket_id is null then
    raise exception 'add_ticket_reply: ticket id is required'
      using errcode = '22023';
  end if;

  if char_length(v_body) not between 1 and 5000 then
    raise exception 'add_ticket_reply: reply body must be between 1 and 5000 characters'
      using errcode = '22023';
  end if;

  select *
    into v_ticket
    from public.tickets as t
   where t.id = p_ticket_id
   for update;

  if not found then
    raise exception 'add_ticket_reply: ticket % not found', p_ticket_id
      using errcode = 'P0002';
  end if;

  v_is_support := public.is_support_agent();

  if v_ticket.user_id <> v_actor and not v_is_support then
    raise exception 'add_ticket_reply: caller is neither the ticket owner nor a support agent'
      using errcode = '42501';
  end if;

  if v_ticket.status = 'closed'::public.ticket_status then
    raise exception 'add_ticket_reply: cannot reply to a closed ticket'
      using errcode = 'SUP01';
  end if;

  insert into public.ticket_replies (
    ticket_id,
    sender_id,
    is_support_reply,
    body
  )
  values (
    p_ticket_id,
    v_actor,
    v_is_support,
    v_body
  )
  returning * into v_reply;

  update public.tickets
     set last_activity_at = v_reply.created_at,
         assigned_to = case
           when v_is_support and assigned_to is null then v_actor
           else assigned_to
         end
   where id = p_ticket_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'support.ticket_replied'::public.audit_action,
    'ticket_replies',
    v_reply.id::text,
    jsonb_build_object(
      'ticket_id', p_ticket_id,
      'ticket_number', v_ticket.ticket_number,
      'is_support_reply', v_is_support
    )
  );

  return jsonb_build_object(
    'id', v_reply.id,
    'ticket_id', v_reply.ticket_id,
    'sender_id', v_reply.sender_id,
    'is_support_reply', v_reply.is_support_reply,
    'body', v_reply.body,
    'created_at', v_reply.created_at
  );
end;
$$;

revoke all on function public.add_ticket_reply(uuid, text)
  from public, anon, service_role;
grant execute on function public.add_ticket_reply(uuid, text)
  to authenticated;

-- (c) Update ticket status & priority (support agents / administrators only)
create or replace function public.update_ticket_status(
  p_ticket_id uuid,
  p_status public.ticket_status,
  p_priority public.ticket_priority default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_updated public.tickets%rowtype;
  v_next_priority public.ticket_priority;
begin
  if v_actor is null or not public.is_support_agent() then
    raise exception 'update_ticket_status: support management privileges required'
      using errcode = '42501';
  end if;

  if p_ticket_id is null or p_status is null then
    raise exception 'update_ticket_status: ticket id and status are required'
      using errcode = '22023';
  end if;

  select *
    into v_ticket
    from public.tickets as t
   where t.id = p_ticket_id
   for update;

  if not found then
    raise exception 'update_ticket_status: ticket % not found', p_ticket_id
      using errcode = 'P0002';
  end if;

  v_next_priority := coalesce(p_priority, v_ticket.priority);

  update public.tickets
     set status = p_status,
         priority = v_next_priority,
         assigned_to = coalesce(assigned_to, v_actor),
         last_activity_at = now(),
         resolved_at = case
           when p_status = 'resolved'::public.ticket_status then coalesce(resolved_at, now())
           when p_status in ('opened'::public.ticket_status, 'in_progress'::public.ticket_status) then null
           else resolved_at
         end,
         closed_at = case
           when p_status = 'closed'::public.ticket_status then coalesce(closed_at, now())
           else null
         end
   where id = p_ticket_id
  returning * into v_updated;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'support.ticket_status_updated'::public.audit_action,
    'tickets',
    p_ticket_id::text,
    jsonb_build_object(
      'ticket_number', v_ticket.ticket_number,
      'previous_status', v_ticket.status,
      'new_status', v_updated.status,
      'previous_priority', v_ticket.priority,
      'new_priority', v_updated.priority
    )
  );

  return jsonb_build_object(
    'id', v_updated.id,
    'ticket_number', v_updated.ticket_number,
    'status', v_updated.status,
    'priority', v_updated.priority,
    'assigned_to', v_updated.assigned_to,
    'resolved_at', v_updated.resolved_at,
    'closed_at', v_updated.closed_at,
    'last_activity_at', v_updated.last_activity_at,
    'updated_at', v_updated.updated_at
  );
end;
$$;

revoke all on function public.update_ticket_status(uuid, public.ticket_status, public.ticket_priority)
  from public, anon, service_role;
grant execute on function public.update_ticket_status(uuid, public.ticket_status, public.ticket_priority)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Realtime publication (invalidation signals only)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'tickets'
  ) then
    alter publication supabase_realtime add table public.tickets;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ticket_replies'
  ) then
    alter publication supabase_realtime add table public.ticket_replies;
  end if;
end;
$$;
