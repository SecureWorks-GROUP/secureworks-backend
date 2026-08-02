#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * SES — record the captain's 2026-08-02 sign-off of SWMS-261059 as evidence.
 *
 * WHAT THIS WRITES: exactly one `makesafe_terminal_proofs` row, for one job.
 * That is the whole authorised write. It does not touch `jobs`,
 * `makesafe_job_details`, `job_assignments`, `job_documents`, `xero_invoices`,
 * `makesafe_board_status_applications`, or any communication path, and it does
 * not go near the money seal — signing a job off is not an invoice action.
 *
 * WHAT IT DOES NOT DO: place the card. The proof is evidence; the stage is
 * derived from it by `ses_stage_engine_v2.ts`. There is deliberately no stage
 * argument here, because a one-off manual stage write on the very card that
 * proves the cutover gate works would hollow the gate out.
 *
 * Shape, following `scripts/apply-ses-c3-suburb-backfill-v1.ts`:
 * - a CLOSED fixture of one job. There is no discovery step, so no card a human
 *   did not adjudicate can be written by this;
 * - every fact is re-derived LIVE at both dry-run and apply time — production
 *   is the data source, the fixture only authorises;
 * - a committed before/after ledger;
 * - `--mode verify` re-reads the row and proves nothing else moved.
 *
 * Reads are Management API `/database/query` with `read_only: true`. The single
 * INSERT is the one statement sent without it, and it carries its own
 * `NOT EXISTS` guard so a re-run writes nothing.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     --allow-write scripts/apply-ses-261059-captain-signoff-v1.ts [--mode dry-run|apply|verify]
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/** The closed fixture. One job, both identifiers, hand-adjudicated. */
const FIXTURE = {
  job_id: "b88809b7-ee6e-497f-a586-25aea586047c",
  job_number: "SWMS-261059",
  /**
   * `kind` is the closed evidence-type vocabulary on the table's CHECK
   * constraint. This closeout happened outside the release flow — manually,
   * through the back end — and the captain verified it against the artifacts on
   * the card. Widening that vocabulary would need a migration and its own
   * ruling; see the report for why no new member was minted here.
   */
  kind: "verified_historical_closeout",
  /**
   * The PRODUCER. `proven_by` is free text precisely so an actor can be named
   * without widening any vocabulary, and this names the ruling rather than a
   * person, so the record stays attributable when people change.
   */
  proven_by: "captain-signoff:2026-08-02-swms-261059-and-draft-invoice",
  decision_ref:
    "decision:data/decisions/2026-08-02-swms-261059-and-draft-invoice.md",
  /** The builder reference the card's invoice carries. Not a client identifier. */
  invoice_reference: "MLB-25857PO-53193",
  invoice_number: "INV-1084",
  /** Document types the captain read on the card, as a set. */
  expected_document_types: ["work_order", "makesafe_report", "swms", "invoice"],
} as const;

type Mode = "dry-run" | "apply" | "verify";

const WRITE_VERBS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment on",
  "copy",
  "call",
  "do ",
  "vacuum",
  "refresh materialized",
];

const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_phone",
  "contact_email",
];

function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error(`refused non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused statement naming write verb "${verb}"`);
    }
  }
}

