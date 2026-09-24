// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planScopeBuild,
  type PriceBookRow,
  ScopeBuildError,
  type ScopeInput,
  scopePriceBookKeys,
} from "./scope_build.ts";
import {
  quantityText,
  type QuoteDocumentView,
  renderQuoteDocumentHtml,
  sha256Hex,
  termsFor,
} from "./quote_document.ts";
import { renderQuotePdf, termsBlocks } from "./quote_pdf.ts";
import { buildPartyMessages, QUOTE_LINK_PLACEHOLDER } from "./send_message.ts";
import {
  deliverLiveRow,
  LIVE_DELIVERY_FLAG_VALUE,
  liveDeliveryGate,
} from "./delivery.ts";
import {
  handleQuoteV2Request,
  quoteSendApprovers,
  type QuoteV2Deps,
} from "./handler.ts";

// ── Scope build ─────────────────────────────────────────────────────────
const STEEL: PriceBookRow = {
  item_key: "steel-rhs-100x50x2",
  unit: "lm",
  status: "provisional",
  cut_rule: "one_per_stick",
  kerf_mm: 3,
  stock_lengths_mm: [5500, 6500, 8000],
};
const POST: PriceBookRow = {
  item_key: "patio-post-90x90",
  unit: "each",
  status: "blessed",
  cut_rule: null,
  kerf_mm: null,
  stock_lengths_mm: null,
};
const CLIENT = {
  ref: "c",
  role: "client",
  display_name: "Margaret",
  share_rule: "sole",
  share_bp: 10000,
};
const scope = (items: ScopeInput["items"]): ScopeInput => ({
  family: "patio",
  scope: { title: "Patio" },
  parties: [CLIENT],
  items,
});

Deno.test("build: required lengths buy stock lengths, one priced line per length, markup on each", () => {
  const input = scope([
    {
      key: "beams",
      description: "Beam 100x50x2",
      price_book: {
        item_key: STEEL.item_key,
        cut: {
          pieces: [{ length_mm: 6000, qty: 1 }, { length_mm: 4800, qty: 2 }],
        },
      },
      markup: { multiplier: 1.3, reason: "steel" },
    },
    {
      key: "posts",
      description: "Posts",
      qty: 4,
      price_book: { item_key: POST.item_key },
    },
  ]);
  assertEquals(scopePriceBookKeys(input), [STEEL.item_key, POST.item_key]);
  const plan = planScopeBuild(input, [STEEL, POST]);
  const lines = plan.payload.lines;
  assertEquals(
    lines.map((l) => [l.line_key, l.qty, l.unit, l.cost]),
    [
      ["beams@5500", 2, "length", {
        source: "price_book",
        item_key: STEEL.item_key,
        stock_length_mm: 5500,
      }],
      ["beams@6500", 1, "length", {
        source: "price_book",
        item_key: STEEL.item_key,
        stock_length_mm: 6500,
      }],
      ["posts", 4, undefined, {
        source: "price_book",
        item_key: POST.item_key,
      }],
    ],
  );
  assertEquals(lines[0].description, "Beam 100x50x2 (lengths of 5.5 m)");
  // The sell is always cost x markup unless stated; a tool never sets one.
  assert(
    lines.every((l) => (l.sell as { basis: string }).basis === "cost_markup"),
  );
  assertEquals(plan.markups, [
    { line_key: "beams@5500", multiplier: 1.3, reason: "steel" },
    { line_key: "beams@6500", multiplier: 1.3, reason: "steel" },
  ]);
  assertEquals(plan.cuts[0].purchased_mm, 17500);
  assertEquals(plan.cuts[0].rule_source, "price_book");
});

