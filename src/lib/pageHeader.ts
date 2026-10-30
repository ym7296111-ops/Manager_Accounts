import type { LucideIcon } from 'lucide-react';
import type { TranslationKey } from '@/i18n/I18nContext';

/** Tone of the header for the current page. Colour is never the only signal. */
export type PageHeaderTone = 'emerald' | 'orange' | 'violet' | 'sky';

export interface PageHeaderOverride {
  /** Translated through the active locale, never stored as a string. */
  readonly titleKey: TranslationKey;
  readonly tone: PageHeaderTone;
  readonly icon: LucideIcon;
}

/**
 * One place for the four tones: the text stays readable in light and dark
 * themes, the icon sits on a tinted chip, and a short bar under the title
 * repeats the colour. `text-*` alone would fail a greyscale check.
 */
export const PAGE_HEADER_TONE_CLASSES: Record<
  PageHeaderTone,
  { readonly text: string; readonly chip: string; readonly bar: string }
> = {
  emerald: {
    text: 'text-emerald-700 dark:text-emerald-300',
    chip: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    bar: 'bg-emerald-500',
  },
  orange: {
    text: 'text-orange-700 dark:text-orange-300',
    chip: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    bar: 'bg-orange-500',
  },
  violet: {
    text: 'text-violet-700 dark:text-violet-300',
    chip: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    bar: 'bg-violet-500',
  },
  sky: {
    text: 'text-sky-700 dark:text-sky-300',
    chip: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
    bar: 'bg-sky-500',
  },
};
