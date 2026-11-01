// Rehearsal harness for the A.1 draft (docs/consultations/drafts/, not shipped).
// Boots a real PostgreSQL (PGlite/WASM), stubs the Supabase objects the draft
// depends on, applies it, then asserts its invariants and behaviour:
//
//   mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm init -y && npm i @electric-sql/pglite
//   cd /path/to/repo
//   PGLITE_MODULE=/tmp/pgtest/node_modules/@electric-sql/pglite/dist/index.js \
//     node docs/consultations/drafts/20261121000000_aps_active_fiscal_month.checks.mjs
//
// It needs PostgreSQL 14+; PGlite ships PostgreSQL 18, which also proves the
// draft runs on a newer engine than the hosted one.
//
// Two stubs differ from production and are intentional: `has_permission` is a
// simplified copy, and fiscal_years_before_write is installed in its pre-A.1
// form so the draft's replacement is what gets exercised.
import { readFile } from 'node:fs/promises';
Error.stackTraceLimit = 2;

// PGlite is a rehearsal-only dependency: it is deliberately not in
// package.json, so point PGLITE_MODULE at an installed copy. Without it the
// bare specifier is used, which fails unless the package happens to be local.
const pgliteSpecifier = process.env.PGLITE_MODULE ?? '@electric-sql/pglite';
const { PGlite } = await import(pgliteSpecifier);

const MIGRATION = new URL(
  '../../../supabase/migrations/20261121000000_aps_active_fiscal_month.sql',
  import.meta.url,
).pathname;

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CLERK = '00000000-0000-4000-8000-0000000000a2';
const MANAGER = '00000000-0000-4000-8000-0000000000a3';

const db = await PGlite.create();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expectError(name, sql, params, expected) {
  try {
    await db.query(sql, params);
    check(name, false, 'no error raised');
  } catch (error) {
    const text = String(error.message ?? error);
    const code = error.code ?? '';
    const ok = text.includes(expected) || code === expected;
    check(name, ok, `${code} ${text}`.slice(0, 140));
  }
}

