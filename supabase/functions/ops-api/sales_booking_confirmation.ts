/** Booking confirmation projection and independent approval records.
 * This module has no provider or send capability. Contract:
 * docs/sales-booking-confirmation-api.md.
 */
import {
  type SalesBookingCase,
  salesBookingLeadBelongsTo,
  type SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  assertSalesBookingStampWriteAuth,
  type SalesBookingEnvGet,
  type SalesBookingPackAuth,
  SalesBookingPackError,
} from "./sales_booking_pack.ts";
import {
  BOOKING_APPROVAL_TTL_MS,
  bookingContentHash,
  bookingHash,
  bookingInstant as timestamp,
  canonicalBookingJson,
} from "../_shared/booking_approval_gate.ts";
import {
  type OwnerApprovalDeps,
  type OwnerApprovalResult,
  salesBookingOwnerApprovalAction,
} from "./sales_booking_owner_approval.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  salesBookingSenderFor,
} from "./sales_booking_sender.ts";
export {
  BOOKING_APPROVAL_TTL_MS,
  bookingContentHash,
  bookingHash,
  canonicalBookingJson,
};

// JSON from the versioned producer is preserved, including future diagnostic keys.
// deno-lint-ignore no-explicit-any
export type BookingObject = Record<string, any>;
export type BookingStep = "calendar" | "message";
const PROFILE = "fencing-stratco-marnin";
/** The engine profile for one booking person, or null for anyone else. */
function resourceProfile(resourceId: unknown): string | null {
  return typeof resourceId === "string" &&
      Object.hasOwn(SALES_BOOKING_SENDER_LINES, resourceId)
    ? SALES_BOOKING_SENDER_LINES[resourceId].profile
    : null;
}
const SCHEMA = "scope-booking-lead.v1";
const obj = (v: unknown): v is BookingObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim();
const hashPattern = /^[a-f0-9]{64}$/;
const opportunity = (id: string) => id.replace(/^opp:/, "");

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

