import crypto from 'node:crypto'
import {
  CAPTAIN_EMAIL,
  type CapabilityMap,
  type CreatedArtifact,
  type DriverResponse,
  type ProofDriver,
  type ProofFixture,
  type ProofMode,
  type ProofRunContext,
} from './types'
import { SafetyViolation } from './guards'

const ALL_CAPABILITIES: CapabilityMap = {
  synthetic_intake_v1: { available: true },
  makesafe_board_proof_v1: { available: true },
  ses_pack_v3: { available: true },
  ses_draft_invoice_revision_v1: { available: true },
  ses_captain_delivery_v1: { available: true },
  synthetic_cleanup_v1: { available: true },
}

function artifactId(context: ProofRunContext, key: string): string {
  return `ses-proof-${crypto.createHash('sha256').update(`${context.runId}:${key}`).digest('hex').slice(0, 20)}`
}

function artifact(context: ProofRunContext, key: string, kind: CreatedArtifact['kind'], description: string, accountingStatus?: string): CreatedArtifact {
  return {
    id: artifactId(context, key),
    kind,
    marker: context.marker,
    description,
    ...(accountingStatus ? { accountingStatus } : {}),
  }
}

export class UnavailableDriver implements ProofDriver {
  readonly mode: ProofMode = 'live'

  async call(action: string): Promise<DriverResponse> {
    if (action !== 'proof_capabilities') {
      throw new Error('SES_PROOF_CONTROL_URL is not configured')
    }
    const reason = 'The live synthetic proof control plane is not configured. Set SES_PROOF_CONTROL_URL and SES_PROOF_API_KEY.'
    return {
      success: true,
      capabilities: Object.fromEntries(Object.keys(ALL_CAPABILITIES).map((key) => [key, { available: false, reason }])),
    }
  }
}

export class HttpProofDriver implements ProofDriver {
  readonly mode: ProofMode = 'live'

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly context: ProofRunContext,
  ) {
    const parsed = new URL(endpoint)
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !local) {
      throw new SafetyViolation('live proof control URL must use HTTPS unless it is localhost')
    }
    if (!apiKey) {
      throw new Error('SES_PROOF_API_KEY is required when SES_PROOF_CONTROL_URL is set')
    }
  }

  async call(action: string, payload: Record<string, unknown> = {}): Promise<DriverResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.apiKey,
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          action,
          proofRun: {
            runId: this.context.runId,
            marker: this.context.marker,
            seed: this.context.seed,
            allowedRecipient: CAPTAIN_EMAIL,
            accountingMode: 'DRAFT_ONLY',
          },
          payload,
        }),
        signal: controller.signal,
      })
      const text = await response.text()
      let result: DriverResponse
      try {
        result = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`${action} returned non-JSON HTTP ${response.status}`)
      }
      if (!response.ok) {
        throw new Error(`${action} returned HTTP ${response.status}: ${String(result.error || result.message || 'unknown error')}`)
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}

interface FixtureCard {
  fixtureId: string
  cardId: string
  jobId: string | null
  fate: ProofFixture['fate']
  stage: string
  blocker: string | null
  person: string
  reasonCode: string | null
  revisionCount: number
}

export class FixtureProofDriver implements ProofDriver {
  readonly mode: ProofMode = 'fixture'
  private readonly created = new Map<string, CreatedArtifact>()
  private readonly cards = new Map<string, FixtureCard>()
  private approvalCurrent = false
  private docketRevision = 1
  private cleaned = false

  constructor(private readonly context: ProofRunContext) {}

  private add(item: CreatedArtifact): CreatedArtifact {
    this.created.set(item.id, item)
    return item
  }

  private findPrimary(): FixtureCard {
    const card = [...this.cards.values()].find((item) => item.fate === 'confirmed_live_job')
    if (!card) throw new Error('fixture primary job does not exist')
    return card
  }

