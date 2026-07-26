import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const mode = process.argv[2] || 'live'
if (!['live', 'fixture'].includes(mode)) {
  console.error(`Unknown proof mode: ${mode}`)
  process.exit(2)
}

const now = new Date().toISOString().replace(/[-:.]/g, '')
const runId = process.env.SES_PROOF_RUN_ID || `${now}-${mode}`
const runRoot = path.resolve(process.env.SES_PROOF_RUN_ROOT || path.join('artifacts', 'ses-reporting-proof', runId))
const playwright = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright')

if (!fs.existsSync(playwright)) {
  console.error('Playwright is not installed. Run npm ci and npx playwright install chromium once, then rerun this command.')
  process.exit(2)
}

fs.mkdirSync(runRoot, { recursive: true })
console.log(`SES Reporting proof mode: ${mode}`)
console.log(`Run folder: ${runRoot}`)
if (mode === 'fixture') {
  console.log('Fixture mode validates the harness only. It cannot prove the product works.')
}

const result = spawnSync(
  playwright,
  ['test', 'tests/e2e/ses-reporting-proof/ses-reporting-proof.spec.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SES_PROOF_MODE: mode,
      SES_PROOF_RUN_ID: runId,
      SES_PROOF_RUN_ROOT: runRoot,
    },
  },
)

console.log(`Summary: ${path.join(runRoot, 'summary.html')}`)
process.exit(result.status ?? 1)
