// deno-lint-ignore-file no-explicit-any
/**
 * Guarded correction for a FALSE `makesafe_job_details.report_sent_at`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `report_sent_at` was never send truth. Until Rescue SES T2 removed the
 * auto-stamp, `updateMakesafeSubstatus` stamped it on the move to
 * `ready_to_invoice` — an operator CLAIM that the report was ready to invoice,
 * not a record that anything was emailed. Every card moved that way minted a
 * timestamp for a send that never happened, and a card genuinely sent through
 * the sealed release graph gets no stamp at all. The field is therefore wrong
 * in BOTH directions and must never be read as send truth (Floreat
 * SWMS-261021 / SWMS-261020 are the worked pair: one address, both errors).
 *
 * The forward producer is already gone. This action cures the rows the old
 * producer left behind, and it is the SANCTIONED way to do it — a direct
 * `update` could erase the stamp of a card that really was sent.
 *
 * KNOWN OPEN HOLE: that sanction is NOT ENFORCED
 * ----------------------------------------------
 * This is the sanctioned path, not the only possible one. `update_makesafe_details`
 * (index.ts, the make-safe detail field allow-list) still carries
 * `report_sent_at` with no privilege gate and no send-truth derivation, so any
 * caller of that action can clear a REAL send's stamp or SET a false one — the
 * exact failure mode this module exists to prevent. The applied 5-card
 * correction script itself went through that unguarded door. Closing it is a
 * behaviour decision that was deliberately deferred (no-coding day, ticketed
 * separately); do not read this module's existence as proof the field is
 * protected. See docs/evidence/ses-manufactured-blockers-2026-08-07.md.
 *
 * WHAT IT WILL AND WILL NOT DO
 * ----------------------------
 * It only ever CLEARS a stamp. There is no path here that sets one: a missing
 * stamp is the correct resting state for an unsent card, and re-stamping is
 * how the false evidence got minted in the first place.
 *
 * Before clearing, it re-derives send truth server-side from the four surfaces
 * that actually record a send, and REFUSES the card if any of them fires. The
 * caller cannot supply, override or skip that derivation. Fail-closed: a
 * surface that cannot be read is treated as "might have sent", never as "no
 * send".
 *
 * THE FOUR SURFACES, AND THE JOIN THAT IS A TRAP
 * ----------------------------------------------
 *   1. `ses_release_route_proofs`   — carries `job_id`; the trustworthy join.
 *   2. `ses_external_effects` (`effect_kind='route_send'`) — joined through
 *      `makesafe_release_revision_members`. Its OWN `job_id` column is NULL on
 *      every route_send row, so a direct `job_id` join returns zero and reads
 *      as "nothing was ever sent" — which would let this action erase the
 *      stamp of a card that really shipped. That join is the trap; do not
 *      reintroduce it here or anywhere else.
 *   3. `makesafe_report_packs.status` in a sent/closed status — the durable
 *      legacy pack record, only written after the irreversible send step.
 *   4. The legacy `MAKESAFE_PACK_SENT` job_events marker — the pre-pack-table
 *      send path. 28 of the 33 stamps live on 2026-08-06 are corroborated by
 *      this marker alone, so omitting it would misread real sends as false.
 *
 * The caller must also state the stamp it observed (`expected_report_sent_at`),
 * so a row that moved between measurement and apply refuses instead of being
 * silently overwritten.
 */

/**
 * `ApiError` lives in `index.ts`, which imports this module — importing it back
 * would be circular, so validation faults are plain Errors carrying a `status`
 * the router maps, matching the convention in the sibling make-safe modules.
 */
function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  return err;
}

/** Pack statuses that only exist after the irreversible send step. */
const SENT_PACK_STATUSES = [
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
];

/** Hard cap: this is a hand-adjudicated correction, never a board-wide sweep. */
export const FALSE_SEND_STAMP_MAX_JOBS = 25;

export type FalseSendStampSurface =
  | "ses_release_route_proofs"
  | "ses_external_effects_via_release_members"
  | "makesafe_report_packs_status"
  | "legacy_pack_sent_marker";

export interface FalseSendStampSendEvidence {
  /** True when ANY surface recorded a send, or when any surface was unreadable. */
  sent: boolean;
  surfaces: Record<FalseSendStampSurface, number | "unreadable">;
}

export interface FalseSendStampOutcome {
  job_id: string;
  job_number: string | null;
  /** cleared | would_clear (dry run) | refused */
  outcome: "cleared" | "would_clear" | "refused";
  refusal_code?: string;
  refusal_fact?: string;
  before_report_sent_at: string | null;
  after_report_sent_at: string | null;
  send_evidence: FalseSendStampSendEvidence | null;
  /**
   * Present only when the stamp WAS cleared but its audit event could not be
   * written. The correction stands; the record of it does not.
   */
  audit_write_failed?: string;
}

function asIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Re-derive whether this job was ever actually sent, from the four surfaces.
 * Fail-closed on every read fault: an unreadable surface counts as evidence of
 * a send, because the cost of being wrong here is erasing the record of a real
 * one.
 */
export async function readMakesafeSendEvidence(
  client: any,
  jobId: string,
): Promise<FalseSendStampSendEvidence> {
  const surfaces: Record<FalseSendStampSurface, number | "unreadable"> = {
    ses_release_route_proofs: 0,
    ses_external_effects_via_release_members: 0,
    makesafe_report_packs_status: 0,
    legacy_pack_sent_marker: 0,
  };

  // 1. Route proofs — this table DOES carry job_id.
  const proofs = await client.from("ses_release_route_proofs")
    .select("id").eq("job_id", jobId);
  surfaces.ses_release_route_proofs = proofs?.error
    ? "unreadable"
    : (proofs?.data || []).length;

  // 2. route_send effects — reached ONLY through the release members table.
  //    `ses_external_effects.job_id` is NULL on every route_send row.
  const members = await client.from("makesafe_release_revision_members")
    .select("release_revision_id").eq("job_id", jobId);
  if (members?.error) {
    surfaces.ses_external_effects_via_release_members = "unreadable";
  } else {
    const revisionIds = [
      ...new Set(
        (members?.data || [])
          .map((m: any) => String(m?.release_revision_id || "").trim())
          .filter((v: string) => v.length > 0),
      ),
    ];
    if (revisionIds.length === 0) {
      surfaces.ses_external_effects_via_release_members = 0;
    } else {
      const effects = await client.from("ses_external_effects")
        .select("id")
        .eq("effect_kind", "route_send")
        .in("release_revision_id", revisionIds);
      surfaces.ses_external_effects_via_release_members = effects?.error
        ? "unreadable"
        : (effects?.data || []).length;
    }
  }

  // 3. Durable legacy pack row in a sent/closed status.
  const packs = await client.from("makesafe_report_packs")
    .select("status").eq("job_id", jobId);
  if (packs?.error) {
    surfaces.makesafe_report_packs_status = "unreadable";
  } else {
    surfaces.makesafe_report_packs_status = (packs?.data || []).filter((p: any) =>
      SENT_PACK_STATUSES.includes(String(p?.status || "").toLowerCase())
    ).length;
  }

  // 4. Legacy MAKESAFE_PACK_SENT marker (pre-pack-table send path).
  const events = await client.from("job_events")
    .select("id, event_type, detail_json").eq("job_id", jobId);
  if (events?.error) {
    surfaces.legacy_pack_sent_marker = "unreadable";
  } else {
    surfaces.legacy_pack_sent_marker = (events?.data || []).filter((e: any) => {
      const type = String(e?.event_type || "").toLowerCase();
      if (type.includes("pack_sent")) return true;
      let blob = "";
      try {
        blob = JSON.stringify(e?.detail_json ?? "");
      } catch {
        return true; // unserialisable -> fail closed
      }
      return blob.includes("MAKESAFE_PACK_SENT");
    }).length;
  }

  const sent = Object.values(surfaces).some((v) => v === "unreadable" || (typeof v === "number" && v > 0));
  return { sent, surfaces };
}

/**
 * Clear provably-false `report_sent_at` stamps on an explicit, closed list of
 * cards. Dry run by default. Privileged callers only (enforced at the router).
 */
