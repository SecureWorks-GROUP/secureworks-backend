// The material lines of a job saved from the Scope Engine patio tool.
//
// The engine seals each revision with its own list of lines (scope_json.lines,
// written by scope-engine-v2 patio/scoper/src/jobsystem.ts: id, description,
// quantity, unit, colour). Those lines are the order; the older patio shape
// (scope_json.config) is never on such a record, so extractMaterialsFromScope
// reads these instead of guessing from dimensions.
//
// Office fixings are bought by the office, not ordered from a supplier: a line
// the engine marks with supplier `office` is skipped, so it never reaches a
// supplier order, a purchase order or a bill. A quantity the engine left
// unknown stays null, never 0.

export function isScopeEnginePatioRecord(scope: unknown): scope is { tool: 'patio-scoper'; lines: unknown[] } {
  return !!scope && typeof scope === 'object' &&
    (scope as Record<string, unknown>).tool === 'patio-scoper' &&
    Array.isArray((scope as Record<string, unknown>).lines)
}

function supplierOf(line: Record<string, unknown>): string {
  const s = line.supplier ?? line.supplierId ?? line.supplier_id
  if (typeof s === 'string') return s.trim().toLowerCase()
  if (s && typeof s === 'object') {
    const id = (s as Record<string, unknown>).id
    return typeof id === 'string' ? id.trim().toLowerCase() : ''
  }
  return ''
}

export function isOfficeFixingLine(line: Record<string, unknown>): boolean {
  return supplierOf(line) === 'office'
}

export function scopeEngineMaterialLines(lines: unknown[]): Array<{ description: string; quantity: number | null; unit: string | null; unit_price: 0 }> {
  const out: Array<{ description: string; quantity: number | null; unit: string | null; unit_price: 0 }> = []
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as Record<string, unknown>
    if (isOfficeFixingLine(line)) continue
    const description = typeof line.description === 'string' ? line.description.trim() : ''
    if (!description) continue
    const quantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) ? line.quantity : null
    const unit = typeof line.unit === 'string' && line.unit.trim() ? line.unit.trim() : null
    out.push({ description, quantity, unit, unit_price: 0 })
  }
  return out
}
