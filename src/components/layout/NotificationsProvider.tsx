import { createContext, useContext, type ReactNode } from 'react';
import { useUserNotifications, type UserNotificationsApi } from '@/hooks/useUserNotifications';

/**
 * Single owner of the in-app notification feed for the app shell.
 *
 * Mounted once in `Topbar` around the bell, this provider is the ONLY place
 * `useUserNotifications` runs: one hook instance means one Realtime
 * subscription (one `postgres_changes` channel, INSERT + UPDATE + DELETE via
 * `event: '*'`) whose signal invalidates both user-scoped queries, and both
 * the badge (`NotificationBell`) and the panel (`NotificationDropdown`) read
 * that one feed through context. Auth (setAuth before subscribe) and cleanup
 * (removeChannel on unmount) stay where they have always been — inside
 * `useUserNotificationsRealtime`.
 *
 * History: the bell and the dropdown used to each mount the hook, so opening
 * the panel created a SECOND subscription. The realtime hook still gives every
 * instance a unique channel topic, so an accidental second mount degrades to
 * a redundant socket instead of a crash — but structurally there is one now.
 */
const NotificationsContext = createContext<UserNotificationsApi | null>(null);
NotificationsContext.displayName = 'NotificationsContext';

export interface NotificationsProviderProps {
  children: ReactNode;
}

export function NotificationsProvider({ children }: NotificationsProviderProps) {
  const api = useUserNotifications();
  return <NotificationsContext.Provider value={api}>{children}</NotificationsContext.Provider>;
}

/**
 * Access the shell-level notification feed.
 * Throws outside of {@link NotificationsProvider} so a missing provider fails
 * loudly instead of spinning up a rogue second subscription.
 */
export function useNotifications(): UserNotificationsApi {
  const context = useContext(NotificationsContext);
  if (context === null) {
    throw new Error(
      'useNotifications must be used inside a <NotificationsProvider>. Wrap the notification bell first.',
    );
  }
  return context;
}