Deno.test("build: unknown, unpriced and wrongly shaped items are refused before any write", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as ScopeBuildError).code;
    }
    return null;
  };
  const one = (item: ScopeInput["items"][number], rows = [STEEL, POST]) =>
    code(() => planScopeBuild(scope([item]), rows));
  assertEquals(
    one({
      key: "x",
      description: "X",
      qty: 1,
      price_book: { item_key: "nope" },
    }),
    "quote_line_item_unknown",
  );
  assertEquals(
    one({ key: "x", description: "X", qty: 1, price_book: { item_key: "p" } }, [
      { ...POST, item_key: "p", status: "unpriced" },
    ]),
    "quote_line_unpriced",
  );
  assertEquals(
    one({
      key: "x",
      description: "X",
      price_book: {
        item_key: POST.item_key,
        cut: { pieces: [{ length_mm: 100, qty: 1 }] },
      },
    }),
    "quote_line_stock_length_needs_lm_item",
  );
  assertEquals(
    one({
      key: "x",
      description: "X",
      qty: 3,
      price_book: {
        item_key: STEEL.item_key,
        cut: { pieces: [{ length_mm: 100, qty: 1 }] },
      },
    }),
    "quote_line_qty_invalid",
  );
  assertEquals(
    one({
      key: "x",
      description: "X",
      qty: 1,
      sell: { basis: "stated", unit_sell_ex_gst: 10 },
      markup: { multiplier: 1.2 },
    }),
    "quote_line_not_marked_up",
  );
  assertEquals(
    one({
      key: "x",
      description: "X",
      qty: 1,
      price_book: { item_key: POST.item_key },
      markup: { multiplier: 0.9 },
    }),
    "quote_markup_below_cost",
  );
  assertEquals(
    one({ key: "Bad Key", description: "X", qty: 1 }),
    "quote_line_key_invalid",
  );
  assertEquals(
    code(() =>
      planScopeBuild(
        scope([
          { key: "a", description: "A", qty: 1, cost: { source: "tool" } },
          { key: "a", description: "A", qty: 1, cost: { source: "tool" } },
        ]),
        [],
      )
    ),
    "quote_line_key_duplicate",
  );
  assertThrows(() => planScopeBuild(scope([]), []), ScopeBuildError);
});

Deno.test("build: an adjustment needs no quantity; stated costs pass through", () => {
  const plan = planScopeBuild(
    scope([
      {
        key: "labour",
        description: "Install",
        qty: 2,
        unit: "hour",
        cost: {
          source: "stated",
          unit_cost_ex_gst: 50,
          stated_by: "marnin",
          evidence: "rate",
        },
      },
      {
        key: "rounding",
        description: "Rounding",
        sell: {
          basis: "adjustment",
          amount_ex_gst: -2.35,
          stated_by: "marnin",
          stated_at: "2026-09-17T12:00:00+08:00",
        },
        note: "rounded",
      },
    ]),
    [],
  );
  assertEquals(plan.payload.lines[1].cost, { source: "none" });
  assertEquals(plan.payload.lines[1].qty, undefined);
  assertEquals(plan.markups, []);
});

// ── Documents ───────────────────────────────────────────────────────────
const VIEW: QuoteDocumentView = {
  revision_id: "64222f15-ce1d-47ee-9a0d-b8b1f48febb7",
  revision_number: 2,
  content_hash: "sha256:" + "ab".repeat(32),
  job_number: "SWF-261423",
  site_suburb: "Gwelup",
  family: "fencing",
  scope: {
    title: "Colorbond boundary fence",
    summary: "22 m of Colorbond.",
    exclusions: ["Root removal"],
  },
  valid_until: "2026-10-24",
  issued_on: "2026-09-24",
  job_total: { ex_gst: 4330, gst: 433, inc_gst: 4763 },
  party: {
    first_name: "Fiona",
    role: "neighbour",
    share: { ex_gst: 2165, gst: 216.5, inc_gst: 2381.5 },
    share_of_job_percent: 50,
  },
  lines: [{
    description: "Colorbond fence",
    qty: 22,
    unit: "lm",
    line_total_ex_gst: 2750,
    your_share_ex_gst: 1375,
  }],
  other_parties: [{
    first_name: "Stephen",
    role: "client",
    share_of_job_percent: 50,
  }],
};

Deno.test("document: the HTML shows the party's own share and the split, deterministically", () => {
  const a = renderQuoteDocumentHtml(VIEW);
  assertEquals(a, renderQuoteDocumentHtml(VIEW));
  assertStringIncludes(a, '<div class="who">Fiona</div>');
  assertStringIncludes(a, "$2,381.50");
  assertStringIncludes(a, "You pay 50%; Stephen pays 50%");
  assertStringIncludes(a, "Valid until 24 October 2026");
  assertStringIncludes(a, "01 This quote");
  assert(!/cost to us|markup|price book/i.test(a));
  assert(!a.includes("—"), "no em dash in customer copy");
  const solo = renderQuoteDocumentHtml({
    ...VIEW,
    family: "patio",
    other_parties: [],
  });
  assert(!solo.includes("This work is shared"));
  assert(!solo.includes("Terms and conditions"), "no unapproved patio terms");
  assertEquals(termsFor("stratco").length, 17);
  assertEquals(quantityText(22, "lm"), "22 m");
  assertEquals(quantityText(1, "item"), "");
  assertEquals(quantityText(2, "stock"), "2 lengths");
});

