// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20261003110000_notification_bundle_rpc.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

function functionBody(name: string): string {
  const definition = migration.match(
    new RegExp(
      `create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\)\\s*returns[\\s\\S]*?\\bas\\s+\\$\\$([\\s\\S]*?)\\$\\$;`,
      'i',
    ),
  );

  if (!definition?.[1]) {
    throw new Error(`RPC definition not found: ${name}`);
  }

  return definition[1].replace(/^\s*--.*$/gm, '');
}

function jsonObjectKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/'([a-z][a-z0-9_]*)'\s*,/gi)) {
    const key = match[1];
    if (key) keys.push(key);
  }
  return keys;
}

describe('notification bundle RPC migration (D12 / §2.10)', () => {
  const exportBody = functionBody('admin_export_notification_bundle');
  const importBody = functionBody('admin_import_notification_bundle');

  it('projects an explicit export shape without secret, password, ciphertext, or original-id fields', () => {
    const keys = jsonObjectKeys(exportBody);

    expect(keys).toEqual(
      expect.arrayContaining([
        'version',
        'transports',
        'templates',
        'slug',
        'provider_type',
        'config',
        'key',
        'status',
        'variables',
        'sample_variables',
        'is_system',
      ]),
    );
    expect(keys).not.toContain('id');
    expect(keys.filter((key) => /(secret|password|passwd|ciphertext)/i.test(key))).toEqual([]);
    expect(exportBody).not.toMatch(
      /notification_transport_secrets|secret_ciphertext|secrets_version/i,
    );
    expect(exportBody).not.toMatch(/to_jsonb\s*\(/i);
    expect(exportBody).toMatch(/template\.status\s+in\s*\('active',\s*'draft'\)/i);
    expect(exportBody).toMatch(/is_system',\s*template\.is_system/i);
    expect(exportBody).toMatch(/!~\*\s*'\(secret\|password\|passwd\|ciphertext/i);
  });

  it('imports templates with DO NOTHING and never updates existing active customer content', () => {
    expect(importBody).toMatch(/on conflict\s*\(key,\s*locale,\s*version\)\s*do nothing/i);
    expect(importBody).not.toMatch(/update\s+public\.notification_templates/i);
    expect(importBody).toMatch(/v_is_system\s*:=\s*coalesce\(/i);
    expect(importBody).toMatch(/existing\.version\s*=\s*v_template_version/i);
    expect(importBody).toMatch(/existing_draft\.status\s*=\s*'draft'/i);
    expect(importBody).toMatch(/v_is_current\s*:=\s*v_template_status\s*=\s*'active'/i);
  });

  it('ignores secret-shaped input properties and always imports transports disabled and non-default', () => {
    expect(importBody).not.toMatch(/(?:->>|->)\s*'[^']*(?:secret|password|ciphertext)[^']*'/i);
    expect(importBody).not.toMatch(/notification_transport_secrets|secret_ciphertext/i);
    expect(importBody).toMatch(/on conflict\s*\(slug\)\s*do nothing/i);
    expect(importBody).toMatch(/is_enabled,\s*is_default,[\s\S]*?false,\s*false,/i);
    expect(importBody).toMatch(/header\.key\s*!~\*\s*'\(secret\|password\|passwd\|ciphertext/i);
    expect(importBody).toMatch(
      /candidate\.value\s*->>\s*'name'[\s\S]*?!~\*\s*'\(secret\|password\|passwd\|ciphertext/i,
    );
  });
});
