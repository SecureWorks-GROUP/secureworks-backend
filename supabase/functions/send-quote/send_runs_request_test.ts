// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  quoteSendMissingOrForeignRefusal,
  quoteSendTenantAccess,
} from "./quote_send_auth.ts";
import {
  sendRunsJobTypeRefusal,
  sendRunsRequestRefusal,
} from "./send_runs_request.ts";
import {
  quoteSendBuildSource,
  sealedSendSource,
  startNamedScopeRevisionRead,
} from "../_shared/scope_freeze/quote_scope_revision_link.ts";
import {
  approvedQuotePdfsByLabel,
  OWNER_APPROVAL_SAVED_REVISION_FLAG,
  ownerPriceGate,
} from "../_shared/scope_freeze/owner_price_approval.ts";

Deno.test("send-runs rejects every explicit runs property rather than silently widening selection", () => {
  for (const runs of [["REAR"], [], null, undefined, "REAR"]) {
    const refusal = sendRunsRequestRefusal({ job_id: "fixture-job", runs });
    assertEquals(refusal?.status, 400);
    assertEquals(refusal?.body.code, "RUN_SELECTION_NOT_SUPPORTED");
  }
});

Deno.test("send-runs validates its optional fixed scope and preserves supported legacy inputs", () => {
  for (
    const body of [null, [], {}, { job_id: 2 }, { job_id: " " }, {
      job_id: "fixture-job",
      expected_job_type: "patio",
    }, { job_id: "fixture-job", expected_job_type: null }]
  ) {
    assertEquals(
      sendRunsRequestRefusal(body)?.body.code,
      "INVALID_QUOTE_SEND_REQUEST",
    );
  }
  for (
    const body of [{ job_id: "fixture-job" }, {
      job_id: "fixture-job",
      message: "Saved quote",
      run_pdfs: { REAR: "https://example.test/quote.pdf" },
    }, { job_id: "fixture-job", expected_job_type: "fencing" }]
  ) {
    assertEquals(sendRunsRequestRefusal(body), null);
  }
  for (const type of ["patio", "fencing", "other", null]) {
    assertEquals(sendRunsJobTypeRefusal({ job_id: "fixture-job" }, type), null);
  }
  assertEquals(
    sendRunsJobTypeRefusal({ expected_job_type: "fencing" }, "fencing"),
    null,
  );
  assertEquals(
    sendRunsJobTypeRefusal({ expected_job_type: "fencing" }, "patio")?.body
      .code,
    "QUOTE_JOB_TYPE_MISMATCH",
  );
});

// Execute the production route prelude, ending before pricing/claim/publication.
// This proves guard placement and observable HTTP refusals without importing the
// serving monolith or permitting a DB/provider write. It is not full-route proof.
const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = source.indexOf(
  "if (path === 'send-runs' && req.method === 'POST')",
);
const end = source.indexOf("const pj = typeof job.pricing_json", start);
assert(
  start > -1 && end > start,
  "send-runs request prelude must remain identifiable",
);
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<Response>;
const prelude = new AsyncFunction(
  "req",
  "path",
  "RESEND_API_KEY",
  "corsHeaders",
  "sb",
  "jsonResponse",
  "sendAuthMode",
  "sendAuthUser",
  "quoteSendMissingOrForeignRefusal",
  "quoteSendTenantAccess",
  "sendRunsRequestRefusal",
  "sendRunsJobTypeRefusal",
  "startNamedScopeRevisionRead",
  "sealedSendSource",
  "quoteSendBuildSource",
  "ownerPriceGate",
  "approvedQuotePdfsByLabel",
  `${
    source.slice(start, end).replaceAll("refused!.", "refused.")
      .replace("let ownerPriceRuns: OwnerPriceGate", "let ownerPriceRuns")
      .replace("let approvedRunPdfs: Map<string, Uint8Array> = new Map()", "let approvedRunPdfs = new Map()")
  } return jsonResponse({ reached_pricing: true }, 200, corsHeaders); }`,
);

