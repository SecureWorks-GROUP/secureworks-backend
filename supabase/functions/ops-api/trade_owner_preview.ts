// Owner's read-only view of a trade. The JWT remains the owner's throughout.
export const TRADE_PREVIEW_PARAM = 'preview_trade_user_id'
export const TRADE_PREVIEW_READS = new Set([
  'trade_preview_context', 'trade_calendar', 'my_jobs', 'search_all_jobs',
  'trade_job_detail', 'my_work_orders', 'my_job_work_order',
  'group_work_order_my_share', 'my_hours', 'my_money', 'my_trade_invoices',
  'get_trade_invoice', 'get_running_invoice_draft', 'my_invoices',
  'crew_charges_on_my_jobs',
])

type Caller = { id: string; email: string; orgId: string; role: string }
export class TradePreviewError extends Error {
  constructor(message: string, public status = 403, public code = 'trade_preview_forbidden') { super(message) }
}

export function assertTradePreviewOwner(caller: Caller | null, authMode = 'jwt') {
  if (authMode !== 'jwt' || !caller?.orgId ||
      caller.email.toLowerCase() !== 'marnin@secureworkswa.com.au' ||
      !['admin', 'owner'].includes(caller.role.toLowerCase())) {
    throw new TradePreviewError('View as trade is available only to the signed-in owner.')
  }
}

export function assertTradePreviewRead(action: string | null, method: string) {
  if (!action || !TRADE_PREVIEW_READS.has(action) ||
      (method !== 'GET' && !(action === 'group_work_order_my_share' && method === 'POST'))) {
    throw new TradePreviewError('Read-only preview: changes and invoice submissions are disabled.', 403, 'trade_preview_read_only')
  }
}

export async function readTradePreviewProfile(client: any, caller: Caller, target: string) {
  assertTradePreviewOwner(caller)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    throw new TradePreviewError('Choose a trade to preview.', 400, 'trade_preview_target_required')
  }
  const { data, error } = await client.from('users')
    .select('id, name, email, org_id, role, managed_verticals, trade_sees_all_jobs, trade_tier, invoice_type, abn, trade_details')
    .eq('id', target).eq('org_id', caller.orgId).maybeSingle()
  if (error) throw new TradePreviewError('Could not load that trade. Try again.', 503, 'trade_preview_unavailable')
  if (!data || ['admin', 'owner', 'ops_manager'].includes(String(data.role).toLowerCase())) {
    throw new TradePreviewError('That trade is not available for preview.', 404, 'trade_preview_not_found')
  }
  // Only the GST preference is needed from the private profile on this screen.
  return { ...data, trade_details: { gstRegistered: data.trade_details?.gstRegistered === true } }
}

export async function tradePreviewContext(client: any, caller: Caller | null, target?: string | null) {
  assertTradePreviewOwner(caller)
  if (target) return { preview: true, read_only: true, profile: await readTradePreviewProfile(client, caller!, target) }
  const { data, error } = await client.from('users').select('id, name, role, invoice_type')
    .eq('org_id', caller!.orgId).order('name')
  if (error) throw new TradePreviewError('Could not load the trade list. Try again.', 503, 'trade_preview_unavailable')
  return { can_preview: true, trades: (data || []).filter((p: any) =>
    !['admin', 'owner', 'ops_manager'].includes(String(p.role).toLowerCase())) }
}
