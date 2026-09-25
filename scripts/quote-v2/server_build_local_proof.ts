// Quote v2 stage 3 local proof: drive the REAL quote-v2 handler against a
// DISPOSABLE LOCAL database prepared by test-server-build-local.sh. Builds the
// three real jobs (and a price book test job) from scope, renders every
// party's HTML and PDF, stamps and sends to the CAPTURE outbox, and times the
// Gwelup two-party quote end to end. Nothing is delivered: no live adapter is
// enabled and the database URL must be localhost.
//
//   deno run --allow-net=127.0.0.1,localhost,esm.sh,jsr.io --allow-env \
//     --allow-read --allow-write scripts/quote-v2/server_build_local_proof.ts \
//     --db-url <url> --out <dir>

// deno-lint-ignore no-import-prefix
import { Client } from "jsr:@db/postgres@0.19.5";
import {
  handleQuoteV2Request,
  type QuoteV2Deps,
} from "../../supabase/functions/quote-v2/handler.ts";
import { sha256Hex } from "../../supabase/functions/quote-v2/quote_document.ts";
import {
  GWELUP,
  GWELUP_JOB,
  KIKO,
  KIKO_JOB,
  PB_DEMO,
  PB_DEMO_JOB,
  SWP_26051,
  SWP_JOB,
} from "./server_build_scopes.ts";
import type { ScopeInput } from "../../supabase/functions/quote-v2/scope_build.ts";

