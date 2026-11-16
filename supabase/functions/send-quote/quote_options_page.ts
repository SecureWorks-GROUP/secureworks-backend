// Ruling 14 step 1: the "Options you can add" card on the customer's Accept page.
//
// One row per option (name, its one line, price inc GST) with a tick box. The
// total and deposit shown are the tool's precomputed combination for the ticked
// set (quote_options.ts), never arithmetic in the browser. The ticked ids go to
// POST /accept as { option_ids }; the server picks and checks the combination
// again, so the page's figures are display only.
import type { QuoteOptionsOffer } from './quote_options.ts'

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function money(v: number): string {
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** JSON safe to place inside a <script> element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** The figures the page shows for each tickable set, keyed by ids joined with "|". */
export function optionFigures(offer: QuoteOptionsOffer): Record<string, { total: string; deposit: string }> {
  const out: Record<string, { total: string; deposit: string }> = {}
  for (const c of offer.combinations) {
    out[c.option_ids.join('|')] = { total: money(c.totalIncGST), deposit: money(c.deposit_inc_gst) }
  }
  return out
}

export function buildQuoteOptionsCard(offer: QuoteOptionsOffer): string {
  const base = offer.combinations[0]
  const rows = offer.options.map((o) => `
      <label class="opt-row">
        <input type="checkbox" class="opt-tick" value="${escapeHtml(o.id)}" onchange="updateOptionTotals()">
        <span class="opt-text">
          <span class="opt-name">${escapeHtml(o.name)}</span>
          ${o.line ? `<span class="opt-line">${escapeHtml(o.line)}</span>` : ''}
        </span>
        <span class="opt-price">+${escapeHtml(money(o.sell_inc_gst))}</span>
      </label>`).join('')
  return `
    <div class="card opt-card" id="quoteOptions">
      <h3>Options you can add</h3>
      <p class="opt-sentence">${escapeHtml(offer.sentence || 'Tick any options you want. Your price and deposit are updated to match.')}</p>
      ${rows}
      <div class="opt-totals">
        <div><span>Your total</span><strong id="optTotal">${escapeHtml(money(base.totalIncGST))}</strong></div>
        <div><span>Deposit to pay now</span><strong id="optDeposit">${escapeHtml(money(base.deposit_inc_gst))}</strong></div>
        <div class="opt-note">Prices include GST.</div>
      </div>
    </div>
    <script>
      var OPTION_ORDER = ${scriptJson(offer.options.map((o) => o.id))};
      var OPTION_FIGURES = ${scriptJson(optionFigures(offer))};
      function tickedOptionIds() {
        var ticked = {};
        document.querySelectorAll('.opt-tick').forEach(function (b) { if (b.checked) ticked[b.value] = true; });
        return OPTION_ORDER.filter(function (id) { return ticked[id]; });
      }
      function currentOptionFigures() {
        return OPTION_FIGURES[tickedOptionIds().join('|')] || null;
      }
      function updateOptionTotals() {
        var f = currentOptionFigures();
        if (!f) return;
        document.getElementById('optTotal').textContent = f.total;
        document.getElementById('optDeposit').textContent = f.deposit;
      }
    </script>`
}

export const QUOTE_OPTIONS_CSS = `
    .opt-card .opt-sentence { color: rgba(255,255,255,0.7); font-size: 14px; margin-bottom: 14px; }
    .opt-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.08); cursor: pointer; }
    .opt-row input { width: 20px; height: 20px; margin-top: 2px; accent-color: #34C759; flex-shrink: 0; }
    .opt-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .opt-name { font-weight: 600; color: #fff; font-size: 15px; }
    .opt-line { color: rgba(255,255,255,0.6); font-size: 13px; }
    .opt-price { color: #fff; font-weight: 600; font-size: 15px; white-space: nowrap; }
    .opt-totals { margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
    .opt-totals div { display: flex; justify-content: space-between; color: rgba(255,255,255,0.8); font-size: 15px; }
    .opt-totals strong { color: #fff; font-size: 17px; }
    .opt-totals .opt-note { color: rgba(255,255,255,0.45); font-size: 12px; justify-content: flex-start; }
`
