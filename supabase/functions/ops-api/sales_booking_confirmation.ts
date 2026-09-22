/** Booking confirmation projection and independent approval records.
 * This module has no provider or send capability. Contract:
 * docs/sales-booking-confirmation-api.md.
 */
import type {
  SalesBookingCase,
  SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  assertSalesBookingStampWriteAuth,
  type SalesBookingEnvGet,
  type SalesBookingPackAuth,
  SalesBookingPackError,
} from "./sales_booking_pack.ts";

// JSON from the versioned producer is preserved, including future diagnostic keys.
// deno-lint-ignore no-explicit-any
export type BookingObject = Record<string, any>;
export type BookingStep = "calendar" | "message";
export const BOOKING_APPROVAL_TTL_MS = 15 * 60_000;
const PROFILE = "fencing-stratco-marnin";
const SCHEMA = "scope-booking-lead.v1";
const obj = (v: unknown): v is BookingObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim();
const hashPattern = /^[a-f0-9]{64}$/;
const opportunity = (id: string) => id.replace(/^opp:/, "");

/** Key order independent; string bytes (including whitespace) are untouched. */
export function canonicalBookingJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBookingJson).join(",")}]`;
  }
  if (obj(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalBookingJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}
export async function bookingHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalBookingJson(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function fail(reason: string, status = 409): never {
  throw new SalesBookingPackError(reason, status);
}

export function emptyBookingFlow() {
  return {
    version: "booking-confirm.v1",
    approval_write: "separate-v1",
    calendar_read: {
      state: "could_not_read",
      provider: "ghl",
      reason: "person_wide_calendars_and_prior_offer_ledger_not_connected",
    },
    // Null is deliberate: an empty array would invent a complete empty ledger.
    commitments: null,
  };
}

/** Transfer format wraps the producer's exact index.json and files by filename.
 * Never enumerate files: only index.leads selects the current generation.
 */
export function selectBookingModels(bundle: unknown): BookingObject[] {
  if (bundle == null) return [];
  if (
    !obj(bundle) || !obj(bundle.index) || bundle.index.schema !== SCHEMA ||
    !Array.isArray(bundle.index.leads) || !obj(bundle.files) ||
    bundle.index.leads.length > 500
  ) fail("invalid_booking_model_manifest", 400);
  const ids = new Set<string>(), contacts = new Set<string>();
  let revision: string | null = null;
  return bundle.index.leads.map((entry: unknown) => {
    if (
      !obj(entry) || !nonempty(entry.id) || !nonempty(entry.contact_id) ||
      typeof entry.file !== "string" || !/^[a-f0-9]{64}\.json$/.test(entry.file)
    ) fail("invalid_booking_model_entry", 400);
    const model = bundle.files[entry.file];
    if (
      !obj(model) || model.schema !== SCHEMA || model.id !== entry.id ||
      model.contact_id !== entry.contact_id ||
      !nonempty(model.profile) || typeof model.pack_revision !== "string" ||
      !hashPattern.test(model.pack_revision)
    ) fail("booking_model_identity_mismatch", 400);
    if (
      (model.proposal != null && !obj(model.proposal)) ||
      (model.evidence_quotes != null &&
        (!Array.isArray(model.evidence_quotes) ||
          model.evidence_quotes.some((e: unknown) =>
            !obj(e) || !nonempty(e.message_id) || !nonempty(e.quote)
          ))) ||
      (model.validation != null && (!obj(model.validation) ||
        (model.validation.reasons != null &&
          (!Array.isArray(model.validation.reasons) ||
            model.validation.reasons.some((r: unknown) =>
              typeof r !== "string"
            ))) ||
        (model.validation.checks != null &&
          (!Array.isArray(model.validation.checks) ||
            model.validation.checks.some((c: unknown) =>
              !obj(c) || !nonempty(c.label) || typeof c.passed !== "boolean"
            ))))) ||
      (model.calendar_write != null && !obj(model.calendar_write)) ||
      (model.message != null && !obj(model.message))
    ) fail("booking_model_fields_malformed", 400);
    if (ids.has(opportunity(model.id)) || contacts.has(model.contact_id)) {
      fail("booking_model_identity_ambiguous", 400);
    }
    if (revision !== null && revision !== model.pack_revision) {
      fail("booking_model_mixed_revisions", 400);
    }
    revision = model.pack_revision;
    ids.add(opportunity(model.id));
    contacts.add(model.contact_id);
    return structuredClone(model);
  });
}

function projectedModel(
  row: SalesBookingCase,
  model: BookingObject | undefined,
  reason: string | null,
): BookingObject {
  const m = model ?? {
    schema: SCHEMA,
    id: `opp:${row.opportunity_id}`,
    contact_id: row.contact_id,
    profile: row.resource_id === "marnin" ? PROFILE : "patio-nithin",
    pack_revision: null,
    proposal: null,
  };
  const missing: BookingObject = { ...(m.unavailable_fields ?? {}) };
  const nullable = (value: unknown, key: string, why: string) => {
    if (value == null) {
      missing[key] = why;
      return null;
    }
    return value;
  };
  const validation = obj(m.validation) ? m.validation : {
    ok: false,
    reasons: [reason || "booking_read_model_not_published"],
    requires_fresh_read: true,
  };
  return {
    ...m,
    expires_at: nullable(
      m.expires_at,
      "expires_at",
      "producer_expiry_not_published",
    ),
    evidence_quotes: nullable(
      m.evidence_quotes,
      "evidence_quotes",
      "source_message_quotes_not_published",
    ),
    validation: {
      ...validation,
      checks: nullable(
        validation.checks,
        "validation.checks",
        "individual_validation_checks_not_published",
      ),
    },
    calendar_write: projectApprovalChannel({
      state: "awaiting_approval",
      approval: null,
      receipt: null,
      ...m.calendar_write,
      preview: nullable(
        m.calendar_write?.preview,
        "calendar_write.preview",
        "owner_configured_calendar_operation_not_published",
      ),
    }),
    message: projectApprovalChannel({
      state: "awaiting_approval",
      approval: null,
      receipt: null,
      chosen: null,
      approved_text: null,
      ...m.message,
      template_text: nullable(
        m.message?.template_text,
        "message.template_text",
        "locked_template_not_published",
      ),
      ai_proposed_text: null,
      routing: nullable(
        m.message?.routing,
        "message.routing",
        "exact_sender_recipient_route_not_published",
      ),
    }),
    unavailable_fields: {
      ...missing,
      "message.ai_proposed_text":
        "alternate_ai_text_not_supported_in_launch_contract",
      ...(reason ? { booking_read_model: reason } : {}),
    },
  };
}

/** Overlay producer models only by exact contact AND opportunity identity. */
export function applyBookingConfirmationModels(
  response: SalesBookingReadResponse,
  bundle: unknown,
): SalesBookingReadResponse {
  let models: BookingObject[] = [], reason: string | null = null;
  try {
    models = selectBookingModels(bundle);
  } catch (e) {
    reason = (e as Error).message;
  }
  const counts = new Map<string | null, number>();
  for (const row of response.cases) {
    counts.set(row.contact_id, (counts.get(row.contact_id) ?? 0) + 1);
  }
  return {
    ...response,
    resource: { ...response.resource, id: response.resource.resource_id },
    booking_flow: emptyBookingFlow(),
    cases: response.cases.map((row) => {
      const candidate = models.find((m) =>
        opportunity(m.id) === row.opportunity_id &&
        m.contact_id === row.contact_id
      );
      const ambiguous = (counts.get(row.contact_id) ?? 0) !== 1;
      return {
        ...row,
        booking_read_model: projectedModel(
          row,
          ambiguous ? undefined : candidate,
          reason ||
            (ambiguous
              ? "booking_case_contact_ambiguous"
              : candidate
              ? null
              : "current_manifest_model_not_published"),
        ),
      };
    }),
  };
}

/** Exactly the merged UI approvalSnapshot() shape. No caller content is trusted. */
export function bookingApprovalSnapshot(
  response: SalesBookingReadResponse,
  row: SalesBookingCase,
  step: BookingStep,
): BookingObject {
  const m = row.booking_read_model ?? {},
    p = m.proposal,
    preview = m.calendar_write?.preview ?? {},
    msg = m.message ?? {},
    route = msg.routing ?? {};
  return {
    schema: "scope-booking-approval.v1",
    step,
    case_id: row.id,
    contact_id: row.contact_id,
    resource: response.resource.resource_id,
    scoper_user_id: response.resource.scoper_user_id,
    week_start: response.week_start,
    id: m.id,
    profile: m.profile,
    pack_revision: m.pack_revision,
    content_hash:
      (step === "calendar" ? preview.content_hash : route.message_sha256) ??
        null,
    content: step === "calendar"
      ? {
        provider: preview.provider ?? null,
        calendar_id: preview.calendar_id ?? null,
        assigned_user_id: preview.assigned_user_id ?? null,
        start_iso: preview.start ?? p?.window?.start ?? null,
        end_iso: preview.end ?? null,
        window_start_iso: p?.window?.start ?? null,
        window_end_iso: p?.window?.end ?? null,
        title: preview.title ?? null,
        address: preview.site_address ?? null,
      }
      : {
        text: msg.template_text ?? null,
        sender: route.from_number ?? null,
        recipient: route.to_number ?? null,
        variant: "template",
      },
  };
}

/** content_hash binds identity/revision and the entire channel content; it is
 * NOT SHA256(text) alone. Producer and UI handoff use this canonical form. */
export function bookingContentHash(snapshot: BookingObject): Promise<string> {
  const { content_hash: _ignored, ...binding } = snapshot;
  return bookingHash(binding);
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}
function isRecordedApprovalState(state: unknown): boolean {
  return state === "approved" || state === "held" || state === "refused";
}
function projectApprovalChannel(channel: BookingObject): BookingObject {
  if (!isRecordedApprovalState(channel.state)) return channel;
  return { ...channel, state: "awaiting_approval" };
}
function clearUnrecordedApprovalAuthority(channel: BookingObject | undefined) {
  if (!channel || !isRecordedApprovalState(channel.state)) return;
  channel.state = "awaiting_approval";
  channel.reason = "approval_expired_or_binding_unverified";
}
function approvalRecordAuthorizes(
  record: BookingApprovalRecord,
  snapshot: BookingObject,
  now: Date,
): boolean {
  if (
    canonicalBookingJson(record.snapshot) !== canonicalBookingJson(snapshot)
  ) return false;
  const recorded = timestamp(record.approved_at);
  const expires = timestamp(record.expires_at);
  if (!Number.isFinite(recorded) || !Number.isFinite(expires)) return false;
  const latest = Math.min(expires, recorded + BOOKING_APPROVAL_TTL_MS);
  return now.getTime() >= recorded && now.getTime() < latest;
}

export interface BookingApprovalRecord {
  binding_hash: string;
  step: BookingStep;
  resource: string;
  week_start: string;
  state: "approved" | "refused";
  reason: string | null;
  snapshot: BookingObject;
  approved_by_user_id: string;
  approved_by_email: string;
  approved_at: string;
  expires_at: string;
}
export interface BookingApprovalStore {
  find(hashes: string[]): Promise<BookingApprovalRecord[]>;
  insert(record: BookingApprovalRecord): Promise<BookingApprovalRecord>;
}

/** Same service-role-only append/read pattern as sales_booking_packs; separate
 * table prevents either legacy combined stamps or the other channel being changed. */
export function bookingApprovalStore(
  client: { from: (table: string) => BookingObject },
): BookingApprovalStore {
  const columns =
    "binding_hash,step,resource,week_start,state,reason,snapshot,approved_by_user_id,approved_by_email,approved_at,expires_at";
  const find = async (hashes: string[]): Promise<BookingApprovalRecord[]> => {
    if (!hashes.length) return [];
    const rows: BookingApprovalRecord[] = [];
    for (let i = 0; i < hashes.length; i += 50) {
      const { data, error } = await client.from("sales_booking_approvals")
        .select(columns).in("binding_hash", hashes.slice(i, i + 50));
      if (error || !Array.isArray(data)) {
        fail("booking_approvals_unreadable", 503);
      }
      rows.push(...data);
    }
    return rows;
  };
  return {
    find,
    async insert(record) {
      const { data, error } = await client.from("sales_booking_approvals")
        .insert(record).select(columns).single();
      if (error?.code === "23505") {
        const [existing] = await find([record.binding_hash]);
        if (existing) return existing;
      }
      if (error || !data) fail("booking_approval_write_failed", 503);
      return data;
    },
  };
}

export async function salesBookingApprovalWriteAction(args: {
  store: BookingApprovalStore;
  auth: SalesBookingPackAuth;
  body: BookingObject;
  method: string;
  readWorkspace: (
    resource: string,
    week: string,
  ) => Promise<SalesBookingReadResponse>;
  now?: () => Date;
  envGet?: SalesBookingEnvGet;
}): Promise<{ ok: true; approval: BookingApprovalRecord }> {
  if (args.method !== "POST") {
    fail("sales_booking_approval_write requires POST", 405);
  }
  const email = assertSalesBookingStampWriteAuth(args.auth, args.envGet);
  if (!args.auth.userId) fail("approval_actor_required", 403);
  const { snapshot, decision, reason } = args.body;
  if (
    !obj(snapshot) || !["calendar", "message"].includes(snapshot.step) ||
    !["approved", "refused"].includes(decision)
  ) fail("invalid_independent_approval", 400);
  if (snapshot.resource !== "marnin" || snapshot.profile !== PROFILE) {
    fail("stratco_profile_required", 400);
  }
  if (decision === "refused" && (!nonempty(reason) || reason.length > 1000)) {
    fail("refusal_reason_required", 400);
  }
  const response = await args.readWorkspace(
    snapshot.resource,
    snapshot.week_start,
  );
  const now = (args.now ?? (() => new Date()))(); // after potentially slow fresh reads
  const matches = response.cases.filter((row) =>
    row.contact_id === snapshot.contact_id
  );
  const row = matches[0];
  if (
    matches.length !== 1 || !row || row.id !== snapshot.case_id ||
    !row.booking_read_model
  ) fail("booking_case_identity_ambiguous");
  const model = row.booking_read_model;
  if (
    model.contact_id !== row.contact_id ||
    opportunity(model.id) !== row.opportunity_id || model.profile !== PROFILE ||
    !hashPattern.test(model.pack_revision ?? "")
  ) fail("current_booking_model_required");
  const expected = bookingApprovalSnapshot(response, row, snapshot.step);
  if (canonicalBookingJson(snapshot) !== canonicalBookingJson(expected)) {
    fail("approval_snapshot_changed");
  }
  if (
    !hashPattern.test(snapshot.content_hash ?? "") ||
    await bookingContentHash(expected) !== snapshot.content_hash
  ) fail("approval_content_hash_mismatch");
  if (!(timestamp(model.expires_at) > now.getTime())) fail("proposal_expired");
  const channel = snapshot.step === "calendar"
    ? model.calendar_write
    : model.message;
  if (["pending", "unknown", "succeeded", "failed"].includes(channel?.state)) {
    fail("booking_step_requires_reconciliation");
  }
  if (decision === "approved") {
    const flow = response.booking_flow;
    if (
      !response.coverage.full_population ||
      flow?.calendar_read?.state !== "read" ||
      flow.calendar_read.provider !== "ghl" || !Array.isArray(flow.commitments)
    ) fail("current_person_availability_unavailable");
    const validation = model.validation;
    if (
      validation?.ok !== true || !Array.isArray(validation.checks) ||
      !validation.checks.length || validation.checks.some((c: BookingObject) =>
        c.passed !== true
      )
    ) fail("booking_validation_not_passed");
    const labels = new Set(
      validation.checks.map((c: BookingObject) => c.label),
    );
    for (
      const required of [
        "calendar",
        "protected_band",
        "hours",
        "travel",
        "daily_capacity",
      ]
    ) if (!labels.has(required)) fail(`booking_validation_missing:${required}`);
    const checked = timestamp(validation.checked_at);
    if (!(checked <= now.getTime() && now.getTime() - checked <= 60_000)) {
      fail("booking_validation_stale");
    }
    if (
      !Array.isArray(model.evidence_quotes) || !model.evidence_quotes.length ||
      model.evidence_quotes.some((e: BookingObject) =>
        !nonempty(e.message_id) || !nonempty(e.quote)
      )
    ) fail("customer_evidence_missing");
    const cal = bookingApprovalSnapshot(response, row, "calendar").content;
    if (
      cal.provider !== "ghl" || Object.values(cal).some((v) => !nonempty(v)) ||
      !String(cal.start_iso).endsWith("+08:00") ||
      !String(cal.end_iso).endsWith("+08:00") ||
      !(timestamp(cal.start_iso) > now.getTime()) ||
      !(timestamp(cal.window_end_iso) > timestamp(cal.window_start_iso)) ||
      cal.start_iso !== cal.window_start_iso ||
      !(timestamp(cal.end_iso) > timestamp(cal.window_end_iso))
    ) fail("calendar_operation_incomplete");
    for (const slot of flow.commitments) {
      if (
        !nonempty(slot.id) || !nonempty(slot.contact_id) ||
        !["offered", "agreed"].includes(slot.state) ||
        !(timestamp(slot.end_iso) > timestamp(slot.start_iso))
      ) fail("prior_offer_ledger_malformed");
      if (
        slot.id === model.proposal?.commitment_id &&
        slot.contact_id === row.contact_id &&
        slot.start_iso === cal.start_iso && slot.end_iso === cal.end_iso
      ) continue;
      if (
        timestamp(slot.start_iso) < timestamp(cal.end_iso) &&
        timestamp(slot.end_iso) > timestamp(cal.start_iso)
      ) fail("prior_offer_conflict");
    }
    if (
      snapshot.step === "message" &&
      (!nonempty(expected.content.text) ||
        !/^\+[1-9]\d{7,14}$/.test(expected.content.sender) ||
        !/^\+[1-9]\d{7,14}$/.test(expected.content.recipient))
    ) fail("exact_message_route_required");
  }
  const record: BookingApprovalRecord = {
    binding_hash: await bookingHash(expected),
    step: snapshot.step,
    resource: response.resource.resource_id,
    week_start: response.week_start,
    state: decision,
    reason: decision === "refused" ? reason : null,
    snapshot: expected,
    approved_by_user_id: args.auth.userId,
    approved_by_email: email,
    approved_at: now.toISOString(),
    expires_at: new Date(
      Math.min(
        now.getTime() + BOOKING_APPROVAL_TTL_MS,
        timestamp(model.expires_at),
      ),
    ).toISOString(),
  };
  const written = await args.store.insert(record);
  if (
    written.state !== record.state || written.reason !== record.reason ||
    canonicalBookingJson(written.snapshot) !==
      canonicalBookingJson(record.snapshot)
  ) fail("approval_decision_already_recorded");
  if (!(timestamp(written.expires_at) > now.getTime())) {
    fail("approval_expired_requires_new_proposal");
  }
  return { ok: true, approval: written };
}

export async function applyBookingApprovals(
  response: SalesBookingReadResponse,
  store: BookingApprovalStore,
  now = new Date(),
): Promise<SalesBookingReadResponse> {
  const result = structuredClone(response);
  const bindings: Array<
    {
      row: SalesBookingCase;
      step: BookingStep;
      snapshot: BookingObject;
      hash: string;
    }
  > = [];
  for (const row of result.cases) {
    const model = row.booking_read_model;
    if (!model) continue;
    for (const step of ["calendar", "message"] as const) {
      const channel = step === "calendar"
        ? model.calendar_write
        : model.message;
      clearUnrecordedApprovalAuthority(channel);
      if (!model.pack_revision) continue;
      const snapshot = bookingApprovalSnapshot(result, row, step);
      bindings.push({ row, step, snapshot, hash: await bookingHash(snapshot) });
    }
  }
  let records: BookingApprovalRecord[];
  try {
    records = await store.find(bindings.map((b) => b.hash));
  } catch {
    result.booking_flow = {
      ...emptyBookingFlow(),
      approval_write: null,
      approval_read_error: "booking_approvals_unreadable",
    };
    return result;
  }
  for (const b of bindings) {
    const record = records.find((r) =>
      r.binding_hash === b.hash && r.step === b.step
    );
    if (!record || !approvalRecordAuthorizes(record, b.snapshot, now)) continue;
    const model = b.row.booking_read_model!;
    const channel = b.step === "calendar"
      ? model.calendar_write
      : model.message;
    // An approval is not an execution receipt and must never clear unknown/pending.
    if (["pending", "unknown", "succeeded", "failed"].includes(channel.state)) {
      continue;
    }
    channel.state = record.state;
    channel.reason = record.reason;
    channel.approval = {
      ...channel.approval,
      ...record,
      ui_snapshot: record.snapshot,
    };
    if (b.step === "message" && record.state === "approved") {
      channel.chosen = "template";
      channel.approved_text = record.snapshot.content.text;
    }
  }
  return result;
}
