// deno-lint-ignore-file no-import-prefix no-explicit-any
// Crew scope of works on the Trade App (director, 12 Nov 2026): the trade view
// returns the sealed crew scope of works of the ACCEPTED, released revision
// (the one the accepted quote document is bound to), never the latest saved
// scope, with no money field; where the binding cannot be proved it gives the
// reason and no page. These tests drive the real trade_job_detail payload.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _tradeJobDetailForTest, redactTradeScopeQuote } from "./index.ts";
import {
  crewPageFromFrozenScope,
  readTradeCrewScopeOfWorks,
} from "./trade_crew_scope_of_works.ts";

// ── Stub client: a chainable PostgREST stand-in over in-memory tables ───────

type Tables = Record<string, any[]>;

function makeClient(tables: Tables, opts: { errorOn?: string } = {}) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    const run = () => {
      if (opts.errorOn === table) {
        return {
          data: null,
          error: { message: `stub error on ${table}` },
          count: null,
        };
      }
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null, count: rows.length };
    };
    const api: any = {
      select: () => api,
      order: () => api,
      eq: (c: string, v: any) => {
        preds.push((r) =>
          String((c === "is_ghost" ? r?.[c] ?? false : r?.[c]) ?? "") ===
            String(v)
        );
        return api;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      in: (c: string, vs: any[]) => {
        preds.push((r) => vs.map(String).includes(String(r?.[c])));
        return api;
      },
      not: (c: string, op: string, v: any) => {
        if (op === "is" && v === null) preds.push((r) => r?.[c] != null);
        return api;
      },
      is: (c: string, v: any) => {
        preds.push((r) => (r?.[c] ?? null) === v);
        return api;
      },
      gte: () => api,
      lte: () => api,
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      single: () => {
        const { data, error } = run();
        return Promise.resolve({
          data: error ? null : (data || [])[0] ?? null,
          error,
        });
      },
      maybeSingle: () => {
        const { data, error } = run();
        return Promise.resolve({
          data: error ? null : (data || [])[0] ?? null,
          error,
        });
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      update: () => {
        const upd: any = {
          eq: () => upd,
          is: () => upd,
          select: () => upd,
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (res: any, rej: any) =>
            Promise.resolve({ data: [], error: null }).then(res, rej),
        };
        return upd;
      },
      insert: (row: any) => {
        (tables[table] ||= []).push(row);
        const ins: any = {
          select: () => ins,
          single: () => Promise.resolve({ data: row, error: null }),
          then: (res: any, rej: any) =>
            Promise.resolve({ data: row, error: null }).then(res, rej),
        };
        return ins;
      },
    };
    return api;
  }
  return { from: (t: string) => builder(t) };
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const JOB_ID = "job-patio-1";
const ORG = "org-1";
const INSTALLER = "user-installer";

const PAGE_REV1 =
  "<!doctype html><html><head><title>Crew scope of works</title></head><body><h1>Crew scope of works REV1-PAGE</h1><p>Posts: 2. Height under beam 2,450 mm.</p></body></html>";
const PAGE_REV2 =
  "<!doctype html><html><head><title>Crew scope of works</title></head><body><h1>Crew scope of works REV2-PAGE</h1><p>Posts: 3.</p></body></html>";

// A Scope Engine patio record as the tool saves it: every money place the
// record has (expected figures, priced lines, the seal's price, the customer
// quote page, payment stages) is filled, so a leak shows.
async function enginePatioScope(
  n: number,
  frozenId: string,
  crewPage: string,
  opts: {
    stampHash?: string | null;
  } = {},
) {
  const contentHash = opts.stampHash === undefined
    ? await sha256Hex(JSON.stringify(crewPage))
    : opts.stampHash;
  return {
    tool: "patio-scoper",
    version: "2.0",
    supported: true,
    revision: {
      n,
      frozenId,
      sealedAt: "2026-11-10T02:00:00.000Z",
      outputsAgree: true,
      sealed: true,
    },
    expected: { materials: 4200.5, labour: 1800, sale: 9800, commission: 490 },
    lines: [
      {
        key: "post",
        description: "Post 90x90 SHS",
        qty: 2,
        unitPriceEx: 85.5,
        lineTotalEx: 171,
        cost: 60,
      },
    ],
    sealed: {
      seal: {
        frozen: {
          id: frozenId,
          price: { totalIncGst: 9800, depositIncGst: 980 },
          margin: 0.31,
        },
        stamps: [
          ...(contentHash === null ? [] : [{
            kind: "installer-sow",
            frozenRevisionId: frozenId,
            scopeRevisionId: `scope-${n}`,
            scopeLineIds: ["post"],
            contentHash,
          }]),
          {
            kind: "customer-quote",
            frozenRevisionId: frozenId,
            contentHash: "a".repeat(64),
          },
        ],
        documents: {
          "installer-sow": crewPage,
          "customer-quote": "<p>Your price: $9,800 inc GST. Deposit $980.</p>",
          "work-packages": "<p>Crew pay $1,800</p>",
        },
        payments: [{ label: "Deposit", amountIncGst: 980 }, {
          label: "Final",
          amountIncGst: 8820,
        }],
      },
    },
  };
}

async function frozenRow(
  id: string,
  number: number,
  status: string,
  scope: any,
) {
  const text = JSON.stringify(scope);
  return {
    id,
    job_id: JOB_ID,
    status,
    revision_number: number,
    tool_kind: "patio",
    scope_canonical_text: text,
    scope_hash: await sha256Hex(text),
  };
}

// Rev 1 sealed, sent and accepted; Rev 2 saved and frozen afterwards. The
// job's working scope is Rev 2.
async function seedRev1AcceptedRev2Saved(): Promise<Tables> {
  const rev1 = await enginePatioScope(1, "fz-1", PAGE_REV1);
  const rev2 = await enginePatioScope(2, "fz-2", PAGE_REV2);
  return {
    jobs: [{
      id: JOB_ID,
      org_id: ORG,
      type: "patio",
      status: "scheduled",
      job_number: "SWP-TEST-1",
      client_name: "Test Client",
      scope_json: rev2,
      pricing_json: { totalIncGST: 9800, deposit: 980 },
      metadata: {},
    }],
    job_documents: [{
      id: "doc-q1",
      job_id: JOB_ID,
      type: "quote",
      quote_number: "Q-1",
      sent_at: "2026-11-10T03:00:00.000Z",
      accepted_at: "2026-11-11T03:00:00.000Z",
      trade_pack_json: null,
      visible_to_trades: false,
    }],
    run_acceptances: [],
    job_variations: [],
    quote_revisions: [{
      job_id: JOB_ID,
      job_document_id: "doc-q1",
      scope_revision_id: "rev-1",
      sent_at: "2026-11-10T03:00:00.000Z",
    }],
    scope_revisions: [
      await frozenRow("rev-1", 1, "superseded", rev1),
      await frozenRow("rev-2", 2, "frozen", rev2),
    ],
    job_media: [],
    job_events: [],
    job_service_reports: [],
    work_orders: [],
    job_assignments: [{
      id: "asg-1",
      job_id: JOB_ID,
      user_id: INSTALLER,
      status: "scheduled",
      role: "lead_installer",
      is_lead: false,
      crew_name: "Crew",
      users: { name: "Crew", phone: null },
    }],
    purchase_orders: [],
    makesafe_job_details: [],
    feature_flags: [],
  };
}

const installer = {
  id: INSTALLER,
  email: "installer@example.test",
  orgId: ORG,
  role: "installer",
  managedVerticals: [] as string[],
};

function detail(tables: Tables, jobId = JOB_ID) {
  return _tradeJobDetailForTest(
    makeClient(tables),
    new URLSearchParams({ jobId }),
    installer as any,
    false,
  ) as Promise<any>;
}

// ── The money-key check over the whole payload ──────────────────────────────
// A key fails when any word of its name (split on _, -, and camelCase) is one
// of these, and it carries a value (a number, a non-empty string, or a
// non-empty object or list). An emptied container (`pricing: {}`, the existing
// labour-only shape) carries no figure.
export const MONEY_KEY_WORDS = [
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "margin",
  "margins",
  "commission",
  "deposit",
  "deposits",
  "payment",
  "payments",
  "paid",
  "sell",
  "sale",
  "sales",
  "total",
  "totals",
  "subtotal",
  "gst",
  "amount",
  "amounts",
  "rate",
  "rates",
  "money",
  "invoice",
  "invoices",
  "quoted",
  "profit",
];

function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(
    /[^a-z0-9]+/,
  )
    .filter(Boolean);
}

function carriesValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "number") return true;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

// Two existing shapes carry a money-named key but no figure, and are allowed
// by exact shape only (anything more fails):
// - `pricing: { labour: { trades, days, labourers } }`: the crew's own
//   headcount and days (redactTradeScopeQuote keeps only these, TRD4-REV15-001);
// - quote pack `terms.payment_terms` holding exactly the sealed phrase
//   "50% deposit + 50% on completion" (TRD-4, isSealedPaymentTermsPhrase): no
//   amount, kept for crews by the existing quote pack rule.
function allowedShape(key: string, v: unknown): boolean {
  if (key === "pricing" && v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, any>;
    if (Object.keys(o).join() !== "labour") return false;
    const labour = o.labour;
    return !!labour && typeof labour === "object" && !Array.isArray(labour) &&
      Object.entries(labour).every(([lk, lv]) =>
        ["trades", "days", "labourers"].includes(lk) && typeof lv === "number"
      );
  }
  if (key === "payment_terms" && typeof v === "string") {
    return /^\s*50%\s*deposit\s*\+\s*50%\s*on\s+completion\s*$/i.test(v);
  }
  return false;
}

function moneyLeaks(node: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...moneyLeaks(v, `${path}[${i}]`)));
    return out;
  }
  if (typeof node === "string") {
    if (/\$\s?\d/.test(node)) out.push(`${path} (dollar amount in text)`);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (
      keyWords(k).some((w) => MONEY_KEY_WORDS.includes(w)) && carriesValue(v) &&
      !allowedShape(k, v)
    ) {
      out.push(p);
    }
    out.push(...moneyLeaks(v, p));
  }
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test("Rev 1 accepted then Rev 2 saved: the crew get Rev 1's sealed page, never Rev 2's", async () => {
  const d = await detail(await seedRev1AcceptedRev2Saved());
  const c = d.crew_scope_of_works;
  assertEquals(c, {
    status: "accepted",
    page: PAGE_REV1,
    content_hash: await sha256Hex(JSON.stringify(PAGE_REV1)),
    revision: { n: 1, frozen_revision_id: "fz-1" },
    reason: null,
    reason_code: null,
  });
  const whole = JSON.stringify(d);
  assert(!whole.includes("REV2-PAGE"), "Rev 2's page reached the crew");
  // Nothing else of the seal rides scope_json to the crew.
  assertEquals("sealed" in d.job.scope_json, false);
});

