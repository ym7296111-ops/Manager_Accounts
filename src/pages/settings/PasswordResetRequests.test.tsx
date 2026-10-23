import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PasswordResetsModule from '@/hooks/usePasswordResetRequests';
import {
  usePasswordResetRequests,
  type PasswordResetRequestRow,
  type PasswordResetRequestsApi,
} from '@/hooks/usePasswordResetRequests';
import { I18nProvider } from '@/i18n/I18nContext';
import PasswordResetRequests from '@/pages/settings/PasswordResetRequests';

/**
 * Screen-level tests for the Password Reset Requests queue (the admin half of
 * the manual approval flow):
 * - pending rows render with Approve/Reject actions,
 * - both actions go through the confirmation dialog before hitting the hook,
 * - failures surface their translated code inside the dialog,
 * - empty and fetch-error states stay distinguishable.
 */

vi.mock('@/hooks/usePasswordResetRequests', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordResetsModule>();
  return { ...actual, usePasswordResetRequests: vi.fn() };
});

const mockedUsePasswordResetRequests = vi.mocked(usePasswordResetRequests);

/* ------------------------------------------------------------- fixtures */

function requestRow(
  id: string,
  overrides: Partial<PasswordResetRequestRow> = {},
): PasswordResetRequestRow {
  return {
    id,
    email: `${id}@example.invalid`,
    status: 'pending_approval',
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  };
}

const PENDING_ROW = requestRow('req-1');
const PROCESSED_ROW = requestRow('req-2', { status: 'approved' });

/* ------------------------------------------------------------- helpers */

function renderScreen(overrideApi?: Partial<PasswordResetRequestsApi>) {
  const api: PasswordResetRequestsApi = {
    requests: [PENDING_ROW],
    statusFilter: 'pending',
    setStatusFilter: vi.fn(),
    approveRequest: vi.fn().mockResolvedValue({
      ok: true,
      requestId: '',
      status: 'approved',
      tempPassword: 'Gen3rated!Pass',
    }),
    rejectRequest: vi.fn().mockResolvedValue({ ok: true, requestId: '', status: 'rejected' }),
    pendingRequestId: null,
    isInitialLoading: false,
    isRefreshing: false,
    fetchError: null,
    lastSyncedAt: Date.now(),
    refresh: vi.fn(),
    ...overrideApi,
  };
  mockedUsePasswordResetRequests.mockReturnValue(api);

  render(
    <I18nProvider defaultLocale="en">
      <PasswordResetRequests />
    </I18nProvider>,
  );
  return api;
}

/* ------------------------------------------------------------- tests */

describe('PasswordResetRequests — queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists pending requests with both actions and never a password', () => {
    renderScreen();

    expect(screen.getByRole('table', { name: 'Password reset requests' })).toBeTruthy();
    expect(screen.getByText('req-1@example.invalid')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy();
    /* The plaintext password is not part of the wire contract at all. */
    expect(screen.queryByText(/new_password/i)).toBeNull();
  });

  it('renders processed rows without actions', () => {
    renderScreen({ requests: [PROCESSED_ROW], statusFilter: 'processed' });

    expect(screen.getByText('req-2@example.invalid')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject$/ })).toBeNull();
  });

  it('switches the queue filter through the toolbar', () => {
    const api = renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'All requests' }));
    expect(api.setStatusFilter).toHaveBeenCalledWith('all');
  });

  it('approves through the confirmation dialog and shows the success banner', async () => {
    const api = renderScreen();

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('A new password will be generated');
    /* No manual password entry: approval generates the credential. */
    expect(dialog.querySelector('#reset-new-password')).toBeNull();
    expect(dialog.querySelector('#reset-confirm-password')).toBeNull();
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByLabelText('Confirm new password')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve & update password' }));

    expect(api.approveRequest).toHaveBeenCalledWith('req-1');
    expect(await screen.findByText(/Approved\. Copy the password now/)).toBeTruthy();
  });

  it('opens PasswordRevealDialog with the generated password after approval', async () => {
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & update password' }));

    const reveal = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(reveal.textContent).toContain('Gen3rated!Pass');
  });

  it('rejects through the confirmation dialog without touching the password', async () => {
    const api = renderScreen();

    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('stays unchanged');

    fireEvent.click(screen.getByRole('button', { name: 'Reject request' }));

    expect(api.rejectRequest).toHaveBeenCalledWith('req-1');
    expect(api.approveRequest).not.toHaveBeenCalled();
    expect(await screen.findByText(/was rejected/)).toBeTruthy();
  });

  it('cancels the dialog without calling the hook', async () => {
    const api = renderScreen();

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.approveRequest).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the translated failure', async () => {
    renderScreen({
      approveRequest: vi
        .fn()
        .mockResolvedValue({ ok: false, requestId: 'req-1', code: 'user-not-found' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & update password' }));

    expect(
      await screen.findByText('No account is registered with this email address.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the pending empty state when the queue is clear', () => {
    renderScreen({ requests: [] });

    expect(screen.getByText('No pending requests')).toBeTruthy();
  });

  it('shows the fetch error panel with a retry for transient failures', () => {
    const api = renderScreen({ requests: [], fetchError: 'network' });

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not reach the server — check your connection.',
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(api.refresh).toHaveBeenCalled();
  });

  it('shows the not-deployed operator message without a retry', () => {
    renderScreen({ requests: [], fetchError: 'not-deployed' });

    expect(screen.getByRole('alert').textContent).toContain(
      'The password reset service is not deployed on this project',
    );
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});
