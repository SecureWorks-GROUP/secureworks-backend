// Finance job cost report (M4 U5) — read-only, token-gated, standalone HTML page.
//
// Mission profit-trade-invoice-intelligence-2026-07-03 (campaign
// profitability-job-costing, M4). Wiki issue #112.
//
// Finance opens a link in the U3 review email and sees, for ONE job: allowed-vs-
// charged per make-safe line with the allowance source, every over-allowance flag
// with the trade's justification, the job's cost facts to date, and links to the
// Xero objects — enough to decide pay-or-not. This surface is STRICTLY read-only:
// it SELECTs existing data and renders HTML. It never pays, holds, authorises or
// mutates anything; the pay decision stays human, in Xero.
//
// It reads the canonical surfaces — v_trade_charge_resolved carrying the U4 flag
// facts, and job_financials — so materials/full P&L enrich automatically as M2/M3
// land, with no rework here.
//
// Access: reachable without a Bearer (finance clicks an email link), gated by an
// HMAC token over the job_id so the URL is unguessable. The token is deterministic
// and stateless — no row is written to mint it, which keeps U5 pure-read. The
// figures shown here come from the SAME view the U3 email reads, so the email and
// this page reconcile by construction.

export const MAKESAFE_COST_REPORT_ACTION = "makesafe_job_cost_report";

// ── env (cross-runtime so the module is testable under Deno and Node) ──
function getEnv(name: string): string {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) return g.Deno.env.get(name) || "";
  return g.process?.env?.[name] || "";
}

// Secret for the link token. A dedicated MAKESAFE_REPORT_SECRET is preferred;
// falls back to server-only keys that always exist so the link works out of the
// box and can be hardened later by setting the dedicated secret.
export function costReportSecret(): string {
  return getEnv("MAKESAFE_REPORT_SECRET") || getEnv("SW_API_KEY") ||
    getEnv("SUPABASE_SERVICE_ROLE_KEY") || "makesafe-cost-report-dev-secret";
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function costReportToken(
  jobId: string,
  secret: string = costReportSecret(),
): Promise<string> {
  return hmacHex(`${MAKESAFE_COST_REPORT_ACTION}:${jobId}`, secret);
}

export async function verifyCostReportToken(
  jobId: string,
  token: string,
  secret: string = costReportSecret(),
): Promise<boolean> {
  if (!jobId || !token) return false;
  const expected = await costReportToken(jobId, secret);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

// Full openable URL for the U3 email link. `supabaseUrl` is the project URL
// (e.g. https://<ref>.supabase.co); the function path is appended here.
export function costReportUrl(
  supabaseUrl: string,
  jobId: string,
  token: string,
): string {
  const b = (supabaseUrl || "").replace(/\/$/, "");
  return `${b}/functions/v1/ops-api?action=${MAKESAFE_COST_REPORT_ACTION}` +
    `&job_id=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`;
}

// Convenience: mint the token and build the link in one call (for U3).
export async function buildCostReportLink(
  supabaseUrl: string,
  jobId: string,
  secret: string = costReportSecret(),
): Promise<string> {
  return costReportUrl(supabaseUrl, jobId, await costReportToken(jobId, secret));
}

// ── formatting + labels ──
export function allowanceSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "ops_set":
      return "Office-set expectation";
    case "report":
      return "Trade report (unverified)";
    case "rule_default":
      return "Rule default (2hr minimum)";
    default:
      return source ? String(source) : "—";
  }
}

export function xeroBillUrl(xeroBillId: string | null | undefined): string | null {
  return xeroBillId
    ? `https://go.xero.com/AccountsPayable/View.aspx?invoiceID=${encodeURIComponent(xeroBillId)}`
    : null;
}

function money(n: number | null | undefined): string {
  const v = Number(n || 0);
  return "$" +
    v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function hrs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return (Math.round(Number(n) * 100) / 100).toString() + "h";
}