function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refused statement naming PII column "${column}"`);
    }
  }
}

async function post(sql: string, readOnly: boolean): Promise<any[]> {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-261059-Captain-Signoff/1.0",
    },
    body: JSON.stringify(
      readOnly ? { query: sql, read_only: true } : { query: sql },
    ),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as any).message)
      : `HTTP ${response.status}`;
    throw new Error(`query failed: ${message}`);
  }
  return payload;
}

async function read(sql: string): Promise<any[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  return await post(sql, true);
}

/** Live re-derivation of every fact the write depends on. */
async function observe() {
  const [job] = await read(`
    select id, job_number, type, status, completed_at, org_id,
           ses_money_sealed_at
    from jobs
    where id = '${FIXTURE.job_id}'
  `);
  const cycles = await read(`
    select id from makesafe_attendance_cycles
    where job_id = '${FIXTURE.job_id}'
    order by id asc
  `);
  const detail = (await read(`
    select job_id, substatus, cycle_number, attendance_cycle_id,
           report_received_at, report_sent_at
    from makesafe_job_details
    where job_id = '${FIXTURE.job_id}'
  `))[0] ?? null;
  const documents = await read(`
    select id, type from job_documents
    where job_id = '${FIXTURE.job_id}'
    order by type asc, id asc
  `);
  const linkedInvoices = await read(`
    select id, invoice_number, status from xero_invoices
    where job_id = '${FIXTURE.job_id}'
  `);
  const referencedInvoices = await read(`
    select id, invoice_number, reference, status, invoice_type, invoice_date,
           job_id
    from xero_invoices
    where reference = '${FIXTURE.invoice_reference}'
      and invoice_type = 'ACCREC'
      and upper(status) in ('AUTHORISED', 'SUBMITTED', 'PAID')
    order by invoice_date asc, id asc
  `);
  const existingProofs = await read(`
    select id, kind, proven_by, proven_at from makesafe_terminal_proofs
    where job_id = '${FIXTURE.job_id}'
  `);
  const proofTotal = Number(
    (await read(`select count(*) as n from makesafe_terminal_proofs`))[0]?.n ??
      -1,
  );
  const statusApplications = await read(`
    select id, source_status, after_status, applied_at
    from makesafe_board_status_applications
    where job_id = '${FIXTURE.job_id}'
    order by id asc
  `);
  return {
    job,
    cycles,
    detail,
    documents,
    linkedInvoices,
    referencedInvoices,
    existingProofs,
    proofTotal,
    statusApplications,
  };
}

interface Refusal {
  code: string;
  detail: string;
}

/**
 * Fail-closed preconditions. Every one is a fact about the record, checked
 * against live production rather than against the fixture.
 */
function refusals(o: Awaited<ReturnType<typeof observe>>): Refusal[] {
  const out: Refusal[] = [];
  if (!o.job) {
    out.push({ code: "job_missing", detail: FIXTURE.job_id });
    return out;
  }
  if (String(o.job.job_number) !== FIXTURE.job_number) {
    out.push({
      code: "job_number_mismatch",
      detail: `expected ${FIXTURE.job_number}, found ${o.job.job_number}`,
    });
  }
  if (
    !["complete", "completed", "closed"].includes(
      String(o.job.status || "").toLowerCase(),
    )
  ) {
    out.push({
      code: "job_not_terminally_claimed",
      detail: `jobs.status is ${o.job.status}`,
    });
  }
  if (!o.job.completed_at) {
    out.push({
      code: "completion_timestamp_missing",
      detail: "jobs.completed_at is null, so the proof has no honest clock",
    });
  }
  if (o.cycles.length !== 1) {
    // Not a rule about proofs in general — a proof binds to whatever cycle set
    // it covers. It is a rule about THIS adjudication, which was made on a
    // single-attendance card.
    out.push({
      code: "attendance_cycle_set_changed",
      detail: `expected 1 attendance cycle, found ${o.cycles.length}`,
    });
  }
  const documentTypes = new Set(o.documents.map((d) => String(d.type)));
  for (const type of FIXTURE.expected_document_types) {
    if (!documentTypes.has(type)) {
      out.push({
        code: "adjudicated_document_missing",
        detail:
          `the captain read a ${type} on this card; it is no longer attached`,
      });
    }
  }
  if (o.linkedInvoices.length > 0) {
    // If the mirror ever gets linked, the ordinary corroborated-terminal path
    // covers this card and a sign-off proof is not the right record for it.
    out.push({
      code: "invoice_now_linked",
      detail: "an xero_invoices row now names this job; re-adjudicate",
    });
  }
  const matches = o.referencedInvoices.filter((row) => !row.job_id);
  if (matches.length !== 1) {
    out.push({
      code: "issued_invoice_not_uniquely_observed",
      detail:
        `expected exactly one unlinked issued ACCREC on ${FIXTURE.invoice_reference}, found ${matches.length}`,
    });
  } else if (String(matches[0].invoice_number) !== FIXTURE.invoice_number) {
    out.push({
      code: "invoice_number_mismatch",
      detail: `expected ${FIXTURE.invoice_number}, found ${
        matches[0].invoice_number
      }`,
    });
  }
  if (o.existingProofs.length > 0) {
    out.push({
      code: "terminal_proof_already_recorded",
      detail:
        `${o.existingProofs.length} proof row(s) already exist for this job`,
    });
  }
  return out;
}

function plan(o: Awaited<ReturnType<typeof observe>>) {
  const invoice = o.referencedInvoices.find((row) => !row.job_id) ?? null;
  const evidenceRefs = [
    ...o.documents
      .filter((d) =>
        (FIXTURE.expected_document_types as readonly string[]).includes(
          String(d.type),
        )
      )
      .map((d) => `job_documents:${d.id}`),
    ...(invoice ? [`xero_invoices:${invoice.id}`] : []),
    FIXTURE.decision_ref,
  ];
  return {
    job_id: FIXTURE.job_id,
    job_number: FIXTURE.job_number,
    org_id: o.job?.org_id ?? null,
    kind: FIXTURE.kind,
    attendance_cycle_ids: o.cycles.map((c) => String(c.id)),
    // The closeout time, not the sign-off time: the U2 reconcile writer likewise
    // stamps a proof with when the work actually closed, and the display clock
    // ages the card from it.
    proven_at: o.job?.completed_at ?? null,
    proven_by: FIXTURE.proven_by,
    evidence_refs: evidenceRefs,
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function insertSql(p: ReturnType<typeof plan>): string {
  const cycleArray = `array[${
    p.attendance_cycle_ids.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")
  }]`;
  const refs = `array[${
    p.evidence_refs.map((ref) => sqlLiteral(ref)).join(", ")
  }]::text[]`;
  return `
