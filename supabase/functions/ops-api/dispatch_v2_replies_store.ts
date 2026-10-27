// deno-lint-ignore-file no-explicit-any
// Dispatch v2, slice 8: the database reads and writes of the reply matcher.
//
// Its own tables (20261023230000_dispatch_v2_replies_tables.sql):
//   dispatch_v2_supplier_emails, dispatch_v2_supplier_order_refs,
//   dispatch_v2_delivery_suggestions, dispatch_v2_reply_scan_state.
// Read only: business_events (the captured mail), jobs, suppliers, users,
// feature_flags. One more write: a job_events row when a person presses
// Assign, Confirm, Accept or Dismiss.
//
// Tables owned by other Dispatch v2 slices are NOT reached here; they go
// through dispatch_v2_replies_sources.ts.
//
// PostgREST returns errors, it does not throw: every call below reads
// `error`, and a failed read throws RepliesStoreError (a 500 at the router).

import {
  type CapturedEmail,
  type JobHint,
  jobNumberForms,
  type SupplierContact,
} from "./dispatch_v2_replies_rules.ts";

export class RepliesStoreError extends Error {
  detail: unknown;
  constructor(label: string, detail: unknown) {
    super(`${label} failed`);
    this.detail = detail;
  }
}

/** A captured inbound email row with what the scan needs to decide to skip it. */
export type CapturedEmailRow = CapturedEmail & {
  capture_mode: string | null;
  history_tier: string | null;
};

export type ScanState = {
  cursor_sequence: number | null;
  last_scan_at: string | null;
  last_result: Record<string, unknown>;
};

