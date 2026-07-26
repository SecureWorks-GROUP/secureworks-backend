import { expect, test } from '@playwright/test'
import { ArtifactRegistry, SafetyViolation, assertCaptainOnlyEnvelope, assertCaptainOnlyRoute, assertDraftAccounting, assertSyntheticMarker } from './guards'
import { CAPTAIN_EMAIL } from './types'

const marker = 'SWG-SES-E2E-TEST-ONLY-SAFETY-CONTRACT'

test('recipient gate allows only one Captain To address and no Cc or Bcc', () => {
  expect(() => assertCaptainOnlyRoute({
    to: [CAPTAIN_EMAIL],
    cc: [],
    bcc: [],
    subject: 'safe test',
    releaseRevisionId: 'release-safe',
  })).not.toThrow()

  for (const route of [
    { to: ['builder@example.com'], cc: [], bcc: [] },
    { to: [CAPTAIN_EMAIL], cc: ['crew@example.com'], bcc: [] },
    { to: [CAPTAIN_EMAIL, 'ses@example.com'], cc: [], bcc: [] },
    { to: [], cc: [], bcc: [] },
  ]) {
    expect(() => assertCaptainOnlyRoute({ ...route, subject: 'unsafe test', releaseRevisionId: 'release-unsafe' })).toThrow(SafetyViolation)
  }
})

test('recipient gate also guards the executed and delivered envelopes', () => {
  expect(() => assertCaptainOnlyEnvelope({ to: [CAPTAIN_EMAIL], cc: [], bcc: [] }, 'executed send')).not.toThrow()

  for (const envelope of [
    undefined,
    null,
    'marninms98@gmail.com',
    {},
    { to: [CAPTAIN_EMAIL] },
    { to: [CAPTAIN_EMAIL], cc: [] },
    { to: CAPTAIN_EMAIL, cc: [], bcc: [] },
    { to: [CAPTAIN_EMAIL], cc: ['crew@example.com'], bcc: [] },
    { to: [CAPTAIN_EMAIL], cc: [], bcc: ['archive@example.com'] },
    { to: [CAPTAIN_EMAIL, 'ses@example.com'], cc: [], bcc: [] },
  ]) {
    expect(() => assertCaptainOnlyEnvelope(envelope, 'executed send')).toThrow(SafetyViolation)
  }
})

test('accounting gate rejects every status except DRAFT', () => {
  expect(() => assertDraftAccounting('DRAFT', 'test')).not.toThrow()
  for (const status of ['AUTHORISED', 'PAID', 'SUBMITTED', 'VOIDED', '', null, undefined]) {
    expect(() => assertDraftAccounting(status, 'test')).toThrow(SafetyViolation)
  }
})

test('marker gate rejects missing, weak and cross-run markers', () => {
  expect(() => assertSyntheticMarker(marker, marker, 'test')).not.toThrow()
  for (const candidate of ['', 'TEST', 'SWG-SES-E2E-TEST-ONLY-OTHER-RUN']) {
    expect(() => assertSyntheticMarker(candidate, marker, 'test')).toThrow(SafetyViolation)
  }
})

test('artifact registry requires a declared creation ledger', () => {
  const registry = new ArtifactRegistry(marker)
  expect(() => registry.register({}, 'mutation')).toThrow(SafetyViolation)
  expect(() => registry.register({ createdArtifacts: [{ id: 'job-1', kind: 'job', marker: 'wrong' }] }, 'mutation')).toThrow(SafetyViolation)
  expect(() => registry.register({ createdArtifacts: [{ id: 'unknown-1', kind: 'unknown' as never, marker }] }, 'mutation')).toThrow(SafetyViolation)
  expect(() => registry.register({ createdArtifacts: [{ id: 'invoice-1', kind: 'invoice', marker, accountingStatus: 'AUTHORISED' }] }, 'mutation')).toThrow(SafetyViolation)
})

test('cleanup gate rejects survivors, omissions and non-void invoice cleanup', () => {
  const registry = new ArtifactRegistry(marker)
  registry.register({
    createdArtifacts: [
      { id: 'job-1', kind: 'job', marker },
      { id: 'invoice-1', kind: 'invoice', marker, accountingStatus: 'DRAFT' },
    ],
  }, 'seed')

  expect(() => registry.verifyCleanup([], [])).toThrow(SafetyViolation)
  expect(() => registry.verifyCleanup([
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'REMOVED' },
    { id: 'invoice-1', kind: 'invoice', outcome: 'VOIDED', finalState: 'VOIDED' },
  ], [{ id: 'job-1', kind: 'job', marker }])).toThrow(SafetyViolation)
  expect(() => registry.verifyCleanup([
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'STILL_LIVE' },
    { id: 'invoice-1', kind: 'invoice', outcome: 'VOIDED', finalState: 'VOIDED' },
  ], [])).toThrow(SafetyViolation)
  expect(() => registry.verifyCleanup([
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'REMOVED' },
    { id: 'invoice-1', kind: 'invoice', outcome: 'REMOVED', finalState: 'REMOVED' },
  ], [])).toThrow(SafetyViolation)
  expect(() => registry.verifyCleanup([
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'REMOVED' },
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'REMOVED' },
    { id: 'invoice-1', kind: 'invoice', outcome: 'VOIDED', finalState: 'VOIDED' },
  ], [])).toThrow(SafetyViolation)
  expect(() => registry.verifyCleanup([
    { id: 'job-1', kind: 'job', outcome: 'REMOVED', finalState: 'REMOVED' },
    { id: 'invoice-1', kind: 'invoice', outcome: 'VOIDED', finalState: 'VOIDED' },
  ], [])).not.toThrow()
})