  async call(action: string, payload: Record<string, unknown> = {}): Promise<DriverResponse> {
    switch (action) {
      case 'proof_capabilities':
        return { success: true, capabilities: ALL_CAPABILITIES }

      case 'proof_synthetic_intake': {
        const fixtures = payload.fixtures as ProofFixture[]
        const base = Date.now() - 12_000
        const outcomes = fixtures.map((fixture, index) => {
          const source = this.add(artifact(this.context, `source:${fixture.fixtureId}`, 'source', `${fixture.fate} source email`))
          const document = this.add(artifact(this.context, `pdf:${fixture.fixtureId}`, 'document', `${fixture.fate} PDF`))
          const arrivedAt = new Date(base + index * 100).toISOString()
          const hugoVisibleAt = fixture.fate === 'accounted_non_work' ? null : new Date(base + 2_000 + index * 350).toISOString()
          let jobId: string | null = null
          let revisionCount: number | null = null
          let attachedToExistingJob = false
          let newJobCreated = false
          if (fixture.fate === 'reason_coded_exception') {
            const intakeCase = this.add(artifact(this.context, `case:${fixture.fixtureId}`, 'case', 'reason-coded intake exception'))
            this.cards.set(fixture.fixtureId, {
              fixtureId: fixture.fixtureId,
              cardId: intakeCase.id,
              jobId: null,
              fate: fixture.fate,
              stage: fixture.expected.boardStage || 'Intake Exception',
              blocker: fixture.expected.blocker,
              person: fixture.expected.person,
              reasonCode: fixture.expected.reasonCode,
              revisionCount: 0,
            })
          } else if (fixture.expected.boardStage) {
            const job = this.add(artifact(this.context, `job:${fixture.fixtureId}`, 'job', `${fixture.fate} synthetic job`))
            jobId = job.id
            revisionCount = fixture.fate === 'revision_existing_job' ? 2 : 1
            attachedToExistingJob = fixture.fate === 'revision_existing_job'
            newJobCreated = !attachedToExistingJob
            this.cards.set(fixture.fixtureId, {
              fixtureId: fixture.fixtureId,
              cardId: job.id,
              jobId,
              fate: fixture.fate,
              stage: fixture.expected.boardStage,
              blocker: fixture.expected.blocker,
              person: fixture.expected.person,
              reasonCode: fixture.expected.reasonCode,
              revisionCount,
            })
          }
          return {
            fixtureId: fixture.fixtureId,
            sourceId: source.id,
            documentId: document.id,
            fate: fixture.fate,
            reasonCode: fixture.expected.reasonCode,
            jobId,
            revisionCount,
            attachedToExistingJob,
            newJobCreated,
            arrivedAt,
            hugoVisibleAt,
            accounted: true,
          }
        })
        return { success: true, outcomes, nothingDisappeared: outcomes.length === fixtures.length, createdArtifacts: [...this.created.values()] }
      }

      case 'proof_read_board':
        return {
          success: true,
          visibleToHugo: true,
          source: 'makesafe_board',
          cards: [...this.cards.values()],
          syntheticCount: this.cards.size,
        }

      case 'proof_advance_board': {
        const card = this.findPrimary()
        card.stage = String(payload.targetStage)
        if (payload.person) card.person = String(payload.person)
        return { success: true, card: { ...card }, createdArtifacts: [] }
      }

      case 'proof_build_pack': {
        const pack = this.add(artifact(this.context, 'pack:complete', 'pack', 'family-correct synthetic document pack'))
        const report = this.add(artifact(this.context, 'report:complete', 'document', 'rendered completion report'))
        this.findPrimary().stage = 'Docs Ready'
        return {
          success: true,
          completed: { produced: true, packId: pack.id, artifacts: ['work_order', 'completion_report', 'photo_story', 'swms', 'invoice_proposal'] },
          incomplete: { produced: false, missing: ['trade_completion_signature', 'photo_story'], reasonCode: 'pack_evidence_incomplete' },
          createdArtifacts: [pack, report],
        }
      }

      case 'proof_plan_draft_invoice':
        return {
          success: true,
          plannedStatus: 'DRAFT',
          contact: `${this.context.marker} TEST CONTACT`,
          reference: `${this.context.marker} ${this.findPrimary().jobId}`,
          lines: [{ description: `${this.context.marker} synthetic confirmed rate`, quantity: 1, unitAmount: 275, rateConfirmed: true, rateSource: 'sealed_fixture_rate_v1' }],
        }

      case 'proof_create_draft_invoice': {
        const invoice = this.add(artifact(this.context, 'invoice:one', 'invoice', 'synthetic Xero invoice', 'DRAFT'))
        return { success: true, invoiceId: invoice.id, xeroStatus: 'DRAFT', createdArtifacts: [invoice] }
      }

      case 'proof_create_internal_approval': {
        const approvalNumber = this.docketRevision
        const approval = this.add(artifact(this.context, `approval:${approvalNumber}`, 'approval', `internal docket approval for revision ${approvalNumber}`))
        this.approvalCurrent = true
        return {
          success: true,
          approvalId: approval.id,
          approvalScope: 'docket_release_only',
          docketRevision: this.docketRevision,
          xeroStatus: 'DRAFT',
          current: true,
          createdArtifacts: [approval],
        }
      }

      case 'proof_revise_report': {
        const previous = this.docketRevision
        this.docketRevision += 1
        this.approvalCurrent = false
        const report = this.add(artifact(this.context, `report:revision:${this.docketRevision}`, 'document', `material report revision ${this.docketRevision}`))
        return {
          success: true,
          previousDocketRevision: previous,
          currentDocketRevision: this.docketRevision,
          previousApprovalCurrent: false,
          xeroStatus: 'DRAFT',
          createdArtifacts: [report],
        }
      }

      case 'proof_plan_send': {
        return {
          success: true,
          route: {
            to: [CAPTAIN_EMAIL],
            cc: [],
            bcc: [],
            subject: `[${this.context.marker}] ${String(payload.operatorBand)} pack and draft invoice`,
            releaseRevisionId: artifactId(this.context, `release:${String(payload.operatorBand)}`),
          },
          attachments: ['approved_pack', 'draft_invoice'],
          xeroStatus: 'DRAFT',
        }
      }

      case 'proof_execute_send': {
        if (!this.approvalCurrent) throw new Error('send refused because current docket revision is not approved')
        const operatorBand = String(payload.operatorBand)
        const mail = this.add(artifact(this.context, `mail:${operatorBand}`, 'mail', `${operatorBand} delivery to Captain inbox`))
        this.findPrimary().stage = 'Completed'
        return {
          success: true,
          messageId: mail.id,
          deliveredTo: CAPTAIN_EMAIL,
          executedRoute: { to: [CAPTAIN_EMAIL], cc: [], bcc: [] },
          xeroStatus: 'DRAFT',
          operatorBand,
          attachments: ['approved_pack', 'draft_invoice'],
          createdArtifacts: [mail],
        }
      }

      case 'proof_verify_delivery':
        return {
          success: true,
          delivered: true,
          inbox: CAPTAIN_EMAIL,
          messageId: String(payload.messageId),
          observedRecipients: { to: [CAPTAIN_EMAIL], cc: [], bcc: [] },
          markerFound: true,
          attachments: ['approved_pack', 'draft_invoice'],
          xeroStatus: 'DRAFT',
        }

      case 'proof_plan_cleanup':
        return { success: true, artifacts: [...this.created.values()], boardSyntheticCount: this.cards.size }

      case 'proof_execute_cleanup': {
        this.cleaned = true
        const cleanedArtifacts = [...this.created.values()].map((item) => ({
          id: item.id,
          kind: item.kind,
          outcome: item.kind === 'invoice' ? 'VOIDED' : 'REMOVED',
          finalState: item.kind === 'invoice' ? 'VOIDED' : 'REMOVED',
        }))
        this.cards.clear()
        return { success: true, cleanedArtifacts, createdArtifacts: [] }
      }

      case 'proof_verify_cleanup':
        return {
          success: true,
          boardSyntheticCount: this.cleaned ? 0 : this.cards.size,
          survivors: this.cleaned ? [] : [...this.created.values()],
          invoiceFinalStates: [...this.created.values()].filter((item) => item.kind === 'invoice').map((item) => ({ id: item.id, status: this.cleaned ? 'VOIDED' : 'DRAFT' })),
        }

      default:
        throw new Error(`fixture proof driver does not implement ${action}`)
    }
  }
}

export function createProofDriver(context: ProofRunContext): ProofDriver {
  if (context.mode === 'fixture') return new FixtureProofDriver(context)
  const endpoint = process.env.SES_PROOF_CONTROL_URL || ''
  if (!endpoint) return new UnavailableDriver()
  return new HttpProofDriver(endpoint, process.env.SES_PROOF_API_KEY || '', context)
}