Deno.test("whole trade payload for a v2 patio carries no money key", async () => {
  const d = await detail(await seedRev1AcceptedRev2Saved());
  assertEquals(moneyLeaks(d), []);
  // The fixture really did carry money: the check is not passing on nothing.
  const tables = await seedRev1AcceptedRev2Saved();
  assert(moneyLeaks(tables.jobs[0].scope_json).length > 5);
});

Deno.test("whole trade payload for a fence carries no money key, and a fence gets no crew page", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  const fenceScope = {
    tool: "fencing",
    job: {
      pricePerMetre: 145,
      runs: [{
        id: "r1",
        length: 24.5,
        material: "Colorbond",
        colour: "Monument",
      }],
      gates: [{ width: 0.9, kind: "single" }],
    },
    pricing: {
      labour: { trades: 2, days: 1, dayRate: 900, sell: 1800 },
      extras: [{ name: "Removal", sell: 300 }],
    },
    _pricing_json: { totalIncGST: 4200 },
    job_costs: { materials: 1500 },
    notes: { noteQuote: "Supply and install 24.5 m of Colorbond fencing" },
  };
  tables.jobs[0] = {
    ...tables.jobs[0],
    type: "fencing",
    scope_json: fenceScope,
  };
  tables.scope_revisions = [];
  tables.quote_revisions = [];
  const d = await detail(tables);
  assertEquals(moneyLeaks(d), []);
  assert(moneyLeaks(fenceScope).length > 3);
  // Older tools: unchanged.
  assertEquals(d.crew_scope_of_works, null);
  assertEquals(d.job.scope_json, redactTradeScopeQuote(fenceScope));
});

Deno.test("binding not provable: accepted quote names no revision -> no page, reason given", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  tables.quote_revisions[0].scope_revision_id = null;
  const c = (await detail(tables)).crew_scope_of_works;
  assertEquals(c.status, "not_proved");
  assertEquals(c.page, null);
  assertEquals(c.revision, null);
  assertEquals(c.content_hash, null);
  assertEquals(c.reason_code, "accepted_quote_not_bound_to_revision");
  assertEquals(
    c.reason,
    "The accepted quote is not linked to a sealed scope revision.",
  );
});

Deno.test("not accepted: no page for any revision, reason given", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  tables.job_documents[0].accepted_at = null;
  const d = await detail(tables);
  const c = d.crew_scope_of_works;
  assertEquals(c.status, "not_proved");
  assertEquals(c.page, null);
  assertEquals(c.reason_code, "no_accepted_document");
  assert(typeof c.reason === "string" && c.reason.length > 0);
  const whole = JSON.stringify(d);
  assert(!whole.includes("REV1-PAGE") && !whole.includes("REV2-PAGE"));
});

Deno.test("an unreadable acceptance chain gives no page, never the latest save", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  const c = await readTradeCrewScopeOfWorks(
    makeClient(tables, { errorOn: "quote_revisions" }),
    JOB_ID,
    tables.jobs[0].scope_json,
  );
  assertEquals(c?.status, "not_proved");
  assertEquals(c?.page, null);
  assertEquals(c?.reason_code, "acceptance_chain_unreadable");
});

