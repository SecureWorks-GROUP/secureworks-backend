import { assertEquals } from 'jsr:@std/assert@1'
import { findOpportunityField, opportunityFieldInputs, readOpportunityFieldDefs } from './opportunity_custom_fields.ts'

const defs = readOpportunityFieldDefs({
  customFields: [
    { id: 'f1', fieldKey: 'opportunity.job_number', name: 'Job Number', model: 'opportunity' },
    { id: 'f2', fieldKey: 'opportunity.supabase_job_id', name: 'Supabase Job ID' },
    { id: 'f3', fieldKey: 'opportunity.type_of_job', name: 'Job Type' },
    { name: 'no id', fieldKey: 'opportunity.quote_value' },
  ],
})

Deno.test('opportunity fields: ids by field key, then by name; nothing invented', () => {
  assertEquals(defs.length, 3)
  assertEquals(findOpportunityField(defs, 'job_number')?.id, 'f1')
  assertEquals(findOpportunityField(defs, 'job_type')?.id, 'f3')
  assertEquals(findOpportunityField(defs, 'quote_value'), null)
})

Deno.test('opportunity fields: inputs are { id, field_value }, empty values skipped, unknown keys reported', () => {
  const r = opportunityFieldInputs(defs, { job_number: 'SWP-1', supabase_job_id: 'abc', job_type: 'patio', quote_value: 1234.5, other: null })
  assertEquals(r.inputs, [
    { id: 'f1', field_value: 'SWP-1' },
    { id: 'f2', field_value: 'abc' },
    { id: 'f3', field_value: 'patio' },
  ])
  assertEquals(r.missing, ['quote_value'])
})

Deno.test('opportunity fields: an unreadable list gives no fields', () => {
  assertEquals(readOpportunityFieldDefs(null), [])
  assertEquals(readOpportunityFieldDefs({ customFields: 'x' }), [])
})
