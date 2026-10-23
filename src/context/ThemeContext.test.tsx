import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, THEME_STORAGE_KEY, useTheme } from '@/context/ThemeContext';

function ThemeProbe() {
  const { theme, resolvedTheme, toggleTheme, setTheme } = useTheme();

  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={toggleTheme}>
        toggle
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        system
      </button>
    </div>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('starts from the system preference (light in jsdom) without the dark class', () => {
    renderTheme();

    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles to dark, applies .dark on <html> and persists the choice', () => {
    renderTheme();

    fireEvent.click(screen.getByText('toggle'));

    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('restores a persisted preference on mount', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    renderTheme();

    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('returns to system mode when re-selected', () => {
    renderTheme();

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');

    fireEvent.click(screen.getByText('system'));
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});