export type EmailRow = {
  id: string;
  org_id: string;
  business_event_id: string;
  sequence_number: number;
  provider_message_id: string | null;
  conversation_id: string | null;
  received_at: string | null;
  from_email: string;
  subject: string;
  snippet: string;
  supplier_key: string | null;
  supplier_name: string | null;
  sender_via: string | null;
  order_desk: boolean;
  job_numbers: string[];
  supplier_refs: string[];
  delivery_date: string | null;
  delivery_read: Record<string, unknown> | null;
  state: "matched" | "needs_confirmation" | "unmatched" | "hidden";
  rung: string | null;
  match_reason: string | null;
  job_id: string | null;
  order_id: string | null;
  candidates: unknown[];
  rejected_order_ids: string[];
  decision: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decided_by_email: string | null;
  matched_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RefLinkRow = {
  order_id: string;
  job_id: string;
  supplier_key: string | null;
  supplier_name: string | null;
  ref: string;
  source_email_id: string | null;
  linked_via: "certain_match" | "confirmed_guess" | "assigned";
  linked_by: string | null;
  linked_by_email: string | null;
};

export type SuggestionRow = {
  id: string;
  org_id: string;
  job_id: string;
  order_id: string | null;
  email_id: string;
  supplier_key: string | null;
  supplier_name: string | null;
  delivery_date: string;
  label: string;
  quote: string | null;
  flags: Record<string, unknown>;
  state: "open" | "accepted" | "dismissed" | "superseded";
  accepted_order_id: string | null;
  acted_at: string | null;
  acted_by: string | null;
  acted_by_email: string | null;
  created_at: string;
  updated_at: string;
};

export type NewEmailRow = Omit<EmailRow, "id" | "created_at" | "updated_at">;
export type NewSuggestionRow = Omit<
  SuggestionRow,
  "id" | "created_at" | "updated_at"
>;

/** Everything the engine (dispatch_v2_replies.ts) asks of the database. The
 * tests use an in-memory copy; ops-api uses postgrestRepliesStore. */
export interface RepliesStore {
  flagEnabled(): Promise<boolean>;
  getScanState(): Promise<ScanState>;
  saveScanState(state: ScanState): Promise<void>;
  headSequence(): Promise<number | null>;
  readInboundEmails(
    afterSequence: number,
    recordedBefore: string,
    limit: number,
  ): Promise<CapturedEmailRow[]>;
  /** The captured copy of each of OUR sent emails, by provider key
   * ("email:<message id>") -> its Outlook conversation id. */
  conversationIdsFor(providerKeys: string[]): Promise<Map<string, string>>;
  supplierContacts(orgId: string): Promise<SupplierContact[]>;
  jobsByNumbers(orgId: string, numbers: string[]): Promise<JobHint[]>;
  jobsByIds(orgId: string, ids: string[]): Promise<JobHint[]>;
  refLinks(orgId: string, refs: string[]): Promise<RefLinkRow[]>;
  insertRefLinks(orgId: string, rows: RefLinkRow[]): Promise<void>;
  storedEventIds(ids: string[]): Promise<Set<string>>;
  /** Insert; a row for the same captured email already there is kept and
   * null is returned. */
  insertEmail(row: NewEmailRow): Promise<EmailRow | null>;
  getEmail(orgId: string, id: string): Promise<EmailRow | null>;
  /** Update only while the row is still in `expectState` (two people pressing
   * at once: the second gets null). */
  updateEmail(
    orgId: string,
    id: string,
    expectState: EmailRow["state"],
    patch: Partial<EmailRow>,
  ): Promise<EmailRow | null>;
  emailsForJob(
    orgId: string,
    jobId: string,
    limit: number,
  ): Promise<EmailRow[]>;
  tray(
    orgId: string,
    opts: { includeOther: boolean; limit: number },
  ): Promise<{ rows: EmailRow[]; counts: Record<string, number> }>;
  insertSuggestion(row: NewSuggestionRow): Promise<SuggestionRow | null>;
  getSuggestion(orgId: string, id: string): Promise<SuggestionRow | null>;
  updateSuggestion(
    orgId: string,
    id: string,
    expectState: SuggestionRow["state"],
    patch: Partial<SuggestionRow>,
  ): Promise<SuggestionRow | null>;
  /** Open suggestions for an order become superseded (except `keepId`). */
  supersedeOpenForOrder(
    orgId: string,
    orderId: string,
    keepId: string | null,
    now: string,
  ): Promise<void>;
  suggestionsForJob(orgId: string, jobId: string): Promise<SuggestionRow[]>;
  suggestionsForEmails(
    orgId: string,
    emailIds: string[],
  ): Promise<SuggestionRow[]>;
  /** users row by email (any case) in the org, or null. */
  userByEmail(
    orgId: string,
    email: string,
  ): Promise<{ id: string; email: string } | null>;
  logJobEvent(
    jobId: string,
    userId: string | null,
    eventType: string,
    detail: Record<string, unknown>,
  ): Promise<boolean>;
}

export const DISPATCH_V2_REPLIES_FLAG = "dispatch_v2_replies_v1";
// business_events.source of the Outlook capture reader (outlook-mail-capture).
export const CAPTURE_SOURCE = "outlook-mail-capture";

export const EMAIL_SELECT =
  "id, org_id, business_event_id, sequence_number, provider_message_id, conversation_id, received_at, from_email, subject, snippet, supplier_key, supplier_name, sender_via, order_desk, job_numbers, supplier_refs, delivery_date, delivery_read, state, rung, match_reason, job_id, order_id, candidates, rejected_order_ids, decision, decided_at, decided_by, decided_by_email, matched_at, created_at, updated_at";
export const SUGGESTION_SELECT =
  "id, org_id, job_id, order_id, email_id, supplier_key, supplier_name, delivery_date, label, quote, flags, state, accepted_order_id, acted_at, acted_by, acted_by_email, created_at, updated_at";
export const REF_SELECT =
  "order_id, job_id, supplier_key, supplier_name, ref, source_email_id, linked_via, linked_by, linked_by_email";
export const CAPTURE_SELECT =
  "id, sequence_number, provider_message_id, event_at, recorded_at, privacy_classification, payload, metadata";
const JOB_SELECT =
  "id, job_number, client_name, site_address, site_suburb, status, type";

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function failed(label: string, error: unknown): never {
  console.error(`[dispatch_v2_replies] ${label} failed:`, error);
  throw new RepliesStoreError(label, error);
}

/** The reader writes "Subject: ..." as the body's first line; drop it. */
export function bodyWithoutSubjectLine(body: string): string {
  return body.replace(/^\s*Subject:[^\n]*\n+/i, "");
}

/** A business_events row -> the captured email the rules read. */
export function capturedEmailOf(row: any): CapturedEmailRow {
  const p = row?.payload ?? {};
  const m = row?.metadata ?? {};
  const atts = Array.isArray(p.attachments) ? p.attachments : [];
  return {
    business_event_id: String(row.id),
    sequence_number: Number(row.sequence_number),
    provider_message_id: str(row.provider_message_id) || null,
    received_at: str(row.event_at) || str(row.recorded_at) || null,
    from_email: str(p.from) || str(p.email) || null,
    subject: str(p.subject),
    body: bodyWithoutSubjectLine(str(p.body)),
    conversation_id: str(p.conversation_id) || null,
    sender_kind: str(p.sender_kind) || null,
    has_attachments: p.has_attachments === true,
    attachment_names: atts.map((a: any) => str(a?.name)).filter(Boolean),
    capture_mode: str(m.capture_mode) || null,
    history_tier: str(m.history_tier) || null,
  };
}

function jobHintOf(j: any): JobHint {
  return {
    job_id: String(j.id),
    job_number: j.job_number ?? null,
    client_name: j.client_name ?? null,
    site_address: j.site_address ?? null,
    site_suburb: j.site_suburb ?? null,
    status: j.status ?? null,
    type: j.type ?? null,
  };
}

export function postgrestRepliesStore(client: any): RepliesStore {
  return {
    async flagEnabled() {
      const { data, error } = await client.from("feature_flags")
        .select("enabled")
        .eq("flag_name", DISPATCH_V2_REPLIES_FLAG)
        .maybeSingle();
      if (error) failed("flag read", error);
      return data?.enabled === true;
    },

    async getScanState() {
      const { data, error } = await client.from("dispatch_v2_reply_scan_state")
        .select("cursor_sequence, last_scan_at, last_result")
        .eq("id", "default")
        .maybeSingle();
      if (error) failed("scan state read", error);
      return {
        cursor_sequence: data?.cursor_sequence == null
          ? null
          : Number(data.cursor_sequence),
        last_scan_at: data?.last_scan_at ?? null,
        last_result: data?.last_result ?? {},
      };
    },

    async saveScanState(state) {
      const { error } = await client.from("dispatch_v2_reply_scan_state")
        .upsert({
          id: "default",
          cursor_sequence: state.cursor_sequence,
          last_scan_at: state.last_scan_at,
          last_result: state.last_result,
          updated_at: state.last_scan_at ?? new Date().toISOString(),
        }, { onConflict: "id" });
      if (error) failed("scan state write", error);
    },

    async headSequence() {
      const { data, error } = await client.from("business_events")
        .select("sequence_number")
        .order("sequence_number", { ascending: false })
        .limit(1);
      if (error) failed("head read", error);
      const n = data?.[0]?.sequence_number;
      return n == null ? null : Number(n);
    },

    async readInboundEmails(afterSequence, recordedBefore, limit) {
      // Inbound email saved by the Outlook capture reader only; never the
      // owner-private mailboxes (marnin@, jan@).
      const { data, error } = await client.from("business_events")
        .select(CAPTURE_SELECT)
        .eq("source", CAPTURE_SOURCE)
        .eq("channel", "email")
        .eq("direction", "inbound")
        .gt("sequence_number", afterSequence)
        .lt("recorded_at", recordedBefore)
        .or(
          "privacy_classification.is.null,privacy_classification.neq.restricted_pii",
        )
        .order("sequence_number", { ascending: true })
        .limit(limit);
      if (error) failed("captured mail read", error);
      return (data || []).map(capturedEmailOf);
    },

    async conversationIdsFor(providerKeys) {
      const out = new Map<string, string>();
      for (const keys of chunks([...new Set(providerKeys)], 50)) {
        const { data, error } = await client.from("business_events")
          .select("provider_message_id, payload->>conversation_id")
          .in("provider_message_id", keys);
        if (error) failed("sent copy read", error);
        for (const r of data || []) {
          const conv = str(r.conversation_id);
          if (conv) out.set(String(r.provider_message_id), conv);
        }
      }
      return out;
    },

    async supplierContacts(orgId) {
      const { data, error } = await client.from("suppliers")
        .select("id, name, email")
        .eq("org_id", orgId)
        .not("email", "is", null)
        .limit(2000);
      if (error) failed("supplier contacts read", error);
      return (data || []).map((s: any) => ({
        id: String(s.id),
        name: String(s.name ?? ""),
        email: s.email ?? null,
      }));
    },

    async jobsByNumbers(orgId, numbers) {
      const forms = [...new Set(numbers.flatMap(jobNumberForms))];
      if (forms.length === 0) return [];
      const { data, error } = await client.from("jobs")
        .select(JOB_SELECT)
        .eq("org_id", orgId)
        .in("job_number", forms);
      if (error) failed("jobs by number read", error);
      return (data || []).map(jobHintOf);
    },

    async jobsByIds(orgId, ids) {
      const out: JobHint[] = [];
      for (const part of chunks([...new Set(ids)].filter(Boolean), 100)) {
        const { data, error } = await client.from("jobs")
          .select(JOB_SELECT)
          .eq("org_id", orgId)
          .in("id", part);
        if (error) failed("jobs read", error);
        out.push(...(data || []).map(jobHintOf));
      }
      return out;
    },

    async refLinks(orgId, refs) {
      if (refs.length === 0) return [];
      const { data, error } = await client.from(
        "dispatch_v2_supplier_order_refs",
      )
        .select(REF_SELECT)
        .eq("org_id", orgId)
        .in("ref", [...new Set(refs)]);
      if (error) failed("supplier number read", error);
      return data || [];
    },

    async insertRefLinks(orgId, rows) {
      if (rows.length === 0) return;
      const { error } = await client.from("dispatch_v2_supplier_order_refs")
        .upsert(rows.map((r) => ({ ...r, org_id: orgId })), {
          onConflict: "order_id,ref",
          ignoreDuplicates: true,
        });
      if (error) failed("supplier number write", error);
    },

    async storedEventIds(ids) {
      const out = new Set<string>();
      for (const part of chunks([...new Set(ids)], 100)) {
        const { data, error } = await client.from("dispatch_v2_supplier_emails")
          .select("business_event_id")
          .in("business_event_id", part);
        if (error) failed("stored email read", error);
        for (const r of data || []) out.add(String(r.business_event_id));
      }
      return out;
    },

    async insertEmail(row) {
      const { data, error } = await client.from("dispatch_v2_supplier_emails")
        .upsert(row, {
          onConflict: "business_event_id",
          ignoreDuplicates: true,
        })
        .select(EMAIL_SELECT);
      if (error) failed("supplier email write", error);
      return data?.[0] ?? null;
    },

    async getEmail(orgId, id) {
      const { data, error } = await client.from("dispatch_v2_supplier_emails")
        .select(EMAIL_SELECT)
        .eq("org_id", orgId)
        .eq("id", id)
        .maybeSingle();
      if (error) failed("supplier email read", error);
      return data ?? null;
    },

    async updateEmail(orgId, id, expectState, patch) {
      const { data, error } = await client.from("dispatch_v2_supplier_emails")
        .update(patch)
        .eq("org_id", orgId)
        .eq("id", id)
        .eq("state", expectState)
        .select(EMAIL_SELECT);
      if (error) failed("supplier email update", error);
      return data?.[0] ?? null;
    },

    async emailsForJob(orgId, jobId, limit) {
      const { data, error } = await client.from("dispatch_v2_supplier_emails")
        .select(EMAIL_SELECT)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .in("state", ["matched", "needs_confirmation"])
        .order("received_at", { ascending: false })
        .limit(limit);
      if (error) failed("job emails read", error);
      return data || [];
    },

    async tray(orgId, opts) {
      let q = client.from("dispatch_v2_supplier_emails")
        .select(EMAIL_SELECT)
        .eq("org_id", orgId)
        .in("state", ["unmatched", "needs_confirmation"]);
      // The default view: emails from a supplier's order desk, and every best
      // guess. include_other adds the rest (accounts, marketing).
      if (!opts.includeOther) {
        q = q.or("order_desk.eq.true,state.eq.needs_confirmation");
      }
      const { data, error } = await q
        .order("received_at", { ascending: false })
        .limit(opts.limit);
      if (error) failed("tray read", error);

      const counts: Record<string, number> = {};
      const countOf = async (label: string, build: (q: any) => any) => {
        const r = await build(
          client.from("dispatch_v2_supplier_emails")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId),
        );
        if (r.error) failed(`tray count ${label}`, r.error);
        counts[label] = r.count ?? 0;
      };
      await countOf(
        "needs_confirmation",
        (q) => q.eq("state", "needs_confirmation"),
      );
      await countOf(
        "unmatched_order_desk",
        (q) => q.eq("state", "unmatched").eq("order_desk", true),
      );
      await countOf(
        "unmatched_other",
        (q) => q.eq("state", "unmatched").eq("order_desk", false),
      );
      return { rows: data || [], counts };
    },

    async insertSuggestion(row) {
      const { data, error } = await client.from(
        "dispatch_v2_delivery_suggestions",
      )
        .upsert(row, { onConflict: "email_id", ignoreDuplicates: true })
        .select(SUGGESTION_SELECT);
      if (error) failed("suggestion write", error);
      return data?.[0] ?? null;
    },

    async getSuggestion(orgId, id) {
      const { data, error } = await client.from(
        "dispatch_v2_delivery_suggestions",
      )
        .select(SUGGESTION_SELECT)
        .eq("org_id", orgId)
        .eq("id", id)
        .maybeSingle();
      if (error) failed("suggestion read", error);
      return data ?? null;
    },

    async updateSuggestion(orgId, id, expectState, patch) {
      const { data, error } = await client.from(
        "dispatch_v2_delivery_suggestions",
      )
        .update(patch)
        .eq("org_id", orgId)
        .eq("id", id)
        .eq("state", expectState)
        .select(SUGGESTION_SELECT);
      if (error) failed("suggestion update", error);
      return data?.[0] ?? null;
    },

    async supersedeOpenForOrder(orgId, orderId, keepId, now) {
      let q = client.from("dispatch_v2_delivery_suggestions")
        .update({ state: "superseded", updated_at: now })
        .eq("org_id", orgId)
        .eq("order_id", orderId)
        .eq("state", "open");
      if (keepId) q = q.neq("id", keepId);
      const { error } = await q;
      if (error) failed("suggestion supersede", error);
    },

    async suggestionsForJob(orgId, jobId) {
      const { data, error } = await client.from(
        "dispatch_v2_delivery_suggestions",
      )
        .select(SUGGESTION_SELECT)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) failed("job suggestions read", error);
      return data || [];
    },

    async suggestionsForEmails(orgId, emailIds) {
      const out: SuggestionRow[] = [];
      for (const part of chunks([...new Set(emailIds)], 100)) {
        const { data, error } = await client.from(
          "dispatch_v2_delivery_suggestions",
        )
          .select(SUGGESTION_SELECT)
          .eq("org_id", orgId)
          .in("email_id", part);
        if (error) failed("email suggestions read", error);
        out.push(...(data || []));
      }
      return out;
    },

    async userByEmail(orgId, email) {
      const raw = email.trim();
      const { data, error } = await client.from("users")
        .select("id, email, org_id")
        .eq("org_id", orgId)
        .in("email", [...new Set([raw, raw.toLowerCase()])]);
      if (error) failed("operator read", error);
      const match = (data || []).find((u: any) =>
        String(u.email || "").toLowerCase() === raw.toLowerCase()
      );
      return match
        ? { id: String(match.id), email: String(match.email) }
        : null;
    },

    async logJobEvent(jobId, userId, eventType, detail) {
      const { error } = await client.from("job_events").insert({
        job_id: jobId,
        user_id: userId,
        event_type: eventType,
        detail_json: detail,
      });
      if (error) {
        console.error("[dispatch_v2_replies] job_events insert failed:", error);
        return false;
      }
      return true;
    },
  };
}
