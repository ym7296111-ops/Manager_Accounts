// Offline PostgreSQL audit. No environment credentials or TCP hosts are used.
// Requires the isolated tooling/database described in the audit report.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from '../../.cache/live-audit/tooling/node_modules/pg/lib/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOCKET = `${ROOT}.cache/live-audit/pg-socket`;
const DATABASE = 'admin_system_audit';
const RESULTS = [];
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const V = '00000000-0000-4000-8000-000000000004';
const E = '00000000-0000-4000-8000-000000000005';

if (!process.argv.includes('--reset-fixture')) {
  throw new Error('Pass --reset-fixture to recreate ONLY the local admin_system_audit database.');
}

async function connect(database = DATABASE) {
  const client = new pg.Client({
    host: SOCKET,
    port: 55432,
    user: 'postgres',
    password: '',
    database,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await client.connect();
  return client;
}

async function asRole(role, actorId, fn, rollback = false) {
  assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
  const client = await connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actorId ?? '']);
    await client.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
    const result = await fn(client);
    await client.query(rollback ? 'rollback' : 'commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

async function test(name, fn) {
  await fn();
  RESULTS.push({ name, status: 'passed' });
  console.log(`PASS ${name}`);
}

async function expectCode(code, fn) {
  await assert.rejects(fn, (error) => error.code === code);
}

// Revoked table privileges surface as either RLS denial (42501) or a plain
// privilege refusal (42505) depending on the layer reached first; both mean
// "the direct write path is closed".
async function expectDenied(fn) {
  await assert.rejects(fn, (error) => ['42501', '42505'].includes(error.code));
}

function publishedVersion(result) {
  return result.version;
}

const control = await connect('postgres');
await control.query(`drop database if exists ${DATABASE}`);
await control.query(`create database ${DATABASE}`);
await control.end();
const db = await connect();

try {
  await db.query(await readFile(new URL('./supabase-fixture.sql', import.meta.url), 'utf8'));
  const migrations = (await readdir(`${ROOT}supabase/migrations`))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    // The embedded fixture models cron.schedule but does not include the pg_cron
    // shared library; the actual extension is exercised by Supabase migration CI.
    let sql = await readFile(`${ROOT}supabase/migrations/${file}`, 'utf8');
    sql = sql.replace('create extension if not exists pg_cron with schema pg_catalog;', '');

    // One transaction per migration, matching the important enum visibility boundary.
    await db.query('begin');
    if (file === '20261016000000_first_signup_admin_and_retire_ci_backups.sql') {
      await db.query('update public.backup_settings set enabled=true where singleton');
      await db.query(
        "insert into public.backup_logs(backup_type,status) values ('manual','queued')",
      );
    }
    if (file === '20261012120000_harden_bootstrap_preflight_and_audit_logs.sql') {
      await db.query(
        "insert into public.audit_logs(action,entity,entity_id,metadata) values ('settings.updated'::public.audit_action,'audit_fixture','legacy-email-metadata',$1::jsonb)",
        [
          JSON.stringify({
            target_email: 'legacy.owner@example.invalid',
            note: 'Contact legacy.owner@example.invalid',
            nested: { email: 'another.owner@example.invalid' },
          }),
        ],
      );
    }
    await db.query(sql);
    await db.query('commit');
  }
  await db.query(await readFile(`${ROOT}supabase/seed.sql`, 'utf8'));

  await test('first Auth signup is confirmed and elevated once; later signups ignore role metadata', async () => {
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const firstEmail = `first.${randomUUID()}@example.invalid`;
    const secondEmail = `later.${randomUUID()}@example.invalid`;

    await db.query('begin');
    try {
      await db.query(
        'insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)',
        [firstUserId, firstEmail, JSON.stringify({ role: 'viewer' })],
      );
      const first = (
        await db.query(
          `select u.email_confirmed_at, p.status, array_agg(r.slug order by r.slug) as slugs,
                  al.actor_type, al.actor_ref, al.metadata
             from auth.users u
             join public.profiles p on p.id = u.id
             join public.user_roles ur on ur.user_id = u.id
             join public.roles r on r.id = ur.role_id
             join public.audit_logs al on al.entity_id = u.id::text
            where u.id = $1 and al.action = 'role.granted' and al.entity = 'user_roles'
            group by u.email_confirmed_at, p.status, al.actor_type, al.actor_ref, al.metadata`,
          [firstUserId],
        )
      ).rows[0];
      assert.ok(first);
      assert.ok(first.email_confirmed_at);
      assert.equal(first.status, 'active');
      assert.equal(
        (await db.query('select approval_status from public.profiles where id=$1', [firstUserId]))
          .rows[0].approval_status,
        'approved',
      );
      assert.deepEqual(first.slugs, ['owner']);
      assert.equal(first.actor_type, 'auth_signup_trigger');
      assert.equal(first.actor_ref, 'auth.users.on_auth_user_created');
      assert.equal(first.metadata.first_signup, true);
      assert.equal(first.metadata.target_user_id, firstUserId);
      assert.equal(JSON.stringify(first.metadata).includes(firstEmail), false);
      const claim = (
        await db.query(
          'select claimed, first_user_id from public.first_admin_bootstrap_state where singleton',
        )
      ).rows[0];
      assert.equal(claim.claimed, true);
      assert.equal(claim.first_user_id, firstUserId);

      await db.query(
        'insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)',
        [
          secondUserId,
          secondEmail,
          JSON.stringify({ role: 'super_admin', is_super_admin: true, permissions: ['*'] }),
        ],
      );
      const later = (
        await db.query(
          `select u.email_confirmed_at, p.approval_status,
          (select count(*)::int from public.user_roles where user_id=u.id) as role_count
          from auth.users u join public.profiles p on p.id=u.id where u.id=$1`,
          [secondUserId],
        )
      ).rows[0];
      assert.equal(later.approval_status, 'pending');
      assert.equal(later.role_count, 0);
      assert.equal(later.email_confirmed_at, null);

      // Same transaction sees these uncommitted signup rows. RLS must block
      // sensitive data, but allow a pending actor to inspect their own status.
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [secondUserId]);
      await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      assert.equal(
        (await db.query('select count(*)::int as count from public.roles')).rows[0].count,
        0,
      );
      assert.equal(
        (await db.query('select count(*)::int as count from public.workspaces')).rows[0].count,
        0,
      );
      assert.deepEqual(
        (await db.query('select approval_status from public.profiles')).rows.map(
          (r) => r.approval_status,
        ),
        ['pending'],
      );
      assert.equal(
        (await db.query('select public.get_my_capabilities() as caps')).rows[0].caps.length,
        0,
      );
      await db.query('reset role');
      // Direct API callers cannot invoke the service-only approval RPC.
      assert.equal(
        (
          await db.query(
            "select has_function_privilege('authenticated', 'public.admin_approve_user(uuid,varchar,uuid)', 'execute') as allowed",
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await db.query(
            "select has_column_privilege('authenticated', 'public.profiles', 'approval_status', 'update') as allowed",
          )
        ).rows[0].allowed,
        false,
      );
      await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
      await db.query('savepoint invalid_approval');
      await expectCode('42501', () =>
        db.query("select public.admin_approve_user($1, 'approve', $2)", [
          secondUserId,
          secondUserId,
        ]),
      );
      await db.query('rollback to savepoint invalid_approval');
      await db.query("select public.admin_approve_user($1, 'approve', $2)", [
        secondUserId,
        firstUserId,
      ]);
      assert.equal(
        (await db.query('select approval_status from public.profiles where id=$1', [secondUserId]))
          .rows[0].approval_status,
        'approved',
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int as count from public.audit_logs where entity_id=$1 and metadata->>'event'='user.approval_approve'",
            [secondUserId],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await db.query('select count(*)::int as count from public.user_roles where user_id=$1', [
            secondUserId,
          ])
        ).rows[0].count,
        1,
      );

      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const helper of [
          'public.confirm_first_auth_user_email()',
          'public.handle_new_user()',
        ]) {
          const access = await db.query(
            "select has_function_privilege($1,$2,'execute') as allowed",
            [role, helper],
          );
          assert.equal(access.rows[0].allowed, false, `${role} must not execute ${helper}`);
        }
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const access = await db.query(
            "select has_table_privilege($1, 'public.first_admin_bootstrap_state', $2) as allowed",
            [role, privilege],
          );
          assert.equal(
            access.rows[0].allowed,
            false,
            `${role} must not have ${privilege} on signup state`,
          );
        }
      }

      const oldBootstrapRpcCount = Number(
        (
          await db.query(
            `select count(*)::int as n
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('bootstrap_first_super_admin','check_bootstrap_readiness')`,
          )
        ).rows[0].n,
      );
      assert.equal(oldBootstrapRpcCount, 0);
      // Validate deferred constraints, then roll back the synthetic first owner;
      // owner protection intentionally prevents even a SQL Editor delete.
      await db.query('set constraints all immediate');
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  await test('owner is protected and explicitly holds every permission while super_admin remains unchanged', async () => {
    const allPermissions = (
      await db.query('select slug from public.permissions order by slug')
    ).rows.map((row) => row.slug);
    const ownerPermissions = (
      await db.query(
        `select p.slug
           from public.roles r
           join public.role_permissions rp on rp.role_id = r.id
           join public.permissions p on p.id = rp.permission_id
          where r.slug = 'owner'
          order by p.slug`,
      )
    ).rows.map((row) => row.slug);
    assert.deepEqual(ownerPermissions, allPermissions);

    const protectedRoles = (
      await db.query('select slug from public.roles where is_super_admin order by slug')
    ).rows.map((row) => row.slug);
    assert.deepEqual(protectedRoles, ['owner', 'super_admin']);

    const superAdminWildcard = (
      await db.query(
        `select r.is_super_admin, bool_or(p.slug = '*') as has_wildcard
           from public.roles r
           join public.role_permissions rp on rp.role_id = r.id
           join public.permissions p on p.id = rp.permission_id
          where r.slug = 'super_admin'
          group by r.id`,
      )
    ).rows[0];
    assert.deepEqual(superAdminWildcard, { is_super_admin: true, has_wildcard: true });

    await db.query('begin');
    try {
      await db.query(
        "insert into public.permissions(slug,module,name_ar,name_en) values ('audit.owner.future_permission','audit','صلاحية لاحقة','Future owner permission')",
      );
      assert.equal(
        (
          await db.query(
            `select exists (
               select 1 from public.roles r
               join public.role_permissions rp on rp.role_id = r.id
               join public.permissions p on p.id = rp.permission_id
               where r.slug = 'owner' and p.slug = 'audit.owner.future_permission'
             ) as granted`,
          )
        ).rows[0].granted,
        true,
      );
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  await test('owner role, account, permissions and Auth identity reject SQL and RPC writes', async () => {
    const ownerId = randomUUID();
    const adminId = randomUUID();
    const approvalMigration = await readFile(
      `${ROOT}supabase/migrations/20261017010000_protect_original_owner.sql`,
      'utf8',
    );
    await db.query('begin');
    try {
      /* One row per statement: the first-owner trigger requires the claiming
         signup to be the sole Auth row at grant time (a multi-row INSERT trips
         the count guard before this test's owner claim can succeed). */
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        ownerId,
        `owner.${randomUUID()}@example.invalid`,
      ]);
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        adminId,
        `admin.${randomUUID()}@example.invalid`,
      ]);
      await db.query("update public.profiles set approval_status='approved' where id=$1", [
        adminId,
      ]);
      await db.query(
        "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
        [adminId],
      );
      assert.equal(
        (await db.query('select public.is_original_owner($1) as owner', [ownerId])).rows[0].owner,
        true,
      );

      async function rejected(sql, args = []) {
        await db.query('savepoint owner_attempt');
        await assert.rejects(
          db.query(sql, args),
          (error) => error.code === '42501' && error.message.includes('owner_protection'),
        );
        await db.query('rollback to savepoint owner_attempt');
      }
      await rejected(
        "update public.user_roles set role_id=(select id from public.roles where slug='viewer') where user_id=$1",
        [ownerId],
      );
      await rejected('delete from public.user_roles where user_id=$1', [ownerId]);
      await rejected("update public.profiles set status='suspended' where id=$1", [ownerId]);
      await rejected('delete from public.profiles where id=$1', [ownerId]);
      await rejected('delete from auth.users where id=$1', [ownerId]);
      await rejected(
        "delete from public.role_permissions where role_id=(select id from public.roles where slug='owner')",
      );
      await rejected("update public.roles set slug='former-owner' where slug='owner'");
      // Even the API's own row policies refuse changing the protected row.
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [adminId]);
      await db.query('savepoint owner_rls');
      try {
        const result = await db.query('delete from public.user_roles where user_id=$1', [ownerId]);
        assert.equal(result.rowCount, 0);
      } catch (error) {
        assert.equal(error.code, '42501');
        await db.query('rollback to savepoint owner_rls');
      }
      await db.query('reset role');
      await db.query('set local role service_role');
      await rejected("update public.profiles set status='suspended' where id=$1", [ownerId]);
      await db.query('reset role');

      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [adminId]);
      await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      await rejected("select public.admin_set_user_status($1,'suspended'::public.user_status)", [
        ownerId,
      ]);
      await rejected("select public.admin_set_user_roles($1,array['viewer']::text[])", [ownerId]);
      await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
      await rejected("select public.admin_approve_user($1,'reject',$2)", [ownerId, adminId]);
      await db.query(approvalMigration);
      assert.equal(
        (
          await db.query(
            'select p.status,p.approval_status,r.slug from public.profiles p join public.user_roles ur on ur.user_id=p.id join public.roles r on r.id=ur.role_id where p.id=$1',
            [ownerId],
          )
        ).rows[0].slug,
        'owner',
      );
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  await test('owner updates project settings and writes audit_logs atomically', async () => {
    const ownerId = randomUUID();
    await db.query('begin');
    try {
      // Create the owner through the real first-signup trigger while Auth is
      // empty, then roll the entire fixture and identity update back together.
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        ownerId,
        `project-owner.${randomUUID()}@example.invalid`,
      ]);
      assert.equal(
        (await db.query('select public.is_original_owner($1) as owner', [ownerId])).rows[0].owner,
        true,
      );
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
      await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");

      const before = await db.query(
        'select updated_at::text as updated_at from public.app_identity_settings where id=true',
      );
      const updated = await db.query(
        `select public.admin_update_project_settings(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
         ) as identity`,
        [
          'هوية المشروع المحدّثة',
          'Project Settings Audit',
          null,
          null,
          null,
          null,
          null,
          null,
          false,
          false,
          before.rows[0].updated_at,
        ],
      );
      assert.equal(updated.rows[0].identity.name_ar, 'هوية المشروع المحدّثة');
      assert.equal(updated.rows[0].identity.name_en, 'Project Settings Audit');

      const audit = await db.query(
        `select actor_id,action,entity,entity_id,metadata
           from public.audit_logs
          where actor_id=$1
            and entity='app_identity_settings'
            and entity_id='singleton'
            and metadata->>'event'='project.settings_updated'
          order by created_at desc
          limit 1`,
        [ownerId],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].action, 'settings.updated');
      assert.equal(audit.rows[0].metadata.after.name_ar, 'هوية المشروع المحدّثة');
      assert.ok(audit.rows[0].metadata.changed_fields.includes('name_ar'));
      assert.ok(audit.rows[0].metadata.changed_fields.includes('name_en'));

      await db.query('reset role');
      await db.query('set constraints all immediate');
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  // The following identities are synthetic audit fixtures in an isolated
  // database. Mark the first-signup claim closed, then let the real Auth
  // triggers create their profiles/default viewer assignments before the
  // tests install their explicit fixture roles.
  await db.query(
    'update public.first_admin_bootstrap_state set claimed=true, first_user_id=null, claimed_at=clock_timestamp() where singleton',
  );
  await db.query(
    'insert into auth.users(id, email) values ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)',
    [
      A,
      'audit-a@example.invalid',
      B,
      'audit-b@example.invalid',
      C,
      'audit-c@example.invalid',
      V,
      'audit-v@example.invalid',
      E,
      'audit-e@example.invalid',
    ],
  );
  await db.query("update public.profiles set approval_status='approved' where id=any($1::uuid[])", [
    [A, B, C, V, E],
  ]);
  await db.query(
    "insert into public.roles(slug,name_ar,name_en) values ('audit_admin','مدير فحص','Audit administrator')",
  );
  await db.query(
    "insert into public.role_permissions select r.id,p.id,now() from public.roles r cross join public.permissions p where r.slug='audit_admin' and p.slug='*'",
  );
  // A second role with notifications.manage ONLY: proves the capability split
  // (content editor without transport/credentials access — study D5).
  await db.query(
    "insert into public.roles(slug,name_ar,name_en) values ('audit_editor','محرر فحص','Audit content editor')",
  );
  await db.query(
    "insert into public.role_permissions select r.id,p.id,now() from public.roles r join public.permissions p on p.slug='notifications.manage' where r.slug='audit_editor'",
  );
  await db.query(
    "delete from public.user_roles where user_id = any($1::uuid[]) and role_id = (select id from public.roles where slug='viewer')",
    [[A, B, C, V, E]],
  );
  await db.query(
    "insert into public.user_roles(user_id,role_id) select t.uid,r.id from (values ($1::uuid,'super_admin'),($2::uuid,'super_admin'),($3::uuid,'audit_admin'),($4::uuid,'viewer'),($5::uuid,'audit_editor')) t(uid,slug) join public.roles r on r.slug=t.slug",
    [A, B, C, V, E],
  );
  const roleRows = (await db.query('select id,slug from public.roles')).rows;
  const roles = Object.fromEntries(roleRows.map((row) => [row.slug, row.id]));

  await test('project settings permission has explicit owner and super_admin grants only', async () => {
    const grants = await db.query(
      `select r.slug
         from public.role_permissions rp
         join public.roles r on r.id = rp.role_id
         join public.permissions p on p.id = rp.permission_id
        where p.slug = 'project.settings:manage'
        order by r.slug`,
    );
    assert.deepEqual(
      grants.rows.map((row) => row.slug),
      ['owner', 'super_admin'],
    );
  });

  await test('ordinary admin keeps legacy identity access but project settings RPC returns 42501', async () => {
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='admin' on conflict do nothing",
      [V],
    );
    try {
      const access = await asRole('authenticated', V, (c) =>
        c.query(
          `select public.can_manage_app_identity() as legacy_access,
                  public.can_manage_project_settings() as project_access`,
        ),
      );
      assert.equal(access.rows[0].legacy_access, true);
      assert.equal(access.rows[0].project_access, false);
      await expectCode('42501', () =>
        asRole('authenticated', V, (c) =>
          c.query("select public.admin_update_project_settings('تحديث ممنوع','Denied Admin')"),
        ),
      );
    } finally {
      await db.query('delete from public.user_roles where user_id=$1 and role_id=$2', [
        V,
        roles.admin,
      ]);
    }
  });

  await test('anonymous caller cannot execute project settings update RPC', async () => {
    await expectCode('42501', () =>
      asRole('anon', null, (c) =>
        c.query("select public.admin_update_project_settings('تحديث ممنوع','Denied Anonymous')"),
      ),
    );
  });

  await test('project settings execute grants allow authenticated only', async () => {
    const privileges = await db.query(
      `select has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
              has_function_privilege('anon',p.oid,'execute') as anon_execute,
              has_function_privilege('service_role',p.oid,'execute') as service_role_execute,
              exists(
                select 1 from aclexplode(p.proacl) as acl
                 where acl.grantee=0 and acl.privilege_type='EXECUTE'
              ) as public_execute
         from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname='admin_update_project_settings'`,
    );
    assert.equal(privileges.rowCount, 1);
    assert.equal(privileges.rows[0].authenticated_execute, true);
    assert.equal(privileges.rows[0].anon_execute, false);
    assert.equal(privileges.rows[0].service_role_execute, false);
    assert.equal(privileges.rows[0].public_execute, false);
  });

  await test('owner role cannot be granted to a second user via RPC or SQL', async () => {
    const firstOwnerId = randomUUID();
    const secondId = randomUUID();
    await db.query('begin');
    try {
      /* Fresh signups land as pending viewer holders once the first-signup
         claim is closed; approve them so the RPC target checks see ordinary
         active accounts. */
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        firstOwnerId,
        `b1.first.${randomUUID()}@example.invalid`,
      ]);
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        secondId,
        `b1.second.${randomUUID()}@example.invalid`,
      ]);
      await db.query(
        "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
        [[firstOwnerId, secondId]],
      );
      // The first-ever owner grant is the legitimate bootstrap shape: with no
      // holder in history the singleton trigger lets it through.
      await db.query(
        "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='owner'",
        [firstOwnerId],
      );
      assert.equal(
        (await db.query('select public.is_original_owner($1) as owner', [firstOwnerId])).rows[0]
          .owner,
        true,
      );

      async function rejectedOwnerGrant(sql, args = []) {
        await db.query('savepoint b1_attempt');
        await assert.rejects(
          db.query(sql, args),
          (error) => error.code === '42501' && error.message.includes('owner_protection'),
        );
        await db.query('rollback to savepoint b1_attempt');
      }

      // Direct SQL is refused by the singleton trigger — even for the table
      // owner, which bypasses RLS but never a trigger.
      await rejectedOwnerGrant(
        "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='owner'",
        [secondId],
      );

      // The RPC refuses 'owner' explicitly (42501), alone or smuggled inside
      // an otherwise valid set — never the misleading P0002 branch.
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [A]);
      await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      await rejectedOwnerGrant("select public.admin_set_user_roles($1,array['owner']::text[])", [
        secondId,
      ]);
      await rejectedOwnerGrant(
        "select public.admin_set_user_roles($1,array['viewer','owner']::text[])",
        [secondId],
      );

      // Positive control: the same RPC still grants ordinary roles (set
      // semantics replace the signup viewer default), and the only holder in
      // history keeps exactly the owner role.
      await db.query("select public.admin_set_user_roles($1,array['editor']::text[])", [secondId]);
      assert.deepEqual(
        (
          await db.query(
            `select r.slug from public.user_roles ur
               join public.roles r on r.id = ur.role_id
              where ur.user_id = $1 order by r.slug`,
            [secondId],
          )
        ).rows.map((row) => row.slug),
        ['editor'],
      );
      assert.deepEqual(
        (
          await db.query(
            `select ur.user_id from public.user_roles ur
               join public.roles r on r.id = ur.role_id
              where r.slug = 'owner' order by ur.user_id`,
          )
        ).rows.map((row) => row.user_id),
        [firstOwnerId],
      );
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  await test('delegated capabilities are scoped, audited, expiring and revoke immediately', async () => {
    const delegateId = randomUUID();
    const applicantId = randomUUID();
    const delegateEmail = `delegate.${delegateId}@example.invalid`;
    const resetRequestEmail = `reset.${delegateId}@example.invalid`;
    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      delegateId,
      delegateEmail,
      applicantId,
      `applicant.${applicantId}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [
      delegateId,
    ]);
    await db.query('insert into public.user_roles(user_id,role_id,granted_by) values ($1,$2,$3)', [
      delegateId,
      roles.viewer,
      B,
    ]);

    await expectCode('42501', () =>
      asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',null,$2)", [B, B]),
      ),
    );
    // Both slugs exist in the catalogue but can never be delegatable
    // (20261030000000): the refusal is capability_not_delegatable (42501).
    // It used to be the hardcoded allow-list's invalid_action (22023).
    for (const forbidden of ['*', 'roles.manage']) {
      await expectCode('42501', () =>
        asRole('service_role', B, (c) =>
          c.query('select public.admin_grant_capability($1,$2,null,$3)', [
            delegateId,
            forbidden,
            B,
          ]),
        ),
      );
    }
    await expectCode('42501', () =>
      asRole('service_role', delegateId, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',null,$2)", [
          V,
          delegateId,
        ]),
      ),
    );

    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const approvalGrantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',$2,$3) as id", [
          delegateId,
          futureExpiry,
          B,
        ]),
      )
    ).rows[0].id;
    const resetGrantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'password_reset.manage',null,$2) as id", [
          delegateId,
          B,
        ]),
      )
    ).rows[0].id;

    const effective = await asRole('authenticated', delegateId, (c) =>
      c.query(`select public.has_permission('users.approve') as can_approve,
                      public.has_permission('password_reset.manage') as can_reset,
                      public.is_admin() as is_admin,
                      public.get_my_capabilities() as capabilities`),
    );
    assert.equal(effective.rows[0].can_approve, true);
    assert.equal(effective.rows[0].can_reset, true);
    assert.equal(
      effective.rows[0].is_admin,
      false,
      'delegations never imply wildcard administration',
    );
    assert.ok(effective.rows[0].capabilities.includes('users.approve'));
    assert.ok(effective.rows[0].capabilities.includes('password_reset.manage'));

    const listed = await asRole('service_role', B, (c) =>
      c.query('select * from public.get_user_capabilities($1,$2)', [delegateId, B]),
    );
    assert.deepEqual(listed.rows.map((row) => row.permission_slug).sort(), [
      'password_reset.manage',
      'users.approve',
    ]);
    assert.equal(
      (
        await db.query(
          "select has_function_privilege('authenticated','public.get_user_capabilities(uuid,uuid)','EXECUTE') as allowed",
        )
      ).rows[0].allowed,
      false,
      'user-capability administration RPCs must remain service-role only',
    );

    const resetRequestId = (
      await db.query('insert into public.password_reset_requests(email) values ($1) returning id', [
        resetRequestEmail,
      ])
    ).rows[0].id;
    const safeRows = await asRole('authenticated', delegateId, (c) =>
      c.query(
        'select id,email,created_at,status from public.password_reset_requests_safe where id=$1',
        [resetRequestId],
      ),
    );
    assert.equal(safeRows.rowCount, 1);
    assert.deepEqual(Object.keys(safeRows.rows[0]).sort(), ['created_at', 'email', 'id', 'status']);
    await expectCode('42501', () =>
      asRole('authenticated', delegateId, (c) =>
        c.query('select id from public.password_reset_requests limit 1'),
      ),
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='password_reset_requests' and column_name='new_password'",
        )
      ).rows[0].n,
      0,
      'plaintext password column must be physically absent',
    );
    assert.deepEqual(
      (
        await db.query(
          "select array_agg(column_name::text order by ordinal_position) as columns from information_schema.columns where table_schema='public' and table_name='password_reset_requests_safe'",
        )
      ).rows[0].columns,
      ['id', 'email', 'created_at', 'status'],
    );

    const applicantQueue = await asRole('service_role', B, (c) =>
      c.query('select * from public.get_approval_queue($1) where id=$2', [delegateId, applicantId]),
    );
    assert.equal(
      applicantQueue.rowCount,
      1,
      'delegate sees the pending queue through the limited RPC',
    );
    await expectCode('42501', () =>
      asRole('service_role', B, (c) =>
        c.query("select public.admin_approve_user($1,'approve',$2,'editor')", [
          applicantId,
          delegateId,
        ]),
      ),
    );
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_approve_user($1,'approve',$2,'viewer')", [
        applicantId,
        delegateId,
      ]),
    );
    assert.equal(
      (
        await db.query(
          'select r.slug from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=$1',
          [applicantId],
        )
      ).rows[0].slug,
      'viewer',
      'delegated approver can only assign viewer',
    );

    await asRole('service_role', B, (c) =>
      c.query('select public.admin_revoke_capability($1,$2)', [approvalGrantId, B]),
    );
    const afterRevoke = await asRole('authenticated', delegateId, (c) =>
      c.query(`select public.has_permission('users.approve') as can_approve,
                      public.is_admin() as is_admin`),
    );
    assert.equal(afterRevoke.rows[0].can_approve, false);
    assert.equal(afterRevoke.rows[0].is_admin, false);

    const expiringGrantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',$2,$3) as id", [
          delegateId,
          futureExpiry,
          B,
        ]),
      )
    ).rows[0].id;
    await db.query(
      "update public.user_capabilities set expires_at=now()-interval '1 second' where id=$1",
      [expiringGrantId],
    );
    const afterExpiry = await asRole('authenticated', delegateId, (c) =>
      c.query("select public.has_permission('users.approve') as can_approve"),
    );
    assert.equal(afterExpiry.rows[0].can_approve, false, 'expired grants are ineffective');
    const renewedGrantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',$2,$3) as id", [
          delegateId,
          futureExpiry,
          B,
        ]),
      )
    ).rows[0].id;
    await db.query(
      "update public.user_capabilities set expires_at=now()-interval '1 second' where id=$1",
      [renewedGrantId],
    );
    const afterRenewalExpiry = await asRole('authenticated', delegateId, (c) =>
      c.query("select public.has_permission('users.approve') as can_approve"),
    );
    assert.equal(afterRenewalExpiry.rows[0].can_approve, false);

    await asRole('service_role', B, (c) =>
      c.query('select public.admin_revoke_capability($1,$2)', [resetGrantId, B]),
    );
    const hiddenSafeRows = await asRole('authenticated', delegateId, (c) =>
      c.query('select id from public.password_reset_requests_safe where id=$1', [resetRequestId]),
    );
    assert.equal(hiddenSafeRows.rowCount, 0, 'revoking password_reset.manage closes the safe view');

    const events = (
      await db.query(
        "select metadata->>'event' as event from public.audit_logs where entity='user_capabilities' and actor_id=$1",
        [B],
      )
    ).rows.map((row) => row.event);
    assert.ok(events.includes('capability.granted'));
    assert.ok(events.includes('capability.revoked'));
    assert.ok(events.includes('capability.expired'));
  });

  await test('permission delegability is owner-configurable and enforced at grant time', async () => {
    const targetId = randomUUID();
    const secondTargetId = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      targetId,
      `delegable-target.${targetId}@example.invalid`,
      secondTargetId,
      `delegable-target2.${secondTargetId}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id=any($1::uuid[])",
      [[targetId, secondTargetId]],
    );
    await db.query(
      'insert into public.user_roles(user_id,role_id,granted_by) values ($1,$2,$3),($4,$2,$3)',
      [targetId, roles.viewer, B, secondTargetId],
    );

    // Seeded baseline: exactly the two historically hardcoded slugs are on.
    const flags = Object.fromEntries(
      (await db.query('select slug,is_delegatable from public.permissions')).rows.map((row) => [
        row.slug,
        row.is_delegatable,
      ]),
    );
    assert.equal(flags['settings.manage'], false);
    assert.equal(flags['users.approve'], true);
    assert.equal(flags['password_reset.manage'], true);
    assert.equal(flags['*'], false);
    assert.equal(flags['roles.manage'], false);

    // A permission that is not delegatable cannot be granted.
    await assert.rejects(
      () =>
        asRole('service_role', B, (c) =>
          c.query("select public.admin_grant_capability($1,'settings.manage',null,$2)", [
            targetId,
            B,
          ]),
        ),
      /capability_not_delegatable/,
    );

    // Protected permissions can never be made delegatable — neither through
    // the RPC nor through a direct table write as postgres: the trigger is
    // unconditional, with no trusted-context bypass.
    for (const protectedSlug of ['*', 'roles.manage']) {
      await assert.rejects(
        () =>
          asRole('service_role', B, (c) =>
            c.query('select public.admin_set_permission_delegatable($1,true,$2)', [
              protectedSlug,
              B,
            ]),
          ),
        /permission_is_protected/,
      );
      await assert.rejects(
        () =>
          db.query('update public.permissions set is_delegatable=true where slug=$1', [
            protectedSlug,
          ]),
        /permission_is_protected/,
      );
    }

    // The write path is owner/super_admin only: C holds '*' through a custom
    // role but is neither. And a browser caller cannot spoof the executor:
    // under a JWT, p_executor_id must equal auth.uid().
    await expectCode('42501', () =>
      asRole('service_role', C, (c) =>
        c.query("select public.admin_set_permission_delegatable('settings.manage',true,$1)", [C]),
      ),
    );
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query("select public.admin_set_permission_delegatable('settings.manage',true,$1)", [B]),
      ),
    );
    assert.equal(
      (
        await db.query(
          "select has_function_privilege('anon','public.admin_set_permission_delegatable(text,boolean,uuid)','EXECUTE') as allowed",
        )
      ).rows[0].allowed,
      false,
      'anon must never reach the delegability write RPC',
    );

    // The owner opts settings.manage in (browser path: authenticated with
    // executor = caller). The flip is audited once; re-asserting the same
    // state is an idempotent success without a duplicate audit row.
    const enabled = (
      await asRole('authenticated', B, (c) =>
        c.query(
          "select public.admin_set_permission_delegatable('settings.manage',true,$1) as result",
          [B],
        ),
      )
    ).rows[0].result;
    assert.deepEqual(enabled, {
      permission_slug: 'settings.manage',
      is_delegatable: true,
      changed: true,
    });
    const reasserted = (
      await asRole('service_role', B, (c) =>
        c.query(
          "select public.admin_set_permission_delegatable('settings.manage',true,$1) as result",
          [B],
        ),
      )
    ).rows[0].result;
    assert.equal(reasserted.changed, false);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where entity='permissions' and actor_id=$1 and metadata->>'event'='permission.delegatable_updated' and metadata->>'permission_slug'='settings.manage'",
          [B],
        )
      ).rows[0].n,
      1,
    );

    // Now the permission delegates like any other.
    const grantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'settings.manage',null,$2) as id", [
          targetId,
          B,
        ]),
      )
    ).rows[0].id;
    const grantedCaps = await asRole('authenticated', targetId, (c) =>
      c.query('select public.get_my_capabilities() as capabilities'),
    );
    assert.ok(grantedCaps.rows[0].capabilities.includes('settings.manage'));

    // Disabling stops NEW grants immediately but never retroactively revokes
    // a live one: grants end by revoke or expiry, not by a flag flip.
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_set_permission_delegatable('settings.manage',false,$1)", [B]),
    );
    const stillEffective = await asRole('authenticated', targetId, (c) =>
      c.query("select public.has_permission('settings.manage') as allowed"),
    );
    assert.equal(stillEffective.rows[0].allowed, true, 'flag flips never revoke live grants');
    // The read path must not mirror the flag either: the owner still sees
    // (and can revoke) the live grant after its permission was disabled.
    // (The pre-20261030000000 slug filter in get_user_capabilities hid any
    // grant outside the old hardcoded pair.)
    const listedWhileDisabled = await asRole('service_role', B, (c) =>
      c.query('select * from public.get_user_capabilities($1,$2)', [targetId, B]),
    );
    assert.ok(
      listedWhileDisabled.rows.some((row) => row.permission_slug === 'settings.manage'),
      'a live grant stays visible after its permission is disabled',
    );
    await assert.rejects(
      () =>
        asRole('service_role', B, (c) =>
          c.query("select public.admin_grant_capability($1,'settings.manage',null,$2)", [
            secondTargetId,
            B,
          ]),
        ),
      /capability_not_delegatable/,
    );

    // Unknown slugs keep the legacy invalid_capability channel on both RPCs.
    await expectCode('22023', () =>
      asRole('service_role', B, (c) =>
        c.query("select public.admin_set_permission_delegatable('no.such.permission',true,$1)", [
          B,
        ]),
      ),
    );
    await expectCode('22023', () =>
      asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'no.such.permission',null,$2)", [
          targetId,
          B,
        ]),
      ),
    );

    // Leave the fixture as found: flag off (already), grant revoked, users gone.
    await asRole('service_role', B, (c) =>
      c.query('select public.admin_revoke_capability($1,$2)', [grantId, B]),
    );
    await db.query('delete from auth.users where id=any($1::uuid[])', [[targetId, secondTargetId]]);
  });

  await test('delegable capabilities are absent from ordinary role defaults', async () => {
    const defaults = await db.query(
      `select r.slug as role_slug, p.slug as permission_slug
         from public.role_permissions rp
         join public.roles r on r.id = rp.role_id
         join public.permissions p on p.id = rp.permission_id
        where r.slug in ('admin', 'editor', 'executive', 'viewer')
          and p.slug in ('users.approve', 'password_reset.manage')
        order by r.slug, p.slug`,
    );
    assert.deepEqual(
      defaults.rows,
      [],
      'ordinary administrative roles must not inherit Phase 1 delegations',
    );
  });

  await test('capability grants require an active and approved target account', async () => {
    const targetId = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      targetId,
      `pending-capability.${targetId}@example.invalid`,
    ]);
    await expectCode('42501', () =>
      asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',null,$2)", [targetId, B]),
      ),
    );
    assert.equal(
      (
        await db.query('select count(*)::int as n from public.user_capabilities where user_id=$1', [
          targetId,
        ])
      ).rows[0].n,
      0,
    );
    await db.query('delete from auth.users where id=$1', [targetId]);
  });

  await test('delegated capabilities stop working when a user is suspended or unapproved', async () => {
    const targetId = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      targetId,
      `suspended-capability.${targetId}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [targetId]);
    await db.query('insert into public.user_roles(user_id,role_id,granted_by) values ($1,$2,$3)', [
      targetId,
      roles.viewer,
      B,
    ]);
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_grant_capability($1,'users.approve',null,$2)", [targetId, B]),
    );

    let effective = await asRole('authenticated', targetId, (c) =>
      c.query("select public.has_permission('users.approve') as allowed"),
    );
    assert.equal(effective.rows[0].allowed, true);
    await db.query("update public.profiles set status='suspended' where id=$1", [targetId]);
    effective = await asRole('authenticated', targetId, (c) =>
      c.query("select public.has_permission('users.approve') as allowed"),
    );
    assert.equal(effective.rows[0].allowed, false);

    await db.query(
      "update public.profiles set status='active', approval_status='rejected' where id=$1",
      [targetId],
    );
    effective = await asRole('authenticated', targetId, (c) =>
      c.query("select public.has_permission('users.approve') as allowed"),
    );
    assert.equal(effective.rows[0].allowed, false);
    await db.query('delete from auth.users where id=$1', [targetId]);
  });

  await test('non-owner callers cannot list or revoke capability grants', async () => {
    const targetId = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      targetId,
      `capability-read.${targetId}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [targetId]);
    await db.query('insert into public.user_roles(user_id,role_id,granted_by) values ($1,$2,$3)', [
      targetId,
      roles.viewer,
      B,
    ]);
    const grantId = (
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_grant_capability($1,'users.approve',null,$2) as id", [
          targetId,
          B,
        ]),
      )
    ).rows[0].id;

    await expectCode('42501', () =>
      asRole('service_role', V, (c) =>
        c.query('select * from public.get_user_capabilities($1,$2)', [targetId, V]),
      ),
    );
    await expectCode('42501', () =>
      asRole('service_role', V, (c) =>
        c.query('select public.admin_revoke_capability($1,$2)', [grantId, V]),
      ),
    );
    await asRole('service_role', B, (c) =>
      c.query('select public.admin_revoke_capability($1,$2)', [grantId, B]),
    );
    await db.query('delete from auth.users where id=$1', [targetId]);
  });

  await test('D5 removes plaintext storage and denies API reads of the reset base table', async () => {
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='password_reset_requests' and column_name='new_password'",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await db.query(
          "select array_agg(e.enumlabel::text order by e.enumsortorder) as labels from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='password_reset_request_status'",
        )
      ).rows[0].labels,
      ['awaiting_password', 'pending_approval', 'approved', 'rejected'],
    );
    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        (
          await db.query(
            "select has_table_privilege($1,'public.password_reset_requests','SELECT') as allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
        `${role} must not select the raw reset-request table`,
      );
    }
    assert.equal(
      (
        await db.query(
          "select to_regprocedure('public.admin_claim_password_reset_request(uuid,uuid)') is null as removed",
        )
      ).rows[0].removed,
      true,
      'legacy secret-reading claim RPC must be removed',
    );
  });

  await test('approval grants the chosen non-protected role and refuses protected roles', async () => {
    const applicant = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      applicant,
      `rolepick.${applicant}@example.invalid`,
    ]);
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'pending',
    );
    // Protected roles can never be granted at approval time (invalid_role).
    for (const protectedRole of ['super_admin', 'owner', 'no_such_role']) {
      await expectCode('22023', () =>
        asRole('service_role', B, (c) =>
          c.query("select public.admin_approve_user($1, 'approve', $2, $3)", [
            applicant,
            B,
            protectedRole,
          ]),
        ),
      );
    }
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'pending',
    );
    // The chosen non-protected role is granted in the same transaction.
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_approve_user($1, 'approve', $2, $3)", [applicant, B, 'editor']),
    );
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'approved',
    );
    assert.deepEqual(
      (
        await db.query(
          'select r.slug from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1',
          [applicant],
        )
      ).rows.map((row) => row.slug),
      ['editor'],
    );
    const audit = (
      await db.query(
        "select metadata from public.audit_logs where entity_id=$1 and metadata->>'event'='user.approval_approve'",
        [applicant],
      )
    ).rows[0];
    assert.equal(audit.metadata.granted_role, 'editor');
    // The legacy 3-arg overload keeps its signature and viewer default.
    const later = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      later,
      `legacy.${later}@example.invalid`,
    ]);
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_approve_user($1, 'approve', $2)", [later, B]),
    );
    assert.deepEqual(
      (
        await db.query(
          'select r.slug from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1',
          [later],
        )
      ).rows.map((row) => row.slug),
      ['viewer'],
    );
    await db.query('delete from auth.users where id = any($1::uuid[])', [[applicant, later]]);
  });

  await test('only owner/super_admin may approve; viewer is denied; rejections are audited', async () => {
    const applicant = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      applicant,
      `pending.${applicant}@example.invalid`,
    ]);
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'pending',
    );
    await expectCode('42501', () =>
      asRole('service_role', V, (c) =>
        c.query("select public.admin_approve_user($1, 'approve', $2)", [applicant, V]),
      ),
    );
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_approve_user($1, 'reject', $2)", [applicant, B]),
    );
    const rejected = (
      await db.query('select approval_status from public.profiles where id=$1', [applicant])
    ).rows[0];
    assert.equal(rejected.approval_status, 'rejected');
    const audit = (
      await db.query(
        "select actor_id,metadata->>'event' as event from public.audit_logs where entity_id=$1 and metadata->>'event'='user.approval_reject'",
        [applicant],
      )
    ).rows[0];
    assert.equal(audit.actor_id, B);
    assert.equal(audit.event, 'user.approval_reject');
    // Replay must not approve a rejected account or duplicate its event.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261017000000_add_user_approval_workflow.sql`,
        'utf8',
      ),
    );
    // The legacy replay replaces the approval overloads with their historical
    // bodies; restore the current lifecycle-aware wrappers before later checks.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261025000000_resolve_stale_notifications.sql`,
        'utf8',
      ),
    );
    // The legacy replay above also replaces reset RPCs with their pre-capability
    // bodies; restore the current schema contract under test.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261026000000_granular_role_delegation.sql`,
        'utf8',
      ),
    );
    // Re-apply the notification-recipient + owner-protection fix, whose
    // admin_approve_password_reset_request replacement the replay just reverted.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261102000000_fix_password_reset_notification_recipients.sql`,
        'utf8',
      ),
    );
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'rejected',
    );
    await db.query('delete from auth.users where id=$1', [applicant]);
  });

  await test('executive dashboard RPC is capability-gated and aggregate-only', async () => {
    // Anonymous callers never reach the body: EXECUTE is not granted to anon.
    await expectCode('42501', () =>
      asRole('anon', null, (c) => c.query('select public.get_executive_dashboard()')),
    );

    // The viewer holds the legacy `dashboard.view` only, which is a screen
    // grant, not a data grant. D2 keeps the indicators to executive/admin/owner.
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) => c.query('select public.get_executive_dashboard()')),
    );

    // A least-privilege executive: exactly one capability, `dashboard:read`.
    const executive = randomUUID();
    await db.query('insert into auth.users(id,email,last_sign_in_at) values ($1,$2,now())', [
      executive,
      `executive.${executive}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [
      executive,
    ]);
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='executive'",
      [executive],
    );

    try {
      // The parameter is bounded; free-form windows are refused before any scan.
      await expectCode('22023', () =>
        asRole('authenticated', executive, (c) =>
          c.query('select public.get_executive_dashboard(6)'),
        ),
      );

      // A hostile audit row: the raw metadata carries a password and an e-mail
      // address that must never survive into the response.
      const planted = await db.query(
        `insert into public.audit_logs(action,entity,entity_id,actor_id,metadata)
         values ('settings.updated','user',$1,$2,
                 jsonb_build_object('event','user.approval_approve',
                                    'new_password','never-return-me',
                                    'email','leak@example.invalid',
                                    'role_slugs',jsonb_build_array('viewer')))
         returning id`,
        [executive, executive],
      );

      const snapshot = (
        await asRole('authenticated', executive, (c) =>
          c.query('select public.get_executive_dashboard() as snapshot'),
        )
      ).rows[0].snapshot;

      assert.deepEqual(Object.keys(snapshot).sort(), [
        'daily_signups',
        'generated_at',
        'kpis',
        'recent_activity',
        'role_distribution',
        'timezone',
        'window_days',
      ]);
      /* The snapshot echoes the CONFIGURED project time zone (read live from
         app_settings); the dedicated timezone test below drives that value
         through three settings, so here we compare against the stored row
         rather than a hard-coded zone. */
      const configuredZone = (
        await db.query(
          "select nullif(btrim(coalesce(value #>> '{}', '')), '') as tz from public.app_settings where key = 'appearance.default_timezone'",
        )
      ).rows[0]?.tz;
      assert.equal(snapshot.timezone, configuredZone ?? 'UTC');
      assert.equal(snapshot.window_days, 30);
      assert.deepEqual(Object.keys(snapshot.kpis).sort(), [
        'pending_approvals',
        'pending_password_resets',
        'signed_in_today',
        'suspended_users',
        'total_users',
      ]);
      // The freshly signed-in executive is counted today (now() is "today"
      // in every zone, so this stays valid whatever zone is configured).
      assert.ok(snapshot.kpis.signed_in_today >= 1);
      // Every KPI is a JSON number, never a string or null.
      for (const value of Object.values(snapshot.kpis)) {
        assert.equal(typeof value, 'number');
      }

      // Zero-filled, project-timezone-bucketed, oldest → newest, exactly one
      // point per local calendar day.
      assert.equal(snapshot.daily_signups.length, 30);
      assert.equal(snapshot.daily_signups.at(-1).count >= 1, true);
      const days = snapshot.daily_signups.map((point) => point.day);
      assert.deepEqual(days, [...days].sort());
      assert.equal(new Set(days).size, 30);
      assert.match(days.at(-1), /^\d{4}-\d{2}-\d{2}$/);

      // Role distribution keeps the seeded role catalogue and never fabricates
      // a negative or missing count.
      assert.ok(snapshot.role_distribution.items.some((item) => item.slug === 'executive'));
      assert.equal(typeof snapshot.role_distribution.users_without_role, 'number');

      // The planted row surfaces as a translated event with sanitized labels,
      // while its raw metadata stays inside the database.
      const entry = snapshot.recent_activity.find(
        (item) => String(item.id) === String(planted.rows[0].id),
      );
      assert.ok(entry);
      assert.equal(entry.event, 'user.approval_approve');
      assert.deepEqual(entry.role_slugs, ['viewer']);
      assert.equal(entry.actor_kind, 'user');
      const serialized = JSON.stringify(snapshot);
      assert.equal(serialized.includes('never-return-me'), false);
      assert.equal(serialized.includes('leak@example.invalid'), false);
      assert.equal(serialized.includes('new_password'), false);
      assert.ok(snapshot.recent_activity.length <= 10);

      // A suspended account loses the indicators even though its role still
      // holds `dashboard:read`.
      await db.query("update public.profiles set status='suspended' where id=$1", [executive]);
      await expectCode('42501', () =>
        asRole('authenticated', executive, (c) =>
          c.query('select public.get_executive_dashboard()'),
        ),
      );
      await db.query("update public.profiles set status='active' where id=$1", [executive]);

      await db.query('delete from public.audit_logs where id=$1', [planted.rows[0].id]);
    } finally {
      await db.query('delete from auth.users where id=$1', [executive]);
    }
  });

  await test('executive dashboard honors the configured project timezone', async () => {
    // Caller: approved + active executive holding exactly dashboard:read, with
    // NO last_sign_in_at so it never pollutes the counts under test.
    const executive = randomUUID();
    const probe = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      executive,
      `tz-executive.${executive}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [
      executive,
    ]);
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='executive'",
      [executive],
    );

    /* The probe sits one minute after the EARLIER of today's two local
       midnights (UTC vs Asia/Riyadh, fixed UTC+3 with no DST). At any hour of
       the day, that instant is "today" in the zone whose day started first and
       "yesterday" in the other — so the expected deltas are deterministic
       whenever the audit runs, without freezing the clock. */
    const starts = (
      await db.query(
        `select ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC' as s_utc,
                ((now() at time zone 'Asia/Riyadh')::date)::timestamp
                  at time zone 'Asia/Riyadh' as s_riyadh`,
      )
    ).rows[0];
    const includingZone = starts.s_utc < starts.s_riyadh ? 'UTC' : 'Asia/Riyadh';
    const excludingZone = includingZone === 'UTC' ? 'Asia/Riyadh' : 'UTC';

    await db.query(
      `insert into auth.users(id,email,last_sign_in_at)
       values ($1,$2, least(
         ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC',
         ((now() at time zone 'Asia/Riyadh')::date)::timestamp at time zone 'Asia/Riyadh'
       ) + interval '1 minute')`,
      [probe, `tz-probe.${probe}@example.invalid`],
    );
    await db.query("update public.profiles set approval_status='approved' where id=$1", [probe]);
    // Same instant as profiles.created_at so the daily-signups bucketing is
    // exercised by the very same boundary.
    await db.query(
      `update public.profiles
          set created_at = (select last_sign_in_at from auth.users where id = $1)
        where id = $1`,
      [probe],
    );

    /* Neutralize fixture noise so the ONLY rows able to move between the two
       snapshots are the probe's (captured here, restored in `finally`):
       accounts created during the audit itself have created_at ≈ now() and
       would otherwise flip day buckets at boundary hours. */
    const savedSignIns = (
      await db.query('select id, last_sign_in_at from auth.users where last_sign_in_at is not null')
    ).rows;
    const savedCreations = (
      await db.query(
        "select id, created_at from public.profiles where created_at >= now() - interval '32 days'",
      )
    ).rows;

    const originalZoneRow = (
      await db.query(
        "select value from public.app_settings where key = 'appearance.default_timezone'",
      )
    ).rows[0];

    const setZone = (zone) =>
      db.query(
        `insert into public.app_settings (key, group_slug, value, is_public)
         values ('appearance.default_timezone', 'appearance', to_jsonb($1::text), true)
         on conflict (key) do update set value = excluded.value`,
        [zone],
      );
    const snapshotFor = async (zone) => {
      await setZone(zone);
      return (
        await asRole('authenticated', executive, (c) =>
          c.query('select public.get_executive_dashboard() as snapshot'),
        )
      ).rows[0].snapshot;
    };

    try {
      await db.query('update auth.users set last_sign_in_at = null where id <> $1', [probe]);
      await db.query(
        "update public.profiles set created_at = now() - interval '45 days' where id <> all($1::uuid[])",
        [[probe, executive]],
      );

      const included = await snapshotFor(includingZone);
      const excluded = await snapshotFor(excludingZone);

      // The response always echoes the zone that was applied.
      assert.equal(included.timezone, includingZone);
      assert.equal(excluded.timezone, excludingZone);

      // signed_in_today: the probe is "today" only in the including zone.
      assert.equal(
        included.kpis.signed_in_today,
        1,
        `probe must count as signed in today under ${includingZone}`,
      );
      assert.equal(
        excluded.kpis.signed_in_today,
        0,
        `probe must NOT count as signed in today under ${excludingZone}`,
      );

      // daily_signups: the probe moves between the today and yesterday
      // buckets with the setting (the caller, created ≈ now, is a constant
      // +1 in "today" under both).
      assert.equal(included.daily_signups.at(-1).count, excluded.daily_signups.at(-1).count + 1);
      assert.equal(included.daily_signups.at(-2).count, excluded.daily_signups.at(-2).count - 1);

      // The zone is read live: changing the setting again moves figures back.
      const switchedBack = await snapshotFor(includingZone);
      assert.equal(switchedBack.kpis.signed_in_today, 1);

      // A corrupt zone name can never take the dashboard down: UTC fallback,
      // and the echo says so loudly instead of silently mis-bucketing.
      const fallback = await snapshotFor('Mars/Olympus_Mons');
      assert.equal(fallback.timezone, 'UTC');
      assert.equal(
        fallback.kpis.signed_in_today,
        includingZone === 'UTC' ? 1 : 0,
        'an invalid zone must behave exactly like UTC',
      );
    } finally {
      if (originalZoneRow === undefined) {
        await db.query("delete from public.app_settings where key = 'appearance.default_timezone'");
      } else {
        await db.query(
          "update public.app_settings set value = $1::jsonb where key = 'appearance.default_timezone'",
          [JSON.stringify(originalZoneRow.value)],
        );
      }
      await db.query('update auth.users set last_sign_in_at = null');
      for (const saved of savedSignIns) {
        await db.query('update auth.users set last_sign_in_at = $2 where id = $1', [
          saved.id,
          saved.last_sign_in_at,
        ]);
      }
      for (const saved of savedCreations) {
        await db.query('update public.profiles set created_at = $2 where id = $1', [
          saved.id,
          saved.created_at,
        ]);
      }
      // The signup fan-out leaves owner copies keyed by related_id; the
      // accounts' own copies cascade with the auth.users deletes.
      await db.query('delete from public.user_notifications where related_id = any($1::uuid[])', [
        [probe, executive],
      ]);
      await db.query('delete from auth.users where id=$1', [probe]);
      await db.query('delete from auth.users where id=$1', [executive]);
    }
  });

  await test('executive dashboard grants visualisation to admin, not to viewer', async () => {
    // D2: the general administrator also sees the executive indicators; the
    // capability is what separates "can see the screen" from "can read the
    // figures". C is the wildcard audit_admin, A/B are super_admins, V is the
    // legacy viewer.
    const holders = (
      await db.query(
        `select r.slug
           from public.roles r
           join public.role_permissions rp on rp.role_id = r.id
           join public.permissions p on p.id = rp.permission_id
          where p.slug = 'dashboard:read'
          order by r.slug`,
      )
    ).rows.map((row) => row.slug);
    assert.ok(holders.includes('executive'));
    assert.ok(holders.includes('admin'));
    assert.ok(holders.includes('owner'));
    assert.equal(holders.includes('viewer'), false);
    assert.equal(holders.includes('editor'), false);

    // The migration is idempotent: replaying it must not duplicate grants.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261023000000_executive_dashboard_rpc.sql`,
        'utf8',
      ),
    );
    // Restore the post-migration reset lifecycle and its updated aggregate.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261026000000_granular_role_delegation.sql`,
        'utf8',
      ),
    );
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261029000000_executive_dashboard_project_timezone.sql`,
        'utf8',
      ),
    );
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261031000000_user_lifecycle_auto_suspend_and_kpis.sql`,
        'utf8',
      ),
    );
    // The 20261026 replay above reverts the reset-approval RPC; re-apply the
    // notification-recipient + owner-protection fix.
    await db.query(
      await readFile(
        `${ROOT}supabase/migrations/20261102000000_fix_password_reset_notification_recipients.sql`,
        'utf8',
      ),
    );
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from public.role_permissions rp
             join public.roles r on r.id = rp.role_id
             join public.permissions p on p.id = rp.permission_id
            where p.slug = 'dashboard:read' and r.slug = 'admin'`,
        )
      ).rows[0].n,
      1,
    );
  });

  await test('every migration and seed replay on PostgreSQL 17', async () => {
    // Keep this count in step with supabase/migrations/ so every forward-only
    // security migration is replayed from a clean PostgreSQL fixture.
    assert.equal(migrations.length, 53);
    assert.ok(migrations.includes('20261025000000_resolve_stale_notifications.sql'));
    assert.ok(migrations.includes('20261026000000_granular_role_delegation.sql'));
    assert.ok(
      migrations.includes(
        '20261027000000_resolve_approval_notifications_on_profile_transition.sql',
      ),
    );
    assert.ok(migrations.includes('20261028000000_user_notifications_replica_identity_full.sql'));
    assert.ok(migrations.includes('20261029000000_executive_dashboard_project_timezone.sql'));
    assert.ok(migrations.includes('20261030000000_permission_delegatable.sql'));
    assert.ok(migrations.includes('20261031000000_user_lifecycle_auto_suspend_and_kpis.sql'));
    assert.ok(migrations.includes('20261101000000_delegation_notifications_and_profile.sql'));
    assert.ok(migrations.includes('20261102000000_fix_password_reset_notification_recipients.sql'));
    assert.ok(migrations.includes('20261103000000_prevent_owner_role_reassignment.sql'));
    assert.ok(migrations.includes('20261104010000_add_project_settings_permission.sql'));
    assert.ok(migrations.includes('20261104020000_project_settings_access.sql'));
    assert.ok(migrations.includes('20261104030000_stations_and_warehouses.sql'));
    assert.ok(migrations.includes('20261104040000_classifications_schema.sql'));
    assert.ok(migrations.includes('20261105000000_classifications_unbounded_depth.sql'));
    assert.ok(migrations.includes('20261106000000_parties_schema.sql'));
    assert.ok(migrations.includes('20261107000000_parties_internal_no_credit_terms.sql'));
    assert.ok(
      migrations.includes('20261108000000_inbound_outbound_parties_and_sister_companies.sql'),
    );
    assert.ok(migrations.includes('20261109000000_parties_two_root_tree.sql'));
    assert.ok(migrations.includes('20261110000000_fiscal_years_and_opening_balances.sql'));
    assert.ok(migrations.includes('20261111000000_opening_balances_delete_audit.sql'));
    assert.ok(migrations.includes('20261112000000_opening_balances_freeze.sql'));
    assert.ok(migrations.includes('20261113000000_aps_letters.sql'));
    assert.ok(migrations.includes('20261001130000_core_security_hardening.sql'));
    assert.ok(migrations.includes('20261001140000_support_system_schema.sql'));
    assert.ok(migrations.includes('20261001160000_localization_system_schema.sql'));
    assert.ok(migrations.includes('20261002120000_notification_transports_and_secrets.sql'));
    assert.ok(migrations.includes('20261002150000_notification_templates_schema.sql'));
    // The super-admin security chain must always be present: without the
    // hardening step there is no is_super_admin column, and without the RBAC
    // baseline a cloud project has an empty roles table so no first
    // administrator can ever be granted. The owner migration follows that
    // baseline and must retain the original super_admin role.
    assert.ok(migrations.includes('20261005120000_harden_super_admin.sql'));
    assert.ok(migrations.includes('20261010120000_automated_super_admin_bootstrap.sql'));
    assert.ok(migrations.includes('20261010130000_seed_rbac_baseline.sql'));
    assert.ok(migrations.includes('20261012120000_harden_bootstrap_preflight_and_audit_logs.sql'));
    assert.ok(migrations.includes('20261016000000_first_signup_admin_and_retire_ci_backups.sql'));
    assert.ok(migrations.includes('20261016120000_add_owner_role_and_grant_all_permissions.sql'));
    assert.ok(migrations.includes('20261018120000_approval_role_selection.sql'));
    // The admin invite / password-reset RPCs are the only sanctioned path for
    // creating an account on someone's behalf and for setting another user's
    // password; both must survive a clean replay.
    assert.ok(migrations.includes('20261024000000_admin_invite_and_set_password.sql'));
    const legacyMetadata = (
      await db.query(
        "select metadata from public.audit_logs where entity_id='legacy-email-metadata'",
      )
    ).rows[0].metadata;
    assert.equal('target_email' in legacyMetadata, false);
    assert.equal('email' in legacyMetadata.nested, false);
    assert.equal(JSON.stringify(legacyMetadata).includes('legacy.owner@example.invalid'), false);
    assert.equal(legacyMetadata.note, 'Contact l***@example.invalid');
    // Replay order is the filename order, which is the order `db push` uses.
    assert.deepEqual(
      migrations,
      [...migrations].sort(),
      'migrations must be applied in filename order',
    );
    assert.equal(
      (Number((await db.query('show server_version_num')).rows[0].server_version_num) / 10000) | 0,
      17,
    );
  });
  await test('fiscal years derive names, rotate the active year, generate twelve months, and gate opening balances', async () => {
    const fiscalYearIds = [randomUUID(), randomUUID(), randomUUID()];
    const invalidYearId = randomUUID();
    const stationId = randomUUID();
    const warehouseId = randomUUID();
    const classificationId = randomUUID();
    let openingBalanceId = null;

    try {
      await db.query('insert into public.stations(id,name) values ($1,$2)', [
        stationId,
        `Fiscal audit station ${randomUUID()}`,
      ]);
      await db.query('insert into public.warehouses(id,station_id,name) values ($1,$2,$3)', [
        warehouseId,
        stationId,
        `Fiscal audit warehouse ${randomUUID()}`,
      ]);
      await db.query('insert into public.classifications(id,name) values ($1,$2)', [
        classificationId,
        `Fiscal audit classification ${randomUUID()}`,
      ]);

      const createFiscalYear = (id, startDate, endDate, isActive) =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.fiscal_years (id,name,start_date,end_date,is_active)
               values ($1,'client supplied name',$2::date,$3::date,$4)
               returning name,is_active,is_closed,supplements_open`,
            [id, startDate, endDate, isActive],
          ),
        );

      const firstYear = await createFiscalYear(fiscalYearIds[0], '2026-07-01', '2027-06-30', true);
      assert.deepEqual(firstYear.rows[0], {
        name: '2026-2027',
        is_active: true,
        is_closed: false,
        supplements_open: false,
      });

      const firstYearMonths = await db.query(
        `select month_number,name,start_date::text,end_date::text,current_period,is_closed
             from public.fiscal_months
            where fiscal_year_id=$1
            order by month_number`,
        [fiscalYearIds[0]],
      );
      assert.equal(firstYearMonths.rowCount, 12);
      assert.deepEqual(firstYearMonths.rows[0], {
        month_number: 1,
        name: 'يوليو 2026',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        current_period: 1,
        is_closed: false,
      });
      assert.deepEqual(firstYearMonths.rows[11], {
        month_number: 12,
        name: 'يونيو 2027',
        start_date: '2027-06-01',
        end_date: '2027-06-30',
        current_period: 1,
        is_closed: false,
      });

      await createFiscalYear(fiscalYearIds[1], '2027-07-01', '2028-06-30', false);
      const activatedByUpdate = await asRole('authenticated', A, (c) =>
        c.query(
          'update public.fiscal_years set is_active=true where id=$1 returning name,is_active',
          [fiscalYearIds[1]],
        ),
      );
      assert.deepEqual(activatedByUpdate.rows[0], { name: '2027-2028', is_active: true });

      const thirdYear = await createFiscalYear(fiscalYearIds[2], '2028-07-01', '2029-06-30', true);
      assert.equal(thirdYear.rows[0].name, '2028-2029');
      const activeYears = await db.query(
        'select id,name from public.fiscal_years where is_active order by name',
      );
      assert.deepEqual(activeYears.rows, [{ id: fiscalYearIds[2], name: '2028-2029' }]);
      const allYearMonthCounts = await db.query(
        `select fiscal_year_id,count(*)::int as month_count
             from public.fiscal_months
            where fiscal_year_id=any($1::uuid[])
            group by fiscal_year_id`,
        [fiscalYearIds],
      );
      assert.equal(allYearMonthCounts.rowCount, 3);
      assert.ok(allYearMonthCounts.rows.every((row) => row.month_count === 12));

      await expectCode('23514', () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.fiscal_years(id,name,start_date,end_date)
               values ($1,'invalid date range','2030-01-01','2030-01-01')`,
            [invalidYearId],
          ),
        ),
      );

      const insertedBalance = await asRole('authenticated', A, (c) =>
        c.query(
          `insert into public.opening_balances
               (fiscal_year_id,warehouse_id,classification_id,amount)
             values ($1,$2,$3,123.45)
             returning id,amount::text`,
          [fiscalYearIds[0], warehouseId, classificationId],
        ),
      );
      openingBalanceId = insertedBalance.rows[0].id;
      assert.equal(insertedBalance.rows[0].amount, '123.45');

      await expectCode('23505', () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.opening_balances
                 (fiscal_year_id,warehouse_id,classification_id,amount)
               values ($1,$2,$3,9.99)`,
            [fiscalYearIds[0], warehouseId, classificationId],
          ),
        ),
      );
      await expectCode('23514', () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.opening_balances
                 (fiscal_year_id,warehouse_id,classification_id,amount)
               values ($1,$2,$3,-0.01)`,
            [fiscalYearIds[1], warehouseId, classificationId],
          ),
        ),
      );

      const updatedBalance = await asRole('authenticated', A, (c) =>
        c.query(
          'update public.opening_balances set amount=234.56 where id=$1 returning amount::text',
          [openingBalanceId],
        ),
      );
      assert.deepEqual(updatedBalance.rows, [{ amount: '234.56' }]);

      const balanceAudit = await db.query(
        `select actor_id,action,entity,entity_id,metadata
             from public.audit_logs
            where entity='opening_balances' and entity_id=$1
              and action='opening_balance.updated'::public.audit_action
            order by id`,
        [openingBalanceId],
      );
      assert.equal(balanceAudit.rowCount, 2, 'both INSERT and UPDATE are audited');
      assert.deepEqual(
        balanceAudit.rows.map((row) => ({
          actor_id: row.actor_id,
          action: row.action,
          entity: row.entity,
          entity_id: row.entity_id,
          fiscal_year_id: row.metadata.fiscal_year_id,
          warehouse_id: row.metadata.warehouse_id,
          classification_id: row.metadata.classification_id,
          old_amount: row.metadata.old_amount,
          new_amount: row.metadata.new_amount,
        })),
        [
          {
            actor_id: A,
            action: 'opening_balance.updated',
            entity: 'opening_balances',
            entity_id: openingBalanceId,
            fiscal_year_id: fiscalYearIds[0],
            warehouse_id: warehouseId,
            classification_id: classificationId,
            old_amount: null,
            new_amount: 123.45,
          },
          {
            actor_id: A,
            action: 'opening_balance.updated',
            entity: 'opening_balances',
            entity_id: openingBalanceId,
            fiscal_year_id: fiscalYearIds[0],
            warehouse_id: warehouseId,
            classification_id: classificationId,
            old_amount: 123.45,
            new_amount: 234.56,
          },
        ],
      );

      // Deletion must be audited with the amount that was removed: the row is
      // gone, so the audit entry is the only remaining record of it.
      const deleteTarget = await asRole('authenticated', A, (c) =>
        c.query(
          `insert into public.opening_balances
               (fiscal_year_id,warehouse_id,classification_id,amount)
             values ($1,$2,$3,77.70)
             returning id`,
          [fiscalYearIds[1], warehouseId, classificationId],
        ),
      );
      const deleteTargetId = deleteTarget.rows[0].id;

      // A caller without project.settings:manage is filtered by RLS: the
      // statement succeeds with zero rows and the row survives.
      const viewerDelete = await asRole('authenticated', V, (c) =>
        c.query('delete from public.opening_balances where id=$1 returning id', [deleteTargetId]),
      );
      assert.equal(viewerDelete.rowCount, 0, 'viewer delete must be filtered by RLS');
      assert.equal(
        (await db.query('select id from public.opening_balances where id=$1', [deleteTargetId]))
          .rowCount,
        1,
        'a filtered delete must not remove the row',
      );

      const deletedBalance = await asRole('authenticated', A, (c) =>
        c.query('delete from public.opening_balances where id=$1 returning id', [deleteTargetId]),
      );
      assert.equal(deletedBalance.rowCount, 1);
      assert.equal(
        (await db.query('select id from public.opening_balances where id=$1', [deleteTargetId]))
          .rowCount,
        0,
      );

      const deleteAudit = await db.query(
        `select actor_id,action,entity,entity_id,metadata
             from public.audit_logs
            where entity='opening_balances' and entity_id=$1
            order by id`,
        [deleteTargetId],
      );
      assert.deepEqual(
        deleteAudit.rows.map((row) => ({
          actor_id: row.actor_id,
          action: row.action,
          entity: row.entity,
          entity_id: row.entity_id,
          classification_id: row.metadata.classification_id,
          old_amount: row.metadata.old_amount,
          new_amount: row.metadata.new_amount,
        })),
        [
          {
            actor_id: A,
            action: 'opening_balance.updated',
            entity: 'opening_balances',
            entity_id: deleteTargetId,
            classification_id: classificationId,
            old_amount: null,
            new_amount: 77.7,
          },
          {
            actor_id: A,
            action: 'opening_balance.deleted',
            entity: 'opening_balances',
            entity_id: deleteTargetId,
            classification_id: classificationId,
            old_amount: 77.7,
            new_amount: null,
          },
        ],
        'INSERT and DELETE are both audited, with the removed amount preserved',
      );

      const deleteTrigger = await db.query(
        `select (tgtype & 8) = 8 as listens_to_delete,
                (tgtype & 1) = 1 as is_row_level,
                (tgtype & 2) = 0 as is_after
           from pg_trigger
          where tgrelid='public.opening_balances'::regclass
            and tgname='opening_balances_audit_write'`,
      );
      assert.deepEqual(deleteTrigger.rows, [
        { listens_to_delete: true, is_row_level: true, is_after: true },
      ]);

      for (const [table, policyPrefix] of [
        ['fiscal_years', 'fiscal_years_project_settings_'],
        ['fiscal_months', 'fiscal_months_project_settings_'],
        ['opening_balances', 'opening_balances_project_settings_'],
      ]) {
        const flags = await db.query(
          'select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass',
          [`public.${table}`],
        );
        assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
        const policies = await db.query(
          `select polname,polpermissive from pg_policy
              where polrelid=$1::regclass and polname like $2 order by polname`,
          [`public.${table}`, `${policyPrefix}%`],
        );
        assert.deepEqual(
          policies.rows,
          ['delete', 'insert', 'select', 'update'].map((command) => ({
            polname: `${policyPrefix}${command}`,
            polpermissive: true,
          })),
        );
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal(
            (
              await db.query('select has_table_privilege($1,$2,$3) as allowed', [
                'authenticated',
                `public.${table}`,
                privilege,
              ])
            ).rows[0].allowed,
            true,
            `authenticated must have ${privilege} on public.${table}`,
          );
          assert.equal(
            (
              await db.query('select has_table_privilege($1,$2,$3) as allowed', [
                'anon',
                `public.${table}`,
                privilege,
              ])
            ).rows[0].allowed,
            false,
            `anon must not have ${privilege} on public.${table}`,
          );
        }
      }

      const viewerCapability = await asRole('authenticated', V, (c) =>
        c.query('select public.can_manage_project_settings() as allowed'),
      );
      assert.equal(viewerCapability.rows[0].allowed, false);
      for (const [table, idColumn, id] of [
        ['fiscal_years', 'id', fiscalYearIds[0]],
        ['fiscal_months', 'fiscal_year_id', fiscalYearIds[0]],
        ['opening_balances', 'id', openingBalanceId],
      ]) {
        const hidden = await asRole('authenticated', V, (c) =>
          c.query(`select * from public.${table} where ${idColumn}=$1`, [id]),
        );
        assert.equal(hidden.rowCount, 0, `viewer must not read public.${table}`);
      }

      const viewerYearUpdate = await asRole('authenticated', V, (c) =>
        c.query('update public.fiscal_years set is_closed=true where id=$1 returning id', [
          fiscalYearIds[0],
        ]),
      );
      assert.equal(viewerYearUpdate.rowCount, 0);
      const viewerMonthUpdate = await asRole('authenticated', V, (c) =>
        c.query(
          'update public.fiscal_months set current_period=2 where fiscal_year_id=$1 and month_number=1 returning id',
          [fiscalYearIds[0]],
        ),
      );
      assert.equal(viewerMonthUpdate.rowCount, 0);
      const viewerBalanceUpdate = await asRole('authenticated', V, (c) =>
        c.query('update public.opening_balances set amount=999 where id=$1 returning id', [
          openingBalanceId,
        ]),
      );
      assert.equal(viewerBalanceUpdate.rowCount, 0);
      await expectDenied(() =>
        asRole('authenticated', V, (c) =>
          c.query(
            `insert into public.fiscal_years(id,name,start_date,end_date)
               values ($1,'viewer attempt','2031-07-01','2032-06-30')`,
            [randomUUID()],
          ),
        ),
      );
      await expectDenied(() =>
        asRole('authenticated', V, (c) =>
          c.query(
            `insert into public.opening_balances
                 (fiscal_year_id,warehouse_id,classification_id,amount)
               values ($1,$2,$3,1.00)`,
            [fiscalYearIds[2], warehouseId, classificationId],
          ),
        ),
      );
    } finally {
      await db.query('delete from public.opening_balances where fiscal_year_id=any($1::uuid[])', [
        fiscalYearIds,
      ]);
      await db.query('delete from public.fiscal_years where id=any($1::uuid[])', [fiscalYearIds]);
      await db.query('delete from public.warehouses where id=$1', [warehouseId]);
      await db.query('delete from public.stations where id=$1', [stationId]);
      await db.query('delete from public.classifications where id=$1', [classificationId]);
    }
  });
  await test('opening-balance freeze: RLS refuses writes in a locked year and lock/unlock are audited', async () => {
    const yearIds = [randomUUID(), randomUUID()];
    const stationId = randomUUID();
    const warehouseId = randomUUID();
    const classificationIds = [randomUUID(), randomUUID()];

    try {
      await db.query('insert into public.stations(id,name) values ($1,$2)', [
        stationId,
        `Freeze audit station ${randomUUID()}`,
      ]);
      await db.query('insert into public.warehouses(id,station_id,name) values ($1,$2,$3)', [
        warehouseId,
        stationId,
        `Freeze audit warehouse ${randomUUID()}`,
      ]);
      for (const classificationId of classificationIds) {
        await db.query('insert into public.classifications(id,name) values ($1,$2)', [
          classificationId,
          `Freeze audit classification ${randomUUID()}`,
        ]);
      }

      // The column is boolean, not null and defaults to open.
      const column = await db.query(
        `select data_type,is_nullable,column_default
           from information_schema.columns
          where table_schema='public' and table_name='fiscal_years'
            and column_name='opening_balances_locked'`,
      );
      assert.deepEqual(column.rows, [
        { data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      ]);

      const createYear = (id, startDate, endDate) =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.fiscal_years (id,name,start_date,end_date)
               values ($1,'freeze audit',$2::date,$3::date)
               returning opening_balances_locked`,
            [id, startDate, endDate],
          ),
        );

      assert.deepEqual((await createYear(yearIds[0], '2036-07-01', '2037-06-30')).rows, [
        { opening_balances_locked: false },
      ]);
      assert.deepEqual((await createYear(yearIds[1], '2037-07-01', '2038-06-30')).rows, [
        { opening_balances_locked: false },
      ]);

      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('select public.is_opening_balances_locked($1) as locked', [yearIds[0]]),
          )
        ).rows[0].locked,
        false,
      );

      const inserted = await asRole('authenticated', A, (c) =>
        c.query(
          `insert into public.opening_balances
               (fiscal_year_id,warehouse_id,classification_id,amount)
             values ($1,$2,$3,100.00)
             returning id`,
          [yearIds[0], warehouseId, classificationIds[0]],
        ),
      );
      const balanceId = inserted.rows[0].id;

      /* A balance in the second, still-open year: the freeze must also stop a
         row being moved into the locked year. */
      const openYearBalance = await asRole('authenticated', A, (c) =>
        c.query(
          `insert into public.opening_balances
               (fiscal_year_id,warehouse_id,classification_id,amount)
             values ($1,$2,$3,20.00)
             returning id`,
          [yearIds[1], warehouseId, classificationIds[0]],
        ),
      );
      const openYearBalanceId = openYearBalance.rows[0].id;

      const locked = await asRole('authenticated', A, (c) =>
        c.query(
          'update public.fiscal_years set opening_balances_locked=true where id=$1 returning opening_balances_locked',
          [yearIds[0]],
        ),
      );
      assert.deepEqual(locked.rows, [{ opening_balances_locked: true }]);
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('select public.is_opening_balances_locked($1) as locked', [yearIds[0]]),
          )
        ).rows[0].locked,
        true,
      );

      // INSERT is refused outright: the candidate row violates the WITH CHECK.
      await expectCode('42501', () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `insert into public.opening_balances
                 (fiscal_year_id,warehouse_id,classification_id,amount)
               values ($1,$2,$3,5.00)`,
            [yearIds[0], warehouseId, classificationIds[1]],
          ),
        ),
      );

      // UPDATE and DELETE are filtered by the USING clause: zero rows, no error,
      // and — this is the part that matters — no change.
      const frozenUpdate = await asRole('authenticated', A, (c) =>
        c.query('update public.opening_balances set amount=999.99 where id=$1 returning id', [
          balanceId,
        ]),
      );
      assert.equal(frozenUpdate.rowCount, 0);
      assert.equal(
        (
          await db.query('select amount::text from public.opening_balances where id=$1', [
            balanceId,
          ])
        ).rows[0].amount,
        '100.00',
        'a filtered update in a locked year must not change the amount',
      );

      const frozenDelete = await asRole('authenticated', A, (c) =>
        c.query('delete from public.opening_balances where id=$1 returning id', [balanceId]),
      );
      assert.equal(frozenDelete.rowCount, 0);
      assert.equal(
        (await db.query('select id from public.opening_balances where id=$1', [balanceId]))
          .rowCount,
        1,
        'a filtered delete in a locked year must not remove the row',
      );

      // Moving a row *into* the locked year passes the USING clause (the source
      // year is open) and fails the WITH CHECK: a hard 42501, not a silent no-op.
      await expectCode('42501', () =>
        asRole('authenticated', A, (c) =>
          c.query('update public.opening_balances set fiscal_year_id=$1 where id=$2 returning id', [
            yearIds[0],
            openYearBalanceId,
          ]),
        ),
      );
      assert.equal(
        (
          await db.query('select fiscal_year_id from public.opening_balances where id=$1', [
            openYearBalanceId,
          ])
        ).rows[0].fiscal_year_id,
        yearIds[1],
      );

      // The lock itself is audited once, with the transition it recorded.
      const lockAudit = await db.query(
        `select actor_id,action,entity,entity_id,metadata
           from public.audit_logs
          where entity='fiscal_years' and entity_id=$1
          order by id`,
        [yearIds[0]],
      );
      assert.deepEqual(
        lockAudit.rows.map((row) => ({
          actor_id: row.actor_id,
          action: row.action,
          entity: row.entity,
          entity_id: row.entity_id,
          metadata: row.metadata,
        })),
        [
          {
            actor_id: A,
            action: 'fiscal_year.opening_balances_locked',
            entity: 'fiscal_years',
            entity_id: yearIds[0],
            metadata: { fiscal_year_id: yearIds[0], old_value: false, new_value: true },
          },
        ],
      );

      // Any other column must not look like a freeze event, and a viewer may
      // neither lock nor unlock.
      await asRole('authenticated', A, (c) =>
        c.query('update public.fiscal_years set is_closed=true where id=$1', [yearIds[0]]),
      );
      const viewerUnlock = await asRole('authenticated', V, (c) =>
        c.query(
          'update public.fiscal_years set opening_balances_locked=false where id=$1 returning id',
          [yearIds[0]],
        ),
      );
      assert.equal(viewerUnlock.rowCount, 0);
      assert.equal(
        (
          await db.query('select opening_balances_locked from public.fiscal_years where id=$1', [
            yearIds[0],
          ])
        ).rows[0].opening_balances_locked,
        true,
        'a viewer must not be able to unlock the year',
      );
      assert.equal(
        (
          await db.query(
            `select count(*)::int as n from public.audit_logs
              where entity='fiscal_years' and entity_id=$1`,
            [yearIds[0]],
          )
        ).rows[0].n,
        1,
        'is_closed and a filtered viewer update must not write freeze audit rows',
      );

      const unlocked = await asRole('authenticated', A, (c) =>
        c.query(
          'update public.fiscal_years set opening_balances_locked=false where id=$1 returning opening_balances_locked',
          [yearIds[0]],
        ),
      );
      assert.deepEqual(unlocked.rows, [{ opening_balances_locked: false }]);

      const unlockedAudit = await db.query(
        `select actor_id,action,entity,entity_id,metadata
           from public.audit_logs
          where entity='fiscal_years' and entity_id=$1
          order by id`,
        [yearIds[0]],
      );
      assert.equal(unlockedAudit.rowCount, 2);
      assert.deepEqual(
        {
          action: unlockedAudit.rows[1].action,
          actor_id: unlockedAudit.rows[1].actor_id,
          metadata: unlockedAudit.rows[1].metadata,
        },
        {
          action: 'fiscal_year.opening_balances_unlocked',
          actor_id: A,
          metadata: { fiscal_year_id: yearIds[0], old_value: true, new_value: false },
        },
      );

      // Reopened means writable again, through the same policies.
      const reopenedUpdate = await asRole('authenticated', A, (c) =>
        c.query(
          'update public.opening_balances set amount=456.78 where id=$1 returning amount::text',
          [balanceId],
        ),
      );
      assert.deepEqual(reopenedUpdate.rows, [{ amount: '456.78' }]);
      const reopenedInsert = await asRole('authenticated', A, (c) =>
        c.query(
          `insert into public.opening_balances
               (fiscal_year_id,warehouse_id,classification_id,amount)
             values ($1,$2,$3,7.25)
             returning amount::text`,
          [yearIds[0], warehouseId, classificationIds[1]],
        ),
      );
      assert.deepEqual(reopenedInsert.rows, [{ amount: '7.25' }]);

      const policies = await db.query(
        `select policyname,qual,with_check
           from pg_catalog.pg_policies
          where schemaname='public' and tablename='opening_balances'
          order by policyname`,
      );
      const byName = new Map(policies.rows.map((row) => [row.policyname, row]));
      const qual = (name) => String(byName.get(name)?.qual ?? '');
      const withCheck = (name) => String(byName.get(name)?.with_check ?? '');

      for (const name of [
        'opening_balances_project_settings_select',
        'opening_balances_project_settings_insert',
        'opening_balances_project_settings_update',
        'opening_balances_project_settings_delete',
      ]) {
        assert.ok(byName.has(name), `${name} is missing`);
      }
      assert.equal(
        qual('opening_balances_project_settings_select').includes('is_opening_balances_locked'),
        false,
        'a locked year must stay readable',
      );
      assert.equal(withCheck('opening_balances_project_settings_select'), '');
      for (const name of [
        'opening_balances_project_settings_insert',
        'opening_balances_project_settings_update',
      ]) {
        assert.ok(
          withCheck(name).includes('can_manage_project_settings'),
          `${name} keeps the capability predicate`,
        );
      }
      assert.ok(
        qual('opening_balances_project_settings_delete').includes('can_manage_project_settings'),
        'the delete policy keeps the capability predicate',
      );
      assert.ok(
        withCheck('opening_balances_project_settings_insert').includes(
          'is_opening_balances_locked',
        ),
      );
      assert.equal(qual('opening_balances_project_settings_insert'), '');
      for (const name of [
        'opening_balances_project_settings_update',
        'opening_balances_project_settings_delete',
      ]) {
        assert.ok(
          qual(name).includes('is_opening_balances_locked'),
          `${name} must refuse closed-year writes through USING`,
        );
      }
      assert.ok(
        withCheck('opening_balances_project_settings_update').includes(
          'is_opening_balances_locked',
        ),
        'an update must not move a row into a locked year',
      );
      assert.equal(withCheck('opening_balances_project_settings_delete'), '');

      const privileges = await db.query(
        `select has_function_privilege('authenticated','public.is_opening_balances_locked(uuid)','EXECUTE') as authenticated_can,
                has_function_privilege('anon','public.is_opening_balances_locked(uuid)','EXECUTE') as anon_can,
                has_function_privilege('authenticated','public.audit_opening_balances_lock_change()','EXECUTE') as trigger_can`,
      );
      assert.deepEqual(privileges.rows, [
        { authenticated_can: true, anon_can: false, trigger_can: false },
      ]);

      const trigger = await db.query(
        `select (tgtype & 1) = 1 as is_row,
                (tgtype & 2) = 0 as is_after,
                (tgtype & 16) = 16 as is_update,
                (tgtype & 8) = 0 as not_delete,
                pg_get_triggerdef(oid) as definition
           from pg_trigger
          where tgrelid='public.fiscal_years'::regclass
            and tgname='fiscal_years_audit_opening_balances_lock'`,
      );
      assert.deepEqual(
        trigger.rows.map(({ definition: _definition, ...rest }) => rest),
        [{ is_row: true, is_after: true, is_update: true, not_delete: true }],
      );
      assert.ok(trigger.rows[0].definition.includes('UPDATE OF opening_balances_locked'));
      assert.ok(trigger.rows[0].definition.includes('WHEN'));
    } finally {
      await db.query('delete from public.opening_balances where fiscal_year_id=any($1::uuid[])', [
        yearIds,
      ]);
      await db.query('delete from public.fiscal_years where id=any($1::uuid[])', [yearIds]);
      await db.query('delete from public.warehouses where id=$1', [warehouseId]);
      await db.query('delete from public.stations where id=$1', [stationId]);
      await db.query('delete from public.classifications where id=any($1::uuid[])', [
        classificationIds,
      ]);
    }
  });

  // ---------------------------------------------------------------------------
  // APS letters (20261113000000_aps_letters.sql)
  // ---------------------------------------------------------------------------
  const seedApsLetters = async () => {
    const stationId = randomUUID();
    const warehouseId = randomUUID();
    const leafA = randomUUID();
    const leafB = randomUUID();
    await db.query('insert into public.stations(id,name) values ($1,$2)', [
      stationId,
      `APS audit station ${randomUUID()}`,
    ]);
    await db.query('insert into public.warehouses(id,station_id,name) values ($1,$2,$3)', [
      warehouseId,
      stationId,
      `APS audit warehouse ${randomUUID()}`,
    ]);
    await db.query('insert into public.classifications(id,name) values ($1,$2),($3,$4)', [
      leafA,
      `APS audit leaf A ${randomUUID()}`,
      leafB,
      `APS audit leaf B ${randomUUID()}`,
    ]);
    const party = (
      await asRole('authenticated', A, (c) =>
        c.query("insert into public.parties(branch,name) values ('inbound',$1) returning id,code", [
          `APS audit supplier ${randomUUID()}`,
        ]),
      )
    ).rows[0];
    const partyOut = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "insert into public.parties(branch,name) values ('outbound',$1) returning id,code",
          [`APS audit customer ${randomUUID()}`],
        ),
      )
    ).rows[0];
    const sister = (
      await asRole('authenticated', A, (c) =>
        c.query('insert into public.sister_companies(name,level) values ($1,1) returning id,code', [
          `APS audit sister ${randomUUID()}`,
        ]),
      )
    ).rows[0];
    const firstYear = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "insert into public.fiscal_years(start_date,end_date) values ('2040-07-01','2041-06-30') returning id,name",
        ),
      )
    ).rows[0];
    const secondYear = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "insert into public.fiscal_years(start_date,end_date) values ('2041-07-01','2042-06-30') returning id,name",
        ),
      )
    ).rows[0];
    return {
      stationId,
      warehouseId,
      leafA,
      leafB,
      party,
      partyOut,
      sister,
      firstYear,
      secondYear,
    };
  };

  const insertApsLetter = (fixture, input) =>
    asRole('authenticated', A, (c) =>
      c.query(
        `insert into public.letters
           (fiscal_year_id, letter_type, letter_number, letter_date, party_id, sister_company_id)
         values ($1,$2,$3,$4::date,$5,$6)
         returning id, letter_number, letter_number_raw, status,
                   source_total, destination_total, counterparty_code, counterparty_name`,
        [
          input.yearId ?? fixture.firstYear.id,
          input.type,
          input.number,
          input.date ?? '2040-08-15',
          input.partyId ?? null,
          input.sisterId ?? null,
        ],
      ),
    );

  const insertApsLine = (letterId, line) =>
    asRole('authenticated', A, (c) =>
      c.query(
        `insert into public.letter_lines
           (letter_id, direction, warehouse_id, classification_id, amount, paired_line_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [
          letterId,
          line.direction,
          line.warehouseId,
          line.classificationId,
          line.amount,
          line.pairedLineId ?? null,
        ],
      ),
    );

  const approveApsLetter = (letterId) =>
    asRole('authenticated', A, (c) => c.query('select public.aps_approve_letter($1)', [letterId]));

  const cancelApsLetter = (letterId, reason) =>
    asRole('authenticated', A, (c) =>
      c.query('select public.aps_cancel_letter($1,$2)', [letterId, reason]),
    );

  /** Run `fn` and return the error it raised, so a message can be asserted. */
  const captureApsError = async (fn) => {
    try {
      await fn();
    } catch (error) {
      return error;
    }
    throw new Error('expected the call to fail');
  };

  await test('APS letters: permission-gated, author-scoped drafts and one numbering series per fiscal year', async () => {
    const fixture = await seedApsLetters();
    const createdIds = [];
    let readerRoleId = null;
    try {
      const columns = await db.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name='letters' order by ordinal_position",
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const column of [
        'fiscal_year_id',
        'letter_type',
        'letter_number',
        'letter_number_raw',
        'letter_date',
        'status',
        'party_id',
        'sister_company_id',
        'counterparty_code',
        'counterparty_name',
        'source_total',
        'destination_total',
        'created_by',
        'approved_at',
        'approved_by',
        'cancelled_at',
        'cancelled_by',
        'cancel_reason',
      ]) {
        assert.ok(names.includes(column), `letters.${column} is missing`);
      }
      assert.deepEqual(
        (
          await db.query(
            "select column_name from information_schema.columns where table_schema='public' and table_name='letter_lines' order by ordinal_position",
          )
        ).rows.map((row) => row.column_name),
        [
          'id',
          'letter_id',
          'line_number',
          'direction',
          'warehouse_id',
          'classification_id',
          'amount',
          'paired_line_id',
          'note',
          'created_at',
          'updated_at',
        ],
      );

      assert.deepEqual(
        (
          await db.query(
            "select slug, module from public.permissions where slug like 'aps.%' order by slug",
          )
        ).rows,
        [
          { slug: 'aps.letters:cancel', module: 'aps' },
          { slug: 'aps.letters:create', module: 'aps' },
          { slug: 'aps.letters:read', module: 'aps' },
          { slug: 'aps.reconciliation:manage', module: 'aps' },
        ],
      );
      assert.deepEqual(
        (
          await db.query(
            `select distinct r.slug
               from public.role_permissions rp
               join public.roles r on r.id = rp.role_id
               join public.permissions p on p.id = rp.permission_id
              where p.slug like 'aps.%'
              order by r.slug`,
          )
        ).rows.map((row) => row.slug),
        ['owner', 'super_admin'],
      );

      // D1(a) + normalisation: «٠٠٧», «007» and «7» are one number, and the
      // key is (fiscal year, number) — not (counterparty, number).
      const first = (
        await insertApsLetter(fixture, {
          type: 'inbound',
          number: '٠٠٧',
          partyId: fixture.party.id,
        })
      ).rows[0];
      createdIds.push(first.id);
      assert.equal(first.letter_number, '7');
      assert.equal(first.letter_number_raw, '٠٠٧');
      assert.equal(first.status, 'draft');
      assert.equal(first.source_total, '0.00');
      assert.equal(first.destination_total, '0.00');
      assert.equal(first.counterparty_code, fixture.party.code);
      assert.ok(first.counterparty_name.startsWith('APS audit supplier'));

      await expectCode('23505', () =>
        insertApsLetter(fixture, { type: 'outbound', number: '007', partyId: fixture.partyOut.id }),
      );
      await expectCode('23505', () =>
        insertApsLetter(fixture, { type: 'outbound', number: '7', partyId: fixture.partyOut.id }),
      );
      // The same number in another fiscal year is a different letter.
      createdIds.push(
        (
          await insertApsLetter(fixture, {
            yearId: fixture.secondYear.id,
            type: 'inbound',
            number: '7',
            date: '2041-08-15',
            partyId: fixture.party.id,
          })
        ).rows[0].id,
      );

      // A viewer holds none of the APS capabilities.
      assert.equal(
        (
          await asRole('authenticated', V, (c) =>
            c.query('select count(*)::int as n from public.letters'),
          )
        ).rows[0].n,
        0,
      );
      await expectCode('42501', () =>
        asRole('authenticated', V, (c) =>
          c.query(
            `insert into public.letters (fiscal_year_id, letter_type, letter_number, letter_date, party_id, created_by)
             values ($1,'inbound','900',$2::date,$3,$4)`,
            [fixture.firstYear.id, '2040-09-01', fixture.party.id, V],
          ),
        ),
      );

      // `aps.letters:read` alone sees approved letters and never a draft.
      readerRoleId = randomUUID();
      await db.query(
        "insert into public.roles(id,slug,name_ar,name_en) values ($1,'audit_aps_reader','قارئ خطابات','APS reader')",
        [readerRoleId],
      );
      await db.query(
        "insert into public.role_permissions(role_id,permission_id) select $1,id from public.permissions where slug='aps.letters:read'",
        [readerRoleId],
      );
      await db.query('insert into public.user_roles(user_id,role_id) values ($1,$2)', [
        V,
        readerRoleId,
      ]);
      assert.equal(
        (
          await asRole('authenticated', V, (c) =>
            c.query('select count(*)::int as n from public.letters'),
          )
        ).rows[0].n,
        0,
        'a draft is never visible to anyone but its author',
      );
      assert.equal(
        (
          await asRole('authenticated', V, (c) =>
            c.query('select count(*)::int as n from public.letter_lines'),
          )
        ).rows[0].n,
        0,
        'line visibility follows the letter',
      );
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('select count(*)::int as n from public.letters'),
          )
        ).rows[0].n,
        createdIds.length,
      );

      assert.deepEqual(
        (
          await db.query(
            "select policyname, cmd from pg_policies where schemaname='public' and tablename in ('letters','letter_lines') and permissive='PERMISSIVE' order by policyname",
          )
        ).rows.map((row) => `${row.policyname}:${row.cmd}`),
        [
          'letter_lines_create:INSERT',
          'letter_lines_delete:DELETE',
          'letter_lines_read:SELECT',
          'letter_lines_update:UPDATE',
          'letters_create:INSERT',
          'letters_delete:DELETE',
          'letters_read:SELECT',
          'letters_update:UPDATE',
        ],
      );
      assert.deepEqual(
        (
          await db.query(
            `select tgname from pg_trigger
              where tgrelid in ('public.letters'::regclass,'public.letter_lines'::regclass)
                and not tgisinternal
              order by tgname`,
          )
        ).rows.map((row) => row.tgname),
        [
          'letter_lines_aps_before_write',
          'letter_lines_aps_recalc_totals',
          'letter_lines_set_updated_at',
          'letters_aps_before_write',
          'letters_set_updated_at',
        ],
      );
    } finally {
      if (readerRoleId) {
        await db.query('delete from public.user_roles where role_id=$1', [readerRoleId]);
        await db.query('delete from public.roles where id=$1', [readerRoleId]);
      }
      await db.query('delete from public.letters where id=any($1::uuid[])', [createdIds]);
      await db.query('delete from public.fiscal_years where id=any($1::uuid[])', [
        [fixture.firstYear.id, fixture.secondYear.id],
      ]);
      await db.query('delete from public.classifications where id=any($1::uuid[])', [
        [fixture.leafA, fixture.leafB],
      ]);
      await db.query('delete from public.warehouses where id=$1', [fixture.warehouseId]);
      await db.query('delete from public.stations where id=$1', [fixture.stationId]);
      await db.query('delete from public.parties where id=any($1::uuid[])', [
        [fixture.party.id, fixture.partyOut.id],
      ]);
      await db.query('delete from public.sister_companies where id=$1', [fixture.sister.id]);
    }
  });

  await test('APS letters: approval enforces pairing, open periods and the audit trail', async () => {
    const fixture = await seedApsLetters();
    const createdIds = [];
    let readerRoleId = null;
    try {
      // ---- A single-sided letter: the totals come from its own lines. ------
      const inbound = (
        await insertApsLetter(fixture, {
          type: 'inbound',
          number: '10',
          partyId: fixture.party.id,
        })
      ).rows[0];
      createdIds.push(inbound.id);
      await insertApsLine(inbound.id, {
        direction: 'in',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafA,
        amount: 125.5,
      });
      assert.deepEqual(
        (
          await db.query(
            'select source_total::text, destination_total::text from public.letters where id=$1',
            [inbound.id],
          )
        ).rows[0],
        { source_total: '0.00', destination_total: '125.50' },
      );
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('select public.aps_suggest_letter_number($1) as next', [fixture.firstYear.id]),
          )
        ).rows[0].next,
        '11',
      );

      await approveApsLetter(inbound.id);
      assert.deepEqual(
        (
          await db.query(
            'select status, approved_at is not null as stamped from public.letters where id=$1',
            [inbound.id],
          )
        ).rows[0],
        { status: 'approved', stamped: true },
      );
      const approvalAudit = (
        await db.query(
          "select actor_id, metadata from public.audit_logs where entity='letters' and entity_id=$1 and action='aps.letter_approved'",
          [inbound.id],
        )
      ).rows[0];
      assert.equal(approvalAudit.actor_id, A);
      assert.equal(approvalAudit.metadata.letter_number, '10');
      assert.equal(approvalAudit.metadata.letter_type, 'inbound');
      assert.equal(approvalAudit.metadata.destination_total, 125.5);
      assert.equal(approvalAudit.metadata.line_count, 1);

      // Approved means frozen: no second approval, no update, no delete, no
      // new line, and the number stays taken.
      await expectCode('22023', () => approveApsLetter(inbound.id));
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('update public.letters set letter_date=letter_date where id=$1 returning id', [
              inbound.id,
            ]),
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('delete from public.letters where id=$1 returning id', [inbound.id]),
          )
        ).rowCount,
        0,
      );

      // ---- D4(b): an internal transfer must balance and be paired. ---------
      const transfer = (
        await insertApsLetter(fixture, {
          type: 'internal_transfer',
          number: '11',
          date: '2040-08-20',
        })
      ).rows[0];
      createdIds.push(transfer.id);
      const source = (
        await insertApsLine(transfer.id, {
          direction: 'out',
          warehouseId: fixture.warehouseId,
          classificationId: fixture.leafA,
          amount: 100,
        })
      ).rows[0];
      // A pair that names a non-existent partner, or an unequal one, fails on
      // write — where the mistake is made.
      await expectCode('23503', () =>
        insertApsLine(transfer.id, {
          direction: 'in',
          warehouseId: fixture.warehouseId,
          classificationId: fixture.leafA,
          amount: 100,
          pairedLineId: randomUUID(),
        }),
      );
      await expectCode('23514', () =>
        insertApsLine(transfer.id, {
          direction: 'in',
          warehouseId: fixture.warehouseId,
          classificationId: fixture.leafA,
          amount: 90,
          pairedLineId: source.id,
        }),
      );
      // An unpaired destination line is caught at approval.
      await insertApsLine(transfer.id, {
        direction: 'in',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafB,
        amount: 100,
      });
      assert.match(
        (await captureApsError(() => approveApsLetter(transfer.id))).message,
        /name the source line/,
      );
      await db.query("delete from public.letter_lines where letter_id=$1 and direction='in'", [
        transfer.id,
      ]);
      // Paired and balanced, but it moves stock into a different classification:
      // D4(b) requires the explicit reclassification flag.
      await insertApsLine(transfer.id, {
        direction: 'in',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafB,
        amount: 100,
        pairedLineId: source.id,
      });
      assert.match(
        (await captureApsError(() => approveApsLetter(transfer.id))).message,
        /reclassification/,
      );
      await asRole('authenticated', A, (c) =>
        c.query(
          'update public.letters set has_reclassification=true, reclassification_reason=$2 where id=$1',
          [transfer.id, 'تحويل بين تصنيفين بقرار من الإدارة'],
        ),
      );
      await approveApsLetter(transfer.id);
      const approvedTransfer = (
        await db.query(
          'select status, source_total::text, destination_total::text from public.letters where id=$1',
          [transfer.id],
        )
      ).rows[0];
      assert.deepEqual(approvedTransfer, {
        status: 'approved',
        source_total: '100.00',
        destination_total: '100.00',
      });
      // The next free number counts the approved ones.
      assert.equal(
        (
          await asRole('authenticated', A, (c) =>
            c.query('select public.aps_suggest_letter_number($1) as next', [fixture.firstYear.id]),
          )
        ).rows[0].next,
        '12',
      );

      // ---- D3(a): an external transfer is a sister company, one direction. -
      const external = (
        await insertApsLetter(fixture, {
          type: 'external_transfer',
          number: '12',
          date: '2040-08-25',
          sisterId: fixture.sister.id,
        })
      ).rows[0];
      createdIds.push(external.id);
      assert.equal(external.counterparty_code, fixture.sister.code);
      await insertApsLine(external.id, {
        direction: 'out',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafA,
        amount: 10,
      });
      await insertApsLine(external.id, {
        direction: 'in',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafB,
        amount: 5,
      });
      assert.match(
        (await captureApsError(() => approveApsLetter(external.id))).message,
        /one direction/,
      );

      // An inbound party cannot be used on an outbound letter: the branch must
      // match the type, and that cross-table rule lives in the write trigger.
      assert.match(
        (
          await captureApsError(() =>
            insertApsLetter(fixture, { type: 'outbound', number: '13', partyId: fixture.party.id }),
          )
        ).message,
        /needs a outbound party/,
      );

      // ---- D8(a+b): a closed month blocks approval until supplements open. --
      await db.query(
        'update public.fiscal_months set is_closed=true where fiscal_year_id=$1 and month_number=2',
        [fixture.secondYear.id],
      );
      const closed = (
        await insertApsLetter(fixture, {
          yearId: fixture.secondYear.id,
          type: 'outbound',
          number: '1',
          date: '2041-08-10',
          partyId: fixture.partyOut.id,
        })
      ).rows[0];
      createdIds.push(closed.id);
      // A draft may be prepared for a closed period...
      await insertApsLine(closed.id, {
        direction: 'out',
        warehouseId: fixture.warehouseId,
        classificationId: fixture.leafA,
        amount: 40,
      });
      // ...but it cannot post.
      assert.match(
        (await captureApsError(() => approveApsLetter(closed.id))).message,
        /month containing .* is closed/,
      );
      await db.query('update public.fiscal_years set supplements_open=true where id=$1', [
        fixture.secondYear.id,
      ]);
      await approveApsLetter(closed.id);
      assert.equal(
        (await db.query('select status from public.letters where id=$1', [closed.id])).rows[0]
          .status,
        'approved',
      );

      // ---- D7(b) + D11(a): cancellation needs the capability and a reason. -
      await expectCode('22023', () => cancelApsLetter(inbound.id, '  '));
      await asRole('authenticated', V, (c) =>
        c.query('select public.aps_cancel_letter($1,$2)', [inbound.id, 'إلغاء بلا صلاحية']),
      ).then(
        () => {
          throw new Error('a viewer must not cancel a letter');
        },
        (error) => assert.equal(error.code, '42501'),
      );
      await cancelApsLetter(inbound.id, 'خطأ في رقم الخطاب الورقي');
      const cancelled = (
        await db.query(
          'select status, cancel_reason, cancelled_by from public.letters where id=$1',
          [inbound.id],
        )
      ).rows[0];
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancel_reason, 'خطأ في رقم الخطاب الورقي');
      assert.equal(cancelled.cancelled_by, A);
      const cancelAudit = (
        await db.query(
          "select metadata from public.audit_logs where entity='letters' and entity_id=$1 and action='aps.letter_cancelled'",
          [inbound.id],
        )
      ).rows[0];
      assert.equal(cancelAudit.metadata.previous_status, 'approved');
      assert.equal(cancelAudit.metadata.reason, 'خطأ في رقم الخطاب الورقي');
      await expectCode('22023', () => cancelApsLetter(inbound.id, 'محاولة إلغاء ثانية'));

      // A cancelled number is never reused.
      await expectCode('23505', () =>
        insertApsLetter(fixture, { type: 'inbound', number: '10', partyId: fixture.party.id }),
      );

      // ---- The read capability alone now sees exactly the approved letters. -
      readerRoleId = randomUUID();
      await db.query(
        "insert into public.roles(id,slug,name_ar,name_en) values ($1,'audit_aps_reader2','قارئ خطابات 2','APS reader 2')",
        [readerRoleId],
      );
      await db.query(
        "insert into public.role_permissions(role_id,permission_id) select $1,id from public.permissions where slug='aps.letters:read'",
        [readerRoleId],
      );
      await db.query('insert into public.user_roles(user_id,role_id) values ($1,$2)', [
        V,
        readerRoleId,
      ]);
      const visible = await asRole('authenticated', V, (c) =>
        c.query('select id, status from public.letters order by letter_number'),
      );
      assert.deepEqual(visible.rows, [
        { id: closed.id, status: 'approved' },
        { id: inbound.id, status: 'cancelled' },
        { id: transfer.id, status: 'approved' },
      ]);
    } finally {
      if (readerRoleId) {
        await db.query('delete from public.user_roles where role_id=$1', [readerRoleId]);
        await db.query('delete from public.roles where id=$1', [readerRoleId]);
      }
      await db.query('delete from public.letters where id=any($1::uuid[])', [createdIds]);
      await db.query('delete from public.fiscal_years where id=any($1::uuid[])', [
        [fixture.firstYear.id, fixture.secondYear.id],
      ]);
      await db.query('delete from public.classifications where id=any($1::uuid[])', [
        [fixture.leafA, fixture.leafB],
      ]);
      await db.query('delete from public.warehouses where id=$1', [fixture.warehouseId]);
      await db.query('delete from public.stations where id=$1', [fixture.stationId]);
      await db.query('delete from public.parties where id=$1', [fixture.party.id]);
      await db.query('delete from public.sister_companies where id=$1', [fixture.sister.id]);
    }
  });

  await test('classifications: derived level and is_leaf at any depth, sequence codes, subtree moves', async () => {
    const columns = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='classifications' order by ordinal_position",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'id',
        'parent_id',
        'name',
        'code',
        'level',
        'is_leaf',
        'is_active',
        'created_at',
        'updated_at',
      ],
    );

    // Our four project-settings policies must each be permissive. The approval
    // workflow migration drops a blanket restrictive `approved_access_only`
    // guard onto every existing RLS table, and the replay test above re-runs
    // that migration, so the table may also carry that guard — assert ours only.
    const policies = await db.query(
      "select polname, polpermissive from pg_policy where polrelid='public.classifications'::regclass and polname like 'classifications_project_settings_%' order by polname",
    );
    assert.deepEqual(policies.rows, [
      { polname: 'classifications_project_settings_delete', polpermissive: true },
      { polname: 'classifications_project_settings_insert', polpermissive: true },
      { polname: 'classifications_project_settings_select', polpermissive: true },
      { polname: 'classifications_project_settings_update', polpermissive: true },
    ]);

    // Codes are minted by public.next_classification_code() from
    // public.classification_code_seq, and supabase/seed.sql (replayed above)
    // deliberately seeds a demo tree, so the next value is NOT 1 here. The
    // expected code is derived from the sequence itself rather than hardcoded:
    // hardcoding 'CLS-001' made this audit a second, silent copy of the seed's
    // row count — it turned a legitimate seed change into a red build.
    const nextCode = async () => {
      const seq = await db.query(
        'select last_value, is_called from public.classification_code_seq',
      );
      const last = Number(seq.rows[0].last_value);
      const upcoming = seq.rows[0].is_called ? last + 1 : last;
      // Mirrors the minting rule: zero-pad to three digits, keep full digits
      // past 999 (lpad would truncate '1000' to '100').
      return `CLS-${upcoming < 1000 ? String(upcoming).padStart(3, '0') : String(upcoming)}`;
    };

    // Root: level is derived to 1, code minted from the sequence, leaf by default.
    const expectedRootCode = await nextCode();
    const root = await db.query(
      "insert into public.classifications (name) values ('تصنيف أساسي للاختبار') returning id, code, level, is_leaf",
    );
    assert.equal(root.rows[0].code, expectedRootCode);
    assert.match(root.rows[0].code, /^CLS-\d{3,}$/);
    assert.equal(root.rows[0].level, 1);
    assert.equal(root.rows[0].is_leaf, true);
    const rootId = root.rows[0].id;

    // A client-supplied level is ignored: the server still derives level 1.
    const rootOverride = await db.query(
      "insert into public.classifications (name, level) values ('جذر معاكس', 5) returning level",
    );
    assert.equal(rootOverride.rows[0].level, 1);

    // A child's level is derived from its parent without being supplied, and a
    // new child flips its parent to non-leaf. Its code comes straight after the
    // root's (the override insert above consumed one value in between).
    const expectedChildCode = await nextCode();
    const child = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'تصنيف فرعي للاختبار') returning id, code, level, is_leaf",
      [rootId],
    );
    assert.equal(child.rows[0].code, expectedChildCode);
    assert.notEqual(child.rows[0].code, root.rows[0].code);
    assert.equal(child.rows[0].level, 2);
    assert.equal(child.rows[0].is_leaf, true);
    const parentAfterChild = await db.query(
      'select is_leaf from public.classifications where id = $1',
      [rootId],
    );
    assert.equal(parentAfterChild.rows[0].is_leaf, false);
    const childId = child.rows[0].id;

    // Grandchild: level derived to 3.
    const grandChild = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'تصنيف فرعي أدنى للاختبار') returning id, level",
      [childId],
    );
    assert.equal(grandChild.rows[0].level, 3);
    const grandChildId = grandChild.rows[0].id;

    /* Depth is unbounded (20261105000000): the fourth level used to be refused
       with 22023 and is now a normal row. Walk to level six so the change is
       proven by behaviour rather than by the absence of an error. */
    const fourth = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'المستوى الرابع') returning id, level",
      [grandChildId],
    );
    assert.equal(fourth.rows[0].level, 4);
    const fifth = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'المستوى الخامس') returning id, level",
      [fourth.rows[0].id],
    );
    assert.equal(fifth.rows[0].level, 5);
    const sixth = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'المستوى السادس') returning id, level",
      [fifth.rows[0].id],
    );
    assert.equal(sixth.rows[0].level, 6);

    // Every ancestor on the way down flipped to non-leaf, the deepest stays a leaf.
    const deepLeaves = await db.query(
      `select id, level, is_leaf
         from public.classifications
        where id = any($1::uuid[])
        order by level`,
      [[rootId, childId, grandChildId, fourth.rows[0].id, fifth.rows[0].id, sixth.rows[0].id]],
    );
    assert.deepEqual(
      deepLeaves.rows.map((row) => [Number(row.level), row.is_leaf]),
      [
        [1, false],
        [2, false],
        [3, false],
        [4, false],
        [5, false],
        [6, true],
      ],
    );

    // The tree still hangs together: the deepest node's ancestry is the chain above.
    const ancestry = await db.query(
      `with recursive up(id, parent_id, level) as (
         select id, parent_id, level from public.classifications where id = $1
         union all
         select parent.id, parent.parent_id, parent.level
           from public.classifications as parent
           join up on parent.id = up.parent_id
       )
       select level from up order by level`,
      [sixth.rows[0].id],
    );
    assert.deepEqual(
      ancestry.rows.map((row) => Number(row.level)),
      [1, 2, 3, 4, 5, 6],
    );

    // Moving a node re-derives its whole subtree's levels.
    const moveRoot = await db.query(
      "insert into public.classifications (name) values ('جذر منقول') returning id",
    );
    const moveRootId = moveRoot.rows[0].id;
    const moveChild = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'طفل منقول') returning id",
      [moveRootId],
    );
    const moveTarget = await db.query(
      "insert into public.classifications (name) values ('هدف المنقول') returning id",
    );
    await db.query('update public.classifications set parent_id = $1 where id = $2', [
      moveTarget.rows[0].id,
      moveRootId,
    ]);
    const moveRootLevel = await db.query('select level from public.classifications where id = $1', [
      moveRootId,
    ]);
    assert.equal(moveRootLevel.rows[0].level, 2);
    const moveChildLevel = await db.query(
      'select level from public.classifications where id = $1',
      [moveChild.rows[0].id],
    );
    assert.equal(moveChildLevel.rows[0].level, 3);

    /* A move no longer has a ceiling to hit: pulling a three-deep subtree under
       a level-3 node re-derives the whole thing to levels 4, 5 and 6. */
    const deepRoot = await db.query(
      "insert into public.classifications (name) values ('جذر عميق') returning id",
    );
    const deepRootId = deepRoot.rows[0].id;
    const deepChild = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'ابن عميق') returning id",
      [deepRootId],
    );
    const deepGrandChild = await db.query(
      "insert into public.classifications (parent_id, name) values ($1, 'حفيد عميق') returning id, level",
      [deepChild.rows[0].id],
    );
    assert.equal(deepGrandChild.rows[0].level, 3);

    await db.query('update public.classifications set parent_id = $1 where id = $2', [
      fourth.rows[0].id,
      deepRootId,
    ]);
    const movedSubtree = await db.query(
      `select id, level from public.classifications
        where id = any($1::uuid[]) order by level`,
      [[deepRootId, deepChild.rows[0].id, deepGrandChild.rows[0].id]],
    );
    // The moved subtree now hangs off a level-4 node, so its three rows land on
    // 5, 6 and 7 — three levels below the deepest point the old ceiling allowed.
    assert.deepEqual(
      movedSubtree.rows.map((row) => Number(row.level)),
      [5, 6, 7],
    );

    /* The guard that replaced the ceiling: a node may not be moved under its
       own descendant. Without it the recursive re-derivation would not
       terminate and the cycle would be unreachable from any root. */
    await expectCode('22023', () =>
      db.query('update public.classifications set parent_id = $1 where id = $2', [
        deepGrandChild.rows[0].id,
        deepRootId,
      ]),
    );
    // …nor under itself.
    await expectCode('22023', () =>
      db.query('update public.classifications set parent_id = id where id = $1', [deepRootId]),
    );
    // A self-parented INSERT is refused too (the FK alone would allow it).
    await expectCode('22023', () =>
      db.query(
        `insert into public.classifications (id, parent_id, name)
         values ('00000000-0000-4000-8000-00000000abc1', '00000000-0000-4000-8000-00000000abc1', 'دائرة')`,
      ),
    );

    /* Removing the last child flips the parent back to a leaf. The branch is now
       six rows deep, and RESTRICT means it has to come down from the leaf:
       deleting `grandChild` first is refused while `fourth` still hangs off it. */
    await expectCode('23503', () =>
      db.query('delete from public.classifications where id = $1', [grandChildId]),
    );
    /* Deepest first, and both subtrees: `fourth` gained the moved `deepRoot`
       branch above, so it stays referenced until that whole branch is gone. */
    for (const id of [
      sixth.rows[0].id,
      fifth.rows[0].id,
      deepGrandChild.rows[0].id,
      deepChild.rows[0].id,
      deepRootId,
      fourth.rows[0].id,
      grandChildId,
      childId,
    ]) {
      await db.query('delete from public.classifications where id = $1', [id]);
    }
    const parentAfterDelete = await db.query(
      'select is_leaf from public.classifications where id = $1',
      [rootId],
    );
    assert.equal(parentAfterDelete.rows[0].is_leaf, true);

    // The internal re-derivation flag must not be a bypass. Any session can set
    // a custom GUC, so skipping derivation requires the flag *and* a nested
    // trigger depth. Set the flag alone, then write directly: the level is still
    // derived and the client's value is still ignored. This runs last because
    // these inserts burn sequence values the code assertions above depend on.
    await db.query("select set_config('classifications.deriving_level', 'on', false)");
    try {
      const flagged = await db.query(
        "insert into public.classifications (name, level) values ('محاولة تجاوز', 2) returning level",
      );
      assert.equal(flagged.rows[0].level, 1);
      const flaggedDeep = await db.query(
        "insert into public.classifications (name, level) values ('محاولة تجاوز عميقة', 9) returning level",
      );
      assert.equal(flaggedDeep.rows[0].level, 1);
    } finally {
      await db.query("select set_config('classifications.deriving_level', 'off', false)");
    }
  });
  await test('parties: two-root tree, per-branch codes, immutable identity, CHECKs, and RLS gate', async () => {
    const columns = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='parties' order by ordinal_position",
    );
    // Identity only: the commercial profile columns were retired in
    // 20261109000000. `branch` is appended by the ALTER, hence its position.
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['id', 'name', 'code', 'is_active', 'created_at', 'updated_at', 'branch'],
    );

    // The retired vocabulary is gone from the schema entirely.
    for (const retired of [
      'parties_type_check',
      'parties_code_matches_type',
      'parties_credit_terms_external_only',
      'parties_email_check',
      'parties_credit_limit_non_negative',
      'parties_payment_terms_check',
    ]) {
      assert.equal(
        (
          await db.query(
            "select 1 from pg_constraint where conrelid='public.parties'::regclass and conname=$1",
            [retired],
          )
        ).rowCount,
        0,
        `${retired} must not exist any more`,
      );
    }

    const branchCheck = await db.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.parties'::regclass and conname='parties_branch_check'",
    );
    assert.ok(branchCheck.rows[0]?.def.includes('inbound'));
    assert.ok(branchCheck.rows[0]?.def.includes('outbound'));
    for (const retired of ['local_supplier', 'foreign_supplier', 'customer', 'internal']) {
      assert.equal(branchCheck.rows[0]?.def.includes(retired), false);
    }

    const codeCheck = await db.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.parties'::regclass and conname='parties_code_matches_branch'",
    );
    for (const prefix of ['IN-', 'OUT-']) {
      assert.ok(
        codeCheck.rows[0]?.def.includes(prefix),
        `parties_code_matches_branch must name ${prefix}`,
      );
    }
    for (const retired of ['LOC-', 'FRN-', 'CUS-', 'SUP-', 'SIS-', 'INT-']) {
      assert.equal(codeCheck.rows[0]?.def.includes(retired), false, `${retired} must be retired`);
    }

    // Forced RLS + the four permissive project.settings:manage policies.
    const rlsFlags = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid='public.parties'::regclass",
    );
    assert.deepEqual(rlsFlags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    const policies = await db.query(
      "select polname, polpermissive from pg_policy where polrelid='public.parties'::regclass and polname like 'parties_project_settings_%' order by polname",
    );
    assert.deepEqual(policies.rows, [
      { polname: 'parties_project_settings_delete', polpermissive: true },
      { polname: 'parties_project_settings_insert', polpermissive: true },
      { polname: 'parties_project_settings_select', polpermissive: true },
      { polname: 'parties_project_settings_update', polpermissive: true },
    ]);

    // Explicit table grants: authenticated gets CRUD, anon gets nothing.
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        (
          await db.query('select has_table_privilege($1, $2, $3) as ok', [
            'authenticated',
            'public.parties',
            priv,
          ])
        ).rows[0].ok,
        true,
        `authenticated must have ${priv} on public.parties`,
      );
      assert.equal(
        (
          await db.query('select has_table_privilege($1, $2, $3) as ok', [
            'anon',
            'public.parties',
            priv,
          ])
        ).rows[0].ok,
        false,
        `anon must not have ${priv} on public.parties`,
      );
    }

    // API roles cannot call nextval() directly on either branch sequence, nor
    // invoke the SECURITY DEFINER trigger function directly. The per-type
    // sequences of the retired model must be gone.
    for (const seq of ['public.party_inbound_code_seq', 'public.party_outbound_code_seq']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(
          (await db.query('select has_sequence_privilege($1, $2, $3) as ok', [role, seq, 'USAGE']))
            .rows[0].ok,
          false,
          `${role} must not have USAGE on ${seq}`,
        );
      }
    }
    for (const retired of [
      'party_local_supplier_code_seq',
      'party_foreign_supplier_code_seq',
      'party_customer_code_seq',
      'party_supplier_code_seq',
      'party_sister_company_code_seq',
      'party_internal_code_seq',
    ]) {
      assert.equal(
        (await db.query('select to_regclass($1) as oid', [`public.${retired}`])).rows[0].oid,
        null,
        `${retired} must not exist any more`,
      );
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(
        (
          await db.query(
            "select has_function_privilege($1, 'public.parties_before_write()', 'EXECUTE') as ok",
            [role],
          )
        ).rows[0].ok,
        false,
        `${role} must not execute parties_before_write()`,
      );
    }

    const nextPartyCode = async (seqName, prefix) => {
      const seq = await db.query(`select last_value, is_called from public.${seqName}`);
      const last = Number(seq.rows[0].last_value);
      const upcoming = seq.rows[0].is_called ? last + 1 : last;
      return `${prefix}-${upcoming < 1000 ? String(upcoming).padStart(3, '0') : String(upcoming)}`;
    };

    const createdIds = [];
    try {
      // 1) A branch outside the two roots is rejected with 23514 without
      //    burning a sequence value, and NULL `branch` fails NOT NULL with
      //    23502. The retired vocabulary is simply not a value any more.
      const inboundNextBeforeBadBranch = await nextPartyCode('party_inbound_code_seq', 'IN');
      for (const badBranch of [
        'local_supplier',
        'foreign_supplier',
        'customer',
        'supplier',
        'internal',
        'sister_company',
        'vendor',
        '',
        'INBOUND',
        ' inbound ',
      ]) {
        await expectCode('23514', () =>
          db.query('insert into public.parties (branch, name) values ($1, $2)', [
            badBranch,
            'جهة مرفوضة',
          ]),
        );
      }
      await expectCode('23502', () =>
        db.query('insert into public.parties (branch, name) values (null, $1)', ['جهة بلا فرع']),
      );
      assert.equal(
        await nextPartyCode('party_inbound_code_seq', 'IN'),
        inboundNextBeforeBadBranch,
        'a rejected branch must not advance any sequence',
      );

      // 2) Each branch mints from its own sequence, and a client-supplied code
      //    is overwritten server-side.
      const expectedIn1 = await nextPartyCode('party_inbound_code_seq', 'IN');
      const in1 = (
        await asRole('authenticated', A, (c) =>
          c.query('insert into public.parties (branch, name) values ($1, $2) returning *', [
            'inbound',
            'شركة النيل للتوريدات',
          ]),
        )
      ).rows[0];
      createdIds.push(in1.id);
      assert.equal(in1.code, expectedIn1);
      assert.match(in1.code, /^IN-\d{3,}$/);
      assert.equal(in1.branch, 'inbound');
      assert.equal(in1.is_active, true);

      /* The row is identity only: no retired column exists to read. */
      for (const retired of [
        'type',
        'tax_number',
        'commercial_register',
        'address',
        'contact_person',
        'phone',
        'email',
        'credit_limit',
        'payment_terms',
      ]) {
        assert.equal(in1[retired], undefined, `parties must not expose ${retired}`);
      }

      const expectedIn2 = await nextPartyCode('party_inbound_code_seq', 'IN');
      const in2 = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'insert into public.parties (branch, name, code) values ($1, $2, $3) returning id, code',
            ['inbound', 'مورد وارد ثانٍ للاختبار', 'OUT-999'],
          ),
        )
      ).rows[0];
      createdIds.push(in2.id);
      assert.equal(in2.code, expectedIn2);
      assert.notEqual(in2.code, 'OUT-999');

      const expectedOut1 = await nextPartyCode('party_outbound_code_seq', 'OUT');
      const out1 = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'insert into public.parties (branch, name) values ($1, $2) returning id, code, branch',
            ['outbound', 'جهة صرف للاختبار'],
          ),
        )
      ).rows[0];
      createdIds.push(out1.id);
      assert.equal(out1.branch, 'outbound');
      assert.equal(out1.code, expectedOut1);
      assert.match(out1.code, /^OUT-\d{3,}$/);

      /* The two sequences are independent: minting outbound did not move the
         inbound counter. */
      const nextInbound = Number(expectedIn2.split('-')[1]) + 1;
      assert.equal(
        await nextPartyCode('party_inbound_code_seq', 'IN'),
        `IN-${String(nextInbound).padStart(3, '0')}`,
        'the outbound insert must not advance the inbound sequence',
      );

      // Padding width guard: 999 -> OUT-999, 1000 -> OUT-1000 (never OUT-100).
      const savedOutSeq = (
        await db.query('select last_value, is_called from public.party_outbound_code_seq')
      ).rows[0];
      try {
        await db.query('select setval($1, 998, true)', ['public.party_outbound_code_seq']);
        const row999 = (
          await db.query(
            "insert into public.parties (branch, name) values ('outbound', 'صرف 999') returning id, code",
          )
        ).rows[0];
        const row1000 = (
          await db.query(
            "insert into public.parties (branch, name) values ('outbound', 'صرف 1000') returning id, code",
          )
        ).rows[0];
        assert.equal(row999.code, 'OUT-999');
        assert.equal(row1000.code, 'OUT-1000');
        await db.query('delete from public.parties where id = any($1::uuid[])', [
          [row999.id, row1000.id],
        ]);
      } finally {
        await db.query('select setval($1, $2, $3)', [
          'public.party_outbound_code_seq',
          savedOutSeq.last_value,
          savedOutSeq.is_called,
        ]);
      }

      // 3) Immutability on UPDATE: changing `branch` or `code` is refused with
      //    22023 both for direct SQL and for an authorized API caller.
      await expectCode('22023', () =>
        db.query("update public.parties set branch = 'outbound' where id = $1", [in1.id]),
      );
      await expectCode('22023', () =>
        db.query('update public.parties set branch = null where id = $1', [in1.id]),
      );
      await expectCode('22023', () =>
        db.query("update public.parties set code = 'IN-999' where id = $1", [in1.id]),
      );
      await expectCode('22023', () =>
        db.query('update public.parties set code = null where id = $1', [in1.id]),
      );
      await expectCode('22023', () =>
        asRole('authenticated', A, (c) =>
          c.query("update public.parties set branch = 'outbound' where id = $1", [in1.id]),
        ),
      );
      await expectCode('22023', () =>
        asRole('authenticated', A, (c) =>
          c.query("update public.parties set code = 'OUT-001' where id = $1", [in1.id]),
        ),
      );

      // Mutable fields update cleanly and advance `updated_at` via set_updated_at().
      await db.query(
        "update public.parties set updated_at = now() - interval '5 minutes' where id = $1",
        [in1.id],
      );
      const beforeStamp = (
        await db.query('select updated_at from public.parties where id = $1', [in1.id])
      ).rows[0].updated_at;
      const updatedIn = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'update public.parties set name = $1, is_active = false where id = $2 returning name, is_active, updated_at, branch, code',
            ['شركة النيل للتوريدات المحدّثة', in1.id],
          ),
        )
      ).rows[0];
      assert.equal(updatedIn.name, 'شركة النيل للتوريدات المحدّثة');
      assert.equal(updatedIn.is_active, false);
      assert.equal(updatedIn.branch, 'inbound');
      assert.equal(updatedIn.code, in1.code);
      assert.ok(updatedIn.updated_at > beforeStamp, 'updated_at must advance on UPDATE');

      // 4) Blank `name` is rejected with 23514.
      for (const blankName of ['', '   ', '\t\n']) {
        await expectCode('23514', () =>
          db.query('update public.parties set name = $1 where id = $2', [blankName, in1.id]),
        );
        await expectCode('23514', () =>
          db.query('insert into public.parties (branch, name) values ($1, $2)', [
            'inbound',
            blankName,
          ]),
        );
      }

      // 5) The retired profile columns are not even addressable.
      for (const retired of [
        'type',
        'tax_number',
        'commercial_register',
        'address',
        'contact_person',
        'phone',
        'email',
        'credit_limit',
        'payment_terms',
      ]) {
        await expectCode('42703', () =>
          db.query(`update public.parties set ${retired} = null where id = $1`, [in1.id]),
        );
      }

      // 6) Runtime RLS isolation: anon and non-privileged authenticated users are blocked.
      await expectDenied(() =>
        asRole('anon', null, (c) => c.query('select id from public.parties')),
      );
      const viewerRows = await asRole('authenticated', V, (c) =>
        c.query('select id from public.parties'),
      );
      assert.equal(viewerRows.rowCount, 0, 'viewer without project.settings:manage sees 0 rows');
      await expectCode('42501', () =>
        asRole('authenticated', V, (c) =>
          c.query("insert into public.parties (branch, name) values ('inbound', 'ممنوع')"),
        ),
      );
      const viewerUpdate = await asRole('authenticated', V, (c) =>
        c.query("update public.parties set name = 'ممنوع' where id = $1", [in1.id]),
      );
      assert.equal(viewerUpdate.rowCount, 0);
      const viewerDelete = await asRole('authenticated', V, (c) =>
        c.query('delete from public.parties where id = $1', [in1.id]),
      );
      assert.equal(viewerDelete.rowCount, 0);

      // 7) The newest migration replays cleanly while live rows exist.
      await db.query(
        await readFile(
          `${ROOT}supabase/migrations/20261109000000_parties_two_root_tree.sql`,
          'utf8',
        ),
      );
      const afterReplay = await db.query(
        'select id, code, branch from public.parties order by code',
      );
      assert.ok(afterReplay.rowCount >= 3, 'replay must not lose live rows');
      for (const row of afterReplay.rows) {
        assert.match(
          row.code,
          row.branch === 'inbound' ? /^IN-\d{3,}$/ : /^OUT-\d{3,}$/,
          'replay must not re-key a row onto the wrong prefix',
        );
      }
    } finally {
      if (createdIds.length > 0) {
        await db.query('delete from public.parties where id = any($1::uuid[])', [createdIds]);
      }
    }
  });

  await test('sister companies: two-level tree, derived codes, write-once identity, and RLS gate', async () => {
    const columns = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='sister_companies' order by ordinal_position",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['id', 'parent_id', 'level', 'name', 'code', 'is_active', 'created_at', 'updated_at'],
    );

    // No currency/exchange-rate columns yet: they belong to the letters phase.
    for (const forbidden of ['currency', 'currency_code', 'exchange_rate']) {
      assert.equal(
        columns.rows.some((row) => row.column_name === forbidden),
        false,
        `sister_companies must not carry ${forbidden} in this phase`,
      );
    }

    const checks = await db.query(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.sister_companies'::regclass and contype='c' order by conname",
    );
    const checkNames = checks.rows.map((row) => row.conname);
    for (const expected of [
      'sister_companies_name_not_blank',
      'sister_companies_level_check',
      'sister_companies_code_matches_level',
    ]) {
      assert.ok(checkNames.includes(expected), `${expected} is missing`);
    }
    assert.ok(checkNames.includes('sister_companies_level_check'));
    assert.ok(
      checks.rows
        .find((row) => row.conname === 'sister_companies_level_check')
        .def.includes('<= 2'),
      'level must be capped at 2',
    );

    // Forced RLS + the four permissive project.settings:manage policies.
    const rlsFlags = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid='public.sister_companies'::regclass",
    );
    assert.deepEqual(rlsFlags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    const policies = await db.query(
      "select polname, polpermissive from pg_policy where polrelid='public.sister_companies'::regclass and polname like 'sister_companies_project_settings_%' order by polname",
    );
    assert.deepEqual(policies.rows, [
      { polname: 'sister_companies_project_settings_delete', polpermissive: true },
      { polname: 'sister_companies_project_settings_insert', polpermissive: true },
      { polname: 'sister_companies_project_settings_select', polpermissive: true },
      { polname: 'sister_companies_project_settings_update', polpermissive: true },
    ]);

    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        (
          await db.query('select has_table_privilege($1, $2, $3) as ok', [
            'authenticated',
            'public.sister_companies',
            priv,
          ])
        ).rows[0].ok,
        true,
        `authenticated must have ${priv} on public.sister_companies`,
      );
      assert.equal(
        (
          await db.query('select has_table_privilege($1, $2, $3) as ok', [
            'anon',
            'public.sister_companies',
            priv,
          ])
        ).rows[0].ok,
        false,
        `anon must not have ${priv} on public.sister_companies`,
      );
    }

    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        (
          await db.query('select has_sequence_privilege($1, $2, $3) as ok', [
            role,
            'public.sister_company_root_code_seq',
            'USAGE',
          ])
        ).rows[0].ok,
        false,
        `${role} must not have USAGE on the sister-company sequence`,
      );
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(
        (
          await db.query(
            "select has_function_privilege($1, 'public.sister_companies_before_write()', 'EXECUTE') as ok",
            [role],
          )
        ).rows[0].ok,
        false,
        `${role} must not execute sister_companies_before_write()`,
      );
    }

    const nextRootCode = async () => {
      const seq = await db.query(
        'select last_value, is_called from public.sister_company_root_code_seq',
      );
      const last = Number(seq.rows[0].last_value);
      const upcoming = seq.rows[0].is_called ? last + 1 : last;
      return `SIS-${upcoming < 1000 ? String(upcoming).padStart(3, '0') : String(upcoming)}`;
    };

    const createdIds = [];
    try {
      // 1) A root row is level 1 and mints SIS-###; the client cannot choose
      //    either, and a supplied code is overwritten.
      const expectedRoot = await nextRootCode();
      const parent = (
        await asRole('authenticated', A, (c) =>
          c.query(
            "insert into public.sister_companies (name, level, code) values ('شقيقة جذر للاختبار', 9, 'SIS-999') returning id, code, level, parent_id",
          ),
        )
      ).rows[0];
      createdIds.push(parent.id);
      assert.equal(parent.code, expectedRoot);
      assert.match(parent.code, /^SIS-\d{3,}$/);
      assert.equal(parent.level, 1);
      assert.equal(parent.parent_id, null);

      // 2) Branches are level 2 and append a two-digit ordinal to the parent
      //    code: SIS-001-01, then -02, and a deleted branch's number is not
      //    reused.
      const branch1 = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'insert into public.sister_companies (parent_id, name) values ($1, $2) returning id, code, level',
            [parent.id, 'فرع أول للاختبار'],
          ),
        )
      ).rows[0];
      createdIds.push(branch1.id);
      assert.equal(branch1.code, `${parent.code}-01`);
      assert.equal(branch1.level, 2);

      const branch2 = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'insert into public.sister_companies (parent_id, name) values ($1, $2) returning id, code, level',
            [parent.id, 'فرع ثانٍ للاختبار'],
          ),
        )
      ).rows[0];
      createdIds.push(branch2.id);
      assert.equal(branch2.code, `${parent.code}-02`);

      // 3) A third level is refused with 22023 (and the level CHECK agrees).
      await expectCode('22023', () =>
        db.query('insert into public.sister_companies (parent_id, name) values ($1, $2)', [
          branch1.id,
          'مستوى ثالث',
        ]),
      );

      // 4) The tree is write-once: parent_id, code and level cannot move.
      await expectCode('22023', () =>
        db.query('update public.sister_companies set parent_id = null where id = $1', [branch1.id]),
      );
      await expectCode('22023', () =>
        db.query("update public.sister_companies set code = 'SIS-999-99' where id = $1", [
          branch1.id,
        ]),
      );
      await expectCode('22023', () =>
        db.query('update public.sister_companies set level = 1 where id = $1', [branch1.id]),
      );
      await expectCode('23514', () =>
        db.query("insert into public.sister_companies (name) values ('   ')"),
      );

      // 5) A rename works and advances updated_at.
      await db.query(
        "update public.sister_companies set updated_at = now() - interval '5 minutes' where id = $1",
        [parent.id],
      );
      const beforeStamp = (
        await db.query('select updated_at from public.sister_companies where id = $1', [parent.id])
      ).rows[0].updated_at;
      const renamed = (
        await asRole('authenticated', A, (c) =>
          c.query(
            'update public.sister_companies set name = $1 where id = $2 returning name, code, level, updated_at',
            ['شقيقة جذر بعد التعديل', parent.id],
          ),
        )
      ).rows[0];
      assert.equal(renamed.name, 'شقيقة جذر بعد التعديل');
      assert.equal(renamed.code, parent.code);
      assert.equal(renamed.level, 1);
      assert.ok(renamed.updated_at > beforeStamp, 'updated_at must advance on UPDATE');

      // 6) ON DELETE RESTRICT: a parent with branches cannot be deleted.
      await expectCode('23503', () =>
        db.query('delete from public.sister_companies where id = $1', [parent.id]),
      );
      await db.query('delete from public.sister_companies where id = $1', [branch1.id]);
      await db.query('delete from public.sister_companies where id = $1', [branch2.id]);
      await db.query('delete from public.sister_companies where id = $1', [parent.id]);

      // 7) Runtime RLS isolation: anon and non-privileged users are blocked.
      await expectDenied(() =>
        asRole('anon', null, (c) => c.query('select id from public.sister_companies')),
      );
      const viewerRows = await asRole('authenticated', V, (c) =>
        c.query('select id from public.sister_companies'),
      );
      assert.equal(viewerRows.rowCount, 0, 'viewer without project.settings:manage sees 0 rows');
      await expectCode('42501', () =>
        asRole('authenticated', V, (c) =>
          c.query("insert into public.sister_companies (name) values ('ممنوع')"),
        ),
      );
      const viewerDelete = await asRole('authenticated', V, (c) =>
        c.query('delete from public.sister_companies where id = $1', [parent.id]),
      );
      assert.equal(viewerDelete.rowCount, 0);

      // 8) The newest migration replays cleanly while live rows exist (a fresh
      //    parent is inserted first so there is something to replay over).
      //    The parties two-root migration deliberately leaves sister_companies
      //    alone, so replaying it must be a no-op for this tree — which is
      //    exactly what this assertion pins down.
      const replayParent = (
        await db.query(
          "insert into public.sister_companies (name) values ('شقيقة إعادة التشغيل') returning id",
        )
      ).rows[0];
      createdIds.push(replayParent.id);
      const sistersBefore = Number(
        (await db.query('select count(*)::int as n from public.sister_companies')).rows[0].n,
      );
      await db.query(
        await readFile(
          `${ROOT}supabase/migrations/20261109000000_parties_two_root_tree.sql`,
          'utf8',
        ),
      );
      const sistersAfterReplay = await db.query(
        'select id, name, code, level from public.sister_companies where id = $1',
        [replayParent.id],
      );
      assert.equal(sistersAfterReplay.rowCount, 1, 'replay must not delete sister companies');
      assert.equal(sistersAfterReplay.rows[0].name, 'شقيقة إعادة التشغيل');
      assert.match(sistersAfterReplay.rows[0].code, /^SIS-\d{3,}$/);
      assert.equal(Number(sistersAfterReplay.rows[0].level), 1);
      // Replaying must not mint a second code for the same row either.
      assert.equal(
        Number(
          (await db.query('select count(*)::int as n from public.sister_companies')).rows[0].n,
        ),
        sistersBefore,
        'replay must not duplicate sister companies',
      );
    } finally {
      // Branches first: the parent FK is ON DELETE RESTRICT.
      await db.query('delete from public.sister_companies where parent_id = any($1::uuid[])', [
        createdIds,
      ]);
      if (createdIds.length > 0) {
        await db.query('delete from public.sister_companies where id = any($1::uuid[])', [
          createdIds,
        ]);
      }
    }
  });

  await test('RLS on every public table and no anonymous SECURITY DEFINER execution', async () => {
    assert.equal(
      (
        await db.query(
          "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'execute')",
        )
      ).rowCount,
      0,
    );
    const userRoles = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid='public.user_roles'::regclass",
    );
    assert.deepEqual(userRoles.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    const roleWritePolicies = await db.query(
      "select count(*)::int as n, bool_and(policyname='Database owners write user_roles' and cmd='ALL' and roles @> array['postgres','supabase_admin']::name[] and roles <@ array['postgres','supabase_admin']::name[]) as owner_only from pg_policies where schemaname='public' and tablename='user_roles' and permissive='PERMISSIVE' and cmd in ('ALL','INSERT','UPDATE','DELETE')",
    );
    assert.equal(roleWritePolicies.rows[0].n, 1);
    assert.equal(roleWritePolicies.rows[0].owner_only, true);
    // The approval/owner-protection hardening layers RESTRICTIVE write guards
    // on top (approved_access_only + the owner_role_immutable_* trio); they AND
    // with the sole permissive policy and must stay restrictive-only.
    const roleRestrictiveGuards = await db.query(
      "select count(*)::int as n from pg_policies where schemaname='public' and tablename='user_roles' and permissive='RESTRICTIVE' and cmd in ('ALL','INSERT','UPDATE','DELETE')",
    );
    assert.equal(roleRestrictiveGuards.rows[0].n, 4);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const result = await db.query('select has_table_privilege($1, $2, $3) as allowed', [
          role,
          'public.user_roles',
          privilege,
        ]);
        assert.equal(result.rows[0].allowed, false, `${role} must not have ${privilege}`);
      }
    }
  });
  await test('audit logs reject forged writes, block API-role mutations, and minimize metadata', async () => {
    const baseline = Number(
      (await db.query('select count(*)::int as n from public.audit_logs')).rows[0].n,
    );
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const execute = await db.query(
        "select has_function_privilege($1, 'public.write_audit_log(public.audit_action,text,text,jsonb)', 'execute') as allowed",
        [role],
      );
      assert.equal(execute.rows[0].allowed, false, `${role} must not call write_audit_log`);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const tableAccess = await db.query(
          "select has_table_privilege($1, 'public.audit_logs', $2) as allowed",
          [role, privilege],
        );
        assert.equal(tableAccess.rows[0].allowed, false, `${role} must not have ${privilege}`);
      }
      await expectDenied(() =>
        asRole(role, role === 'authenticated' ? A : null, (c) =>
          c.query(
            "select public.write_audit_log('role.granted'::public.audit_action, 'user_roles', $1, $2::jsonb)",
            [A, JSON.stringify({ target_user_id: A })],
          ),
        ),
      );
    }

    // Even a trusted database owner cannot use the SECURITY DEFINER helper to
    // forge a different event; the approved RPC uses only this fixed pair.
    await expectCode('22023', () =>
      db.query(
        "select public.write_audit_log('role.granted'::public.audit_action, 'user_roles', $1, $2::jsonb)",
        [A, JSON.stringify({ target_user_id: A })],
      ),
    );

    for (const [role, actor] of [
      ['authenticated', A],
      ['service_role', null],
    ]) {
      await expectDenied(() =>
        asRole(role, actor, (c) =>
          c.query(
            "insert into public.audit_logs(actor_id,action,entity,entity_id,metadata) values ($1,'role.granted'::public.audit_action,'user_roles',$2,'{}'::jsonb)",
            [A, A],
          ),
        ),
      );
      await expectDenied(() =>
        asRole(role, actor, (c) =>
          c.query("update public.audit_logs set metadata='{}'::jsonb where id=1"),
        ),
      );
      await expectDenied(() =>
        asRole(role, actor, (c) => c.query('delete from public.audit_logs where id=1')),
      );
      await expectDenied(() => asRole(role, actor, (c) => c.query('truncate public.audit_logs')));
    }
    assert.equal(
      Number((await db.query('select count(*)::int as n from public.audit_logs')).rows[0].n),
      baseline,
      'failed API-role attempts must not create or change an audit row',
    );

    const email = `sensitive.${randomUUID()}@example.invalid`;
    const passwordSentinel = `sensitive-${randomUUID()}`;
    await db.query(
      "insert into public.audit_logs(actor_id,action,entity,entity_id,metadata) values ($1,'role.granted'::public.audit_action,'user_roles',$2,$3::jsonb)",
      [
        A,
        A,
        JSON.stringify({
          target_user_id: A,
          target_email: email,
          email,
          password: passwordSentinel,
          note: `For ${email}`,
          nested: { contact_email: email, values: [email, 'safe'] },
          role_slugs: ['super_admin'],
        }),
      ],
    );
    const metadata = (
      await db.query(
        'select metadata from public.audit_logs where entity_id=$1 order by id desc limit 1',
        [A],
      )
    ).rows[0].metadata;
    assert.equal(metadata.target_user_id, A);
    assert.equal('target_email' in metadata, false);
    assert.equal('email' in metadata, false);
    assert.equal('password' in metadata, false);
    assert.equal('contact_email' in metadata.nested, false);
    assert.equal(JSON.stringify(metadata).includes(email), false);
    assert.equal(JSON.stringify(metadata).includes(passwordSentinel), false);
    assert.match(metadata.note, /s\*\*\*@example\.invalid/);
    assert.deepEqual(metadata.nested.values, ['s***@example.invalid', 'safe']);
  });

  await test('users RPC rejects self-suspension and non-admin callers', async () => {
    await expectCode('42501', () =>
      asRole('authenticated', A, (c) =>
        c.query("select public.admin_set_user_status($1,'suspended')", [A]),
      ),
    );
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query("select public.admin_set_user_status($1,'suspended')", [B]),
      ),
    );
    assert.equal(
      (await db.query('select status from public.profiles where id=$1', [A])).rows[0].status,
      'active',
    );
  });
  await test('roles RPC protects both protected roles and capability-level self-demotion', async () => {
    for (const protectedRoleId of [roles.owner, roles.super_admin]) {
      await expectCode('42501', () =>
        asRole('authenticated', A, (c) =>
          c.query('select public.admin_set_role_permissions($1,$2)', [
            protectedRoleId,
            ['roles.manage'],
          ]),
        ),
      );
    }
    await expectCode('RBA01', () =>
      asRole('authenticated', C, (c) =>
        c.query('select public.admin_set_role_permissions($1,$2)', [
          roles.audit_admin,
          ['roles.manage'],
        ]),
      ),
    );
    await expectCode('P0002', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_set_role_permissions($1,$2)', [
          roles.viewer,
          ['unknown.audit.permission'],
        ]),
      ),
    );
  });
  await test('atomic role diff is audited; direct role_permissions writes are denied', async () => {
    const out = await asRole('authenticated', A, (c) =>
      c.query('select public.admin_set_role_permissions($1,$2) as result', [
        roles.viewer,
        ['dashboard.view', 'workspace.1.access'],
      ]),
    );
    assert.deepEqual(out.rows[0].result.granted, ['workspace.1.access']);
    assert.equal(
      (
        await db.query(
          "select 1 from public.audit_logs where action='role.permissions_updated' and entity_id=$1",
          [roles.viewer],
        )
      ).rowCount,
      1,
    );
    await expectCode('42501', () =>
      asRole('authenticated', A, (c) =>
        c.query('delete from public.role_permissions where role_id=$1', [roles.viewer]),
      ),
    );
  });

  await test('user_roles writes are RPC-only, audited, and self-demotion protected', async () => {
    await expectCode('42501', () =>
      asRole('authenticated', C, (c) =>
        c.query('delete from public.user_roles where user_id=$1', [C]),
      ),
    );
    await expectCode('42501', () =>
      asRole('authenticated', C, (c) =>
        c.query('insert into public.user_roles(user_id,role_id) values ($1,$2)', [C, roles.viewer]),
      ),
    );
    await expectCode('RBA01', () =>
      asRole('authenticated', C, (c) =>
        c.query('select public.admin_set_user_roles($1,$2)', [C, ['viewer']]),
      ),
    );
    await expectCode('P0002', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_set_user_roles($1,$2)', [V, ['owner']]),
      ),
    );

    const result = await asRole('authenticated', C, (c) =>
      c.query('select public.admin_set_user_roles($1,$2) as result', [V, ['viewer', 'editor']]),
    );
    assert.deepEqual(result.rows[0].result.granted, ['editor']);
    assert.equal(
      (
        await db.query(
          "select 1 from public.audit_logs where action='role.granted' and entity='user_roles' and entity_id=$1",
          [V],
        )
      ).rowCount,
      1,
    );
  });
  await test('assignment and status RPCs preserve the only active super_admin', async () => {
    // Fixture setup: the production RPC now refuses any mutation of a protected
    // super_admin identity, so remove the second assignment as the DB owner to
    // exercise the remaining last-admin status guard.
    await db.query('delete from public.user_roles where user_id=$1 and role_id=$2', [
      B,
      roles.super_admin,
    ]);
    await expectCode('42501', () =>
      asRole('authenticated', C, (c) =>
        c.query('select public.admin_set_user_roles($1,$2)', [A, ['viewer']]),
      ),
    );
    await expectCode('RBA02', () =>
      asRole('authenticated', C, (c) =>
        c.query("select public.admin_set_user_status($1,'suspended')", [A]),
      ),
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select count(distinct p.id)::int as n from public.profiles p join public.user_roles ur on ur.user_id=p.id join public.roles r on r.id=ur.role_id where p.status='active' and r.slug='super_admin'",
          )
        ).rows[0].n,
      ),
      1,
    );
    await db.query(
      'insert into public.user_roles(user_id,role_id) values ($1,$2) on conflict do nothing',
      [B, roles.super_admin],
    );
  });
  await test('concurrent mutual suspensions serialize without locking out administrators', async () => {
    await db.query("update public.profiles set status='active' where id=any($1::uuid[])", [[A, B]]);
    const ca = await connect();
    const cb = await connect();
    try {
      for (const [client, id] of [
        [ca, A],
        [cb, B],
      ]) {
        await client.query('begin');
        await client.query('set local role authenticated');
        await client.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
        await client.query("select set_config('request.jwt.claim.role','authenticated',true)");
        assert.equal((await client.query('select public.is_admin() as value')).rows[0].value, true);
      }

      await ca.query("select public.admin_set_user_status($1,'suspended')", [B]);
      const secondCall = cb.query("select public.admin_set_user_status($1,'suspended')", [A]).then(
        () => null,
        (error) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await ca.query('commit');
      const secondError = await secondCall;
      assert.equal(secondError?.code, '42501');
      await cb.query('rollback');

      assert.equal(
        Number(
          (
            await db.query(
              "select count(distinct p.id)::int as n from public.profiles p join public.user_roles ur on ur.user_id=p.id join public.roles r on r.id=ur.role_id where p.status='active' and r.slug='super_admin'",
            )
          ).rows[0].n,
        ),
        1,
      );
    } finally {
      await ca.end();
      await cb.end();
      await db.query("update public.profiles set status='active' where id=any($1::uuid[])", [
        [A, B],
      ]);
    }
  });

  await test('custom backup queue is retired, inaccessible, and points to Supabase-managed backups', async () => {
    const settings = (await db.query('select enabled from public.backup_settings where singleton'))
      .rows[0];
    assert.equal(settings.enabled, false);

    const retiredJob = (
      await db.query(
        `select status, error_summary, finished_at
           from public.backup_logs
          where error_summary = 'Legacy backup worker retired; use Supabase-managed backups.'`,
      )
    ).rows[0];
    assert.ok(retiredJob);
    assert.equal(retiredJob.status, 'failed');
    assert.ok(retiredJob.finished_at);

    const scheduledJobs = await db.query(
      `select count(*)::int as n from cron.job
        where jobname in (
          'generate-scheduled-backup-requests-europe-paris-0100',
          'generate-scheduled-backup-requests-hourly'
        ) and database = current_database()`,
    );
    assert.equal(scheduledJobs.rows[0].n, 0);

    const retiredFunctions = await db.query(
      `select count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'admin_trigger_manual_backup',
            'admin_update_backup_settings',
            'admin_claim_next_backup_job',
            'generate_scheduled_backup_requests',
            'backup_logs_stamp_finished'
          )`,
    );
    assert.equal(retiredFunctions.rows[0].n, 0);

    const retiredTrigger = await db.query(
      `select count(*)::int as n from pg_trigger
        where tgrelid = 'public.backup_logs'::regclass
          and tgname = 'backup_logs_stamp_finished' and not tgisinternal`,
    );
    assert.equal(retiredTrigger.rows[0].n, 0);

    const realtimeTables = await db.query(
      `select count(*)::int as n from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename in ('backup_logs', 'backup_settings')`,
    );
    assert.equal(realtimeTables.rows[0].n, 0);
    const storagePolicies = await db.query(
      `select count(*)::int as n from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'backup_objects_super_admin_read'`,
    );
    assert.equal(storagePolicies.rows[0].n, 0);

    for (const role of ['anon', 'authenticated', 'service_role']) {
      const userId = role === 'authenticated' ? A : null;
      for (const table of ['public.backup_settings', 'public.backup_logs']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const access = await db.query('select has_table_privilege($1, $2, $3) as allowed', [
            role,
            table,
            privilege,
          ]);
          assert.equal(
            access.rows[0].allowed,
            false,
            `${role} must not have ${privilege} on ${table}`,
          );
        }
      }
      await expectDenied(() =>
        asRole(role, userId, (c) => c.query('select * from public.backup_logs')),
      );
      await expectDenied(() =>
        asRole(role, userId, (c) =>
          c.query("insert into public.backup_logs(backup_type,status) values ('manual','queued')"),
        ),
      );
    }
  });

  await test('appearance capability helper matches the settings.manage contract', async () => {
    assert.equal(
      (
        await asRole('authenticated', A, (c) =>
          c.query('select public.can_manage_appearance() as ok'),
        )
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await asRole('authenticated', V, (c) =>
          c.query('select public.can_manage_appearance() as ok'),
        )
      ).rows[0].ok,
      false,
    );
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', [
          JSON.stringify({ 'appearance.default_theme': 'dark' }),
        ]),
      ),
    );
  });

  await test('app_settings direct writes are revoked; public keys stay readable', async () => {
    // SELECT remains open for the public keys (RLS policy, not table grant).
    assert.ok(
      Number(
        (
          await asRole('authenticated', V, (c) =>
            c.query('select * from public.app_settings where is_public'),
          )
        ).rowCount,
      ) >= 5,
    );
    for (const [role, actor] of [
      ['authenticated', A],
      ['authenticated', V],
    ]) {
      await expectDenied(() =>
        asRole(role, actor, (c) =>
          c.query(
            "insert into public.app_settings (key, group_slug, value, is_public) values ('appearance.probe', 'appearance', '1'::jsonb, true)",
          ),
        ),
      );
      await expectDenied(() =>
        asRole(role, actor, (c) =>
          c.query(
            "update public.app_settings set value='1'::jsonb where key='appearance.default_theme'",
          ),
        ),
      );
      await expectDenied(() =>
        asRole(role, actor, (c) =>
          c.query("delete from public.app_settings where key='appearance.default_theme'"),
        ),
      );
    }
  });

  await test('appearance RPC enforces whitelist, validation, pairing and optimistic lock', async () => {
    // Non-object / empty payloads.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', ['{}']),
      ),
    );
    // Foreign keys are rejected outright.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', [
          JSON.stringify({ 'general.maintenance_mode': true }),
        ]),
      ),
    );
    // Invalid theme value.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', [
          JSON.stringify({ 'appearance.default_theme': 'neon' }),
        ]),
      ),
    );
    // Unknown IANA zone.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', [
          JSON.stringify({ 'appearance.default_timezone': 'Mars/Olympus_Mons' }),
        ]),
      ),
    );
    // Locale/direction pair mismatch.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb)', [
          JSON.stringify({
            'appearance.default_locale': 'en',
            'appearance.default_direction': 'rtl',
          }),
        ]),
      ),
    );
    // Out-of-range / duplicate / too-many weekend days.
    for (const weekend of [[0], [6, 6], [5, 6, 7, 1]]) {
      await expectCode('22023', () =>
        asRole('authenticated', A, (c) =>
          c.query('select public.admin_update_appearance_settings($1::jsonb)', [
            JSON.stringify({ 'appearance.weekend_days': weekend }),
          ]),
        ),
      );
    }

    // Happy path: a grouped, diff-only write with an audit trail.
    const payload = {
      'appearance.default_timezone': 'Asia/Riyadh',
      'appearance.weekend_days': [5, 6],
      'appearance.default_theme': 'dark',
    };
    const beforeCount = Number(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where action='settings.updated' and entity='app_settings'",
        )
      ).rows[0].n,
    );
    const result = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb) as out', [
          JSON.stringify(payload),
        ]),
      )
    ).rows[0].out;
    assert.equal(result.default_timezone, 'Asia/Riyadh');
    assert.deepEqual(result.weekend_days, [5, 6]);
    assert.equal(result.default_theme, 'dark');
    assert.equal(result.default_locale, 'ar'); // untouched keys keep their seed
    assert.ok(result.updated_at);

    const auditRows = (
      await db.query(
        "select metadata from public.audit_logs where action='settings.updated' and entity='app_settings' order by id desc limit 1",
      )
    ).rows;
    assert.equal(
      Number(
        (
          await db.query(
            "select count(*)::int as n from public.audit_logs where action='settings.updated' and entity='app_settings'",
          )
        ).rows[0].n,
      ),
      beforeCount + 1,
    );
    assert.equal(auditRows[0].metadata.group, 'appearance');
    assert.deepEqual(Object.keys(auditRows[0].metadata.changed).sort(), [
      'default_theme',
      'default_timezone',
      'weekend_days',
    ]);
    assert.equal(auditRows[0].metadata.changed.default_timezone.new, 'Asia/Riyadh');
    assert.deepEqual(auditRows[0].metadata.changed.weekend_days.old, [6, 7]);

    // Identical re-write is a no-op: no new audit row.
    await asRole('authenticated', A, (c) =>
      c.query('select public.admin_update_appearance_settings($1::jsonb)', [
        JSON.stringify(payload),
      ]),
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select count(*)::int as n from public.audit_logs where action='settings.updated' and entity='app_settings'",
          )
        ).rows[0].n,
      ),
      beforeCount + 1,
    );

    // Optimistic lock: a stale version raises LOC02.
    await expectCode('LOC02', () =>
      asRole('authenticated', A, (c) =>
        c.query('select public.admin_update_appearance_settings($1::jsonb, $2::timestamptz)', [
          JSON.stringify({ 'appearance.default_theme': 'light' }),
          '2026-01-01T00:00:00Z',
        ]),
      ),
    );

    // Restore the seed contract for a clean report and idempotent re-runs.
    const restore = {
      'appearance.default_timezone': 'Europe/Paris',
      'appearance.weekend_days': [6, 7],
      'appearance.default_theme': 'system',
    };
    await asRole('authenticated', A, (c) =>
      c.query('select public.admin_update_appearance_settings($1::jsonb, $2::timestamptz)', [
        JSON.stringify(restore),
        result.updated_at,
      ]),
    );
    const restored = (
      await db.query(
        "select key, value from public.app_settings where key in ('appearance.default_timezone','appearance.weekend_days','appearance.default_theme') order by key",
      )
    ).rows;
    assert.deepEqual(Object.fromEntries(restored.map((r) => [r.key, r.value])), {
      'appearance.default_theme': 'system',
      'appearance.default_timezone': 'Europe/Paris',
      'appearance.weekend_days': [6, 7],
    });
  });

  await test('notification carriers are typed, RLS-forced, and unreachable without an RPC', async () => {
    for (const table of [
      'public.notification_transports',
      'public.notification_transport_secrets',
      'public.notification_encryption_keys',
    ]) {
      const flags = await db.query(
        'select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass',
        [table],
      );
      assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true }, table);
    }

    // The secrets table must carry ZERO PERMISSIVE policies of any kind (study
    // §1.3 / P4). The approval hardening layers one blanket RESTRICTIVE
    // `approved_access_only` guard onto every RLS table; restrictive-only rows
    // can never let anything through (no permissive policy exists at all).
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from pg_policy where polrelid = 'public.notification_transport_secrets'::regclass and polpermissive",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await db.query(
          "select polname from pg_policy where polrelid = 'public.notification_transport_secrets'::regclass order by polname",
        )
      ).rows.map((row) => row.polname),
      ['approved_access_only'],
    );

    // The one jsonb column is the whitelisted, non-secret config slot (study
    // §1.2.1). Anything else would be another chance to hide a credential.
    assert.deepEqual(
      (
        await db.query(
          `select a.attname, a.attnotnull
             from pg_attribute a
             join pg_type ty on ty.oid = a.atttypid
            where a.attrelid = 'public.notification_transports'::regclass
              and a.attnum > 0
              and not a.attisdropped
              and ty.typname = 'jsonb'`,
        )
      ).rows,
      [{ attname: 'config', attnotnull: true }],
    );
    for (const constraint of [
      'notification_transports_config_object',
      'notification_transports_config_size',
      'notification_transports_config_whitelist',
    ]) {
      assert.equal(
        (
          await db.query(
            'select count(*)::int as n from pg_constraint where conname = $1 and conrelid = $2::regclass',
            [constraint, 'public.notification_transports'],
          )
        ).rows[0].n,
        1,
        constraint,
      );
    }
    // The validator must stay uncallable from a browser session. service_role
    // keeps EXECUTE because a CHECK constraint runs as the writing role.
    for (const [role, expected] of [
      ['anon', false],
      ['authenticated', false],
      ['service_role', true],
    ]) {
      assert.equal(
        (
          await db.query(
            "select has_function_privilege($1, 'public.notification_transport_config_is_valid(jsonb)', 'execute') as allowed",
            [role],
          )
        ).rows[0].allowed,
        expected,
        role,
      );
    }
    assert.equal(
      (
        await db.query(
          `select ty.typname
             from pg_attribute a
             join pg_type ty on ty.oid = a.atttypid
            where a.attrelid = 'public.notification_transport_secrets'::regclass
              and a.attname = 'secret_ciphertext'`,
        )
      ).rows[0].typname,
      'bytea',
    );

    const tables = [
      'public.notification_transports',
      'public.notification_transport_secrets',
      'public.notification_encryption_keys',
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        for (const table of tables) {
          assert.equal(
            (
              await db.query('select has_table_privilege($1, $2, $3) as allowed', [
                role,
                table,
                privilege,
              ])
            ).rows[0].allowed,
            false,
            `${role} must not have ${privilege} on ${table}`,
          );
        }
      }
    }
    for (const [privilege, expected] of [
      ['SELECT', true],
      ['INSERT', true],
      ['UPDATE', true],
      ['DELETE', false],
    ]) {
      assert.equal(
        (
          await db.query('select has_table_privilege($1, $2, $3) as allowed', [
            'service_role',
            'public.notification_transport_secrets',
            privilege,
          ])
        ).rows[0].allowed,
        expected,
        `service_role ${privilege}`,
      );
    }

    // Secrets must never be published to Realtime (study C9).
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename in ('notification_transports',
                                'notification_transport_secrets',
                                'notification_encryption_keys')`,
        )
      ).rows[0].n,
      0,
    );

    // The internal snapshot helper and the Path B writer stay un-granted.
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'notification_transport_snapshot'
              and has_function_privilege('authenticated', p.oid, 'execute')`,
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'admin_store_email_secret'
              and has_function_privilege('authenticated', p.oid, 'execute')`,
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'admin_store_email_secret'
              and has_function_privilege('service_role', p.oid, 'execute')`,
        )
      ).rows[0].n,
      1,
    );

    // Both audit values are appended to the enum tail.
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_enum e
             join pg_type t on t.oid = e.enumtypid
            where t.typname = 'audit_action'
              and e.enumlabel in ('email.transport_updated', 'email.credentials_rotated')`,
        )
      ).rows[0].n,
      2,
    );
  });

  await test('transport capability and the masked snapshot obey settings.manage', async () => {
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) => c.query('select public.admin_get_email_transport()')),
    );
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'default-smtp', p_host := 'denied.example.invalid')",
        ),
      ),
    );

    const snapshot = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_get_email_transport() as out'),
      )
    ).rows[0].out;
    assert.equal(snapshot.slug, 'default-smtp');
    assert.equal(snapshot.has_password, false);
    assert.equal(snapshot.fingerprint, null);
    assert.equal(snapshot.secrets_version, 0);
    assert.ok(snapshot.warnings.includes('disabled'));
    for (const forbidden of [
      'secret_ciphertext',
      'nonce',
      'wrapped_key',
      'content_fingerprint',
      'password',
    ]) {
      assert.equal(Object.keys(snapshot).includes(forbidden), false, forbidden);
    }

    // Direct table access stays closed for every API role.
    await expectDenied(() =>
      asRole('authenticated', A, (c) =>
        c.query('select * from public.notification_transports limit 1'),
      ),
    );
    await expectDenied(() =>
      asRole('authenticated', A, (c) =>
        c.query('select * from public.notification_transport_secrets limit 1'),
      ),
    );
    await expectDenied(() =>
      asRole('authenticated', A, (c) =>
        c.query('select * from public.notification_encryption_keys limit 1'),
      ),
    );
  });

  await test('transport RPC validates fields, locks optimistically, and audits names only', async () => {
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query(
            "select public.admin_update_email_transport(p_slug := 'default-smtp', p_host := $1)",
            ['bad host value.invalid'],
          ),
        ),
      (error) => {
        assert.equal(error.code, '22023');
        assert.equal(error.detail, 'field: host');
        assert.equal(String(error.message).includes('bad host value.invalid'), false);
        return true;
      },
    );

    const auditBefore = Number(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where action = 'email.transport_updated'",
        )
      ).rows[0].n,
    );

    const updated = (
      await asRole('authenticated', A, (c) =>
        c.query(`select public.admin_update_email_transport(
            p_slug := 'default-smtp',
            p_host := 'smtp.audit.invalid',
            p_port := 465,
            p_tls_mode := 'implicit_tls',
            p_sender_email := 'no-reply@audit.invalid',
            p_sender_name := 'Audit System',
            p_daily_quota := 500
          ) as out`),
      )
    ).rows[0].out;
    assert.equal(updated.host, 'smtp.audit.invalid');
    assert.equal(updated.port, 465);
    assert.equal(updated.tls_mode, 'implicit_tls');
    assert.equal(updated.daily_quota, 500);
    assert.equal(updated.is_enabled, false);
    assert.equal(updated.is_default, true);

    const metadata = (
      await db.query(
        "select metadata from public.audit_logs where action = 'email.transport_updated' order by id desc limit 1",
      )
    ).rows[0].metadata;
    assert.equal(
      Number(
        (
          await db.query(
            "select count(*)::int as n from public.audit_logs where action = 'email.transport_updated'",
          )
        ).rows[0].n,
      ),
      auditBefore + 1,
    );
    assert.ok(metadata.changed_fields.includes('host'));
    assert.equal(metadata.transition, 'updated');
    assert.equal(metadata.before.port, 587);
    assert.equal(metadata.after.port, 465);
    assert.equal(metadata.host_changed, true);
    assert.equal(metadata.sender_changed, true);
    assert.equal(JSON.stringify(metadata).includes('smtp.audit.invalid'), false);
    assert.equal(JSON.stringify(metadata).includes('no-reply@audit.invalid'), false);

    // Identical re-write: no UPDATE, no new audit row.
    await asRole('authenticated', A, (c) =>
      c.query(`select public.admin_update_email_transport(
          p_slug := 'default-smtp',
          p_host := 'smtp.audit.invalid',
          p_port := 465,
          p_tls_mode := 'implicit_tls',
          p_sender_email := 'no-reply@audit.invalid',
          p_sender_name := 'Audit System',
          p_daily_quota := 500
        )`),
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select count(*)::int as n from public.audit_logs where action = 'email.transport_updated'",
          )
        ).rows[0].n,
      ),
      auditBefore + 1,
    );

    // Stale snapshot → MAIL01 (SQLSTATE MAIL1).
    await expectCode('MAIL1', () =>
      asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'default-smtp', p_host := 'smtp.stale.invalid', p_expected_updated_at := '2026-01-01T00:00:00Z')",
        ),
      ),
    );

    // Enabling without credentials is refused with a stable code.
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'default-smtp', p_is_enabled := true)",
        ),
      ),
    );
  });

  await test('carrier config is whitelisted and never stores a credential', async () => {
    const sentinel = `SENTINEL-${randomUUID()}`;

    // (1) A valid, non-secret extension slot is accepted end to end.
    const withConfig = (
      await asRole('authenticated', A, (c) =>
        c.query(
          `select public.admin_update_email_transport(
             p_slug := 'default-smtp',
             p_config := $1::jsonb
           ) as out`,
          [
            JSON.stringify({
              headers: { 'X-Entity-Ref-ID': 'notifications', 'List-Unsubscribe': 'none' },
            }),
          ],
        ),
      )
    ).rows[0].out;
    assert.deepEqual(withConfig.config, {
      headers: { 'X-Entity-Ref-ID': 'notifications', 'List-Unsubscribe': 'none' },
    });

    // (2) Unknown keys are refused (whitelist: headers only) — value-free message.
    for (const payload of [
      { smtp_password: sentinel },
      { password: sentinel },
      { api_key: sentinel },
      { max_recipients_per_message: 900 },
      { headers: { Authorization: `Bearer ${sentinel}` } },
      { headers: { 'X-Api-Key': sentinel } },
      { headers: { 'X-Auth': `token-${sentinel}` } },
      { headers: { 'X-Custom': 'A'.repeat(3000) } },
      { headers: { 'X-Custom': 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5' } },
      { headers: { 'X-Custom': 'first\nInjected: header' } },
      { headers: { 'X-Custom': 'x'.repeat(600) } },
      { headers: 'not-an-object' },
    ]) {
      await assert.rejects(
        () =>
          asRole('authenticated', A, (c) =>
            c.query(
              'select public.admin_update_email_transport(p_slug := $1, p_config := $2::jsonb)',
              ['default-smtp', JSON.stringify(payload)],
            ),
          ),
        (error) => {
          assert.equal(error.code, '22023', JSON.stringify(payload));
          assert.equal(error.detail, 'field: config');
          assert.equal(String(error.message).includes(sentinel), false);
          assert.equal(JSON.stringify(error).includes(sentinel), false);
          return true;
        },
      );
    }

    // (3) The CHECK constraint is the backstop: a direct service_role write with
    //     a credential-shaped value never reaches the table either.
    await expectCode('23514', () =>
      asRole('service_role', null, (c) =>
        c.query(
          "update public.notification_transports set config = $1::jsonb where slug = 'default-smtp'",
          [
            JSON.stringify({
              headers: {
                'X-Custom':
                  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
              },
            }),
          ],
        ),
      ),
    );

    // (4) Validation happens before the write: the row still holds the last
    //     accepted value and nothing leaked into the audit trail.
    const stored = (
      await db.query(
        "select config from public.notification_transports where slug = 'default-smtp'",
      )
    ).rows[0].config;
    assert.deepEqual(stored, {
      headers: { 'X-Entity-Ref-ID': 'notifications', 'List-Unsubscribe': 'none' },
    });
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where metadata::text like '%' || $1 || '%'",
          [sentinel],
        )
      ).rows[0].n,
      0,
    );

    // (5) Audit metadata records config key names only, never the values.
    const metadata = (
      await db.query(
        "select metadata from public.audit_logs where action = 'email.transport_updated' order by id desc limit 1",
      )
    ).rows[0].metadata;
    assert.equal(metadata.config_changed, true);
    assert.deepEqual(metadata.after.config_keys, ['headers']);
    assert.equal(JSON.stringify(metadata).includes('X-Entity-Ref-ID'), false);

    // (6) An empty object clears the slot again (full replace, not a merge).
    const cleared = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'default-smtp', p_config := '{}'::jsonb) as out",
        ),
      )
    ).rows[0].out;
    assert.deepEqual(cleared.config, {});
  });

  await test('reserved KV namespaces and plaintext-shaped secrets are rejected', async () => {
    await expectCode('MAIL4', () =>
      db.query(
        "insert into public.app_settings (key, group_slug, value, is_public) values ('notifications.smtp_password', 'notifications', '\"x\"'::jsonb, false)",
      ),
    );
    await expectCode('MAIL4', () =>
      db.query(
        "insert into public.app_settings (key, group_slug, value, is_public) values ('email.transport', 'general', '{}'::jsonb, false)",
      ),
    );

    const key = (
      await db.query('select id from public.notification_encryption_keys where is_current')
    ).rows[0];
    const transport = (
      await db.query("select id from public.notification_transports where slug = 'default-smtp'")
    ).rows[0];

    // A plaintext-shaped payload never reaches the table.
    await expectCode('22023', () =>
      db.query(
        `insert into public.notification_transport_secrets
           (transport_id, secret_ciphertext, key_id, cipher, nonce, content_fingerprint, secrets_version)
         values ($1, $2, $3, 'aes-256-gcm', extensions.gen_random_bytes(12), repeat('a', 64), 1)`,
        [transport.id, Buffer.from('P@ssw0rd-plaintext-01'), key.id],
      ),
    );

    // Wrong nonce length for the declared AEAD suite.
    await expectCode('22023', () =>
      db.query(
        `insert into public.notification_transport_secrets
           (transport_id, secret_ciphertext, key_id, cipher, nonce, content_fingerprint, secrets_version)
         values ($1, extensions.gen_random_bytes(48), $2, 'xsalsa20-poly1305', extensions.gen_random_bytes(12), repeat('b', 64), 1)`,
        [transport.id, key.id],
      ),
    );

    // Key provenance is mandatory (exactly one of key_id / kms_key_id).
    await expectCode('23514', () =>
      db.query(
        `insert into public.notification_transport_secrets
           (transport_id, secret_ciphertext, cipher, nonce, content_fingerprint, secrets_version)
         values ($1, extensions.gen_random_bytes(48), 'aes-256-gcm', extensions.gen_random_bytes(12), repeat('c', 64), 1)`,
        [transport.id],
      ),
    );
  });

  await test('credential rotation is deterministic and never leaks a value', async () => {
    const pathA = (
      await db.query(
        "select to_regprocedure('pgsodium.crypto_secretbox(bytea, bytea, bytea)') is not null as ready",
      )
    ).rows[0].ready;
    const keyRow = (
      await db.query(
        'select key_version, key_source from public.notification_encryption_keys where is_current',
      )
    ).rows[0];
    assert.equal(keyRow.key_version, 1);
    assert.equal(keyRow.key_source, pathA ? 'vault' : 'external');

    const sentinel = `SENTINEL-${randomUUID()}`;
    const expectedFingerprint = createHash('sha256').update(sentinel, 'utf8').digest('hex');

    if (pathA) {
      const rotated = (
        await asRole('authenticated', A, (c) =>
          c.query('select public.admin_set_email_password($1) as out', [sentinel]),
        )
      ).rows[0].out;
      assert.equal(rotated.has_password, true);
      assert.equal(rotated.fingerprint, expectedFingerprint.slice(0, 8));
      assert.equal(rotated.cipher, 'xsalsa20-poly1305');

      const stored = (
        await db.query(
          `select s.secret_ciphertext, s.content_fingerprint
             from public.notification_transport_secrets s
             join public.notification_transports t on t.id = s.transport_id
            where t.slug = 'default-smtp'`,
        )
      ).rows[0];
      assert.equal(stored.content_fingerprint, expectedFingerprint);
      assert.equal(Buffer.from(stored.secret_ciphertext).includes(Buffer.from(sentinel)), false);
      assert.equal(
        (
          await db.query(
            "select count(*)::int as n from vault.decrypted_secrets where decrypted_secret like '%' || $1 || '%'",
            [sentinel],
          )
        ).rows[0].n,
        0,
      );

      // Path B storage stays refused while the current key is a vault key.
      await expectCode('SEC01', () =>
        asRole('service_role', null, (c) =>
          c.query(
            `select public.admin_store_email_secret(
               p_transport_slug := $1, p_cipher := $2, p_ciphertext := $3, p_nonce := $4,
               p_content_fingerprint := $5, p_key_version := $6, p_tag := $7, p_kms_key_id := $8
             )`,
            [
              'default-smtp',
              'aes-256-gcm',
              randomBytes(48),
              randomBytes(12),
              expectedFingerprint,
              1,
              randomBytes(16),
              'env-audit-v1',
            ],
          ),
        ),
      );
    } else {
      // Without pgsodium/vault the in-database path fails closed, loudly and
      // without leaking anything; the Path B writer remains the sanctioned path.
      await expectCode('MAIL3', () =>
        asRole('authenticated', A, (c) =>
          c.query('select public.admin_set_email_password($1)', [sentinel]),
        ),
      );

      const storedExternal = (
        await asRole('service_role', null, (c) =>
          c.query(
            `select public.admin_store_email_secret(
               p_transport_slug := $1, p_cipher := $2, p_ciphertext := $3, p_nonce := $4,
               p_content_fingerprint := $5, p_key_version := $6, p_tag := $7, p_kms_key_id := $8
             ) as out`,
            [
              'default-smtp',
              'aes-256-gcm',
              randomBytes(48),
              randomBytes(12),
              expectedFingerprint,
              1,
              randomBytes(16),
              'env-audit-v1',
            ],
          ),
        )
      ).rows[0].out;
      assert.equal(storedExternal.has_password, true);
      assert.equal(storedExternal.fingerprint, expectedFingerprint.slice(0, 8));
      assert.equal(storedExternal.key_source, 'external');
      assert.equal(storedExternal.secrets_version, 1);
    }

    // Audit metadata carries 8-char fingerprints and never the full hash.
    const metadata = (
      await db.query(
        "select metadata from public.audit_logs where action = 'email.credentials_rotated' order by id desc limit 1",
      )
    ).rows[0].metadata;
    assert.equal(metadata.content_fingerprint.length, 8);
    assert.equal(JSON.stringify(metadata).includes(expectedFingerprint), false);
    assert.equal(JSON.stringify(metadata).includes(sentinel), false);

    // Enabling now succeeds because credentials exist.
    const enabled = (
      await asRole('authenticated', A, (c) =>
        c.query(
          'select public.admin_update_email_transport(p_slug := $1, p_is_enabled := $2) as out',
          ['default-smtp', true],
        ),
      )
    ).rows[0].out;
    assert.equal(enabled.is_enabled, true);
    assert.equal(enabled.has_password, true);
    assert.equal(enabled.fingerprint, expectedFingerprint.slice(0, 8));

    // A second enabled default is refused.
    await asRole('authenticated', A, (c) =>
      c.query(
        "select public.admin_update_email_transport(p_slug := 'bulk-smtp', p_host := 'bulk.audit.invalid', p_sender_email := 'bulk@audit.invalid', p_sender_name := 'Bulk', p_is_default := false)",
      ),
    );
    await expectCode('22023', () =>
      asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'bulk-smtp', p_is_default := true, p_is_enabled := true)",
        ),
      ),
    );

    // Clearing disables the carrier, removes the row, and rotates the counter.
    const cleared = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_clear_email_password() as out'),
      )
    ).rows[0].out;
    assert.equal(cleared.has_password, false);
    assert.equal(cleared.is_enabled, false);
    assert.equal(cleared.fingerprint, null);
    assert.ok(cleared.secrets_version >= 1);
    assert.equal(
      (await db.query('select count(*)::int as n from public.notification_transport_secrets'))
        .rows[0].n,
      0,
    );

    // Sentinel sweep: no value in any audit row, and failing calls stay silent.
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where metadata::text like '%' || $1 || '%'",
          [sentinel],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query('select public.admin_set_email_password($1, 999)', [sentinel]),
        ),
      (error) => {
        assert.equal(String(error.message).includes(sentinel), false);
        assert.equal(['MAIL1', 'MAIL3'].includes(error.code), true);
        return true;
      },
    );
  });

  await test('path A encrypts in-database when vault material is available (contract stub)', async () => {
    // The offline fixture ships no pgsodium/vault, exactly like a bare
    // PostgreSQL. The real extension is exercised by the Supabase CI image.
    // The stub below proves the SQL path resolves end to end and that no
    // plaintext ever reaches the vault store or the audit trail.
    const keyBefore = (
      await db.query(
        'select id, key_version from public.notification_encryption_keys where is_current',
      )
    ).rows[0];

    await db.query('create schema pgsodium');
    await db.query(`create function pgsodium.crypto_secretbox(message bytea, nonce bytea, key bytea)
      returns bytea
      language sql
      immutable
      set search_path = pg_catalog, public
      as $$ select nonce || extensions.digest(message || key, 'sha256') $$`);
    await db.query('create schema vault');
    await db.query(
      'create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text)',
    );
    // Real vault stores the secret as text and exposes it decrypted as text.
    await db.query(`create view vault.decrypted_secrets as
      select id, name, description, secret, secret as decrypted_secret
        from vault.secrets`);

    await db.query(
      'update public.notification_encryption_keys set is_current = false where id = $1',
      [keyBefore.id],
    );
    const vaultSecret = (
      await db.query(
        `insert into vault.secrets (secret, name, description)
         values (encode(extensions.gen_random_bytes(32), 'hex'), 'notification-transport-dek-v2', 'audit stub')
         returning id`,
      )
    ).rows[0];
    const registry = (
      await db.query(
        `insert into public.notification_encryption_keys
           (key_version, key_source, vault_secret_id, is_current, rotated_at)
         values (2, 'vault', $1, true, now())
         returning id`,
        [vaultSecret.id],
      )
    ).rows[0];

    const sentinel = `SENTINEL-${randomUUID()}`;
    const expectedFingerprint = createHash('sha256').update(sentinel, 'utf8').digest('hex');
    const rotated = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_set_email_password($1) as out', [sentinel]),
      )
    ).rows[0].out;
    assert.equal(rotated.has_password, true);
    assert.equal(rotated.fingerprint, expectedFingerprint.slice(0, 8));
    assert.equal(rotated.cipher, 'xsalsa20-poly1305');
    assert.equal(rotated.key_source, 'vault');
    assert.equal(rotated.key_version, 2);

    const stored = (
      await db.query(
        `select s.secret_ciphertext, s.content_fingerprint, s.key_id
           from public.notification_transport_secrets s
           join public.notification_transports t on t.id = s.transport_id
          where t.slug = 'default-smtp'`,
      )
    ).rows[0];
    assert.equal(stored.content_fingerprint, expectedFingerprint);
    assert.equal(stored.key_id, registry.id);
    assert.equal(Buffer.from(stored.secret_ciphertext).includes(Buffer.from(sentinel)), false);

    // The vault store holds only the DEK; the password never enters it, the
    // audit trail, or any error message.
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from vault.decrypted_secrets where decrypted_secret like '%' || $1 || '%'",
          [sentinel],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.audit_logs where metadata::text like '%' || $1 || '%'",
          [sentinel],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query('select public.admin_set_email_password($1, 999)', [sentinel]),
        ),
      (error) => {
        assert.equal(error.code, 'MAIL1');
        assert.equal(String(error.message).includes(sentinel), false);
        return true;
      },
    );

    // Rotating again keeps a strict +1 version and an 8-char audit fingerprint.
    const rotatedAgain = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_set_email_password($1, $2) as out', [
          `${sentinel}-2`,
          rotated.secrets_version,
        ]),
      )
    ).rows[0].out;
    assert.equal(rotatedAgain.secrets_version, rotated.secrets_version + 1);
    assert.equal(rotatedAgain.key_version, 2);
  });

  // ---------------------------------------------------------------------------
  // Phase 2 — notification templates (study §2.x and §3.7 cases A7..A12, A16)
  // ---------------------------------------------------------------------------
  await test('template table is RLS-forced, policy-gated, and realtime-scoped', async () => {
    const flags = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.notification_templates'::regclass",
    );
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    // Zero PERMISSIVE write policies: the RPCs are the only sanctioned writers.
    // (The blanket RESTRICTIVE `approved_access_only` guard ANDs with whatever
    // permissive policies exist and never opens a write path by itself.)
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from pg_policy where polrelid = 'public.notification_templates'::regclass and polpermissive and polcmd in ('a','w','d','*')",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from pg_policy where polrelid = 'public.notification_templates'::regclass and polcmd = 'r'",
        )
      ).rows[0].n,
      1,
    );

    for (const [role, expected] of [
      ['anon', false],
      ['authenticated', true],
      ['service_role', true],
    ]) {
      assert.equal(
        (
          await db.query(
            "select has_table_privilege($1, 'public.notification_templates', 'SELECT') as allowed",
            [role],
          )
        ).rows[0].allowed,
        expected,
        `${role} SELECT`,
      );
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(
          (
            await db.query('select has_table_privilege($1, $2, $3) as allowed', [
              role,
              'public.notification_templates',
              privilege,
            ])
          ).rows[0].allowed,
          role === 'service_role',
          `${role} ${privilege}`,
        );
      }
    }

    // Both new audit values exist at the tail of the enum.
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_enum e join pg_type t on t.oid = e.enumtypid
            where t.typname = 'audit_action'
              and e.enumlabel in ('notification.template_updated','notification.template_previewed')`,
        )
      ).rows[0].n,
      2,
    );

    // The immutability guard exists and is not callable by an API role.
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'guard_notification_template_writes'
              and has_function_privilege('authenticated', p.oid, 'execute')`,
        )
      ).rows[0].n,
      0,
    );

    // Nothing is inserted again for archived/active rows on re-run: seeds are
    // idempotent (on conflict do nothing).
    assert.equal(
      (await db.query('select count(*)::int as n from public.notification_templates')).rows[0].n,
      6,
    );
  });

  await test('A16: realtime carries templates and never the secret stores', async () => {
    const published = (
      await db.query(
        `select tablename from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public'
          order by tablename`,
      )
    ).rows.map((row) => row.tablename);
    assert.ok(published.includes('notification_templates'), 'templates must be published');
    for (const forbidden of [
      'notification_transport_secrets',
      'notification_transports',
      'notification_encryption_keys',
    ]) {
      assert.equal(published.includes(forbidden), false, `${forbidden} must not be published`);
    }

    // A content change flows through the publication (wal_level=logical fixture),
    // which is what the Phase 4 invalidation channel will listen to.
    const table = (
      await db.query(
        "select relname, relreplident from pg_class where oid = 'public.notification_templates'::regclass",
      )
    ).rows[0];
    assert.equal(table.relreplident, 'd');
  });

  await test('seeded templates are complete, hashed correctly, and self-rendering', async () => {
    const seeds = (
      await db.query(
        `select id, key, locale, version, status, is_current, is_system, content_hash,
                variables, sample_variables, subject, body_text, body_html, direction
           from public.notification_templates
          order by key, locale`,
      )
    ).rows;
    assert.equal(seeds.length, 6);
    const keys = [...new Set(seeds.map((row) => row.key))].sort();
    assert.deepEqual(keys, [
      'auth.welcome_invitation',
      'backup.failure_notice',
      'security.suspension_alert',
    ]);
    for (const key of keys) {
      const locales = seeds
        .filter((row) => row.key === key)
        .map((row) => row.locale)
        .sort();
      assert.deepEqual(locales, ['ar', 'en'], key);
    }

    for (const seed of seeds) {
      assert.equal(seed.version, 1, seed.key);
      assert.equal(seed.status, 'active', seed.key);
      assert.equal(seed.is_current, true, seed.key);
      assert.equal(seed.is_system, true, seed.key);

      // The migration computed the hash with the same canonical function the
      // RPCs use: recompute it through the helper and compare.
      const recomputed = (
        await db.query('select public.notification_template_content_hash($1,$2,$3,$4) as hash', [
          seed.subject,
          seed.body_text,
          seed.body_html,
          JSON.stringify(seed.variables),
        ])
      ).rows[0].hash;
      assert.equal(recomputed, seed.content_hash, `${seed.key}/${seed.locale}`);

      // The seed renders from its own masked samples: this proves every token
      // is declared (fail-closed renderer) and the sample set is complete.
      const rendered = (
        await asRole('authenticated', A, (c) =>
          c.query('select public.admin_render_notification($1,$2,$3::jsonb,$4) as out', [
            seed.key,
            seed.locale,
            '{}',
            'preview',
          ]),
        )
      ).rows[0].out;
      assert.equal(rendered.resolved_locale, seed.locale);
      assert.equal(rendered.fallback_used, false);
      assert.equal(rendered.template_content_hash, seed.content_hash);
      assert.equal(rendered.subject.includes('{{'), false, `${seed.key}/${seed.locale} subject`);
      assert.equal(
        rendered.body_text.includes('{{'),
        false,
        `${seed.key}/${seed.locale} body_text`,
      );
      assert.equal(
        (rendered.body_html ?? '').includes('{{'),
        false,
        `${seed.key}/${seed.locale} body_html`,
      );

      // Direction is derived from the locale and the HTML carries dir.
      assert.equal(seed.direction, seed.locale === 'ar' ? 'rtl' : 'ltr');
    }
  });

  await test('template RPCs obey capabilities: editor writes content, never transports', async () => {
    // The content editor may read and write templates …
    const listed = (
      await asRole('authenticated', E, (c) =>
        c.query('select public.admin_list_notification_templates() as list'),
      )
    ).rows[0].list;
    assert.equal(Array.isArray(listed), false); // setof => one row per template
    const listRows = (
      await asRole('authenticated', E, (c) =>
        c.query(
          'select key, locale, version, status from public.admin_list_notification_templates()',
        ),
      )
    ).rows;
    assert.equal(listRows.length, 6);

    // … but has zero access to transport configuration (separation of duties).
    await expectCode('42501', () =>
      asRole('authenticated', E, (c) => c.query('select public.admin_get_email_transport()')),
    );
    await expectCode('42501', () =>
      asRole('authenticated', E, (c) =>
        c.query(
          "select public.admin_update_email_transport(p_slug := 'default-smtp', p_host := 'denied.example.invalid')",
        ),
      ),
    );

    // A capability-less user cannot reach any template RPC and sees no rows
    // through the policy (zero rows is the refusal, not an error).
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query('select public.admin_list_notification_templates()'),
      ),
    );
    await expectCode('42501', () =>
      asRole('authenticated', V, (c) =>
        c.query("select public.admin_render_notification('auth.welcome_invitation','ar')"),
      ),
    );
    const viewerRows = (
      await asRole('authenticated', V, (c) =>
        c.query('select * from public.notification_templates'),
      )
    ).rows;
    assert.equal(viewerRows.length, 0);
  });

  await test('A7: reserved and malformed tokens are refused with TPL05/TPL01', async () => {
    const probe = async (bodyText, bodyHtml = null) =>
      asRole('authenticated', A, (c) =>
        c.query(
          `select public.admin_upsert_notification_template_draft(
             p_key := 'probe.tokens', p_locale := 'ar', p_subject := 'probe',
             p_body_text := $1, p_body_html := $2,
             p_variables := '[{"name":"user_name","type":"text","required":true}]'::jsonb,
             p_sample_variables := '{"user_name":"x"}'::jsonb
           )`,
          [bodyText, bodyHtml],
        ),
      );

    await assert.rejects(
      () => probe('{{smtp_password}}'),
      (error) => {
        assert.equal(error.code, 'TPL05');
        assert.equal(error.detail, 'names: ["smtp_password"]');
        return true;
      },
    );
    await assert.rejects(
      () => probe('{{ secret_api_key }}'),
      (error) => {
        assert.equal(error.code, 'TPL05');
        return true;
      },
    );
    await assert.rejects(
      () => probe('{{{app_name}}}'),
      (error) => {
        assert.equal(error.code, 'TPL01');
        assert.equal(error.detail, 'names: ["triple_brace"]');
        return true;
      },
    );
    await assert.rejects(
      () => probe('{% if user_name %}x{% endif %}'),
      (error) => {
        assert.equal(error.code, 'TPL01');
        assert.equal(error.detail.includes('statement_block'), true);
        return true;
      },
    );
    await assert.rejects(
      () => probe('{{not_declared}}'),
      (error) => {
        assert.equal(error.code, 'TPL01');
        assert.equal(error.detail, 'names: ["not_declared"]');
        return true;
      },
    );
    await assert.rejects(
      () => probe('{{user_name}'),
      (error) => {
        assert.equal(error.code, 'TPL01');
        assert.equal(error.detail.includes('unbalanced_braces'), true);
        return true;
      },
    );

    // A reserved NAME in the variables whitelist is refused too (TPL05).
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `select public.admin_upsert_notification_template_draft(
               p_key := 'probe.tokens', p_locale := 'ar', p_subject := 'probe',
               p_body_text := 'x',
               p_variables := '[{"name":"service_role","type":"text","required":true}]'::jsonb,
               p_sample_variables := '{"service_role":"x"}'::jsonb
             )`,
          ),
        ),
      (error) => {
        assert.equal(error.code, 'TPL05');
        return true;
      },
    );

    // Nothing was written by any of the failures.
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.notification_templates where key = 'probe.tokens'",
        )
      ).rows[0].n,
      0,
    );
  });

  await test('A8: HTML allowlist refuses tags, handlers, attributes and schemes', async () => {
    const cases = [
      ['<p onclick="steal()">x</p>', 'attr:onclick'],
      ['<div><script>alert(1)</script></div>', 'tag:script'],
      ['<p><iframe src="https://evil.invalid"></iframe></p>', 'tag:iframe'],
      ['<a href="javascript:alert(1)">x</a>', null],
      ['<img src="data:text/html;base64,PHNjcmlwdD4="/>', 'scheme:unsafe'],
      ['<p style="behavior:url(#default#time2)">x</p>', 'css:unsafe'],
      ['<a href="{{user_name}}">x</a>', 'placeholder_in_attribute'],
      ['<p style="position:fixed">x</p>', 'css:position'],
    ];

    for (const [bodyHtml, expectedName] of cases) {
      await assert.rejects(
        () =>
          asRole('authenticated', A, (c) =>
            c.query(
              `select public.admin_upsert_notification_template_draft(
                 p_key := 'probe.html', p_locale := 'ar', p_subject := 'probe',
                 p_body_text := 'safe text',
                 p_body_html := $1,
                 p_variables := '[{"name":"user_name","type":"text","required":true}]'::jsonb,
                 p_sample_variables := '{"user_name":"x"}'::jsonb
               )`,
              [bodyHtml],
            ),
          ),
        (error) => {
          assert.equal(error.code, 'TPL04', bodyHtml);
          assert.equal(typeof error.detail, 'string');
          assert.equal(error.detail.startsWith('names: '), true);
          // Names only: the rejected markup never travels back to the client.
          assert.equal(error.detail.includes('<'), false, error.detail);
          if (expectedName) {
            assert.equal(
              error.detail.includes(expectedName),
              true,
              `${bodyHtml} -> ${error.detail}`,
            );
          }
          return true;
        },
      );
    }
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.notification_templates where key = 'probe.html'",
        )
      ).rows[0].n,
      0,
    );
  });

  await test('A9: variable values are escaped in html and hashed as rendered', async () => {
    const payload = '</td><script>alert(1)</script>';
    const variables = JSON.stringify([
      { name: 'user_name', type: 'text', required: true, max_length: 120 },
    ]);

    const draft = (
      await asRole('authenticated', A, (c) =>
        c.query(
          `select public.admin_upsert_notification_template_draft(
             p_key := 'probe.escape', p_locale := 'ar', p_subject := 'Hi {{user_name}}',
             p_body_text := 'Hi {{user_name}}',
             p_body_html := '<p>Hi {{user_name}}</p>',
             p_variables := $1::jsonb,
             p_sample_variables := '{"user_name":"Lina"}'::jsonb
           ) as out`,
          [variables],
        ),
      )
    ).rows[0].out;

    const rendered = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_render_notification('probe.escape','ar',$1::jsonb,'preview') as out",
          [JSON.stringify({ user_name: payload })],
        ),
      )
    ).rows[0].out;

    assert.equal(rendered.body_html.includes('<script>'), false);
    assert.equal(rendered.body_html.includes('&lt;/td&gt;'), true);
    assert.equal(rendered.body_text.includes(payload), true); // text stays literal
    assert.equal(rendered.subject.includes(payload), true);

    // The escaped output hashes differently from the raw one: proof that the
    // escaping actually ran (not just that a filter exists).
    const rawHash = createHash('sha256')
      .update(`Hi ${payload}\nHi ${payload}\n<p>Hi ${payload}</p>`, 'utf8')
      .digest('hex');
    assert.notEqual(rendered.rendered_hash, rawHash);

    // Five consecutive renders are byte-identical (A10, same test surface).
    const hashes = new Set();
    for (let index = 0; index < 5; index += 1) {
      const again = (
        await asRole('authenticated', A, (c) =>
          c.query(
            "select public.admin_render_notification('probe.escape','ar',$1::jsonb,'preview') as out",
            [JSON.stringify({ user_name: payload })],
          ),
        )
      ).rows[0].out;
      hashes.add(`${again.rendered_hash}|${again.body_html}`);
    }
    assert.equal(hashes.size, 1, 'render must be stable byte-for-byte');

    // Clean up the probe draft (drafts are deletable, published versions are not).
    await asRole('authenticated', A, (c) =>
      c.query('select public.admin_delete_notification_template_draft($1)', [draft.id]),
    );
  });

  await test('A11/A12: published versions are immutable and singular', async () => {
    // Direct UPDATE on an active row is refused even for the table owner path
    // that service_role would use.
    await assert.rejects(
      () =>
        db.query(
          "update public.notification_templates set subject = 'rewritten' where key = 'backup.failure_notice' and locale = 'ar' and status = 'active'",
        ),
      (error) => {
        assert.equal(error.code, '22023');
        assert.equal(error.detail, 'field: status');
        return true;
      },
    );

    // DELETE of a published version is refused; only drafts may be removed.
    await assert.rejects(
      () =>
        db.query(
          "delete from public.notification_templates where key = 'backup.failure_notice' and locale = 'ar' and status = 'active'",
        ),
      (error) => {
        assert.equal(error.code, '22023');
        assert.equal(error.detail, 'field: status');
        return true;
      },
    );

    // A second active+current row for the same (key, locale) cannot exist.
    await expectCode('23505', () =>
      db.query(
        `insert into public.notification_templates
           (key, channel, locale, version, status, is_current, subject, body_text, content_hash)
         values ('backup.failure_notice','email','ar',99,'active',true,'x','y',repeat('a',64))`,
      ),
    );

    // Two open drafts for one (key, locale) are impossible as well.
    const variables = JSON.stringify([
      { name: 'user_name', type: 'text', required: true, max_length: 120 },
    ]);
    const first = (
      await asRole('authenticated', A, (c) =>
        c.query(
          `select public.admin_upsert_notification_template_draft(
             p_key := 'auth.welcome_invitation', p_locale := 'ar', p_subject := 'draft one',
             p_body_text := 'Hello {{user_name}}', p_variables := $1::jsonb,
             p_sample_variables := '{"user_name":"Lina"}'::jsonb
           ) as out`,
          [variables],
        ),
      )
    ).rows[0].out;
    await expectCode('23505', () =>
      db.query(
        `insert into public.notification_templates
           (key, channel, locale, version, status, is_current, subject, body_text, content_hash)
         values ('auth.welcome_invitation','email','ar',98,'draft',false,'x','y',repeat('b',64))`,
      ),
    );

    // A can edit that draft but never the published version next to it.
    await asRole('authenticated', A, (c) =>
      c.query(
        `select public.admin_upsert_notification_template_draft(
           p_key := 'auth.welcome_invitation', p_locale := 'ar', p_subject := 'draft two',
           p_body_text := 'Hello {{user_name}} again', p_variables := $1::jsonb,
           p_sample_variables := '{"user_name":"Lina"}'::jsonb,
           p_expected_hash := $2
         )`,
        [variables, first.content_hash],
      ),
    );

    // Stale expected_hash is refused without writing.
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query(
            `select public.admin_upsert_notification_template_draft(
               p_key := 'auth.welcome_invitation', p_locale := 'ar', p_subject := 'draft three',
               p_body_text := 'Hello {{user_name}}', p_variables := $1::jsonb,
               p_sample_variables := '{"user_name":"Lina"}'::jsonb,
               p_expected_hash := $2
             )`,
            [variables, 'f'.repeat(64)],
          ),
        ),
      (error) => {
        assert.equal(error.code, '22023');
        assert.equal(error.detail, 'field: expected_hash');
        return true;
      },
    );

    // Publish the draft, then roll back to version 1: exactly one current row.
    const published = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_publish_notification_template($1,$2,$3) as out', [
          'auth.welcome_invitation',
          'ar',
          publishedVersion(first),
        ]),
      )
    ).rows[0].out;
    assert.equal(published.status, 'active');
    assert.equal(published.is_current, true);
    assert.equal(published.previous_version, 1);

    const rolledBack = (
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_rollback_notification_template($1,$2,1) as out', [
          'auth.welcome_invitation',
          'ar',
        ]),
      )
    ).rows[0].out;
    assert.equal(rolledBack.version, 1);
    assert.equal(rolledBack.is_current, true);

    const current = (
      await db.query(
        "select count(*)::int as n from public.notification_templates where key='auth.welcome_invitation' and locale='ar' and is_current",
      )
    ).rows[0].n;
    assert.equal(current, 1);

    // Audit trail: publish and rollback are both recorded, value-free.
    const audit = (
      await db.query(
        `select metadata from public.audit_logs
          where action = 'notification.template_updated' and entity = 'notification_templates'
          order by id desc limit 3`,
      )
    ).rows.map((row) => row.metadata.transition);
    assert.ok(audit.includes('publish'));
    assert.ok(audit.includes('rollback'));

    // Leave the fixture as the seeds defined it.
    await asRole('authenticated', A, (c) =>
      c.query(
        `select public.admin_upsert_notification_template_draft(
           p_key := 'auth.welcome_invitation', p_locale := 'ar', p_subject := 'probe',
           p_body_text := 'probe {{user_name}}', p_variables := $1::jsonb,
           p_sample_variables := '{"user_name":"Lina"}'::jsonb
         )`,
        [variables],
      ),
    );
    const probeDraft = (
      await db.query(
        "select id from public.notification_templates where key='auth.welcome_invitation' and locale='ar' and status='draft'",
      )
    ).rows[0];
    if (probeDraft) {
      await asRole('authenticated', A, (c) =>
        c.query('select public.admin_delete_notification_template_draft($1)', [probeDraft.id]),
      );
    }
  });

  await test('render is capability-split: delivery belongs to the worker only', async () => {
    // A browser session may preview …
    const preview = (
      await asRole('authenticated', E, (c) =>
        c.query(
          "select public.admin_preview_notification_template('auth.welcome_invitation','en') as out",
        ),
      )
    ).rows[0].out;
    assert.equal(preview.mode, 'preview');
    assert.ok(preview.rendered_hash);

    // … but never render for a real recipient.
    await expectCode('42501', () =>
      asRole('authenticated', E, (c) =>
        c.query(
          "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'delivery')",
          [
            JSON.stringify({
              user_name: 'Lina',
              app_name: 'App',
              action_url: 'https://app.example.invalid/x',
              expires_at: '2026-10-09T12:00:00Z',
              support_email: 'support@example.invalid',
            }),
          ],
        ),
      ),
    );

    // The worker renders, and the previewed hash equals the delivered hash for
    // the same inputs (the "preview === delivery" contract, §2.1.2/A10).
    const inputs = JSON.stringify({
      user_name: 'Lina',
      app_name: 'App',
      action_url: 'https://app.example.invalid/x',
      expires_at: '2026-10-09T12:00:00Z',
      support_email: 'support@example.invalid',
    });
    const delivered = (
      await asRole('service_role', null, (c) =>
        c.query(
          "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'delivery') as out",
          [inputs],
        ),
      )
    ).rows[0].out;
    const previewedSame = (
      await asRole('authenticated', A, (c) =>
        c.query(
          "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'preview') as out",
          [inputs],
        ),
      )
    ).rows[0].out;
    assert.equal(delivered.rendered_hash, previewedSame.rendered_hash);
    assert.equal(delivered.template_content_hash, previewedSame.template_content_hash);

    // Missing/unknown/invalid variables keep their own codes.
    await assert.rejects(
      () =>
        asRole('service_role', null, (c) =>
          c.query(
            "select public.admin_render_notification('auth.welcome_invitation','en','{}'::jsonb,'delivery')",
          ),
        ),
      (error) => {
        assert.equal(error.code, 'TPL01');
        return true;
      },
    );
    // A wrong-typed value is TPL02 with the variable name only.
    await assert.rejects(
      () =>
        asRole('service_role', null, (c) =>
          c.query(
            "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'delivery')",
            [
              JSON.stringify({
                user_name: 'Lina',
                app_name: 'App',
                action_url: 'https://app.example.invalid/x',
                expires_at: 'not-a-date',
                support_email: 'support@example.invalid',
              }),
            ],
          ),
        ),
      (error) => {
        assert.equal(error.code, 'TPL02');
        // names are text-joined for typed failures, jsonb for token failures —
        // either way only NAMES travel, never values.
        assert.equal(error.detail.includes('expires_at'), true, error.detail);
        assert.equal(error.detail.includes('not-a-date'), false);
        return true;
      },
    );

    // Over-long text and brace injection inside a value are TPL02 as well.
    for (const badValue of ['L'.repeat(500), 'value {{injected}}']) {
      await assert.rejects(
        () =>
          asRole('service_role', null, (c) =>
            c.query(
              "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'delivery')",
              [
                JSON.stringify({
                  user_name: badValue,
                  app_name: 'App',
                  action_url: 'https://app.example.invalid/x',
                  expires_at: '2026-10-09T12:00:00Z',
                  support_email: 'support@example.invalid',
                }),
              ],
            ),
          ),
        (error) => {
          assert.equal(error.code, 'TPL02');
          assert.equal(error.detail.includes('user_name'), true);
          return true;
        },
      );
    }

    // Unknown variable names are refused rather than ignored.
    await assert.rejects(
      () =>
        asRole('service_role', null, (c) =>
          c.query(
            "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'delivery')",
            [
              JSON.stringify({
                user_name: 'Lina',
                app_name: 'App',
                action_url: 'https://app.example.invalid/x',
                expires_at: '2026-10-09T12:00:00Z',
                support_email: 'support@example.invalid',
                extra_field: 'nope',
              }),
            ],
          ),
        ),
      (error) => {
        assert.equal(error.code, 'TPL01');
        assert.equal(error.detail.includes('extra_field'), true);
        return true;
      },
    );
    await assert.rejects(
      () =>
        asRole('authenticated', A, (c) =>
          c.query(
            "select public.admin_render_notification('auth.welcome_invitation','en',$1::jsonb,'preview')",
            [
              JSON.stringify({
                user_name: 'Lina',
                app_name: 'App',
                action_url: 'http://insecure.example.invalid/x',
                expires_at: '2026-10-09T12:00:00Z',
                support_email: 'support@example.invalid',
              }),
            ],
          ),
        ),
      (error) => {
        assert.equal(error.code, 'TPL02');
        assert.equal(error.detail, 'names: action_url');
        return true;
      },
    );

    // Locale fallback: a locale with no template falls back to the default and
    // says so explicitly.
    await db.query(
      "update public.app_settings set value = '\"ar\"'::jsonb where key = 'appearance.default_locale'",
    );
    await db.query(
      "insert into public.notification_templates (key, channel, locale, version, status, is_current, subject, body_text, content_hash) values ('probe.fallback','email','ar',1,'active',true,'s','b',repeat('c',64)) on conflict do nothing",
    );
    const fallback = (
      await asRole('service_role', null, (c) =>
        c.query(
          "select public.admin_render_notification('probe.fallback','en','{}'::jsonb,'delivery') as out",
        ),
      )
    ).rows[0].out;
    assert.equal(fallback.resolved_locale, 'ar');
    assert.equal(fallback.fallback_used, true);
  });

  await test('isolated QA account SQL generates one-time random passwords without storing plaintext', async () => {
    const qaSql = await readFile(`${ROOT}scripts/sql/test-account-bootstrap.sql`, 'utf8');
    const start = qaSql.indexOf('with candidates as materialized (');
    const end = qaSql.indexOf('-- تحقق: ثلاثة حسابات', start);
    const guardStart = qaSql.indexOf('do $qa_first_signup_guard$');
    const guardEndMarker = '\n$qa_first_signup_guard$;';
    const guardEnd = qaSql.indexOf(guardEndMarker, guardStart);
    assert.ok(start >= 0 && end > start, 'QA SQL must expose its account-creation query');
    assert.ok(guardStart >= 0 && guardStart < start, 'QA SQL must guard the first-admin claim');
    assert.ok(guardEnd > guardStart, 'QA SQL first-signup guard must be a complete DO block');
    const preflightSql = qaSql.slice(guardStart, guardEnd + guardEndMarker.length).trim();
    const createAccountsSql = qaSql.slice(start, end).trim();

    await db.query('begin');
    await db.query('update public.first_admin_bootstrap_state set claimed=false where singleton');
    await assert.rejects(
      db.query(preflightSql),
      /Register the intended project owner as the first Auth user before creating QA accounts\./,
    );
    await db.query('rollback');

    await db.query('begin');
    try {
      const firstQaUserId = randomUUID();
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        firstQaUserId,
        `qa.first-${randomUUID()}@example.invalid`,
      ]);
      /* Seed a "consumed claim" directly at the marker. The Auth triggers
         intentionally refuse to promote any signup once the claim is closed or
         Auth users already exist (fail-closed first-signup hardening), so this
         scenario guards the QA preflight SQL contract, not the signup triggers
         (those are covered by the first-signup test). */
      await db.query(
        'update public.first_admin_bootstrap_state set claimed=true, first_user_id=$1, claimed_at=clock_timestamp() where singleton',
        [firstQaUserId],
      );
      await assert.rejects(
        db.query(preflightSql),
        /A QA account consumed the first owner signup\. Do not try to promote it to admin/,
      );
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }

    await db.query('begin');
    try {
      const created = await db.query(createAccountsSql);
      assert.equal(created.rowCount, 3);
      const passwords = created.rows.map((row) => row.generated_password);
      assert.equal(new Set(passwords).size, 3);
      for (const password of passwords) {
        assert.match(password, /^[a-f0-9]{64}$/);
      }

      const stored = await db.query(
        'select email, encrypted_password from auth.users where email = any($1::text[])',
        [created.rows.map((row) => row.email)],
      );
      assert.equal(stored.rowCount, 3);
      for (const row of stored.rows) {
        assert.match(row.encrypted_password, /^\$2/);
        assert.equal(
          passwords.some((password) => row.encrypted_password.includes(password)),
          false,
        );
      }
      assert.equal((await db.query(createAccountsSql)).rowCount, 0);
      await db.query('rollback');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  await test('in-app notifications are owner-scoped, RPC-only, and never fail the cause', async () => {
    // ---- Schema and lockdown ------------------------------------------------
    const tableState = (
      await db.query(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'user_notifications'`,
      )
    ).rows[0];
    assert.equal(tableState.relrowsecurity, true, 'RLS must be enabled');
    assert.equal(tableState.relforcerowsecurity, true, 'RLS must be FORCED');
    for (const column of ['related_id', 'resolved_at']) {
      assert.equal(
        (
          await db.query(
            `select count(*)::int as n from information_schema.columns
              where table_schema = 'public' and table_name = 'user_notifications' and column_name = $1`,
            [column],
          )
        ).rows[0].n,
        1,
        `user_notifications must include ${column}`,
      );
    }
    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        (
          await db.query(
            "select has_function_privilege($1, 'public.resolve_related_notifications(uuid,text)', 'execute') as allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
        `${role} must not resolve other users' notifications`,
      );
    }
    assert.equal(
      (
        await db.query(
          "select has_function_privilege('service_role', 'public.resolve_related_notifications(uuid,text)', 'execute') as allowed",
        )
      ).rows[0].allowed,
      true,
      'service_role must resolve related notifications',
    );

    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal(
          (
            await db.query('select has_table_privilege($1, $2, $3) as allowed', [
              role,
              'public.user_notifications',
              privilege,
            ])
          ).rows[0].allowed,
          false,
          `${role} must not have ${privilege} on user_notifications`,
        );
      }
    }
    // Reading is granted; RLS narrows it to the caller's own rows.
    assert.equal(
      (
        await db.query('select has_table_privilege($1, $2, $3) as allowed', [
          'authenticated',
          'public.user_notifications',
          'SELECT',
        ])
      ).rows[0].allowed,
      true,
    );
    assert.equal(
      (
        await db.query('select has_table_privilege($1, $2, $3) as allowed', [
          'anon',
          'public.user_notifications',
          'SELECT',
        ])
      ).rows[0].allowed,
      false,
      'anon must not read the feed at all',
    );

    // The browser may never insert a feed row directly.
    const applicant = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      applicant,
      `notify.${applicant}@example.invalid`,
    ]);
    await expectDenied(() =>
      asRole('authenticated', applicant, (c) =>
        c.query(
          `insert into public.user_notifications (user_id, type, title_key, body_key, dedupe_key)
           values ($1, 'user_approved', 'notifications.type.user_approved.title',
                   'notifications.type.user_approved.body', 'tamper')`,
          [applicant],
        ),
      ),
    );

    // ---- (a) A pending signup fans out to the owners only ------------------
    const queued = (
      await db.query(
        `select n.user_id, n.type, n.title_key, n.body_key, n.params, n.link, n.dedupe_key,
                n.related_id, n.resolved_at, n.is_read, n.read_at,
                public.user_has_permission(n.user_id, 'users.approve') as is_owner
           from public.user_notifications n
          where n.type = 'user_approval_requested' and n.dedupe_key = $1`,
        [`user_approval_requested:${applicant}`],
      )
    ).rows;
    assert.ok(queued.length >= 1, 'owners must be notified of a pending signup');
    for (const row of queued) {
      assert.equal(
        row.is_owner,
        true,
        'only users.approve holders may receive an approval queue event',
      );
      assert.equal(row.link, '/settings/system/users');
      assert.equal(row.title_key, 'notifications.type.user_approval_requested.title');
      assert.equal(row.body_key, 'notifications.type.user_approval_requested.body');
      assert.equal(row.related_id, applicant);
      assert.equal(row.resolved_at, null);
      assert.equal(row.is_read, false);
      // Stored as i18n KEYS, never as rendered prose.
      assert.match(row.title_key, /^notifications\.type\.[a-z_]+\.(title|body)$/);
      // The subject address is masked, matching the audit-log masking contract.
      const masked = row.params.subject_email;
      assert.equal(typeof masked, 'string');
      assert.ok(masked.includes('***'), `subject_email must be masked, got ${masked}`);
      assert.equal(
        masked.includes(applicant.toLowerCase()),
        false,
        'the raw address must not appear in params',
      );
    }

    // ---- Idempotency: a replayed fan-out cannot duplicate ------------------
    const before = (await db.query('select count(*)::int as n from public.user_notifications'))
      .rows[0].n;
    await db.query(
      `select public.enqueue_user_notification('user_approval_requested', $1, $2, '/settings/system/users')`,
      [applicant, `user_approval_requested:${applicant}`],
    );
    assert.equal(
      (await db.query('select count(*)::int as n from public.user_notifications')).rows[0].n,
      before,
      'dedupe_key must make the fan-out idempotent',
    );

    // ---- (c) The decision reaches the applicant, and only the applicant ----
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_approve_user($1, 'approve', $2)", [applicant, B]),
    );
    const decision = (
      await db.query(
        `select user_id, type, link from public.user_notifications
          where dedupe_key = $1`,
        [`user_approved:${applicant}`],
      )
    ).rows;
    assert.equal(decision.length, 1, 'exactly one decision notification');
    assert.equal(decision[0].user_id, applicant);
    assert.equal(decision[0].link, '/profile');

    const resolvedApproval = (
      await db.query(
        `select is_read, read_at, resolved_at
           from public.user_notifications
          where related_id = $1 and type = 'user_approval_requested'`,
        [applicant],
      )
    ).rows;
    assert.ok(resolvedApproval.length >= 1, 'approval must have generated an owner notification');
    for (const row of resolvedApproval) {
      assert.equal(row.is_read, true, 'resolved approval notifications must be read');
      assert.ok(row.read_at instanceof Date, 'resolved approval notifications must have read_at');
      assert.ok(
        row.resolved_at instanceof Date,
        'approval decision must resolve the original notification',
      );
    }

    // A manual password reset decision resolves each owner copy by request id.
    const resetRequest = (
      await db.query(
        `insert into public.password_reset_requests (email)
         values ($1) returning id`,
        [`notify.${applicant}@example.invalid`],
      )
    ).rows[0];
    const queuedReset = (
      await db.query(
        `select user_id, related_id, is_read, resolved_at
           from public.user_notifications
          where type = 'password_reset_requested' and related_id = $1`,
        [resetRequest.id],
      )
    ).rows;
    assert.ok(queuedReset.length >= 1, 'password reset request must notify owners');
    for (const row of queuedReset) {
      assert.equal(row.is_read, false);
      assert.equal(row.resolved_at, null);
    }
    await asRole('service_role', B, (c) =>
      c.query("select public.admin_finalize_password_reset_request($1, 'reject', $2)", [
        resetRequest.id,
        B,
      ]),
    );
    const resolvedReset = (
      await db.query(
        `select is_read, read_at, resolved_at
           from public.user_notifications
          where type = 'password_reset_requested' and related_id = $1`,
        [resetRequest.id],
      )
    ).rows;
    assert.equal(resolvedReset.length, queuedReset.length);
    for (const row of resolvedReset) {
      assert.equal(row.is_read, true, 'resolved reset notifications must be read');
      assert.ok(row.read_at instanceof Date, 'resolved reset notifications must have read_at');
      assert.ok(
        row.resolved_at instanceof Date,
        'password-reset decision must resolve its notification',
      );
    }

    // ---- RLS isolation: a caller sees their own rows and nothing else ------
    const totalRows = (await db.query('select count(*)::int as n from public.user_notifications'))
      .rows[0].n;
    assert.ok(totalRows > 1, 'fixture must hold more than the applicant row');
    const visible = await asRole(
      'authenticated',
      applicant,
      async (c) =>
        (
          await c.query(
            'select count(*)::int as n, count(*) filter (where user_id <> $1)::int as foreign_rows from public.user_notifications',
            [applicant],
          )
        ).rows[0],
    );
    assert.equal(visible.foreign_rows, 0, 'no foreign row may be visible');
    assert.ok(visible.n < totalRows, 'the feed must be narrowed by RLS');

    // ---- Ownership on the mark-read RPC ------------------------------------
    const foreignRow = (
      await db.query(
        'select id from public.user_notifications where user_id <> $1 and is_read = false limit 1',
        [applicant],
      )
    ).rows[0];
    assert.ok(foreignRow, 'fixture must hold an unread row belonging to someone else');
    const crossUser = await asRole(
      'authenticated',
      applicant,
      async (c) =>
        (await c.query('select public.mark_notification_read($1) as changed', [foreignRow.id]))
          .rows[0].changed,
    );
    assert.equal(crossUser, false, "marking another user's row must be a silent no-op");
    assert.equal(
      (
        await db.query('select is_read from public.user_notifications where id = $1', [
          foreignRow.id,
        ])
      ).rows[0].is_read,
      false,
      "another user's row must stay unread",
    );

    const ownRow = (
      await db.query(
        'select id from public.user_notifications where user_id = $1 and is_read = false limit 1',
        [applicant],
      )
    ).rows[0];
    const ownChanged = await asRole(
      'authenticated',
      applicant,
      async (c) =>
        (await c.query('select public.mark_notification_read($1) as changed', [ownRow.id])).rows[0]
          .changed,
    );
    assert.equal(ownChanged, true);
    const marked = (
      await db.query('select is_read, read_at from public.user_notifications where id = $1', [
        ownRow.id,
      ])
    ).rows[0];
    assert.equal(marked.is_read, true);
    assert.ok(marked.read_at instanceof Date, 'read_at must be stamped');

    const markedAll = await asRole(
      'authenticated',
      applicant,
      async (c) =>
        (await c.query('select public.mark_all_notifications_read() as changed')).rows[0].changed,
    );
    assert.equal(typeof markedAll, 'number');
    assert.equal(
      (
        await db.query(
          'select count(*)::int as n from public.user_notifications where user_id = $1 and is_read = false',
          [applicant],
        )
      ).rows[0].n,
      0,
      'mark-all must clear the caller feed',
    );

    // Anonymous callers get neither the feed nor the RPCs.
    await expectCode('42501', () =>
      asRole('anon', null, (c) => c.query('select public.mark_all_notifications_read()')),
    );

    // ---- THE key contract: a broken feed never fails the cause -------------
    const helperDdl = (
      await db.query(
        `select pg_get_functiondef(p.oid) as ddl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'enqueue_user_notification'
            and p.pronargs = 4`,
      )
    ).rows[0].ddl;
    try {
      await db.query(
        `create or replace function public.enqueue_user_notification(
           p_type text, p_subject_id uuid, p_dedupe_key text, p_link text
         ) returns integer language plpgsql security definer
         set search_path = pg_catalog, public as $sabotage$
         begin
           raise exception 'simulated notification subsystem failure';
         end;
         $sabotage$;`,
      );

      // (a) signup still provisions the profile
      const doomed = randomUUID();
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        doomed,
        `doomed.${doomed}@example.invalid`,
      ]);
      assert.equal(
        (await db.query('select approval_status from public.profiles where id = $1', [doomed]))
          .rows[0].approval_status,
        'pending',
        'signup must survive a notification failure',
      );

      // (b) a password reset request still reaches the queue
      await db.query('insert into public.password_reset_requests (email) values ($1)', [
        `doomed.${doomed}@example.invalid`,
      ]);
      assert.equal(
        (
          await db.query('select status from public.password_reset_requests where email = $1', [
            `doomed.${doomed}@example.invalid`,
          ])
        ).rows[0].status,
        'pending_approval',
        'the reset queue must survive a notification failure',
      );

      // (c) an approval decision still commits
      await asRole('service_role', B, (c) =>
        c.query("select public.admin_approve_user($1, 'approve', $2)", [doomed, B]),
      );
      assert.equal(
        (await db.query('select approval_status from public.profiles where id = $1', [doomed]))
          .rows[0].approval_status,
        'approved',
        'an approval must never be rolled back by a notification failure',
      );

      await db.query('delete from auth.users where id = $1', [doomed]);
    } finally {
      await db.query(helperDdl);
    }
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'enqueue_user_notification'`,
        )
      ).rows[0].n,
      2,
      'both stable and related-id fan-out helper overloads must be present',
    );

    // ---- Retention and realtime wiring -------------------------------------
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n from cron.job
            where jobname = 'prune-expired-user-notifications-daily-0315'
              and command like '%prune_expired_user_notifications%'`,
        )
      ).rows[0].n,
      1,
      'the 90-day prune must be scheduled',
    );
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public'
              and tablename = 'user_notifications'`,
        )
      ).rows[0].n,
      1,
      'the feed must be published for invalidation signals',
    );
    // REPLICA IDENTITY FULL: the client subscription is filtered by user_id,
    // and under the default identity a DELETE's WAL old record carries only
    // the PK, so Realtime cannot match the filter and silently drops the
    // event (live deletes would linger in an open panel — see migration
    // 20261028000000 and the Playwright delete scenario).
    assert.equal(
      (
        await db.query(
          "select relreplident from pg_class where oid = 'public.user_notifications'::regclass",
        )
      ).rows[0].relreplident,
      'f',
      'filtered DELETE delivery requires REPLICA IDENTITY FULL on user_notifications',
    );
    // A stale row is pruned; a fresh one survives.
    const staleId = randomUUID();
    await db.query(
      `insert into public.user_notifications (id, user_id, type, title_key, body_key, dedupe_key, created_at)
       values ($1, $2, 'user_approved', 'notifications.type.user_approved.title',
               'notifications.type.user_approved.body', $3, now() - interval '91 days')`,
      [staleId, applicant, `stale:${staleId}`],
    );
    const pruned = (await db.query('select public.prune_expired_user_notifications() as n')).rows[0]
      .n;
    assert.ok(pruned >= 1, 'the prune must delete the 91-day-old row');
    assert.equal(
      (
        await db.query('select count(*)::int as n from public.user_notifications where id = $1', [
          staleId,
        ])
      ).rows[0].n,
      0,
    );

    // ---- The external URL guard --------------------------------------------
    await assert.rejects(
      () =>
        db.query(
          `insert into public.user_notifications (user_id, type, title_key, body_key, link, dedupe_key)
           values ($1, 'user_approved', 'notifications.type.user_approved.title',
                   'notifications.type.user_approved.body', 'https://evil.example.invalid', $2)`,
          [applicant, `external:${randomUUID()}`],
        ),
      (error) => error.code === '23514',
      'an absolute URL must be refused by the CHECK constraint',
    );

    await db.query('delete from auth.users where id = $1', [applicant]);
  });

  await test('resolve_related_notifications returns the exact count and stamps resolved_at', async () => {
    const applicant = randomUUID();
    const email = `direct-resolve.${applicant}@example.invalid`;

    try {
      await db.query('insert into auth.users(id,email) values ($1,$2)', [applicant, email]);

      // The pending signup fanned out to the owners; count the unresolved copies.
      const pending = (
        await db.query(
          `select count(*)::int as n
             from public.user_notifications
            where type = 'user_approval_requested' and related_id = $1 and resolved_at is null`,
          [applicant],
        )
      ).rows[0].n;
      assert.ok(pending >= 1, 'pending signup must queue unresolved owner notifications');

      // The resolver must REPORT exactly the rows it resolved — the client badge
      // predicate (unread + unresolved) converges only if both agree.
      const resolved = (
        await db.query('select public.resolve_related_notifications($1, $2) as n', [
          applicant,
          'user_approval_requested',
        ])
      ).rows[0].n;
      assert.equal(
        resolved,
        pending,
        'resolve_related_notifications must return the resolved row count',
      );

      const rows = (
        await db.query(
          `select is_read, read_at, resolved_at
             from public.user_notifications
            where type = 'user_approval_requested' and related_id = $1
            order by id`,
          [applicant],
        )
      ).rows;
      assert.equal(rows.length, pending);
      for (const row of rows) {
        assert.ok(
          row.resolved_at instanceof Date,
          'resolve_related_notifications must stamp resolved_at',
        );
        assert.equal(row.is_read, true, 'resolved rows must leave the unread bucket');
        assert.ok(row.read_at instanceof Date, 'resolved rows must carry read_at');
      }

      // The client's active-feed predicate sees nothing left for this subject.
      assert.equal(
        (
          await db.query(
            `select count(*)::int as n
               from public.user_notifications
              where type = 'user_approval_requested' and related_id = $1
                and is_read = false and resolved_at is null`,
            [applicant],
          )
        ).rows[0].n,
        0,
        'no resolved row may remain in the active feed',
      );

      // A second pass counts every matching row again, but the first stamp wins
      // (coalesce): re-resolution must never move resolved_at forward.
      const stampsBefore = rows.map((row) => row.resolved_at.getTime());
      const resolvedAgain = (
        await db.query('select public.resolve_related_notifications($1, $2) as n', [
          applicant,
          'user_approval_requested',
        ])
      ).rows[0].n;
      assert.equal(
        resolvedAgain,
        pending,
        're-resolution must still return the matching row count',
      );
      const stampsAfter = (
        await db.query(
          `select resolved_at
             from public.user_notifications
            where type = 'user_approval_requested' and related_id = $1
            order by id`,
          [applicant],
        )
      ).rows.map((row) => row.resolved_at.getTime());
      assert.deepEqual(stampsAfter, stampsBefore, 'the first resolution stamp must win');

      // The allow-list is closed: only queue types may be resolved.
      await expectCode('22023', () =>
        db.query('select public.resolve_related_notifications($1, $2)', [
          applicant,
          'user_approved',
        ]),
      );
    } finally {
      await db.query('delete from public.user_notifications where related_id = $1', [applicant]);
      await db.query('delete from auth.users where id = $1', [applicant]);
    }
  });

  await test('a direct profile approval update resolves its pending owner notification', async () => {
    const applicant = randomUUID();
    const email = `direct-approval.${applicant}@example.invalid`;

    try {
      await db.query('insert into auth.users(id,email) values ($1,$2)', [applicant, email]);
      const queued = (
        await db.query(
          `select id, is_read, resolved_at
             from public.user_notifications
            where type = 'user_approval_requested'
              and related_id = $1`,
          [applicant],
        )
      ).rows;
      assert.ok(queued.length > 0, 'pending signup must create an owner approval notification');
      assert.ok(queued.every((row) => !row.is_read && row.resolved_at === null));

      // Intentionally bypass admin_approve_user: this is the transition the
      // profile trigger must cover on its own.
      await db.query("update public.profiles set approval_status = 'approved' where id = $1", [
        applicant,
      ]);

      const resolved = (
        await db.query(
          `select is_read, read_at, resolved_at
             from public.user_notifications
            where type = 'user_approval_requested'
              and related_id = $1`,
          [applicant],
        )
      ).rows;
      assert.equal(resolved.length, queued.length);
      for (const row of resolved) {
        assert.equal(row.is_read, true, 'profile trigger must clear the stale unread state');
        assert.ok(row.read_at instanceof Date, 'profile trigger must stamp read_at');
        assert.ok(row.resolved_at instanceof Date, 'profile trigger must stamp resolved_at');
      }
    } finally {
      await db.query('delete from public.user_notifications where related_id = $1', [applicant]);
      await db.query('delete from auth.users where id = $1', [applicant]);
    }
  });

  await test('profile updates survive a failure in approval notification resolution', async () => {
    const applicant = randomUUID();
    const email = `notification-failure.${applicant}@example.invalid`;
    const resolverDdl = (
      await db.query(
        `select pg_get_functiondef('public.resolve_related_notifications(uuid,text)'::regprocedure) as ddl`,
      )
    ).rows[0].ddl;

    try {
      await db.query('insert into auth.users(id,email) values ($1,$2)', [applicant, email]);
      await db.query(
        `create or replace function public.resolve_related_notifications(
           p_related_id uuid, p_type text
         ) returns integer language plpgsql security definer
         set search_path = pg_catalog, public as $sabotage$
         begin
           raise exception 'simulated resolver failure';
         end;
         $sabotage$;`,
      );

      await db.query("update public.profiles set approval_status = 'rejected' where id = $1", [
        applicant,
      ]);
      assert.equal(
        (await db.query('select approval_status from public.profiles where id = $1', [applicant]))
          .rows[0].approval_status,
        'rejected',
        'notification resolver errors must not roll back the source status change',
      );
    } finally {
      await db.query(resolverDdl);
      await db.query('delete from public.user_notifications where related_id = $1', [applicant]);
      await db.query('delete from auth.users where id = $1', [applicant]);
    }
  });

  await test('admin invite is owner/super_admin-only, grants exactly one allow-listed role, and activates the account', async () => {
    // EXECUTE is service_role-only, so the browser path is closed outright.
    for (const fn of [
      'public.admin_invite_user(uuid,text,uuid)',
      'public.admin_verify_password_reset_authority(uuid,uuid)',
      'public.admin_record_password_reset(uuid,uuid)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(
          (
            await db.query('select has_function_privilege($1, $2, $3) as allowed', [
              role,
              fn,
              'execute',
            ])
          ).rows[0].allowed,
          false,
          `${role} must not execute ${fn}`,
        );
      }
      assert.equal(
        (
          await db.query('select has_function_privilege($1, $2, $3) as allowed', [
            'service_role',
            fn,
            'execute',
          ])
        ).rows[0].allowed,
        true,
        `service_role must execute ${fn}`,
      );
    }

    const applicant = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      applicant,
      `invite.${applicant}@example.invalid`,
    ]);
    // Since 20261017000000 a non-first signup is created PENDING and with NO
    // role at all — the invitation is what grants the first one.
    const seeded = (
      await db.query(
        `select p.approval_status,
                coalesce(array_agg(r.slug order by r.slug) filter (where r.id is not null), '{}') as slugs
           from public.profiles p
           left join public.user_roles ur on ur.user_id = p.id
           left join public.roles r on r.id = ur.role_id
          where p.id = $1
          group by p.id`,
        [applicant],
      )
    ).rows;
    assert.equal(seeded[0].approval_status, 'pending');
    assert.deepEqual(seeded[0].slugs, [], 'a fresh signup must hold no role before it is invited');

    // A viewer cannot invite…
    await expectCode('42501', () =>
      asRole('service_role', V, (c) =>
        c.query('select public.admin_invite_user($1, $2, $3)', [applicant, 'editor', V]),
      ),
    );
    // …and neither can a role that merely holds `*`. The RPC requires the
    // owner/super_admin SLUG (decision D2), not the wildcard capability.
    await expectCode('42501', () =>
      asRole('service_role', C, (c) =>
        c.query('select public.admin_invite_user($1, $2, $3)', [applicant, 'editor', C]),
      ),
    );
    // Protected and unknown roles are refused before anything is written.
    for (const refused of ['owner', 'super_admin', 'no_such_role', '']) {
      await expectCode('22023', () =>
        asRole('service_role', B, (c) =>
          c.query('select public.admin_invite_user($1, $2, $3)', [applicant, refused, B]),
        ),
      );
    }
    assert.equal(
      (await db.query('select approval_status from public.profiles where id=$1', [applicant]))
        .rows[0].approval_status,
      'pending',
      'a refused invite must leave the account pending',
    );

    // The invitation grants exactly the chosen role and nothing else.
    const invited = (
      await asRole('service_role', B, (c) =>
        c.query('select public.admin_invite_user($1, $2, $3) as out', [applicant, 'executive', B]),
      )
    ).rows[0].out;
    assert.equal(invited.granted_role, 'executive');

    const after = await db.query(
      `select p.approval_status, p.status,
              coalesce(array_agg(r.slug order by r.slug) filter (where r.id is not null), '{}') as slugs
         from public.profiles p
         left join public.user_roles ur on ur.user_id = p.id
         left join public.roles r on r.id = ur.role_id
        where p.id = $1
        group by p.id`,
      [applicant],
    );
    assert.equal(after.rows[0].approval_status, 'approved');
    assert.equal(after.rows[0].status, 'active');
    assert.deepEqual(after.rows[0].slugs, ['executive']);
    assert.equal(
      (
        await db.query(
          'select email_confirmed_at is not null as confirmed from auth.users where id=$1',
          [applicant],
        )
      ).rows[0].confirmed,
      true,
      'an invited account must be email-confirmed so it can sign in',
    );

    // The grant is attributed to the executor and audited as user.invited.
    const audit = (
      await db.query(
        `select actor_id, action, metadata
           from public.audit_logs
          where entity = 'user' and entity_id = $1
            and metadata->>'event' = 'user.invited'`,
        [applicant],
      )
    ).rows;
    assert.equal(audit.length, 1, 'exactly one user.invited audit row');
    assert.equal(audit[0].actor_id, B);
    assert.equal(audit[0].action, 'user.created');
    assert.equal(audit[0].metadata.granted_role, 'executive');
    assert.equal(audit[0].metadata.executor_role, 'super_admin');

    await db.query('delete from auth.users where id = $1', [applicant]);
  });

  await test('admin password reset is authority-gated, audited without a credential, and never touches the original owner', async () => {
    const target = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      target,
      `reset.${target}@example.invalid`,
    ]);

    // A viewer may neither authorize nor record a reset.
    await expectCode('42501', () =>
      asRole('service_role', V, (c) =>
        c.query('select public.admin_verify_password_reset_authority($1, $2)', [target, V]),
      ),
    );
    // The gate runs BEFORE the GoTrue write, so nothing has been audited yet.
    assert.equal(
      (
        await db.query(
          `select count(*)::int as n from public.audit_logs
            where entity_id = $1 and metadata->>'event' = 'user.password_reset_by_admin'`,
          [target],
        )
      ).rows[0].n,
      0,
    );

    // Pending signups have no session to recover: P0002, not a silent pass.
    await expectCode('P0002', () =>
      asRole('service_role', B, (c) =>
        c.query('select public.admin_verify_password_reset_authority($1, $2)', [target, B]),
      ),
    );

    // Once approved and active the gate passes; recording writes the trail.
    await db.query(
      "update public.profiles set approval_status='approved', status='active' where id=$1",
      [target],
    );
    await asRole('service_role', B, (c) =>
      c.query('select public.admin_verify_password_reset_authority($1, $2)', [target, B]),
    );
    await asRole('service_role', B, (c) =>
      c.query('select public.admin_record_password_reset($1, $2)', [target, B]),
    );

    const logged = (
      await db.query(
        `select actor_id, action, metadata
           from public.audit_logs
          where entity = 'user' and entity_id = $1
            and metadata->>'event' = 'user.password_reset_by_admin'`,
        [target],
      )
    ).rows;
    assert.equal(logged.length, 1, 'exactly one password-reset audit row');
    assert.equal(logged[0].actor_id, B);
    assert.equal(logged[0].action, 'user.updated');
    assert.equal(logged[0].metadata.executor_role, 'super_admin');
    // No credential material of any kind: neither plaintext nor a hash.
    assert.deepEqual(Object.keys(logged[0].metadata).sort(), ['event', 'executor_role']);
    assert.equal(
      JSON.stringify(logged[0].metadata).includes('$2'),
      false,
      'audit metadata must never carry a bcrypt-style hash',
    );

    // ---- Decision D6: the original owner is untouchable by every RPC -------
    // The fixture closes the first-signup claim with first_user_id = NULL, so
    // save/restore around the marker instead of assuming a prior test's state.
    const claim = (
      await db.query('select first_user_id from public.first_admin_bootstrap_state where singleton')
    ).rows[0].first_user_id;
    await db.query(
      'update public.first_admin_bootstrap_state set first_user_id=$1 where singleton',
      [target],
    );
    try {
      assert.equal(
        (await db.query('select public.is_original_owner($1) as owner', [target])).rows[0].owner,
        true,
        'fixture must actually make the target the original owner',
      );
      for (const call of [
        ['select public.admin_invite_user($1, $2, $3)', [target, 'editor', B]],
        ['select public.admin_verify_password_reset_authority($1, $2)', [target, B]],
        ['select public.admin_record_password_reset($1, $2)', [target, B]],
      ]) {
        await expectCode('42501', () =>
          asRole('service_role', B, (c) => c.query(call[0], call[1])),
        );
      }
      // The refusal must not have added a second audit row.
      assert.equal(
        (
          await db.query(
            `select count(*)::int as n from public.audit_logs
              where entity_id = $1 and metadata->>'event' = 'user.password_reset_by_admin'`,
            [target],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await db.query(
        'update public.first_admin_bootstrap_state set first_user_id=$1 where singleton',
        [claim],
      );
    }

    await db.query('delete from auth.users where id = $1', [target]);
  });

  await test('admin_set_user_roles auto-suspends on role removal and reactivates on role re-grant', async () => {
    const lifecycleUser = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [
      lifecycleUser,
      `lifecycle.${lifecycleUser}@example.invalid`,
    ]);
    await db.query("update public.profiles set approval_status='approved' where id=$1", [
      lifecycleUser,
    ]);
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [lifecycleUser],
    );

    try {
      assert.equal(
        (await db.query('select status from public.profiles where id=$1', [lifecycleUser])).rows[0]
          .status,
        'active',
      );

      // Revoking all roles automatically transitions profiles.status -> 'suspended'.
      const stripResult = (
        await asRole('authenticated', C, (c) =>
          c.query('select public.admin_set_user_roles($1,$2) as result', [lifecycleUser, []]),
        )
      ).rows[0].result;
      assert.deepEqual(stripResult.revoked, ['viewer']);
      assert.equal(
        (await db.query('select status from public.profiles where id=$1', [lifecycleUser])).rows[0]
          .status,
        'suspended',
      );
      assert.equal(
        (
          await db.query('select count(*)::int as n from public.user_roles where user_id=$1', [
            lifecycleUser,
          ])
        ).rows[0].n,
        0,
      );

      // Re-granting at least one role restores profiles.status -> 'active'.
      const grantResult = (
        await asRole('authenticated', C, (c) =>
          c.query('select public.admin_set_user_roles($1,$2) as result', [
            lifecycleUser,
            ['editor'],
          ]),
        )
      ).rows[0].result;
      assert.deepEqual(grantResult.granted, ['editor']);
      assert.equal(
        (await db.query('select status from public.profiles where id=$1', [lifecycleUser])).rows[0]
          .status,
        'active',
      );
    } finally {
      await db.query('delete from public.user_notifications where related_id = $1', [
        lifecycleUser,
      ]);
      await db.query('delete from auth.users where id = $1', [lifecycleUser]);
    }
  });

  await test('executive dashboard role_distribution counts active approved users and groups pending as no_role', async () => {
    const execCaller = randomUUID();
    const activeViewer = randomUUID();
    const suspendedViewer = randomUUID();
    const pendingUser = randomUUID();
    const rejectedUser = randomUUID();
    const createdIds = [execCaller, activeViewer, suspendedViewer, pendingUser, rejectedUser];

    for (const uid of createdIds) {
      await db.query('insert into auth.users(id,email) values ($1,$2)', [
        uid,
        `kpi-lifecycle.${uid}@example.invalid`,
      ]);
    }
    await db.query("update public.profiles set approval_status='approved' where id=$1", [
      execCaller,
    ]);
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='executive'",
      [execCaller],
    );

    const beforeSnapshot = (
      await asRole('authenticated', execCaller, (c) =>
        c.query('select public.get_executive_dashboard() as snapshot'),
      )
    ).rows[0].snapshot;
    const beforeViewerCount = beforeSnapshot.role_distribution.items.find(
      (i) => i.slug === 'viewer',
    ).user_count;
    const beforeNoRoleCount = beforeSnapshot.role_distribution.items.find(
      (i) => i.slug === 'no_role',
    ).user_count;

    try {
      // Configure the four distinct lifecycle states:
      //  1) activeViewer    -> status='active',    approval_status='approved' + viewer role (+1 viewer, -1 pending)
      //  2) suspendedViewer -> status='suspended', approval_status='approved' + viewer role (+0 viewer, -1 pending)
      //  3) pendingUser     -> status='active',    approval_status='pending'  (stays in pending / no_role)
      //  4) rejectedUser    -> status='active',    approval_status='rejected' (+0 viewer, -1 pending -> excluded!)
      await db.query("update public.profiles set approval_status='approved' where id=$1", [
        activeViewer,
      ]);
      await db.query(
        "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
        [activeViewer],
      );

      await db.query(
        "update public.profiles set status='suspended', approval_status='approved' where id=$1",
        [suspendedViewer],
      );
      await db.query(
        "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
        [suspendedViewer],
      );

      await db.query("update public.profiles set approval_status='rejected' where id=$1", [
        rejectedUser,
      ]);

      const afterSnapshot = (
        await asRole('authenticated', execCaller, (c) =>
          c.query('select public.get_executive_dashboard() as snapshot'),
        )
      ).rows[0].snapshot;

      const afterViewerCount = afterSnapshot.role_distribution.items.find(
        (i) => i.slug === 'viewer',
      ).user_count;
      const afterNoRoleItem = afterSnapshot.role_distribution.items.find(
        (i) => i.slug === 'no_role',
      );
      const expectedPendingTotal = (
        await db.query(
          "select count(*)::int as n from public.profiles where approval_status='pending'",
        )
      ).rows[0].n;

      // Only activeViewer (+1) is counted in `viewer`; suspendedViewer is excluded!
      assert.equal(afterViewerCount, beforeViewerCount + 1);
      // `no_role` matches exact pending count (activeViewer, suspendedViewer, rejectedUser all dropped out: -3).
      assert.ok(afterNoRoleItem, 'no_role slice must exist in role_distribution.items');
      assert.equal(afterNoRoleItem.user_count, beforeNoRoleCount - 3);
      assert.equal(afterNoRoleItem.user_count, expectedPendingTotal);
      assert.equal(afterSnapshot.role_distribution.users_without_role, expectedPendingTotal);
    } finally {
      await db.query('delete from public.user_notifications where related_id = any($1::uuid[])', [
        createdIds,
      ]);
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdIds]);
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 5 — Delegation Lifecycle Notifications & Self-Service Profile RPCs
  // ---------------------------------------------------------------------------
  await test('delegation lifecycle: grant capability emits delegation_event granted notification', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];
    const granterEmail = `granter-${granter.slice(0, 8)}@example.invalid`;
    const delegateEmail = `delegate-${delegate.slice(0, 8)}@example.invalid`;
    const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      granterEmail,
      delegate,
      delegateEmail,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            expiresAt,
            granter,
          ]),
        )
      ).rows[0].id;

      const rows = (
        await db.query(
          `select type, title_key, body_key, link, related_id, metadata, params, is_read, resolved_at
             from public.user_notifications
            where user_id = $1 and related_id = $2`,
          [delegate, capId],
        )
      ).rows;

      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, 'delegation_event');
      assert.equal(rows[0].link, '/profile#delegations');
      assert.equal(rows[0].metadata.event, 'granted');
      assert.equal(rows[0].metadata.slug, 'users.approve');
      assert.equal(rows[0].metadata.granter_email, granterEmail);
      assert.ok(rows[0].metadata.expires_at, 'metadata.expires_at must be populated');
      assert.equal(rows[0].is_read, false);
      assert.equal(rows[0].resolved_at, null);
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('delegation lifecycle: revoke capability emits delegation_event revoked notification', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      `revoke-g-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      `revoke-d-${delegate.slice(0, 8)}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            null,
            granter,
          ]),
        )
      ).rows[0].id;

      await asRole('service_role', granter, (c) =>
        c.query('select public.admin_revoke_capability($1, $2)', [capId, granter]),
      );

      const revokedRows = (
        await db.query(
          `select type, link, metadata, is_read, resolved_at
             from public.user_notifications
            where user_id = $1
              and related_id = $2
              and metadata ->> 'event' = 'revoked'`,
          [delegate, capId],
        )
      ).rows;

      assert.equal(revokedRows.length, 1);
      assert.equal(revokedRows[0].type, 'delegation_event');
      assert.equal(revokedRows[0].link, '/profile#delegations');
      assert.equal(revokedRows[0].metadata.slug, 'users.approve');
      assert.equal(revokedRows[0].is_read, false);
      assert.equal(revokedRows[0].resolved_at, null);
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('delegation lifecycle: T-7 expiry window creates granter and delegate notifications', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];
    const delegateEmail = `t7-delegate-${delegate.slice(0, 8)}@example.invalid`;
    const fiveDaysOut = new Date(Date.now() + 5 * 86_400_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      `t7-granter-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      delegateEmail,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            fiveDaysOut,
            granter,
          ]),
        )
      ).rows[0].id;

      await db.query('select public.generate_delegation_expiry_notifications()');

      const expiryRows = (
        await db.query(
          `select user_id, type, link, dedupe_key, metadata
             from public.user_notifications
            where related_id = $1
              and metadata ->> 'event' = 'expiring'
            order by link`,
          [capId],
        )
      ).rows;

      assert.equal(expiryRows.length, 2);
      const delegateNotif = expiryRows.find((r) => r.user_id === delegate);
      const granterNotif = expiryRows.find((r) => r.user_id === granter);
      assert.ok(delegateNotif, 'delegate must receive T-7 expiry notification');
      assert.ok(granterNotif, 'granter must receive T-7 expiry notification');
      assert.equal(delegateNotif.link, '/profile#delegations');
      assert.equal(granterNotif.link, '/settings/system/users');
      assert.equal(delegateNotif.dedupe_key, `delegation_expiring:${capId}:T-7:${delegate}`);
      assert.equal(granterNotif.dedupe_key, `delegation_expiring:${capId}:T-7:${granter}`);
      assert.equal(granterNotif.metadata.email, delegateEmail);
      assert.equal(delegateNotif.metadata.slug, 'users.approve');
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('delegation lifecycle: T-1 expiry window creates granter and delegate notifications', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];
    const twelveHoursOut = new Date(Date.now() + 12 * 3_600_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      `t1-granter-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      `t1-delegate-${delegate.slice(0, 8)}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            twelveHoursOut,
            granter,
          ]),
        )
      ).rows[0].id;

      await db.query('select public.generate_delegation_expiry_notifications()');

      const expiryRows = (
        await db.query(
          `select user_id, link, dedupe_key, metadata
             from public.user_notifications
            where related_id = $1
              and metadata ->> 'event' = 'expiring'`,
          [capId],
        )
      ).rows;

      assert.equal(expiryRows.length, 2);
      const delegateNotif = expiryRows.find((r) => r.user_id === delegate);
      const granterNotif = expiryRows.find((r) => r.user_id === granter);
      assert.equal(delegateNotif.dedupe_key, `delegation_expiring:${capId}:T-1:${delegate}`);
      assert.equal(granterNotif.dedupe_key, `delegation_expiring:${capId}:T-1:${granter}`);
      assert.equal(delegateNotif.metadata.days, 1);
      assert.equal(granterNotif.metadata.days, 1);
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('delegation lifecycle: expiry sweep is idempotent via dedupe_key and scheduled at 03:20 UTC', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];
    const fourDaysOut = new Date(Date.now() + 4 * 86_400_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      `dedupe-g-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      `dedupe-d-${delegate.slice(0, 8)}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            fourDaysOut,
            granter,
          ]),
        )
      ).rows[0].id;

      await db.query('select public.generate_delegation_expiry_notifications()');
      const countAfterFirst = (
        await db.query(
          `select count(*)::int as n
             from public.user_notifications
            where related_id = $1 and metadata ->> 'event' = 'expiring'`,
          [capId],
        )
      ).rows[0].n;
      assert.equal(countAfterFirst, 2);

      const insertedSecondRun = (
        await db.query('select public.generate_delegation_expiry_notifications() as n')
      ).rows[0].n;
      const countAfterSecond = (
        await db.query(
          `select count(*)::int as n
             from public.user_notifications
            where related_id = $1 and metadata ->> 'event' = 'expiring'`,
          [capId],
        )
      ).rows[0].n;

      assert.equal(insertedSecondRun, 0, 'second run in same window must be a no-op');
      assert.equal(countAfterSecond, 2);

      const cronJob = (
        await db.query(
          "select schedule, command from cron.job where jobname = 'generate-delegation-expiry-notifications-daily-0320'",
        )
      ).rows;
      assert.equal(cronJob.length, 1);
      assert.equal(cronJob[0].schedule, '20 3 * * *');
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('delegation lifecycle: updating expires_at or revoking resolves open expiry notifications', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const createdUsers = [granter, delegate];
    const fiveDaysOut = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const thirtyDaysOut = new Date(Date.now() + 30 * 86_400_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [
      granter,
      `renew-g-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      `renew-d-${delegate.slice(0, 8)}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            fiveDaysOut,
            granter,
          ]),
        )
      ).rows[0].id;

      await db.query('select public.generate_delegation_expiry_notifications()');

      assert.equal(
        (
          await db.query(
            `select count(*)::int as n
               from public.user_notifications
              where related_id = $1
                and metadata ->> 'event' = 'expiring'
                and resolved_at is null`,
            [capId],
          )
        ).rows[0].n,
        2,
      );

      // Renewing `expires_at` must resolve all open expiry warnings for that capability.
      await db.query('update public.user_capabilities set expires_at = $1 where id = $2', [
        thirtyDaysOut,
        capId,
      ]);

      assert.equal(
        (
          await db.query(
            `select count(*)::int as n
               from public.user_notifications
              where related_id = $1
                and metadata ->> 'event' = 'expiring'
                and resolved_at is null`,
            [capId],
          )
        ).rows[0].n,
        0,
        'renewing expires_at must resolve open expiry notifications',
      );
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  await test('profile self-service RPCs: get_my_delegated_capabilities and get_my_roles enforce caller isolation', async () => {
    const granter = randomUUID();
    const delegate = randomUUID();
    const outsider = randomUUID();
    const createdUsers = [granter, delegate, outsider];
    const granterEmail = `self-granter-${granter.slice(0, 8)}@example.invalid`;
    const futureExpiry = new Date(Date.now() + 6 * 86_400_000).toISOString();

    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4),($5,$6)', [
      granter,
      granterEmail,
      delegate,
      `self-delegate-${delegate.slice(0, 8)}@example.invalid`,
      outsider,
      `self-outsider-${outsider.slice(0, 8)}@example.invalid`,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='editor'",
      [outsider],
    );

    let capId = null;
    try {
      capId = (
        await asRole('service_role', granter, (c) =>
          c.query('select public.admin_grant_capability($1, $2, $3, $4) as id', [
            delegate,
            'users.approve',
            futureExpiry,
            granter,
          ]),
        )
      ).rows[0].id;

      const delegateCaps = (
        await asRole('authenticated', delegate, (c) =>
          c.query('select * from public.get_my_delegated_capabilities()'),
        )
      ).rows;
      assert.equal(delegateCaps.length, 1);
      assert.equal(delegateCaps[0].slug, 'users.approve');
      assert.equal(delegateCaps[0].granted_by, granter);
      assert.equal(delegateCaps[0].granted_by_email, granterEmail);

      const outsiderCaps = (
        await asRole('authenticated', outsider, (c) =>
          c.query('select * from public.get_my_delegated_capabilities()'),
        )
      ).rows;
      assert.equal(outsiderCaps.length, 0);

      const delegateRoles = (
        await asRole('authenticated', delegate, (c) =>
          c.query('select * from public.get_my_roles()'),
        )
      ).rows;
      assert.deepEqual(
        delegateRoles.map((r) => r.slug),
        ['viewer'],
      );
    } finally {
      if (capId) {
        await db.query('delete from public.user_notifications where related_id = $1', [capId]);
      }
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    }
  });

  // Shared fixture for the password-reset notification/owner-protection checks:
  // a super_admin granter, a viewer delegate holding both delegatable
  // capabilities, a reset target, and a user marked as the original owner.
  async function setupResetDelegate() {
    const granter = randomUUID();
    const delegate = randomUUID();
    const target = randomUUID();
    const ownerUser = randomUUID();
    const createdUsers = [granter, delegate, target, ownerUser];
    const targetEmail = `reset-target-${target.slice(0, 8)}@example.invalid`;
    const ownerEmailAddress = `reset-owner-${ownerUser.slice(0, 8)}@example.invalid`;
    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4),($5,$6),($7,$8)', [
      granter,
      `reset-granter-${granter.slice(0, 8)}@example.invalid`,
      delegate,
      `reset-delegate-${delegate.slice(0, 8)}@example.invalid`,
      target,
      targetEmail,
      ownerUser,
      ownerEmailAddress,
    ]);
    await db.query(
      "update public.profiles set approval_status='approved' where id = any($1::uuid[])",
      [createdUsers],
    );
    const previousFirstUserId = (
      await db.query('select first_user_id from public.first_admin_bootstrap_state where singleton')
    ).rows[0].first_user_id;
    await db.query(
      'update public.first_admin_bootstrap_state set first_user_id=$1 where singleton',
      [ownerUser],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='super_admin'",
      [granter],
    );
    await db.query(
      "insert into public.user_roles(user_id,role_id) select $1,id from public.roles where slug='viewer'",
      [delegate],
    );
    for (const slug of ['password_reset.manage', 'users.approve']) {
      await asRole('service_role', granter, (c) =>
        c.query('select public.admin_grant_capability($1,$2,null,$3) as id', [
          delegate,
          slug,
          granter,
        ]),
      );
    }
    const cleanup = async (requestIds) => {
      await db.query('delete from public.password_reset_requests where id = any($1::uuid[])', [
        requestIds.filter(Boolean),
      ]);
      await db.query(
        'delete from public.user_notifications where user_id = any($1::uuid[]) or related_id = any($2::uuid[])',
        [createdUsers, requestIds.filter(Boolean)],
      );
      await db.query(
        'update public.first_admin_bootstrap_state set first_user_id=$1 where singleton',
        [previousFirstUserId],
      );
      await db.query('delete from auth.users where id = any($1::uuid[])', [createdUsers]);
    };
    return { granter, delegate, target, ownerUser, targetEmail, ownerEmailAddress, cleanup };
  }

  await test('password-reset and approval notifications reach capability delegates, not only owners', async () => {
    const { delegate, targetEmail, cleanup } = await setupResetDelegate();
    let requestId = null;
    try {
      const recipients = (
        await db.query(
          "select public.resolve_notification_recipients('password_reset_requested') as id",
        )
      ).rows.map((r) => r.id);
      assert.ok(recipients.includes(delegate), 'delegate must receive reset notifications');
      const approvalRecipients = (
        await db.query(
          "select public.resolve_notification_recipients('user_approval_requested') as id",
        )
      ).rows.map((r) => r.id);
      assert.ok(
        approvalRecipients.includes(delegate),
        'delegate must receive approval notifications',
      );
      requestId = (
        await db.query(
          'insert into public.password_reset_requests(email) values ($1) returning id',
          [targetEmail],
        )
      ).rows[0].id;
      const notified = (
        await db.query(
          `select count(*)::int as n from public.user_notifications
            where type='password_reset_requested' and related_id=$1 and user_id=$2`,
          [requestId, delegate],
        )
      ).rows[0].n;
      assert.equal(notified, 1, 'delegate must be notified of a new reset request');
    } finally {
      await cleanup([requestId]);
    }
  });

  await test('approving a reset request for the original owner is refused with 42501', async () => {
    const { delegate, target, ownerUser, targetEmail, ownerEmailAddress, cleanup } =
      await setupResetDelegate();
    let requestId = null;
    let ownerRequestId = null;
    try {
      assert.equal(
        (await db.query('select public.is_original_owner($1) as owner', [ownerUser])).rows[0].owner,
        true,
        'fixture must actually make ownerUser the original owner',
      );
      // A delegate can still approve a non-owner request.
      requestId = (
        await db.query(
          'insert into public.password_reset_requests(email) values ($1) returning id',
          [targetEmail],
        )
      ).rows[0].id;
      const claim = (
        await asRole('service_role', delegate, (c) =>
          c.query('select public.admin_approve_password_reset_request($1,$2) as claim', [
            requestId,
            delegate,
          ]),
        )
      ).rows[0].claim;
      assert.equal(claim.auth_user_id, target);
      ownerRequestId = (
        await db.query(
          'insert into public.password_reset_requests(email) values ($1) returning id',
          [ownerEmailAddress],
        )
      ).rows[0].id;
      await expectCode('42501', () =>
        asRole('service_role', delegate, (c) =>
          c.query('select public.admin_approve_password_reset_request($1,$2)', [
            ownerRequestId,
            delegate,
          ]),
        ),
      );
      assert.equal(
        (
          await db.query('select status from public.password_reset_requests where id=$1', [
            ownerRequestId,
          ])
        ).rows[0].status,
        'pending_approval',
        'owner protection must refuse before reserving the request',
      );
    } finally {
      await cleanup([requestId, ownerRequestId]);
    }
  });

  await test('user_has_permission resolves correctly with no auth context (trigger context)', async () => {
    const { delegate, targetEmail, cleanup } = await setupResetDelegate();
    let requestId = null;
    try {
      // No JWT claims are set on this connection, so auth.uid() is NULL —
      // exactly the context of the trigger fired by an anonymous insert.
      assert.equal(
        (
          await db.query("select public.user_has_permission($1,'password_reset.manage') as ok", [
            delegate,
          ])
        ).rows[0].ok,
        true,
      );
      requestId = (
        await db.query(
          'insert into public.password_reset_requests(email) values ($1) returning id',
          [targetEmail],
        )
      ).rows[0].id;
      const notified = (
        await db.query(
          `select count(*)::int as n from public.user_notifications
            where type='password_reset_requested' and related_id=$1 and user_id=$2`,
          [requestId, delegate],
        )
      ).rows[0].n;
      assert.equal(notified, 1, 'trigger fan-out must reach the delegate without auth.uid()');
    } finally {
      await cleanup([requestId]);
    }
  });

  const report = {
    scope: 'OFFLINE fixture, not live Supabase',
    postgres: (await db.query('show server_version')).rows[0].server_version,
    migrationFiles: migrations,
    tests: RESULTS,
  };
  await mkdir(`${ROOT}.cache/live-audit`, { recursive: true });
  await writeFile(
    `${ROOT}.cache/live-audit/database-results.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${RESULTS.length} database checks passed. Evidence: .cache/live-audit/database-results.json`,
  );
} finally {
  await db.end();
}
