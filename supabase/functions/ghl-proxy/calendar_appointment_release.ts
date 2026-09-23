// Release for a GHL appointment ledger row stuck in `sending` (booking review
// 23 Sep 2026, gap 15). Contract: docs/ghl-calendar-appointment-write.md
// "Releasing a stuck sending row".
//
// A `sending` row is the writer's fence for a post whose outcome is unknown.
// It never expires on its own, so one lost provider answer froze that person's
// window forever. This action lets the captain (allow-listed JWT email) or the
// service role mark ONE such row `released` with a reason, after checking GHL
// by hand. It never deletes a row, never posts to GHL, never touches any other
// state, and only acts on a row whose post started over ten minutes ago.
// Default is a read-only preview; `commit: true` performs the release.

type ObjectRow = Record<string, unknown>;

export type ReleaseDecision =
  | {
    decision: "released" | "already_released";
    released_at: string;
    released_by: string;
    release_reason: string;
  }
  | { decision: "not_found" }
  | { decision: "not_sending"; state: string }
  | { decision: "too_recent"; lease_until: string };

export type LedgerRowView = {
  state: string;
  assigned_user_id: string;
  start_time: string;
  end_time: string;
  lease_until: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
};

export interface ReleaseLedger {
  read(locationId: string, key: string): Promise<LedgerRowView | null>;
  release(args: {
    locationId: string;
    key: string;
    reason: string;
    releasedBy: string;
  }): Promise<ReleaseDecision>;
}

export type ReleaseCaller = {
  mode: "service_role" | "shared_key" | "user_jwt";
  email: string | null;
  role: unknown;
  orgId: unknown;
};

export type ReleaseDeps = {
  locationId: string;
  configuredOrgId: string;
  captainEmails: string[];
  ledger: ReleaseLedger;
};

type ActionResult = { status: number; body: ObjectRow };

const FIELDS = new Set(["idempotencyKey", "reason", "commit"]);

function refuse(code: string, status: number, reason?: string): ActionResult {
  return { status, body: { ok: false, code, ...(reason ? { reason } : {}) } };
}

/** Service role, or a same-organisation JWT whose email is on the captain list. */
export function releaseActor(
  caller: ReleaseCaller,
  deps: Pick<ReleaseDeps, "captainEmails" | "configuredOrgId">,
): string | null {
  if (caller.mode === "service_role") return "service_role";
  if (caller.mode !== "user_jwt") return null;
  const email = String(caller.email || "").trim().toLowerCase();
  if (!email || !deps.captainEmails.includes(email)) return null;
  if (!caller.orgId || String(caller.orgId) !== deps.configuredOrgId) {
    return null;
  }
  return email;
}

const hasControl = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function parse(
  body: unknown,
): { key: string; reason: string; commit: boolean } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as ObjectRow;
  if (Object.keys(row).some((k) => !FIELDS.has(k))) return null;
  const { idempotencyKey: key, reason, commit } = row;
  if (
    typeof key !== "string" || key.length < 1 || key.length > 200 ||
    key !== key.trim() || hasControl(key)
  ) return null;
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (
    trimmed.length < 10 || trimmed.length > 500 ||
    hasControl(trimmed)
  ) return null;
  if (commit !== undefined && typeof commit !== "boolean") return null;
  return { key, reason: trimmed, commit: commit === true };
}

const TOO_RECENT_MS = 10 * 60_000;

export async function releaseCalendarAppointmentAction(args: {
  method: string;
  body: unknown;
  caller: ReleaseCaller;
  deps: ReleaseDeps;
  now?: () => number;
}): Promise<ActionResult> {
  if (args.method !== "POST") return refuse("method_not_allowed", 405);
  const actor = releaseActor(args.caller, args.deps);
  if (!actor) return refuse("forbidden", 403, "captain_or_service_role_only");
  const request = parse(args.body);
  if (!request || !args.deps.locationId) {
    return refuse("invalid_request", 400);
  }
  try {
    if (!request.commit) {
      const row = await args.deps.ledger.read(
        args.deps.locationId,
        request.key,
      );
      if (!row) return refuse("not_found", 404);
      const now = args.now?.() ?? Date.now();
      const leaseUntil = Date.parse(row.lease_until);
      const blocker = row.state === "released"
        ? "already_released"
        : row.state !== "sending"
        ? "not_sending"
        : !(Number.isFinite(leaseUntil) && now - leaseUntil >= TOO_RECENT_MS)
        ? "too_recent"
        : null;
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          wouldRelease: blocker === null,
          ...(blocker ? { blocker } : {}),
          request: row,
          releasedBy: actor,
          reason: request.reason,
        },
      };
    }
    const result = await args.deps.ledger.release({
      locationId: args.deps.locationId,
      key: request.key,
      reason: request.reason,
      releasedBy: actor,
    });
    switch (result.decision) {
      case "released":
      case "already_released":
        return {
          status: 200,
          body: {
            ok: true,
            released: result.decision === "released",
            alreadyReleased: result.decision === "already_released",
            releasedAt: result.released_at,
            releasedBy: result.released_by,
            releaseReason: result.release_reason,
          },
        };
      case "not_found":
        return refuse("not_found", 404);
      case "not_sending":
        return {
          status: 409,
          body: { ok: false, code: "not_sending", state: result.state },
        };
      case "too_recent":
        return {
          status: 409,
          body: {
            ok: false,
            code: "too_recent",
            leaseUntil: result.lease_until,
          },
        };
    }
  } catch {
    return refuse("ledger_error", 503);
  }
  return refuse("ledger_error", 503);
}

const ROW_COLUMNS =
  "state,assigned_user_id,start_time,end_time,lease_until,created_at,released_at,released_by,release_reason";

/** Supabase adapter. The release itself is the locked database function. */
// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
export function releaseLedger(sb: any): ReleaseLedger {
  return {
    async read(locationId, key) {
      const { data, error } = await sb.from("ghl_calendar_appointment_requests")
        .select(ROW_COLUMNS).eq("location_id", locationId)
        .eq("idempotency_key", key).maybeSingle();
      if (error) throw new Error("ledger_read_failed");
      return (data as LedgerRowView | null) ?? null;
    },
    async release({ locationId, key, reason, releasedBy }) {
      const { data, error } = await sb.rpc(
        "release_ghl_calendar_appointment_sending",
        {
          p_location_id: locationId,
          p_key: key,
          p_reason: reason,
          p_released_by: releasedBy,
        },
      );
      if (
        error || !data ||
        ![
          "released",
          "already_released",
          "not_found",
          "not_sending",
          "too_recent",
        ]
          .includes(data.decision)
      ) throw new Error("ledger_release_failed");
      return data as ReleaseDecision;
    },
  };
}
