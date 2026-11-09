// deno-lint-ignore-file no-explicit-any no-import-prefix
// Quick Quote, end to end from the function entry to the email provider, on a
// saved revision whose price the owner approved: only a PDF the owner's
// decision covers is attached, as those bytes. The real handler source runs
// with the real named-revision read, owner price gate and PDF check; the
// database, the PDF host and the provider are in-memory fakes, so nothing
// leaves the process. Generated identifiers and synthetic figures only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import {
  quoteSendBuildSource,
  sealedSendSource,
  startNamedScopeRevisionRead,
} from "../_shared/scope_freeze/quote_scope_revision_link.ts";
import {
  approvedQuotePdf,
  ownerPriceBeforeSend,
  quotePdfBase64,
  unapprovedSendKeyForQuickQuote,
} from "../_shared/scope_freeze/owner_price_approval.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const marker = "async function sendQuickQuoteEmail(client: any, body: any) {";
const start = source.indexOf(marker) + marker.length;
const stop = source.indexOf("  const resendResult = await resendResp.json()", start);
assert(start > marker.length && stop > start, "Quick Quote handler found");
// The production body up to and including the provider call, with only its
// type annotations removed. Post-send persistence is outside this test.
const handlerBody = source.slice(start, stop)
  .replaceAll(" as any", "").replaceAll(": any", "").replaceAll("e as Error", "e") +
  "return resendResp;";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const handler = new AsyncFunction(
  "client", "body",
  "startNamedScopeRevisionRead", "sealedSendSource", "quoteSendBuildSource",
  "ownerPriceBeforeSend", "unapprovedSendKeyForQuickQuote", "approvedQuotePdf", "quotePdfBase64",
  "assertLegacySesMoneyActionAllowedForJob", "Deno", "ApiError", "getClientReplyTo", "fetch",
  handlerBody,
);

class ApiError extends Error {
  constructor(message: string, public status: number, public detail: any) {
    super(message);
  }
}

function syntheticPdf(line: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`%PDF-1.4\n% ${line}\n%%EOF\n`);
}
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PDF_A = syntheticPdf("Approved A: total AUD 110 inc GST");
const PDF_B = syntheticPdf("Unapproved B: total AUD 220 inc GST");
const URL_A = "https://fixture.invalid/approved-A.pdf";
const URL_B = "https://fixture.invalid/unapproved-B.pdf";