export async function correctMakesafeFalseSendStamps(
  client: any,
  body: any,
  ctx: { actor?: string | null } = {},
): Promise<any> {
  const rawJobIds: unknown = body?.job_ids ?? body?.jobIds;
  if (!Array.isArray(rawJobIds) || rawJobIds.length === 0) {
    throw badRequest("job_ids (non-empty array) required");
  }
  const jobIds = [
    ...new Set(rawJobIds.map((v) => String(v || "").trim()).filter((v) => v.length > 0)),
  ];
  if (jobIds.length === 0) throw badRequest("job_ids (non-empty array) required");
  if (jobIds.length > FALSE_SEND_STAMP_MAX_JOBS) {
    throw badRequest(
      `job_ids is capped at ${FALSE_SEND_STAMP_MAX_JOBS}; this is a hand-adjudicated correction, not a sweep`);
  }

  const reason = String(body?.reason || "").trim();
  if (!reason) throw badRequest("reason required");

  // Expectation guard: the caller states the stamp it measured, per job.
  const expectedRaw = body?.expected_report_sent_at ?? body?.expectedReportSentAt;
  if (!expectedRaw || typeof expectedRaw !== "object" || Array.isArray(expectedRaw)) {
    throw badRequest(
      "expected_report_sent_at required: an object of { job_id: observed_timestamp }");
  }

  // Dry run unless the caller explicitly opts out.
  const dryRun = body?.dry_run !== false && body?.dryRun !== false;

  const results: FalseSendStampOutcome[] = [];

  for (const jobId of jobIds) {
    const { data: detail, error: detailErr } = await client
      .from("makesafe_job_details")
      .select("job_id, report_sent_at, substatus")
      .eq("job_id", jobId)
      .maybeSingle();

    const { data: job } = await client.from("jobs")
      .select("id, job_number").eq("id", jobId).maybeSingle();
    const jobNumber = job?.job_number ?? null;

    // Captured ONCE, before any write. Re-reading `detail` inside push() would
    // report whatever the row holds at that moment, and a client that mutates
    // the selected object in place then reports the correction's own `before`
    // as null — i.e. the audit trail would lose the very value being corrected.
    const observed = asIso(detail?.report_sent_at);

    const push = (
      outcome: FalseSendStampOutcome["outcome"],
      extra: Partial<FalseSendStampOutcome> = {},
    ) => {
      results.push({
        job_id: jobId,
        job_number: jobNumber,
        outcome,
        before_report_sent_at: observed,
        after_report_sent_at: observed,
        send_evidence: null,
        ...extra,
      });
    };

    if (detailErr || !detail) {
      push("refused", {
        refusal_code: "makesafe_detail_unreadable",
        refusal_fact: "No readable make-safe detail row for this job.",
      });
      continue;
    }

    const before = observed;
    if (!before) {
      push("refused", {
        refusal_code: "no_stamp_to_clear",
        refusal_fact: "report_sent_at is already null; nothing to correct.",
      });
      continue;
    }

    const expected = asIso((expectedRaw as Record<string, unknown>)[jobId]);
    if (!expected) {
      push("refused", {
        refusal_code: "expectation_missing",
        refusal_fact: "No expected_report_sent_at supplied for this job.",
      });
      continue;
    }
    if (expected !== before) {
      push("refused", {
        refusal_code: "stamp_drift",
        refusal_fact:
          `report_sent_at moved since it was measured: expected ${expected}, found ${before}.`,
      });
      continue;
    }

    // The load-bearing guard: has this card ACTUALLY been sent, on any surface?
    const evidence = await readMakesafeSendEvidence(client, jobId);
    if (evidence.sent) {
      push("refused", {
        refusal_code: "send_evidence_present",
        refusal_fact:
          "A send surface recorded (or could not rule out) a real send for this card; the stamp is not provably false.",
        send_evidence: evidence,
      });
      continue;
    }

    if (dryRun) {
      push("would_clear", { after_report_sent_at: null, send_evidence: evidence });
      continue;
    }

    const nowIso = new Date().toISOString();
    const { error: updateErr } = await client.from("makesafe_job_details")
      .update({ report_sent_at: null, updated_at: nowIso })
      .eq("job_id", jobId);
    if (updateErr) {
      push("refused", {
        refusal_code: "update_failed",
        refusal_fact: String(updateErr?.message || updateErr),
        send_evidence: evidence,
      });
      continue;
    }

    const { error: auditErr } = await client.from("job_events").insert({
      job_id: jobId,
      event_type: "makesafe_evidence_correction",
      detail_json: {
        field: "report_sent_at",
        action: "nulled",
        before_report_sent_at: before,
        after_report_sent_at: null,
        substatus_unchanged: detail.substatus ?? null,
        send_evidence: evidence,
        reason,
        actor: ctx.actor ?? null,
        corrected_at: nowIso,
      },
    });

    // PostgREST RETURNS errors, it does not throw, so a `.catch()` here would
    // catch nothing and a rejected insert would leave the stamp cleared with no
    // record of what was cleared or on what evidence. The clear is already
    // committed and must NOT be silently rolled back — report it instead, so an
    // unaudited correction is visible in the result.
    push("cleared", {
      after_report_sent_at: null,
      send_evidence: evidence,
      audit_write_failed: auditErr
        ? String((auditErr as any)?.message || auditErr)
        : undefined,
    });
  }

  return {
    schema: "secureworks.makesafe.false-send-stamp-correction/v1",
    dry_run: dryRun,
    requested: jobIds.length,
    cleared: results.filter((r) => r.outcome === "cleared").length,
    would_clear: results.filter((r) => r.outcome === "would_clear").length,
    refused: results.filter((r) => r.outcome === "refused").length,
    results,
  };
}