function arg(name: string): string {
  const i = Deno.args.indexOf(name);
  if (i < 0 || !Deno.args[i + 1]) throw new Error(`missing ${name}`);
  return Deno.args[i + 1];
}
const DB_URL = arg("--db-url");
const OUT = arg("--out");
if (
  !/^postgres(ql)?:\/\/([^/?#@]+@)?(127\.0\.0\.1|localhost)(:[0-9]+)?\/[^/?#]+$/
    .test(DB_URL)
) {
  throw new Error("--db-url must be a localhost database");
}

const client = new Client(DB_URL);
await client.connect();

// One connection, the same RPC shape PostgREST gives the edge function.
const TABLE_SETS = new Set(["price_book_current_costs"]);
const SCALAR_SETS = new Set(["quote_v2_live_outbox_pending"]);
async function rpc(fn: string, args: Record<string, unknown>) {
  const params: unknown[] = [];
  const parts = Object.entries(args).map(([k, v], i) => {
    let cast = "";
    if (v === null || v === undefined) params.push(null);
    else if (
      Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
    ) {
      params.push(v);
      cast = "::text[]";
    } else if (typeof v === "object") {
      params.push(JSON.stringify(v));
      cast = "::jsonb";
    } else if (typeof v === "boolean") {
      params.push(v);
      cast = "::boolean";
    } else if (typeof v === "number") {
      params.push(v);
      cast = Number.isInteger(v) ? "::integer" : "::numeric";
    } else params.push(v);
    return `${k} => $${i + 1}${cast}`;
  });
  const call = `public.${fn}(${parts.join(", ")})`;
  const text = TABLE_SETS.has(fn)
    ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as v from ${call} x`
    : SCALAR_SETS.has(fn)
    ? `select coalesce(jsonb_agg(x.v), '[]'::jsonb) as v from ${call} as x(v)`
    : `select to_jsonb(${call}) as v`;
  try {
    const r = await client.queryObject<{ v: unknown }>({ text, args: params });
    return { data: r.rows[0]?.v ?? null, error: null };
  } catch (e) {
    const err = e as { fields?: { message?: string }; message: string };
    if (Deno.env.get("QUOTE_PROOF_DEBUG")) console.error(fn, err.message);
    return {
      data: null,
      error: { message: err.fields?.message ?? err.message },
    };
  }
}

const OWNER = "marnin@secureworkswa.com.au";
const SCOPER = "khairo@secureworkswa.com.au";
const ENV: Record<string, string> = {
  SUPABASE_SERVICE_ROLE_KEY: "local-service-secret",
  QUOTE_V2_PUBLIC_BASE_URL: "http://localhost/functions/v1/quote-v2",
};
let fetchCalls = 0;
const deps: QuoteV2Deps = {
  env: (n) => ENV[n],
  nonce: () => "proofnonce",
  userIdentity: (t) =>
    Promise.resolve(
      t === "jwt-owner"
        ? { role: "owner", actor: OWNER, email: OWNER }
        : t === "jwt-khairo"
        ? { role: "sales", actor: SCOPER, email: SCOPER }
        : null,
    ),
  rpc,
  fetch: () => {
    fetchCalls++;
    throw new Error("the proof never delivers");
  },
};

const BASE = "http://localhost/functions/v1/quote-v2";
const AS = (
  who: "jwt-owner" | "jwt-khairo" | "server",
): Record<string, string> =>
  who === "server"
    ? { "x-api-key": "local-service-secret" }
    : { Authorization: `Bearer ${who}` };
async function call(
  method: "GET" | "POST",
  qs: string,
  who: "jwt-owner" | "jwt-khairo" | "server",
  body?: unknown,
) {
  const res = await handleQuoteV2Request(
    new Request(BASE + qs, {
      method,
      headers: { "Content-Type": "application/json", ...AS(who) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  );
  return res;
}
// deno-lint-ignore no-explicit-any
async function jsonCall(...a: Parameters<typeof call>): Promise<any> {
  const res = await call(...a);
  const body = await res.json();
  return { status: res.status, ...body };
}

const results: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail: unknown = null) {
  results[name] = ok ? "pass" : { fail: detail };
  if (!ok) console.error(`FAIL ${name}`, JSON.stringify(detail ?? ""));
}
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;

await Deno.mkdir(OUT, { recursive: true });
const validUntil = (() => {
  const d = new Date(Date.now() + 30 * 86400_000);
  return d.toISOString().slice(0, 10);
})();

// Fake but well-formed recipients: nothing is delivered in capture mode.
const RECIPIENTS: Record<string, { channel: string; to: string }[]> = {
  Stephen: [
    { channel: "email", to: "stephen.gwelup@example.test" },
    { channel: "sms", to: "+61400000001" },
  ],
  Fiona: [{ channel: "email", to: "fiona.gwelup@example.test" }],
  Margaret: [{ channel: "email", to: "margaret.canningvale@example.test" }],
  Kiko: [
    { channel: "email", to: "kiko.balcatta@example.test" },
    { channel: "sms", to: "+61400000002" },
  ],
  Test: [{ channel: "email", to: "test@example.test" }],
};

interface Flow {
  revision: {
    revision_id: string;
    revision_number: number;
    freeze: Record<string, unknown>;
  };
  parties: { party_id: string; display_name: string }[];
  preview: {
    preview_id: string;
    preview_hash: string;
    preview: Record<string, unknown>;
  };
  send: Record<string, unknown>;
  timings: Record<string, number>;
  cuts: unknown;
}

async function buildAndSend(
  jobId: string,
  scope: ScopeInput,
  label: string,
): Promise<Flow> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let t = performance.now();
  // The three real quotes carry the owner's stated sells, so the owner's own
  // session builds them; a scoper sending one is refused below.
  const built = await jsonCall("POST", "?action=build", "jwt-owner", {
    job_id: jobId,
    ...scope,
    valid_until: validUntil,
  });
  timings.build_and_freeze_ms = ms(t);
  if (built.status !== 200) {
    throw new Error(`${label} build: ${JSON.stringify(built)}`);
  }
  const rev = built.result;
  const staff = await rpc("quote_v2_staff_revision", {
    p_revision_id: rev.revision_id,
  });
  // deno-lint-ignore no-explicit-any
  const parties = ((staff.data as any).parties as any[]).filter((p) =>
    Number(p.share_inc_gst) > 0
  );
  t = performance.now();
  const prepared = await jsonCall(
    "POST",
    "?action=prepare_send",
    "jwt-khairo",
    {
      revision_id: rev.revision_id,
      from_name: "Khairo",
      parties: parties.map((p) => ({
        party_id: p.party_id,
        recipients: RECIPIENTS[p.display_name],
      })),
    },
  );
  timings.render_and_preview_ms = ms(t);
  if (prepared.status !== 200) {
    throw new Error(`${label} prepare: ${JSON.stringify(prepared)}`);
  }
  const preview = prepared.result;
  t = performance.now();
  const stamp = await jsonCall("POST", "?action=approve_send", "jwt-owner", {
    preview_id: preview.preview_id,
    preview_hash: preview.preview_hash,
  });
  timings.owner_stamp_ms = ms(t);
  if (stamp.status !== 200) {
    throw new Error(`${label} stamp: ${JSON.stringify(stamp)}`);
  }
  t = performance.now();
  const sent = await jsonCall("POST", "?action=send", "jwt-khairo", {
    preview_id: preview.preview_id,
    preview_hash: preview.preview_hash,
  });
  timings.send_to_outbox_ms = ms(t);
  if (sent.status !== 200) {
    throw new Error(`${label} send: ${JSON.stringify(sent)}`);
  }
  timings.total_ms = ms(t0);
  timings.total_without_owner_stamp_ms = Math.round(
    (timings.total_ms - timings.owner_stamp_ms) * 10,
  ) / 10;
  return {
    revision: rev,
    parties,
    preview,
    send: sent.result,
    timings,
    cuts: built.cuts,
  };
}

async function saveSamples(prefix: string, flow: Flow) {
  for (const p of flow.parties) {
    const who = String(p.display_name).toLowerCase();
    const qs =
      `?action=render&revision_id=${flow.revision.revision_id}&party_id=${p.party_id}`;
    const html = await (await call("GET", `${qs}&format=html`, "jwt-khairo"))
      .text();
    const pdf = new Uint8Array(
      await (await call("GET", `${qs}&format=pdf`, "jwt-khairo")).arrayBuffer(),
    );
    await Deno.writeTextFile(`${OUT}/${prefix}-${who}-quote.html`, html);
    await Deno.writeFile(`${OUT}/${prefix}-${who}-quote.pdf`, pdf);
    // deno-lint-ignore no-explicit-any
    const pp = (flow.preview.preview.parties as any[]).find((x) =>
      x.party_id === p.party_id
    );
    check(
      `${prefix}: ${p.display_name}'s stamped document hashes match what the server renders`,
      pp?.documents?.html_sha256 === await sha256Hex(html) &&
        pp?.documents?.pdf_sha256 === await sha256Hex(pdf),
    );
  }
  const outbox = await client.queryObject<Record<string, string>>(
    `select o.channel, o.to_address, o.subject, o.body_text, o.body_html, rp.display_name
     from quote_v2_outbox o join quote_v2_revision_parties rp
       on rp.party_id = o.party_id and rp.revision_id = $1
     where o.send_id = $2 order by rp.ordinal, o.channel`,
    [flow.revision.revision_id, flow.send.send_id],
  );
  for (const o of outbox.rows) {
    const who = o.display_name.toLowerCase();
    // The captured link is a local test token; the saved copies show where
    // it goes without carrying a usable token.
    const redact = (s: string | null) =>
      (s ?? "").replace(/\?t=[0-9a-f]{64}/g, "?t=<link issued at send>");
    if (o.channel === "email") {
      await Deno.writeTextFile(
        `${OUT}/${prefix}-${who}-email.html`,
        redact(o.body_html),
      );
    } else {
      await Deno.writeTextFile(
        `${OUT}/${prefix}-${who}-sms.txt`,
        redact(o.body_text) + "\n",
      );
    }
  }
  const safePreview = JSON.parse(
    JSON.stringify(flow.preview.preview),
  );
  await Deno.writeTextFile(
    `${OUT}/${prefix}-send-preview.json`,
    JSON.stringify(
      { preview_hash: flow.preview.preview_hash, preview: safePreview },
      null,
      2,
    ),
  );
}

