import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Rendered when the boundary trips. Defaults to `null` — the
   * rest of the tree keeps working, which is the entire point.
   */
  readonly fallback?: ReactNode;
  /** Namespaced into the logged error, e.g. the feature name. */
  readonly name?: string;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

/**
 * Last-resort containment for non-critical subtrees.
 *
 * An uncaught error anywhere in a React tree unmounts the ENTIRE
 * root — a single misbehaving widget blanks the page. Features
 * that talk to sockets or third-party services (Realtime, for
 * example) must therefore be wrapped: the failure is logged here
 * and the subtree is sacrificed, while the app around it stays
 * interactive.
 *
 * This is defense in depth, not a license to throw: hooks must
 * still contain their own subscription errors (see
 * `useUserNotificationsRealtime`).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* Telemetry seam: structured logging today, an APM client
       tomorrow. Never rethrow — the boundary has already decided
       the subtree is lost. */
    console.error(`[ErrorBoundary:${this.props.name ?? 'unnamed'}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
