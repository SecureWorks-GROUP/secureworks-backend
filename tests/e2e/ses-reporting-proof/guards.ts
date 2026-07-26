import {
  CAPTAIN_EMAIL,
  MARKER_PREFIX,
  type CleanedArtifact,
  type CreatedArtifact,
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

export function assertCaptainOnlyRoute(route: ResolvedRoute): void {
  const to = route.to.map(normaliseEmail)
  const cc = route.cc.map(normaliseEmail)
  const bcc = route.bcc.map(normaliseEmail)
  const allRecipients = [...to, ...cc, ...bcc]

  if (to.length !== 1 || to[0] !== CAPTAIN_EMAIL || cc.length !== 0 || bcc.length !== 0) {
    throw new SafetyViolation(
      `send refused before transport. Expected To ${CAPTAIN_EMAIL} with empty Cc and Bcc, received To ${JSON.stringify(route.to)}, Cc ${JSON.stringify(route.cc)}, Bcc ${JSON.stringify(route.bcc)}`,
    )
  }
  if (allRecipients.some((recipient) => recipient !== CAPTAIN_EMAIL)) {
    throw new SafetyViolation(`send refused before transport because ${allRecipients.join(', ')} is outside the one-address allowlist`)
  }
}

export function assertDraftAccounting(status: unknown, operation: string): void {
  if (String(status || '').toUpperCase() !== 'DRAFT') {
    throw new SafetyViolation(`${operation} refused because accounting status was ${String(status)}, not DRAFT`)
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
