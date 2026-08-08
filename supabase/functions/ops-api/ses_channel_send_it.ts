// ════════════════════════════════════════════════════════════════════════════
// SES channel SEND IT — the Captain's send word over WhatsApp/SMS
// (Harden SES v1, ticket 07).
//
// ── READ FIRST: TEXT SEND IT HAS NO PRODUCTION CALL SITE ────────────────────
//
// Nothing imports `executeSesChannelSendIt`. The live text route
// (`ses_echo_code_approval.ts`) refuses any non-`approve_invoice` message, and
// `submit_ses_channel_approval` answers `send_it` with
// `channel_send_not_supported` (409). The COCKPIT SEND IT route
// (`approve_ses_release_revision` / `execute_ses_release_revision`) is
// untouched. This module is kept for its binding rules and its own unit
// tests; re-wiring text SEND IT behind its own echo-code request is a NAMED
// follow-up requiring the Captain's word — do not restore it as a side effect
// of another slice. Contract:
// `docs/evidence/ses-echo-code-text-approvals-v1-2026-08-08.md`.
//
// The identity work described below (relay key + enrolled sender + live TOTP)
// is retired: the knowledge factor is now a server-minted single-use echo
// code. This module answers ONE
// question: which exact prepared release does the Captain's word bind to —
// and then drives the very same approve/execute release actions a cockpit
// press drives, so every guard, money check and exact-once send is unchanged.
//
// Binding rules (all refusals are named and fail closed):
//   - The job must have exactly ONE release revision awaiting send
//     (state proposed or approved). Zero means nothing is prepared for send;
//     more than one means the word is ambiguous. Either way: refuse.
//   - The release member's docket_revision_id must be the job's LATEST ready
//     docket revision. A word can never release a stale revision: if the pack
//     was rebuilt since the release was prepared, refuse and ask for a fresh
//     prepare.
//   - The word releases the single named card only. Multi-job release
//     revisions refuse on this channel: a one-line phone message must never
//     fan out to cards it does not name.
// ════════════════════════════════════════════════════════════════════════════

import type { SesActionAuth } from "./ses_reporting_actions.ts";
import { SesActionError } from "./ses_reporting_actions.ts";
import { type SesRefusal } from "./ses_reporting_refusals.ts";

type SesSupabaseClient = any;

function refuse(
  status: number,
  code: string,
  fact: string,
  recovery_action: string,
  evidence?: Record<string, unknown>,
): never {
  const refusal: SesRefusal = {
    state: "refused",
    code,
    fact,
    recovery_action,
    ...(evidence ? { evidence } : {}),
  } as SesRefusal;
  throw new SesActionError(status, refusal);
}

export interface SesChannelSendItDeps {
  approveRelease: (
    auth: SesActionAuth,
    args: {
      org_id: string;
      release_revision_id: string;
      evidence_refs?: unknown[];
    },
  ) => Promise<unknown>;
  executeRelease: (
    auth: SesActionAuth,
    args: {
      org_id: string;
      release_revision_id: string;
      actor: string;
    },
  ) => Promise<unknown>;
}

export interface SesChannelSendItBinding {
  release_revision_id: string;
  release_state: string;
  release_content_hash: string;
  docket_revision_id: string;
  docket_output_content_hash: string;
}

/**
 * Resolve the one release revision the Captain's word can bind to, refusing
 * on zero, many, multi-job membership, or a stale docket revision.
 */
