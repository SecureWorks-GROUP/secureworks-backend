// deno-lint-ignore-file no-explicit-any
// Test-only: an in-memory stand-in for the send rule's database
// (dispatch_v2_outlook_on_send.ts OnSendStore) and the catch-up's one extra
// write (dispatch_v2_outlook_catch_up.ts CatchUpStore). It behaves like the
// database function dispatch_v2_record_outlook_order_on_send: once per sent
// email and supplier, never over a Dispatch send, the box reused or made.
// Never imported by ops-api itself.

import type {
  CapturedSentEmail,
  OnSendBox,
  OnSendEntry,
  OnSendJob,
  OnSendOrderRow,
  RecordOnSendInput,
  RecordOnSendResult,
  StoredReply,
} from "./dispatch_v2_outlook_on_send.ts";
import type {
  CatchUpStore,
  SetDeliveredInput,
} from "./dispatch_v2_outlook_catch_up.ts";
import type { SupplierUsage } from "./dispatch_v2_outlook_order.ts";

export const ADMIN = "admin@secureworkswa.com.au";

/** A sent email as the capture keeps it. */
export function sentEmail(
  n: number,
  over: Partial<CapturedSentEmail> = {},
): CapturedSentEmail {
  return {
    business_event_id: `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`,
    sequence_number: 5000 + n,
    provider_message_id: `email:sent${n}@outlook.com`,
    internet_message_id: `sent${n}@outlook.com`,
    conversation_id: `CONV-SENT-${n}`,
    sent_at: "2026-11-03T02:00:00Z",
    mailbox: ADMIN,
    from_email: ADMIN,
    sent_by_email: ADMIN,
    folder_kind: "sent",
    to: [],
    cc: ["fencing@secureworkswa.com.au"],
    subject: "Material Order Ref SWF-261586",
    body: "",
    body_truncated: false,
    ...over,
  };
}

export class MemoryOnSendStore implements CatchUpStore {
  sent: CapturedSentEmail[] = [];
  entries: OnSendEntry[] = [];
  jobs: OnSendJob[] = [];
  orders: OnSendOrderRow[] = [];
  boxes: OnSendBox[] = [];
  replies: StoredReply[] = [];
  usage: SupplierUsage[] = [];
  since: string | null = null;
  calls: RecordOnSendInput[] = [];
  delivered: SetDeliveredInput[] = [];
  jobEvents: any[] = [];
  // Reads and writes that fail, by method name.
  failing = new Set<string>();
  // Called after each order is recorded (a test can mirror it elsewhere).
  onRecord?: (row: OnSendOrderRow, input: RecordOnSendInput) => void;
  n = 0;

