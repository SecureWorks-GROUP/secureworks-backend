// The `makesafe_terminal_proofs` evidence contract, read once.
//
// The table is the append-only, producer-attributed record that a card's work
// is finished: exact job, exact attendance-cycle SET, a non-empty
// `evidence_refs` list naming what was read, and `proven_by` / `proven_at`
// recording who proved it and when. It is installed by
// `20260728000001_makesafe_state_authority_u2.sql` and written today by the U2
// reconcile path (`20260728060000_makesafe_board_reconcile_truth_u2.sql`).
//
// This module holds the ONE binding rule — "does this proof still cover the
// card as it stands now" — so `makesafe_state_projection.ts` (which already
// consumed the contract) and `ses_stage_engine_v2.ts` (which now does) cannot
// drift into two answers. It derives no stage and reads no other evidence.
// The board loader reads `makesafe_terminal_proofs_current_v2` because it runs
// as service_role. The parity harness reads the raw table and reproduces the
// revision join because the view invokes `makesafe_attendance_cycle_set_hash_v1`,
// whose EXECUTE grant is restricted to postgres and service_role; the harness's
// Management API read-only role cannot select the view.
//
// A proof is bound to a cycle SET, not to a job, on purpose: a re-attendance
// opens a new cycle, the set changes, and the old proof stops covering the card
// without anything having to revoke it.

/**
 * The closed `kind` vocabulary, mirroring the table's CHECK constraint.
 *
 * `kind` is the evidence TYPE, not the producer — the producer is the free-text
 * `proven_by`, which is how a human authority is attributed without widening
 * any vocabulary. Adding a member here is a migration plus a captain ruling,
 * never a code edit.
 */
export const MAKESAFE_TERMINAL_PROOF_KINDS = [
  "release_closeout",
  "verified_historical_closeout",
  "approved_nonwork_archive",
] as const;
export type MakesafeTerminalProofKind =
  typeof MAKESAFE_TERMINAL_PROOF_KINDS[number];

export interface MakesafeTerminalProofFact {
  id?: string | null;
  kind?: string | null;
  attendance_cycle_ids?: readonly string[] | null;
  proven_by?: string | null;
  proven_at?: string | null;
  evidence_refs?: readonly string[] | null;
  readiness_revision?: string | null;
  validatedCycleSetHash?: boolean;
  validatedReadinessRevision?: boolean;
}

/**
 * Exact cycle-set coverage.
 *
 * Transcribed from `makesafe_state_projection.ts`'s `terminalExact` test so the
 * two consumers agree by construction: the card's ids are de-duplicated, the
 * proof's are NOT (a proof carrying a duplicate cycle id is malformed and fails
 * on length), and both sides are compared sorted.
 */
export function makesafeTerminalProofCoversCycleSet(
  proofCycleIds: readonly string[] | null | undefined,
  cardCycleIds: readonly string[] | null | undefined,
): boolean {
  const proof = [...(proofCycleIds || [])].sort();
  const card = [...new Set(cardCycleIds || [])].sort();
  if (card.length === 0) return false;
  return proof.length === card.length &&
    proof.every((value, index) => value === card[index]);
}

export async function makesafeAttendanceCycleSetHash(
  cycleIds: readonly string[] | null | undefined,
): Promise<string> {
  const normalized = [...(cycleIds || [])]
    .map((id) => String(id).toLowerCase())
    .sort();
  const input =
    `SecureWorks:make-safe-attendance-cycle-set:v1\n${JSON.stringify(normalized)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The proof that binds to this card right now, or null.
 *
 * Every condition is a fact about the record, never about the stage it would
 * produce: a recognised kind, a non-empty evidence list, a usable `proven_at`,
 * the card's current cycle inside the covered set, and exact coverage of the
 * card's whole cycle set. Anything short of that is not evidence about this
 * card and is ignored rather than downgraded into a weaker signal.
 */
export function bindingMakesafeTerminalProof(
  proofs: readonly MakesafeTerminalProofFact[] | null | undefined,
  cardCycleIds: readonly string[] | null | undefined,
  currentCycleId: string | null | undefined,
): MakesafeTerminalProofFact | null {
  const current = String(currentCycleId || "").trim();
  if (!current) return null;
  const cardSet = [...new Set(cardCycleIds || [])];
  if (!cardSet.includes(current)) return null;
  for (const proof of proofs || []) {
    if (
      !(MAKESAFE_TERMINAL_PROOF_KINDS as readonly string[]).includes(
        String(proof?.kind || ""),
      )
    ) continue;
    if (!(proof?.evidence_refs || []).length) continue;
    if (proof?.validatedCycleSetHash === false) continue;
    if (proof?.validatedReadinessRevision === false) continue;
    const provenAt = new Date(String(proof?.proven_at || "")).getTime();
    if (!Number.isFinite(provenAt)) continue;
    if (
      !makesafeTerminalProofCoversCycleSet(proof?.attendance_cycle_ids, cardSet)
    ) continue;
    return proof;
  }
  return null;
}
