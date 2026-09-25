import { normaliseQuoteRunLabel, sameQuoteParty } from './quote_party_view.ts'

export function findQuoteRun(pricingJson: unknown, runLabel: string | null): any | null {
  const pricing = typeof pricingJson === 'string' ? JSON.parse(pricingJson) : pricingJson
  if (!pricing || typeof pricing !== 'object' || !Array.isArray((pricing as any).runs)) return null
  return (pricing as any).runs.find((run: any) => sameQuoteParty(run, { run_label: runLabel })) || null
}

export function quoteRunDepositAmount(
  run: any,
  isClient: boolean,
  depositPercent: number,
): number {
  const shareInc = isClient
    ? (run?.totals?.client_share_inc || 0)
    : (run?.totals?.neighbour_share_inc || 0)
  return Math.round(shareInc * (depositPercent / 100) * 100) / 100
}

export function persistSendRunRows(
  sb: { from: (table: string) => any },
  table: 'job_documents' | 'run_acceptances' | 'run_line_items',
  rows: any,
): any {
  if (table === 'job_documents') {
    return sb.from(table).insert({ ...rows, run_label: normaliseQuoteRunLabel(rows.run_label) })
  }
  if (table === 'run_acceptances') {
    return sb.from(table).upsert(rows, { onConflict: 'job_id,job_contact_id,run_label' })
  }
  return sb.from(table).insert(rows)
}
