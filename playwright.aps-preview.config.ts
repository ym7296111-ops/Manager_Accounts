import { defineConfig, devices } from '@playwright/test';

/** Isolated UI review only: no auth state, Supabase or production data. */
const baseURL = 'http://127.0.0.1:4174';
const executablePath = process.env.APS_REVIEW_CHROMIUM;

export default defineConfig({
  testDir: './src/dev/aps-preview',
  testMatch: 'review.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview:aps',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
