// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleQuoteV2Request, type QuoteV2Deps } from "./handler.ts";
import type { PartyLinkResult, PartyQuoteView } from "./party_page.ts";

const ENV: Record<string, string> = {
  SW_API_KEY: "public-shared-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  OPS_AGENT_SERVER_KEY: "agent-secret",
};
const TOKEN = "a".repeat(64);
const REV = "64222f15-ce1d-47ee-9a0d-b8b1f48febb7";
const HASH = "sha256:" + "2".repeat(64);
const JOB = "00000000-0000-4000-8000-000000261423";

// Gwelup SWF-261423 as quote_v2_party_view returns it for the client: the
// frozen revision shape proved in the SQL contract.
const STEPHEN: PartyQuoteView = {
  revision_id: REV,
  revision_number: 1,
  content_hash: HASH,
  job_number: "SWF-261423",
  site_suburb: "Gwelup",
  family: "fencing",
  scope: {
    title: "Colorbond fence, Woodland Grey 1800 Sameside",
    inclusions: ["22 m fence", "9 retaining plinths"],
    exclusions: ["Root removal: neighbour only, priced separately"],
  },
  valid_until: "2026-10-24",
  issued_on: "2026-09-24",
  expired: false,
  job_total: { ex_gst: 4330, gst: 433, inc_gst: 4763 },
  party: {
    first_name: "Stephen",
    role: "client",
    share: { ex_gst: 2165, gst: 216.5, inc_gst: 2381.5 },
    share_of_job_percent: 50,
  },
  lines: [
    {
      description: "Colorbond fence 1800 Woodland Grey",
      qty: 22,
      unit: "lm",
      line_total_ex_gst: 2750,
      your_share_ex_gst: 1375,
    },
    {
      description: "Retaining plinths",
      qty: 9,
      unit: "each",
      line_total_ex_gst: 720,
      your_share_ex_gst: 360,
    },
    {
      description: "Remove Hardie fence",
      qty: 22,
      unit: "lm",
      line_total_ex_gst: 660,
      your_share_ex_gst: 330,
    },
    {
      description: "Delivery",
      qty: 1,
      unit: "delivery",
      line_total_ex_gst: 200,
      your_share_ex_gst: 100,
    },
  ],
  other_parties: [{
    first_name: "Fiona",
    role: "neighbour",
    share_of_job_percent: 50,
  }],
  accepted_at: null,
};

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function deps(
  over: {
    link?: PartyLinkResult;
    rpcError?: string;
    result?: unknown;
  } = {},
): QuoteV2Deps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    env: (n) => ENV[n],
    nonce: () => "testnonce",
    userIdentity: (token) =>
      Promise.resolve(
        token === "jwt-estimator"
          ? { role: "estimator", actor: "nithin@secureworkswa.com.au" }
          : token === "jwt-trade"
          ? { role: "trade", actor: "trade@example.com" }
          : null,
      ),
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (over.rpcError) {
        return Promise.resolve({
          data: null,
          error: { message: over.rpcError },
        });
      }
      if (fn === "quote_v2_open_party_document") {
        return Promise.resolve({
          data: over.link ??
            { state: "current", link_revision_number: 1, quote: STEPHEN },
          error: null,
        });
      }
      return Promise.resolve({
        data: over.result ??
          {
            state: "accepted",
            accepted_at: "2026-09-24T02:00:00Z",
            job_fully_accepted: true,
          },
        error: null,
      });
    },
  };
}

const BASE = "https://example.test/functions/v1/quote-v2";
const get = (qs: string, headers: Record<string, string> = {}) =>
  new Request(BASE + qs, { headers });
const post = (
  qs: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(BASE + qs, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

Deno.test("party page: shows only the party's own quote, with the job total and their split", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(get(`?t=${TOKEN}`), d);
  const html = await res.text();
  assertEquals(res.status, 200);
  assertEquals(d.calls, [{
    fn: "quote_v2_open_party_document",
    args: { p_token: TOKEN },
  }]);
  assertStringIncludes(html, '<div class="who">Stephen</div>');
  assertStringIncludes(html, "You pay 50%; Fiona pays 50%");
  assertStringIncludes(html, "$4,763.00");
  assertStringIncludes(html, "$2,381.50");
  assertStringIncludes(html, `data-revision="${REV}"`);
  assertStringIncludes(html, `data-hash="${HASH}"`);
  assert(!html.includes(TOKEN), "the token is never written into the page");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertStringIncludes(
    res.headers.get("Content-Security-Policy")!,
    "script-src 'nonce-testnonce'",
  );
  assertStringIncludes(html, '<script nonce="testnonce">');
});

Deno.test("party page: a single-party quote shows amounts without a split", async () => {
  const solo = {
    ...STEPHEN,
    other_parties: [],
    party: {
      ...STEPHEN.party,
      share: STEPHEN.job_total,
      share_of_job_percent: 100,
    },
  };
  const res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({ link: { state: "current", link_revision_number: 1, quote: solo } }),
  );
  const html = await res.text();
  assert(!html.includes("This work is shared"));
  assert(!html.includes("Your share"));
});