async function run(opts: { decision: "covers_a" | "none"; pdfUrl: string; switchOn?: boolean }) {
  const job = crypto.randomUUID();
  const rev = crypto.randomUUID();
  const scope = await canonicalJsonAndHash({ title: "approved A" });
  const pricing = await canonicalJsonAndHash({ totalIncGST: 110, totalExGST: 100, gst: 10 });
  const row = {
    id: rev, job_id: job, status: "frozen",
    scope_hash: scope.hash, pricing_hash: pricing.hash,
    scope_canonical_text: scope.canonical, pricing_canonical_text: pricing.canonical,
  };
  const shaA = await sha256Hex(PDF_A);
  const rpcCalls: any[] = [];
  const provider: any[] = [];
  const downloads: string[] = [];
  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        const f: any = {
          select: () => f, eq: () => f,
          maybeSingle: () => Promise.resolve({ data: { enabled: opts.switchOn === true }, error: null }),
        };
        return f;
      }
      const q: any = {
        select: () => q, eq: () => q,
        single: () => Promise.resolve({
          data: {
            id: job, job_number: "ZZTEST-SE-20261109-01", type: "fencing",
            client_name: "ZZTEST Scope Checker", client_email: "admin@example.invalid",
            pricing_json: { totalIncGST: 220 },
          },
          error: null,
        }),
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return q;
    },
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name === "record_quote_send_price_unapproved") {
        return Promise.resolve({ data: { recorded: true, state: args.p_state }, error: null });
      }
      return Promise.resolve({
        data: opts.decision === "none"
          ? null
          : { id: crypto.randomUUID(), kind: "price", quote_document_sha256s: [shaA] },
        error: null,
      });
    },
  };
  const localFetch = (url: string | URL | Request, init?: any) => {
    const u = String(url);
    if (u === URL_A || u === URL_B) {
      downloads.push(u);
      return Promise.resolve(new Response(u === URL_A ? PDF_A : PDF_B));
    }
    assertEquals(u, "https://api.resend.com/emails");
    provider.push(JSON.parse(init.body));
    return Promise.resolve(new Response('{"id":"fake-provider"}'));
  };
  // The real PDF check reads with the global fetch: point it at the fake too.
  const realFetch = globalThis.fetch;
  globalThis.fetch = localFetch as typeof fetch;
  try {
    const call = () =>
      handler(
        client,
        { job_id: job, source_scope_revision_id: rev, pdf_url: opts.pdfUrl },
        startNamedScopeRevisionRead, sealedSendSource, quoteSendBuildSource,
        ownerPriceBeforeSend, unapprovedSendKeyForQuickQuote, approvedQuotePdf, quotePdfBase64,
        () => Promise.resolve(), { env: { get: () => "synthetic-only" } }, ApiError,
        () => "admin@example.invalid", localFetch,
      );
    let error: any = null;
    try {
      await call();
    } catch (e) {
      error = e;
    }
    return { error, provider, downloads, rpcCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("Quick Quote: an approved revision with a PDF the decision does not cover is refused, nothing reaches the provider", async () => {
  const out = await run({ decision: "covers_a", pdfUrl: URL_B });
  assert(out.error instanceof ApiError, "refused");
  assertEquals([out.error.status, out.error.detail.code], [409, "owner_price_pdf_not_approved"]);
  assertEquals(out.provider.length, 0);
  assertEquals(out.rpcCalls.map((c) => c.name), ["scope_price_owner_approval"]);
});

Deno.test("Quick Quote: the PDF the owner's decision covers goes out as those bytes, with the approved price", async () => {
  const out = await run({ decision: "covers_a", pdfUrl: URL_A });
  assertEquals(out.error, null);
  assertEquals(out.provider.length, 1);
  assert(/\$110\.00/.test(out.provider[0].html), "the email quotes the approved frozen price");
  assertEquals(out.provider[0].attachments.length, 1);
  assertEquals(out.provider[0].attachments[0].content, quotePdfBase64(PDF_A));
  assertEquals(out.downloads, [URL_A]);
});

Deno.test("Quick Quote: no approver set and the switch off, a saved-revision send goes exactly as today, recorded first", async () => {
  const out = await run({ decision: "none", pdfUrl: URL_A });
  assertEquals(out.error, null);
  assertEquals(out.provider.length, 1);
  assert(/\$110\.00/.test(out.provider[0].html), "the email quotes the frozen price");
  // As today: the given PDF is fetched once and attached, unchecked.
  assertEquals(out.downloads, [URL_A]);
  assertEquals(out.provider[0].attachments[0].content, quotePdfBase64(PDF_A));
  const record = out.rpcCalls.filter((c) => c.name === "record_quote_send_price_unapproved");
  assertEquals(record.length, 1);
  assertEquals([record[0].args.p_state, record[0].args.p_path], ["claimed", "quick-quote"]);
  assertEquals(record[0].args.p_scope_revision_id, out.rpcCalls[0].args.p_scope_revision_id);
});

Deno.test("Quick Quote: with the switch on, no price decision on the named revision is refused before any PDF or provider call", async () => {
  const out = await run({ decision: "none", pdfUrl: URL_A, switchOn: true });
  assert(out.error instanceof ApiError, "refused");
  assertEquals([out.error.status, out.error.detail.code], [409, "owner_price_approval_required"]);
  assertEquals(out.downloads, []);
  assertEquals(out.provider.length, 0);
});