export async function resolveSesChannelSendItBinding(
  client: SesSupabaseClient,
  jobId: string,
): Promise<SesChannelSendItBinding> {
  const members = await client.from("makesafe_release_revision_members")
    .select("release_revision_id,docket_revision_id")
    .eq("job_id", jobId);
  if (members.error) {
    refuse(
      503,
      "channel_release_unreadable",
      `The card's release ledger could not be read (${
        members.error.message || "unknown database error"
      }).`,
      "Retry once the release ledger is readable.",
    );
  }
  const memberRows = members.data || [];
  const revisionIds = [
    ...new Set(
      memberRows.map((row: Record<string, unknown>) =>
        String(row.release_revision_id)
      ),
    ),
  ];
  let candidates: Array<Record<string, unknown>> = [];
  if (revisionIds.length > 0) {
    const revisions = await client.from("makesafe_release_revisions")
      .select("id,state,content_hash")
      .in("id", revisionIds)
      .in("state", ["proposed", "approved"]);
    if (revisions.error) {
      refuse(
        503,
        "channel_release_unreadable",
        `The card's release revisions could not be read (${
          revisions.error.message || "unknown database error"
        }).`,
        "Retry once the release ledger is readable.",
      );
    }
    candidates = revisions.data || [];
  }
  if (candidates.length === 0) {
    refuse(
      409,
      "channel_release_not_prepared",
      "No prepared release is awaiting your word on this card, so there is nothing this message could send.",
      "Have the docket prepared for release first (the board skill's send path), then send the word again.",
    );
  }
  if (candidates.length > 1) {
    refuse(
      409,
      "channel_release_ambiguous",
      "More than one release revision is awaiting send on this card, so which one your word binds to cannot be established.",
      "Send from the cockpit where the exact release is displayed, or have the stale preparation superseded first.",
      { release_revision_ids: candidates.map((row) => String(row.id)) },
    );
  }
  const release = candidates[0]!;
  const releaseId = String(release.id);
  const releaseMembers = memberRows.filter(
    (row: Record<string, unknown>) =>
      String(row.release_revision_id) === releaseId,
  );
  const allMembers = await client.from("makesafe_release_revision_members")
    .select("job_id,docket_revision_id")
    .eq("release_revision_id", releaseId);
  if (allMembers.error) {
    refuse(
      503,
      "channel_release_unreadable",
      `The release revision's member set could not be read (${
        allMembers.error.message || "unknown database error"
      }).`,
      "Retry once the release ledger is readable.",
    );
  }
  const memberSet = allMembers.data || [];
  if (memberSet.length !== 1 || String(memberSet[0].job_id) !== jobId) {
    refuse(
      409,
      "channel_release_not_single_card",
      "The prepared release covers more than the card your word names, so a one-line message cannot authorise it.",
      "Send it from the cockpit where the full member set is displayed.",
      {
        member_job_ids: memberSet.map((row: Record<string, unknown>) =>
          String(row.job_id)
        ),
      },
    );
  }
  const docketRevisionId = String(releaseMembers[0]?.docket_revision_id || "");

  const latest = await client.from("makesafe_docket_revisions")
    .select("id,output_content_hash")
    .eq("job_id", jobId)
    .eq("state", "ready")
    .order("created_at", { ascending: false })
    .limit(1);
  if (latest.error) {
    refuse(
      503,
      "channel_release_unreadable",
      `The card's docket revisions could not be read (${
        latest.error.message || "unknown database error"
      }).`,
      "Retry once the docket ledger is readable.",
    );
  }
  const latestRow = (latest.data || [])[0];
  if (!latestRow || String(latestRow.id) !== docketRevisionId) {
    refuse(
      409,
      "channel_release_stale_docket",
      "The prepared release binds a docket revision that is no longer the card's latest, so your word would send a stale pack.",
      "Have the release prepared again from the current docket revision, then send the word again.",
      {
        bound_docket_revision_id: docketRevisionId,
        latest_docket_revision_id: String(latestRow?.id || ""),
      },
    );
  }
  return {
    release_revision_id: releaseId,
    release_state: String(release.state),
    release_content_hash: String(release.content_hash || ""),
    docket_revision_id: docketRevisionId,
    docket_output_content_hash: String(latestRow.output_content_hash || ""),
  };
}

/**
 * Drive the existing deterministic release path for the resolved binding.
 * A `proposed` release is approved first (recording the operator act and the
 * exact revision hashes as evidence); an already-`approved` release goes
 * straight to execute. Both actions run every cockpit guard unchanged.
 */
export async function executeSesChannelSendIt(
  client: SesSupabaseClient,
  operatorAuth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    actor: string;
    evidence_refs: unknown[];
  },
  deps: SesChannelSendItDeps,
) {
  const binding = await resolveSesChannelSendItBinding(client, args.job_id);
  const boundEvidence = [
    ...args.evidence_refs,
    {
      kind: "ses_channel_send_it_binding",
      release_revision_id: binding.release_revision_id,
      release_content_hash: binding.release_content_hash,
      docket_revision_id: binding.docket_revision_id,
      docket_output_content_hash: binding.docket_output_content_hash,
    },
  ];
  let approval: unknown = null;
  if (binding.release_state === "proposed") {
    approval = await deps.approveRelease(operatorAuth, {
      org_id: args.org_id,
      release_revision_id: binding.release_revision_id,
      evidence_refs: boundEvidence,
    });
  }
  const release = await deps.executeRelease(operatorAuth, {
    org_id: args.org_id,
    release_revision_id: binding.release_revision_id,
    actor: args.actor,
  });
  return { binding, approval, release };
}
