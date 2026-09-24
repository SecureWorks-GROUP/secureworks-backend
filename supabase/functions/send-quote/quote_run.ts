export function findQuoteRun(pricingJson: unknown, runLabel: string): any | null {
  const pricing = typeof pricingJson === 'string' ? JSON.parse(pricingJson) : pricingJson
  if (!pricing || typeof pricing !== 'object' || !Array.isArray((pricing as any).runs)) return null
  return (pricing as any).runs.find((run: any) => run?.run_label === runLabel) || null
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