async function as(actor, role, fn) {
  await db.exec('begin');
  try {
    await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', actor]);
    await db.exec(`set local role ${role}`);
    const value = await fn();
    await db.exec('rollback');
    return value;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function asCommit(actor, role, fn) {
  await db.exec('begin');
  try {
    await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', actor]);
    await db.exec(`set local role ${role}`);
    const value = await fn();
    await db.exec('commit');
    return value;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function asExpectError(name, actor, role, sql, params, expected) {
  await db.exec('begin');
  try {
    await db.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', actor]);
    await db.exec(`set local role ${role}`);
    await db.query(sql, params);
    await db.exec('rollback');
    check(name, false, 'no error raised');
  } catch (error) {
    const text = String(error.message ?? error);
    const code = error.code ?? '';
    await db.exec('rollback');
    check(name, text.includes(expected) || code === expected, `${code} ${text}`.slice(0, 160));
  }
}

// ---------------------------------------------------------------------------
// Stubs: the parts of the schema the migration reads or writes.
// ---------------------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create type public.audit_action as enum ('role.created', 'opening_balance.updated');

  create table public.profiles (
    id uuid primary key,
    status text not null default 'active',
    approval_status text not null default 'approved'
  );

  create table public.roles (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique,
    is_super_admin boolean not null default false
  );

  create table public.user_roles (
    user_id uuid not null references public.profiles (id) on delete cascade,
    role_id uuid not null references public.roles (id) on delete cascade,
    primary key (user_id, role_id)
  );

  create table public.permissions (id uuid primary key default gen_random_uuid(), slug text not null unique);
  create table public.role_permissions (
    role_id uuid not null references public.roles (id) on delete cascade,
    permission_id uuid not null references public.permissions (id) on delete cascade,
    primary key (role_id, permission_id)
  );

  create table public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid,
    action public.audit_action not null,
    entity text not null,
    entity_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create table public.app_settings (
    key text primary key,
    category text not null default 'appearance',
    value jsonb not null,
    is_public boolean not null default true
  );

  create table public.fiscal_years (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    start_date date not null,
    end_date date not null,
    is_active boolean not null default false,
    is_closed boolean not null default false,
    supplements_open boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint fiscal_years_valid_date_range check (start_date < end_date)
  );

  create table public.fiscal_months (
    id uuid primary key default gen_random_uuid(),
    fiscal_year_id uuid not null references public.fiscal_years (id) on delete cascade,
    month_number integer not null,
    name text not null,
    start_date date not null,
    end_date date not null,
    current_period integer not null default 1,
    is_closed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint fiscal_months_year_month_key unique (fiscal_year_id, month_number),
    constraint fiscal_months_number_between_1_and_12 check (month_number between 1 and 12),
    constraint fiscal_months_current_period_positive check (current_period >= 1),
    constraint fiscal_months_valid_date_range check (start_date <= end_date)
  );

  -- Production grants this migration has to narrow.
  grant select, insert, update, delete on public.fiscal_months to authenticated;
  grant select, insert, update, delete on public.fiscal_years to authenticated;

  -- The year trigger already exists from 20261110000000 in production. This
  -- stub body is the same minus the period clearing, so the migration's
  -- replacement is what the test exercises.
  create or replace function public.fiscal_years_before_write()
  returns trigger language plpgsql set search_path = pg_catalog, public as $$
  declare
    v_excluded_id uuid;
  begin
    new.name := extract(year from new.start_date)::integer::text
                || '-' || extract(year from new.end_date)::integer::text;
    v_excluded_id := case when tg_op = 'UPDATE' then old.id else new.id end;
    if new.is_active then
      update public.fiscal_years set is_active = false
       where is_active and id is distinct from v_excluded_id;
    end if;
    return new;
  end;
  $$;
  revoke all on function public.fiscal_years_before_write() from public, anon, authenticated, service_role;
  create trigger fiscal_years_before_write
    before insert or update on public.fiscal_years
    for each row execute function public.fiscal_years_before_write();
  grant select on public.fiscal_months to anon;

  -- Capability helpers (the real ones live in earlier migrations).
  create or replace function public.has_permission(p_permission text)
  returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (
      select 1
        from public.user_roles u
        join public.role_permissions rp on rp.role_id = u.role_id
        join public.permissions p on p.id = rp.permission_id
       where u.user_id = auth.uid()
         and (p.slug = p_permission or p.slug = '*')
    );
  $$;

  create or replace function public.is_active_user()
  returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
    select exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.status = 'active' and p.approval_status = 'approved'
    );
  $$;

  create or replace function public.can_manage_project_settings()
  returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
    select coalesce(public.is_active_user(), false)
       and coalesce(public.has_permission('project.settings:manage'), false);
  $$;

  create or replace function public.aps_can_create_letters()
  returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
    select coalesce(public.is_active_user(), false)
       and coalesce(public.has_permission('aps.letters:create'), false);
  $$;

  grant execute on function public.has_permission(text) to authenticated;
  grant execute on function public.is_active_user() to authenticated;
  grant execute on function public.can_manage_project_settings() to authenticated;
  grant execute on function public.aps_can_create_letters() to authenticated;
`);

// Fixtures: one owner, one settings manager, one plain letter clerk.
await db.exec(`
  insert into public.profiles (id, status, approval_status) values
    ('${OWNER}', 'active', 'approved'),
    ('${MANAGER}', 'active', 'approved'),
    ('${CLERK}', 'active', 'approved');

  insert into public.roles (slug, is_super_admin) values
    ('owner', true),
    ('project_manager', false),
    ('aps_clerk', false);

  insert into public.permissions (slug) values
    ('*'),
    ('project.settings:manage'),
    ('aps.letters:create');

  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r, public.permissions p
   where (r.slug = 'project_manager' and p.slug = 'project.settings:manage')
      or (r.slug = 'aps_clerk' and p.slug = 'aps.letters:create')
      or (r.slug = 'owner' and p.slug = '*');

  insert into public.user_roles (user_id, role_id)
  select '${OWNER}', id from public.roles where slug = 'owner';
  insert into public.user_roles (user_id, role_id)
  select '${MANAGER}', id from public.roles where slug = 'project_manager';
  insert into public.user_roles (user_id, role_id)
  select '${CLERK}', id from public.roles where slug = 'aps_clerk';

  insert into public.app_settings (key, category, value)
  values ('appearance.default_timezone', 'appearance', to_jsonb('Africa/Cairo'::text));

  insert into public.fiscal_years (id, name, start_date, end_date, is_active)
  values
    ('11111111-1111-4111-8111-111111111111', '2025-2026', '2025-07-01', '2026-06-30', false),
    ('22222222-2222-4222-8222-222222222222', '2026-2027', '2026-07-01', '2027-06-30', true);

  insert into public.fiscal_years (id, name, start_date, end_date, is_active)
  values ('33333333-3333-4333-8333-333333333333', '2027-2028', '2027-07-01', '2028-06-30', false);

  insert into public.fiscal_months (id, fiscal_year_id, month_number, name, start_date, end_date)
  select gen_random_uuid(), y.id, m.n,
         to_char(d.start, 'YYYY-MM-DD') || ' month' || m.n,
         d.start,
         (d.start + interval '1 month - 1 day')::date
    from public.fiscal_years y
    cross join generate_series(1, 12) as m(n)
    cross join lateral (
      select (y.start_date + ((m.n - 1) * interval '1 month'))::date as start
    ) as d;
`);

// ---------------------------------------------------------------------------
// Apply the migration under test.
// ---------------------------------------------------------------------------
const migration = await readFile(MIGRATION, 'utf8');
await db.exec(migration);
console.log('— migration applied —');

// Helpers -------------------------------------------------------------------
const monthId = async (yearName, n) => {
  const { rows } = await db.query(
    `select m.id from public.fiscal_months m
       join public.fiscal_years y on y.id = m.fiscal_year_id
      where y.name = $1 and m.month_number = $2`,
    [yearName, n],
  );
  return rows[0].id;
};
const active = async () => {
  const { rows } = await db.query(
    `select m.name, m.month_number, y.name as year_name
       from public.fiscal_months m join public.fiscal_years y on y.id = m.fiscal_year_id
      where m.is_active`,
  );
  return rows;
};
const audit = async () => {
  const { rows } = await db.query(
    `select action, metadata from public.audit_logs order by created_at`,
  );
  return rows;
};

const OCT = await monthId('2026-2027', 4);
const NOV = await monthId('2026-2027', 5);
const JAN_OLD = await monthId('2025-2026', 7);

// 1) No active period is a valid state --------------------------------------
{
  const value = await as(CLERK, 'authenticated', async () => {
    const { rows } = await db.query('select public.aps_active_period() as p');
    return rows[0].p;
  });
  check('reader returns null when the project has no active period', value === null, String(value));
}

// 2) Activate October as the settings manager -------------------------------
{
  const value = await asCommit(MANAGER, 'authenticated', async () => {
    const { rows } = await db.query('select public.aps_activate_fiscal_month($1) as r', [OCT]);
    return rows[0].r;
  });
  check('manager activates a month', value?.changed === true, JSON.stringify(value));
  const now = await active();
  check(
    'exactly one active month',
    now.length === 1 && now[0].month_number === 4,
    JSON.stringify(now),
  );
  const rows = await audit();
  check(
    'activation is audited with via=rpc and no previous month',
    rows.length === 1 &&
      rows[0].action === 'fiscal_month.activated' &&
      rows[0].metadata.previous_fiscal_month_id === null &&
      rows[0].metadata.via === 'rpc',
    JSON.stringify(rows[0]?.metadata),
  );
}

// 3) Reader shape + suggestion flag ----------------------------------------
{
  const value = await as(CLERK, 'authenticated', async () => {
    const { rows } = await db.query('select public.aps_active_period() as p');
    return rows[0].p;
  });
  check(
    'letter clerk can read the active period',
    value?.month_number === 4 && value?.fiscal_year_name === '2026-2027',
    JSON.stringify(value),
  );
  check(
    'contains_today is computed in the project zone',
    value?.contains_today === false && typeof value?.project_today === 'string',
    `${value?.contains_today} ${value?.project_today}`,
  );
}

// 4) Rotation keeps a single active month and names the previous one --------
{
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('select public.aps_activate_fiscal_month($1) as r', [NOV]);
  });
  const now = await active();
  check(
    'rotation deactivates the previous month',
    now.length === 1 && now[0].month_number === 5,
    JSON.stringify(now),
  );
  const rows = await audit();
  const last = rows.at(-1);
  check(
    'the audit row names the month we left',
    last.metadata.previous_month_name === '2026-10-01 month4' && last.metadata.via === 'rpc',
    JSON.stringify(last.metadata),
  );
}

// 5) A month of an inactive fiscal year is refused -------------------------
await asExpectError(
  'a month of an inactive fiscal year is refused',
  MANAGER,
  'authenticated',
  'select public.aps_activate_fiscal_month($1)',
  [JAN_OLD],
  'not active',
);

// 6) Closed period: the documented exception -------------------------------
{
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('select public.aps_activate_fiscal_month($1) as r', [OCT]);
  });
  await db.query('update public.fiscal_months set is_closed = true where id = $1', [NOV]);

  await asExpectError(
    'a settings manager cannot post into a closed period',
    MANAGER,
    'authenticated',
    'select public.aps_activate_fiscal_month($1)',
    [NOV],
    '42501',
  );

  await asExpectError(
    'the owner needs a written reason for a closed period',
    OWNER,
    'authenticated',
    'select public.aps_activate_fiscal_month($1, $2)',
    [NOV, 'short'],
    'at least 10 characters',
  );

  const value = await asCommit(OWNER, 'authenticated', async () => {
    const { rows } = await db.query('select public.aps_activate_fiscal_month($1, $2) as r', [
      NOV,
      'اعتماد متأخر لشهر مغلق بموافقة المالك',
    ]);
    return rows[0].r;
  });
  const rows = await audit();
  const last = rows.at(-1);
  check(
    'the owner may activate a closed month with a reason, audited as an exception',
    value?.was_closed === true &&
      last.action === 'fiscal_month.activated_closed' &&
      last.metadata.reason === 'اعتماد متأخر لشهر مغلق بموافقة المالك' &&
      last.metadata.month_is_closed === true,
    JSON.stringify(last.metadata),
  );

  await db.query('update public.fiscal_months set is_closed = false where id = $1', [NOV]);
}

// 7) Direct writes ---------------------------------------------------------
await db.query('update public.fiscal_months set is_closed = false where id = $1', [NOV]);
await asExpectError(
  'authenticated cannot set is_active directly',
  MANAGER,
  'authenticated',
  'update public.fiscal_months set is_active = true where id = $1',
  [OCT],
  '42501',
);

{
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('update public.fiscal_months set current_period = 3 where id = $1', [OCT]);
  });
  const { rows } = await db.query('select current_period from public.fiscal_months where id = $1', [
    OCT,
  ]);
  check(
    'the periodic-settings screen keeps writing current_period',
    rows[0].current_period === 3,
    String(rows[0].current_period),
  );
}

await asExpectError(
  'a month cannot be created active',
  MANAGER,
  'authenticated',
  `insert into public.fiscal_months
     (fiscal_year_id, month_number, name, start_date, end_date, is_active)
   values ('33333333-3333-4333-8333-333333333333', 1, 'يوليو 2027', '2027-07-01', '2027-07-31', true)`,
  undefined,
  'cannot be created active',
);

// 7b) The period cannot be deleted away ------------------------------------
await asExpectError(
  'the active month cannot be deleted',
  MANAGER,
  'authenticated',
  'delete from public.fiscal_months where id = $1',
  [NOV],
  'move the period to another month',
);

{
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('delete from public.fiscal_months where id = $1', [OCT]);
  });
  const { rows } = await db.query(
    'select count(*)::int as n from public.fiscal_months where id = $1',
    [OCT],
  );
  check('an inactive month can still be deleted', rows[0].n === 0, String(rows[0].n));
  // Put October back so the following checks keep their fixture.
  await db.query(
    `insert into public.fiscal_months
       (id, fiscal_year_id, month_number, name, start_date, end_date, current_period)
     values ($1, '22222222-2222-4222-8222-222222222222', 4, 'restored october', '2026-10-01', '2026-10-31', 3)`,
    [OCT],
  );
}

// 8) The partial unique index is the last line of defence ------------------
{
  await db.exec('alter table public.fiscal_months disable trigger fiscal_months_before_write');
  try {
    await db.query('update public.fiscal_months set is_active = true where id = $1', [OCT]);
    check('the unique index still blocks a second active month', false, 'no error raised');
  } catch (error) {
    check(
      'the unique index still blocks a second active month',
      error.code === '23505',
      `${error.code} ${error.message}`.slice(0, 120),
    );
  }
  await db.exec('alter table public.fiscal_months enable trigger fiscal_months_before_write');
  const now = await active();
  check('still exactly one active month afterwards', now.length === 1, JSON.stringify(now));
}

// 9) Idempotent activation writes no extra audit row ----------------------
{
  const before = (await audit()).length;
  const value = await asCommit(MANAGER, 'authenticated', async () => {
    const { rows } = await db.query('select public.aps_activate_fiscal_month($1) as r', [NOV]);
    return rows[0].r;
  });
  const after = (await audit()).length;
  check(
    'a repeated activation is a no-op',
    value?.changed === false && after === before,
    `${value?.changed} ${before}->${after}`,
  );
}

// 10) Rotating the year clears the period and says so ----------------------
{
  // NOV is active in 2026-2027. Activating 2027-2028 must clear it, because a
  // period outside the active year is not a valid posting target.
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('update public.fiscal_years set is_active = true where id = $1', [
      '33333333-3333-4333-8333-333333333333',
    ]);
  });
  const now = await active();
  check('a year rotation clears the posting period', now.length === 0, JSON.stringify(now));
  const rows = await audit();
  const last = rows.at(-1);
  check(
    'the clearing is audited as a year rotation, not as an activation',
    last.action === 'fiscal_month.deactivated' &&
      last.metadata.reason === 'fiscal_year_rotation' &&
      last.metadata.via === 'year_rotation',
    JSON.stringify(last.metadata),
  );

  const value = await as(CLERK, 'authenticated', async () => {
    const { rows: r } = await db.query('select public.aps_active_period() as p');
    return r[0].p;
  });
  check('the reader reports no period after the rotation', value === null, String(value));

  // Restore 2026-2027 as the active year and NOV as the posting month.
  await asCommit(MANAGER, 'authenticated', async () => {
    await db.query('update public.fiscal_years set is_active = true where id = $1', [
      '22222222-2222-4222-8222-222222222222',
    ]);
    await db.query('select public.aps_activate_fiscal_month($1) as r', [NOV]);
  });
  const restored = await active();
  check(
    'the project can be returned to a period',
    restored.length === 1 && restored[0].month_number === 5,
    JSON.stringify(restored),
  );
}

// 11) Time zone helper ----------------------------------------------------
{
  const { rows } = await db.query(
    `select public.aps_project_today() = (now() at time zone 'Africa/Cairo')::date as same`,
  );
  check('project today follows the configured zone', rows[0].same === true, String(rows[0].same));
  await db.query(
    `update public.app_settings set value = to_jsonb('Not/AZone'::text)
      where key = 'appearance.default_timezone'`,
  );
  const { rows: rows2 } = await db.query(
    `select public.aps_project_today() = (now() at time zone 'UTC')::date as same`,
  );
  check('an invalid zone falls back to UTC', rows2[0].same === true, String(rows2[0].same));
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('FAILURES:', JSON.stringify(failed, null, 2));
  process.exitCode = 1;
}