Deno.test("party page: text from the record is escaped", async () => {
  const hostile = {
    ...STEPHEN,
    scope: { title: "<script>alert(1)</script>" },
    lines: [{
      ...STEPHEN.lines[0],
      description: '"><img src=x onerror=alert(1)>',
    }],
    other_parties: [{
      first_name: "<b>Fi</b>",
      role: "neighbour" as const,
      share_of_job_percent: 50,
    }],
  };
  const res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({
      link: { state: "current", link_revision_number: 1, quote: hostile },
    }),
  );
  const html = await res.text();
  assert(!html.includes("<script>alert"));
  assert(!html.includes("<img src=x"));
  assert(!html.includes("<b>Fi</b>"));
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

Deno.test("party page: a replaced revision's link shows the same party's current revision", async () => {
  const res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({
      link: {
        state: "forwarded",
        link_revision_number: 1,
        quote: { ...STEPHEN, revision_number: 2 },
      },
    }),
  );
  const html = await res.text();
  assertEquals(res.status, 200);
  assertStringIncludes(html, "This quote was updated");
  assertStringIncludes(html, "revision 2");
  assertStringIncludes(html, '<div class="who">Stephen</div>');
});

Deno.test("party page: no current quote, revoked and malformed links show nothing of the job", async () => {
  let d = deps({
    link: { state: "no_current_quote", link_revision_number: 1, quote: null },
  });
  let res = await handleQuoteV2Request(get(`?t=${TOKEN}`), d);
  let html = await res.text();
  assertEquals(res.status, 200);
  assertStringIncludes(html, "no current quote");
  assert(!html.includes("SWF-261423"));

  res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({
      link: { state: "revoked", link_revision_number: null, quote: null },
    }),
  );
  assertEquals(res.status, 404);
  assertStringIncludes(await res.text(), "no longer valid");

  d = deps();
  res = await handleQuoteV2Request(get("?t=../../etc"), d);
  html = await res.text();
  assertEquals(res.status, 404);
  assertEquals(
    d.calls.length,
    0,
    "a malformed token never reaches the database",
  );
});

Deno.test("party page: accepted and expired quotes show no Accept button", async () => {
  let res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({
      link: {
        state: "current",
        link_revision_number: 1,
        quote: { ...STEPHEN, accepted_at: "2026-09-24T02:00:00Z" },
      },
    }),
  );
  let html = await res.text();
  assertStringIncludes(html, "Accepted");
  assert(!html.includes('id="accept"'));
  res = await handleQuoteV2Request(
    get(`?t=${TOKEN}`),
    deps({
      link: {
        state: "current",
        link_revision_number: 1,
        quote: { ...STEPHEN, expired: true },
      },
    }),
  );
  html = await res.text();
  assertStringIncludes(html, "was valid until");
  assert(!html.includes('id="accept"'));
});