export function esc(s: unknown): string {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── data model ──
export interface CostReportLine {
  line_id: string;
  trade_invoice_id: string | null;
  xero_bill_id: string | null;
  description: string;
  line_type: string;
  charged_hours: number | null;
  hourly_rate: number | null;
  line_total_ex: number | null;
  allowed_hours: number | null;
  baseline_source: string | null;
  flag_type: string | null;
  hours_justification: string | null;
  flagged_at: string | null;
  is_hours_flagged: boolean;
  line_date: string | null;
}

export interface CostReportData {
  job: {
    id: string;
    job_number: string;
    client_name: string;
    site: string;
    type: string;
  };
  generated_at: string;
  makesafe_lines: CostReportLine[];
  flagged_lines: CostReportLine[];
  all_lines: CostReportLine[];
  financials:
    | {
      cost_labour_ex: number;
      cost_materials_ex: number;
      cost_commission_ex: number;
      cost_other_ex: number;
      client_invoiced_ex: number;
      net_margin_ex: number | null;
      margin_pct: number | null;
    }
    | null;
  invoices: {
    id: string;
    invoice_number: string | null;
    week_start: string | null;
    status: string | null;
    xero_bill_id: string | null;
  }[];
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

const isMakeSafeLineType = (t: string): boolean =>
  String(t || "").toLowerCase().replace(/[-_\s]/g, "") === "makesafe";

// Pure: assemble the report data model from raw view/table rows. Deterministic
// (no DB, no clock) so it can be tested and so the render reconciles to U3.
export function assembleCostReport(
  // deno-lint-ignore no-explicit-any
  rawJob: any,
  // deno-lint-ignore no-explicit-any
  rawLines: any[],
  // deno-lint-ignore no-explicit-any
  rawFin: any,
  // deno-lint-ignore no-explicit-any
  rawInvoices: any[],
  generatedAt: string,
): CostReportData {
  const lines: CostReportLine[] = (rawLines || [])
    .filter((r) => !r.is_probable_test_line)
    .map((r) => ({
      line_id: r.line_id,
      trade_invoice_id: r.trade_invoice_id ?? null,
      xero_bill_id: r.xero_bill_id ?? null,
      description: r.description || "",
      line_type: r.line_type || "",
      charged_hours: num(r.total_hours),
      hourly_rate: num(r.hourly_rate),
      line_total_ex: num(r.line_total_ex),
      allowed_hours: num(r.baseline_hours),
      baseline_source: r.baseline_source ?? null,
      flag_type: r.flag_type ?? null,
      hours_justification: r.hours_justification ?? null,
      flagged_at: r.flagged_at ?? null,
      is_hours_flagged: !!r.is_hours_flagged,
      line_date: r.line_date ?? null,
    }));

  const makesafe_lines = lines.filter((l) => isMakeSafeLineType(l.line_type));
  const flagged_lines = lines.filter((l) => l.is_hours_flagged);

  const financials = rawFin
    ? {
      cost_labour_ex: Number(rawFin.cost_labour_ex || 0),
      cost_materials_ex: Number(rawFin.cost_materials_ex || 0),
      cost_commission_ex: Number(rawFin.cost_commission_ex || 0),
      cost_other_ex: Number(rawFin.cost_other_ex || 0),
      client_invoiced_ex: Number(rawFin.client_invoiced_ex || 0),
      net_margin_ex: num(rawFin.net_margin_ex),
      margin_pct: num(rawFin.margin_pct),
    }
    : null;

  return {
    job: {
      id: rawJob.id,
      job_number: rawJob.job_number || "",
      client_name: rawJob.client_name || "",
      site: [rawJob.site_address, rawJob.site_suburb].filter(Boolean).join(", "),
      type: rawJob.type || "",
    },
    generated_at: generatedAt,
    makesafe_lines,
    flagged_lines,
    all_lines: lines,
    financials,
    invoices: (rawInvoices || []).map((i) => ({
      id: i.id,
      invoice_number: i.invoice_number ?? null,
      week_start: i.week_start ?? null,
      status: i.status ?? null,
      xero_bill_id: i.xero_bill_id ?? null,
    })),
  };
}

// Read-only fetch of everything the report needs for one job. Only SELECTs.
// deno-lint-ignore no-explicit-any
export async function getJobCostReport(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
  now: string = new Date().toISOString(),
): Promise<CostReportData | null> {
  const { data: job } = await client
    .from("jobs")
    .select("id, job_number, client_name, site_address, site_suburb, type")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;

  const { data: lines } = await client
    .from("v_trade_charge_resolved")
    .select(
      "line_id, trade_invoice_id, xero_bill_id, description, line_type, total_hours, hourly_rate, line_total_ex, baseline_hours, baseline_source, flag_type, hours_justification, flagged_at, is_hours_flagged, line_date, is_probable_test_line",
    )
    .eq("resolved_job_id", jobId);

  const { data: fin } = await client
    .from("job_financials")
    .select(
      "cost_labour_ex, cost_materials_ex, cost_commission_ex, cost_other_ex, client_invoiced_ex, net_margin_ex, margin_pct",
    )
    .eq("job_id", jobId)
    .maybeSingle();

  const invIds = [
    ...new Set((lines || []).map((l: { trade_invoice_id: string }) => l.trade_invoice_id).filter(Boolean)),
  ];
  let invoices: unknown[] = [];
  if (invIds.length) {
    const { data } = await client
      .from("trade_invoices")
      .select("id, invoice_number, week_start, status, xero_bill_id")
      .in("id", invIds);
    invoices = data || [];
  }

  // deno-lint-ignore no-explicit-any
  return assembleCostReport(job, (lines || []) as any[], fin, invoices as any[], now);
}

// ── render ──
const BRAND_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1A2332;background:#f5f6f8;line-height:1.55}
.wrap{max-width:720px;margin:0 auto;background:#fff;min-height:100vh}
.header{background:#293C46;color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700}.header .brand{font-size:12px;opacity:.7}
.accent{height:4px;background:#F15A29}
.ro{background:#FFF6E9;border-bottom:1px solid #F3D9AE;color:#8a5a12;font-size:12px;padding:8px 24px}
.section{padding:16px 24px;border-bottom:1px solid #eee}
.section h3{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#4C6A7C;margin-bottom:10px;font-weight:700}
.info-row{display:flex;gap:12px;font-size:14px;margin:4px 0}
.info-label{font-weight:700;min-width:84px;color:#4C6A7C;flex-shrink:0}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:rgba(241,90,41,.12);color:#F15A29}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#7C8898;font-weight:700;padding:6px 8px;border-bottom:1px solid #eee}
td{padding:8px 8px;border-bottom:1px solid #f2f2f2;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.flag td{background:#FDECEA}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700}
.pill-over{background:#FDE2DE;color:#c0392b}
.src{font-size:11px;color:#7C8898}
.just{font-size:12px;color:#293C46;white-space:pre-wrap}
.none{font-size:13px;color:#4C6A7C;background:#f2f8f2;border:1px solid #d5ead5;border-radius:8px;padding:10px 12px}
.sumgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;font-size:14px}
.sumgrid .k{color:#4C6A7C}.sumgrid .v{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.note{font-size:11px;color:#7C8898;margin-top:8px}
.xlink{color:#2980B9;text-decoration:none;font-weight:600;font-size:12px}
.footer{padding:20px 24px;text-align:center;font-size:11px;color:#7C8898}
@media print{body{background:#fff}.wrap{max-width:100%}}
`;

function flaggedRow(l: CostReportLine): string {
  const over = (l.charged_hours != null && l.allowed_hours != null)
    ? l.charged_hours - l.allowed_hours
    : null;
  const bill = xeroBillUrl(l.xero_bill_id);
  return `<tr class="flag">
<td><div>${esc(l.description || l.line_type)}</div>${l.line_date ? `<div class="src">${esc(l.line_date)}</div>` : ""}</td>
<td class="num">${hrs(l.allowed_hours)}<div class="src">${esc(allowanceSourceLabel(l.baseline_source))}</div></td>
<td class="num">${hrs(l.charged_hours)}${over != null ? `<div class="src"><span class="pill pill-over">+${hrs(over)}</span></div>` : ""}</td>
<td class="just">${l.hours_justification ? esc(l.hours_justification) : '<span class="src">No explanation given</span>'}</td>
<td>${bill ? `<a class="xlink" href="${esc(bill)}">Xero bill ↗</a>` : '<span class="src">—</span>'}</td>
</tr>`;
}

function makesafeRow(l: CostReportLine): string {
  return `<tr>
<td>${esc(l.description || l.line_type)}${l.is_hours_flagged ? ' <span class="pill pill-over">over</span>' : ""}</td>
<td class="num">${hrs(l.allowed_hours)}<div class="src">${esc(allowanceSourceLabel(l.baseline_source))}</div></td>
<td class="num">${hrs(l.charged_hours)}</td>
<td class="num">${money(l.line_total_ex)}</td>
</tr>`;
}

export function renderCostReportHtml(d: CostReportData): string {
  const j = d.job;
  const genPerth = (() => {
    try {
      return new Date(d.generated_at).toLocaleString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Australia/Perth",
      });
    } catch {
      return d.generated_at;
    }
  })();

  const flagged = d.flagged_lines;
  const flaggedSection = flagged.length
    ? `<table>
<thead><tr><th>Make-safe line</th><th class="num">Allowed</th><th class="num">Charged</th><th>Trade's justification</th><th>Bill</th></tr></thead>
<tbody>${flagged.map(flaggedRow).join("")}</tbody>
</table>
<div class="note">Allowed hours never rise because the builder was billed more (2026-06-19 ruling). The pay decision is yours, in Xero. This page changes nothing.</div>`
    : `<div class="none">No over-allowance flags on this job. Every make-safe line is within its allowed hours.</div>`;

  const msSection = d.makesafe_lines.length
    ? `<table>
<thead><tr><th>Make-safe line</th><th class="num">Allowed</th><th class="num">Charged</th><th class="num">Amount</th></tr></thead>
<tbody>${d.makesafe_lines.map(makesafeRow).join("")}</tbody>
</table>`
    : `<div class="none">No make-safe labour lines on this job yet.</div>`;

  const f = d.financials;
  const finSection = f
    ? `<div class="sumgrid">
<div class="k">Labour cost</div><div class="v">${money(f.cost_labour_ex)}</div>
<div class="k">Materials cost</div><div class="v">${money(f.cost_materials_ex)}</div>
<div class="k">Commission</div><div class="v">${money(f.cost_commission_ex)}</div>
<div class="k">Other cost</div><div class="v">${money(f.cost_other_ex)}</div>
<div class="k">Client invoiced</div><div class="v">${money(f.client_invoiced_ex)}</div>
<div class="k">Net margin</div><div class="v">${f.net_margin_ex != null ? money(f.net_margin_ex) : "—"}${f.margin_pct != null ? ` (${Math.round(Number(f.margin_pct))}%)` : ""}</div>
</div>
<div class="note">Cost facts to date, ex GST. Materials and full P&amp;L populate automatically as they are captured.</div>`
    : `<div class="none">No cost summary available for this job yet.</div>`;

  const invSection = d.invoices.length
    ? `<table>
<thead><tr><th>Trade invoice</th><th>Week</th><th>Status</th><th>Bill</th></tr></thead>
<tbody>${
      d.invoices.map((i) => {
        const bill = xeroBillUrl(i.xero_bill_id);
        return `<tr><td>${esc(i.invoice_number || i.id)}</td><td>${esc(i.week_start || "—")}</td><td>${esc(i.status || "—")}</td><td>${bill ? `<a class="xlink" href="${esc(bill)}">Xero draft bill ↗</a>` : '<span class="src">—</span>'}</td></tr>`;
      }).join("")
    }</tbody>
</table>`
    : "";

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Cost Report: ${esc(j.job_number || j.client_name)}</title>
<style>${BRAND_CSS}</style></head><body>
<div class="wrap">
<div class="header"><div><h1>Job Cost Report</h1><div class="brand">SecureWorks Group · Finance review</div></div><span class="badge">${esc(j.type || "job")}</span></div>
<div class="accent"></div>
<div class="ro">Read-only. This page never pays, holds or changes any amount, hour or invoice. It is here so you can decide whether to pay.</div>

<div class="section">
<h3>Job</h3>
<div class="info-row"><span class="info-label">Job</span><span>${esc(j.job_number || "—")}</span></div>
<div class="info-row"><span class="info-label">Client</span><span>${esc(j.client_name || "—")}</span></div>
${j.site ? `<div class="info-row"><span class="info-label">Site</span><span>${esc(j.site)}</span></div>` : ""}
</div>

<div class="section">
<h3>Over-allowance flags to review</h3>
${flaggedSection}
</div>

<div class="section">
<h3>All make-safe labour: allowed vs charged</h3>
${msSection}
</div>

<div class="section">
<h3>Job cost summary</h3>
${finSection}
</div>

${invSection ? `<div class="section"><h3>Trade invoices</h3>${invSection}</div>` : ""}

<div class="footer">Generated ${esc(genPerth)} (AWST). Read-only finance review surface · SecureWorks Group.</div>
</div>
</body></html>`;
}

// Small branded error page for an invalid/expired link or missing job.
export function renderCostReportError(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Job Cost Report</title>
<style>${BRAND_CSS}</style></head><body><div class="wrap">
<div class="header"><div><h1>Job Cost Report</h1><div class="brand">SecureWorks Group · Finance review</div></div></div>
<div class="accent"></div>
<div class="section"><div class="none" style="background:#FDECEA;border-color:#F3C4BE;color:#8a2a1c">${esc(message)}</div></div>
</div></body></html>`;
}