Deno.test("document: text from the record is escaped", () => {
  const html = renderQuoteDocumentHtml({
    ...VIEW,
    scope: { title: "<script>x</script>" },
    other_parties: [{ ...VIEW.other_parties[0], first_name: "<b>S</b>" }],
  });
  assert(!html.includes("<script>x"));
  assert(!html.includes("<b>S</b>"));
});

Deno.test("document: the PDF is the same bytes every time and says the same thing", async () => {
  const a = await renderQuotePdf(VIEW);
  const b = await renderQuotePdf(VIEW);
  assertEquals(await sha256Hex(a), await sha256Hex(b));
  assertEquals(new TextDecoder().decode(a.slice(0, 5)), "%PDF-");
  const other = await renderQuotePdf({
    ...VIEW,
    party: { ...VIEW.party, share: { ex_gst: 1, gst: 0.1, inc_gst: 1.1 } },
  });
  assert(await sha256Hex(other) !== await sha256Hex(a));
});

Deno.test("document: the approved terms keep their bold and list items", () => {
  const blocks = termsBlocks(
    "<p>We stop. <b>We tell you.</b> Then</p><ul><li>Rock</li></ul>",
  );
  assertEquals(blocks, [
    {
      bullet: false,
      runs: [
        { text: "We stop. ", bold: false },
        { text: "We tell you.", bold: true },
        { text: " Then", bold: false },
      ],
    },
    { bullet: true, runs: [{ text: "Rock", bold: false }] },
  ]);
});

Deno.test("messages: every message carries the link placeholder and only this party's money", () => {
  const m = buildPartyMessages(VIEW, { fromName: "Khairo" });
  for (const text of [m.email.text, m.email.html, m.sms.text]) {
    assertStringIncludes(text, QUOTE_LINK_PLACEHOLDER);
    assert(!text.includes("—"));
  }
  assertStringIncludes(m.email.subject, "SWF-261423 rev 2");
  assertStringIncludes(m.email.text, "$2,381.50 including GST, your 50% share");
  assert(!m.email.text.includes("$4,763.00"));
  assertStringIncludes(m.email.text, "Khairo");
  assert(m.sms.text.length < 320);
});

// ── Delivery gate ───────────────────────────────────────────────────────
const envOf = (e: Record<string, string>) => (n: string) => e[n];
const STAGING = {
  QUOTE_V2_ENVIRONMENT: "staging",
  QUOTE_V2_LIVE_DELIVERY: LIVE_DELIVERY_FLAG_VALUE,
  SUPABASE_URL: "https://stagingref.supabase.co",
  RESEND_API_KEY: "re_test",
};

Deno.test("delivery: live delivery is off unless staging and its flag are both set, never on production", () => {
  assertEquals(liveDeliveryGate(envOf({})).allowed, false);
  assertEquals(
    liveDeliveryGate(envOf({ ...STAGING, QUOTE_V2_LIVE_DELIVERY: "true" }))
      .allowed,
    false,
  );
  assertEquals(
    liveDeliveryGate(envOf({ ...STAGING, QUOTE_V2_ENVIRONMENT: "production" }))
      .allowed,
    false,
  );
  assertEquals(
    liveDeliveryGate(envOf({
      ...STAGING,
      SUPABASE_URL: "https://kevgrhcjxspbxgovpmfl.supabase.co",
    })).allowed,
    false,
  );
  assertEquals(liveDeliveryGate(envOf(STAGING)).allowed, true);
});

