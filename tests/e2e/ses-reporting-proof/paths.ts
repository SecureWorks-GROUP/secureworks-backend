import path from 'node:path'

export const HARNESS_ROOT = __dirname
export const NPM_ROOT = path.resolve(HARNESS_ROOT, '..')
export const REPO_ROOT = path.resolve(NPM_ROOT, '..', '..')

export function resolveRunRoot(runId: string): string {
  return path.resolve(process.env.SES_PROOF_RUN_ROOT || path.join(REPO_ROOT, 'artifacts', 'ses-reporting-proof', runId))
}
