// deno-lint-ignore-file no-import-prefix
// Debt follow-up exact-approval executor. No network: every read, ledger write
// and provider call is a counted fake. The headline proof: while the execute
// switch is unset, no path makes a provider send call.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ApprovalRecord,
  type AttemptRow,
  DEBT_FOLLOWUP_EXECUTE_ENV,
  debtFollowupActionEntry,
  debtFollowupApproveAction,
  type DebtFollowupCaller,
  debtFollowupCallerRefusal,
  type DebtFollowupDeps,
  debtFollowupExecuteAction,
  debtFollowupExecuteSwitchOn,
  debtFollowupLegacySend,
  debtFollowupProposeAction,
  type DebtFollowupResult,
  formatAud,
  legacySendResponse,
  type LiveExecution,
  type MirrorInvoiceRow,
} from "./debt_followup_approval.ts";
import {
  CONTACT_MATCH_SCAN_LIMIT,
  debtFollowupLedger,
  debtFollowupReads,
} from "./debt_followup_approval_live.ts";
import { SMS_DEFAULT_FROM_NUMBER } from "../_shared/sms_from_number.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-24T01:00:00Z");
const CAPTAIN = "marnin@secureworkswa.com.au";
const CAPTAIN_USER_ID = "706c5258-70dd-483a-b36c-af6864b24498";
const captain = { mode: "jwt", email: CAPTAIN, user_id: CAPTAIN_USER_ID };
const staff = { mode: "jwt", email: "ops@secureworkswa.com.au" };
const apiKey = { mode: "api_key", email: null };
const SWITCH_ON = { [DEBT_FOLLOWUP_EXECUTE_ENV]: "true" };

function xeroInvoice(id: string, over: Obj = {}): Obj {
  return {
    InvoiceID: id,
    InvoiceNumber: id === "inv-1" ? "INV-0857" : "INV-0858",
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 275,
    AmountPaid: 0,
    Total: 275,
    CurrencyCode: "AUD",
    UpdatedDateUTC: "/Date(1758600000000+0000)/",
    Contact: {
      ContactID: "xc-1",
      EmailAddress: "accounts@builder.example",
      ContactPersons: [{ EmailAddress: "pm@builder.example" }],
    },
    ...over,
  };
}

function mirrorRow(
  id: string,
  over: Partial<MirrorInvoiceRow> = {},
): MirrorInvoiceRow {
  return {
    xero_invoice_id: id,
    org_id: ORG,
    invoice_type: "ACCREC",
    invoice_number: id === "inv-1" ? "INV-0857" : "INV-0858",
    job_id: "job-1",
    xero_contact_id: "xc-1",
    debt_classification: "genuine_debt",
    debt_blocker: null,
    ...over,
  };
}

interface World {
  mirror: Record<string, MirrorInvoiceRow>;
  xero: Record<string, Obj>;
  jobs: Record<string, string | null>;
  jobStatuses: Record<string, string | null>;
  matches: Record<string, string | null>;
  ghl: Record<
    string,
    { id: string; phone: string | null; first_name: string | null }
  >;
  anchors: { job_emails: string[]; company_emails: string[] };
  onlineUrl: string | null;
  recentLink: boolean;
  fence: Obj | null;
  fail: Set<string>;
  env: Record<string, string>;
  now: Date;
  approvals: Map<string, ApprovalRecord>;
  live: Map<string, LiveExecution & { press_token: string }>;
  attempts: AttemptRow[];
  sms: Obj[];
  emails: Obj[];
  afterSent: Obj[];
  smsResponse: () => Promise<{ status: number; body: Obj }>;
  emailResponse: (args?: Obj) => Promise<{ status: number; body: Obj }>;
  claimFails?: boolean;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    mirror: { "inv-1": mirrorRow("inv-1"), "inv-2": mirrorRow("inv-2") },
    xero: { "inv-1": xeroInvoice("inv-1"), "inv-2": xeroInvoice("inv-2") },
    jobs: { "job-1": "ghl-1" },
    jobStatuses: { "job-1": "complete" },
    matches: { "xc-1": "ghl-1" },
    ghl: { "ghl-1": { id: "ghl-1", phone: "0412 345 678", first_name: "Sam" } },
    anchors: { job_emails: ["accounts@builder.example"], company_emails: [] },
    onlineUrl: "https://in.xero.com/abc123",
    recentLink: false,
    fence: null,
    fail: new Set(),
    env: {},
    now: NOW,
    approvals: new Map(),
    live: new Map(),
    attempts: [],
    sms: [],
    emails: [],
    afterSent: [],
    smsResponse: () =>
      Promise.resolve({
        status: 200,
        body: { success: true, messageId: "ghl-msg-1", evidence: "inserted" },
      }),
    emailResponse: (args) =>
      Promise.resolve({
        status: 200,
        body: {
          success: true,
          emailed: true,
          via: "outlook",
          attachment_sha256: "a".repeat(64),
          provider_proof: {
            label: "accepted by Outlook",
            status: 202,
            request_id: "outlook-request-1",
            client_request_id: "client-request-1",
            sent_at: "2026-09-24T01:02:03.000Z",
            approval_id: args?.approval_id,
            attachment_sha256: "a".repeat(64),
          },
        },
      }),
    ...over,
  };
  w.env = { ...w.env }; // never share an env object between worlds
  return w;
}

function guard(w: World, name: string) {
  if (w.fail.has(name)) throw new Error(`${name} failed`);
}

