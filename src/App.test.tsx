import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';

/**
 * Full application smoke test: providers, router and the auth guard.
 * No Supabase environment is configured in CI, so the anonymous visit must
 * land on the standalone login screen.
 */
describe('App integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    window.history.replaceState({}, '', '/');
  });

  it('redirects anonymous visitors from / to the standalone login screen', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });

  it('shows the 404 screen outside the dashboard shell', async () => {
    window.history.replaceState({}, '', '/does/not/exist');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'الصفحة غير موجودة' })).toBeTruthy();
    expect(document.querySelector('aside[aria-label="التنقل الرئيسي"]')).toBeNull();
  });
});
