import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTitle } from '@/components/layout/DocumentTitle';
import { I18nProvider } from '@/i18n/I18nContext';

vi.mock('@/context/BrandingContext', () => ({
  useBranding: () => ({ displayName: 'Manager Accounts' }),
}));

describe('DocumentTitle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.title = '';
  });

  it('changes DocumentTitle when the active workspace route changes', async () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/workspaces/aps']}>
          <DocumentTitle />
          <Routes>
            <Route
              path="/workspaces/aps"
              element={<Link to="/workspaces/reports">Open reports</Link>}
            />
            <Route
              path="/workspaces/reports"
              element={
                <div>
                  <Link to="/">Go home</Link>
                </div>
              }
            />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() => expect(document.title).toBe('APS | Manager Accounts'));
    fireEvent.click(screen.getByRole('link', { name: 'Open reports' }));
    await waitFor(() => expect(document.title).toBe('التقارير والاستعلامات | Manager Accounts'));
    fireEvent.click(screen.getByRole('link', { name: 'Go home' }));
    await waitFor(() => expect(document.title).toBe('Manager Accounts'));
  });
});