function deps(w: World): DebtFollowupDeps {
  return {
    orgId: ORG,
    envGet: (n) => w.env[n],
    now: () => w.now,
    newToken: () => crypto.randomUUID(),
    reads: {
      invoiceMirror(ids) {
        guard(w, "mirror");
        return Promise.resolve(ids.map((id) => w.mirror[id]).filter(Boolean));
      },
      xeroInvoice(id) {
        guard(w, "xero");
        if (!w.xero[id]) return Promise.reject(new Error("missing"));
        return Promise.resolve(structuredClone(w.xero[id]));
      },
      jobFacts(ids) {
        guard(w, "jobs");
        return Promise.resolve(
          Object.fromEntries(ids.map((id) => [id, {
            status: w.jobStatuses[id] ?? null,
            ghl_contact_id: w.jobs[id] ?? null,
          }])),
        );
      },
      contactMatch(xc) {
        guard(w, "matches");
        return Promise.resolve(w.matches[xc] ?? null);
      },
      ghlContact(id) {
        guard(w, "ghl");
        if (!w.ghl[id]) return Promise.reject(new Error("missing"));
        return Promise.resolve({ ...w.ghl[id] });
      },
      emailAnchors() {
        guard(w, "anchors");
        return Promise.resolve(structuredClone(w.anchors));
      },
      onlineInvoiceUrl() {
        guard(w, "online");
        return Promise.resolve(w.onlineUrl);
      },
      paymentLinkSentSince() {
        guard(w, "history");
        return Promise.resolve(w.recentLink);
      },
      sealedFence() {
        guard(w, "fence");
        return Promise.resolve(w.fence);
      },
    },
    ledger: {
      getApproval(id) {
        guard(w, "approval_read");
        const r = w.approvals.get(id);
        return Promise.resolve(r ? structuredClone(r) : null);
      },
      findOpenApproval(hash, nowIso) {
        const open = [...w.approvals.values()].find((a) =>
          a.binding_hash === hash && a.expires_at > nowIso &&
          !w.live.has(a.approval_id)
        );
        return Promise.resolve(open ?? null);
      },
      insertApproval(record) {
        guard(w, "approval_write");
        w.approvals.set(record.approval_id, structuredClone(record));
        return Promise.resolve();
      },
      liveExecution(id) {
        const row = w.live.get(id);
        if (!row) return Promise.resolve(null);
        const { press_token: _t, ...rest } = row;
        return Promise.resolve(rest);
      },
      claimLive(row) {
        if (w.claimFails) return Promise.resolve(false);
        if (w.live.has(row.approval_id)) return Promise.resolve(false);
        w.live.set(row.approval_id, {
          approval_id: row.approval_id,
          outcome: "sending",
          provider: null,
          provider_message_id: null,
          provider_proof: null,
          press_token: row.press_token,
        });
        return Promise.resolve(true);
      },
      settleLive(id, token, outcome) {
        const row = w.live.get(id);
        if (row && row.outcome === "sending" && row.press_token === token) {
          w.live.set(id, { ...row, ...outcome });
        }
        return Promise.resolve();
      },
      recordAttempt(row) {
        guard(w, "attempt_write");
        w.attempts.push(structuredClone(row));
        return Promise.resolve();
      },
    },
    transports: {
      sendSms(body) {
        w.sms.push(body);
        return w.smsResponse();
      },
      sendInvoiceEmail(args) {
        w.emails.push(args);
        return w.emailResponse(args);
      },
      afterSent(proposal, proof, meta) {
        w.afterSent.push({ kind: proposal.kind, proof, meta });
        return Promise.resolve();
      },
    },
  };
}

Deno.test("contact matching is scoped to the executor organization", async () => {
  const rows = [
    { org_id: "org-a", xero_contact_id: "same-xero", ghl_contact_id: "ghl-a" },
    { org_id: "org-b", xero_contact_id: "same-xero", ghl_contact_id: "ghl-b" },
  ];
  const filters: Array<[string, unknown]> = [];
  const client = {
    from(table: string) {
      assertEquals(table, "contact_matches");
      const query: Obj = {
        select() {
          return query;
        },
        eq(field: string, value: unknown) {
          filters.push([field, value]);
          return query;
        },
        limit(count: number) {
          const data = rows.filter((row) =>
            filters.every(([field, value]) => (row as Obj)[field] === value)
          ).slice(0, count);
          return Promise.resolve({ data, error: null });
        },
      };
      return query;
    },
  };
  const reads = debtFollowupReads(client, {
    orgId: "org-a",
    getToken: () => Promise.resolve({ accessToken: "", tenantId: "" }),
    xeroGet: () => Promise.resolve({}),
    assertInvoiceAllowed: () => Promise.resolve(undefined),
    fenceRefusal: () => null,
    sendInvoiceEmail: () => Promise.resolve({ status: 200, body: {} }),
    sendSms: () => Promise.resolve({ status: 200, body: {} }),
  });

  assertEquals(await reads.contactMatch("same-xero"), "ghl-a");
  assertEquals(filters, [
    ["org_id", "org-a"],
    ["xero_contact_id", "same-xero"],
  ]);
});

Deno.test("job facts read current status and the GHL contact together", async () => {
  const selected: string[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      const query: Obj = {
        select(columns: string) {
          selected.push(columns);
          return query;
        },
        in(column: string, ids: string[]) {
          assertEquals(column, "id");
          assertEquals(ids, ["job-1"]);
          return Promise.resolve({
            data: [{
              id: "job-1",
              status: "scheduled",
              ghl_contact_id: "ghl-1",
            }],
            error: null,
          });
        },
      };
      return query;
    },
  };
  const reads = debtFollowupReads(client, {
    orgId: "org-a",
    getToken: () => Promise.resolve({ accessToken: "", tenantId: "" }),
    xeroGet: () => Promise.resolve({}),
    assertInvoiceAllowed: () => Promise.resolve(undefined),
    fenceRefusal: () => null,
    sendInvoiceEmail: () => Promise.resolve({ status: 200, body: {} }),
    sendSms: () => Promise.resolve({ status: 200, body: {} }),
  });

  assertEquals(await reads.jobFacts(["job-1"]), {
    "job-1": { status: "scheduled", ghl_contact_id: "ghl-1" },
  });
  assertEquals(selected, ["id,status,ghl_contact_id"]);
});

const providerCalls = (w: World) => w.sms.length + w.emails.length;

const CHASE = {
  kind: "chase_sms",
  xero_invoice_ids: ["inv-1"],
  ghl_contact_id: "ghl-1",
  message:
    "Hi Sam, INV-0857 for $275.00 is overdue. Can you let us know when it will be paid?",
};
const LINK = { kind: "payment_link_sms", xero_invoice_ids: ["inv-1"] };
const THANKS = { kind: "thank_you_sms", xero_invoice_ids: ["inv-1"] };
const EMAIL = {
  kind: "invoice_email",
  xero_invoice_ids: ["inv-1"],
  to_email: "accounts@builder.example",
};

function paid(w: World) {
  w.xero["inv-1"] = xeroInvoice("inv-1", {
    Status: "PAID",
    AmountDue: 0,
    AmountPaid: 1234.5,
  });
}

async function approve(w: World, request: Obj): Promise<string> {
  const proposed = await debtFollowupProposeAction({
    method: "POST",
    body: { request },
    deps: deps(w),
  });
  assertEquals(proposed.status, "proposed", JSON.stringify(proposed));
  if (proposed.status !== "proposed") throw new Error("unreachable");
  const approved = await debtFollowupApproveAction({
    method: "POST",
    auth: captain,
    body: { request, expected_binding_hash: proposed.binding_hash },
    deps: deps(w),
  });
  assertEquals(approved.status, "approved", JSON.stringify(approved));
  if (approved.status !== "approved") throw new Error("unreachable");
  return approved.approval_id;
}

const press = (
  w: World,
  approvalId: string,
  auth: Obj = captain,
  extra: Obj = {},
) =>
  debtFollowupExecuteAction({
    method: "POST",
    auth: auth as { mode: string; email: string | null },
    body: { approval_id: approvalId, ...extra },
    deps: deps(w),
  });

// ── Switch unset: zero provider calls on every path ───────────────────────

