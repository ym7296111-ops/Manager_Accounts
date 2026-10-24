import type { ReactNode } from 'react';

/**
 * Harness-only replacement for the route capability guard.
 *
 * The live preview runs without a Supabase project, so there is no session and
 * no capability snapshot to gate on. Swapping only this module (via
 * `vite.preview.config.ts`) keeps every other byte of the screen — the real
 * `ProjectSettings`, the real tabs, the real `Classifications` tree and its
 * real hook — in the preview, so what you review is what ships.
 *
 * The production guard is untouched.
 */
export function RequireCapability({
  children,
}: {
  readonly requirement: string;
  readonly children: ReactNode;
}) {
  return <>{children}</>;
}