Deno.test("an accepted revision whose text does not match its fingerprint gives no page", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  tables.scope_revisions[0].scope_hash = "0".repeat(64);
  const c = (await detail(tables)).crew_scope_of_works;
  assertEquals(c.status, "not_proved");
  assertEquals(c.reason_code, "accepted_revision_unverified");
  assertEquals(c.page, null);
});

Deno.test("a crew page that does not match its stamp, or has none, is not shown", async () => {
  const changed = await enginePatioScope(1, "fz-1", PAGE_REV1, {
    stampHash: "b".repeat(64),
  });
  assertEquals(
    (await crewPageFromFrozenScope(changed)).reason_code,
    "crew_page_does_not_match_stamp",
  );
  const unstamped = await enginePatioScope(1, "fz-1", PAGE_REV1, {
    stampHash: null,
  });
  assertEquals(
    (await crewPageFromFrozenScope(unstamped)).reason_code,
    "crew_page_has_no_stamp",
  );
  const priced = await enginePatioScope(1, "fz-1", "<p>Crew pay $1,800</p>");
  const p = await crewPageFromFrozenScope(priced);
  assertEquals(p.reason_code, "crew_page_shows_dollar_amount");
  assertEquals(p.page, null);
});

Deno.test("office still sees the whole working scope, and the same crew page field", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  const d: any = await _tradeJobDetailForTest(
    makeClient(tables),
    new URLSearchParams({ jobId: JOB_ID }),
    { ...installer, role: "admin" } as any,
    true,
  );
  assertEquals(d.quote_visible, true);
  assertEquals(
    d.job.scope_json.sealed.seal.documents["installer-sow"],
    PAGE_REV2,
  );
  assertEquals(d.crew_scope_of_works.page, PAGE_REV1);
});

// Ruling 17a, every tier (money14's case on PR 1426): the office and a division
// manager read the quote on the Trade App, but no budget, commission or
// salesperson key reaches them either. The quote fence is not the gate.
Deno.test("trade view: no budget, commission or salesperson key for any tier, the quote kept where it is visible", async () => {
  const tables = await seedRev1AcceptedRev2Saved();
  const seller = { id: "00000000-0000-4000-8000-00000000000b", name: "ZZTEST Seller Two" };
  const budget = {
    version: "budget.v1",
    job: { salesperson: seller },
    commission: { rule_id: "fence_15", percent: 15, salesperson: seller },
    totals: { cost_before_commission_ex_gst: 5500, commission_ex_gst: 675, profit_after_commission_ex_gst: 3825 },
  };
  const scope = tables.jobs[0].scope_json;
  scope.budget = budget;
  scope.expected = { commission: 675 };
  if (scope.sealed) scope.sealed.budget = budget;
  scope.job = {
    ...(scope.job || {}),
    commissionBasis: "gross_profit",
    quote: { quote_number: "Q-1", salesperson: seller },
    revisionPacks: [{ commissionFrom: "app", budget, snapshot: { commissionBasis: "gross_profit", runs: [] } }],
  };
  tables.jobs[0].pricing_json = { totalIncGST: 9800, budget };
  const tiers: Array<[string, any, boolean, boolean]> = [
    ["allocated", installer, false, false],
    ["division_manager", { ...installer, managedVerticals: ["patio"] }, false, true],
    ["office", { ...installer, role: "admin" }, true, true],
  ];
  for (const [tier, viewer, isAdmin, quoteVisible] of tiers) {
    const d: any = await _tradeJobDetailForTest(
      makeClient(structuredClone(tables)),
      new URLSearchParams({ jobId: JOB_ID }),
      viewer,
      isAdmin,
    );
    assertEquals(d.quote_visible, quoteVisible, tier);
    const found: string[] = [];
    const walk = (x: unknown, p: string) => {
      if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${p}[${i}]`));
      if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          if (/commission|salesperson|budget/i.test(k)) found.push(`${p}.${k}`);
          walk(v, `${p}.${k}`);
        }
      }
    };
    walk(d, "");
    assertEquals(found, [], tier);
    const text = JSON.stringify(d);
    assert(!text.includes("ZZTEST Seller Two"), tier);
    assert(!text.includes(seller.id), tier);
    assert(d.crew_scope_of_works, `${tier}: the crew page is kept`);
    if (quoteVisible) {
      // The quote a quote-visible tier may read is kept.
      assertEquals(d.job.scope_json.job.quote.quote_number, "Q-1", tier);
    }
  }
});