Deno.test("switch unset: every old send path records a dry run and makes 0 provider calls", async () => {
  const cases: [string, Obj, (w: World) => void][] = [
    ["send_chase_sms", CHASE, () => {}],
    ["send_payment_link", LINK, () => {}],
    ["handle_payment_event", THANKS, paid],
    ["send_invoice_email", EMAIL, () => {}],
    // The retired Xero-direct branch: no to_email.
    ["send_invoice_email", {
      kind: "invoice_email",
      xero_invoice_ids: ["inv-1"],
    }, () => {}],
  ];
  for (const [source, request, prep] of cases) {
    const w = world();
    prep(w);
    const { kind, ...rest } = request;
    const result = await debtFollowupLegacySend({
      sourceAction: source,
      kind,
      method: "POST",
      auth: staff,
      request: rest,
      body: {},
      deps: deps(w),
    });
    assertEquals(
      result.status,
      "dry_run",
      `${source}: ${JSON.stringify(result)}`,
    );
    if (result.status !== "dry_run") continue;
    assertEquals(result.reason, "approval_required");
    assertEquals(result.execute_switch, "off");
    assertEquals(result.recorded, true);
    assertEquals(providerCalls(w), 0, source);
    assertEquals(w.attempts.length, 1);
    assertEquals(w.attempts[0].outcome, "dry_run");
    assertEquals(w.attempts[0].source_action, source);
    assertEquals(w.attempts[0].binding_hash, result.binding_hash);
    const response = legacySendResponse(result);
    assertEquals(response.status, 409);
    assertEquals(response.body.success, false);
    assertEquals(response.body.sent, false);
  }
});

Deno.test("switch unset: a captain-approved press of each kind is a dry run with 0 provider calls", async () => {
  for (
    const [request, prep] of [[CHASE, () => {}], [LINK, () => {}], [
      THANKS,
      paid,
    ], [EMAIL, () => {}]] as [Obj, (w: World) => void][]
  ) {
    const w = world();
    prep(w);
    const approvalId = await approve(w, request);
    const result = await press(w, approvalId);
    assertEquals(result.status, "dry_run", JSON.stringify(result));
    if (result.status === "dry_run") {
      assertEquals(result.reason, "execute_switch_off");
      assertEquals(result.execute_switch, "off");
      assertEquals(result.recorded, true);
    }
    assertEquals(providerCalls(w), 0);
    assertEquals(w.live.size, 0);
    assertEquals(w.afterSent.length, 0);
  }
});

Deno.test("switch reads on only for the exact value true; a failed read is off", async () => {
  for (const value of ["TRUE", "True", "1", "yes", " true", "true ", ""]) {
    const w = world({ env: { [DEBT_FOLLOWUP_EXECUTE_ENV]: value } });
    const id = await approve(w, CHASE);
    const result = await press(w, id);
    assertEquals(result.status, "dry_run", value);
    assertEquals(providerCalls(w), 0, value);
  }
  assertEquals(
    debtFollowupExecuteSwitchOn(() => {
      throw new Error("env unavailable");
    }),
    false,
  );
  assertEquals(debtFollowupExecuteSwitchOn(() => undefined), false);
  // The real process environment of this test run has no switch.
  assertEquals(debtFollowupExecuteSwitchOn((n) => Deno.env.get(n)), false);
});

Deno.test("even with the switch on: a non-captain press or dry_run:true sends nothing", async () => {
  const w = world({ env: SWITCH_ON });
  const id = await approve(w, CHASE);
  for (const auth of [apiKey, staff]) {
    const result = await press(w, id, auth);
    assertEquals(result.status, "dry_run");
    if (result.status === "dry_run") {
      assertEquals(result.reason, "press_is_not_captain");
    }
  }
  const dry = await press(w, id, captain, { dry_run: true });
  assertEquals(dry.status, "dry_run");
  if (dry.status === "dry_run") assertEquals(dry.reason, "dry_run_requested");
  const bad = await press(w, id, captain, { dry_run: "no" });
  assertEquals(bad, { status: "refused", reason: "invalid_dry_run" });
  assertEquals(providerCalls(w), 0);
});

Deno.test("with the switch on but no approval, an old send path still sends nothing", async () => {
  const w = world({ env: SWITCH_ON });
  const { kind: _k, ...rest } = CHASE;
  const result = await debtFollowupLegacySend({
    sourceAction: "send_chase_sms",
    kind: "chase_sms",
    method: "POST",
    auth: captain,
    request: rest,
    body: {},
    deps: deps(w),
  });
  assertEquals(result.status, "dry_run");
  if (result.status === "dry_run") {
    assertEquals(result.reason, "approval_required");
    assertEquals(result.execute_switch, "on");
  }
  assertEquals(providerCalls(w), 0);
});

// ── Live control: one approval, one provider call, provider proof ─────────

Deno.test("control: switch on + captain press sends the exact approved text once, with proof", async () => {
  const w = world({ env: SWITCH_ON });
  const id = await approve(w, CHASE);
  const first = await press(w, id);
  assertEquals(first.status, "sent", JSON.stringify(first));
  assertEquals(w.sms, [{
    contactId: "ghl-1",
    message: CHASE.message,
    jobId: "job-1",
  }]);
  if (first.status === "sent") {
    assertEquals(first.replayed, false);
    assertEquals(first.provider_message_id, "ghl-msg-1");
    assertEquals(first.provider_proof?.message_id, "ghl-msg-1");
    assertEquals(first.provider_proof?.evidence, "inserted");
  }
  assertEquals(w.live.get(id)?.outcome, "sent");
  assertEquals(w.afterSent.length, 1);

  const again = await press(w, id);
  assertEquals(again.status, "sent");
  if (again.status === "sent") assertEquals(again.replayed, true);
  // Replay after expiry still never sends.
  w.now = new Date(NOW.getTime() + 60 * 60_000);
  const late = await press(w, id);
  assertEquals(late.status, "sent");
  assertEquals(w.sms.length, 1);
  assertEquals(w.afterSent.length, 1);
  const response = legacySendResponse(first);
  assertEquals(response.status, 200);
  assertEquals(response.body.success, true);
  assertEquals(response.body.message_id, "ghl-msg-1");
});

Deno.test("a lost claim race or an unknown/failed outcome never sends a second time", async () => {
  const raced = world({ env: SWITCH_ON, claimFails: true });
  const rid = await approve(raced, CHASE);
  const r = await press(raced, rid);
  assertEquals(r, { status: "refused", reason: "approval_already_pressed" });
  assertEquals(providerCalls(raced), 0);

  const unknown = world({
    env: SWITCH_ON,
    smsResponse: () => Promise.reject(new Error("socket hang up")),
  });
  const uid = await approve(unknown, CHASE);
  const u = await press(unknown, uid);
  assertEquals(u.status, "unknown");
  assertEquals(unknown.live.get(uid)?.outcome, "unknown");
  const u2 = await press(unknown, uid);
  assertEquals(u2, {
    status: "refused",
    reason: "approval_already_pressed",
    detail: { outcome: "unknown" },
  });
  assertEquals(unknown.sms.length, 1);
  assertEquals(unknown.afterSent.length, 0);

  const refusedByProxy = world({
    env: SWITCH_ON,
    smsResponse: () =>
      Promise.resolve({
        status: 409,
        body: { success: false, dedup_blocked: true },
      }),
  });
  const fid = await approve(refusedByProxy, CHASE);
  const f = await press(refusedByProxy, fid);
  assertEquals(f.status, "failed");
  await press(refusedByProxy, fid);
  assertEquals(refusedByProxy.sms.length, 1);

  const soft = world({
    env: SWITCH_ON,
    smsResponse: () =>
      Promise.resolve({
        status: 200,
        body: { success: false, error: "GHL 500" },
      }),
  });
  const sid = await approve(soft, CHASE);
  assertEquals((await press(soft, sid)).status, "unknown");
});

