// deno-lint-ignore-file no-explicit-any
/**
 * Privileged recorder for `makesafe_terminal_proofs` rows.
 *
 * WHY THIS EXISTS
 * ---------------
 * Release 12 places the board from evidence. A card that was already billed and
 * sent under a sibling bundle (SWMS-26832 / INV-0835 on SWMS-26837) never grows
 * its own ACCREC or SES docket, so the U2 reconcile writer — which only mints
 * `verified_historical_closeout` from an OWN sent pack + OWN AUTHORISED/PAID
 * invoice — never covers it. The durable sibling binding already exists
 * (U7 / `makesafe_sibling_bundle_binding_revisions`); what was missing is an
 * agent-callable closeout path that records the same evidence contract the
 * stage engine already reads (SWMS-261059 pattern), without minting a second
 * invoice and without inventing a stage write.
 *
 * A second class — intentional assessment-only / no-invoice closeout
 * (SWMS-26791) — needs the already-sealed `approved_nonwork_archive` kind.
 * Substatus `complete` alone never places Archive under R12 (job status stays
 * processing; no issued invoice corroborates a raw terminal claim). Funding is
 * the privileged caller naming `kind=approved_nonwork_archive` against sealed
 * assessment family + complete substatus + zero active own ACCREC — never a
 * freeform triage note (same bar as #754). It never invents portal captures or
 * money.
 *
 * Standing law: an internal bookkeeping gap must not wall the captain. This
 * action records evidence; `ses_stage_engine_v2` then DERIVES archive/completed.
 * It never sends, never mints, never rewrites jobs/substatus/money, and never
 * widens the closed `kind` vocabulary (both recordable kinds already exist on
 * the table CHECK).
 *
 * Dry-run is the DEFAULT. A live write must be asked for explicitly.
 */

import {
  makesafeAttendanceCycleSetHash,
  MAKESAFE_TERMINAL_PROOF_KINDS,
  type MakesafeTerminalProofKind,
} from "./makesafe_terminal_proof.ts";
import {
  isBundledCoverageSendNote,
  isPackSentMainEvent,
  isPackSentTriageEvent,
} from "./makesafe_send_pack.ts";

export class RecordTerminalProofRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RecordTerminalProofRequestError";
  }
}

export class RecordTerminalProofConflictError extends Error {
  readonly status = 409;
  readonly code: string;
  readonly evidence?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    evidence?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RecordTerminalProofConflictError";
    this.code = code;
    this.evidence = evidence;
  }
}

/** Closed set this action may write. Release closeout stays on the send path. */
export const RECORDABLE_TERMINAL_PROOF_KINDS = [
  "verified_historical_closeout",
  "approved_nonwork_archive",
] as const satisfies readonly MakesafeTerminalProofKind[];

export type RecordableTerminalProofKind =
  typeof RECORDABLE_TERMINAL_PROOF_KINDS[number];

const RAISED_INVOICE_STATUSES = new Set(["AUTHORISED", "PAID", "SUBMITTED"]);

/** Sealed assessment family tokens only — never report_type alone. */
const ASSESSMENT_FAMILY_TOKENS = new Set([
  "assessment_report_quote",
  "assessment",
  "assessment_quote",
]);

/**
 * Assessment non-work archive is family-gated off the sealed
 * `jobs.metadata.makesafe_job_family` field. `report_type` may corroborate in
 * evidence refs but must never sole-qualify a physical card.
 */
export function isAssessmentNonworkFamily(input: {
  makesafe_job_family?: string | null;
  report_type?: string | null;
}): boolean {
  const family = text(input.makesafe_job_family).toLowerCase().replace(
    /[\s-]+/g,
    "_",
  );
  if (!family) return false;
  if (ASSESSMENT_FAMILY_TOKENS.has(family)) return true;
  // Exact sealed assessment* family only — not a report_type substring, and
  // not a loose includes() over unrelated tokens that happen to contain the
  // word (e.g. a future "pre_assessment_physical" invent).
  return false;
}

function badRequest(message: string): Error {
  return new RecordTerminalProofRequestError(message);
}

