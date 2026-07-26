export const CAPTAIN_EMAIL = 'marninms98@gmail.com'
export const MARKER_PREFIX = 'SWG-SES-E2E-TEST-ONLY'
export const FIVE_MINUTES_MS = 5 * 60 * 1000

export type ProofMode = 'live' | 'fixture'
export type StageStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'NOT BUILT YET' | 'SIMULATED'
export type ArtifactKind = 'source' | 'case' | 'job' | 'document' | 'pack' | 'invoice' | 'approval' | 'mail'
export type CleanupOutcome = 'REMOVED' | 'VOIDED'

export interface CreatedArtifact {
  id: string
  kind: ArtifactKind
  marker: string
  accountingStatus?: string
  description?: string
}

export interface CleanedArtifact {
  id: string
  kind: ArtifactKind
  outcome: CleanupOutcome
  finalState: string
}

export interface Capability {
  available: boolean
  reason?: string
}

export interface CapabilityMap {
  synthetic_intake_v1: Capability
  makesafe_board_proof_v1: Capability
  ses_pack_v3: Capability
  ses_draft_invoice_revision_v1: Capability
  ses_captain_delivery_v1: Capability
  synthetic_cleanup_v1: Capability
}

export interface ProofFixture {
  fixtureId: string
  fate: 'confirmed_live_job' | 'blocked_live_job' | 'reason_coded_exception' | 'revision_existing_job' | 'accounted_non_work'
  subject: string
  workOrder: string
  expected: {
    boardStage: string | null
    blocker: string | null
    person: string
    reasonCode: string | null
  }
  emlPath: string
  pdfPath: string
  emlBase64: string
  pdfBase64: string
  sha256: {
    eml: string
    pdf: string
  }
}

export interface StageCopy {
  title: string
  whatWeDid: string
  correctMeans: string
  whatYouSee: string
  howWeKnow: string
}

export interface Metric {
  label: string
  value: string
  threshold?: string
}

export interface StageResult {
  number: number
  slug: string
  status: StageStatus
  copy: StageCopy
  detail: string
  metrics: Metric[]
  screenshot?: string
  surfaceScreenshots: string[]
  startedAt?: string
  finishedAt?: string
  error?: string
  raw?: unknown
}

export interface RunSummary {
  schemaVersion: 1
  runId: string
  marker: string
  seed: string
  mode: ProofMode
  startedAt: string
  finishedAt?: string
  captainRecipient: string
  overall: 'RUNNING' | 'PASS' | 'FAIL' | 'HARNESS SELF-TEST ONLY'
  overallDetail: string
  stages: StageResult[]
  artifacts: {
    created: CreatedArtifact[]
    cleaned: CleanedArtifact[]
    survivors: CreatedArtifact[]
  }
  safety: {
    onlyAllowedRecipient: string
    accountingWriteStatus: 'DRAFT only'
    markerPrefix: string
    cleanupRequired: true
  }
}

export interface ProofRunContext {
  runId: string
  marker: string
  seed: string
  mode: ProofMode
  runRoot: string
}

export interface RecipientEnvelope {
  to: string[]
  cc: string[]
  bcc: string[]
}

export interface ResolvedRoute extends RecipientEnvelope {
  subject: string
  releaseRevisionId: string
}

export interface DriverResponse {
  success?: boolean
  createdArtifacts?: CreatedArtifact[]
  evidenceUrls?: Array<{ label: string; url: string }>
  [key: string]: unknown
}

export interface ProofDriver {
  readonly mode: ProofMode
  call(action: string, payload?: Record<string, unknown>): Promise<DriverResponse>
}