// ── Any moved coordinate or failed read refuses at the press ──────────────

Deno.test("the press refuses on any changed coordinate and makes 0 provider calls", async () => {
  const mutations: [string, (w: World) => void, string][] = [
    ["balance", (w) => (w.xero["inv-1"].AmountDue = 200), "approval_stale"],
    ["status", (w) => (w.xero["inv-1"].Status = "PAID"), "invoice_not_payable"],
    [
      "xero edit",
      (w) => (w.xero["inv-1"].UpdatedDateUTC = "/Date(1758700000000+0000)/"),
      "approval_stale",
    ],
    ["phone", (w) => (w.ghl["ghl-1"].phone = "0499 999 999"), "approval_stale"],
    [
      "contact binding",
      (w) => (w.jobs["job-1"] = "ghl-2"),
      "destination_mismatch",
    ],
    [
      "xero contact",
      (w) => (w.xero["inv-1"].Contact.ContactID = "xc-9"),
      "contact_identity_drift",
    ],
    [
      "hold",
      (w) => (w.mirror["inv-1"].debt_classification = "in_dispute"),
      "invoice_on_hold",
    ],
    [
      "blocker",
      (w) => (w.mirror["inv-1"].debt_blocker = "payment_claimed"),
      "invoice_on_hold",
    ],
    [
      "fence",
      (w) => (w.fence = { code: "sealed_ses_release_required" }),
      "sealed_ses_invoice",
    ],
  ];
  for (const [label, mutate, reason] of mutations) {
    const w = world({ env: SWITCH_ON });
    const id = await approve(w, CHASE);
    mutate(w);
    const result = await press(w, id);
    assertEquals(result.status, "refused", label);
    if (result.status === "refused") assertEquals(result.reason, reason, label);
    assertEquals(providerCalls(w), 0, label);
    assertEquals(w.live.size, 0, label);
  }
  const w = world({ env: SWITCH_ON });
  const id = await approve(w, CHASE);
  w.xero["inv-1"].AmountDue = 100;
  const stale = await press(w, id);
  assertEquals(stale.status, "refused");
  if (stale.status === "refused") {
    assertEquals(stale.detail?.changed, ["invoices.inv-1.amount_due"]);
    assertEquals(stale.recorded, true);
  }
});

Deno.test("the press refuses on every failed read and makes 0 provider calls", async () => {
  const reads: [string, string][] = [
    ["mirror", "invoice_mirror_unreadable"],
    ["xero", "xero_invoice_unreadable"],
    ["jobs", "job_status_unreadable"],
    ["ghl", "contact_unreadable"],
    ["fence", "sealed_fence_unreadable"],
    ["approval_read", "approval_unreadable"],
  ];
  for (const [name, reason] of reads) {
    const w = world({ env: SWITCH_ON });
    const id = await approve(w, CHASE);
    w.fail.add(name);
    const result = await press(w, id);
    assertEquals(result.status, "refused", name);
    if (result.status === "refused") assertEquals(result.reason, reason, name);
    assertEquals(providerCalls(w), 0, name);
  }
  // Link and email reads.
  for (
    const [request, name, reason] of [
      [LINK, "online", "online_invoice_unreadable"],
      [LINK, "history", "payment_link_history_unreadable"],
      [EMAIL, "anchors", "recipient_anchors_unreadable"],
    ] as [Obj, string, string][]
  ) {
    const w = world({ env: SWITCH_ON });
    const id = await approve(w, request);
    w.fail.add(name);
    const result = await press(w, id);
    assertEquals(result.status, "refused", name);
    if (result.status === "refused") assertEquals(result.reason, reason, name);
    assertEquals(providerCalls(w), 0, name);
  }
});

Deno.test("expiry, hash tampering and a non-captain approver refuse with 0 provider calls", async () => {
  const expired = world({ env: SWITCH_ON });
  const eid = await approve(expired, CHASE);
  expired.now = new Date(NOW.getTime() + 30 * 60_000);
  assertEquals(await press(expired, eid), {
    status: "refused",
    reason: "approval_expired",
  });

  const tampered = world({ env: SWITCH_ON });
  const tid = await approve(tampered, CHASE);
  tampered.approvals.get(tid)!.proposal.body = "Pay now or else";
  assertEquals(await press(tampered, tid), {
    status: "refused",
    reason: "approval_integrity_failed",
  });

  const rehashed = world({ env: SWITCH_ON });
  const hid = await approve(rehashed, CHASE);
  rehashed.approvals.get(hid)!.body_sha256 = "0".repeat(64);
  assertEquals((await press(rehashed, hid)).status, "refused");

  const demoted = world({ env: SWITCH_ON });
  const did = await approve(demoted, CHASE);
  demoted.env.DEBT_FOLLOWUP_CAPTAIN_EMAILS =
    "someone-else@secureworkswa.com.au";
  assertEquals(await press(demoted, did), {
    status: "refused",
    reason: "approval_not_by_captain",
  });

  const missing = world({ env: SWITCH_ON });
  assertEquals(await press(missing, "f".repeat(64)), {
    status: "refused",
    reason: "approval_not_found",
  });
  assertEquals(await press(missing, "not-a-hash"), {
    status: "refused",
    reason: "approval_id_required",
  });
  for (const w of [expired, tampered, rehashed, demoted, missing]) {
    assertEquals(providerCalls(w), 0);
  }
});

// ── Approval ───────────────────────────────────────────────────────────────

Deno.test("only an allow-listed captain session can approve, and only the exact current proposal", async () => {
  const w = world();
  const proposed = await debtFollowupProposeAction({
    method: "POST",
    body: { request: CHASE },
    deps: deps(w),
  });
  assert(proposed.status === "proposed");
  const hash = proposed.binding_hash;
  for (const auth of [apiKey, staff, { mode: "routine", email: CAPTAIN }]) {
    const r = await debtFollowupApproveAction({
      method: "POST",
      auth,
      body: { request: CHASE, expected_binding_hash: hash },
      deps: deps(w),
    });
    assertEquals(r, { status: "refused", reason: "approval_requires_captain" });
  }
  assertEquals(w.approvals.size, 0);

  w.xero["inv-1"].AmountDue = 10;
  const moved = await debtFollowupApproveAction({
    method: "POST",
    auth: captain,
    body: { request: CHASE, expected_binding_hash: hash },
    deps: deps(w),
  });
  assertEquals(moved.status, "refused");
  if (moved.status === "refused") {
    assertEquals(moved.reason, "proposal_changed");
  }
  assertEquals(w.approvals.size, 0);
  assertEquals(providerCalls(w), 0);
});

