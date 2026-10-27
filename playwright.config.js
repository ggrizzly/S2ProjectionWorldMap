import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:8000',
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-webgpu', '--ignore-certificate-errors'] },
  },
  webServer: {
    command: 'python3 -m http.server 8000 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8000',
    reuseExistingServer: !process.env.CI,
  },
});