Deno.test("accept: echoes the revision and content shown; never tells a party whether the job is accepted", async () => {
  const d = deps();
  const res = await handleQuoteV2Request(
    post("?action=accept", {
      t: TOKEN,
      revision_id: REV,
      content_hash: HASH,
      accepted_name: "Stephen",
    }),
    d,
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(d.calls[0], {
    fn: "quote_v2_accept",
    args: {
      p_token: TOKEN,
      p_revision_id: REV,
      p_content_hash: HASH,
      p_accepted_name: "Stephen",
    },
  });
  assertEquals(body, {
    ok: true,
    state: "accepted",
    accepted_at: "2026-09-24T02:00:00Z",
  });
});

Deno.test("accept: refusals are plain words; unknown failures leak nothing", async () => {
  let res = await handleQuoteV2Request(
    post("?action=accept", { t: TOKEN, revision_id: REV, content_hash: HASH }),
    deps({
      rpcError:
        "quote_revision_not_current: this quote was updated; open the link again",
    }),
  );
  let body = await res.json();
  assertEquals(res.status, 409);
  assertEquals(body.code, "quote_revision_not_current");
  assertStringIncludes(body.error, "reopen your link");

  res = await handleQuoteV2Request(
    post("?action=accept", { t: TOKEN, revision_id: REV, content_hash: HASH }),
    deps({ rpcError: "quote_expired: this quote was valid until 2026-09-01" }),
  );
  assertEquals(res.status, 410);

  res = await handleQuoteV2Request(
    post("?action=accept", { t: TOKEN, revision_id: REV, content_hash: HASH }),
    deps({
      rpcError: 'relation "public.quote_v2_acceptances" permission denied',
    }),
  );
  body = await res.json();
  assertEquals(res.status, 502);
  assert(!JSON.stringify(body).includes("quote_v2_acceptances"));

  const d = deps();
  res = await handleQuoteV2Request(
    post("?action=accept", {
      t: "short",
      revision_id: REV,
      content_hash: HASH,
    }),
    d,
  );
  assertEquals(res.status, 404);
  res = await handleQuoteV2Request(
    post("?action=accept", { t: TOKEN, revision_id: "x", content_hash: HASH }),
    d,
  );
  assertEquals(res.status, 400);
  assertEquals(d.calls.length, 0);
});

Deno.test("staff: no session, the public key, a forged JWT claim and a trade are all refused", async () => {
  const forged = [
    btoa(JSON.stringify({ alg: "none" })),
    btoa(JSON.stringify({ role: "service_role" })),
    "",
  ].join(".");
  const cases: [Record<string, string>, number][] = [
    [{}, 401],
    [{ Authorization: "Bearer public-shared-key" }, 401],
    [{ Authorization: `Bearer ${forged}` }, 401],
    [{ Authorization: "Bearer jwt-trade" }, 403],
  ];
  for (const [headers, status] of cases) {
    const d = deps();
    const res = await handleQuoteV2Request(
      post(
        "?action=freeze",
        { revision_id: REV, valid_until: "2026-10-24" },
        headers,
      ),
      d,
    );
    assertEquals(res.status, status, JSON.stringify(headers));
    assertEquals(d.calls.length, 0);
  }
});

Deno.test("staff: the actor is the signed-in user, never the body", async () => {
  const d = deps({ result: "rev-id" });
  const res = await handleQuoteV2Request(
    post("?action=create_draft", {
      job_id: JOB,
      payload: { family: "fencing" },
      acting_for: "someone-else",
    }, {
      Authorization: "Bearer jwt-estimator",
    }),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(d.calls[0], {
    fn: "quote_v2_create_draft",
    args: {
      p_job_id: JOB,
      p_payload: { family: "fencing" },
      p_prepared_by: "nithin@secureworkswa.com.au",
    },
  });
});

Deno.test("staff: a server caller must name who it acts for", async () => {
  let d = deps();
  let res = await handleQuoteV2Request(
    post("?action=set_line_markup", {
      revision_id: REV,
      line_key: "beam",
      multiplier: 1.5,
    }, { "x-api-key": "agent-secret" }),
    d,
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, "acting_for_required");
  d = deps();
  res = await handleQuoteV2Request(
    post("?action=set_line_markup", {
      revision_id: REV,
      line_key: "beam",
      multiplier: 1.5,
      acting_for: "marnin",
    }, {
      "x-api-key": "agent-secret",
    }),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(d.calls[0].args.p_set_by, "marnin (via server)");
  assertEquals(d.calls[0].args.p_multiplier, 1.5);
});

Deno.test("staff: a refusal from the quote rules is a 409 with its code", async () => {
  const res = await handleQuoteV2Request(
    post("?action=freeze", { revision_id: REV, valid_until: "2026-10-24" }, {
      Authorization: "Bearer jwt-estimator",
    }),
    deps({
      rpcError:
        "quote_line_duplicate: gutter-beam-extra repeats an earlier line",
    }),
  );
  const body = await res.json();
  assertEquals(res.status, 409);
  assertEquals(body.code, "quote_line_duplicate");
});

Deno.test("staff: reads and link actions route to their functions", async () => {
  const headers = { Authorization: "Bearer jwt-estimator" };
  const d = deps();
  await handleQuoteV2Request(
    get(`?action=revision&revision_id=${REV}`, headers),
    d,
  );
  await handleQuoteV2Request(
    get(`?action=job_acceptance&job_id=${JOB}`, headers),
    d,
  );
  await handleQuoteV2Request(
    post("?action=issue_link", { revision_id: REV, party_id: JOB }, headers),
    d,
  );
  await handleQuoteV2Request(
    post(
      "?action=revoke_link",
      { link_id: REV, reason: "wrong address" },
      headers,
    ),
    d,
  );
  assertEquals(d.calls.map((c) => c.fn), [
    "quote_v2_staff_revision",
    "quote_v2_job_acceptance",
    "quote_v2_issue_party_link",
    "quote_v2_revoke_party_link",
  ]);
  const res = await handleQuoteV2Request(
    post("?action=delete_quote", {}, headers),
    deps(),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, "action_unknown");
});
