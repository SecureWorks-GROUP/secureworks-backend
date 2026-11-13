// deno-lint-ignore-file no-explicit-any no-import-prefix
// Read-only company view (Marnin, 13 Nov 2026; flag trade_company_job_view_v1,
// seeded off). Contract: docs/trade-open-access-v1.md.
//
// With the switch ON, a trade who is not on a job may FIND it and OPEN it,
// read only: no prices, no customer phone or email, a trimmed crew list, no
// service reports. Every write door still refuses them exactly as before.
// With the switch OFF nothing changes. Both directions are driven through the
// real handlers (trade_job_detail, trade_quote_extract, search_all_jobs) and,
// for the doors, through the real request handler.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertAssignedOrMakesafeAccessForTest,
  _opsApiRequestHandlerForTest,
  _tradeJobDetailForTest,
  _tradeQuoteExtractForTest,
  resolveTradeJobAccessTier,
  searchAllJobs,
  type TradeAuthContext,
  tradeLabourCostVisibleForTier,
  tradeQuoteVisibleForTier,
} from "./index.ts";
import { packTradeQuote } from "../_shared/trade_quote_pack/pack_trade_quote.ts";
import { SELF_ALLOCATE_REFUSED_JOB_STATUSES } from "./trade_self_allocation.ts";
import {
  HIDDEN_EMAIL_TEXT,
  HIDDEN_PHONE_TEXT,
  isCustomerContactKey,
  maskContactInText,
  projectCompanyViewCrew,
  stripCustomerContactDeep,
  TRADE_COMPANY_JOB_VIEW_FLAG,
} from "./trade_open_access.ts";

// ── 1. The pure rules ───────────────────────────────────────────────────────

Deno.test("contact keys: a phone, an email or the CRM contact; never a key that only mentions an email", () => {
  for (const key of ["client_phone", "client_email", "ghl_contact_id", "contact_phone", "clientPhone", "mobile", "siteContactMobile", "phone", "email", "tenant_phone_number", "emailAddress"]) {
    assertEquals(isCustomerContactKey(key), true, key);
  }
  for (const key of ["builder_email_subject", "builder_email_text_for_trade", "builder_email_received_at", "client_name", "site_address", "ghl_opportunity_id", "contact_name", "phoneticName", "notes"]) {
    assertEquals(isCustomerContactKey(key), false, key);
  }
});

Deno.test("free text: phone numbers and emails are masked; job numbers, orders, sizes, dates, links and files are not", () => {
  const masked = (text: string) => maskContactInText(text);
  for (const phone of ["0412 345 678", "0412345678", "04 1234 5678", "0412-345-678", "(08) 9123 4567", "08 9123 4567", "+61 412 345 678", "+61412345678", "+61 8 9123 4567", "61412345678"]) {
    assertEquals(masked(`Call Pat on ${phone} for the gate`), `Call Pat on ${HIDDEN_PHONE_TEXT} for the gate`, phone);
  }
  assertEquals(masked("Send to pat.owner+site@example.com.au today"), `Send to ${HIDDEN_EMAIL_TEXT} today`);
  for (
    const kept of [
      "SWMS-261114 at 12 Smith St",
      "MLB-25147PO-56236",
      "PO-1000001 due 2026-11-20",
      "Fence 2100 high, 65x65 posts, 42.5 m",
      "Attended 07-11-2026 0830 to 1500",
      "Visit on 07/11/2026 08:30",
      "Order 100012345678 from the supplier",
      "https://example.test/files/0412345678.jpg",
      "data:image/png;base64,0412345678AAAA",
      // ids: a run of digits inside a longer id is never a phone number
      "7d4f0a52-0000-4000-8000-0412345678ab",
      "7d4f0a52-0000-4000-8000-000412345678",
      "04123456-7890-4000-8000-0000000000aa",
      "org/job/photos/0412345678ab.jpg",
      "ghl-opp-0412345678x",
    ]
  ) {
    assertEquals(masked(kept), kept, kept);
  }
});

Deno.test("deep strip never rewrites an identifier, a reference, a link, a path or a date, whatever its digits", () => {
  const row: any = {
    id: "0412345678",
    job_id: "0412 345 678",
    assignment_ids: "0412345678",
    quote_number: "0412345678",
    external_ref: "0412345678",
    storage_url: "0412345678",
    path: "0412345678",
    created_at: "0412345678",
    scheduled_date: "0412345678",
    label: "Ring 0412345678",
  };
  assertEquals(stripCustomerContactDeep(row), { ...row, label: `Ring ${HIDDEN_PHONE_TEXT}` });
});

Deno.test("deep strip: contact keys go at every depth, text is masked, the input is untouched", () => {
  const input: any = {
    client_phone: "0412 345 678",
    notes: "Ring 0412 345 678",
    nested: [{ contact: { email: "a@b.co", name: "Pat" }, ghl_contact_id: "c-1", keep: 2100 }],
    url: "https://example.test/0412345678",
  };
  const copy = structuredClone(input);
  assertEquals(stripCustomerContactDeep(input), {
    notes: `Ring ${HIDDEN_PHONE_TEXT}`,
    nested: [{ contact: { name: "Pat" }, keep: 2100 }],
    url: "https://example.test/0412345678",
  });
  assertEquals(input, copy);
});

