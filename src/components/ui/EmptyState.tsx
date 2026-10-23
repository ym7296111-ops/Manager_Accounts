import { Inbox } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Shared "empty but ready" state used by the workspace and settings screens.
 * The content is intentionally empty — these screens are the prepared slots
 * the navigation tree promises.
 */
interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description }: EmptyStateProps) {
  return (
    <div className="animate-fade-in bg-card flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
      <span className="bg-muted text-muted-foreground grid size-14 place-items-center rounded-2xl">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-card-foreground text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{description}</p>
      </div>
    </div>
  );
}
