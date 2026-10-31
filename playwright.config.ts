import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 120_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', acceptDownloads: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-cpu', use: { browserName: 'chromium', launchOptions: { executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] } } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'node tests/start-e2e.mjs', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI },
});
