import { Ban, CheckCircle2 } from 'lucide-react';

/**
 * Active/disabled indicator shared by the project-settings directories.
 *
 * Colour alone is not information: the state is also exposed to assistive
 * technology through a visually hidden label (and the icon is marked
 * `aria-hidden`), so the row reads as "…, active" rather than as a bare dot.
 */
export function StatusIcon({
  active,
  label,
}: {
  readonly active: boolean;
  readonly label: string;
}) {
  const Icon = active ? CheckCircle2 : Ban;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Icon
        className={active ? 'text-success size-4' : 'text-destructive size-4'}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