async function runPrelude(
  body: Record<string, unknown>,
  jobType: unknown,
  sameTenant = true,
  savedRevisionRequired = false,
) {
  const reads: string[] = [];
  const sb = {
    from(table: string) {
      reads.push(table);
      if (table === "feature_flags") {
        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            assertEquals(column, "flag_name");
            assertEquals(value, OWNER_APPROVAL_SAVED_REVISION_FLAG);
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { enabled: savedRevisionRequired },
              error: null,
            });
          },
        };
      }
      assertEquals(table, "jobs");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        single() {
          return Promise.resolve({
            data: { id: "fixture-job", type: jobType, org_id: "fixture-org" },
            error: null,
          });
        },
      };
    },
  };
  const result = await prelude(
    new Request("https://example.test/send-runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    "send-runs",
    "fixture-key",
    {},
    sb,
    (body: unknown, status: number) => Response.json(body, { status }),
    "jwt",
    { orgId: sameTenant ? "fixture-org" : "other-org" },
    quoteSendMissingOrForeignRefusal,
    quoteSendTenantAccess,
    sendRunsRequestRefusal,
    sendRunsJobTypeRefusal,
    startNamedScopeRevisionRead,
    sealedSendSource,
    quoteSendBuildSource,
    ownerPriceGate,
    approvedQuotePdfsByLabel,
  );
  return { status: result.status, body: await result.json(), reads };
}
// The approved saved-revision path of the same production prelude: a fake
// sealed read, the real price gate and the real quote PDF check, with the PDF
// fetch faked. No provider is reachable from here.
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runApprovedPrelude(opts: {
  pdfs: Record<string, Uint8Array<ArrayBuffer>>;
  recorded: Uint8Array<ArrayBuffer>[];
  noDecision?: boolean;
  switchOn?: boolean;
}) {
  const REV = crypto.randomUUID();
  const recordedShas = await Promise.all(opts.recorded.map(sha256Hex));
  const sb = {
    rpc(name: string) {
      assertEquals(name, "scope_price_owner_approval");
      return Promise.resolve({
        data: opts.noDecision
          ? null
          : { id: "decision", kind: "price", quote_document_sha256s: recordedShas },
        error: null,
      });
    },
    from(table: string) {
      if (table === "feature_flags") {
        const flag = {
          select() {
            return flag;
          },
          eq() {
            return flag;
          },
          maybeSingle() {
            return Promise.resolve({ data: { enabled: opts.switchOn === true }, error: null });
          },
        };
        return flag;
      }
      assertEquals(table, "jobs");
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        single() {
          return Promise.resolve({
            data: { id: "fixture-job", type: "fencing", org_id: "fixture-org" },
            error: null,
          });
        },
      };
      return chain;
    },
  };
  const fakeFetch = (url: string | URL | Request) => {
    const key = String(url);
    const bytes = opts.pdfs[key];
    return Promise.resolve(
      bytes ? new Response(bytes) : new Response("missing", { status: 404 }),
    );
  };
  const runPdfs = Object.fromEntries(Object.keys(opts.pdfs).map((u, i) => [`RUN${i}`, u]));
  const result = await prelude(
    new Request("https://example.test/send-runs", {
      method: "POST",
      body: JSON.stringify({ job_id: "fixture-job", run_pdfs: runPdfs }),
    }),
    "send-runs",
    "fixture-key",
    {},
    sb,
    (body: unknown, status: number) => Response.json(body, { status }),
    "jwt",
    { orgId: "fixture-org" },
    quoteSendMissingOrForeignRefusal,
    quoteSendTenantAccess,
    sendRunsRequestRefusal,
    sendRunsJobTypeRefusal,
    () => Promise.resolve({ revision: null, reason: "fixture" }),
    () => ({ kind: "sealed", revision_id: REV, scope_json: {}, pricing_json: {} }),
    (_sealed: unknown, job: any) => ({ scope_json: job.scope_json, pricing_json: job.pricing_json }),
    ownerPriceGate,
    (gate: any, runPdfs: unknown) =>
      approvedQuotePdfsByLabel(gate, runPdfs, fakeFetch as typeof fetch),
  );
  return { status: result.status, body: await result.json(), REV };
}

Deno.test("production send-runs on an approved revision refuses a caller PDF the owner's decision does not cover", async () => {
  const approvedPdf = new TextEncoder().encode("%PDF approved quote");
  const otherPdf = new TextEncoder().encode("%PDF other prices");
  const refused = await runApprovedPrelude({
    pdfs: { "https://example.test/b.pdf": otherPdf },
    recorded: [approvedPdf],
  });
  assertEquals(refused.status, 409);
  assertEquals(refused.body.code, "owner_price_pdf_not_approved");

  // One approved run PDF and one other: still refused, before any claim.
  const mixed = await runApprovedPrelude({
    pdfs: {
      "https://example.test/a.pdf": approvedPdf,
      "https://example.test/b.pdf": otherPdf,
    },
    recorded: [approvedPdf],
  });
  assertEquals(mixed.body.code, "owner_price_pdf_not_approved");

  // No PDF named: nothing to check or attach.
  const none = await runApprovedPrelude({ pdfs: {}, recorded: [approvedPdf] });
  assertEquals(none.body.reached_pricing, true);
  const ok = await runApprovedPrelude({
    pdfs: { "https://example.test/a.pdf": approvedPdf },
    recorded: [approvedPdf],
  });
  assertEquals(ok.status, 200);
  assertEquals(ok.body.reached_pricing, true);
});