/** Published evidence only. A diary read cannot fill missing person-wide sources. */
function publishedBookingFlow(
  models: BookingObject[],
  publishedAt: string | null,
  now: Date,
): BookingObject {
  const flow: BookingObject = emptyBookingFlow();
  const evidence = models.map((m) => ({
    model: m,
    read: m.validation?.availability,
  }));
  const stale = !Number.isFinite(timestamp(publishedAt)) ||
    timestamp(publishedAt) > now.getTime() ||
    models.some((m) => !(timestamp(m.expires_at) > now.getTime()));
  const stamp = { as_of: publishedAt, stale };
  flow.calendar_read = {
    ...flow.calendar_read,
    ...stamp,
    occupied_intervals: null,
  };
  flow.commitments_read = { state: "could_not_read", ...stamp };
  if (!models.length) return flow;
  const readsValid = evidence.every(({ read }) =>
    obj(read) &&
    ["read", "could_not_read", "not_configured"].includes(read.state) &&
    (read.state !== "read" || (Array.isArray(read.occupied_intervals) &&
      read.occupied_intervals.every((slot: unknown) =>
        obj(slot) &&
        timestamp(slot.end_iso ?? slot.end) >
          timestamp(slot.start_iso ?? slot.start)
      )))
  );
  if (readsValid) {
    const unread = evidence.find(({ read }) => read.state !== "read");
    flow.calendar_read = {
      state: stale ? "stale" : unread?.read.state ?? "read",
      provider: "ghl",
      reason: stale
        ? "published_booking_model_expired"
        : unread?.read.reason ?? null,
      occupied_intervals: unread
        ? null
        : evidence.flatMap(({ read }) => read.occupied_intervals),
      ...stamp,
    };
  }
  // Every model must carry its census. Never substitute [] for an absent census.
  const slots = new Map<string, BookingObject>();
  let slotsValid = true;
  for (const model of models) {
    if (!Array.isArray(model.prior_offers)) {
      slotsValid = false;
      break;
    }
    for (const source of model.prior_offers) {
      if (!obj(source)) {
        slotsValid = false;
        break;
      }
      const slot: BookingObject = {
        ...source,
        id: source.id ?? source.slot_id,
        start_iso: source.start_iso ?? source.start,
        end_iso: source.end_iso ?? source.end,
      };
      if (
        !nonempty(slot.id) || !nonempty(slot.contact_id) ||
        !["offered", "agreed"].includes(slot.state) ||
        !(timestamp(slot.end_iso) > timestamp(slot.start_iso)) ||
        (slots.has(slot.id) &&
          canonicalBookingJson(slots.get(slot.id)) !==
            canonicalBookingJson(slot))
      ) {
        slotsValid = false;
        break;
      }
      slots.set(slot.id, slot);
    }
  }
  if (slotsValid) {
    flow.commitments = [...slots.values()].map((slot) => ({
      ...slot,
      ...stamp,
    }));
    flow.commitments_read = { state: stale ? "stale" : "read", ...stamp };
  }
  return flow;
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
    profile: resourceProfile(row.resource_id),
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
  now = new Date(),
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
  const matched = models.filter((m) =>
    response.cases.some((row) =>
      opportunity(m.id) === row.opportunity_id &&
      m.contact_id === row.contact_id &&
      counts.get(row.contact_id) === 1 &&
      m.profile === resourceProfile(row.resource_id)
    )
  );
  return {
    ...response,
    resource: { ...response.resource, id: response.resource.resource_id },
    booking_flow: {
      ...response.booking_flow,
      ...publishedBookingFlow(matched, response.pack.as_of, now),
    },
    cases: response.cases.map((row) => {
      const candidate = matched.find((m) =>
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

// content_hash binds identity/revision and the entire channel content; it is
// NOT SHA256(text) alone. bookingContentHash lives in the shared gate so the
// executor and the GHL writer verify it the same way.
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
  /** The opportunity's current GHL assignee (live, not the cached roster). */
  readOpportunityAssignee?: (opportunityId: string) => Promise<string | null>;
  now?: () => Date;
  envGet?: SalesBookingEnvGet;
}): Promise<{ ok: true; approval: BookingApprovalRecord }> {
  if (args.method !== "POST") {
    fail("sales_booking_approval_write requires POST", 405);
  }
  if (obj(args.body) && args.body.owner_input !== undefined) {
    fail("owner_input_requires_owner_path", 400);
  }
  const email = assertSalesBookingStampWriteAuth(args.auth, args.envGet);
  if (!args.auth.userId) fail("approval_actor_required", 403);
  const { snapshot, decision, reason } = args.body;
  if (
    !obj(snapshot) || !["calendar", "message"].includes(snapshot.step) ||
    !["approved", "refused"].includes(decision)
  ) fail("invalid_independent_approval", 400);
  // Each booking person approves on their own profile. A visit is still
  // booked only on the Stratco profile; Nithin and Khairo approve texts.
  const profile = resourceProfile(snapshot.resource);
  if (!profile || snapshot.profile !== profile) {
    fail("booking_profile_required", 400);
  }
  if (snapshot.step === "calendar" && snapshot.profile !== PROFILE) {
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
    opportunity(model.id) !== row.opportunity_id || model.profile !== profile ||
    !hashPattern.test(model.pack_revision ?? "")
  ) fail("current_booking_model_required");
  // The lead must be this person's in GHL right now, read live: a lead
  // assigned to someone else never takes this person's path or line.
  if (decision === "approved") {
    await assertLeadBelongsToResource(
      args.readOpportunityAssignee,
      row.opportunity_id,
      snapshot.resource,
    );
  }
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
  // An exact-text approval stands on its own: a text that names no time
  // ("does Friday suit?") has no calendar operation to prove. The executor
  // (sales_booking_execute.ts) re-checks the thread and route at the press.
  if (decision === "approved" && snapshot.step === "calendar") {
    const flow = response.booking_flow;
    if (
      !response.coverage.full_population ||
      flow?.calendar_read?.state !== "read" ||
      flow.calendar_read.provider !== "ghl" ||
      flow.commitments_read?.state === "stale" ||
      !Array.isArray(flow.commitments)
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
    // No 60-second external freshness gate: the external engine only runs in
    // a terminal, so it could never be met live. sales_booking_book re-reads
    // GHL and Outlook for a clash on the server at the moment of the press.
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
  }
  if (
    decision === "approved" && snapshot.step === "message" &&
    (!nonempty(expected.content.text) ||
      !/^\+[1-9]\d{7,14}$/.test(expected.content.sender) ||
      !/^\+[1-9]\d{7,14}$/.test(expected.content.recipient))
  ) fail("exact_message_route_required");
  // An approved text must go from the visit person's own line; the executor
  // re-checks this at the press.
  if (decision === "approved" && snapshot.step === "message") {
    const who = salesBookingSenderFor(expected);
    if (!who.ok) fail(who.reason);
    if (expected.content.sender !== who.sender.line) {
      fail("sender_not_scoper_line");
    }
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

/** Refuse unless the opportunity's live GHL assignee makes it `resource`'s
 * lead (sales_booking_read.ts `salesBookingLeadBelongsTo`). */
export async function assertLeadBelongsToResource(
  readOpportunityAssignee:
    | ((opportunityId: string) => Promise<string | null>)
    | undefined,
  opportunityId: string | null | undefined,
  resource: string,
): Promise<void> {
  if (!readOpportunityAssignee || !opportunityId) {
    fail("opportunity_assignment_unreadable");
  }
  let assignee: string | null;
  try {
    assignee = await readOpportunityAssignee(opportunityId);
  } catch {
    fail("opportunity_assignment_unreadable");
  }
  if (!salesBookingLeadBelongsTo(assignee, resource)) {
    fail("lead_assigned_to_someone_else");
  }
}

/** `sales_booking_approval_write`: an `owner_input` body is an
 * owner-authored approval (sales_booking_owner_approval.ts); a `snapshot`
 * body is the engine-published path above, unchanged. */
export async function salesBookingApprovalWriteRoute(
  args: Parameters<typeof salesBookingApprovalWriteAction>[0] & {
    /** Reads for an owner-authored approval. The engine path never uses them. */
    owner?: Omit<
      OwnerApprovalDeps,
      "store" | "readWorkspace" | "envGet" | "now"
    >;
  },
): Promise<
  { ok: true; approval: BookingApprovalRecord } | OwnerApprovalResult
> {
  const { owner, ...engine } = args;
  if (!obj(args.body) || args.body.owner_input === undefined) {
    return await salesBookingApprovalWriteAction(engine);
  }
  if (args.method !== "POST") {
    fail("sales_booking_approval_write requires POST", 405);
  }
  if (args.body.snapshot !== undefined) {
    fail("owner_input_and_snapshot_are_exclusive", 400);
  }
  if (!owner) fail("owner_approval_unavailable", 503);
  return await salesBookingOwnerApprovalAction({
    auth: args.auth,
    body: args.body,
    method: args.method,
    deps: {
      ...owner,
      store: args.store,
      readWorkspace: args.readWorkspace,
      envGet: args.envGet,
      now: args.now,
    },
  });
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
      ...result.booking_flow,
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
    // An approval is not an execution receipt and must never clear
    // pending, unknown, succeeded, or failed execution.
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
