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
  `${
    source.slice(start, end).replaceAll("refused!.", "refused.")
  } return jsonResponse({ reached_pricing: true }, 200, corsHeaders); }`,
);

async function runPrelude(
  body: Record<string, unknown>,
  jobType: unknown,
  sameTenant = true,
) {
  const reads: string[] = [];
  const sb = {
    from(table: string) {
      reads.push(table);
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
  );
  return { status: result.status, body: await result.json(), reads };
}

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
  }
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
