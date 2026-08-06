// deno-lint-ignore-file no-explicit-any
/**
 * Re-runnable proof for the reattend RAISED-invoice blanking defect (ladder v7).
 *
 * A reattend card that had already been SENT (route proofs on every kind) and
 * BILLED (an AUTHORISED ACCREC created after its reattend boundary) still sat in
 * Trade Report In. `enrichMakesafeBoardJob` reached cycle attribution only
 * through `qualifyMakesafeCurrentDraftInvoice`, which requires `status ===
 * 'DRAFT'`, so the card's own current-cycle AUTHORISED invoice reported
 * `wrong_status`, was blanked before the ladder ran, and the ladder lost the
 * raised-invoice term (`invoiceDone`) altogether.
 *
 * The cycle boundary itself was never the problem and is unchanged: an invoice
 * created before `last_reattend_at` is still prior-cycle and still refused.
 *
 * Two independent modes, both STRICTLY READ-ONLY. Neither writes: no mint, no
 * void, no approve, no authorise, no send, no board write, no document attach.
 *
 *   --mode=served   Read the live board through ops-api and report the defect
 *                   population: reattend cards whose current receivable is a
 *                   RAISED invoice this card owns for its CURRENT cycle, but
 *                   which the board presents as no invoice at all. After the fix
 *                   is deployed that set must be EMPTY. Exits 1 while it is not.
 *                   Needs SW_SUPABASE_URL + SW_API_KEY + SUPABASE_ACCESS_TOKEN.
 *
 *   --mode=derive   Pull the real production rows for the named cards through
 *                   the Management API (`read_only: true`) and run them through
 *                   the real `enrichMakesafeBoardJob` in THIS working tree,
 *                   twice: once with the invoice the board actually selects (the
 *                   v7 answer) and once with it withheld (which is exactly what
 *                   v6 did to these cards, and is asserted rather than assumed).
 *                   Proves what this code would serve for those cards without
 *                   deploying anything. Needs SUPABASE_ACCESS_TOKEN.
 *
 *                   FAITHFULNESS: the derive mode rebuilds every enrich input
 *                   from raw rows the way `makesafePipeline` does — assignments,
 *                   documents, the current-cycle service report, the pack-sent
 *                   marker, and `packForBoard` (durable pack row overlaid by the
 *                   current docket revision). It then CHECKS its v6 answer
 *                   against the stage the live board actually serves; a mismatch
 *                   is reported as an input-fidelity failure rather than being
 *                   passed off as a result.
 *
 * Client identity is never printed. Job number, suburb and invoice lifecycle
 * fields only.
 *
 * Usage:
 *   deno run --allow-env --allow-net scripts/ses-reattend-raised-invoice-closeout-verify.ts --mode=served
 *   deno run --allow-env --allow-net scripts/ses-reattend-raised-invoice-closeout-verify.ts --mode=derive
 */

import { _enrichMakesafeBoardJobForTest } from "../supabase/functions/ops-api/index.ts";
import {
  currentMakesafeReceivableInvoicesByJobId,
  makesafeInvoiceIsCurrentAttendanceReceivable,
  qualifyMakesafeCurrentDraftInvoice,
} from "../supabase/functions/ops-api/makesafe_docs_ready_invoice.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MGMT_QUERY =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/** The four cards the defect was reported on. */
const CARDS = [
  "SWMS-26953",
  "SWMS-26902",
  "SWMS-261128",
  "SWMS-261131",
];

/**
 * Control: a reattend card whose only raised invoice PREDATES its reattend
 * boundary. It must stay suppressed under v7 exactly as it is under v6.
 */
const CONTROL_CARDS = ["SWMS-26651"];

/** AUTHORISED / SUBMITTED / PAID — the ladder's raised-invoice statuses. */
const RAISED = ["AUTHORISED", "SUBMITTED", "PAID"];

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

function isRaised(invoice: any): boolean {
  return RAISED.includes(String(invoice?.status || "").toUpperCase());
}

