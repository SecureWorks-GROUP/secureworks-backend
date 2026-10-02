/**
 * Booking-lane lead draft jobs (context unit A3).
 *
 * A lead waiting to book usually has no `jobs` row (0 of 12 in the 21 Sep
 * Stratco cohort), and the context pass only reads and briefs jobs. The
 * existing draft creators do not reach these leads: ghl-webhook's form
 * fallback (`handleFormSubmission`) only runs for GHL form/contact posts, and
 * ghl-proxy `create_job` / `sync_ghl` are manual. `ensure_booking_draft_job`
 * (20260921140000) is the idempotent per-contact mint; nothing called it.
 *
 * After the booking read has listed one person's leads, this mints one draft
 * per lead that has no job at all, behind `booking_lead_draft_job_v1`
 * (missing, unreadable or not exactly true reads as OFF: no read, no write).
 *
 * A lead is untouched when:
 *   - any job (any status) carries its GHL opportunity id, or
 *   - its contact has an open job (anything but the terminal statuses
 *     `context_contact_jobs` excludes), which includes the 561 form drafts.
 * The RPC then re-checks the contact under an advisory lock (contact_matches
 * included) and returns `existing` / `ambiguous` rather than inserting a twin.
 * If the linked-jobs read fails, nothing is minted.
 *
 * Writes nothing else: no GHL, no message, no calendar, no status move. The
 * job insert trigger (`context_job_created_reconsider`, P1b) places the
 * contact's lead-window evidence on the new draft.
 */

export const BOOKING_LEAD_DRAFT_FLAG = "booking_lead_draft_job_v1";

/** Same terminal set as `context_contact_jobs` (20260921140000). */
export const BOOKING_LEAD_TERMINAL_STATUSES: readonly string[] = [
  "cancelled",
  "archived",
  "lost",
  "closed",
  "complete",
  "completed",
];

export const BOOKING_LEAD_DRAFT_MAX_PER_READ = 50;
export const BOOKING_LEAD_DRAFT_CONCURRENCY = 4;
export const BOOKING_LEAD_DRAFT_BUDGET_MS = 4_000;
const ID_CHUNK = 25;

export type BookingLeadLane = "fencing" | "patio";

export interface BookingLeadCase {
  opportunity_id: string;
  contact_id: string | null;
  display_name?: string | null;
  suburb?: string | null;
}

export interface BookingLeadDraftSummary {
  flag: "on";
  lane: BookingLeadLane;
  leads: number;
  skipped_no_contact: number;
  skipped_has_job: number;
  attempted: number;
  created: number;
  existing: number;
  ambiguous: number;
  failed: number;
  /** Leads left for the next read because a bound was hit. */
  deferred: number;
  /** Set when the linked-jobs read failed and nothing was attempted. */
  read_error: string | null;
  created_job_ids: string[];
}

