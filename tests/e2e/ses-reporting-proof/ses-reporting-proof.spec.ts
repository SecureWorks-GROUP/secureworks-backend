import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CAPTAIN_EMAIL,
  FIVE_MINUTES_MS,
  MARKER_PREFIX,
  type CapabilityMap,
  type CleanedArtifact,
  type DriverResponse,
  type ProofFixture,
  type ProofMode,
  type ProofRunContext,
  type ResolvedRoute,
  type RunSummary,
  type StageResult,
} from './types'
import { generateFixtures } from './fixtures'
import { createProofDriver } from './drivers'
import { ArtifactRegistry, SafetyViolation, assertCaptainOnlyEnvelope, assertCaptainOnlyRoute, assertDraftAccounting, assertNoDeclaredArtifacts } from './guards'
import { renderCockpit, renderFinalSummary, STAGE_COPY } from './cockpit'
import { resolveRunRoot } from './paths'

const SLUGS = ['intake', 'latency', 'board-truth', 'pack', 'money', 'send', 'cleanup']

const REQUIRED_BOARD_STAGES = [
  'New / Unallocated',
  'Allocated / Waiting on Trade',
  'Trade Report In',
  'Docs Ready',
  'Completed',
  'Archive',
]

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object`)
  return value as Record<string, unknown>
}

function asArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`)
  return value.map((item, index) => asRecord(item, `${label}[${index}]`))
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} expected ${expected}, received ${String(value)}`)
}

function exactBoolean(value: unknown, expected: boolean, label: string): void {
  if (value !== expected) throw new Error(`${label} expected ${expected}, received ${String(value)}`)
}

function requireStringMembers(value: unknown, expected: string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} was not a string array`)
  for (const member of expected) {
    if (!value.includes(member)) throw new Error(`${label} did not include ${member}`)
  }
  return value
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function isSuccessful(stage: StageResult): boolean {
  return stage.status === 'PASS' || stage.status === 'SIMULATED'
}

function missingCapability(capabilities: CapabilityMap | null, key: keyof CapabilityMap): string | null {
  const capability = capabilities?.[key]
  if (capability?.available) return null
  return capability?.reason || `The product does not expose ${key}.`
}

test.describe.configure({ mode: 'serial' })

