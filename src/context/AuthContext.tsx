import { AuthError, type Session } from '@supabase/supabase-js';
import { QueryClientContext } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { env } from '@/lib/env';
import { getSupabase } from '@/lib/supabase';

/**
 * Authentication context backed by Supabase Auth (GoTrue).
 *
 * * Tracks the active session (`getSession` + `onAuthStateChange`).
 * * Exposes `signIn`, `signUp`, and `signOut` with normalized error codes so
 *   the UI can translate them in any language.
 * * Degrades to `configured: false` when env vars are missing, letting the
 *   login screen show an explicit setup banner instead of failing silently.
 */

/** Normalized, locale independent authentication error codes. */
export type AuthErrorCode =
  | 'not-configured'
  | 'invalid-credentials'
  | 'email-not-confirmed'
  | 'pending-approval'
  | 'rejected-approval'
  | 'rate-limited'
  | 'signup-disabled'
  | 'weak-password'
  | 'network'
  | 'unknown';

/**
 * Which signup path completed:
 * * `first-owner` — the very first registrant: the DB trigger confirmed their
 *   email and granted the protected owner role immediately.
 * * `pending-approval` — every later registrant: account awaits owner/admin
 *   approval before it can be used.
 */
export type SignupOutcome = 'first-owner' | 'pending-approval';

export interface AuthContextValue {
  /** Current Supabase session, or `null` when signed out. */
  readonly session: Session | null;
  /** Server-verified approval state; null while signed out or unresolved. */
  readonly approvalStatus: 'approved' | 'pending' | 'rejected' | null;
  /** True while the initial session lookup is in flight. */
  readonly loading: boolean;
  /** False when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing. */
  readonly configured: boolean;
  /** Sign in with email + password. */
  readonly signIn: (email: string, password: string) => Promise<{ error: AuthErrorCode | null }>;
  /** Create an email/password account; reports whether email confirmation is still required. */
  readonly signUp: (
    email: string,
    password: string,
  ) => Promise<{
    error: AuthErrorCode | null;
    requiresEmailConfirmation: boolean;
    /** Which signup outcome banner the form should show (null on error). */
    outcome: SignupOutcome | null;
  }>;
  /** Sign out of the current session. */
  readonly signOut: () => Promise<{ error: AuthErrorCode | null }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
AuthContext.displayName = 'AuthContext';

function mapAuthError(error: unknown): AuthErrorCode {
  if (error instanceof AuthError) {
    const message = error.message.toLowerCase();

    if (error.status === 429) {
      return 'rate-limited';
    }
    if (message.includes('invalid login credentials')) {
      return 'invalid-credentials';
    }
    if (message.includes('email not confirmed')) {
      return 'email-not-confirmed';
    }
    if (message.includes('signups not allowed') || message.includes('signup is disabled')) {
      return 'signup-disabled';
    }
    if (message.includes('weak password') || message.includes('password should be at least')) {
      return 'weak-password';
    }
    if (message.includes('rate limit')) {
      return 'rate-limited';
    }
    if (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      error.name === 'AuthRetryableFetchError'
    ) {
      return 'network';
    }
    return 'unknown';
  }

  if (error instanceof TypeError) {
    return 'network';
  }

  return 'unknown';
}

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<'approved' | 'pending' | 'rejected' | null>(
    null,
  );
  const verification = useRef(0);
  const verifiedUserId = useRef<string | null>(null);
  const signingUp = useRef(false);
  const [loading, setLoading] = useState(() => getSupabase() !== null);
  const configured = env.isSupabaseConfigured;

  /* Read the QueryClient optionally: the app shell always provides one, but a
     bare test tree may not — a missing provider must never break auth. */
  const queryClient = useContext(QueryClientContext);

  /* Drop the cached notification feed on every sign-out path. Feed keys are
     user-scoped (`['user-notifications', userId, …]`, see useUserNotifications),
     but dropping them here guarantees that the next account on this browser
     can never read the previous account's cached rows or badge count — not
     even between sign-out and the next sign-in. The partial (prefix) key
     removes both the list and the unread-count entries for every user. The key
     is spelled literally: importing it from the hook would cycle this context
     through every consumer that reads `useAuth`. */
  const clearNotificationCache = useCallback(() => {
    queryClient?.removeQueries({ queryKey: ['user-notifications'] });
  }, [queryClient]);