Deno.test("approval binds body hash, destination, invoice ids, snapshot and expiry; re-approve is idempotent", async () => {
  const w = world();
  const id = await approve(w, CHASE);
  const record = w.approvals.get(id)!;
  assertEquals(record.approved_by_email, CAPTAIN);
  assertEquals(record.expires_at, "2026-09-24T01:30:00.000Z");
  assertEquals(record.proposal.invoices.map((i) => i.xero_invoice_id), [
    "inv-1",
  ]);
  assertEquals(record.proposal.invoices[0].amount_due, 275);
  assertEquals(record.proposal.invoices[0].status, "AUTHORISED");
  assertEquals(record.proposal.invoices[0].hold, {
    classification: "genuine_debt",
    blocker: null,
    job_status: "complete",
  });
  assertEquals(record.proposal.destination, {
    channel: "sms",
    ghl_contact_id: "ghl-1",
    phone: "+61412345678",
    from_number: SMS_DEFAULT_FROM_NUMBER,
  });
  assertEquals(record.proposal.body, CHASE.message);
  assertEquals(record.body_sha256.length, 64);
  const again = await approve(w, CHASE);
  assertEquals(again, id);
  assertEquals(w.approvals.size, 1);
});

// ── Kind rules ─────────────────────────────────────────────────────────────

Deno.test("payment link binds the exact invoice and composes the online link text", async () => {
  const w = world();
  const result = await debtFollowupProposeAction({
    method: "POST",
    body: { request: LINK },
    deps: deps(w),
  });
  assert(result.status === "proposed");
  assertEquals(
    result.proposal.body,
    "Hi Sam, your invoice INV-0857 is ready. You can view and pay online here: https://in.xero.com/abc123\n\nThanks,\nSecureWorks Group",
  );
  assertEquals(result.proposal.invoices.map((i) => i.xero_invoice_id), [
    "inv-1",
  ]);

  const cases: [Obj, (w: World) => void, string][] = [
    [{ kind: "payment_link_sms" }, () => {}, "invoice_ids_required"],
    [
      { kind: "payment_link_sms", xero_invoice_ids: ["inv-1", "inv-2"] },
      () => {},
      "single_invoice_required",
    ],
    [LINK, (w) => (w.xero["inv-1"].Status = "DRAFT"), "invoice_not_payable"],
    [LINK, (w) => (w.recentLink = true), "payment_link_recently_sent"],
    [LINK, (w) => (w.onlineUrl = null), "online_invoice_missing"],
  ];
  for (const [request, mutate, reason] of cases) {
    const x = world();
    mutate(x);
    const r = await debtFollowupProposeAction({
      method: "POST",
      body: { request },
      deps: deps(x),
    });
    assertEquals(r.status, "refused", reason);
    if (r.status === "refused") assertEquals(r.reason, reason);
  }

  const moved = world({ env: SWITCH_ON });
  const id = await approve(moved, LINK);
  moved.onlineUrl = "https://in.xero.com/other";
  const stale = await press(moved, id);
  assertEquals(stale.status, "refused");
  if (stale.status === "refused") assertEquals(stale.detail?.changed, ["body"]);
  assertEquals(providerCalls(moved), 0);
});

Deno.test("chase, payment-link, and invoice email proposals refuse internal debt holds", async () => {
  const requests = [CHASE, LINK, EMAIL];
  const holds = [
    { debt_classification: "blocked_by_us", debt_blocker: null },
    { debt_classification: "genuine_debt", debt_blocker: "invoice_wrong" },
    { debt_classification: "genuine_debt", debt_blocker: "context_pending" },
  ];

  for (const request of requests) {
    for (const hold of holds) {
      const w = world();
      Object.assign(w.mirror["inv-1"], hold);
      const result = await debtFollowupProposeAction({
        method: "POST",
        body: { request },
        deps: deps(w),
      });
      assertEquals(result.status, "refused");
      if (result.status === "refused") {
        assertEquals(result.reason, "invoice_on_hold");
      }
      assertEquals(providerCalls(w), 0);
    }
  }
});

Deno.test("unclassified invoices on active jobs are held across debtor send kinds", async () => {
  for (
    const status of ["in_progress", "scheduled", "draft", "scoping", "quoted"]
  ) {
    for (const request of [CHASE, LINK, EMAIL]) {
      const w = world();
      w.jobStatuses["job-1"] = status;
      w.mirror["inv-1"].debt_classification = "unclassified";
      const result = await debtFollowupProposeAction({
        method: "POST",
        body: { request },
        deps: deps(w),
      });
      assertEquals(result.status, "refused", `${status}: ${request.kind}`);
      if (result.status === "refused") {
        assertEquals(result.reason, "invoice_on_hold");
        assertEquals(result.detail?.hold?.classification, "blocked_by_us");
        assertEquals(result.detail?.hold?.job_status, status);
      }
      assertEquals(providerCalls(w), 0);
    }
  }

  const unreadable = world();
  unreadable.fail.add("jobs");
  unreadable.mirror["inv-1"].debt_classification = "unclassified";
  const refusedRead = await debtFollowupProposeAction({
    method: "POST",
    body: { request: CHASE },
    deps: deps(unreadable),
  });
  assertEquals(refusedRead.status, "refused");
  if (refusedRead.status === "refused") {
    assertEquals(refusedRead.reason, "job_status_unreadable");
  }
  assertEquals(providerCalls(unreadable), 0);
});

Deno.test("job status changes after approval make the proposal stale", async () => {
  const w = world({ env: SWITCH_ON });
  w.mirror["inv-1"].debt_classification = "unclassified";
  const approvalId = await approve(w, CHASE);
  w.jobStatuses["job-1"] = "invoiced";
  const result = await press(w, approvalId);
  assertEquals(result.status, "refused");
  if (result.status === "refused") {
    assertEquals(result.reason, "approval_stale");
    assert(result.detail?.changed.includes("invoices.inv-1.hold"));
  }
  assertEquals(providerCalls(w), 0);
});

Deno.test("Xero null or missing invoice amounts refuse proposal construction", async () => {
  for (const field of ["AmountDue", "Total", "AmountPaid"] as const) {
    for (const missing of [false, true]) {
      const w = world();
      if (missing) delete w.xero["inv-1"][field];
      else w.xero["inv-1"][field] = null;
      const result = await debtFollowupProposeAction({
        method: "POST",
        body: { request: CHASE },
        deps: deps(w),
      });
      assertEquals(result.status, "refused", `${field}, missing=${missing}`);
      if (result.status === "refused") {
        assertEquals(result.reason, "xero_invoice_unreadable");
      }
      assertEquals(providerCalls(w), 0);
    }
  }

  const paidInvoice = world();
  paid(paidInvoice);
  paidInvoice.xero["inv-1"].AmountDue = null;
  const thankYou = await debtFollowupProposeAction({
    method: "POST",
    body: { request: THANKS },
    deps: deps(paidInvoice),
  });
  assertEquals(thankYou.status, "refused");
  if (thankYou.status === "refused") {
    assertEquals(thankYou.reason, "xero_invoice_unreadable");
  }
});

Deno.test("outbound proposals refuse em dashes in chase text and email subject", async () => {
  for (
    const request of [
      { ...CHASE, message: "Hi Sam — please review this invoice." },
      { ...EMAIL, subject: "Invoice INV-0857 — payment needed" },
    ]
  ) {
    const result = await debtFollowupProposeAction({
      method: "POST",
      body: { request },
      deps: deps(world()),
    });
    assertEquals(result.status, "refused");
    if (result.status === "refused") {
      assertEquals(result.reason, "em_dash_not_allowed");
    }
  }
});

