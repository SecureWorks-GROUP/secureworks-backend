// deno-lint-ignore-file no-explicit-any
/**
 * Re-runnable proof for the reattend invoice-presentation defect.
 *
 * A reattend card whose current-cycle DRAFT the shared qualifier certifies
 * (`invoice_qualifies_as_current_draft: true`) used to serve `invoice_raw_status`,
 * `invoice_date` and `invoice_created_at` as NULL, because those three fields ran
 * `allowCloseoutFromEvidence` (a blunt `!hasReattendBoundary`) on their own instead
 * of reading the `invoiceForStage` binding the ladder had already resolved. The
 * board therefore derived `report_ready` FROM an invoice while presenting no
 * invoice at all, and the cockpit had nothing to bind an approve control to.
 *
 * Two independent modes, both READ-ONLY:
 *
 *   --mode=served   Read the live board through ops-api and report every card
 *                   carrying a qualifying DRAFT with a null `invoice_raw_status`.
 *                   That set is the defect population. After the fix is deployed
 *                   it must be EMPTY. Needs SW_SUPABASE_URL + SW_API_KEY.
 *
 *   --mode=derive   Pull the real production rows for the named cards through the
 *                   Management API (`read_only: true`) and run them through the
 *                   real `enrichMakesafeBoardJob` in this working tree. Proves what
 *                   THIS code would serve for THOSE cards without deploying
 *                   anything. Needs SUPABASE_ACCESS_TOKEN.
 *
 *                   Scope limit, stated so the output is not over-read: this mode
 *                   supplies the invoice/report/pack rows only. It does NOT rebuild
 *                   the board's docket-synthesised `packForBoard`, assignments or
 *                   document flags, so it deliberately reports nothing about
 *                   `board_stage` — placement is the served board's answer
 *                   (`--mode=served`), not this harness's. The invoice presentation
 *                   fields below depend on none of those inputs.
 *
 * Neither mode writes: no mint, no void, no approve, no authorise, no send, no
 * board write. `derive` is pure in-process derivation over rows it only SELECTs.
 *
 * Client identity is never printed. Job number, suburb and invoice lifecycle
 * fields only.
 *
 * Usage:
 *   deno run --allow-env --allow-net scripts/ses-reattend-invoice-presentation-verify.ts --mode=served
 *   deno run --allow-env --allow-net scripts/ses-reattend-invoice-presentation-verify.ts --mode=derive
 */

import { _enrichMakesafeBoardJobForTest } from "../supabase/functions/ops-api/index.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MGMT_QUERY =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/** Cards the defect was reported on, plus the first-attendance control. */
const CARDS = ["SWMS-261114", "SWMS-261025", "SWMS-261081"];

function arg(name: string, fallback: string): string {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`missing ${name}`);
    Deno.exit(2);
  }
  return value;
}

/** Management API SELECT. Refuses anything that is not a single read. */
async function readOnlyQuery(sql: string): Promise<any[]> {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed) || /;/.test(trimmed.replace(/;$/, ""))) {
    throw new Error("read-only guard: single SELECT only");
  }
  const res = await fetch(MGMT_QUERY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: trimmed, read_only: true }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json();
}

/**
 * MODE served — the defect population on the board as it is actually served.
 * Exits non-zero while any card is placed by a draft it does not present.
 */
async function modeServed(): Promise<number> {
  const base = requireEnv("SW_SUPABASE_URL").replace(/\/$/, "");
  const res = await fetch(
    `${base}/functions/v1/ops-api?action=makesafe_board&include_archive=1`,
    { headers: { "x-api-key": requireEnv("SW_API_KEY") } },
  );
  if (!res.ok) {
    console.error(`board read failed: HTTP ${res.status}`);
    return 2;
  }
  const board = await res.json();
  const cards: Array<[string, any]> = [];
  for (const [column, rows] of Object.entries(board?.columns || {})) {
    for (const card of (rows as any[]) || []) cards.push([column, card]);
  }

  const qualifying = cards.filter(([, c]) =>
    c?.invoice_qualifies_as_current_draft === true
  );
  const contradictory = qualifying.filter(([, c]) =>
    c?.invoice_raw_status == null
  );

  console.log(`board cards ................. ${cards.length}`);
  console.log(`qualifying current DRAFT .... ${qualifying.length}`);
  console.log(
    `placed by a draft they do not present ... ${contradictory.length}`,
  );
  console.log();
  console.log(
    `${"job_number".padEnd(16)}${"column".padEnd(16)}${"suburb".padEnd(24)}${
      "rc".padEnd(4)
    }${"raw".padEnd(10)}${"invoice_date".padEnd(14)}created_at`,
  );
  for (const [column, c] of qualifying) {
    console.log(
      `${String(c.job_number).padEnd(16)}${column.padEnd(16)}${
        String(c.site_suburb ?? "").padEnd(24)
      }${String(c.reattend_count ?? 0).padEnd(4)}${
        String(c.invoice_raw_status ?? "NULL").padEnd(10)
      }${String(c.invoice_date ?? "NULL").padEnd(14)}${
        c.invoice_created_at ?? "NULL"
      }`,
    );
  }
  console.log();
  if (contradictory.length) {
    console.log(
      `DEFECT PRESENT on ${contradictory.length} card(s): ${
        contradictory.map(([, c]) => c.job_number).join(", ")
      }`,
    );
    return 1;
  }
  console.log("CLEAN: every card placed by a qualifying draft presents it.");
  return 0;
}