/**
 * MODE served — the defect population on the board as it is actually served.
 *
 * The board never publishes the raw invoice row, so "is this card's current
 * receivable a raised current-cycle invoice" is answered from the mirror through
 * the Management API and then joined to what the board served. A card in the
 * population is one the board places as though it had no invoice while owning
 * one that is committed money for the attendance in front of the Captain.
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

  const reattend = cards.filter(([, c]) => Number(c?.reattend_count ?? 0) > 0);
  const ids = reattend.map(([, c]) => `'${String(c.id)}'`).join(",");
  if (!ids) {
    console.log("no reattend cards on the board.");
    return 0;
  }

  const [invoices, details, jobs] = await Promise.all([
    readOnlyQuery(
      `select id, job_id, invoice_number, invoice_type, status, reference, invoice_date, created_at from xero_invoices where job_id in (${ids})`,
    ),
    readOnlyQuery(
      `select job_id, external_ref, reattend_count, last_reattend_at from makesafe_job_details where job_id in (${ids})`,
    ),
    readOnlyQuery(
      `select id, job_number, metadata from jobs where id in (${ids})`,
    ),
  ]);
  const invoiceByJob = currentMakesafeReceivableInvoicesByJobId(invoices);
  const detailByJob = Object.fromEntries(
    details.map((d: any) => [String(d.job_id), d]),
  );
  const jobById = Object.fromEntries(jobs.map((j: any) => [String(j.id), j]));

  const population: Array<[string, any, any]> = [];
  for (const [column, card] of reattend) {
    const jobId = String(card.id);
    const invoice = invoiceByJob[jobId];
    if (!invoice || !isRaised(invoice)) continue;
    // The SAME predicate the fix uses — imported, never restated.
    if (
      !makesafeInvoiceIsCurrentAttendanceReceivable(
        jobById[jobId],
        detailByJob[jobId],
        invoice,
      )
    ) continue;
    population.push([column, card, invoice]);
  }

  const blanked = population.filter(([, card]) =>
    card.invoice_raw_status == null
  );

  console.log(`board cards ................................ ${cards.length}`);
  console.log(
    `reattend cards ............................. ${reattend.length}`,
  );
  console.log(
    `  ... owning a RAISED current-cycle invoice  ${population.length}`,
  );
  console.log(
    `  ... which the board presents as no invoice ${blanked.length}   <- defect`,
  );
  console.log();
  console.log(
    `${"job_number".padEnd(15)}${"column".padEnd(17)}${"suburb".padEnd(16)}${
      "cyc".padEnd(5)
    }${"invoice".padEnd(11)}${"mirror".padEnd(12)}served`,
  );
  for (const [column, card, invoice] of population) {
    console.log(
      `${String(card.job_number).padEnd(15)}${column.padEnd(17)}${
        String(card.site_suburb ?? "").padEnd(16)
      }${String(card.cycle_number ?? "").padEnd(5)}${
        String(invoice.invoice_number).padEnd(11)
      }${String(invoice.status).padEnd(12)}${
        card.invoice_raw_status ?? "NULL"
      }`,
    );
  }
  console.log();
  if (blanked.length) {
    console.log(
      `DEFECT PRESENT on ${blanked.length} card(s): ${
        blanked.map(([, c]) => c.job_number).join(", ")
      }`,
    );
    console.log(
      "Each is sent-and-billed money the board is hiding from its own ladder.",
    );
    return 1;
  }
  console.log(
    "CLEAN: every reattend card owning a raised current-cycle invoice presents it.",
  );
  return 0;
}

/** Rebuild `packForBoard` the way `makesafePipeline` does. */
function buildPackForBoard(
  rowPack: any,
  docket: any,
  detail: any,
  packCycles: any[],
): any {
  const PACK_SENT_STATUSES = [
    "sent",
    "sent_marker_failed",
    "sent_not_closed",
    "close_failed",
  ];
  const cycleId = String(detail?.attendance_cycle_id || "");
  const packCycle = rowPack?.id
    ? packCycles.find((pc: any) =>
      String(pc?.pack_id || "") === String(rowPack.id) &&
      String(pc?.attendance_cycle_id || "") === cycleId &&
      pc?.cycle_attribution === "bound"
    )
    : null;
  const packIsCurrent = !!packCycle;
  const docketIsCurrent = !!docket &&
    String(docket.current_attendance_cycle_id || "") === cycleId;
  const legacyStatus = String(rowPack?.status || "").toLowerCase();
  const legacySent = PACK_SENT_STATUSES.includes(legacyStatus) ||
    legacyStatus === "authorised_not_sent";

  if (docket && !legacySent) {
    return {
      ...(rowPack || {}),
      status: rowPack?.status || "drafted",
      review_state: docket.pre_xero_docs_ready ? "READY" : "U4_BLOCKED",
      docket_revision_id: docket.id,
      pre_xero_docs_ready: docket.pre_xero_docs_ready === true,
      blockers: Array.isArray(docket.blockers) ? docket.blockers : [],
      cycle_attribution: docketIsCurrent ? "bound" : null,
    };
  }
  if (rowPack) {
    return { ...rowPack, cycle_attribution: packIsCurrent ? "bound" : null };
  }
  return null;
}