Deno.test("delivery: a shut gate never calls a provider; an open one sends once with an idempotency key", async () => {
  const row = {
    id: "0b0e0b3a-54b0-4a4c-9f37-3a1f0c1d2e3f",
    channel: "email" as const,
    to_address: "a@example.test",
    to_name: null,
    subject: "S",
    body_text: "T",
    body_html: "<p>T</p>",
    ghl_contact_id: null,
  };
  const calls: RequestInit[] = [];
  const fakeFetch = ((_: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response(JSON.stringify({ id: "em_1" })));
  }) as unknown as typeof fetch;
  const shut = await deliverLiveRow(row, { env: envOf({}), fetch: fakeFetch });
  assertEquals(shut.outcome, "failed");
  assertEquals(calls.length, 0);
  const open = await deliverLiveRow(row, {
    env: envOf(STAGING),
    fetch: fakeFetch,
  });
  assertEquals(open, { outcome: "delivered", provider_message_id: "em_1" });
  assertEquals(
    (calls[0].headers as Record<string, string>)["Idempotency-Key"],
    `quote-v2:${row.id}`,
  );
  const thrown = await deliverLiveRow(row, {
    env: envOf(STAGING),
    fetch: (() => Promise.reject(new Error("timeout"))) as typeof fetch,
  });
  assertEquals(thrown.outcome, "unknown");
});

// ── Handler: build, stamp, send ─────────────────────────────────────────
interface Call {
  fn: string;
  args: Record<string, unknown>;
}
const REV = "64222f15-ce1d-47ee-9a0d-b8b1f48febb7";
const JOB = "00000000-0000-4000-8000-000000026051";
const PARTY = "e4b95c30-2563-48dd-a7af-0ede45fea0cd";
const PREVIEW = "3a7f4f55-8a51-4a3f-9d0c-3c1a7d4d2b10";
const HASH = "c".repeat(64);

