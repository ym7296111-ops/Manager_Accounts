import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

/**
 * The boundary is the last line of defense around the
 * notification stack: a subtree that throws must be
 * contained — logged, sacrificed — while the page around
 * it keeps working.
 */

function Boom(): never {
  throw new Error('notification stack exploded');
}

describe('ErrorBoundary', () => {
  it('renders children while nothing throws', () => {
    render(
      <ErrorBoundary name="Test">
        <p>healthy</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('healthy')).not.toBe(null);
  });

  it('contains a throwing subtree and keeps the page alive', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <main>
        <p>outside the boundary</p>
        <ErrorBoundary name="NotificationBell">
          <Boom />
        </ErrorBoundary>
      </main>,
    );

    /* The rest of the tree survives… */
    expect(screen.getByText('outside the boundary')).not.toBe(null);
    /* …the failed subtree is sacrificed, not propagated… */
    expect(screen.queryByText('notification stack exploded')).toBe(null);
    /* …and the failure is logged through the telemetry seam. */
    const logged = errorSpy.mock.calls.some((call) =>
      String(call[0]).includes('[ErrorBoundary:NotificationBell]'),
    );
    expect(logged).toBe(true);
    errorSpy.mockRestore();
  });

  it('renders the provided fallback when the subtree throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary name="Test" fallback={<p>degraded</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('degraded')).not.toBe(null);
    vi.restoreAllMocks();
  });
});
