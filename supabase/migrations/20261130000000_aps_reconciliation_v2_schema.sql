-- APS reconciliation v2: additive only. Historical v1 and legacy amounts are
-- not interpreted as monthly or cumulative accountant movement.
insert into public.permissions (slug, module, name_ar, name_en, description, is_delegatable)
values ('aps.reconciliation:settings', 'aps', 'ضبط المطابقة', 'Reconciliation settings',
        'ضبط التصنيفات التي تشملها المطابقة', false)
on conflict (slug) do update set module = excluded.module, name_ar = excluded.name_ar,
  name_en = excluded.name_en, description = excluded.description, is_delegatable = excluded.is_delegatable;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.slug in ('owner', 'super_admin') and p.slug = 'aps.reconciliation:settings'
on conflict (role_id, permission_id) do nothing;

alter type public.audit_action add value if not exists 'aps.reconciliation_settings_changed';
alter type public.audit_action add value if not exists 'aps.reconciliation_v2_recorded';
alter type public.audit_action add value if not exists 'aps.reconciliation_v2_refreshed';
alter type public.audit_action add value if not exists 'aps.reconciliation_review_required';

-- Revisions and their resolved leaf membership are immutable snapshots. They
-- are global to the ledger. A session stores its revision, so a later change
-- to selections or the hierarchy does not silently change that session.
create table public.aps_reconciliation_settings_revisions (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create table public.aps_reconciliation_settings (
  revision_id uuid not null references public.aps_reconciliation_settings_revisions(id) on delete restrict,
  classification_id uuid not null references public.classifications(id) on delete restrict,
  classification_name text not null,
  primary key (revision_id, classification_id)
);
create table public.aps_reconciliation_settings_members (
  revision_id uuid not null,
  classification_id uuid not null,
  leaf_id uuid not null references public.classifications(id) on delete restrict,
  primary key (revision_id, classification_id, leaf_id),
  unique (revision_id, leaf_id),
  foreign key (revision_id, classification_id)
    references public.aps_reconciliation_settings(revision_id, classification_id) on delete restrict
);
-- Singleton pointer allows an empty initial state without manufacturing a
-- configuration or selecting every classification without user consent.
create table public.aps_reconciliation_settings_current (
  singleton boolean primary key default true check (singleton),
  revision_id uuid not null references public.aps_reconciliation_settings_revisions(id) on delete restrict
);

-- Legacy/v1 retain a mandatory station; v2 is a single global session.
alter table public.aps_reconciliation_sessions alter column station_id drop not null;
alter table public.aps_reconciliation_sessions
  add column settings_revision_id uuid references public.aps_reconciliation_settings_revisions(id) on delete restrict,
  add column needs_review boolean not null default false,
  add column review_reason text,
  add column review_required_at timestamptz,
  add column snapshot_version bigint not null default 1 check (snapshot_version > 0);
alter table public.aps_reconciliation_sessions
  drop constraint aps_reconciliation_sessions_flow_type_check;
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_sessions_flow_type_check
  check (flow_type in ('legacy', 'screen', 'screen_v2'));
alter table public.aps_reconciliation_sessions
  add constraint aps_reconciliation_v2_revision_check
  check ((flow_type = 'screen_v2') = (settings_revision_id is not null));
alter table public.aps_reconciliation_sessions add constraint aps_reconciliation_v2_station_check
  check ((flow_type = 'screen_v2' and station_id is null) or (flow_type <> 'screen_v2' and station_id is not null));
-- Reopening retains the same canonical v2 record and avoids duplicate sessions.
create unique index aps_reconciliation_v2_canonical_idx
  on public.aps_reconciliation_sessions(fiscal_month_id)
  where flow_type = 'screen_v2' and status in ('open', 'closed');

-- Keep legacy station validation intact while permitting a NULL station on v2.
create or replace function public.aps_reconciliation_sessions_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_month_year uuid;
  v_bounds record;
begin
  -- The month must belong to the stated fiscal year; otherwise the movement
  -- window and the year's opening balances come from different years.
  select month.fiscal_year_id, month.start_date, month.end_date
    into v_bounds
    from public.fiscal_months as month
   where month.id = new.fiscal_month_id;
  if not found then
    raise exception 'aps reconciliation: unknown fiscal month %', new.fiscal_month_id
      using errcode = '23503';
  end if;
  v_month_year := v_bounds.fiscal_year_id;
  if v_month_year <> new.fiscal_year_id then
    raise exception 'aps reconciliation: fiscal month % does not belong to fiscal year %',
      new.fiscal_month_id, new.fiscal_year_id using errcode = '23514';
  end if;

  if new.flow_type <> 'screen_v2' and not exists (
    select 1 from public.warehouses as warehouse where warehouse.station_id = new.station_id
  ) then
    raise exception 'aps reconciliation: station % has no warehouse to reconcile',
      new.station_id using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'aps reconciliation: sessions are created open' using errcode = '23514';
    end if;
    new.opened_by := coalesce(new.opened_by, auth.uid());
    if new.opened_by is null then
      raise exception 'aps reconciliation: opened_by is required' using errcode = '23514';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    new.cancelled_by := null;
    new.cancelled_at := null;
    new.cancel_reason := null;
  else
    -- A session is identified by its month, station and sequence. Approval only
    -- flips the status and stamps the approver; nothing else may change after
    -- the numbers are certified.
    if (old.flow_type = 'screen_v2' or new.flow_type = 'screen_v2') and new.flow_type is distinct from old.flow_type then
      raise exception 'aps reconciliation: workflow cannot change' using errcode = '23514';
    end if;
    if new.fiscal_year_id is distinct from old.fiscal_year_id
       or new.fiscal_month_id is distinct from old.fiscal_month_id
       or new.station_id is distinct from old.station_id
       or new.sequence_number is distinct from old.sequence_number
       or new.supersedes_session_id is distinct from old.supersedes_session_id
       or new.opened_by is distinct from old.opened_by
    then
      raise exception 'aps reconciliation: a session cannot be moved or renumbered'
        using errcode = '23514';
    end if;

    if old.status = 'approved' and new.status is distinct from old.status then
      raise exception 'aps reconciliation: an approved session is final' using errcode = '23514';
    end if;
    if old.status = 'approved'
       and (
         new.settlement_warehouse_id is distinct from old.settlement_warehouse_id
         or new.note is distinct from old.note
       )
    then
      raise exception 'aps reconciliation: an approved session is immutable' using errcode = '23514';
    end if;
    if old.status = 'cancelled' and new.status is distinct from old.status then
      raise exception 'aps reconciliation: a cancelled session stays cancelled'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;


-- Monetary sources are fixed snapshots; v2 uses an optional manual opening.
-- NULL accountant opening means the trusted system opening was used, not that
-- the accountant independently confirmed it. Other NULL amounts mean missing.
alter table public.aps_reconciliation_lines
  add column book_inbound numeric(18,2),
  add column book_outbound numeric(18,2),
  add column book_year_opening numeric(18,2),
  add column book_ytd_inbound numeric(18,2),
  add column book_ytd_outbound numeric(18,2),
  add column accountant_inbound numeric(18,2),
  add column accountant_outbound numeric(18,2),
  add column accountant_year_opening numeric(18,2),
  add column accountant_ytd_inbound numeric(18,2),
  add column accountant_ytd_outbound numeric(18,2),
  add column v2_version bigint not null default 1,
  add column v2_recorded_by uuid references public.profiles(id),
  add column v2_recorded_at timestamptz;
alter table public.aps_reconciliation_lines add constraint aps_reconciliation_v2_amounts_check
  check ((book_inbound is null or book_inbound >= 0)
    and (book_outbound is null or book_outbound >= 0)
    and (accountant_inbound is null or accountant_inbound >= 0)
    and (accountant_outbound is null or accountant_outbound >= 0)
    and (accountant_year_opening is null or accountant_year_opening >= 0)
    and (accountant_ytd_inbound is null or accountant_ytd_inbound >= 0)
    and (accountant_ytd_outbound is null or accountant_ytd_outbound >= 0)
    and v2_version > 0);

alter table public.aps_reconciliation_settings_revisions enable row level security;
alter table public.aps_reconciliation_settings_revisions force row level security;
alter table public.aps_reconciliation_settings enable row level security;
alter table public.aps_reconciliation_settings force row level security;
alter table public.aps_reconciliation_settings_members enable row level security;
alter table public.aps_reconciliation_settings_members force row level security;
alter table public.aps_reconciliation_settings_current enable row level security;
alter table public.aps_reconciliation_settings_current force row level security;
revoke all on public.aps_reconciliation_settings_revisions, public.aps_reconciliation_settings,
  public.aps_reconciliation_settings_members, public.aps_reconciliation_settings_current
  from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