Deno.test("thank-you text needs a PAID invoice and names the amount paid, without an em dash", async () => {
  const unpaid = world();
  const refusedResult = await debtFollowupProposeAction({
    method: "POST",
    body: { request: THANKS },
    deps: deps(unpaid),
  });
  assertEquals(refusedResult.status, "refused");
  const w = world();
  paid(w);
  const r = await debtFollowupProposeAction({
    method: "POST",
    body: { request: THANKS },
    deps: deps(w),
  });
  assert(r.status === "proposed");
  assertEquals(
    r.proposal.body,
    "Hi Sam, we've received your payment of $1,234.50 for invoice INV-0857. Thank you, SecureWorks Group",
  );
  assert(!r.proposal.body.includes("—"));
  assertEquals(formatAud(1234567.891), "$1,234,567.89");
});

Deno.test("thank-you text refuses unsupported or missing invoice currencies", async () => {
  for (const currency of ["USD", null, ""] as const) {
    const w = world();
    paid(w);
    w.xero["inv-1"].CurrencyCode = currency;
    const result = await debtFollowupProposeAction({
      method: "POST",
      body: { request: THANKS },
      deps: deps(w),
    });
    assertEquals(result.status, "refused");
    if (result.status === "refused") {
      assertEquals(result.reason, "payment_currency_unsupported");
    }
    assertEquals(providerCalls(w), 0);
  }

  const missingCurrency = world();
  paid(missingCurrency);
  delete missingCurrency.xero["inv-1"].CurrencyCode;
  const missingResult = await debtFollowupProposeAction({
    method: "POST",
    body: { request: THANKS },
    deps: deps(missingCurrency),
  });
  assertEquals(missingResult.status, "refused");
  if (missingResult.status === "refused") {
    assertEquals(missingResult.reason, "payment_currency_unsupported");
  }
  assertEquals(providerCalls(missingCurrency), 0);

  const lowerCaseAud = world();
  paid(lowerCaseAud);
  lowerCaseAud.xero["inv-1"].CurrencyCode = "aud";
  const result = await debtFollowupProposeAction({
    method: "POST",
    body: { request: THANKS },
    deps: deps(lowerCaseAud),
  });
  assert(result.status === "proposed");
  assertStringIncludes(result.proposal.body, "$1,234.50");
});

Deno.test("chase: one debtor, verified destination, and a named contact must match the binding", async () => {
  const two = world();
  two.xero["inv-2"].Contact.ContactID = "xc-2";
  two.mirror["inv-2"].xero_contact_id = "xc-2";
  const multi = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { ...CHASE, xero_invoice_ids: ["inv-1", "inv-2"] } },
    deps: deps(two),
  });
  assertEquals(multi.status, "refused");
  if (multi.status === "refused") {
    assertEquals(multi.reason, "multiple_debtors");
  }

  // The job carries no GHL contact: the org-scoped contact_matches binding is
  // the fallback (the invoice itself must still belong to one job).
  const unlinked = world();
  unlinked.jobs["job-1"] = null;
  const viaMatch = await debtFollowupProposeAction({
    method: "POST",
    body: { request: CHASE },
    deps: deps(unlinked),
  });
  assertEquals(viaMatch.status, "proposed");
  unlinked.matches["xc-1"] = null;
  const none = await debtFollowupProposeAction({
    method: "POST",
    body: { request: CHASE },
    deps: deps(unlinked),
  });
  assertEquals(none.status, "refused");
  if (none.status === "refused") {
    assertEquals(none.reason, "destination_unverified");
  }

  const wrong = world();
  const mismatch = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { ...CHASE, ghl_contact_id: "ghl-9" } },
    deps: deps(wrong),
  });
  assertEquals(mismatch.status, "refused");
  if (mismatch.status === "refused") {
    assertEquals(mismatch.reason, "destination_mismatch");
  }

  const nophone = world();
  nophone.ghl["ghl-1"].phone = null;
  const np = await debtFollowupProposeAction({
    method: "POST",
    body: { request: CHASE },
    deps: deps(nophone),
  });
  assertEquals(np.status, "refused");

  const both = world();
  const pair = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { ...CHASE, xero_invoice_ids: ["inv-2", "inv-1"] } },
    deps: deps(both),
  });
  assert(pair.status === "proposed");
  assertEquals(pair.proposal.invoices.map((i) => i.xero_invoice_id), [
    "inv-1",
    "inv-2",
  ]);
  assertEquals(pair.proposal.job_id, "job-1");
});

Deno.test("invoice email: recipient must be a verified anchor; the approved subject and address are what go", async () => {
  const w = world({
    env: SWITCH_ON,
    emailResponse: () =>
      Promise.resolve({
        status: 200,
        body: {
          success: true,
          emailed: true,
          via: "outlook",
          attachment_sha256: "a".repeat(64),
          provider_proof: {
            label: "accepted by Outlook",
            status: 202,
            request_id: "outlook-request-1",
            client_request_id: "client-request-1",
            sent_at: "2026-09-24T01:02:03.000Z",
            attachment_sha256: "a".repeat(64),
          },
          timeline_write_failed: true,
        },
      }),
  });
  const stranger = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { ...EMAIL, to_email: "stranger@hotmail.com" } },
    deps: deps(w),
  });
  assertEquals(stranger.status, "refused");
  if (stranger.status === "refused") {
    assertEquals(stranger.reason, "recipient_mismatch");
  }
  const badCc = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { ...EMAIL, cc: ["x@evil.example"] } },
    deps: deps(w),
  });
  assertEquals(badCc.status, "refused");

  const defaulted = await debtFollowupProposeAction({
    method: "POST",
    body: { request: { kind: "invoice_email", xero_invoice_ids: ["inv-1"] } },
    deps: deps(w),
  });
  assert(defaulted.status === "proposed");
  assertEquals(defaulted.proposal.destination, {
    channel: "email",
    to: "accounts@builder.example",
    cc: [],
  });
  assertEquals(
    defaulted.proposal.email?.subject,
    "Invoice INV-0857 from SecureWorks Group",
  );
  assertEquals(defaulted.proposal.email?.attachment.file_name, "INV-0857.pdf");
  assertStringIncludes(defaulted.proposal.body, "<strong>INV-0857</strong>");

  const request = {
    ...EMAIL,
    cc: "PM@builder.example",
    subject: "Overdue: INV-0857",
  };
  const id = await approve(w, request);
  const sent = await press(w, id);
  assertEquals(sent.status, "sent", JSON.stringify(sent));
  assertEquals(w.emails, [{
    xero_invoice_id: "inv-1",
    to_email: "accounts@builder.example",
    cc: ["pm@builder.example"],
    subject_override: "Overdue: INV-0857",
    job_id: "job-1",
    approval_id: id,
  }]);
  if (sent.status === "sent") {
    assertEquals(sent.provider, "outlook");
    assertEquals(sent.provider_proof?.attachment_sha256, "a".repeat(64));
    assertEquals(sent.provider_proof?.accepted, true);
    assertEquals(sent.provider_proof?.label, "accepted by Outlook");
    assertEquals(sent.provider_proof?.status, 202);
    assertEquals(sent.provider_proof?.request_id, "outlook-request-1");
    assertEquals(sent.provider_proof?.client_request_id, "client-request-1");
    assertEquals(sent.provider_proof?.sent_at, "2026-09-24T01:02:03.000Z");
    assertEquals(sent.provider_proof?.approval_id, id);
    assertEquals(sent.provider_proof?.timeline_write_failed, true);
  }
  await press(w, id);
  assertEquals(w.emails.length, 1);

  const refusedByTransport = world({
    env: SWITCH_ON,
    emailResponse: () =>
      Promise.resolve({ status: 400, body: { code: "recipient_mismatch" } }),
  });
  const rid = await approve(refusedByTransport, EMAIL);
  const r = await press(refusedByTransport, rid);
  assertEquals(r, {
    status: "failed",
    reason: "recipient_mismatch",
    approval_id: rid,
    binding_hash: refusedByTransport.approvals.get(rid)!.binding_hash,
  });
  await press(refusedByTransport, rid);
  assertEquals(refusedByTransport.emails.length, 1);
});

