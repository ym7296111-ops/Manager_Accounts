import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DelegationExpiryBadge } from '@/components/users/DelegationExpiryBadge';
import type { DelegatedCapability } from '@/hooks/useDelegatedUsers';
import { I18nProvider, type Locale } from '@/i18n/I18nContext';

const BASE_NOW = Date.parse('2026-10-22T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function renderBadge(delegations: readonly DelegatedCapability[], locale: Locale = 'ar') {
  window.localStorage.setItem('admin-system:locale', locale);
  return render(
    <I18nProvider>
      <DelegationExpiryBadge delegations={delegations} now={BASE_NOW} />
    </I18nProvider>,
  );
}

describe('DelegationExpiryBadge', () => {
  it('renders gray Infinity icon with "تفويض دائم" tooltip when all delegations are permanent', () => {
    renderBadge(
      [
        {
          slug: 'users.approve',
          expires_at: null,
          granted_at: '2026-10-20T10:00:00.000Z',
        },
      ],
      'ar',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    expect(badge.getAttribute('data-expiry-tone')).toBe('gray');
    expect(badge.querySelector('[data-icon="infinity"]')).not.toBeNull();
    expect(badge.querySelector('[data-icon="clock"]')).toBeNull();
    expect(badge.getAttribute('title')).toBe('تفويض دائم');

    fireEvent.mouseEnter(badge);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('تفويض دائم');
    expect(tooltip.textContent).toContain('الصلاحيات المفوّضة:');
    expect(tooltip.textContent).toContain('users.approve');
  });

  it('renders green Clock icon when soonest delegation expires in more than 7 days', () => {
    renderBadge(
      [
        {
          slug: 'users.approve',
          expires_at: new Date(BASE_NOW + 12 * DAY_MS).toISOString(),
          granted_at: '2026-10-22T00:00:00.000Z',
        },
      ],
      'ar',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    expect(badge.getAttribute('data-expiry-tone')).toBe('green');
    expect(badge.querySelector('[data-icon="clock"]')).not.toBeNull();
  });

  it('renders yellow Clock icon and "5 أيام" tooltip when expiring in 5 days', () => {
    renderBadge(
      [
        {
          slug: 'users.approve',
          expires_at: new Date(BASE_NOW + 5 * DAY_MS).toISOString(),
          granted_at: '2026-10-22T00:00:00.000Z',
        },
      ],
      'ar',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    expect(badge.getAttribute('data-expiry-tone')).toBe('yellow');
    expect(badge.querySelector('[data-icon="clock"]')).not.toBeNull();

    // Opens via hover (desktop)
    fireEvent.mouseEnter(badge);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('التفويض ينتهي خلال: 5 أيام');
    expect(tooltip.textContent).toContain('الأقرب انتهاء:');
    expect(tooltip.textContent).toContain('الصلاحيات المفوّضة:');
    expect(tooltip.textContent).toContain('users.approve');
  });

  it('renders red Clock icon when expiring in 2 hours (< 24h) and supports mobile tap toggle', () => {
    renderBadge(
      [
        {
          slug: 'password_reset.manage',
          expires_at: new Date(BASE_NOW + 2 * HOUR_MS).toISOString(),
          granted_at: '2026-10-22T10:00:00.000Z',
        },
      ],
      'ar',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    expect(badge.getAttribute('data-expiry-tone')).toBe('red');
    expect(badge.querySelector('[data-icon="clock"]')).not.toBeNull();

    // Tap to open on mobile, tap again to close
    fireEvent.click(badge);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('التفويض ينتهي خلال:');
    expect(tooltip.textContent).toContain('password_reset.manage');

    fireEvent.click(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('uses the soonest expiry (3 days) when given two capabilities expiring in 3 days and 10 days', () => {
    renderBadge(
      [
        {
          slug: 'password_reset.manage',
          expires_at: new Date(BASE_NOW + 10 * DAY_MS).toISOString(),
          granted_at: '2026-10-22T00:00:00.000Z',
        },
        {
          slug: 'users.approve',
          expires_at: new Date(BASE_NOW + 3 * DAY_MS).toISOString(),
          granted_at: '2026-10-22T00:00:00.000Z',
        },
      ],
      'ar',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    expect(badge.getAttribute('data-expiry-tone')).toBe('yellow');
    fireEvent.mouseEnter(badge);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('التفويض ينتهي خلال: 3 أيام');
    expect(tooltip.textContent).toContain('users.approve');
    expect(tooltip.textContent).toContain('password_reset.manage');
  });

  it('renders localized English strings when active locale is "en"', () => {
    renderBadge(
      [
        {
          slug: 'users.approve',
          expires_at: new Date(BASE_NOW + 5 * DAY_MS).toISOString(),
          granted_at: '2026-10-22T00:00:00.000Z',
        },
      ],
      'en',
    );

    const badge = screen.getByTestId('delegation-expiry-badge');
    fireEvent.mouseEnter(badge);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Delegation expires in: 5 days');
    expect(tooltip.textContent).toContain('Soonest expiry:');
    expect(tooltip.textContent).toContain('Delegated capabilities:');
  });

  it('renders nothing when delegations array is empty', () => {
    const { container } = renderBadge([], 'ar');
    expect(container.firstChild).toBeNull();
  });
});
