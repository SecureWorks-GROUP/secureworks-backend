import { assertEquals } from 'jsr:@std/assert@1'
import { trackingOptionRows } from './tracking_options.ts'

Deno.test('tracking options retain the chosen category and archived status, with name fallback', () => {
  const options = Array.from({ length: 8 }, (_, i) => ({
    TrackingOptionID: `ZZTEST-option-${i}`,
    Name: `ZZTEST-division-${i}`,
    Status: i === 7 ? 'ARCHIVED' : 'ACTIVE',
  }))
  const response = { TrackingCategories: [
    { TrackingCategoryID: 'ZZTEST-other', Name: 'Other', Options: [options[0]] },
    { TrackingCategoryID: 'ZZTEST-unit', Name: 'Business Unit', Options: options },
  ] }
  const now = '2026-11-17T00:00:00.000Z'
  const rows = trackingOptionRows(response, 'ZZTEST-org', 'ZZTEST-unit', now)
  assertEquals(rows.length, 8)
  assertEquals(rows.filter((r) => r.status === 'ARCHIVED').length, 1)
  assertEquals(rows[7], {
    org_id: 'ZZTEST-org', category_id: 'ZZTEST-unit', category_name: 'Business Unit',
    option_id: 'ZZTEST-option-7', option_name: 'ZZTEST-division-7', status: 'ARCHIVED', synced_at: now,
  })
  assertEquals(trackingOptionRows(response, 'ZZTEST-org', 'missing', now), rows)
  assertEquals(trackingOptionRows({ TrackingCategories: [response.TrackingCategories[0]] }, 'ZZTEST-org', 'missing', now), [])
  assertEquals(trackingOptionRows(response, 'ZZTEST-org', 'ZZTEST-other', now).length, 1)
})
