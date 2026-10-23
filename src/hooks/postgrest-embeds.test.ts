import { describe, expect, it } from 'vitest';
import { PROFILE_COLUMNS } from '@/hooks/useUsersManagement';
import { REPLY_COLUMNS, TICKET_COLUMNS } from '@/hooks/useSupportManagement';

/**
 * PostgREST embed-disambiguation regression (PGRST201).
 *
 * `user_roles` has TWO foreign keys to `profiles` (`user_id` and `granted_by`).
 * An unqualified `user_roles(...)` embed therefore fails every request with
 * HTTP 300 / PGRST201 ("Could not embed because more than one relationship was
 * found") — silently emptying the users and support screens. Each embed MUST
 * carry the `!user_id` relationship hint. See:
 * docs/consultations/2026-10-18-approval-visibility-and-signup-messaging-rca.md
 */
const COLUMN_PROJECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['PROFILE_COLUMNS', PROFILE_COLUMNS],
  ['TICKET_COLUMNS', TICKET_COLUMNS],
  ['REPLY_COLUMNS', REPLY_COLUMNS],
];

describe('PostgREST embed disambiguation (PGRST201 regression)', () => {
  it.each(COLUMN_PROJECTIONS)('%s hints user_roles with its user_id FK', (_name, columns) => {
    expect(columns).toContain('user_roles!user_id(');
  });

  it.each(COLUMN_PROJECTIONS)(
    '%s never uses a bare, ambiguous user_roles embed',
    (_name, columns) => {
      expect(columns).not.toMatch(/user_roles\(/);
    },
  );

  it.each(COLUMN_PROJECTIONS)(
    '%s keeps the response key `user_roles` (no aliasing, parsing unchanged)',
    (_name, columns) => {
      /* `alias:user_roles!user_id(...)` would rename the embedded key and break
         parseUserRow/parseTicket wire readers. The hint must stand alone. */
      expect(columns).not.toMatch(/:\s*user_roles!/);
    },
  );
});