// ── Gwelup: cold run, then a warm run of the same scope ────────────────
const gwCold = await buildAndSend(GWELUP_JOB, GWELUP, "gwelup cold");
// The revised quote goes to the SAME two people: the tool names their party
// ids, so their old links forward to it.
const partyIdOf = (name: string) =>
  gwCold.parties.find((p) => p.display_name === name)!.party_id;
const gw = await buildAndSend(GWELUP_JOB, {
  ...GWELUP,
  parties: [
    {
      ref: "c",
      party_id: partyIdOf("Stephen"),
      share_rule: "equal",
      share_bp: 5000,
    },
    {
      ref: "n",
      party_id: partyIdOf("Fiona"),
      share_rule: "equal",
      share_bp: 5000,
    },
  ],
}, "gwelup warm");
// deno-lint-ignore no-explicit-any
const gwFreeze = gw.revision.freeze as any;
check(
  "gwelup: built from scope, $4,763.00 inc, $2,381.50 each",
  Number(gwFreeze.job_total_inc_gst) === 4763 &&
    // deno-lint-ignore no-explicit-any
    gwFreeze.parties.every((p: any) => Number(p.share_inc_gst) === 2381.5),
  gwFreeze,
);
check(
  "gwelup: the send wrote one email to Stephen, one SMS to Stephen and one email to Fiona, all captured",
  // deno-lint-ignore no-explicit-any
  (gw.send.messages as any[]).length === 3 &&
    // deno-lint-ignore no-explicit-any
    (gw.send.messages as any[]).every((m) => m.delivery === "captured"),
  gw.send,
);

