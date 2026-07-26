import {
  CAPTAIN_EMAIL,
  MARKER_PREFIX,
  type CleanedArtifact,
  type CreatedArtifact,
  type RecipientEnvelope,
  type ResolvedRoute,
} from './types'

export class SafetyViolation extends Error {
  constructor(message: string) {
    super(`SAFETY GATE: ${message}`)
    this.name = 'SafetyViolation'
  }
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase()
}

function requireAddressList(value: unknown, field: string, operation: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new SafetyViolation(`${operation} refused because the ${field} envelope field was not a declared list of addresses`)
  }
  return value.map(normaliseEmail)
}

export function assertCaptainOnlyEnvelope(envelope: unknown, operation: string): RecipientEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new SafetyViolation(`${operation} refused because no To, Cc and Bcc envelope was declared`)
  }
  const candidate = envelope as Record<string, unknown>
  const to = requireAddressList(candidate.to, 'To', operation)
  const cc = requireAddressList(candidate.cc, 'Cc', operation)
  const bcc = requireAddressList(candidate.bcc, 'Bcc', operation)

  if (to.length !== 1 || to[0] !== CAPTAIN_EMAIL || cc.length !== 0 || bcc.length !== 0) {
    throw new SafetyViolation(
      `${operation} refused. Expected To ${CAPTAIN_EMAIL} with empty Cc and Bcc, received To ${JSON.stringify(candidate.to)}, Cc ${JSON.stringify(candidate.cc)}, Bcc ${JSON.stringify(candidate.bcc)}`,
    )
  }
  return { to, cc, bcc }
}

export function assertCaptainOnlyRoute(route: ResolvedRoute): void {
  assertCaptainOnlyEnvelope(route, 'send refused before transport')
}

export function assertDraftAccounting(status: unknown, operation: string): void {
  if (String(status || '').toUpperCase() !== 'DRAFT') {
    throw new SafetyViolation(`${operation} refused because accounting status was ${String(status)}, not DRAFT`)
  }
}

export function assertNoDeclaredArtifacts(response: { createdArtifacts?: unknown }, operation: string): void {
  const declared = response?.createdArtifacts
  if (declared === undefined || declared === null) return
  if (!Array.isArray(declared)) {
    throw new SafetyViolation(`${operation} is a read-only proof action but returned an invalid createdArtifacts ledger`)
  }
  if (declared.length > 0) {
    const ids = declared.map((item) => String((item as { id?: unknown })?.id ?? '(no id)')).join(', ')
    throw new SafetyViolation(
      `${operation} is a read-only proof action but declared ${declared.length} created artifacts: ${ids}. A plan, preflight, read or verification call must never create product state, because anything it creates escapes the harness registry and the cleanup reconciliation.`,
    )
  }
}

export function assertSyntheticMarker(marker: unknown, runMarker: string, operation: string): void {
  const candidate = String(marker || '')
  if (!candidate.startsWith(MARKER_PREFIX) || candidate !== runMarker) {
    throw new SafetyViolation(`${operation} refused because marker ${candidate || '(missing)'} did not equal ${runMarker}`)
  }
}

const ARTIFACT_KINDS = new Set(['source', 'case', 'job', 'document', 'pack', 'invoice', 'approval', 'mail'])

export class ArtifactRegistry {
  private readonly byId = new Map<string, CreatedArtifact>()

  constructor(private readonly runMarker: string) {}

  register(response: { createdArtifacts?: CreatedArtifact[] }, operation: string): CreatedArtifact[] {
    if (!Object.prototype.hasOwnProperty.call(response, 'createdArtifacts')) {
      throw new SafetyViolation(`${operation} mutation did not declare createdArtifacts`)
    }
    if (!Array.isArray(response.createdArtifacts)) {
      throw new SafetyViolation(`${operation} returned an invalid createdArtifacts ledger`)
    }

    for (const artifact of response.createdArtifacts) {
      if (!artifact?.id || !artifact?.kind) {
        throw new SafetyViolation(`${operation} returned an artifact without id and kind`)
      }
      if (!ARTIFACT_KINDS.has(artifact.kind)) {
        throw new SafetyViolation(`${operation} returned unsupported artifact kind ${String(artifact.kind)}`)
      }
      assertSyntheticMarker(artifact.marker, this.runMarker, operation)
      if (artifact.kind === 'invoice') {
        assertDraftAccounting(artifact.accountingStatus, `${operation} invoice ${artifact.id}`)
      }
      const current = this.byId.get(artifact.id)
      if (current && JSON.stringify(current) !== JSON.stringify(artifact)) {
        throw new SafetyViolation(`${operation} changed the registered identity of artifact ${artifact.id}`)
      }
      this.byId.set(artifact.id, artifact)
    }
    return response.createdArtifacts
  }

  list(): CreatedArtifact[] {
    return [...this.byId.values()]
  }

  verifyCleanup(cleaned: CleanedArtifact[], survivors: CreatedArtifact[]): void {
    const cleanedById = new Map(cleaned.map((artifact) => [artifact.id, artifact]))
    const missing = this.list().filter((artifact) => !cleanedById.has(artifact.id))
    const unknown = cleaned.filter((artifact) => !this.byId.has(artifact.id))

    if (cleanedById.size !== cleaned.length) {
      throw new SafetyViolation('cleanup returned duplicate artifact IDs')
    }
    if (survivors.length > 0) {
      throw new SafetyViolation(`cleanup left ${survivors.length} synthetic artifacts alive: ${survivors.map((item) => item.id).join(', ')}`)
    }
    if (missing.length > 0) {
      throw new SafetyViolation(`cleanup omitted registered artifacts: ${missing.map((item) => item.id).join(', ')}`)
    }
    if (unknown.length > 0) {
      throw new SafetyViolation(`cleanup claimed unknown artifacts: ${unknown.map((item) => item.id).join(', ')}`)
    }

    for (const created of this.list()) {
      const result = cleanedById.get(created.id)
      if (!result || result.kind !== created.kind) {
        throw new SafetyViolation(`cleanup kind mismatch for ${created.id}`)
      }
      if (created.kind === 'invoice') {
        if (result.outcome !== 'VOIDED' || result.finalState.toUpperCase() !== 'VOIDED') {
          throw new SafetyViolation(`draft invoice ${created.id} was not voided`)
        }
      } else if (result.outcome !== 'REMOVED' || result.finalState.toUpperCase() !== 'REMOVED') {
        throw new SafetyViolation(`${created.kind} ${created.id} was not removed`)
      }
    }
  }
}
