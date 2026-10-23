import { Moon, Sun } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';
import { useTheme } from '@/context/ThemeContext';
import { useI18n } from '@/i18n/I18nContext';

type ToggleProps = Omit<ComponentPropsWithoutRef<'button'>, 'onClick' | 'type'>;

/**
 * Theme switcher used by both the dashboard topbar and the standalone login
 * page. Clicking flips between the resolved light and dark modes.
 */
export function ThemeToggle({ className, ...rest }: ToggleProps) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const { t } = useI18n();

  const nextLabel = resolvedTheme === 'dark' ? t('theme.light') : t('theme.dark');

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`${t('theme.toggle')} — ${nextLabel}`}
      title={t('theme.toggle')}
      className={
        className ??
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex size-9 items-center justify-center rounded-lg border transition-colors'
      }
      {...rest}
    >
      {resolvedTheme === 'dark' ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Arabic <-> English switcher used by the topbar and the login page.
 * The label always shows the language you would switch TO (AR / EN).
 */
export function LanguageToggle({ className, ...rest }: ToggleProps) {
  const { locale, setLocale, t } = useI18n();

  const nextLocale = locale === 'ar' ? 'en' : 'ar';
  const nextName = nextLocale === 'ar' ? t('language.ar') : t('language.en');
  const shortLabel = locale === 'ar' ? 'EN' : 'ع';

  return (
    <button
      type="button"
      onClick={() => setLocale(nextLocale)}
      aria-label={t('language.switchTo', { name: nextName })}
      title={t('language.switchTo', { name: nextName })}
      className={
        className ??
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex size-9 items-center justify-center rounded-lg border transition-colors'
      }
      {...rest}
    >
      <span className="text-xs font-semibold" aria-hidden="true">
        {shortLabel}
      </span>
      <span className="sr-only">{nextName}</span>
    </button>
  );
}