function conflict(
  code: string,
  message: string,
  evidence?: Record<string, unknown>,
): Error {
  return new RecordTerminalProofConflictError(code, message, evidence);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function asIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function eventNoteText(ev: any): string {
  const detail = ev?.detail_json;
  if (detail && typeof detail === "object") {
    return text(detail.text || detail.note || "");
  }
  return text(ev?.detail || "");
}

function asNoteEvent(ev: { text: string }) {
  return { event_type: "note", detail_json: { text: ev.text } };
}

/**
 * proven_at is derived only from observed evidence. A caller may echo one of
 * those instants; inventing a different clock (or falling back to "now") is
 * refused — the stage engine ages Archive off this field.
 */
function resolveObservedProvenAt(input: {
  callerProvenAt: string | null | undefined;
  candidates: ReadonlyArray<unknown>;
}): string {
  const ordered: string[] = [];
  for (const candidate of input.candidates) {
    const iso = asIso(candidate);
    if (iso && !ordered.includes(iso)) ordered.push(iso);
  }
  if (ordered.length === 0) {
    throw conflict(
      "proven_at_unresolvable",
      "No observed pack-sent, invoice, or binding timestamp is available to stamp proven_at.",
    );
  }
  const caller = asIso(input.callerProvenAt);
  if (caller) {
    if (!ordered.includes(caller)) {
      throw conflict(
        "proven_at_not_observed",
        "proven_at must equal an observed pack-sent, invoice, or binding timestamp.",
        { caller_proven_at: caller, observed: ordered },
      );
    }
    return caller;
  }
  return ordered[0];
}

export interface SiblingBindingRow {
  id?: string | null;
  job_id?: string | null;
  sibling_job_id?: string | null;
  bundle_id?: string | null;
  org_id?: string | null;
  state?: string | null;
  recorded_at?: string | null;
}

export interface SiblingInvoiceRow {
  id?: string | null;
  job_id?: string | null;
  invoice_number?: string | null;
  status?: string | null;
  invoice_type?: string | null;
  invoice_date?: string | null;
  fully_paid_on?: string | null;
}

export interface RecordTerminalProofObservation {
  job: {
    id: string;
    org_id: string;
    job_number: string | null;
    type: string | null;
    status: string | null;
  };
  cycle_ids: string[];
  existing_proofs: Array<{
    id: string;
    kind: string | null;
    attendance_cycle_set_hash: string | null;
  }>;
  own_raised_invoices: SiblingInvoiceRow[];
  pack_sent_events: Array<{ id?: string | null; created_at?: string | null; text: string }>;
  pack_sent_at: string | null;
  outbound_bindings: SiblingBindingRow[];
  reverse_bindings: SiblingBindingRow[];
  sibling_raised_invoices: SiblingInvoiceRow[];
  /** makesafe_job_details overlay facts for the non-work archive path. */
  substatus: string | null;
  makesafe_job_family: string | null;
  report_type: string | null;
  /** Observed instant when substatus moved to complete (event created_at). */
  substatus_complete_at: string | null;
}

export type RecordTerminalProofPath =
  | "own_raised_invoice"
  | "sibling_bundle"
  | "intentional_no_invoice_complete";

export interface RecordTerminalProofPlan {
  path: RecordTerminalProofPath;
  job_id: string;
  org_id: string;
  job_number: string | null;
  kind: RecordableTerminalProofKind;
  attendance_cycle_ids: string[];
  attendance_cycle_set_hash: string;
  evidence_refs: string[];
  proven_by: string;
  proven_at: string;
  sibling_job_id: string | null;
  sibling_invoice_number: string | null;
  sibling_invoice_id: string | null;
  binding_revision_id: string | null;
  reverse_binding_revision_id: string | null;
}

function isRaisedAccrec(row: SiblingInvoiceRow | null | undefined): boolean {
  if (!row) return false;
  const type = text(row.invoice_type).toUpperCase();
  if (type && type !== "ACCREC") return false;
  return RAISED_INVOICE_STATUSES.has(text(row.status).toUpperCase());
}

/**
 * Any live own ACCREC (DRAFT included). A DRAFT proves invoicing already
 * started — archiving as "no invoice to raise" while it sits unpaid hides
 * owed money. Mirrors hasActiveMakesafeInvoice (non-VOIDED/DELETED).
 */
function isActiveAccrec(row: SiblingInvoiceRow | null | undefined): boolean {
  if (!row) return false;
  const type = text(row.invoice_type).toUpperCase();
  if (type && type !== "ACCREC") return false;
  const status = text(row.status).toUpperCase();
  if (!status) return false;
  return !["VOIDED", "DELETED"].includes(status);
}

function currentBoundOutbound(
  rows: readonly SiblingBindingRow[],
  jobId: string,
): SiblingBindingRow[] {
  return (rows || []).filter((row) =>
    text(row.job_id) === jobId && text(row.state).toLowerCase() === "bound"
  );
}

function matchingReverse(
  reverseRows: readonly SiblingBindingRow[],
  outbound: SiblingBindingRow,
): SiblingBindingRow | null {
  return (reverseRows || []).find((row) =>
    text(row.job_id) === text(outbound.sibling_job_id) &&
    text(row.sibling_job_id) === text(outbound.job_id) &&
    text(row.org_id) === text(outbound.org_id) &&
    text(row.bundle_id) === text(outbound.bundle_id) &&
    text(row.state).toLowerCase() === "bound"
  ) || null;
}

/**
 * Planner: given live observations, either return a write plan or throw a typed
 * refusal. Never invents a sibling, invoice, send, or completion clock.
 * Async so the cycle-set hash (U2 semantics) is known before the already-recorded
 * gate — a superseded proof for an older cycle set must not wall a covering write.
 */
export async function planMakesafeTerminalProofRecord(input: {
  observation: RecordTerminalProofObservation;
  proven_by: string;
  kind?: string | null;
  proven_at?: string | null;
  extra_evidence_refs?: readonly string[] | null;
  sibling_job_id?: string | null;
  sibling_invoice_number?: string | null;
}): Promise<RecordTerminalProofPlan> {
  const provenBy = text(input.proven_by);
  if (!provenBy) throw badRequest("proven_by is required");

  const kindRaw = text(input.kind) || "verified_historical_closeout";
  if (
    !(RECORDABLE_TERMINAL_PROOF_KINDS as readonly string[]).includes(kindRaw)
  ) {
    throw badRequest(
      `kind must be one of: ${RECORDABLE_TERMINAL_PROOF_KINDS.join(", ")}`,
    );
  }
  if (!(MAKESAFE_TERMINAL_PROOF_KINDS as readonly string[]).includes(kindRaw)) {
    throw badRequest(`unrecognised terminal proof kind: ${kindRaw}`);
  }
  const kind = kindRaw as RecordableTerminalProofKind;

  // Caller may not invent citations; the recorder stamps only observed refs.
  const callerRefs = (input.extra_evidence_refs || [])
    .map((r) => text(r))
    .filter(Boolean);
  if (callerRefs.length > 0) {
    throw badRequest(
      "caller evidence_refs are not accepted; the recorder cites only observed evidence",
    );
  }

  const job = input.observation.job;
  if (!job?.id || !job.org_id) {
    throw conflict("job_missing", "The named job could not be loaded.");
  }
  const jobType = text(job.type).toLowerCase();
  if (jobType && jobType !== "makesafe" && jobType !== "insurance") {
    throw conflict("job_not_ses", "Terminal proofs are SES cards only.", {
      type: job.type,
    });
  }
  const status = text(job.status).toLowerCase();
  if (["cancelled", "canceled", "lost", "deleted"].includes(status)) {
    throw conflict(
      "job_terminal_cancelled",
      "A cancelled card does not take a historical closeout proof.",
      { status: job.status },
    );
  }

  const cycleIds = [...new Set(
    (input.observation.cycle_ids || []).map((id) => text(id)).filter(Boolean),
  )].sort();
  if (cycleIds.length === 0) {
    throw conflict(
      "attendance_cycle_missing",
      "No attendance cycle is bound on this card, so a cycle-set proof cannot be recorded.",
    );
  }

  const cycleSetHash = await makesafeAttendanceCycleSetHash(cycleIds);

  // U2 reconcile semantics: refuse only a same-kind proof that already covers
  // THIS cycle-set hash. A re-attendance changes the set; the old proof stops
  // covering and must not block a fresh covering write.
  const coveringExisting = (input.observation.existing_proofs || []).filter(
    (row) =>
      text(row.kind) === kind &&
      text(row.attendance_cycle_set_hash) === cycleSetHash,
  );
  if (coveringExisting.length > 0) {
    throw conflict(
      "terminal_proof_already_recorded",
      "A verified historical closeout proof is already recorded for this attendance-cycle set.",
      {
        proof_ids: coveringExisting.map((row) => row.id),
        attendance_cycle_set_hash: cycleSetHash,
      },
    );
  }

  const allNoteEvents = input.observation.pack_sent_events || [];
  const ownRaised = (input.observation.own_raised_invoices || []).filter(
    (row) => isRaisedAccrec(row) && text(row.job_id) === job.id,
  );

  // Path 0 — intentional assessment-only / no-invoice complete (SWMS-26791).
  // Caller must name kind=approved_nonwork_archive explicitly. That privileged
  // stamp is the durable captain decision — freeform notes never fund it
  // (same bar as #754). Never selected as the default verified_historical
  // closeout path.
  if (kind === "approved_nonwork_archive") {
    const ownActive = (input.observation.own_raised_invoices || []).filter(
      (row) => isActiveAccrec(row) && text(row.job_id) === job.id,
    );
    if (ownActive.length > 0) {
      throw conflict(
        "own_active_invoice_present",
        "This card already has a live ACCREC (including DRAFT); use verified_historical_closeout or resolve the invoice, not approved_nonwork_archive.",
        {
          own_invoice_numbers: ownActive.map((row) => text(row.invoice_number)),
          own_invoice_statuses: ownActive.map((row) => text(row.status)),
        },
      );
    }
    if (
      !isAssessmentNonworkFamily({
        makesafe_job_family: input.observation.makesafe_job_family,
        report_type: input.observation.report_type,
      })
    ) {
      throw conflict(
        "nonwork_family_not_assessment",
        "approved_nonwork_archive is only for sealed assessment/quote family cards.",
        {
          makesafe_job_family: input.observation.makesafe_job_family,
          report_type: input.observation.report_type,
        },
      );
    }
    if (text(input.observation.substatus).toLowerCase() !== "complete") {
      throw conflict(
        "substatus_not_complete",
        "approved_nonwork_archive requires makesafe_job_details.substatus=complete.",
        { substatus: input.observation.substatus },
      );
    }
    const provenAt = resolveObservedProvenAt({
      callerProvenAt: input.proven_at,
      candidates: [input.observation.substatus_complete_at],
    });
    const family = text(input.observation.makesafe_job_family);
    const refs = [
      "terminal_proof_kind:approved_nonwork_archive",
      ...(asIso(input.observation.substatus_complete_at)
        ? ["makesafe_job_details:substatus=complete"]
        : []),
      `makesafe_job_family:${family}`,
    ];
    return {
      path: "intentional_no_invoice_complete",
      job_id: job.id,
      org_id: job.org_id,
      job_number: job.job_number,
      kind,
      attendance_cycle_ids: cycleIds,
      attendance_cycle_set_hash: cycleSetHash,
      evidence_refs: [...new Set(refs.filter(Boolean))],
      proven_by: provenBy,
      proven_at: provenAt,
      sibling_job_id: null,
      sibling_invoice_number: null,
      sibling_invoice_id: null,
      binding_revision_id: null,
      reverse_binding_revision_id: null,
    };
  }

  const packRowSentAt = asIso(input.observation.pack_sent_at);
  // Canonical main marker — irreversible-action grade (own path / U2 shape).
  const canonicalPackSentEvents = allNoteEvents.filter((ev) =>
    isPackSentMainEvent(asNoteEvent(ev))
  );
  // Board-triage set (canonical OR bundled-coverage note) — sibling path only.
  const triagePackSentEvents = allNoteEvents.filter((ev) =>
    isPackSentTriageEvent(asNoteEvent(ev))
  );

  // Path 1 — own raised invoice (the U2 reconcile shape, callable here too).
  if (ownRaised.length === 1 && !text(input.sibling_job_id)) {
    // Own path may NOT elevate a triage-only freeform note into closeout
    // evidence. Require a sent pack row or a canonical MAKESAFE_PACK_SENT marker.
    const ownPackSentAt = packRowSentAt ||
      asIso(canonicalPackSentEvents[0]?.created_at);
    if (!ownPackSentAt && canonicalPackSentEvents.length === 0) {
      throw conflict(
        "pack_send_evidence_missing",
        "Own-invoice closeout requires a sent pack or canonical MAKESAFE_PACK_SENT marker; a triage-only bundled note is not enough.",
      );
    }
    const invoice = ownRaised[0];
    const provenAt = resolveObservedProvenAt({
      callerProvenAt: input.proven_at,
      candidates: [
        ownPackSentAt,
        invoice.fully_paid_on,
        invoice.invoice_date,
      ],
    });
    const refs = [
      `xero_invoices:${text(invoice.id)}`,
      `xero_invoice_number:${text(invoice.invoice_number)}`,
      ...canonicalPackSentEvents.slice(0, 1).map((ev) =>
        ev.id ? `job_events:${text(ev.id)}` : "pack_sent:main_marker"
      ),
      ...(packRowSentAt && canonicalPackSentEvents.length === 0
        ? ["pack_sent:report_pack_sent_at"]
        : []),
    ];
    return {
      path: "own_raised_invoice",
      job_id: job.id,
      org_id: job.org_id,
      job_number: job.job_number,
      kind,
      attendance_cycle_ids: cycleIds,
      attendance_cycle_set_hash: cycleSetHash,
      evidence_refs: [...new Set(refs.filter(Boolean))],
      proven_by: provenBy,
      proven_at: provenAt,
      sibling_job_id: null,
      sibling_invoice_number: text(invoice.invoice_number) || null,
      sibling_invoice_id: text(invoice.id) || null,
      binding_revision_id: null,
      reverse_binding_revision_id: null,
    };
  }

  // Path 2 — sibling bundle: reciprocal binding + sibling raised ACCREC.
  // Bundled-coverage triage notes are allowed here as ONE leg beside the
  // binding and the sibling raised invoice — never alone, never on the own path.
  const siblingPackSentAt = packRowSentAt ||
    asIso(triagePackSentEvents[0]?.created_at);
  if (!siblingPackSentAt && triagePackSentEvents.length === 0) {
    throw conflict(
      "pack_send_evidence_missing",
      "No pack-sent marker (canonical or bundled-coverage) is recorded on this card.",
    );
  }

  const requestedSibling = text(input.sibling_job_id);
  const outboundAll = currentBoundOutbound(
    input.observation.outbound_bindings,
    job.id,
  );
  const outbound = requestedSibling
    ? outboundAll.filter((row) => text(row.sibling_job_id) === requestedSibling)
    : outboundAll;
  if (outbound.length === 0) {
    throw conflict(
      "sibling_binding_missing",
      "No current bound sibling-bundle binding covers this card.",
      {
        requested_sibling_job_id: requestedSibling || null,
        own_raised_invoice_count: ownRaised.length,
      },
    );
  }
  if (outbound.length > 1) {
    throw conflict(
      "multiple_sibling_bindings",
      "Multiple current sibling bindings exist; name sibling_job_id explicitly.",
      {
        sibling_job_ids: outbound.map((row) => text(row.sibling_job_id)).sort(),
      },
    );
  }
  const binding = outbound[0];
  const reverse = matchingReverse(
    input.observation.reverse_bindings,
    binding,
  );
  if (!reverse) {
    throw conflict(
      "sibling_binding_not_bidirectional",
      "The sibling binding is not reciprocal, so it cannot fund a closeout proof.",
      { binding_revision_id: text(binding.id) },
    );
  }

  const siblingId = text(binding.sibling_job_id);
  const requestedInvoice = text(input.sibling_invoice_number).toUpperCase();
  let siblingInvoices = (input.observation.sibling_raised_invoices || []).filter(
    (row) =>
      isRaisedAccrec(row) && text(row.job_id) === siblingId,
  );
  if (requestedInvoice) {
    siblingInvoices = siblingInvoices.filter((row) =>
      text(row.invoice_number).toUpperCase() === requestedInvoice
    );
  }
  if (siblingInvoices.length === 0) {
    throw conflict(
      "sibling_raised_invoice_missing",
      "No AUTHORISED/PAID sibling ACCREC is available to cite as closeout evidence.",
      {
        sibling_job_id: siblingId,
        requested_invoice_number: requestedInvoice || null,
      },
    );
  }
  if (siblingInvoices.length > 1) {
    throw conflict(
      "sibling_raised_invoice_ambiguous",
      "Multiple raised sibling invoices match; name sibling_invoice_number explicitly.",
      {
        invoice_numbers: siblingInvoices.map((row) =>
          text(row.invoice_number)
        ).sort(),
      },
    );
  }
  const siblingInvoice = siblingInvoices[0];

  // Bundled path refuses when THIS card already carries its own raised ACCREC —
  // that would be a second money story, and the own-invoice path should be used
  // (or the card re-adjudicated). Never mint a second invoice here either.
  if (ownRaised.length > 0) {
    throw conflict(
      "own_raised_invoice_present",
      "This card already has its own raised ACCREC; do not record a sibling-bundled closeout proof over it.",
      {
        own_invoice_numbers: ownRaised.map((row) => text(row.invoice_number)),
      },
    );
  }

  const provenAt = resolveObservedProvenAt({
    callerProvenAt: input.proven_at,
    candidates: [
      siblingPackSentAt,
      siblingInvoice.fully_paid_on,
      siblingInvoice.invoice_date,
      binding.recorded_at,
    ],
  });

  const refs = [
    `makesafe_sibling_bundle_binding_revisions:${text(binding.id)}`,
    `makesafe_sibling_bundle_binding_revisions:${text(reverse.id)}`,
    `sibling_job_id:${siblingId}`,
    `xero_invoices:${text(siblingInvoice.id)}`,
    `xero_invoice_number:${text(siblingInvoice.invoice_number)}`,
    ...triagePackSentEvents.slice(0, 2).map((ev) =>
      ev.id
        ? `job_events:${text(ev.id)}`
        : (isBundledCoverageSendNote(ev.text)
          ? "pack_sent:bundled_coverage_note"
          : "pack_sent:triage_marker")
    ),
  ];

  return {
    path: "sibling_bundle",
    job_id: job.id,
    org_id: job.org_id,
    job_number: job.job_number,
    kind,
    attendance_cycle_ids: cycleIds,
    attendance_cycle_set_hash: cycleSetHash,
    evidence_refs: [...new Set(refs.filter(Boolean))],
    proven_by: provenBy,
    proven_at: provenAt,
    sibling_job_id: siblingId,
    sibling_invoice_number: text(siblingInvoice.invoice_number) || null,
    sibling_invoice_id: text(siblingInvoice.id) || null,
    binding_revision_id: text(binding.id) || null,
    reverse_binding_revision_id: text(reverse.id) || null,
  };
}

function noteEventsFromRows(rows: any[] | null | undefined) {
  return (rows || [])
    .map((row) => ({
      id: row?.id ?? null,
      created_at: row?.created_at ?? null,
      text: eventNoteText(row),
    }))
    .filter((row) => row.text);
}

/**
 * Load the live facts a bundled / own-invoice closeout proof must cite.
 * Fail-closed: any read error refuses rather than inventing coverage.
 */
export async function observeMakesafeTerminalProofRecord(
  client: any,
  jobId: string,
): Promise<RecordTerminalProofObservation> {
  const jobResp = await client.from("jobs").select(
    "id,org_id,job_number,type,status,metadata",
  ).eq("id", jobId).maybeSingle();
  if (jobResp.error) {
    throw conflict("job_unreadable", `jobs read failed: ${jobResp.error.message}`);
  }
  if (!jobResp.data) {
    throw conflict("job_missing", "The named job could not be loaded.");
  }

  const [
    cyclesResp,
    proofsResp,
    ownInvoicesResp,
    eventsResp,
    packsResp,
    outboundResp,
    detailsResp,
    completeEventsResp,
  ] = await Promise.all([
    client.from("makesafe_attendance_cycles").select("id").eq("job_id", jobId),
    client.from("makesafe_terminal_proofs").select(
      "id,kind,attendance_cycle_set_hash",
    ).eq("job_id", jobId),
    client.from("xero_invoices").select(
      "id,job_id,invoice_number,status,invoice_type,invoice_date,fully_paid_on",
    ).eq("job_id", jobId).eq("invoice_type", "ACCREC"),
    client.from("job_events").select("id,event_type,detail_json,created_at")
      .eq("job_id", jobId).in("event_type", ["note", "note_added"]).order(
        "created_at",
        { ascending: false },
      ).limit(200),
    client.from("makesafe_report_packs").select("id,status,sent_at,pack_kind")
      .eq("job_id", jobId).eq("pack_kind", "main").maybeSingle(),
    client.from("makesafe_sibling_bundle_binding_revisions").select(
      "id,job_id,sibling_job_id,bundle_id,org_id,state,recorded_at",
    ).eq("job_id", jobId).eq("state", "bound"),
    client.from("makesafe_job_details").select(
      "substatus,report_type",
    ).eq("job_id", jobId).maybeSingle(),
    client.from("job_events").select("id,event_type,detail_json,created_at")
      .eq("job_id", jobId).eq("event_type", "makesafe_substatus_changed")
      .order("created_at", { ascending: false }).limit(50),
  ]);

  for (
    const [label, resp] of [
      ["attendance_cycles", cyclesResp],
      ["terminal_proofs", proofsResp],
      ["own_invoices", ownInvoicesResp],
      ["job_events", eventsResp],
      ["report_packs", packsResp],
      ["sibling_bindings", outboundResp],
      ["makesafe_job_details", detailsResp],
      ["substatus_events", completeEventsResp],
    ] as const
  ) {
    if (resp.error) {
      throw conflict(
        "observation_unreadable",
        `${label} read failed: ${resp.error.message}`,
      );
    }
  }

  const outbound = outboundResp.data || [];
  const siblingIds = [...new Set(
    outbound.map((row: any) => text(row.sibling_job_id)).filter(Boolean),
  )];

  let reverse: SiblingBindingRow[] = [];
  let siblingInvoices: SiblingInvoiceRow[] = [];
  if (siblingIds.length > 0) {
    const [reverseResp, siblingInvResp] = await Promise.all([
      client.from("makesafe_sibling_bundle_binding_revisions").select(
        "id,job_id,sibling_job_id,bundle_id,org_id,state,recorded_at",
      ).in("job_id", siblingIds).eq("sibling_job_id", jobId).eq("state", "bound"),
      client.from("xero_invoices").select(
        "id,job_id,invoice_number,status,invoice_type,invoice_date,fully_paid_on",
      ).in("job_id", siblingIds).eq("invoice_type", "ACCREC"),
    ]);
    if (reverseResp.error || siblingInvResp.error) {
      throw conflict(
        "observation_unreadable",
        `sibling coverage read failed: ${
          reverseResp.error?.message || siblingInvResp.error?.message
        }`,
      );
    }
    reverse = reverseResp.data || [];
    siblingInvoices = siblingInvResp.data || [];
  }

  const packRow = packsResp.data;
  const packStatus = text(packRow?.status).toLowerCase();
  const packSentAt = ["sent", "sent_marker_failed", "sent_not_closed", "close_failed"]
      .includes(packStatus)
    ? asIso(packRow?.sent_at)
    : null;

  const metadata = jobResp.data.metadata &&
      typeof jobResp.data.metadata === "object"
    ? jobResp.data.metadata as Record<string, unknown>
    : {};
  const detail = detailsResp.data || {};
  const completeAt = (completeEventsResp.data || [])
    .map((row: any) => {
      const sub = text(row?.detail_json?.substatus).toLowerCase();
      if (sub !== "complete") return null;
      return asIso(row?.created_at);
    })
    .find((iso: string | null) => !!iso) || null;

  return {
    job: {
      id: text(jobResp.data.id),
      org_id: text(jobResp.data.org_id),
      job_number: jobResp.data.job_number ?? null,
      type: jobResp.data.type ?? null,
      status: jobResp.data.status ?? null,
    },
    cycle_ids: (cyclesResp.data || []).map((row: any) => text(row.id)).filter(
      Boolean,
    ),
    existing_proofs: (proofsResp.data || []).map((row: any) => ({
      id: text(row.id),
      kind: row.kind ?? null,
      attendance_cycle_set_hash: row.attendance_cycle_set_hash ?? null,
    })),
    own_raised_invoices: ownInvoicesResp.data || [],
    pack_sent_events: noteEventsFromRows(eventsResp.data),
    pack_sent_at: packSentAt,
    outbound_bindings: outbound,
    reverse_bindings: reverse,
    sibling_raised_invoices: siblingInvoices,
    substatus: detail.substatus ?? null,
    makesafe_job_family: text(metadata.makesafe_job_family) || null,
    report_type: detail.report_type ?? null,
    substatus_complete_at: completeAt,
  };
}

export interface RecordTerminalProofResult {
  ok: true;
  dry_run: boolean;
  path: RecordTerminalProofPath;
  job_id: string;
  job_number: string | null;
  kind: RecordableTerminalProofKind;
  attendance_cycle_ids: string[];
  attendance_cycle_set_hash: string;
  evidence_refs: string[];
  proven_by: string;
  proven_at: string;
  sibling_job_id: string | null;
  sibling_invoice_number: string | null;
  binding_revision_id: string | null;
  reverse_binding_revision_id: string | null;
  proof_id: string | null;
  would_insert: boolean;
}

/**
 * Privileged action entrypoint. Defaults to dry_run.
 * Writes exactly one `makesafe_terminal_proofs` row on a live apply.
 */
export async function recordMakesafeTerminalProofAction(
  client: any,
  body: Record<string, unknown> | null | undefined,
): Promise<RecordTerminalProofResult> {
  const dryRun = body?.dry_run !== false;
  const provenBy = text(body?.proven_by);
  if (!provenBy) throw badRequest("proven_by is required");

  let jobId = text(body?.job_id);
  const jobNumber = text(body?.job_number).toUpperCase();
  if (!jobId && jobNumber) {
    const resp = await client.from("jobs").select("id").eq(
      "job_number",
      jobNumber,
    ).maybeSingle();
    if (resp.error) {
      throw conflict(
        "job_unreadable",
        `job_number lookup failed: ${resp.error.message}`,
      );
    }
    if (!resp.data?.id) {
      throw conflict("job_missing", `No job found for job_number ${jobNumber}`);
    }
    jobId = text(resp.data.id);
  }
  if (!jobId) throw badRequest("job_id or job_number is required");

  const observation = await observeMakesafeTerminalProofRecord(client, jobId);
  const plan = await planMakesafeTerminalProofRecord({
    observation,
    proven_by: provenBy,
    kind: text(body?.kind) || "verified_historical_closeout",
    proven_at: text(body?.proven_at) || null,
    extra_evidence_refs: Array.isArray(body?.evidence_refs)
      ? body!.evidence_refs as string[]
      : null,
    sibling_job_id: text(body?.sibling_job_id) || null,
    sibling_invoice_number: text(body?.sibling_invoice_number) || null,
  });

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      path: plan.path,
      job_id: plan.job_id,
      job_number: plan.job_number,
      kind: plan.kind,
      attendance_cycle_ids: plan.attendance_cycle_ids,
      attendance_cycle_set_hash: plan.attendance_cycle_set_hash,
      evidence_refs: plan.evidence_refs,
      proven_by: plan.proven_by,
      proven_at: plan.proven_at,
      sibling_job_id: plan.sibling_job_id,
      sibling_invoice_number: plan.sibling_invoice_number,
      binding_revision_id: plan.binding_revision_id,
      reverse_binding_revision_id: plan.reverse_binding_revision_id,
      proof_id: null,
      would_insert: true,
    };
  }

  const insertResp = await client.from("makesafe_terminal_proofs").insert({
    org_id: plan.org_id,
    job_id: plan.job_id,
    kind: plan.kind,
    attendance_cycle_ids: plan.attendance_cycle_ids,
    attendance_cycle_set_hash: plan.attendance_cycle_set_hash,
    evidence_refs: plan.evidence_refs,
    proven_by: plan.proven_by,
    proven_at: plan.proven_at,
  }).select("id").maybeSingle();

  if (insertResp.error) {
    const message = insertResp.error.message || "insert failed";
    if (/duplicate|unique|already/i.test(message)) {
      throw conflict(
        "terminal_proof_already_recorded",
        "A verified historical closeout proof is already recorded for this job.",
        { db_message: message },
      );
    }
    throw conflict(
      "terminal_proof_insert_failed",
      `Failed to record terminal proof: ${message}`,
    );
  }

  return {
    ok: true,
    dry_run: false,
    path: plan.path,
    job_id: plan.job_id,
    job_number: plan.job_number,
    kind: plan.kind,
    attendance_cycle_ids: plan.attendance_cycle_ids,
    attendance_cycle_set_hash: plan.attendance_cycle_set_hash,
    evidence_refs: plan.evidence_refs,
    proven_by: plan.proven_by,
    proven_at: plan.proven_at,
    sibling_job_id: plan.sibling_job_id,
    sibling_invoice_number: plan.sibling_invoice_number,
    binding_revision_id: plan.binding_revision_id,
    reverse_binding_revision_id: plan.reverse_binding_revision_id,
    proof_id: text(insertResp.data?.id) || null,
    would_insert: false,
  };
}

/** Test-only helpers. */
export const _internals = {
  isRaisedAccrec,
  isActiveAccrec,
  currentBoundOutbound,
  matchingReverse,
  noteEventsFromRows,
  isPackSentMainEvent,
};
