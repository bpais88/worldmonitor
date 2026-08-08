import { defineConfig } from '@playwright/test';

// The app's relay-fetch falls back to http://localhost:3004 when the page is served from
// localhost (the Vercel /api proxies don't exist in a plain preview), so the smoke test runs
// against the REAL clean-room relay rather than a mock. The relay is started unauthenticated
// on purpose — that path now requires the explicit opt-in, which is itself worth exercising.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    // Use a browser already on the machine when one is provided (CI images pin their own build,
    // which rarely matches the revision a fresh @playwright/test wants). Unset -> normal resolution.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: 'node scripts/relay.cjs',
      port: 3004,
      reuseExistingServer: !process.env.CI,
      env: { PORT: '3004', ALLOW_UNAUTHENTICATED_RELAY: '1', AISSTREAM_API_KEY: '', MARINESIA_API_KEY: '' },
      stdout: 'pipe',
    },
    {
      command: 'npm run build && npm run preview -- --port 4173 --host localhost',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
