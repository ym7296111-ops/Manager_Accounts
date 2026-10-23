import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default async function globalTeardown(): Promise<void> {
  // Remove generated credentials and the browser session even if a test failed.
  await rm(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true, force: true });
}
