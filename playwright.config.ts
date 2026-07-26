import { defineConfig } from '@playwright/test'
import path from 'node:path'

const runId = process.env.SES_PROOF_RUN_ID || 'manual-run-id-required'
const runRoot = path.resolve(process.env.SES_PROOF_RUN_ROOT || path.join('artifacts', 'ses-reporting-proof', runId))

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 12 * 60 * 1000,
  expect: { timeout: 15_000 },
  outputDir: path.join(runRoot, 'test-results'),
  reporter: [
    ['line'],
    [path.resolve('tests/e2e/ses-reporting-proof/reporter.ts')],
  ],
  use: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    video: 'on',
    trace: 'on',
    screenshot: 'off',
  },
})