// ── Old actions with an approval id ────────────────────────────────────────

Deno.test("an old action pressing an approval must match its kind and any restated coordinate", async () => {
  const w = world({ env: SWITCH_ON });
  const id = await approve(w, CHASE);
  const legacy = (kind: "chase_sms" | "payment_link_sms", body: Obj) =>
    debtFollowupLegacySend({
      sourceAction: "send_chase_sms",
      kind,
      method: "POST",
      auth: captain,
      request: {},
      body,
      deps: deps(w),
    });
  assertEquals(await legacy("payment_link_sms", { approval_id: id }), {
    status: "refused",
    reason: "approval_kind_mismatch",
  });
  assertEquals(
    await legacy("chase_sms", { approval_id: id, message: "different words" }),
    {
      status: "refused",
      reason: "approval_request_mismatch",
    },
  );
  assertEquals(
    await legacy("chase_sms", { approval_id: id, xero_invoice_id: "inv-2" }),
    {
      status: "refused",
      reason: "approval_request_mismatch",
    },
  );
  assertEquals(providerCalls(w), 0);
  const ok = await legacy("chase_sms", {
    approval_id: id,
    xero_invoice_id: "inv-1",
    ghl_contact_id: "ghl-1",
    message: CHASE.message,
  });
  assertEquals(ok.status, "sent");
  assertEquals(w.sms.length, 1);
});

Deno.test("old actions refuse what they cannot bind, and record the refusal", async () => {
  const w = world();
  const contactOnly: DebtFollowupResult = await debtFollowupLegacySend({
    sourceAction: "send_chase_sms",
    kind: "chase_sms",
    method: "POST",
    auth: staff,
    request: { xero_invoice_ids: [], ghl_contact_id: "ghl-1", message: "hi" },
    body: {},
    deps: deps(w),
  });
  assertEquals(contactOnly, {
    status: "refused",
    reason: "invoice_ids_required",
    recorded: true,
  });
  assertEquals(w.attempts[0].outcome, "refused");
  // A ledger that cannot record still never sends.
  const broken = world();
  broken.fail.add("attempt_write");
  const { kind: _k, ...rest } = CHASE;
  const r = await debtFollowupLegacySend({
    sourceAction: "send_chase_sms",
    kind: "chase_sms",
    method: "POST",
    auth: staff,
    request: rest,
    body: {},
    deps: deps(broken),
  });
  assertEquals(r.status, "dry_run");
  if (r.status === "dry_run") assertEquals(r.recorded, false);
  assertEquals(providerCalls(broken) + providerCalls(w), 0);
});

// ── One job per approval (v1 scope) ───────────────────────────────────────

Deno.test("an approval covering two jobs is refused at approval, with 0 provider calls", async () => {
  const w = world({ env: SWITCH_ON });
  w.mirror["inv-2"].job_id = "job-2";
  w.jobs["job-2"] = "ghl-1";
  w.jobStatuses["job-2"] = "complete";
  const request = { ...CHASE, xero_invoice_ids: ["inv-1", "inv-2"] };
  const proposed = await debtFollowupProposeAction({
    method: "POST",
    body: { request },
    deps: deps(w),
  });
  assertEquals(proposed.status, "refused");
  if (proposed.status === "refused") {
    assertEquals(proposed.reason, "single_job_scope_required");
    assertEquals(proposed.detail?.job_ids, ["job-1", "job-2"]);
  }
  const approved = await debtFollowupApproveAction({
    method: "POST",
    auth: captain,
    body: { request, expected_binding_hash: "a".repeat(64) },
    deps: deps(w),
  });
  assertEquals(approved.status, "refused");
  if (approved.status === "refused") {
    assertEquals(approved.reason, "single_job_scope_required");
  }
  assertEquals(w.approvals.size, 0);
  assertEquals(providerCalls(w), 0);
});

Deno.test("an invoice that moves to a second job after approval refuses the press", async () => {
  const w = world({ env: SWITCH_ON });
  const id = await approve(w, {
    ...CHASE,
    xero_invoice_ids: ["inv-1", "inv-2"],
  });
  w.mirror["inv-2"].job_id = "job-2";
  const result = await press(w, id);
  assertEquals(result.status, "refused");
  if (result.status === "refused") {
    assertEquals(result.reason, "single_job_scope_required");
  }
  assertEquals(providerCalls(w), 0);
  assertEquals(w.live.size, 0);
});

Deno.test("an invoice with no job is refused for every kind before any provider read", async () => {
  for (
    const [request, prep] of [[CHASE, () => {}], [LINK, () => {}], [
      THANKS,
      paid,
    ], [EMAIL, () => {}]] as [Obj, (w: World) => void][]
  ) {
    const w = world({ env: SWITCH_ON });
    prep(w);
    w.mirror["inv-1"].job_id = null;
    w.fail.add("xero");
    w.fail.add("ghl");
    const result = await debtFollowupProposeAction({
      method: "POST",
      body: { request },
      deps: deps(w),
    });
    assertEquals(result.status, "refused", request.kind);
    if (result.status === "refused") {
      assertEquals(result.reason, "single_job_scope_required", request.kind);
      assertEquals(result.detail?.unlinked_invoice_ids, ["inv-1"]);
    }
    assertEquals(providerCalls(w), 0);
  }
});

Deno.test("a single-job send carries that job id to the provider", async () => {
  const sms = world({ env: SWITCH_ON });
  const sid = await approve(sms, {
    ...CHASE,
    xero_invoice_ids: ["inv-1", "inv-2"],
  });
  assertEquals((await press(sms, sid)).status, "sent");
  assertEquals(sms.sms.length, 1);
  assertEquals(sms.sms[0].jobId, "job-1");

  const email = world({ env: SWITCH_ON });
  const eid = await approve(email, EMAIL);
  assertEquals((await press(email, eid)).status, "sent");
  assertEquals(email.emails.length, 1);
  assertEquals(email.emails[0].job_id, "job-1");
});