insert into public.makesafe_terminal_proofs (
  org_id, job_id, kind, attendance_cycle_ids, attendance_cycle_set_hash,
  evidence_refs, proven_by, proven_at
)
select
  ${sqlLiteral(String(p.org_id))}::uuid,
  ${sqlLiteral(p.job_id)}::uuid,
  ${sqlLiteral(p.kind)},
  ${cycleArray},
  public.makesafe_attendance_cycle_set_hash_v1(${cycleArray}),
  to_jsonb(${refs}),
  ${sqlLiteral(p.proven_by)},
  ${sqlLiteral(String(p.proven_at))}::timestamptz
where not exists (
  select 1 from public.makesafe_terminal_proofs existing
  where existing.job_id = ${sqlLiteral(p.job_id)}::uuid
)
returning id, job_id, kind, proven_by, proven_at, attendance_cycle_set_hash
`.trim();
}

async function main(): Promise<void> {
  const mode = (Deno.args.find((a) => a.startsWith("--mode="))?.slice(7) ??
    "dry-run") as Mode;
  if (!["dry-run", "apply", "verify"].includes(mode)) {
    throw new Error(`unknown mode: ${mode}`);
  }
  const before = await observe();
  const blockers = refusals(before);
  const planned = plan(before);

  if (mode === "verify") {
    const proof = before.existingProofs[0] ?? null;
    const ledger = {
      contract: "ses-261059-captain-signoff/v1",
      mode,
      proof_recorded: !!proof,
      proof,
      proof_rows_for_this_job: before.existingProofs.length,
      proof_rows_in_table: before.proofTotal,
      unchanged: {
        job_status: before.job?.status ?? null,
        job_completed_at: before.job?.completed_at ?? null,
        ses_money_sealed_at: before.job?.ses_money_sealed_at ?? null,
        substatus: before.detail?.substatus ?? null,
        linked_invoice_rows: before.linkedInvoices.length,
        board_status_applications: before.statusApplications,
        document_types: before.documents.map((d) => d.type),
      },
    };
    console.log(JSON.stringify(ledger, null, 2));
    if (!proof) throw new Error("verify: no terminal proof recorded");
    if (before.existingProofs.length !== 1) {
      throw new Error("verify: expected exactly one proof row for this job");
    }
    if (before.proofTotal !== 1) {
      throw new Error(
        `verify: expected the ledger to hold exactly the one authorised row, found ${before.proofTotal}`,
      );
    }
    if (before.linkedInvoices.length !== 0) {
      throw new Error("verify: the money mirror must remain unlinked");
    }
    return;
  }

  const ledger: Record<string, unknown> = {
    contract: "ses-261059-captain-signoff/v1",
    mode,
    observed: {
      job_status: before.job?.status ?? null,
      job_completed_at: before.job?.completed_at ?? null,
      ses_money_sealed_at: before.job?.ses_money_sealed_at ?? null,
      substatus: before.detail?.substatus ?? null,
      attendance_cycles: before.cycles.length,
      document_types: before.documents.map((d) => d.type),
      linked_invoice_rows: before.linkedInvoices.length,
      unlinked_issued_invoices_on_reference: before.referencedInvoices
        .filter((row) => !row.job_id)
        .map((row) => ({
          invoice_number: row.invoice_number,
          status: row.status,
          invoice_date: row.invoice_date,
        })),
      terminal_proof_rows_for_this_job: before.existingProofs.length,
      terminal_proof_rows_in_table: before.proofTotal,
      board_status_applications: before.statusApplications,
    },
    refusals: blockers,
    plan: planned,
  };

  if (blockers.length > 0) {
    console.log(JSON.stringify(ledger, null, 2));
    throw new Error(
      `refusing to write: ${blockers.map((b) => b.code).join(", ")}`,
    );
  }
  if (mode === "dry-run") {
    ledger.statement = insertSql(planned);
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }

  const written = await post(insertSql(planned), false);
  if (written.length !== 1) {
    throw new Error(
      `expected exactly one written row, got ${written.length}`,
    );
  }
  const after = await observe();
  ledger.written = written[0];
  ledger.after = {
    terminal_proof_rows_for_this_job: after.existingProofs.length,
    terminal_proof_rows_in_table: after.proofTotal,
    job_status: after.job?.status ?? null,
    ses_money_sealed_at: after.job?.ses_money_sealed_at ?? null,
    substatus: after.detail?.substatus ?? null,
    linked_invoice_rows: after.linkedInvoices.length,
    board_status_applications: after.statusApplications,
  };
  console.log(JSON.stringify(ledger, null, 2));
  if (after.proofTotal !== 1 || after.existingProofs.length !== 1) {
    throw new Error("post-write check failed: exactly one proof row expected");
  }
  if (after.linkedInvoices.length !== 0) {
    throw new Error(
      "post-write check failed: the money mirror must stay unlinked",
    );
  }
  if (String(after.job?.status) !== String(before.job?.status)) {
    throw new Error("post-write check failed: jobs.status moved");
  }
}

if (import.meta.main) await main();