/**
 * MODE derive — real production rows, this working tree's derivation.
 * Proves the served answer this code produces before it is deployed.
 */
async function modeDerive(): Promise<number> {
  const list = CARDS.map((n) => `'${n}'`).join(",");
  const [jobs, details, invoices, reports, packs] = await Promise.all([
    readOnlyQuery(
      `select id, job_number, status, created_at, completed_at, updated_at, type, site_suburb, metadata from jobs where job_number in (${list})`,
    ),
    readOnlyQuery(
      `select d.* from makesafe_job_details d join jobs j on j.id = d.job_id where j.job_number in (${list})`,
    ),
    readOnlyQuery(
      `select x.* from xero_invoices x join jobs j on j.id = x.job_id where j.job_number in (${list})`,
    ),
    readOnlyQuery(
      `select r.* from job_service_reports r join jobs j on j.id = r.job_id where j.job_number in (${list})`,
    ),
    readOnlyQuery(
      `select p.* from makesafe_report_packs p join jobs j on j.id = p.job_id where j.job_number in (${list})`,
    ),
  ]);

  // Same selector the board uses, imported rather than re-implemented.
  const { currentMakesafeReceivableInvoicesByJobId } = await import(
    "../supabase/functions/ops-api/makesafe_docs_ready_invoice.ts"
  );
  const invoiceByJob = currentMakesafeReceivableInvoicesByJobId(invoices);

  console.log(
    "Real production rows, derived through this working tree's enrichMakesafeBoardJob.\n",
  );
  let contradictions = 0;
  for (const job of jobs) {
    const detail = details.find((d: any) => d.job_id === job.id) ?? null;
    const report = reports
      .filter((r: any) => r.job_id === job.id)
      .sort((a: any, b: any) =>
        String(b.created_at).localeCompare(String(a.created_at))
      )[0] ?? undefined;
    const pack = packs
      .filter((p: any) => p.job_id === job.id)
      .sort((a: any, b: any) =>
        String(b.created_at).localeCompare(String(a.created_at))
      )[0] ?? null;
    const invoice = invoiceByJob[job.id];

    const row: any = _enrichMakesafeBoardJobForTest(
      job,
      detail,
      [],
      report,
      invoice,
      [],
      false,
      pack,
    );

    const placedByDraft = row.invoice_qualifies_as_current_draft === true;
    const presentsNothing = row.invoice_raw_status == null;
    if (placedByDraft && presentsNothing) contradictions += 1;

    console.log(`=== ${job.job_number}  (${job.site_suburb ?? "?"})`);
    console.log(
      `    reattend_count ............ ${detail?.reattend_count ?? 0}`,
    );
    console.log(
      `    qualifies_as_current_draft ${row.invoice_qualifies_as_current_draft} (${row.invoice_draft_qualification_reason})`,
    );
    console.log(`    invoice_raw_status ....... ${row.invoice_raw_status}`);
    console.log(`    invoice_date ............. ${row.invoice_date}`);
    console.log(`    invoice_created_at ....... ${row.invoice_created_at}`);
    console.log();
  }

  if (contradictions) {
    console.log(
      `DEFECT PRESENT: ${contradictions} card(s) placed by a draft they do not present.`,
    );
    return 1;
  }
  console.log(
    "CLEAN: every card placed by a qualifying draft presents that draft.",
  );
  return 0;
}

const mode = arg("mode", "served");
const code = mode === "derive"
  ? await modeDerive()
  : mode === "served"
  ? await modeServed()
  : (console.error(`unknown --mode=${mode} (served|derive)`), 2);
Deno.exit(code);