// A retry of the same stamped send writes nothing and issues no new link.
const countRows = async () =>
  (await client.queryObject<{ o: bigint; l: bigint }>(
    `select (select count(*) from quote_v2_outbox) as o, (select count(*) from quote_v2_party_links) as l`,
  )).rows[0];
const before = await countRows();
const again = await jsonCall("POST", "?action=send", "jwt-khairo", {
  preview_id: gw.preview.preview_id,
  preview_hash: gw.preview.preview_hash,
});
const after = await countRows();
check(
  "retry: a second send of the same stamp returns the same send and writes nothing",
  again.status === 200 && again.result.replay === true &&
    again.result.send_id === gw.send.send_id &&
    before.o === after.o && before.l === after.l,
  { again, before, after },
);

// The captured link opens the branded quote and the stamped PDF.
const stephenBody = (await client.queryObject<{ body_text: string }>(
  `select o.body_text from quote_v2_outbox o join quote_v2_revision_parties rp
     on rp.party_id = o.party_id and rp.revision_id = $1
   where o.send_id = $2 and rp.display_name = 'Stephen' and o.channel = 'email'`,
  [gw.revision.revision_id, gw.send.send_id],
)).rows[0].body_text;
const token = /\?t=([0-9a-f]{64})/.exec(stephenBody)?.[1] ?? "";
const page = await handleQuoteV2Request(
  new Request(`${BASE}?t=${token}`),
  deps,
);
const pageHtml = await page.text();
check(
  "the link in Stephen's captured email opens Stephen's branded quote, not Fiona's",
  page.status === 200 && pageHtml.includes('<div class="who">Stephen</div>') &&
    !pageHtml.includes('<div class="who">Fiona</div>') &&
    pageHtml.includes("$2,381.50") && pageHtml.includes('id="accept"'),
);
const pagePdf = new Uint8Array(
  await (await handleQuoteV2Request(
    new Request(`${BASE}?t=${token}&format=pdf`),
    deps,
  )).arrayBuffer(),
);
// deno-lint-ignore no-explicit-any
const stephenStamped = (gw.preview.preview.parties as any[]).find((p) =>
  p.display_name === "Stephen"
);
check(
  "the PDF behind Stephen's link is byte for byte the PDF the owner stamped",
  stephenStamped.documents.pdf_sha256 === await sha256Hex(pagePdf),
);
const oldToken = /\?t=([0-9a-f]{64})/.exec(
  (await client.queryObject<{ body_text: string }>(
    `select o.body_text from quote_v2_outbox o join quote_v2_revision_parties rp
       on rp.party_id = o.party_id and rp.revision_id = $1
     where o.send_id = $2 and rp.display_name = 'Stephen' and o.channel = 'email'`,
    [gwCold.revision.revision_id, gwCold.send.send_id],
  )).rows[0].body_text,
)?.[1] ?? "";
const oldPage = await (await handleQuoteV2Request(
  new Request(`${BASE}?t=${oldToken}`),
  deps,
)).text();
check(
  "the first send's link forwards Stephen to his current revision",
  oldPage.includes("This quote was updated") &&
    oldPage.includes('<div class="who">Stephen</div>'),
);

// ── The stamp and the gates ─────────────────────────────────────────────
const swp = await buildAndSend(SWP_JOB, SWP_26051, "swp-26051");
// deno-lint-ignore no-explicit-any
const swpFreeze = swp.revision.freeze as any;
check(
  "SWP-26051: $29,631.23 inc from scope",
  Number(swpFreeze.job_total_inc_gst) === 29631.23,
  swpFreeze,
);
const kiko = await buildAndSend(KIKO_JOB, KIKO, "kiko");
// deno-lint-ignore no-explicit-any
const kikoFreeze = kiko.revision.freeze as any;
check(
  "Kiko: $5,786.00 inc from scope (Stratco cost x 1.4, owner's rounding)",
  Number(kikoFreeze.job_total_inc_gst) === 5786,
  kikoFreeze,
);