function deps(env: Record<string, string> = {}): QuoteV2Deps & {
  calls: Call[];
  fetched: number;
} {
  const calls: Call[] = [];
  const d = {
    calls,
    fetched: 0,
    env: envOf({
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      QUOTE_V2_PUBLIC_BASE_URL: "https://example.test/functions/v1/quote-v2",
      ...env,
    }),
    userIdentity: (t: string) =>
      Promise.resolve(
        t === "jwt-owner"
          ? {
            role: "owner",
            actor: "marnin@secureworkswa.com.au",
            email: "Marnin@SecureWorksWA.com.au",
          }
          : t === "jwt-scoper"
          ? {
            role: "sales",
            actor: "khairo@secureworkswa.com.au",
            email: "khairo@secureworkswa.com.au",
          }
          : null,
      ),
    fetch: (() => {
      d.fetched++;
      return Promise.reject(new Error("no delivery in tests"));
    }) as unknown as typeof fetch,
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "price_book_current_costs") {
        return Promise.resolve({ data: [POST], error: null });
      }
      if (fn === "quote_v2_party_document") {
        return Promise.resolve({ data: VIEW, error: null });
      }
      if (fn === "quote_v2_execute_send") {
        return Promise.resolve({
          data: { send_id: "s1", adapter: "capture", replay: false },
          error: null,
        });
      }
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  return d;
}
const post = (qs: string, body: unknown, auth: string) =>
  new Request(`https://example.test/functions/v1/quote-v2${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth.startsWith("jwt")
        ? { Authorization: `Bearer ${auth}` }
        : { "x-api-key": auth }),
    },
    body: JSON.stringify(body),
  });

Deno.test("handler build: reads the price book once, then builds in one call as the signed-in scoper", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=build", {
      job_id: JOB,
      ...scope([{
        key: "posts",
        description: "Posts",
        qty: 4,
        price_book: { item_key: POST.item_key },
        markup: { multiplier: 1.25 },
      }]),
      valid_until: "2026-10-24",
    }, "jwt-scoper"),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(d.calls.map((c) => c.fn), [
    "price_book_current_costs",
    "quote_v2_build_draft",
  ]);
  const build = d.calls[1].args;
  assertEquals(build.p_actor, "khairo@secureworkswa.com.au");
  assertEquals(build.p_valid_until, "2026-10-24");
  assertEquals(build.p_markups, [
    { line_key: "posts", multiplier: 1.25, reason: null },
  ]);
});

Deno.test("handler build: a refused scope writes nothing", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=build", {
      job_id: JOB,
      ...scope([{
        key: "x",
        description: "X",
        qty: 1,
        price_book: { item_key: "nope" },
      }]),
    }, "jwt-scoper"),
    d,
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "quote_line_item_unknown");
  assert(!d.calls.some((c) => c.fn === "quote_v2_build_draft"));
});

Deno.test("handler prepare_send: hashes each party's rendered documents and messages, capture by default", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=prepare_send", {
      revision_id: REV,
      from_name: "Khairo",
      parties: [{
        party_id: PARTY,
        recipients: [{ channel: "email", to: "fiona@example.test" }],
      }],
    }, "jwt-scoper"),
    d,
  );
  assertEquals(res.status, 200);
  const prep = d.calls.find((c) => c.fn === "quote_v2_prepare_send")!.args;
  // deno-lint-ignore no-explicit-any
  const send = prep.p_send as any;
  assertEquals(send.adapter, "capture");
  assertEquals(
    send.link_base_url,
    "https://example.test/functions/v1/quote-v2",
  );
  assertEquals(
    send.parties[0].documents.html_sha256,
    await sha256Hex(renderQuoteDocumentHtml(VIEW)),
  );
  assertEquals(
    send.parties[0].documents.pdf_sha256,
    await sha256Hex(await renderQuotePdf(VIEW)),
  );
  assertStringIncludes(
    send.parties[0].messages.email.html,
    QUOTE_LINK_PLACEHOLDER,
  );
  assertEquals(prep.p_prepared_by, "khairo@secureworkswa.com.au");
});

Deno.test("handler prepare_send: live delivery is refused while the staging gate is shut", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=prepare_send", {
      revision_id: REV,
      adapter: "live",
      parties: [{ party_id: PARTY, recipients: [] }],
    }, "jwt-scoper"),
    d,
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "quote_send_live_disabled");
  assertEquals(d.calls.length, 0);
});

Deno.test("handler approve_send: only the owner's own session stamps, by verified email", async () => {
  const body = { preview_id: PREVIEW, preview_hash: HASH };
  for (
    const [auth, extra] of [
      ["jwt-scoper", {}],
      ["service-secret", { acting_for: "marnin" }],
    ] as const
  ) {
    const d = deps();
    const res = await handleQuoteV2Request(
      post("?action=approve_send", { ...body, ...extra }, auth),
      d,
    );
    assertEquals(res.status, 403);
    assertEquals((await res.json()).code, "owner_stamp_required");
    assertEquals(d.calls.length, 0);
  }
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=approve_send", body, "jwt-owner"),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(d.calls[0], {
    fn: "quote_v2_approve_send",
    args: {
      p_preview_id: PREVIEW,
      p_preview_hash: HASH,
      p_approved_by: "marnin@secureworkswa.com.au",
    },
  });
  assertEquals(quoteSendApprovers(undefined), ["marnin@secureworkswa.com.au"]);
  assertEquals(quoteSendApprovers(" A@x.com , a@x.com,b@y.com"), [
    "a@x.com",
    "b@y.com",
  ]);
});

Deno.test("handler send: runs the stamped preview with live delivery off and calls no provider", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post(
      "?action=send",
      { preview_id: PREVIEW, preview_hash: HASH },
      "jwt-scoper",
    ),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(d.calls, [{
    fn: "quote_v2_execute_send",
    args: {
      p_preview_id: PREVIEW,
      p_preview_hash: HASH,
      p_sent_by: "khairo@secureworkswa.com.au",
      p_live_allowed: false,
    },
  }]);
  assertEquals(d.fetched, 0);
  const bad = await handleQuoteV2Request(
    post("?action=send", { preview_id: PREVIEW }, "jwt-scoper"),
    deps(),
  );
  assertEquals(bad.status, 400);
});

Deno.test("handler render: staff get the party's PDF; the party page link serves the same PDF", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    new Request(
      `https://example.test/functions/v1/quote-v2?action=render&revision_id=${REV}&party_id=${PARTY}&format=pdf`,
      { headers: { Authorization: "Bearer jwt-scoper" } },
    ),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/pdf");
  const staffPdf = new Uint8Array(await res.arrayBuffer());
  const token = "b".repeat(64);
  const party = await handleQuoteV2Request(
    new Request(
      `https://example.test/functions/v1/quote-v2?t=${token}&format=pdf`,
    ),
    {
      ...deps(),
      rpc: () =>
        Promise.resolve({
          data: {
            state: "current",
            link_revision_number: 2,
            quote: { ...VIEW, expired: false, accepted_at: null },
          },
          error: null,
        }),
    },
  );
  assertEquals(
    await sha256Hex(new Uint8Array(await party.arrayBuffer())),
    await sha256Hex(staffPdf),
  );
});
