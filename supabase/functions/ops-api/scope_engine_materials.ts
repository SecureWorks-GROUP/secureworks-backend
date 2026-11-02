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
//
// Dispatch's fill (T20, scopeEngineSealedLines) also keeps each line's own id
// (the engine's scope line id) and the supplier the engine's order put it
// under (supplierId, the Scope Engine catalogue's supplier id, with
// supplierName), so its lines can be traced back to the sealed revision and
// grouped by supplier. Revisions sealed before the engine wrote a supplier
// carry none, and "supplier-to-confirm" is no supplier.

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

export type ScopeEngineSealedLine = {
  description: string
  quantity: number | null
  unit: string | null
  unit_price: 0
  /** The engine's own id for the line (its scope line id), or null. */
  scope_line_id: string | null
  /** The catalogue supplier the engine's order put the line under, or null. */
  supplier_id: string | null
  supplier_name: string | null
}

function textOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t && t.length <= max ? t : null
}

// No supplier to order from: the office's own fixings, and the catalogue's
// placeholder for a product it cannot place with a supplier yet.
const NO_SUPPLIER = new Set(['office', 'supplier-to-confirm'])

export function scopeEngineSealedLines(lines: unknown[]): ScopeEngineSealedLine[] {
  const out: ScopeEngineSealedLine[] = []
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as Record<string, unknown>
    if (isOfficeFixingLine(line)) continue
    const description = typeof line.description === 'string' ? line.description.trim() : ''
    if (!description) continue
    const quantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) ? line.quantity : null
    const unit = typeof line.unit === 'string' && line.unit.trim() ? line.unit.trim() : null
    const supplierId = textOrNull(line.supplierId, 80)
    const known = supplierId !== null && !NO_SUPPLIER.has(supplierId.toLowerCase())
    out.push({
      description,
      quantity,
      unit,
      unit_price: 0,
      scope_line_id: textOrNull(line.id, 100),
      supplier_id: known ? supplierId : null,
      supplier_name: known ? textOrNull(line.supplierName, 120) : null,
    })
  }
  return out
}

export function scopeEngineMaterialLines(lines: unknown[]): Array<{ description: string; quantity: number | null; unit: string | null; unit_price: 0 }> {
  return scopeEngineSealedLines(lines).map(({ description, quantity, unit, unit_price }) => ({ description, quantity, unit, unit_price }))
}