// Price book path: cut to order, per-length cost, the scoper's markup.
const pb1 = await jsonCall("POST", "?action=build", "jwt-khairo", {
  job_id: PB_DEMO_JOB,
  ...PB_DEMO,
  valid_until: validUntil,
});
const pbStaff = (await rpc("quote_v2_staff_revision", {
  p_revision_id: pb1.result?.revision_id,
  // deno-lint-ignore no-explicit-any
})).data as any;
// deno-lint-ignore no-explicit-any
const pbLines = (pbStaff?.lines ?? []) as any[];
const line = (k: string) => pbLines.find((l) => l.line_key === k);
check(
  "price book: 6.0 m of beam buys one 6.5 m length and 4.8 m buys 5.5 m, each at its own length price",
  line("beams@6500")?.qty == 1 &&
    Number(line("beams@6500")?.unit_cost_ex_gst) === 172.73 &&
    line("beams@5500")?.qty == 2 &&
    Number(line("beams@5500")?.unit_cost_ex_gst) === 159,
  pbLines.map((l) => [l.line_key, l.qty, l.unit_cost_ex_gst]),
);
check(
  "price book: the beams carry Khairo's markup x1.30 with his name; the posts carry the patio default",
  line("beams@6500")?.markup_source === "line_override" &&
    Number(line("beams@6500")?.markup_multiplier) === 1.3 &&
    line("beams@6500")?.markup_set_by === SCOPER &&
    line("posts")?.markup_source === "family_default",
  pbLines.map((
    l,
  ) => [l.line_key, l.markup_source, l.markup_multiplier, l.markup_set_by]),
);
results.price_book_lines = pbLines.map((l) => ({
  line: l.line_key,
  qty: Number(l.qty),
  unit: l.unit,
  unit_cost: Number(l.unit_cost_ex_gst),
  sell: Number(l.line_sell_ex_gst),
  source: l.price_source,
}));
results.price_book_cut = pb1.cuts;

// A preview whose quote then changes cannot be stamped or sent.
const pbParty = pbStaff.parties[0].party_id;
const stale = await jsonCall("POST", "?action=prepare_send", "jwt-khairo", {
  revision_id: pb1.result.revision_id,
  parties: [{ party_id: pbParty, recipients: RECIPIENTS.Test }],
});
await jsonCall("POST", "?action=build", "jwt-khairo", {
  job_id: PB_DEMO_JOB,
  ...PB_DEMO,
  valid_until: validUntil,
});
const staleStamp = await jsonCall("POST", "?action=approve_send", "jwt-owner", {
  preview_id: stale.result.preview_id,
  preview_hash: stale.result.preview_hash,
});
check(
  "a preview of a quote that has since changed cannot be stamped",
  staleStamp.status === 409 &&
    staleStamp.code === "quote_send_revision_changed",
  staleStamp,
);

