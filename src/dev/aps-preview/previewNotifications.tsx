import { Bell } from 'lucide-react';
import type { ReactNode } from 'react';

export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  return children;
}

export function NotificationBell({ className }: { readonly className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <Bell className="size-4" />
    </span>
  );
}
