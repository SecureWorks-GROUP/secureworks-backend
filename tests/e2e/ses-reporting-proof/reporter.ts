import fs from 'node:fs/promises'
import path from 'node:path'
import type { FullResult, Reporter } from '@playwright/test/reporter'

async function findFiles(root: string, suffix: string): Promise<string[]> {
  const found: string[] = []
  async function walk(directory: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(candidate)
      else if (entry.name.endsWith(suffix)) found.push(candidate)
    }
  }
  await walk(root)
  return found
}

export default class SesProofReporter implements Reporter {
  async onEnd(_result: FullResult): Promise<void> {
    const runId = process.env.SES_PROOF_RUN_ID
    if (!runId) return
    const runRoot = path.resolve(process.env.SES_PROOF_RUN_ROOT || path.join('artifacts', 'ses-reporting-proof', runId))
    const testResults = path.join(runRoot, 'test-results')
    const videos = await findFiles(testResults, '.webm')
    const traces = await findFiles(testResults, 'trace.zip')

    if (videos.length > 0) {
      await fs.mkdir(path.join(runRoot, 'video'), { recursive: true })
      await fs.copyFile(videos[0], path.join(runRoot, 'video', 'whole-flow.webm'))
    }
    if (traces.length > 0) {
      await fs.mkdir(path.join(runRoot, 'trace'), { recursive: true })
      await fs.copyFile(traces[0], path.join(runRoot, 'trace', 'whole-flow.zip'))
    }

    process.stdout.write(`\nSES proof summary: ${path.join(runRoot, 'summary.html')}\n`)
    process.stdout.write(`SES proof video:   ${path.join(runRoot, 'video', 'whole-flow.webm')}\n`)
  }
}