const kikoRev = kiko.revision.revision_id;
const kikoParty = kiko.parties[0].party_id;
const fresh = await jsonCall("POST", "?action=prepare_send", "jwt-khairo", {
  revision_id: kikoRev,
  parties: [{ party_id: kikoParty, recipients: RECIPIENTS.Kiko }],
});
const byScoper = await jsonCall("POST", "?action=approve_send", "jwt-khairo", {
  preview_id: fresh.result.preview_id,
  preview_hash: fresh.result.preview_hash,
});
const byServer = await jsonCall("POST", "?action=approve_send", "server", {
  acting_for: "marnin",
  preview_id: fresh.result.preview_id,
  preview_hash: fresh.result.preview_hash,
});
check(
  "only the owner's own session can stamp: a scoper and a server key are refused",
  byScoper.status === 403 && byScoper.code === "owner_stamp_required" &&
    byServer.status === 403 && byServer.code === "owner_stamp_required",
  { byScoper, byServer },
);
const wrongHash = await jsonCall("POST", "?action=approve_send", "jwt-owner", {
  preview_id: fresh.result.preview_id,
  preview_hash: "0".repeat(64),
});
check(
  "a stamp that does not echo the preview hash is refused",
  wrongHash.status === 409 && wrongHash.code === "quote_send_hash_mismatch",
  wrongHash,
);
const unstamped = await jsonCall("POST", "?action=send", "jwt-khairo", {
  preview_id: fresh.result.preview_id,
  preview_hash: fresh.result.preview_hash,
});
check(
  "an unstamped preview does not send",
  unstamped.status === 409 && unstamped.code === "quote_send_not_approved",
  unstamped,
);
const forged = await jsonCall("POST", "?action=build", "jwt-khairo", {
  job_id: GWELUP_JOB,
  ...GWELUP,
  valid_until: validUntil,
});
check(
  "a scoper cannot send the owner's stated sells",
  forged.status === 403 && forged.code === "quote_sell_owner_only",
  forged,
);
const gwLines = ((await rpc("quote_v2_staff_revision", {
  p_revision_id: gw.revision.revision_id,
  // deno-lint-ignore no-explicit-any
})).data as any).lines as any[];
check(
  "the owner's stated sells are recorded as the owner's verified session",
  gwLines.every((l) => l.sell_basis !== "stated" || l.sell_stated_by === OWNER),
  gwLines.map((l) => [l.line_key, l.sell_basis, l.sell_stated_by]),
);
const kikoLines = ((await rpc("quote_v2_staff_revision", {
  p_revision_id: kiko.revision.revision_id,
  // deno-lint-ignore no-explicit-any
})).data as any).lines as any[];
check(
  "a stated cost is recorded as the caller who stated it, with its evidence",
  kikoLines.filter((l) => l.cost_source === "stated").length === 4 &&
    kikoLines.every((l) =>
      l.cost_source !== "stated" ||
      (l.cost_stated_by === OWNER && !!l.cost_evidence)
    ),
  kikoLines.map((l) => [l.line_key, l.cost_source, l.cost_stated_by]),
);
const linkBody = {
  revision_id: gw.revision.revision_id,
  party_id: gw.parties[0].party_id,
  preview_hash: gw.preview.preview_hash,
};
const scoperLink = await jsonCall(
  "POST",
  "?action=issue_link",
  "jwt-khairo",
  linkBody,
);
const ownerLink = await jsonCall(
  "POST",
  "?action=issue_link",
  "jwt-owner",
  linkBody,
);
const unstampedLink = await jsonCall(
  "POST",
  "?action=issue_link",
  "jwt-owner",
  {
    ...linkBody,
    preview_hash: "0".repeat(64),
  },
);
check(
  "a hand-issued link is the owner's, for a party a stamped send covers",
  scoperLink.status === 403 && ownerLink.status === 200 &&
    unstampedLink.status === 409 &&
    unstampedLink.code === "quote_link_not_approved",
  { scoperLink, ownerLink: ownerLink.status, unstampedLink },
);
const live = await jsonCall("POST", "?action=prepare_send", "jwt-khairo", {
  revision_id: kikoRev,
  adapter: "live",
  parties: [{ party_id: kikoParty, recipients: RECIPIENTS.Kiko }],
});
check(
  "live delivery is refused here: sends are captured only",
  live.status === 409 && live.code === "quote_send_live_disabled",
  live,
);
const captured = await rpc("quote_v2_record_delivery", {
  p_outbox_id: (kiko.send.messages as { outbox_id: string }[])[0].outbox_id,
  p_outcome: "delivered",
});
check(
  "the database refuses to mark a captured message delivered",
  /quote_outbox_capture_never_delivers/.test(captured.error?.message ?? ""),
  captured,
);
check("nothing called a delivery provider", fetchCalls === 0, fetchCalls);

await saveSamples("gwelup-swf-261423", gw);
await saveSamples("canning-vale-swp-26051", swp);
await saveSamples("kiko-balcatta", kiko);

results.timings = {
  gwelup_two_party_cold: gwCold.timings,
  gwelup_two_party_warm: gw.timings,
  swp_26051: swp.timings,
  kiko: kiko.timings,
};
results.preview_hashes = {
  gwelup: gw.preview.preview_hash,
  swp_26051: swp.preview.preview_hash,
  kiko: kiko.preview.preview_hash,
};
await Deno.writeTextFile(
  `${OUT}/proof-results.json`,
  JSON.stringify(results, null, 2),
);
await client.end();
console.log(JSON.stringify(results, null, 2));
if (
  Object.values(results).some((v) => typeof v === "object" && v && "fail" in v)
) Deno.exit(1);
