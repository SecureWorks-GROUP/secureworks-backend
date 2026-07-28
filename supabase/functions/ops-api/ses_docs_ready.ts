import type { SesBlocker, SesPreparedRevision } from "./ses_docket_envelope.ts";

export const SES_DOCS_READY_STATE_VERSION = "ses.docs-ready/v1";

export type SesDocsReadyState = "needs_review" | "signed_off";
export type SesDocsReadyEventKind =
  | "prepared"
  | "content_changed"
  | "signed_off"
  | "revoked";

export type SesDocsReadyGate =
  | {
    state: "needs_review";
    blockers: [];
  }
  | {
    state: "blocked";
    blockers: SesBlocker[];
  };

function typedManifestBlockers(
  revision: Pick<SesPreparedRevision, "envelope">,
): SesBlocker[] {
  const candidates = [
    ...Object.values(revision.envelope.v2.items),
    ...revision.envelope.v2.deliverables.map((item) => item.completion),
  ].filter((item): item is SesBlocker => item.state === "blocked");
  const seen = new Set<string>();
  return candidates.filter((blocker) => {
    const key = `${blocker.reason_code}\n${blocker.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * This gate deliberately reuses the assembler's existing completeness verdict
 * and typed blockers. It does not reinterpret a family recipe or add another
 * pack rule.
 */
export function evaluateSesDocsReadyGate(
  revision: Pick<
    SesPreparedRevision,
    "state" | "envelope" | "blockers"
  >,
): SesDocsReadyGate {
  if (
    revision.state === "ready" &&
    revision.envelope.pre_xero_docs_ready &&
    revision.blockers.length === 0
  ) {
    return { state: "needs_review", blockers: [] };
  }
  return {
    state: "blocked",
    blockers: revision.blockers.length
      ? revision.blockers
      : typedManifestBlockers(revision),
  };
}

export function nextSesDocsReadyState(
  current: SesDocsReadyState | null,
  event: SesDocsReadyEventKind,
): SesDocsReadyState {
  if (
    (event === "prepared" || event === "content_changed") &&
    current !== "signed_off"
  ) {
    return "needs_review";
  }
  if (event === "content_changed" && current === "signed_off") {
    return "needs_review";
  }
  if (event === "signed_off" && current === "needs_review") {
    return "signed_off";
  }
  if (event === "revoked" && current === "signed_off") {
    return "needs_review";
  }
  throw new TypeError(
    `invalid Docs Ready transition: ${current || "none"} -> ${event}`,
  );
}

export function canManageSesDocsReadySignoff(auth: {
  mode: "api_key" | "jwt" | "routine";
  role?: string | null;
  operator_class?: string | null;
}): boolean {
  if (auth.mode !== "jwt") return false;
  return auth.role === "admin" || auth.role === "owner" ||
    auth.operator_class === "captain" ||
    auth.operator_class === "admin_owner";
}