Deno.test("crew for a reader who is not on the job: name, user, day, status and lead only, never a watcher row", () => {
  assertEquals(
    projectCompanyViewCrew([
      { id: "a1", user_id: "u1", name: "Lee", scheduled_date: "2026-11-20", status: "confirmed", is_lead: true, role: "lead_installer", hours_worked: 6, clocked_on_at: "x", users: { name: "Lee", phone: "0400 111 222" } },
      { id: "a2", user_id: "u2", users: { name: "Kim" }, scheduled_date: "2026-11-20", status: "scheduled", role: "lead_installer" },
      { id: "g1", user_id: "u9", name: "Watcher", role: "observer", status: "scheduled" },
      { id: "g2", user_id: "u9", name: "Watcher", is_ghost: true, role: "lead_installer", status: "scheduled" },
    ]),
    [
      { id: "a1", user_id: "u1", name: "Lee", scheduled_date: "2026-11-20", status: "confirmed", is_lead: true },
      { id: "a2", user_id: "u2", name: "Kim", scheduled_date: "2026-11-20", status: "scheduled", is_lead: false },
    ],
  );
});

// ── In-memory client ────────────────────────────────────────────────────────

type Tables = Record<string, any[]>;

function memClient(tables: Tables, log: Array<{ table: string; op: string }> = []) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let rangeN: [number, number] | null = null;
    let selectCols: string[] | null = null;
    let head = false;
    let orderKey: string | null = null;
    let orderAsc = true;
    const run = () => {
      log.push({ table, op: "select" });
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      const count = rows.length;
      if (orderKey) {
        const key = orderKey;
        rows = rows.slice().sort((a, b) => {
          const x = String(a?.[key] ?? "");
          const y = String(b?.[key] ?? "");
          return x === y ? 0 : (x < y ? -1 : 1) * (orderAsc ? 1 : -1);
        });
      }
      if (rangeN) rows = rows.slice(rangeN[0], rangeN[1] + 1);
      else if (limitN != null) rows = rows.slice(0, limitN);
      // A plain column list answers only those columns, as PostgREST does.
      rows = rows.map((r) => {
        if (!selectCols) return structuredClone(r);
        const out: any = {};
        for (const c of selectCols) if (c in (r || {})) out[c] = structuredClone(r[c]);
        return out;
      });
      return head ? { data: null, count, error: null } : { data: rows, count, error: null };
    };
    const api: any = {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        const c = String(cols || "").trim();
        head = opts?.head === true;
        selectCols = c && c !== "*" && !c.includes("(") && !c.includes(":")
          ? c.split(",").map((x) => x.trim()).filter(Boolean)
          : null;
        return api;
      },
      // First order() is the sort; a second is the tiebreak, not needed here.
      order: (k: string, o?: { ascending?: boolean }) => {
        if (!orderKey) {
          orderKey = k;
          orderAsc = o?.ascending !== false;
        }
        return api;
      },
      range: (a: number, b: number) => {
        rangeN = [a, b];
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      eq: (c: string, v: any) => {
        preds.push((r) => String((c === "is_ghost" ? r?.[c] ?? false : r?.[c]) ?? "") === String(v));
        return api;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      in: (c: string, vals: any[]) => {
        preds.push((r) => vals.map(String).includes(String(r?.[c] ?? "")));
        return api;
      },
      is: (c: string, v: any) => {
        preds.push((r) => (r?.[c] ?? null) === v);
        return api;
      },
      ilike: (c: string, pattern: string) => {
        const needle = String(pattern).replace(/%/g, "").toLowerCase();
        preds.push((r) => String(r?.[c] ?? "").toLowerCase().includes(needle));
        return api;
      },
      not: (c: string, op: string, v: string) => {
        if (op === "in") {
          const list = String(v).replace(/[()"]/g, "").split(",").map((x) => x.trim());
          preds.push((r) => !list.includes(String(r?.[c] ?? "")));
        }
        return api;
      },
      or: (expr: string) => {
        const terms = String(expr).split(",").map((t) => t.trim()).filter(Boolean);
        const ilikes = terms.map((t) => /^(\w+)\.ilike\.%(.*)%$/.exec(t)).filter(Boolean) as RegExpExecArray[];
        if (ilikes.length === terms.length) {
          preds.push((r) => ilikes.some((m) => String(r?.[m[1]] ?? "").toLowerCase().includes(m[2].toLowerCase())));
        }
        return api;
      },
      single: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      insert: (row: any) => {
        log.push({ table, op: "insert" });
        const rec = { id: row?.id || `${table}-${(tables[table] || []).length + 1}`, ...row };
        (tables[table] ||= []).push(rec);
        const inserted = { data: rec, error: null };
        const chain: any = {
          select: () => chain,
          single: () => Promise.resolve(inserted),
          maybeSingle: () => Promise.resolve(inserted),
          then: (res: any, rej: any) => Promise.resolve(inserted).then(res, rej),
        };
        return chain;
      },
      update: (row: any) => {
        log.push({ table, op: "update" });
        const apply = () => {
          const matched = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
          for (const r of matched) Object.assign(r, row);
          return { data: matched[0] ?? null, error: null };
        };
        const chain: any = {
          select: () => chain,
          eq: (c: string, v: any) => {
            api.eq(c, v);
            return chain;
          },
          single: () => Promise.resolve(apply()),
          maybeSingle: () => Promise.resolve(apply()),
          then: (res: any, rej: any) => Promise.resolve(apply()).then(res, rej),
        };
        return chain;
      },
    };
    return api;
  }
  return {
    from: (t: string) => builder(t),
    storage: {
      createBucket: () => Promise.resolve({}),
      from(bucket: string) {
        return {
          upload: () => Promise.resolve({ error: null }),
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${bucket}/${path}` } }),
        };
      },
    },
  };
}

// ── The world ───────────────────────────────────────────────────────────────

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const JOB_FENCE = "job-fence";
const JOB_PATIO = "job-patio";
// Real ids for the two a builder reference can find: the search only admits a
// reference match whose id is a uuid.
const JOB_MS = "7d4f0a52-0000-4000-8000-00000000a003";
const JOB_QUOTED = "job-quoted";
const JOB_OTHER_ORG = "7d4f0a52-0000-4000-8000-00000000b001";
const STRANGER = "u-stranger";
const CREW = "u-crew";
const HENRY = "u-henry";
const WATCHER = "u-watcher";

const PHONE = "0412 345 678";
const EMAIL = "pat.owner@example.com";

const QUOTE_SCOPE = {
  tool: "fence",
  client: { name: "Pat Owner", phone: PHONE, email: EMAIL, notes: `Gate on the left. Ring ${PHONE}` },
  pricing: { labour: { trades: 2, days: 3, dayRate: 400, sell: 3200 } },
  _pricing_json: { totalExGST: 8000, totalIncGST: 8800 },
  job: {
    pricePerMetre: 125,
    runs: [{ length: 10 }],
    siteNotes: `Park on the verge. Owner mobile ${PHONE}`,
    sitePlanImage: "data:image/png;base64,0412345678AAAA",
    quote: {
      quote_number: "Q-1",
      description: "Supply and install Monument fencing with a gate on the left.",
      materials: [{ name: "90x90 posts", qty: 12, unit_price: 45, total: 540 }],
      quotedTotal: 594,
    },
  },
};

function frozenQuote(doc: any) {
  doc.sent_at = "2026-09-01T00:00:00Z";
  doc.trade_pack_json = packTradeQuote({
    quote_number: doc.quote_number,
    job_document_id: doc.id,
    sent_at: doc.sent_at,
    job_type: "fencing",
    scope_json: structuredClone(QUOTE_SCOPE),
    pricing_json: { payment_terms: "50% deposit + 50% on completion", valid_days: 30 },
    customer: { name: "Pat Owner", phone: PHONE, email: EMAIL, site_address: "1 Fence St", site_suburb: "Midland" },
    source: "frozen",
  } as any);
  return doc;
}

function seed(flagOn: boolean): Tables {
  const job = (id: string, over: any) => ({
    id,
    org_id: ORG_A,
    type: "fencing",
    status: "scheduled",
    job_number: id.toUpperCase(),
    client_name: "Pat Owner",
    client_phone: PHONE,
    client_email: EMAIL,
    ghl_contact_id: "ghl-contact-1",
    ghl_opportunity_id: "ghl-opp-1",
    site_address: "1 Fence St",
    site_suburb: "Midland",
    notes: "Internal job notes",
    metadata: { builder_po_number: "PO-1" },
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  });
  return {
    feature_flags: flagOn ? [{ flag_name: TRADE_COMPANY_JOB_VIEW_FLAG, enabled: true }] : [],
    jobs: [
      job(JOB_FENCE, {
        job_number: "SWF-26091",
        scope_json: structuredClone(QUOTE_SCOPE),
        pricing_json: { labourTotal: 3200, total: 8800 },
        notes: `Park on the verge. Ring the owner on ${PHONE} or ${EMAIL} before you arrive.`,
        created_at: "2026-10-05T00:00:00Z",
      }),
      job(JOB_PATIO, { type: "patio", job_number: "SWP-26100", created_at: "2026-10-04T00:00:00Z" }),
      job(JOB_MS, { type: "makesafe", status: "in_progress", job_number: "SWMS-26900", created_at: "2026-10-03T00:00:00Z" }),
      job(JOB_QUOTED, { status: "quoted", job_number: "SWF-26200", created_at: "2026-10-02T00:00:00Z" }),
      job(JOB_OTHER_ORG, { org_id: ORG_B, job_number: "SWF-99001", created_at: "2026-10-06T00:00:00Z" }),
    ],
    job_assignments: [
      { id: "a-crew", job_id: JOB_FENCE, user_id: CREW, status: "confirmed", is_lead: true, role: "lead_installer", scheduled_date: "2026-11-20", hours_worked: 6, clocked_on_at: "2026-11-20T00:00:00Z", users: { name: "Casey Crew", phone: "0400 999 888" } },
      { id: "a-other", job_id: JOB_FENCE, user_id: "u-other", status: "scheduled", is_lead: false, role: "lead_installer", scheduled_date: "2026-11-21", users: { name: "Olly Other", phone: "0400 777 666" } },
      { id: "a-ghost", job_id: JOB_FENCE, user_id: WATCHER, status: "scheduled", is_ghost: true, role: "observer", scheduled_date: "2026-11-20", users: { name: "Watcher", phone: "0400 555 444" } },
      { id: "a-crew-patio", job_id: JOB_PATIO, user_id: CREW, status: "scheduled", is_lead: false, role: "lead_installer", scheduled_date: "2026-11-22" },
      { id: "a-cancelled", job_id: JOB_MS, user_id: STRANGER, status: "cancelled", role: "lead_installer", scheduled_date: "2026-11-01" },
    ],
    job_documents: [
      { id: "d-site", job_id: JOB_FENCE, type: "site_plan", visible_to_trades: true, file_name: "plan.pdf" },
      { id: "d-quote", job_id: JOB_FENCE, type: "quote", visible_to_trades: true, file_name: "quote.pdf", quote_number: "Q-1" },
      { id: "d-invoice", job_id: JOB_FENCE, type: "invoice", visible_to_trades: true, file_name: "inv.pdf" },
      { id: "d-internal", job_id: JOB_FENCE, type: "general", visible_to_trades: false, file_name: "internal.pdf" },
    ].map((d) => d.type === "quote" ? frozenQuote(d) : d),
    job_media: [
      { id: "m-1", job_id: JOB_FENCE, phase: "before", type: "photo", storage_url: "https://storage.test/p/0412345678.jpg", label: "Front fence", notes: `Owner on site, ${PHONE}`, created_at: "2026-10-10T00:00:00Z" },
    ],
    job_events: [
      { id: "e-1", job_id: JOB_FENCE, event_type: "note", detail_json: { text: `Client rang from ${PHONE} about the side gate.` }, created_at: "2026-10-11T00:00:00Z", users: { name: "Office" } },
      { id: "e-2", job_id: JOB_FENCE, event_type: "note", detail_json: { text: "Quoted $4,500 for the extra panel." }, created_at: "2026-10-10T00:00:00Z", users: { name: "Office" } },
    ],
    job_service_reports: [
      { id: "sr-1", job_id: JOB_FENCE, status: "submitted", notes: `Spoke to owner ${PHONE}`, created_at: "2026-10-12T00:00:00Z" },
    ],
    work_orders: [
      { id: "wo-1", job_id: JOB_FENCE, kind: "crew", wo_number: "WO-1", status: "sent", scope_items: [{ description: "Install 42 m fence", qty: 42, unit: "m", price: 125, total: 5250 }], special_instructions: `Call the owner on ${PHONE} before you arrive`, scheduled_date: "2026-11-20" },
    ],
    purchase_orders: [
      { id: "po-1", job_id: JOB_FENCE, po_number: "PO-9", supplier_name: "Steel Co", status: "sent", delivery_date: "2026-11-19", line_items: [{ description: "Posts", quantity: 12, unit: "ea", unit_price: 45, total: 540 }] },
    ],
    makesafe_job_details: [
      { job_id: JOB_MS, external_ref: "MLB-27000", substatus: "allocated", site_contact_phone: PHONE, site_contact_name: "Terry Tenant", invoice_notes: "Bill $500" },
    ],
    job_contacts: [],
  };
}

const viewer = (id: string, over: Partial<TradeAuthContext> = {}): TradeAuthContext => ({
  id,
  email: `${id}@example.test`,
  orgId: ORG_A,
  role: "installer",
  managedVerticals: [],
  seeEverything: false,
  ...over,
});

const access = { orgId: ORG_A, managedVerticals: [] as string[] };
const tier = (tables: Tables, jobId: string, userId: string, opts: any = {}) =>
  resolveTradeJobAccessTier(memClient(tables), jobId, userId, { access, ...opts });

// ── 2. The tier ─────────────────────────────────────────────────────────────

Deno.test("tier: switch on, a read that asks, a live job in the caller's company they are not on -> company_view, quote hidden", async () => {
  for (const jobId of [JOB_FENCE, JOB_PATIO, JOB_MS]) {
    const d = await tier(seed(true), jobId, STRANGER, { allowCompanyView: true });
    assertEquals([d.tier, d.quoteVisible, d.reason], ["company_view", false, "company_view"], jobId);
  }
  assertEquals(tradeQuoteVisibleForTier("company_view"), false);
  assertEquals(tradeLabourCostVisibleForTier("company_view"), false);
});

Deno.test("tier: another company's job stays tenant_mismatch; a job the self-allocation rule refuses stays not_assigned", async () => {
  const other = await tier(seed(true), JOB_OTHER_ORG, STRANGER, { allowCompanyView: true });
  assertEquals([other.tier, other.reason], ["none", "tenant_mismatch"]);
  for (const status of SELF_ALLOCATE_REFUSED_JOB_STATUSES) {
    const tables = seed(true);
    tables.jobs.find((j) => j.id === JOB_FENCE)!.status = status;
    const d = await tier(tables, JOB_FENCE, STRANGER, { allowCompanyView: true });
    assertEquals([d.tier, d.reason], ["none", "not_assigned"], status);
  }
  const holding = seed(true);
  holding.jobs.find((j) => j.id === JOB_FENCE)!.metadata = { do_not_schedule: "true" };
  assertEquals((await tier(holding, JOB_FENCE, STRANGER, { allowCompanyView: true })).tier, "none");
  // A finished job can still be opened, as it can still be self-allocated for an invoice.
  const done = seed(true);
  done.jobs.find((j) => j.id === JOB_FENCE)!.status = "complete";
  assertEquals((await tier(done, JOB_FENCE, STRANGER, { allowCompanyView: true })).tier, "company_view");
});

Deno.test("tier: switch off, or a door that does not ask, is refused exactly as before; the switch is not even read by a door that does not ask", async () => {
  const off = await tier(seed(false), JOB_FENCE, STRANGER, { allowCompanyView: true });
  assertEquals([off.tier, off.reason], ["none", "not_assigned"]);

  const log: Array<{ table: string; op: string }> = [];
  const notAsked = await resolveTradeJobAccessTier(memClient(seed(true), log), JOB_FENCE, STRANGER, { access });
  assertEquals([notAsked.tier, notAsked.reason], ["none", "not_assigned"]);
  assertEquals(log.some((q) => q.table === "feature_flags"), false);

  // The shared assert every write door calls: no option, so the old refusal.
  const err = await assertRejects(() =>
    _assertAssignedOrMakesafeAccessForTest(memClient(seed(true)), JOB_FENCE, STRANGER, false, access)
  ) as Error;
  assertEquals(err.message, "You are not assigned to this job");
  const granted = await _assertAssignedOrMakesafeAccessForTest(memClient(seed(true)), JOB_FENCE, STRANGER, false, access, {
    allowCompanyView: true,
  });
  assertEquals(granted.tier, "company_view");
});

Deno.test("tier: being on the job, managing its division or seeing everything still outranks the company view", async () => {
  const on = { allowCompanyView: true };
  assertEquals((await tier(seed(true), JOB_FENCE, CREW, on)).tier, "allocated");
  const manager = await resolveTradeJobAccessTier(memClient(seed(true)), JOB_FENCE, HENRY, {
    access: { orgId: ORG_A, managedVerticals: ["fencing"] },
    ...on,
  });
  assertEquals(manager.tier, "division_manager");
  assertEquals((await tier(seed(true), JOB_FENCE, STRANGER, { isOffice: true, ...on })).tier, "office");
  // A cancelled row is not being on the job: company view, not allocated.
  assertEquals((await tier(seed(true), JOB_MS, STRANGER, on)).tier, "company_view");
});

// ── 3. trade_job_detail ─────────────────────────────────────────────────────

const detail = (tables: Tables, v: TradeAuthContext, jobId = JOB_FENCE) =>
  _tradeJobDetailForTest(memClient(tables), new URLSearchParams({ jobId }), v, false);

Deno.test("trade_job_detail: switch off, a trade who is not on the job is refused as before", async () => {
  const err = await assertRejects(() => detail(seed(false), viewer(STRANGER))) as Error;
  assertEquals(err.message, "You are not assigned to this job");
});

Deno.test("trade_job_detail: company view carries no customer phone, email or CRM contact, and no prices", async () => {
  const res: any = await detail(seed(true), viewer(STRANGER));
  assertEquals(res.access_tier, "company_view");
  assertEquals(res.quote_visible, false);
  for (const key of ["client_phone", "client_email", "ghl_contact_id", "pricing_json", "metadata"]) {
    assertEquals(key in res.job, false, key);
  }
  // What the owner said a trade may read: who, where, the scope, the notes, the photos.
  assertEquals(
    [res.job.id, res.job.job_number, res.job.client_name, res.job.site_address, res.job.site_suburb],
    [JOB_FENCE, "SWF-26091", "Pat Owner", "1 Fence St", "Midland"],
  );
  // The notes are readable. The allocated redaction already drops a bare run
  // of digits from free text; the email is masked by the company view.
  assertEquals(res.job.notes, `Park on the verge. Ring the owner on or ${HIDDEN_EMAIL_TEXT} before you arrive.`);
  assertEquals(res.notes.length, 2);
  assertEquals(res.notes[0].detail_json.text, "Client rang from about the side gate.");
  assertEquals(res.media.length, 1);
  assertEquals(res.workOrders[0].scope_items, [{ description: "Install 42 m fence", qty: 42, unit: "m" }]);
  assertEquals(res.media[0].storage_url, "https://storage.test/p/0412345678.jpg", "a link is never rewritten");
  assert(res.scopeSummary !== undefined);
  assertEquals(res.purchaseOrders[0].line_items, [{ description: "Posts", quantity: 12, unit: "ea" }]);
  // Documents follow the allocated rule: flagged for trades, never a quote or an invoice.
  assertEquals(res.documents.map((d: any) => d.id), ["d-site"]);
  assertEquals(res.job.scope_json.job.sitePlanImage, "data:image/png;base64,0412345678AAAA", "media blobs are not rewritten");

  const wire = JSON.stringify(res);
  for (const leak of [PHONE, EMAIL, "ghl-contact-1", "0400 999 888", "0400 777 666", "0400 555 444", "$4,500", "4,500", "pricePerMetre", "unit_price", "_pricing_json", "dayRate", "quotedTotal", "8800"]) {
    assertEquals(wire.includes(leak), false, `leaked ${leak}`);
  }
});

Deno.test("trade_job_detail: company view crew is who and when only, with no watcher row, and the service reports are withheld", async () => {
  const res: any = await detail(seed(true), viewer(STRANGER));
  assertEquals(res.crew, [
    { id: "a-crew", user_id: CREW, name: "Casey Crew", scheduled_date: "2026-11-20", status: "confirmed", is_lead: true },
    { id: "a-other", user_id: "u-other", name: "Olly Other", scheduled_date: "2026-11-21", status: "scheduled", is_lead: false },
  ]);
  assertEquals(res.leadInstaller, { assignment_id: "a-crew", user_id: CREW, name: "Casey Crew" });
  assertEquals(res.serviceReport, null);
  assertEquals(res.serviceReports, []);
});

Deno.test("trade_job_detail: with the switch on, a trade who IS on the job still gets the customer's contact and the full crew rows", async () => {
  const res: any = await detail(seed(true), viewer(CREW));
  assertEquals(res.access_tier, "allocated");
  assertEquals([res.job.client_phone, res.job.client_email, res.job.ghl_contact_id], [PHONE, EMAIL, "ghl-contact-1"]);
  assertEquals(res.crew.find((c: any) => c.id === "a-crew").hours_worked, 6);
  assertEquals(res.serviceReports.length, 1);
  // and the response for that trade is the same with the switch off
  const off: any = await detail(seed(false), viewer(CREW));
  assertEquals(JSON.stringify(res), JSON.stringify(off));
});

Deno.test("trade_job_detail: company view on a make-safe takes the site contact off the make-safe details too", async () => {
  const res: any = await detail(seed(true), viewer(STRANGER), JOB_MS);
  assertEquals(res.access_tier, "company_view");
  assertEquals(res.makesafe_details.external_ref, "MLB-27000");
  assertEquals("site_contact_phone" in res.makesafe_details, false);
  assertEquals("invoice_notes" in res.makesafe_details, false, "the allocated redaction still applies");
  assertEquals(JSON.stringify(res).includes(PHONE), false);
});

// ── 4. trade_quote_extract ──────────────────────────────────────────────────

async function extract(tables: Tables, v: TradeAuthContext) {
  const res = await _tradeQuoteExtractForTest(memClient(tables), new URLSearchParams({ jobId: JOB_FENCE }), {}, v, false);
  return { status: res.status, body: await res.json() as any };
}

Deno.test("trade_quote_extract: company view reads the price-free extract without the customer's phone or email; a stranger with the switch off gets the generic 404", async () => {
  const out = await extract(seed(true), viewer(STRANGER));
  assertEquals(out.status, 200);
  assertEquals([out.body.extract.customer.name, out.body.extract.customer.phone, out.body.extract.customer.email], ["Pat Owner", null, null]);
  const wire = JSON.stringify(out.body);
  assertEquals(wire.includes(PHONE) || wire.includes(EMAIL), false);
  assert(out.body.extract.scope.length > 0 || out.body.extract.quote_lines.length > 0 || out.body.extract.notes.length >= 0);

  const onJob = await extract(seed(true), viewer(CREW));
  assertEquals([onJob.body.extract.customer.phone, onJob.body.extract.customer.email], [PHONE, EMAIL]);

  const err = await assertRejects(() => extract(seed(false), viewer(STRANGER))) as any;
  assertEquals([err.status, err.message], [404, "Job not found"]);
});

// ── 5. search_all_jobs ──────────────────────────────────────────────────────

const search = (tables: Tables, v: TradeAuthContext, query = "", isDispatcher = false) =>
  searchAllJobs(memClient(tables), new URLSearchParams(query), v, isDispatcher);

Deno.test("search_all_jobs: switch off, a plain trade still gets only their own jobs, with no assigned_to_me key", async () => {
  const mine: any = await search(seed(false), viewer(CREW));
  assertEquals(mine.lens, "assigned");
  assertEquals(mine.jobs.map((j: any) => j.id).sort(), [JOB_FENCE, JOB_PATIO]);
  assertEquals(mine.jobs.some((j: any) => "assigned_to_me" in j), false);
  assertEquals(mine.jobs.find((j: any) => j.id === JOB_FENCE).client_phone, PHONE);
  const none: any = await search(seed(false), viewer(STRANGER));
  assertEquals([none.jobs, none.total, none.lens], [[], 0, "assigned"]);
});

Deno.test("search_all_jobs: switch on, a plain trade browses the whole company on the allocated-safe projection, with assigned_to_me", async () => {
  const res: any = await search(seed(true), viewer(CREW));
  assertEquals(res.lens, "company");
  assertEquals(res.total, 4);
  assertEquals(res.jobs.map((j: any) => j.id), [JOB_FENCE, JOB_PATIO, JOB_MS, JOB_QUOTED], "newest first, never another company's job");
  assertEquals(
    Object.fromEntries(res.jobs.map((j: any) => [j.id, j.assigned_to_me])),
    { [JOB_FENCE]: true, [JOB_PATIO]: true, [JOB_MS]: false, [JOB_QUOTED]: false },
  );
  for (const job of res.jobs) {
    for (const key of ["notes", "metadata", "org_id", "pricing_json", "scope_json"]) assertEquals(key in job, false, `${job.id} ${key}`);
    if (job.assigned_to_me) {
      assertEquals([job.client_phone, job.client_email], [PHONE, EMAIL], job.id);
    } else {
      assertEquals("client_phone" in job || "client_email" in job || "contact_phone" in job, false, job.id);
      assertEquals(JSON.stringify(job).includes(PHONE) || JSON.stringify(job).includes(EMAIL), false, job.id);
    }
    assertEquals([job.client_name, job.site_suburb], ["Pat Owner", "Midland"]);
  }
  // The make-safe row keeps its eight identity keys and no billing or contact.
  const ms = res.jobs.find((j: any) => j.id === JOB_MS);
  assertEquals(ms.makesafe_details.external_ref, "MLB-27000");
  assertEquals("invoice_notes" in ms.makesafe_details || "site_contact_phone" in ms.makesafe_details, false);

  // A trade with no job at all gets the company too, every row not theirs.
  const stranger: any = await search(seed(true), viewer(STRANGER));
  assertEquals(stranger.jobs.length, 4);
  assertEquals(stranger.jobs.every((j: any) => j.assigned_to_me === false && !("client_phone" in j)), true);
});

Deno.test("search_all_jobs: switch on, the company browse pages as the company lens pages, and a typed search covers the company", async () => {
  const first: any = await search(seed(true), viewer(CREW), "page_size=3");
  assertEquals([first.jobs.length, first.total, first.truncated, first.next_offset, first.page_size, first.offset], [3, 4, true, 3, 3, 0]);
  const second: any = await search(seed(true), viewer(CREW), "page_size=3&offset=3");
  assertEquals([second.jobs.map((j: any) => j.id), second.truncated, second.next_offset], [[JOB_QUOTED], false, null]);

  const typed: any = await search(seed(true), viewer(STRANGER), "q=swms");
  assertEquals(typed.lens, "search");
  assertEquals(typed.jobs.map((j: any) => [j.id, j.assigned_to_me]), [[JOB_MS, false]]);
  // The builder reference finds the job too, and never one in another company.
  const tables = seed(true);
  tables.makesafe_job_details.push({ job_id: JOB_OTHER_ORG, external_ref: "MLB-27000" });
  const byRef: any = await search(tables, viewer(STRANGER), "q=mlb-27000");
  assertEquals(byRef.jobs.map((j: any) => j.id), [JOB_MS]);
  // Deleted, void, duplicate and draft records stay out, as today.
  const withDraft = seed(true);
  withDraft.jobs.find((j) => j.id === JOB_QUOTED)!.status = "draft";
  const browse: any = await search(withDraft, viewer(STRANGER));
  assertEquals(browse.jobs.map((j: any) => j.id).includes(JOB_QUOTED), false);
});

Deno.test("search_all_jobs: switch on changes nothing for a manager or a see-everything viewer, and the switch is not read for them", async () => {
  for (const [v, dispatcher] of [
    [viewer(HENRY, { managedVerticals: ["fencing"] }), false],
    [viewer("u-office", { seeEverything: true }), true],
  ] as Array<[TradeAuthContext, boolean]>) {
    const logOn: Array<{ table: string; op: string }> = [];
    const on: any = await searchAllJobs(memClient(seed(true), logOn), new URLSearchParams(), v, dispatcher);
    const off: any = await search(seed(false), v, "", dispatcher);
    assertEquals(JSON.stringify(on), JSON.stringify(off), v.id);
    assertEquals(on.jobs.some((j: any) => "assigned_to_me" in j), false);
    assertEquals(logOn.some((q) => q.table === "feature_flags"), false, v.id);
  }
});

// ── 6. Through the real request handler: reads open, every write door shut ──

const DOOR_TRADE = "7d4f0a52-0000-4000-8000-0000000c00e1";
const DOOR_JOB = "7d4f0a52-0000-4000-8000-0000000c00b1";
const DOOR_ORG = "00000000-0000-0000-0000-000000000001";

async function callDoor(
  action: string,
  body: Record<string, unknown>,
  opts: { flagOn: boolean; method?: string },
): Promise<{ status: number; text: string; json: any; tables: string[]; writes: string[]; flags: string[] }> {
  const tables: string[] = [];
  const writes: string[] = [];
  // Which switches the door asked about.
  const flags: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: DOOR_TRADE, email: "", aud: "authenticated" }));
    }
    const rest = url.pathname.match(/^\/rest\/v1\/(.+)$/);
    if (rest) tables.push(rest[1]);
    if (rest && method !== "GET" && method !== "HEAD") writes.push(`${method} ${rest[1]}`);
    if (rest?.[1] === "users") {
      return reply([{ id: DOOR_TRADE, org_id: DOOR_ORG, role: "installer", name: "Door Trade", managed_verticals: [], trade_sees_all_jobs: false }]);
    }
    if (rest?.[1] === "feature_flags") {
      flags.push(String(url.searchParams.get("flag_name") || "").replace(/^eq\./, ""));
      // Every switch on: the other two must not open a job door either.
      return reply(opts.flagOn ? [{ enabled: true }] : []);
    }
    if (rest?.[1] === "jobs") {
      return reply([{
        id: DOOR_JOB,
        org_id: DOOR_ORG,
        type: "fencing",
        job_number: "SWF-DOOR",
        status: "scheduled",
        client_name: "Pat Owner",
        client_phone: PHONE,
        client_email: EMAIL,
        ghl_contact_id: "ghl-contact-1",
        site_address: "1 Door St",
        site_suburb: "Midland",
        scope_json: {},
        metadata: {},
      }]);
    }
    // Nobody is on the job: no assignment rows, no documents, nothing else.
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    url.searchParams.set("jobId", DOOR_JOB);
    url.searchParams.set("job_id", DOOR_JOB);
    const method = opts.method ?? "POST";
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method,
        headers: { authorization: "Bearer plain-trade-jwt", "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ ...body, jobId: DOOR_JOB, job_id: DOOR_JOB }),
      }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch { /* an HTML or empty reply */ }
    return { status: res.status, text, json, tables, writes, flags };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// Every per-job door that is not one of the three reads. Each must answer a
// trade who is not on the job exactly as it does today, switch on or off.
const SHUT_DOORS: Array<{ action: string; body?: Record<string, unknown> }> = [
  { action: "add_note", body: { text: "hello" } },
  { action: "upload_photo", body: { dataUrl: "data:image/png;base64,AAAA" } },
  { action: "get_upload_url", body: { fileName: "site.jpg", contentType: "image/jpeg" } },
  { action: "confirm_upload", body: { publicUrl: "https://example.invalid/p.jpg", path: "p.jpg" } },
  { action: "get_service_report" },
  { action: "submit_service_report", body: { status: "submitted", checklist: {} } },
  { action: "submit_makesafe_report", body: { status: "submitted" } },
  { action: "roof_report_template" },
  { action: "save_roof_report", body: { fields: {} } },
  { action: "submit_roof_report", body: { fields: {} } },
  { action: "trade_labour_budget" },
  { action: "complete_my_job" },
  { action: "waive_neighbour_signoff", body: { reason: "neighbour away" } },
  { action: "log_my_job_hours", body: { hours: 2 } },
  { action: "request_assistance", body: { requested_trade_id: "u-other-trade", requested_dates: ["2026-11-30"] } },
  { action: "create_trade_alert", body: { issueType: "access", detail: "gate locked" } },
  { action: "create_variation", body: { description: "Extra panel", estimated_cost: 150 } },
  { action: "report_work_order_variation", body: { trade_invoice_id: "7d4f0a52-0000-4000-8000-0000000c00f1", description: "Extra panel" } },
];

for (const door of SHUT_DOORS) {
  handlerTest(`doors: ${door.action} refuses a trade who is not on the job the same way with the company view on as with it off, and writes nothing`, async () => {
    const off = await callDoor(door.action, door.body ?? {}, { flagOn: false });
    const on = await callDoor(door.action, door.body ?? {}, { flagOn: true });
    assert(off.status >= 400 && off.status !== 401, `${door.action} off: ${off.status} ${off.text}`);
    assertEquals([on.status, on.text], [off.status, off.text], `${door.action} answered differently with the switch on`);
    assertEquals(on.writes, [], `${door.action} wrote with the switch on`);
    assertEquals(off.writes, []);
    assertEquals(on.tables, off.tables, `${door.action} read different tables with the switch on`);
    assertEquals(
      [...on.flags, ...off.flags].includes(TRADE_COMPANY_JOB_VIEW_FLAG),
      false,
      `${door.action} must never ask for the company view`,
    );
  });
}

handlerTest("doors: with the switch on the three reads open for a trade who is not on the job, and say company_view", async () => {
  const jobDetail = await callDoor("trade_job_detail", {}, { flagOn: true, method: "GET" });
  assertEquals(jobDetail.status, 200, jobDetail.text);
  assertEquals(jobDetail.json.access_tier, "company_view");
  assertEquals("client_phone" in jobDetail.json.job || "client_email" in jobDetail.json.job || "ghl_contact_id" in jobDetail.json.job, false);
  assertEquals(jobDetail.text.includes(PHONE) || jobDetail.text.includes(EMAIL), false);
  assertEquals(jobDetail.writes, []);
  assert(jobDetail.flags.includes(TRADE_COMPANY_JOB_VIEW_FLAG));

  const workOrder = await callDoor("my_job_work_order", {}, { flagOn: true, method: "GET" });
  assertEquals(workOrder.status, 200, workOrder.text);
  assertEquals([workOrder.json.job_id, workOrder.json.work_order, workOrder.json.can_report_variation], [DOOR_JOB, null, false]);
  assertEquals(workOrder.writes, []);

  // No sent quote on this job: past the access gate, the read's own answer.
  const quote = await callDoor("trade_quote_extract", {}, { flagOn: true, method: "GET" });
  assertEquals([quote.status, quote.json.error], [404, "No sent quote extract for this job"], quote.text);
});

handlerTest("doors: with the switch off the three reads refuse a trade who is not on the job, as before", async () => {
  const jobDetail = await callDoor("trade_job_detail", {}, { flagOn: false, method: "GET" });
  assertEquals([jobDetail.status, jobDetail.json.error], [500, "You are not assigned to this job"]);
  const workOrder = await callDoor("my_job_work_order", {}, { flagOn: false, method: "GET" });
  assertEquals([workOrder.status, workOrder.json.error], [500, "You are not assigned to this job"]);
  const quote = await callDoor("trade_quote_extract", {}, { flagOn: false, method: "GET" });
  assertEquals([quote.status, quote.json.code], [404, "job_not_found"]);
});
