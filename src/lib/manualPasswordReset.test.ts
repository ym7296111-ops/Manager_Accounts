import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapManualResetInsertError, submitPasswordResetRequest } from '@/lib/manualPasswordReset';
import { getSupabase } from '@/lib/supabase';

/**
 * Manual password reset submissions. Every test drives the client through a
 * mocked `getSupabase`, so the network is never touched. The assertions cover
 * the payload normalization (the table's check constraint relies on it) and
 * the error taxonomy the recovery form translates.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

function mockClient(overrides: { insert?: unknown } = {}) {
  const queryBuilder = {
    insert: vi.fn().mockResolvedValue(overrides.insert ?? { data: null, error: null }),
  };
  const from = vi.fn(() => queryBuilder);
  vi.mocked(getSupabase).mockReturnValue({
    from,
  } as unknown as NonNullable<ReturnType<typeof getSupabase>>);
  return { queryBuilder, from };
}

describe('submitPasswordResetRequest', () => {
  beforeEach(() => {
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('reports a missing Supabase configuration', async () => {
    await expect(submitPasswordResetRequest({ email: 'a@b.co' })).resolves.toEqual({
      error: 'not-configured',
    });
  });

  it('inserts a normalized pending request into the queue table', async () => {
    const { queryBuilder, from } = mockClient();

    const result = await submitPasswordResetRequest({
      email: '  Member@Example.COM ',
    });

    expect(result).toEqual({ error: null });
    expect(from).toHaveBeenCalledWith('password_reset_requests');
    expect(queryBuilder.insert).toHaveBeenCalledWith({
      email: 'member@example.com',
    });
  });

  it('accepts no password and never sends a credential to the request table', async () => {
    const { queryBuilder } = mockClient();

    await expect(submitPasswordResetRequest({ email: 'safe@example.com' })).resolves.toEqual({
      error: null,
    });

    expect(queryBuilder.insert).toHaveBeenCalledWith({ email: 'safe@example.com' });
  });

  it('never branches on whether the address exists: any insert succeeds alike', async () => {
    const { queryBuilder } = mockClient();

    const known = await submitPasswordResetRequest({
      email: 'member@example.com',
    });
    const unknown = await submitPasswordResetRequest({
      email: 'stranger@example.com',
    });

    expect(known).toEqual({ error: null });
    expect(unknown).toEqual({ error: null });
    expect(queryBuilder.insert).toHaveBeenCalledTimes(2);
  });

  it('maps a duplicate pending request (unique partial index)', async () => {
    mockClient({
      insert: {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      },
    });

    await expect(submitPasswordResetRequest({ email: 'member@example.com' })).resolves.toEqual({
      error: 'duplicate-pending',
    });
  });

  it('maps a missing table (migration not applied) to not-deployed', async () => {
    mockClient({
      insert: {
        data: null,
        error: {
          code: 'PGRST205',
          message: "Could not find the table 'public.password_reset_requests' in the schema cache",
        },
      },
    });

    await expect(submitPasswordResetRequest({ email: 'member@example.com' })).resolves.toEqual({
      error: 'not-deployed',
    });
  });

  it('maps a thrown fetch failure to network', async () => {
    const { queryBuilder } = mockClient();
    queryBuilder.insert.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(submitPasswordResetRequest({ email: 'member@example.com' })).resolves.toEqual({
      error: 'network',
    });
  });

  it('maps anything unrecognizable to unknown', async () => {
    mockClient({
      insert: { data: null, error: { code: '23514', message: 'check constraint violated' } },
    });

    await expect(submitPasswordResetRequest({ email: 'member@example.com' })).resolves.toEqual({
      error: 'unknown',
    });
  });
});

describe('mapManualResetInsertError', () => {
  const error = (code: string, message: string) =>
    mapManualResetInsertError({ code, message } as never);

  it('classifies rate limiting by status code and by message', () => {
    expect(error('429', 'Too many requests')).toBe('rate-limited');
    expect(error('XX000', 'rate limit exceeded')).toBe('rate-limited');
  });

  it('classifies network wording', () => {
    expect(error('', 'NetworkError when calling fetch')).toBe('network');
    expect(error('', 'Failed to fetch')).toBe('network');
  });
});