test('SES Reporting whole synthetic voyage', async ({ page }) => {
  const mode = (process.env.SES_PROOF_MODE || 'live') as ProofMode
  if (!['live', 'fixture'].includes(mode)) throw new Error(`Unsupported SES_PROOF_MODE ${mode}`)
  const runId = process.env.SES_PROOF_RUN_ID || `unsafe-direct-${Date.now()}`
  const runRoot = resolveRunRoot(runId)
  const seed = process.env.SES_PROOF_SEED || 'captain-watch-v1'
  const context: ProofRunContext = {
    runId,
    runRoot,
    seed,
    mode,
    marker: `${MARKER_PREFIX}-${runId.toUpperCase()}`,
  }
  await fs.mkdir(path.join(runRoot, 'screenshots'), { recursive: true })

  const summary: RunSummary = {
    schemaVersion: 1,
    runId,
    marker: context.marker,
    seed,
    mode,
    startedAt: new Date().toISOString(),
    captainRecipient: CAPTAIN_EMAIL,
    overall: 'RUNNING',
    overallDetail: 'The seven proof stages are running.',
    stages: STAGE_COPY.map((copy, index) => ({
      number: index + 1,
      slug: SLUGS[index],
      status: 'PENDING',
      copy,
      detail: 'Waiting for this stage.',
      metrics: [],
      surfaceScreenshots: [],
    })),
    artifacts: { created: [], cleaned: [], survivors: [] },
    safety: {
      onlyAllowedRecipient: CAPTAIN_EMAIL,
      accountingWriteStatus: 'DRAFT only',
      markerPrefix: MARKER_PREFIX,
      cleanupRequired: true,
    },
  }

  const registry = new ArtifactRegistry(context.marker)
  let driver: ReturnType<typeof createProofDriver> | null = null
  let capabilities: CapabilityMap | null = null
  let fatalError: Error | null = null
  let intakeOutcomes: Array<Record<string, unknown>> = []
  let fixtures: ProofFixture[] = []
  let primaryJobId = ''
  const boardSequence: string[] = []

  try {
    driver = createProofDriver(context)
  } catch (error) {
    fatalError = error as Error
  }

  async function renderStage(stage: StageResult): Promise<void> {
    await page.setContent(renderCockpit(summary, stage.number), { waitUntil: 'load' })
    await page.waitForTimeout(450)
  }

  async function captureStage(stage: StageResult): Promise<void> {
    const filename = `${String(stage.number).padStart(2, '0')}-${stage.slug}.png`
    await renderStage(stage)
    await page.screenshot({ path: path.join(runRoot, 'screenshots', filename), fullPage: true })
    stage.screenshot = `screenshots/${filename}`
  }

  async function captureSurfaces(stage: StageResult, response: DriverResponse): Promise<void> {
    if (!Array.isArray(response.evidenceUrls)) return
    for (let index = 0; index < response.evidenceUrls.length; index += 1) {
      const evidence = response.evidenceUrls[index]
      const url = new URL(evidence.url)
      const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !local)) {
        throw new SafetyViolation(`evidence URL ${url.toString()} is not HTTPS or localhost`)
      }
      for (const name of url.searchParams.keys()) {
        if (/token|key|auth|secret/i.test(name)) throw new SafetyViolation(`evidence URL includes credential-like query parameter ${name}`)
      }
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(700)
      const filename = `${String(stage.number).padStart(2, '0')}-${stage.slug}-surface-${index + 1}.png`
      await page.screenshot({ path: path.join(runRoot, 'screenshots', filename), fullPage: true })
      stage.surfaceScreenshots.push(`screenshots/${filename}`)
    }
  }

  async function mutate(action: string, payload: Record<string, unknown> = {}): Promise<DriverResponse> {
    if (!driver) throw fatalError || new Error('proof driver is unavailable')
    const cleanupUnavailable = missingCapability(capabilities, 'synthetic_cleanup_v1')
    if (cleanupUnavailable) {
      throw new SafetyViolation(`${action} refused before any product write because synthetic_cleanup_v1 is unavailable. ${cleanupUnavailable}`)
    }
    const response = await driver.call(action, payload)
    registry.register(response, action)
    summary.artifacts.created = registry.list()
    return response
  }

  async function readOnly(action: string, payload: Record<string, unknown> = {}): Promise<DriverResponse> {
    if (!driver) throw fatalError || new Error('proof driver is unavailable')
    const response = await driver.call(action, payload)
    assertNoDeclaredArtifacts(response, action)
    return response
  }

  async function runStage(
    stage: StageResult,
    work: () => Promise<{ notBuilt?: string } | void>,
    options: { cleanup?: boolean } = {},
  ): Promise<void> {
    await test.step(`${stage.number}. ${stage.copy.title}`, async () => {
      stage.startedAt = new Date().toISOString()
      stage.status = 'RUNNING'
      stage.detail = 'This stage is in progress.'
      await renderStage(stage)
      try {
        if (fatalError && !options.cleanup) throw new Error(`Run stopped before this stage: ${fatalError.message}`)
        const result = await work()
        if (result?.notBuilt) {
          stage.status = 'NOT BUILT YET'
          stage.detail = result.notBuilt
        } else {
          stage.status = mode === 'fixture' ? 'SIMULATED' : 'PASS'
        }
      } catch (error) {
        stage.status = 'FAIL'
        stage.error = (error as Error).message
        stage.detail = `This stage failed: ${(error as Error).message}`
        if (!options.cleanup) fatalError = error as Error
      } finally {
        stage.finishedAt = new Date().toISOString()
        announceStage(stage)
        await captureStage(stage)
      }
    })
  }

  function announceStage(stage: StageResult): void {
    if (stage.status === 'NOT BUILT YET') {
      process.stdout.write(`\nNOT BUILT YET — stage ${stage.number}. ${stage.copy.title}: ${stage.detail}\n`)
    } else if (stage.status === 'FAIL') {
      process.stdout.write(`\nFAIL — stage ${stage.number}. ${stage.copy.title}: ${stage.error}\n`)
    }
  }

  fixtures = await generateFixtures(context)

  await runStage(summary.stages[0], async () => {
    if (!driver) throw fatalError || new Error('proof driver is unavailable')
    const capabilityResponse = await readOnly('proof_capabilities')
    capabilities = asRecord(capabilityResponse.capabilities, 'capabilities') as unknown as CapabilityMap
    const intakeUnavailable = missingCapability(capabilities, 'synthetic_intake_v1')
    const cleanupUnavailable = missingCapability(capabilities, 'synthetic_cleanup_v1')
    if (intakeUnavailable || cleanupUnavailable) {
      summary.stages[0].metrics = [
        { label: 'Fates exercised', value: '0 / 5', threshold: 'Correct is 5 / 5' },
        { label: 'Sources disappeared', value: 'Unknown', threshold: 'Correct is 0' },
        { label: 'Product artifacts created', value: '0', threshold: 'Nothing is created without cleanup' },
      ]
      const reason = intakeUnavailable
        ? intakeUnavailable
        : `Cleanup capability synthetic_cleanup_v1 is required before the first product write, so the voyage refused to create anything it could not remove. ${cleanupUnavailable}`
      return { notBuilt: `NOT BUILT YET. ${reason} The harness generated all five deterministic EML and PDF fixtures, created no product artifact, and did not claim that product intake worked.` }
    }

    const fixturePayload = fixtures.map(({ emlPath: _emlPath, pdfPath: _pdfPath, ...fixture }) => fixture)
    const response = await mutate('proof_synthetic_intake', { fixtures: fixturePayload })
    await captureSurfaces(summary.stages[0], response)
    intakeOutcomes = asArray(response.outcomes, 'intake outcomes')
    if (intakeOutcomes.length !== 5) throw new Error(`intake returned ${intakeOutcomes.length} outcomes for five sources`)
    exactBoolean(response.nothingDisappeared, true, 'nothingDisappeared')

    const observedIds = new Set(intakeOutcomes.map((item) => String(item.fixtureId)))
    for (const fixture of fixtures) {
      if (!observedIds.has(fixture.fixtureId)) throw new Error(`source ${fixture.fixtureId} disappeared from intake outcomes`)
      const outcome = intakeOutcomes.find((item) => item.fixtureId === fixture.fixtureId)!
      exactString(outcome.fate, fixture.fate, `${fixture.fixtureId} fate`)
      exactBoolean(outcome.accounted, true, `${fixture.fixtureId} accounted`)
      if ((outcome.reasonCode ?? null) !== fixture.expected.reasonCode) {
        throw new Error(`${fixture.fixtureId} reason expected ${String(fixture.expected.reasonCode)}, received ${String(outcome.reasonCode)}`)
      }
      if (fixture.fate === 'revision_existing_job') {
        exactBoolean(outcome.attachedToExistingJob, true, 'revision attachedToExistingJob')
        exactBoolean(outcome.newJobCreated, false, 'revision newJobCreated')
        if (Number(outcome.revisionCount) !== 2) throw new Error(`revision count expected 2, received ${String(outcome.revisionCount)}`)
      }
      if (fixture.fate === 'reason_coded_exception' && outcome.jobId !== null) throw new Error('reason-coded exception minted a job')
      if (fixture.fate === 'accounted_non_work' && outcome.jobId !== null) throw new Error('accounted non-work minted a job')
    }
    primaryJobId = String(intakeOutcomes.find((item) => item.fate === 'confirmed_live_job')?.jobId || '')
    if (!primaryJobId) throw new Error('confirmed live job did not return a job ID')

    summary.stages[0].detail = 'Five marked sources entered. The clean instruction became a job, the incomplete instruction stayed visible and blocked, the ambiguous instruction became a reason-coded exception, the corrected PDF attached as revision two, and the own-domain copy was accounted as non-work. Nothing disappeared.'
    summary.stages[0].metrics = [
      { label: 'Fates accounted', value: '5 / 5', threshold: 'Correct is 5 / 5' },
      { label: 'Reason-coded exceptions', value: '1', threshold: 'Correct is 1' },
      { label: 'Existing-lineage revisions', value: '1', threshold: 'Correct is 1' },
      { label: 'Sources disappeared', value: '0', threshold: 'Correct is 0' },
    ]
    summary.stages[0].raw = intakeOutcomes
  })

  await runStage(summary.stages[1], async () => {
    if (!isSuccessful(summary.stages[0])) {
      return { notBuilt: `NOT BUILT YET. Latency cannot be proven because intake did not produce Hugo-visible timestamps. Intake status: ${summary.stages[0].status}.` }
    }
    const eligible = intakeOutcomes.filter((outcome) => outcome.fate !== 'accounted_non_work')
    const missingVisibility = eligible.filter((outcome) => !outcome.hugoVisibleAt)
    if (missingVisibility.length > 0) {
      return {
        notBuilt: `NOT BUILT YET. Authorised Board route seam did not confirm Hugo-visible timestamps for ${missingVisibility.map((item) => item.fixtureId).join(', ')}. Fixture clocks alone are not live five-minute SLA evidence; the 90-second client cache remains stated/bypassed, not measured.`,
      }
    }
    const elapsed = eligible.map((outcome) => {
      const arrivedAt = Date.parse(String(outcome.arrivedAt || ''))
      const visibleAt = Date.parse(String(outcome.hugoVisibleAt || ''))
      if (!Number.isFinite(arrivedAt) || !Number.isFinite(visibleAt)) throw new Error(`${String(outcome.fixtureId)} lacks valid arrival or Hugo-visible timestamp`)
      const duration = visibleAt - arrivedAt
      if (duration < 0) throw new Error(`${String(outcome.fixtureId)} became visible before recorded arrival`)
      return duration
    })
    const max = Math.max(...elapsed)
    const p95 = percentile95(elapsed)
    if (max > FIVE_MINUTES_MS) throw new Error(`arrival-to-Hugo maximum was ${(max / 1000).toFixed(1)} seconds, above the 300 second law`)

    summary.stages[1].detail = mode === 'fixture'
      ? `Fixture timing only: arrival to authorised Board route generated_at. Maximum ${(max / 1000).toFixed(1)} seconds and P95 ${(p95 / 1000).toFixed(1)} seconds stay inside 300 seconds by construction. This is NOT the live email-to-Board five-minute SLA. The 90-second Trade client cache is bypassed, not measured.`
      : `Timing starts at recorded message arrival. Four operationally visible outcomes were measured. Maximum ${(max / 1000).toFixed(1)} seconds and P95 ${(p95 / 1000).toFixed(1)} seconds are both inside the sealed 300 second law.`
    summary.stages[1].metrics = [
      { label: 'Maximum arrival to Hugo', value: `${(max / 1000).toFixed(1)} s`, threshold: 'Must be at most 300 s' },
      { label: 'P95 arrival to Hugo', value: `${(p95 / 1000).toFixed(1)} s`, threshold: 'Reported, not substituted for max' },
      { label: 'Eligible outcomes measured', value: String(elapsed.length), threshold: 'Correct is 4' },
      { label: 'Internal midpoint used', value: 'No', threshold: 'Arrival is the start' },
      { label: 'Live five-minute SLA claim', value: 'No', threshold: 'Fixture/route clocks only unless live proof' },
      { label: '90s client cache', value: 'bypassed, not measured', threshold: 'Stated or bypassed' },
    ]
  })

  await runStage(summary.stages[2], async () => {
    const unavailable = missingCapability(capabilities, 'makesafe_board_proof_v1')
    if (unavailable || !isSuccessful(summary.stages[0])) {
      return { notBuilt: `NOT BUILT YET. ${unavailable || 'Board proof depends on successful intake.'}` }
    }
    if (!driver) throw new Error('proof driver is unavailable')
    const board = await readOnly('proof_read_board', { marker: context.marker })
    await captureSurfaces(summary.stages[2], board)
    if (board.visibleToHugo !== true || board.source !== 'makesafe_board') {
      return {
        notBuilt: `NOT BUILT YET. Authorised makesafe_board trade route seam did not confirm containment of the fixture job identities (${String(board.reason || board.evidence || 'visibleToHugo was not true')}). In-memory cards alone are non-evidence.`,
      }
    }
    exactBoolean(board.visibleToHugo, true, 'board visibleToHugo')
    exactString(board.source, 'makesafe_board', 'board source')
    if (board.jobsQueried !== true && mode === 'fixture') {
      return { notBuilt: 'NOT BUILT YET. Board seam response did not prove a jobs-table read from the canonical loader.' }
    }
    const cards = asArray(board.cards, 'board cards')

    for (const fixture of fixtures.filter((item) => item.expected.boardStage)) {
      const card = cards.find((item) => item.fixtureId === fixture.fixtureId)
      if (!card) throw new Error(`${fixture.fixtureId} is absent from Hugo board truth`)
      exactString(card.stage, fixture.expected.boardStage!, `${fixture.fixtureId} stage`)
      exactString(card.person, fixture.expected.person, `${fixture.fixtureId} person`)
      if ((card.blocker ?? null) !== fixture.expected.blocker) throw new Error(`${fixture.fixtureId} blocker mismatch`)
      if ((card.reasonCode ?? null) !== fixture.expected.reasonCode) throw new Error(`${fixture.fixtureId} reason code mismatch`)
      if (fixture.fate === 'revision_existing_job' && Number(card.revisionCount) !== 2) throw new Error('revision card did not retain revision count two')
    }

    boardSequence.push('New / Unallocated')
    for (const targetStage of ['Allocated / Waiting on Trade', 'Trade Report In']) {
      const transition = await mutate('proof_advance_board', { jobId: primaryJobId, targetStage, person: targetStage === 'Allocated / Waiting on Trade' ? 'Assigned Trade' : 'Hugo' })
      const card = asRecord(transition.card, `${targetStage} transition card`)
      exactString(card.stage, targetStage, 'read-back board stage')
      boardSequence.push(targetStage)
    }

    summary.stages[2].detail = 'Hugo can see the canonical cards. The clean lineage moved from New / Unallocated to Allocated / Waiting on Trade and then Trade Report In. The blocker, exception reason, person and revision count remained truthful.'
    summary.stages[2].metrics = [
      { label: 'Required cards visible', value: '4 / 4', threshold: 'Clean, blocked, exception, revision' },
      { label: 'Stages observed so far', value: `${boardSequence.length} / 6`, threshold: 'Later proof adds Docs Ready, Completed, Archive' },
      { label: 'Wrong blockers or people', value: '0', threshold: 'Correct is 0' },
      { label: 'Canonical read source', value: 'makesafe_board' },
    ]
  })

  await runStage(summary.stages[3], async () => {
    const unavailable = missingCapability(capabilities, 'ses_pack_v3')
    if (unavailable || !isSuccessful(summary.stages[2])) {
      summary.stages[3].metrics = [
        { label: 'Complete packs produced', value: '0 / 1', threshold: 'Feature not available' },
        { label: 'Incomplete packs refused', value: '0 / 1', threshold: 'Feature not available' },
      ]
      return { notBuilt: `NOT BUILT YET. ${unavailable || 'Pack proof depends on board truth.'}` }
    }
    const blockedFixture = fixtures.find((item) => item.fate === 'blocked_live_job')!
    const blockedJobId = String(intakeOutcomes.find((item) => item.fixtureId === blockedFixture.fixtureId)?.jobId || '')
    const response = await mutate('proof_build_pack', { completedJobId: primaryJobId, incompleteJobId: blockedJobId })
    await captureSurfaces(summary.stages[3], response)
    const completed = asRecord(response.completed, 'completed pack result')
    const incomplete = asRecord(response.incomplete, 'incomplete pack result')
    exactBoolean(completed.produced, true, 'completed pack produced')
    if (!completed.packId) throw new Error('completed pack has no persistent pack ID')
    exactBoolean(incomplete.produced, false, 'incomplete pack produced')
    if (!Array.isArray(incomplete.missing) || incomplete.missing.length === 0) throw new Error('incomplete pack did not state what is missing')
    exactString(incomplete.reasonCode, 'pack_evidence_incomplete', 'incomplete pack reason')

    if (!driver) throw new Error('proof driver is unavailable')
    const board = await readOnly('proof_read_board', { marker: context.marker })
    const card = asArray(board.cards, 'board cards').find((item) => item.jobId === primaryJobId)
    if (!card) throw new Error('packed job disappeared from board')
    exactString(card.stage, 'Docs Ready', 'packed job stage')
    boardSequence.push('Docs Ready')

    summary.stages[3].detail = `The complete synthetic job produced pack ${String(completed.packId)}. The intentionally incomplete job produced no pack and named ${incomplete.missing.join(', ')} as missing.`
    summary.stages[3].metrics = [
      { label: 'Complete packs produced', value: '1 / 1', threshold: 'Correct is 1 / 1' },
      { label: 'Incomplete packs refused', value: '1 / 1', threshold: 'Correct is 1 / 1' },
      { label: 'Missing items named', value: String(incomplete.missing.length), threshold: 'Must be precise and non-zero' },
      { label: 'Board result', value: 'Docs Ready' },
    ]
  })

  await runStage(summary.stages[4], async () => {
    const unavailable = missingCapability(capabilities, 'ses_draft_invoice_revision_v1')
    if (unavailable || !isSuccessful(summary.stages[3])) {
      summary.stages[4].metrics = [
        { label: 'Draft invoices created', value: '0 / 1', threshold: 'Feature not available' },
        { label: 'Stale approvals invalidated', value: '0 / 1', threshold: 'Feature not available' },
      ]
      return { notBuilt: `NOT BUILT YET. ${unavailable || 'Money proof depends on a completed pack.'}` }
    }
    if (!driver) throw new Error('proof driver is unavailable')
    const plan = await readOnly('proof_plan_draft_invoice', { jobId: primaryJobId, marker: context.marker })
    assertDraftAccounting(plan.plannedStatus, 'invoice preflight')
    const lines = asArray(plan.lines, 'invoice plan lines')
    if (lines.length === 0) throw new Error('invoice preflight returned no confirmed-rate lines')
    if (!String(plan.contact || '').includes(context.marker) || !String(plan.reference || '').includes(context.marker)) {
      throw new SafetyViolation('invoice preflight contact and reference must carry the exact synthetic marker')
    }
    for (const [index, line] of lines.entries()) {
      exactBoolean(line.rateConfirmed, true, `invoice line ${index} confirmed rate`)
      if (!line.rateSource) throw new Error(`invoice line ${index} has no confirmed rate source`)
      if (!String(line.description || '').includes(context.marker)) throw new SafetyViolation(`invoice line ${index} does not carry the synthetic marker`)
    }

    const invoice = await mutate('proof_create_draft_invoice', { jobId: primaryJobId, marker: context.marker, expectedStatus: 'DRAFT' })
    assertDraftAccounting(invoice.xeroStatus, 'invoice creation result')
    const firstApproval = await mutate('proof_create_internal_approval', { jobId: primaryJobId, action: 'docket_release', expectedXeroStatus: 'DRAFT' })
    assertDraftAccounting(firstApproval.xeroStatus, 'first internal approval')
    exactBoolean(firstApproval.current, true, 'first approval current')
    const previousRevision = Number(firstApproval.docketRevision)

    const revision = await mutate('proof_revise_report', { jobId: primaryJobId, materialChange: `${context.marker} corrected synthetic report detail` })
    assertDraftAccounting(revision.xeroStatus, 'report revision result')
    exactBoolean(revision.previousApprovalCurrent, false, 'old approval after material report change')
    const currentRevision = Number(revision.currentDocketRevision)
    if (!Number.isFinite(previousRevision) || !Number.isFinite(currentRevision) || currentRevision <= previousRevision) {
      throw new Error(`report revision did not advance from ${previousRevision} to a newer revision`)
    }

    const secondApproval = await mutate('proof_create_internal_approval', { jobId: primaryJobId, action: 'docket_release', docketRevision: currentRevision, expectedXeroStatus: 'DRAFT' })
    assertDraftAccounting(secondApproval.xeroStatus, 'second internal approval')
    exactBoolean(secondApproval.current, true, 'second approval current')
    if (Number(secondApproval.docketRevision) !== currentRevision) throw new Error('fresh approval did not bind the current docket revision')
    await captureSurfaces(summary.stages[4], secondApproval)

    summary.stages[4].detail = `One marked invoice was created in DRAFT from ${lines.length} confirmed-rate line. Internal approval bound revision ${previousRevision}. The report change advanced the docket to revision ${currentRevision}, expired the old approval, and required a fresh approval. Xero remained DRAFT throughout.`
    summary.stages[4].metrics = [
      { label: 'Draft invoices created', value: '1', threshold: 'Must remain DRAFT' },
      { label: 'Confirmed-rate lines', value: String(lines.length), threshold: 'Must be non-zero' },
      { label: 'Old approval after revision', value: 'Expired', threshold: 'Correct is Expired' },
      { label: 'Fresh approvals required', value: '1', threshold: 'Correct is 1' },
    ]
  })

  await runStage(summary.stages[5], async () => {
    const unavailable = missingCapability(capabilities, 'ses_captain_delivery_v1')
    if (unavailable || !isSuccessful(summary.stages[4])) {
      summary.stages[5].metrics = [
        { label: 'Captain inbox deliveries', value: '0 / 2', threshold: 'Feature not available' },
        { label: 'Non-Captain recipients', value: '0', threshold: 'Hard safety gate' },
      ]
      return { notBuilt: `NOT BUILT YET. ${unavailable || 'Send proof depends on a current approved docket and draft invoice.'}` }
    }
    if (!driver) throw new Error('proof driver is unavailable')
    const messageIds: string[] = []
    for (const operatorBand of ['shaun_safe_today', 'marnin_run_with_care']) {
      const plan = await readOnly('proof_plan_send', {
        jobId: primaryJobId,
        operatorBand,
        requestedRecipient: CAPTAIN_EMAIL,
        marker: context.marker,
      })
      assertDraftAccounting(plan.xeroStatus, `${operatorBand} send preflight`)
      const route = asRecord(plan.route, `${operatorBand} route`) as unknown as ResolvedRoute
      assertCaptainOnlyRoute(route)
      if (!route.subject.includes(context.marker)) throw new SafetyViolation(`${operatorBand} send subject does not carry the exact synthetic marker`)
      const plannedAttachments = requireStringMembers(plan.attachments, ['approved_pack', 'draft_invoice'], `${operatorBand} planned attachments`)

      const sent = await mutate('proof_execute_send', {
        jobId: primaryJobId,
        operatorBand,
        releaseRevisionId: route.releaseRevisionId,
        allowedRecipient: CAPTAIN_EMAIL,
        marker: context.marker,
        attachments: plannedAttachments,
      })
      assertDraftAccounting(sent.xeroStatus, `${operatorBand} send result`)
      assertCaptainOnlyEnvelope(sent.executedRoute, `${operatorBand} executed transport envelope`)
      exactString(sent.deliveredTo, CAPTAIN_EMAIL, `${operatorBand} deliveredTo`)
      requireStringMembers(sent.attachments, ['approved_pack', 'draft_invoice'], `${operatorBand} sent attachments`)
      const messageId = String(sent.messageId || '')
      if (!messageId) throw new Error(`${operatorBand} send returned no message ID`)
      const delivery = await readOnly('proof_verify_delivery', { messageId, recipient: CAPTAIN_EMAIL, marker: context.marker })
      assertCaptainOnlyEnvelope(delivery.observedRecipients, `${operatorBand} delivered message headers`)
      exactBoolean(delivery.delivered, true, `${operatorBand} inbox delivery`)
      exactString(delivery.inbox, CAPTAIN_EMAIL, `${operatorBand} inbox`)
      exactString(delivery.messageId, messageId, `${operatorBand} delivery message ID`)
      exactBoolean(delivery.markerFound, true, `${operatorBand} delivery marker`)
      assertDraftAccounting(delivery.xeroStatus, `${operatorBand} delivered invoice status`)
      requireStringMembers(delivery.attachments, ['approved_pack', 'draft_invoice'], `${operatorBand} delivered attachments`)
      await captureSurfaces(summary.stages[5], delivery)
      messageIds.push(messageId)
    }
    if (new Set(messageIds).size !== 2) throw new Error('the two operator-band sends did not produce two distinct message IDs')

    const board = await readOnly('proof_read_board', { marker: context.marker })
    const card = asArray(board.cards, 'board cards').find((item) => item.jobId === primaryJobId)
    if (!card) throw new Error('sent job disappeared from board')
    exactString(card.stage, 'Completed', 'sent job stage')
    boardSequence.push('Completed')

    summary.stages[5].detail = `Two distinct marked messages landed in ${CAPTAIN_EMAIL}: one Shaun safe-today voyage and one Marnin run-with-care voyage. Each route was locked to one To address with empty Cc and Bcc before transport, the envelope actually used by the send was checked again against the same lock, and the delivered message headers were read back and checked a third time. The accounting object remained DRAFT.`
    summary.stages[5].metrics = [
      { label: 'Captain inbox deliveries', value: '2 / 2', threshold: 'Correct is 2 / 2' },
      { label: 'Envelope checks per send', value: '3', threshold: 'Planned, executed, delivered' },
      { label: 'Shaun safe-today runs', value: '1' },
      { label: 'Marnin run-with-care runs', value: '1' },
      { label: 'Non-Captain recipients', value: '0', threshold: 'Hard safety gate' },
    ]
  })

  await runStage(summary.stages[6], async () => {
    const unavailable = missingCapability(capabilities, 'synthetic_cleanup_v1')
    if (unavailable) {
      summary.artifacts.survivors = registry.list()
      summary.stages[6].metrics = [
        { label: 'Created artifacts', value: String(registry.list().length) },
        { label: 'Cleaned artifacts', value: '0', threshold: 'Must equal created' },
        { label: 'Survivors', value: String(registry.list().length), threshold: 'Must be 0' },
      ]
      return { notBuilt: `NOT BUILT YET. ${unavailable} Cleanup is mandatory, so the whole run cannot pass.` }
    }
    if (!driver) throw fatalError || new Error('proof driver is unavailable for mandatory cleanup')

    let preCleanupError: Error | null = null
    if (isSuccessful(summary.stages[5])) {
      try {
        const archive = await mutate('proof_advance_board', { jobId: primaryJobId, targetStage: 'Archive', person: 'System' })
        exactString(asRecord(archive.card, 'archive transition card').stage, 'Archive', 'archive stage')
        boardSequence.push('Archive')
      } catch (error) {
        preCleanupError = error as Error
      }
    }

    try {
      const plan = await readOnly('proof_plan_cleanup', { marker: context.marker, registeredArtifacts: registry.list() })
      const planned = asArray(plan.artifacts, 'cleanup plan artifacts')
      const plannedIds = new Set(planned.map((item) => String(item.id)))
      const omitted = registry.list().filter((item) => !plannedIds.has(item.id))
      if (omitted.length > 0) preCleanupError = new SafetyViolation(`cleanup plan omitted ${omitted.map((item) => item.id).join(', ')}`)
    } catch (error) {
      preCleanupError = error as Error
    }

    let executeError: Error | null = null
    let cleaned: CleanedArtifact[] = []
    try {
      const cleanup = await mutate('proof_execute_cleanup', { marker: context.marker, registeredArtifacts: registry.list() })
      cleaned = asArray(cleanup.cleanedArtifacts, 'cleaned artifacts') as unknown as CleanedArtifact[]
    } catch (error) {
      executeError = error as Error
    }

    let verifyError: Error | null = null
    try {
      const verification = await readOnly('proof_verify_cleanup', { marker: context.marker, registeredArtifacts: registry.list() })
      const survivors = Array.isArray(verification.survivors) ? verification.survivors as typeof summary.artifacts.survivors : []
      summary.artifacts.cleaned = cleaned
      summary.artifacts.survivors = survivors
      registry.verifyCleanup(cleaned, survivors)
      if (Number(verification.boardSyntheticCount) !== 0) throw new SafetyViolation(`board still contains ${String(verification.boardSyntheticCount)} synthetic rows`)
      const invoiceStates = asArray(verification.invoiceFinalStates, 'invoice final states')
      for (const invoice of invoiceStates) exactString(String(invoice.status).toUpperCase(), 'VOIDED', `invoice ${String(invoice.id)} final status`)
      await captureSurfaces(summary.stages[6], verification)
    } catch (error) {
      verifyError = error as Error
    }

    if (executeError) throw executeError
    if (verifyError) throw verifyError
    if (preCleanupError) throw preCleanupError

    const voided = cleaned.filter((item) => item.outcome === 'VOIDED').length
    summary.stages[6].detail = `The registry recorded ${registry.list().length} synthetic product artifacts. Cleanup reconciled all ${cleaned.length}, voided ${voided} draft invoice, removed the synthetic messages and jobs, and read back zero marked board rows and zero survivors.`
    summary.stages[6].metrics = [
      { label: 'Created artifacts', value: String(registry.list().length) },
      { label: 'Cleaned artifacts', value: String(cleaned.length), threshold: 'Must equal created' },
      { label: 'Invoices voided', value: String(voided), threshold: 'Every test invoice' },
      { label: 'Board survivors', value: '0', threshold: 'Correct is 0' },
    ]
  }, { cleanup: true })

  if (isSuccessful(summary.stages[2])) {
    const missingTransitions = REQUIRED_BOARD_STAGES.filter((stageName) => !boardSequence.includes(stageName))
    summary.stages[2].metrics = [
      { label: 'Required cards visible', value: '4 / 4', threshold: 'Clean, blocked, exception, revision' },
      { label: 'Stages observed', value: `${boardSequence.length} / 6`, threshold: 'New through Archive' },
      { label: 'Wrong blockers or people', value: '0', threshold: 'Correct is 0' },
      { label: 'Canonical read source', value: 'makesafe_board' },
    ]
    if (missingTransitions.length === 0) {
      summary.stages[2].detail = `One canonical lineage was read back at every required stage: ${boardSequence.join(' to ')}. Blocker, reason code and person remained visible on the companion cards.`
    } else {
      summary.stages[2].status = 'NOT BUILT YET'
      summary.stages[2].detail = `NOT BUILT YET. Every board check this stage runs itself passed, and the lineage was read back at ${boardSequence.join(' to ') || 'no stage'}. The complete six-stage voyage still cannot be shown because the later legs that drive ${missingTransitions.join(', ')} did not produce watchable evidence. See the stages below for what is missing.`
      summary.stages[2].metrics.push({ label: 'Missing transitions', value: missingTransitions.join(', '), threshold: 'Owned by the later stages' })
      announceStage(summary.stages[2])
      await captureStage(summary.stages[2])
    }
  }

  summary.finishedAt = new Date().toISOString()
  const badStages = summary.stages.filter((stage) => mode === 'live' ? stage.status !== 'PASS' : stage.status !== 'SIMULATED')
  if (mode === 'fixture' && badStages.length === 0) {
    summary.overall = 'HARNESS SELF-TEST ONLY'
    summary.overallDetail = 'The orchestration, evidence rendering and safety checks worked against the in-memory fixture driver. This is not evidence that the SES Reporting product works.'
  } else if (mode === 'live' && badStages.length === 0) {
    summary.overall = 'PASS'
    summary.overallDetail = 'All seven live synthetic proof stages passed, every delivery went only to the Captain, every accounting object remained draft until voided, and cleanup found zero survivors.'
  } else {
    summary.overall = 'FAIL'
    summary.overallDetail = `${badStages.length} stage${badStages.length === 1 ? '' : 's'} did not pass. Read each red or amber stage below. No missing capability has been promoted to success.`
  }

  await fs.writeFile(path.join(runRoot, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(path.join(runRoot, 'summary.html'), renderFinalSummary(summary))
  await test.info().attach('SES proof summary', { path: path.join(runRoot, 'summary.html'), contentType: 'text/html' })
  await test.info().attach('SES proof run ledger', { path: path.join(runRoot, 'run-summary.json'), contentType: 'application/json' })

  if (mode === 'live') {
    expect(badStages.map((stage) => `${stage.number}. ${stage.copy.title}: ${stage.status}`), summary.overallDetail).toEqual([])
  } else {
    expect(badStages.map((stage) => `${stage.number}. ${stage.copy.title}: ${stage.status}`), 'fixture self-test must exercise every harness stage').toEqual([])
  }
})