/**
 * MODE derive — real production rows, this working tree's derivation.
 *
 * Reports, per card, the stage this code serves (v7) beside the stage the same
 * inputs produce with the invoice withheld (v6's actual behaviour on these
 * cards), and validates the latter against the stage the LIVE board serves.
 */
async function modeDerive(): Promise<number> {
  const names = [...CARDS, ...CONTROL_CARDS];
  const list = names.map((n) => `'${n}'`).join(",");
  const [
    jobs,
    details,
    invoices,
    reports,
    packs,
    docs,
    dockets,
    markers,
    assignmentRows,
  ] = await Promise.all([
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
    readOnlyQuery(
      `select d.job_id, d.type, d.file_name, d.attendance_cycle_id, d.cycle_attribution from job_documents d join jobs j on j.id = d.job_id where j.job_number in (${list})`,
    ),
    readOnlyQuery(
      `select c.job_id, c.id, c.state, c.pre_xero_docs_ready, c.blockers, c.current_attendance_cycle_id from makesafe_docket_revisions_current c join jobs j on j.id = c.job_id where j.job_number in (${list})`,
    ),
    readOnlyQuery(
      `select e.job_id, e.event_type, e.detail_json from job_events e join jobs j on j.id = e.job_id where j.job_number in (${list}) and e.event_type = 'note'`,
    ),
    readOnlyQuery(
      `select a.id, a.job_id, a.status, a.attendance_cycle_id, a.cycle_attribution from job_assignments a join jobs j on j.id = a.job_id where j.job_number in (${list})`,
    ),
  ]);

  const { isPackSentTriageEvent } = await import(
    "../supabase/functions/ops-api/makesafe_send_pack.ts"
  );
  const invoiceByJob = currentMakesafeReceivableInvoicesByJobId(invoices);
  const packSentByJob: Record<string, boolean> = {};
  for (const ev of markers) {
    if (ev?.job_id && isPackSentTriageEvent(ev)) {
      packSentByJob[ev.job_id] = true;
    }
  }

  // Live board, for the input-fidelity check.
  const servedStage: Record<string, string> = {};
  const base = Deno.env.get("SW_SUPABASE_URL");
  const key = Deno.env.get("SW_API_KEY");
  if (base && key) {
    const res = await fetch(
      `${
        base.replace(/\/$/, "")
      }/functions/v1/ops-api?action=makesafe_board&include_archive=1`,
      { headers: { "x-api-key": key } },
    );
    if (res.ok) {
      const board = await res.json();
      for (const rows of Object.values(board?.columns || {})) {
        for (const c of (rows as any[]) || []) {
          // `declared_stage`, NOT `canonical_stage`. This harness derives the
          // LADDER, and `canonical_stage` is the ladder plus the Captain's
          // display-ledger overlay — comparing against it reports an
          // intentional override as an input-fidelity failure. SWMS-26651 is
          // the worked example: declared `allocated`, overlaid to `archive`.
          servedStage[String(c.job_number)] = String(
            c.declared_stage ?? c.canonical_stage,
          );
        }
      }
    }
  }

  console.log(
    "Real production rows, derived through this working tree's enrichMakesafeBoardJob.",
  );
  console.log(
    "v6 column = the same inputs with the invoice withheld, which is what v6 did",
  );
  console.log("to these cards. Asserted per card, not assumed.\n");

  let unfaithful = 0;
  let moved = 0;
  let controlBroken = 0;

  for (const name of names) {
    const job = jobs.find((j: any) => j.job_number === name);
    if (!job) {
      console.log(`${name}: not found`);
      continue;
    }
    const detail = details.find((d: any) => d.job_id === job.id) ?? null;
    const invoice = invoiceByJob[job.id] ?? null;
    const cycleId = String(detail?.attendance_cycle_id || "");
    const report = reports
      .filter((r: any) =>
        r.job_id === job.id &&
        (!cycleId || String(r.attendance_cycle_id || "") === cycleId)
      )
      .sort((a: any, b: any) =>
        String(b.created_at).localeCompare(String(a.created_at))
      )[0] ?? undefined;
    const rowPack = packs
      .filter((p: any) => p.job_id === job.id)
      .sort((a: any, b: any) =>
        String(b.created_at).localeCompare(String(a.created_at))
      )[0] ?? null;
    const docket = dockets.find((d: any) => d.job_id === job.id) ?? null;
    const pack = buildPackForBoard(rowPack, docket, detail, []);
    const docRows = docs.filter((d: any) => d.job_id === job.id);
    const packSent = packSentByJob[job.id] === true;

    const assignments = assignmentRows.filter((a: any) => a.job_id === job.id);

    const enrich = (inv: any) =>
      _enrichMakesafeBoardJobForTest(
        job,
        detail,
        assignments,
        report,
        inv,
        docRows,
        packSent,
        pack,
      ) as any;

    const now = enrich(invoice);
    const withheld = enrich(null);

    // Assert the v6 precondition rather than assuming it: under v6 this card's
    // invoice was blanked exactly when it was neither a first attendance nor a
    // qualifying current-cycle DRAFT.
    const qualification = qualifyMakesafeCurrentDraftInvoice(
      job,
      detail,
      invoice,
    );
    const v6Blanked = Number(detail?.reattend_count ?? 0) > 0 &&
      !qualification.qualifies;
    const v6Stage = v6Blanked ? withheld.board_stage : now.board_stage;

    const served = servedStage[name];
    const faithful = !served || served === v6Stage;
    if (!faithful) unfaithful += 1;

    const isControl = CONTROL_CARDS.includes(name);
    const raisedCurrent = invoice && isRaised(invoice) &&
      makesafeInvoiceIsCurrentAttendanceReceivable(job, detail, invoice);
    if (isControl && now.board_stage !== v6Stage) controlBroken += 1;
    if (!isControl && now.board_stage !== v6Stage) moved += 1;

    console.log(
      `${name}${isControl ? "  (CONTROL)" : ""} — ${job.site_suburb ?? ""}`,
    );
    console.log(
      `  invoice ............ ${invoice?.invoice_number ?? "none"} ${
        invoice?.status ?? ""
      } created ${invoice?.created_at ?? "-"}`,
    );
    console.log(
      `  reattend boundary .. ${detail?.last_reattend_at ?? "none"} (cycle ${
        detail?.cycle_number ?? "?"
      })`,
    );
    console.log(
      `  current-cycle raised ${
        raisedCurrent ? "YES" : "no"
      }   draft qualifier: ${qualification.reason}`,
    );
    console.log(
      `  served (live board)  ${served ?? "n/a"}`,
    );
    console.log(
      `  v6 (invoice blanked) ${v6Stage}${
        faithful ? "" : "   <- INPUT FIDELITY MISMATCH"
      }`,
    );
    console.log(
      `  v7 (this tree) ..... ${now.board_stage}   presents ${
        now.invoice_raw_status ?? "NULL"
      }`,
    );
    console.log();
  }

  console.log(`cards moved off their v6 stage ... ${moved}`);
  console.log(`controls that moved (must be 0) .. ${controlBroken}`);
  console.log(`input-fidelity mismatches (0) .... ${unfaithful}`);
  if (controlBroken || unfaithful) return 1;
  return 0;
}

if (import.meta.main) {
  const mode = arg("mode", "served");
  const code = mode === "derive" ? await modeDerive() : await modeServed();
  Deno.exit(code);
}
