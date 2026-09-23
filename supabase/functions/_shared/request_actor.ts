// F-ACT (INTEGRATION.md X31): who asked, on every call. Owner ruling: per-person
// identity on every call, for audit only.
//
// One rule, shared by every edge function that records the actor:
//   1. a verified signed-in user (the JWT the function itself checked) is the
//      actor, as `user:<id>`; a header on the same request is ignored;
//   2. otherwise (a server-key call: MCP tools, sw-axi, automations) the
//      `x-sw-actor` header, sent by the runtime's shared callEdgeHeaders
//      (slice F-ACT-RT) from SECUREWORKS_CAPTAIN_ID, a tool argument, or
//      `workflow:<name>`; kept verbatim when it matches ACTOR_PATTERN;
//   3. otherwise `actor_missing`. A header that does not match the pattern is
//      also `actor_missing` (source `header_invalid`), and its value is never
//      echoed anywhere, so a junk or hostile header cannot reach a log line.
//
// A missing actor is recorded, never refused: refusing would turn an audit
// field into an access gate. The header is a claim by a caller that already
// holds a server key; `source` says which of the two kinds of actor a record
// carries, so a claimed actor is never read as a verified one.

export const ACTOR_HEADER = "x-sw-actor";
export const ACTOR_MISSING = "actor_missing";

/** Letters, digits and `_ . : @ -`, 1 to 128 characters. No spaces, quotes,
 * slashes or separators, so the value is safe in a log line as it stands. */
export const ACTOR_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

export type ActorSource = "jwt" | "header" | "header_invalid" | "none";

export interface RequestActor {
  /** `user:<id>`, the header value, or `actor_missing`. */
  actor: string;
  source: ActorSource;
  /** True when there is no usable actor (no header, or a malformed one). */
  missing: boolean;
}

export function resolveRequestActor(input: {
  /** Set only when the function verified a signed-in user on this request. */
  verifiedUserId?: string | null;
  headers: Headers;
}): RequestActor {
  const userId = typeof input.verifiedUserId === "string"
    ? input.verifiedUserId.trim()
    : "";
  if (userId) return { actor: `user:${userId}`, source: "jwt", missing: false };
  const raw = (input.headers.get(ACTOR_HEADER) ?? "").trim();
  if (!raw) return { actor: ACTOR_MISSING, source: "none", missing: true };
  // The reserved word is never an actor, whoever sends it.
  if (!ACTOR_PATTERN.test(raw) || raw === ACTOR_MISSING) {
    return { actor: ACTOR_MISSING, source: "header_invalid", missing: true };
  }
  return { actor: raw, source: "header", missing: false };
}
