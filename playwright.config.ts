import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks of the site in the engines people use: Chromium (Chrome),
 * Edge, Firefox, WebKit (Safari) and an iPhone. Runs against the production
 * build, the way the site is served.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4180',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    // Edge is the installed browser, so only where it is installed (not on CI).
    ...(process.env.CI
      ? []
      : [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1280, height: 860 } } }]),
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 860 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 } } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
  webServer: {
    command: 'npm run build -w apps/demo && npx -w apps/demo vite preview --port 4180 --strictPort',
    url: 'http://localhost:4180',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
