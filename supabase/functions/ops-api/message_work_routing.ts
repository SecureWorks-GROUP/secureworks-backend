// Smallest communication routing seam for Dispatch/Debt.
// Strong evidence first. Subject-only is never a silent link.
// One message may link many jobs; unresolved stays visible.

export type WorkRef = { kind: "job" | "po" | "invoice"; id: string };
export type RouteInput = {
  org_id: string;
  subject?: string;
  body?: string;
  in_reply_to?: string | null;
  references?: string[];
  quoted?: boolean;
  explicit_ids?: WorkRef[];
  candidate_jobs?: Array<{ org_id: string; job_id: string; job_number?: string }>;
};
export type RouteResult = {
  links: Array<{ kind: string; id: string; certainty: "explicit" | "thread" | "unresolved" }>;
  unresolved: boolean;
  reason: string;
};

const JOB_NUMBER = /\b(SW[A-Z]{1,3}-\d{4,8})\b/gi;

export function routeMessage(input: RouteInput): RouteResult {
  const sameOrg = (input.candidate_jobs || []).filter((j) => j.org_id === input.org_id);
  const explicit = (input.explicit_ids || []).filter((r) => r.id);
  if (explicit.length) {
    return {
      links: explicit.map((r) => ({ kind: r.kind, id: r.id, certainty: "explicit" as const })),
      unresolved: false,
      reason: "explicit_ids",
    };
  }
  if (input.in_reply_to || (input.references && input.references.length)) {
    const threadHits = sameOrg;
    if (threadHits.length === 1) {
      return {
        links: [{ kind: "job", id: threadHits[0].job_id, certainty: "thread" }],
        unresolved: false,
        reason: "reply_headers",
      };
    }
    if (threadHits.length > 1) {
      return { links: [], unresolved: true, reason: "thread_ambiguous" };
    }
  }
  const text = `${input.subject || ""}\n${input.body || ""}`;
  const nums = [...text.matchAll(JOB_NUMBER)].map((m) => m[1].toUpperCase());
  const unique = [...new Set(nums)];
  if (input.quoted && unique.length) {
    return { links: [], unresolved: true, reason: "quoted_stale_reference" };
  }
  const byNumber = unique
    .map((n) => sameOrg.find((j) => (j.job_number || "").toUpperCase() === n))
    .filter(Boolean) as Array<{ job_id: string }>;
  if (byNumber.length === 1 && unique.length === 1) {
    return {
      links: [{ kind: "job", id: byNumber[0].job_id, certainty: "explicit" }],
      unresolved: false,
      reason: "job_number",
    };
  }
  if (unique.length > 1 || byNumber.length > 1) {
    return { links: [], unresolved: true, reason: "multiple_work_refs" };
  }
  return { links: [], unresolved: true, reason: "no_evidence" };
}

export function applyLinkCorrection(
  current: RouteResult,
  correction: { op: "link" | "unlink"; kind: string; id: string },
): RouteResult {
  if (correction.op === "unlink") {
    const links = current.links.filter((l) => !(l.kind === correction.kind && l.id === correction.id));
    return { links, unresolved: links.length === 0, reason: "manual_unlink" };
  }
  const links = [
    ...current.links.filter((l) => !(l.kind === correction.kind && l.id === correction.id)),
    { kind: correction.kind, id: correction.id, certainty: "explicit" as const },
  ];
  return { links, unresolved: false, reason: "manual_link" };
}