Deno.test("production send-runs: no approver set and the switch off, a saved-revision bundle goes as today", async () => {
  const pdf = new TextEncoder().encode("%PDF quote");
  const off = await runApprovedPrelude({
    pdfs: { "https://example.test/a.pdf": pdf },
    recorded: [],
    noDecision: true,
  });
  assertEquals(off.status, 200);
  assertEquals(off.body.reached_pricing, true);
  const on = await runApprovedPrelude({
    pdfs: { "https://example.test/a.pdf": pdf },
    recorded: [],
    noDecision: true,
    switchOn: true,
  });
  assertEquals(on.status, 409);
  assertEquals(on.body.code, "owner_price_approval_required");
});

Deno.test("production send-runs refuses selection before even a job lookup", async () => {
  for (const runs of [["REAR"], [], null]) {
    const result = await runPrelude({ job_id: "fixture-job", runs }, "fencing");
    assertEquals(result.status, 400);
    assertEquals(result.body.code, "RUN_SELECTION_NOT_SUPPORTED");
    assertEquals(result.reads, []);
  }
});

Deno.test("production send-runs fences the MCP scope before pricing while preserving legacy calls", async () => {
  const refused = await runPrelude({
    job_id: "fixture-job",
    expected_job_type: "fencing",
  }, "patio");
  assertEquals(refused.status, 400);
  assertEquals(refused.body.code, "QUOTE_JOB_TYPE_MISMATCH");
  assertEquals(refused.reads, ["jobs"]);
  for (
    const [body, type] of [
      [{ job_id: "fixture-job" }, "patio"],
      [{ job_id: "fixture-job", expected_job_type: "fencing" }, "fencing"],
    ] as const
  ) {
    const accepted = await runPrelude(body, type);
    assertEquals(accepted.status, 200);
    assertEquals(accepted.body.reached_pricing, true);
    assertEquals(accepted.reads, ["jobs", "feature_flags"]);
  }
});

Deno.test("production send-runs with no saved revision is refused before pricing while the saved-revision switch is on", async () => {
  const refused = await runPrelude(
    { job_id: "fixture-job" },
    "fencing",
    true,
    true,
  );
  assertEquals(refused.status, 409);
  assertEquals(
    refused.body.code,
    "owner_price_approval_requires_saved_revision",
  );
  assertEquals(refused.reads, ["jobs", "feature_flags"]);
  const legacy = await runPrelude({ job_id: "fixture-job" }, "fencing");
  assertEquals(legacy.status, 200);
  assertEquals(legacy.body.reached_pricing, true);
});

Deno.test("production type refusal does not expose foreign-tenant job type", async () => {
  const result = await runPrelude(
    { job_id: "fixture-job", expected_job_type: "fencing" },
    "patio",
    false,
  );
  assertEquals(result.status, 404);
  assertEquals(result.body.code, "not_found");
});

Deno.test("production /send checks an approved revision's shown price and linked PDF after the claim and before the email", () => {
  const at = source.indexOf("const ownerPrice = await ownerPriceGate(sb, doc.job_id, sealedSource)");
  assert(at > 0, "/send gate found");
  const refusal = source.indexOf("if (ownerPrice.kind === 'refused') {", at);
  const shown = source.indexOf(
    "const shownPrice = approvedDocumentSnapshotPrice(doc.data_snapshot_json, sealedPricingJson)",
    at,
  );
  const check = source.indexOf(
    "? await approvedQuotePdf(ownerPrice, String(doc.pdf_url))",
    at,
  );
  assert(refusal > at && shown > refusal && check > shown, "the shown price, then the PDF, after the price gate");
  const release = source.indexOf("revertQuoteDocumentSendClaim(sb, document_id, claimed.token, 'pre_send')", check);
  const provider = source.indexOf("https://api.resend.com/emails", at);
  assert(refusal > at && check > refusal, "checked after the price gate");
  assert(release > check && release < provider, "a refusal releases the claim before any email");
  assert(provider > check, "the email comes after the check");
  // Approved runs attach the checked bytes, never the caller URL.
  const runsAttach = source.indexOf("const checkedBytes = approvedRunPdfs.get(run.run_label || '')");
  assert(runsAttach > 0, "runs attach from the checked bytes");
  assert(
    source.slice(runsAttach, runsAttach + 400).includes("content: quotePdfBase64(checkedBytes)"),
    "as content",
  );
});