export interface BookingLeadDraftDeps {
  readFlag(): Promise<boolean>;
  /** Jobs linked to these ids, any status. Rejects on a failed read. */
  readLinkedJobs(
    ids: { opportunityIds: string[]; contactIds: string[] },
  ): Promise<
    Array<{
      ghl_opportunity_id: string | null;
      ghl_contact_id: string | null;
      status: string | null;
    }>
  >;
  ensureDraft(args: {
    contactId: string;
    type: BookingLeadLane;
    client: Record<string, string>;
  }): Promise<{ outcome?: string; job_id?: string | null }>;
  now(): number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Pure: which leads need a draft. One entry per contact (a contact with two
 * opportunities is one customer and gets one draft).
 */
export function planBookingLeadDrafts(
  cases: BookingLeadCase[],
  linked: Array<{
    ghl_opportunity_id: string | null;
    ghl_contact_id: string | null;
    status: string | null;
  }>,
): {
  plan: Array<{ contactId: string; client: Record<string, string> }>;
  skippedNoContact: number;
  skippedHasJob: number;
} {
  const linkedOpportunities = new Set<string>();
  const openContacts = new Set<string>();
  for (const row of linked) {
    const opp = text(row.ghl_opportunity_id);
    if (opp) linkedOpportunities.add(opp);
    const contact = text(row.ghl_contact_id);
    const status = String(row.status ?? "");
    if (contact && !BOOKING_LEAD_TERMINAL_STATUSES.includes(status)) {
      openContacts.add(contact);
    }
  }
  const plan: Array<{ contactId: string; client: Record<string, string> }> = [];
  const planned = new Set<string>();
  let skippedNoContact = 0;
  let skippedHasJob = 0;
  for (const lead of cases) {
    const contactId = text(lead.contact_id);
    const opportunityId = text(lead.opportunity_id);
    if (!contactId) {
      skippedNoContact++;
      continue;
    }
    if (
      (opportunityId && linkedOpportunities.has(opportunityId)) ||
      openContacts.has(contactId)
    ) {
      skippedHasJob++;
      continue;
    }
    if (planned.has(contactId)) continue;
    planned.add(contactId);
    const client: Record<string, string> = {};
    const name = text(lead.display_name);
    // The booking read shows "Enquiry" for an unnamed or phone-only contact.
    if (name && name !== "Enquiry") client.client_name = name;
    const suburb = text(lead.suburb);
    if (suburb && suburb !== "not given") client.site_suburb = suburb;
    plan.push({ contactId, client });
  }
  return { plan, skippedNoContact, skippedHasJob };
}

/**
 * Mint drafts for one booking read's leads. Returns null when the flag is
 * off (the caller then leaves its response unchanged). Never throws.
 */
export async function ensureBookingLeadDrafts(
  deps: BookingLeadDraftDeps,
  lane: BookingLeadLane,
  cases: BookingLeadCase[],
): Promise<BookingLeadDraftSummary | null> {
  let on = false;
  try {
    on = await deps.readFlag();
  } catch {
    on = false;
  }
  if (!on) return null;

  const summary: BookingLeadDraftSummary = {
    flag: "on",
    lane,
    leads: cases.length,
    skipped_no_contact: 0,
    skipped_has_job: 0,
    attempted: 0,
    created: 0,
    existing: 0,
    ambiguous: 0,
    failed: 0,
    deferred: 0,
    read_error: null,
    created_job_ids: [],
  };
  if (cases.length === 0) return summary;

  let linked;
  try {
    linked = await deps.readLinkedJobs({
      opportunityIds: cases.map((c) => c.opportunity_id).filter(Boolean),
      contactIds: cases.map((c) => c.contact_id ?? "").filter(Boolean),
    });
  } catch (error) {
    summary.read_error = (error as Error)?.message || "linked_jobs_read_failed";
    return summary;
  }

  const { plan, skippedNoContact, skippedHasJob } = planBookingLeadDrafts(
    cases,
    linked,
  );
  summary.skipped_no_contact = skippedNoContact;
  summary.skipped_has_job = skippedHasJob;

  const bounded = plan.slice(0, BOOKING_LEAD_DRAFT_MAX_PER_READ);
  summary.deferred = plan.length - bounded.length;
  const deadline = deps.now() + BOOKING_LEAD_DRAFT_BUDGET_MS;
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(BOOKING_LEAD_DRAFT_CONCURRENCY, bounded.length) },
    async () => {
      while (next < bounded.length) {
        const item = bounded[next++];
        if (deps.now() >= deadline) {
          summary.deferred++;
          continue;
        }
        summary.attempted++;
        try {
          const result = await deps.ensureDraft({
            contactId: item.contactId,
            type: lane,
            client: item.client,
          });
          if (result?.outcome === "created") {
            summary.created++;
            if (result.job_id) summary.created_job_ids.push(result.job_id);
          } else if (result?.outcome === "existing") summary.existing++;
          else if (result?.outcome === "ambiguous") summary.ambiguous++;
          else summary.failed++;
        } catch {
          summary.failed++;
        }
      }
    },
  ));
  return summary;
}

function chunk(ids: string[]): string[][] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    out.push(unique.slice(i, i + ID_CHUNK));
  }
  return out;
}

// deno-lint-ignore no-explicit-any
type Client = any;

/** Production wiring over the service-role client. */
export function createBookingLeadDraftDeps(
  client: Client,
): BookingLeadDraftDeps {
  return {
    async readFlag() {
      const { data, error } = await client.from("feature_flags")
        .select("enabled, updated_at")
        .eq("flag_name", BOOKING_LEAD_DRAFT_FLAG)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (error || !Array.isArray(data)) return false;
      return data[0]?.enabled === true;
    },
    async readLinkedJobs({ opportunityIds, contactIds }) {
      const rows: Array<{
        ghl_opportunity_id: string | null;
        ghl_contact_id: string | null;
        status: string | null;
      }> = [];
      for (
        const [column, ids] of [
          ["ghl_opportunity_id", opportunityIds],
          ["ghl_contact_id", contactIds],
        ] as const
      ) {
        for (const part of chunk(ids)) {
          const { data, error } = await client.from("jobs")
            .select("ghl_opportunity_id, ghl_contact_id, status")
            .in(column, part);
          // A failed read must never read as "no job": the caller mints nothing.
          if (error) {
            throw new Error(`linked_jobs_read_failed: ${error.message}`);
          }
          rows.push(...(data || []));
        }
      }
      return rows;
    },
    async ensureDraft({ contactId, type, client: display }) {
      const { data, error } = await client.rpc("ensure_booking_draft_job", {
        p_ghl_contact_id: contactId,
        p_type: type,
        p_client: display,
      });
      if (error) throw new Error(error.message);
      return (data || {}) as { outcome?: string; job_id?: string | null };
    },
    now: () => Date.now(),
  };
}