  private fail(name: string) {
    if (this.failing.has(name)) throw new Error(`${name} down`);
  }
  private id(prefix: string) {
    this.n++;
    return `${prefix}-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }

  sentOrderEmails(opts: { since: string; before: string; limit: number }) {
    this.fail("sentOrderEmails");
    return Promise.resolve(
      this.sent
        .filter((e) =>
          String(e.sent_at) >= opts.since && String(e.sent_at) < opts.before &&
          /material order/i.test(e.subject)
        )
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, opts.limit),
    );
  }
  approvedEntries() {
    this.fail("approvedEntries");
    return Promise.resolve(this.entries.map((e) => ({ ...e })));
  }
  jobsByNumbers(_org: string, numbers: string[]) {
    const forms = numbers.flatMap((n) => [n, n.replace("-", "")]);
    return Promise.resolve(
      this.jobs.filter((j) => forms.includes(String(j.job_number))),
    );
  }
  dispatchSendsMatching(_org: string, ids: string[], convs: string[]) {
    const key = (v: string | null) =>
      String(v ?? "").replace(/^<|>$/g, "").toLowerCase();
    return Promise.resolve(
      this.orders.filter((o) =>
        o.origin === "dispatch" &&
        (ids.some((i) => key(i) === key(o.sent_internet_message_id)) ||
          (!!o.sent_conversation_id && convs.includes(o.sent_conversation_id)))
      ),
    );
  }
  ordersFromEvents(_org: string, ids: string[]) {
    return Promise.resolve(
      this.orders.filter((o) =>
        !!o.source_business_event_id && ids.includes(o.source_business_event_id)
      ),
    );
  }
  storedEventIds(_ids: string[]) {
    // Overridden by tests that keep a tray; empty by default.
    return Promise.resolve(new Set<string>());
  }
  sentOrdersOnJobs(_org: string, jobIds: string[]) {
    return Promise.resolve(
      this.orders.filter((o) =>
        jobIds.includes(o.job_id) && ["sent", "send_unknown"].includes(o.status)
      ).map((o) => ({ ...o })),
    );
  }
  boxesOnJobs(_org: string, jobIds: string[]) {
    return Promise.resolve(
      this.boxes.filter((b) => jobIds.includes(b.job_id)).map((b) => ({ ...b })),
    );
  }
  supplierUsage() {
    return Promise.resolve(this.usage);
  }
  repliesOnJobs(_org: string, jobIds: string[]) {
    return Promise.resolve(
      this.replies.filter((r) => !!r.job_id && jobIds.includes(r.job_id))
        .map((r) => ({ ...r })),
    );
  }
  recordOrder(input: RecordOnSendInput): Promise<RecordOnSendResult> {
    this.fail("recordOrder");
    this.calls.push(input);
    const related = new Set([input.supplier_id, ...input.related_supplier_ids]);
    const before = this.orders.find((o) =>
      o.source_business_event_id === input.source_business_event_id &&
      !!o.supplier_id && related.has(o.supplier_id)
    );
    if (before) {
      const box = this.boxes.find((b) =>
        b.job_id === before.job_id && b.supplier_id === before.supplier_id
      );
      return Promise.resolve({
        recorded: false,
        order_id: before.order_id,
        box_id: box?.box_id ?? null,
        box_created: false,
        reason: "already_recorded",
      });
    }
    const key = (v: string | null) =>
      String(v ?? "").replace(/^<|>$/g, "").toLowerCase();
    if (
      this.orders.some((o) =>
        o.origin === "dispatch" &&
        ((!!input.sent_internet_message_id &&
          key(o.sent_internet_message_id) ===
            key(input.sent_internet_message_id)) ||
          (!!input.sent_conversation_id &&
            o.sent_conversation_id === input.sent_conversation_id))
      )
    ) {
      return Promise.resolve({
        recorded: false,
        order_id: null,
        box_id: null,
        box_created: false,
        reason: "dispatch_own_send",
      });
    }
    if (!this.jobs.some((j) => j.job_id === input.job_id)) {
      return Promise.resolve({
        recorded: false,
        order_id: null,
        box_id: null,
        box_created: false,
        reason: "job_not_found",
      });
    }
    let box = this.boxes.find((b) =>
      b.job_id === input.job_id && b.supplier_id === input.supplier_id
    );
    const created = !box;
    if (!box) {
      box = {
        box_id: this.id("cccccccc"),
        job_id: input.job_id,
        supplier_id: input.supplier_id,
        material_stage: null,
        material_stage_set_at: null,
      };
      this.boxes.push(box);
    }
    const row: OnSendOrderRow = {
      order_id: this.id("aaaaaaaa"),
      job_id: input.job_id,
      supplier_id: input.supplier_id,
      origin: "outlook",
      status: "sent",
      sent_at: input.sent_at,
      sent_internet_message_id: input.sent_internet_message_id,
      sent_conversation_id: input.sent_conversation_id,
      source_business_event_id: input.source_business_event_id,
    };
    this.orders.push(row);
    this.jobEvents.push({
      job_id: input.job_id,
      event_type: "dispatch_v2_outlook_order_recorded",
      detail: { order_id: row.order_id, box_id: box.box_id, trigger: input.trigger },
    });
    this.onRecord?.(row, input);
    return Promise.resolve({
      recorded: true,
      order_id: row.order_id,
      box_id: box.box_id,
      box_created: created,
      reason: null,
    });
  }
  tieReply(
    _org: string,
    replyId: string,
    orderId: string,
    matchReason: string,
  ) {
    const r = this.replies.find((x) =>
      x.id === replyId && x.state === "matched" && !x.order_id
    );
    if (!r) return Promise.resolve(false);
    r.order_id = orderId;
    r.match_reason = matchReason;
    return Promise.resolve(true);
  }
  sentOrdersSince() {
    this.fail("sentOrdersSince");
    return Promise.resolve(this.since);
  }
  setSentOrdersSince(at: string) {
    this.since = at;
    return Promise.resolve();
  }
  setBoxDelivered(input: SetDeliveredInput) {
    const box = this.boxes.find((b) => b.box_id === input.box.box_id);
    if (!box || box.material_stage_set_at !== input.box.material_stage_set_at) {
      return Promise.resolve(false);
    }
    box.material_stage = "delivered";
    box.material_stage_set_at = input.now;
    this.delivered.push(input);
    this.jobEvents.push({
      job_id: box.job_id,
      event_type: "dispatch_v2_material_stage_set",
      detail: { box_id: box.box_id, to: "delivered", via: "outlook_catch_up" },
    });
    return Promise.resolve(true);
  }
}
