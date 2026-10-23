import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { fixturesPath, type E2EFixtures } from '../global-setup.ts';
import type { E2EDatabase } from './database.types.ts';

export async function readFixtures(): Promise<E2EFixtures> {
  return JSON.parse(await readFile(fixturesPath, 'utf8')) as E2EFixtures;
}

export async function createLocalAdminClient() {
  const { supabaseUrl, serviceRoleKey } = await readFixtures();
  return createClient<E2EDatabase>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