// ── Who may use the three actions ─────────────────────────────────────────

const STAFF_CALLER: DebtFollowupCaller = {
  mode: "jwt",
  staff_role: true,
  org_id: ORG,
  server_secret: false,
};

Deno.test("only SecureWorks office staff or the privileged ops key pass the caller gate", () => {
  assertEquals(debtFollowupCallerRefusal(STAFF_CALLER, ORG), null);
  assertEquals(
    debtFollowupCallerRefusal({
      mode: "api_key",
      staff_role: false,
      org_id: null,
      server_secret: true,
    }, ORG),
    null,
  );
  const refusals: [string, DebtFollowupCaller, string][] = [
    [
      "other-org staff",
      { ...STAFF_CALLER, org_id: "other-org" },
      "operator_org_required",
    ],
    [
      "staff with no profile org",
      { ...STAFF_CALLER, org_id: null },
      "operator_org_required",
    ],
    [
      "trade or crew",
      { ...STAFF_CALLER, staff_role: false },
      "operator_access_required",
    ],
    ["shared browser key", {
      mode: "api_key",
      staff_role: false,
      org_id: null,
      server_secret: false,
    }, "operator_access_required"],
    ["anon", {
      mode: "none",
      staff_role: false,
      org_id: null,
      server_secret: false,
    }, "operator_access_required"],
    ["routine", {
      mode: "routine",
      staff_role: false,
      org_id: null,
      server_secret: false,
    }, "operator_access_required"],
    ["agent read", {
      mode: "agent_read",
      staff_role: false,
      org_id: null,
      server_secret: true,
    }, "operator_access_required"],
  ];
  for (const [label, caller, code] of refusals) {
    assertEquals(debtFollowupCallerRefusal(caller, ORG)?.code, code, label);
  }
});

Deno.test("a refused caller gets 403 before any dependency is built or read", async () => {
  for (
    const action of [
      "debt_followup_propose",
      "debt_followup_approve",
      "debt_followup_execute",
    ] as const
  ) {
    for (
      const caller of [
        { ...STAFF_CALLER, org_id: "other-org" },
        { ...STAFF_CALLER, staff_role: false },
        {
          mode: "api_key",
          staff_role: false,
          org_id: null,
          server_secret: false,
        },
        { mode: "none", staff_role: false, org_id: null, server_secret: false },
      ]
    ) {
      let built = 0;
      const result = await debtFollowupActionEntry({
        action,
        caller,
        orgId: ORG,
        method: "POST",
        auth: captain,
        body: { request: CHASE },
        makeDeps: () => {
          built++;
          return deps(world());
        },
      });
      assertEquals(result.status, 403, `${action} ${JSON.stringify(caller)}`);
      assertEquals(built, 0);
    }
  }
  const w = world();
  let built = 0;
  const allowed = await debtFollowupActionEntry({
    action: "debt_followup_propose",
    caller: STAFF_CALLER,
    orgId: ORG,
    method: "POST",
    auth: staff,
    body: { request: CHASE },
    makeDeps: () => {
      built++;
      return deps(w);
    },
  });
  assertEquals(allowed.status, 200);
  assertEquals(allowed.body.status, "proposed");
  assertEquals(built, 1);
});

Deno.test("the approval records the approving captain's user id; none means no approval", async () => {
  const w = world();
  const id = await approve(w, CHASE);
  assertEquals(w.approvals.get(id)!.approved_by_user_id, CAPTAIN_USER_ID);
  const proposed = await debtFollowupProposeAction({
    method: "POST",
    body: { request: LINK },
    deps: deps(w),
  });
  assert(proposed.status === "proposed");
  const noId = await debtFollowupApproveAction({
    method: "POST",
    auth: { mode: "jwt", email: CAPTAIN },
    body: { request: LINK, expected_binding_hash: proposed.binding_hash },
    deps: deps(w),
  });
  assertEquals(noId, {
    status: "refused",
    reason: "approval_requires_captain",
  });
  assertEquals(w.approvals.size, 1);
});

Deno.test("contact matching reads every row and fails closed past its scan limit", async () => {
  const reader = (count: number, second: boolean) => {
    const rows = Array.from({ length: count }, (_, i) => ({
      org_id: ORG,
      xero_contact_id: "xc-1",
      ghl_contact_id: second && i === count - 1 ? "ghl-2" : "ghl-1",
    }));
    const client = {
      from() {
        const filters: Array<[string, unknown]> = [];
        const query: Obj = {
          select: () => query,
          eq(field: string, value: unknown) {
            filters.push([field, value]);
            return query;
          },
          limit(n: number) {
            return Promise.resolve({
              data: rows.filter((r) =>
                filters.every(([f, v]) => (r as Obj)[f] === v)
              ).slice(0, n),
              error: null,
            });
          },
        };
        return query;
      },
    };
    return debtFollowupReads(client, {
      orgId: ORG,
      getToken: () => Promise.resolve({ accessToken: "", tenantId: "" }),
      xeroGet: () => Promise.resolve({}),
      assertInvoiceAllowed: () => Promise.resolve(undefined),
      fenceRefusal: () => null,
      sendInvoiceEmail: () => Promise.resolve({ status: 200, body: {} }),
      sendSms: () => Promise.resolve({ status: 200, body: {} }),
    });
  };
  const rejects = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  // A second contact past the first 10 rows is still seen.
  assertEquals(
    await rejects(reader(12, true).contactMatch("xc-1")),
    "contact_match_ambiguous",
  );
  assertEquals(
    await reader(CONTACT_MATCH_SCAN_LIMIT, false).contactMatch("xc-1"),
    "ghl-1",
  );
  assertEquals(
    await rejects(
      reader(CONTACT_MATCH_SCAN_LIMIT + 1, false).contactMatch("xc-1"),
    ),
    "contact_match_too_many",
  );
});

// ── Production ledger adapter ──────────────────────────────────────────────

Deno.test("live ledger: a duplicate live claim is 'already claimed', any other write error throws", async () => {
  const inserted: Obj[] = [];
  const client = (error: Obj | null) => ({
    from: () => ({
      insert: (row: Obj) => {
        inserted.push(row);
        return Promise.resolve({ error });
      },
    }),
  });
  const row = {
    approval_id: "a".repeat(64),
    binding_hash: "b".repeat(64),
    kind: "chase_sms" as const,
    channel: "sms" as const,
    press_token: crypto.randomUUID(),
    pressed_by: CAPTAIN,
    source_action: "debt_followup_execute",
    // deno-lint-ignore no-explicit-any
    proposal: {} as any,
  };
  assertEquals(await debtFollowupLedger(client(null)).claimLive(row), true);
  assertEquals(inserted[0].mode, "live");
  assertEquals(inserted[0].outcome, "sending");
  assertEquals(
    await debtFollowupLedger(client({ code: "23505" })).claimLive(row),
    false,
  );
  let threw = false;
  try {
    await debtFollowupLedger(client({ code: "42P01" })).claimLive(row);
  } catch {
    threw = true;
  }
  assert(threw);
});
