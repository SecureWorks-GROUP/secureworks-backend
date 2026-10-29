// Opportunity custom fields the scope link writes (job_number, supabase_job_id, job_type, quote_value).
// GHL's opportunity update takes custom fields as { id, field_value } (as the allocation ref already does,
// allocation_ref.ts): the link used to send { key, value }, which GHL answers 200 and ignores, so the fields
// stayed blank on every linked opportunity. The ids come from the location's opportunity field list, matched
// by field key ("opportunity.job_number") or by name ("Job Number"). A key with no field in GHL is reported,
// never invented.

export type OpportunityFieldDef = { id: string; fieldKey: string | null; name: string | null };
export type OpportunityFieldInput = { id: string; field_value: string };

const norm = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The location's opportunity custom fields, from GHL's list answer. Anything without an id is left out. */
export function readOpportunityFieldDefs(body: unknown): OpportunityFieldDef[] {
  const list = (body as { customFields?: unknown } | null)?.customFields;
  if (!Array.isArray(list)) return [];
  const out: OpportunityFieldDef[] = [];
  for (const f of list) {
    const r = f as Record<string, unknown>;
    if (typeof r?.id !== 'string' || !r.id) continue;
    out.push({ id: r.id, fieldKey: typeof r.fieldKey === 'string' ? r.fieldKey : null, name: typeof r.name === 'string' ? r.name : null });
  }
  return out;
}

/** The field for one of our keys: its field key first ("opportunity.<key>", or any "<model>.<key>"), then its name. */
export function findOpportunityField(defs: readonly OpportunityFieldDef[], key: string): OpportunityFieldDef | null {
  const k = norm(key);
  return defs.find((d) => d.fieldKey && norm(d.fieldKey.split('.').pop() ?? '') === k)
    ?? defs.find((d) => d.name && norm(d.name) === k)
    ?? null;
}

/** The update inputs for the values we have, and the keys GHL has no field for. */
export function opportunityFieldInputs(
  defs: readonly OpportunityFieldDef[], values: Readonly<Record<string, string | number | null | undefined>>,
): { inputs: OpportunityFieldInput[]; missing: string[] } {
  const inputs: OpportunityFieldInput[] = [];
  const missing: string[] = [];
  for (const [key, v] of Object.entries(values)) {
    if (v === null || v === undefined || v === '') continue;
    const def = findOpportunityField(defs, key);
    if (!def) { missing.push(key); continue; }
    inputs.push({ id: def.id, field_value: String(v) });
  }
  return { inputs, missing };
}