  // Never publish an Auth session until the profile has been verified. A
  // missing/unreadable profile fails closed (not an implicit approval).
  const verifySession = useCallback(
    async (candidate: Session | null): Promise<AuthErrorCode | null> => {
      const generation = ++verification.current;
      if (!candidate) {
        /* Signed out (explicit sign-out, expiry, remote revocation): the
           previous account's cached feed must not survive this transition. */
        verifiedUserId.current = null;
        clearNotificationCache();
        setSession(null);
        setApprovalStatus(null);
        setLoading(false);
        return null;
      }
      /* Avoid unmounting active pages/dialogs when re-verifying the same
         already-approved user on `USER_UPDATED`, `TOKEN_REFRESHED`, or re-auth. */
      if (verifiedUserId.current !== candidate.user.id) {
        setLoading(true);
      }
      const client = getSupabase();
      if (!client) return 'not-configured';
      try {
        const { data, error } = await client
          .from('profiles')
          .select('approval_status')
          .eq('id', candidate.user.id)
          .maybeSingle();
        if (generation !== verification.current) return 'unknown';
        if (error || !data || data.approval_status !== 'approved') {
          const reason: AuthErrorCode =
            data?.approval_status === 'pending'
              ? 'pending-approval'
              : data?.approval_status === 'rejected'
                ? 'rejected-approval'
                : 'unknown';
          verifiedUserId.current = null;
          clearNotificationCache();
          setSession(null);
          setApprovalStatus(
            reason === 'pending-approval'
              ? 'pending'
              : reason === 'rejected-approval'
                ? 'rejected'
                : null,
          );
          await client.auth.signOut();
          return reason;
        }
        verifiedUserId.current = candidate.user.id;
        setApprovalStatus('approved');
        setSession(candidate);
        return null;
      } catch {
        if (generation === verification.current) {
          verifiedUserId.current = null;
          clearNotificationCache();
          setSession(null);
          setApprovalStatus(null);
          await client.auth.signOut();
        }
        return 'unknown';
      } finally {
        if (generation === verification.current) setLoading(false);
      }
    },
    [clearNotificationCache],
  );

  useEffect(() => {
    const client = getSupabase();
    if (!client) return;
    let cancelled = false;
    void client.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) void verifySession(data.session);
      })
      .catch(() => {
        if (!cancelled) void verifySession(null);
      });
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      // Supabase holds its auth lock inside this callback. Defer all API calls.
      if (
        (event === 'SIGNED_IN' && !signingUp.current) ||
        event === 'TOKEN_REFRESHED' ||
        event === 'USER_UPDATED' ||
        event === 'SIGNED_OUT'
      ) {
        queueMicrotask(() => {
          if (!cancelled) void verifySession(nextSession);
        });
      }
    });
    const generation = verification;
    return () => {
      cancelled = true;
      generation.current++;
      subscription.unsubscribe();
    };
  }, [verifySession]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const client = getSupabase();
      if (client === null) {
        return { error: 'not-configured' as const };
      }

      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          return { error: mapAuthError(error) };
        }
        return { error: await verifySession(data.session) };
      } catch (caught) {
        return { error: mapAuthError(caught) };
      }
    },
    [verifySession],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      const client = getSupabase();
      if (client === null) {
        return {
          error: 'not-configured' as const,
          requiresEmailConfirmation: false,
          outcome: null,
        };
      }

      try {
        signingUp.current = true;
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) {
          return { error: mapAuthError(error), requiresEmailConfirmation: false, outcome: null };
        }

        /* Resolve which signup path completed before discarding any session.
         The first owner is auto-confirmed by the signup trigger (`email_confirmed_at`
         set / instant session); every later registrant is left unconfirmed and
         pending. With project-wide auto-confirm ON everyone gets a session, so
         read our own `approval_status` (RLS: self-readable even while pending)
         to disambiguate — `approved` can only be the first owner on a fresh
         signup. Conservative fallback is always `pending-approval`. */
        let outcome: SignupOutcome = 'pending-approval';
        const userId = data.user?.id ?? null;
        const sessionIssued = data.session !== null;
        const confirmedAtSignup = data.user?.email_confirmed_at != null;
        if (userId !== null && (sessionIssued || confirmedAtSignup)) {
          if (sessionIssued) {
            const { data: profile } = await client
              .from('profiles')
              .select('approval_status')
              .eq('id', userId)
              .maybeSingle();
            outcome =
              (profile as { approval_status?: string } | null)?.approval_status === 'approved'
                ? 'first-owner'
                : 'pending-approval';
          } else {
            /* Confirmed without a session: only the first-owner trigger does
             that (later signups stay unconfirmed until approval). */
            outcome = 'first-owner';
          }
        }

        // Some projects disable email verification and return an Auth session at
        // signup. Never retain it: every new non-owner must await approval.
        if (data.session) await client.auth.signOut();
        clearNotificationCache();
        setSession(null);
        setApprovalStatus(null);
        return { error: null, requiresEmailConfirmation: true, outcome };
      } catch (caught) {
        return { error: mapAuthError(caught), requiresEmailConfirmation: false, outcome: null };
      } finally {
        signingUp.current = false;
      }
    },
    [clearNotificationCache],
  );

  const signOut = useCallback(async () => {
    const client = getSupabase();
    if (client === null) {
      return { error: 'not-configured' as const };
    }

    try {
      const { error } = await client.auth.signOut();
      if (error) {
        return { error: mapAuthError(error) };
      }
      verification.current++;
      clearNotificationCache();
      setSession(null);
      setApprovalStatus(null);
      return { error: null };
    } catch (caught) {
      return { error: mapAuthError(caught) };
    }
  }, [clearNotificationCache]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, approvalStatus, loading, configured, signIn, signUp, signOut }),
    [session, approvalStatus, loading, configured, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Access the Supabase-backed authentication state.
 * Throws outside of {@link AuthProvider} so a missing provider fails loudly.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside an <AuthProvider>. Wrap your app root first.');
  }
  return context;
}
