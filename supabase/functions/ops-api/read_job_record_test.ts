// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  JOB_RECORD_COLUMNS,
  JobRecordReadError,
  jobRecordSelector,
  readJobRecord,
} from "./read_job_record.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  _preferBearerForOpsApiAction,
  _readJobRecordAction,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const ID = "11111111-1111-4111-8111-111111111111";
const params = (values: Record<string, string> = { job_id: ID }) =>
  new URLSearchParams({ action: "read_job_record", ...values });
function row(extra: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(JOB_RECORD_COLUMNS.map((key) => [key, null])),
    id: ID,
    org_id: ORG,
    job_number: "SWF-TEST",
    archived: true,
    ...extra,
  };
}
function fixture(rows = [row()], error: unknown = null) {
  const calls: any[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select(projection: string) {
          assertEquals(projection, JOB_RECORD_COLUMNS.join(","));
          calls.push(["select", projection]);
          return this;
        },
        eq(field: string, value: unknown) {
          filters.push([field, value]);
          calls.push(["eq", field, value]);
          return this;
        },
        limit(limit: number) {
          assertEquals(limit, 2);
          assertEquals(filters[0][0], "org_id");
          return Promise.resolve({
            data: error
              ? null
              : rows.filter((item: any) =>
                filters.every(([key, value]) => item[key] === value)
              ).slice(0, limit),
            error,
          });
        },
      };
      return new Proxy(builder, {
        get(target, key) {
          if (!(key in target)) throw new Error("Forbidden non-SELECT access");
          return Reflect.get(target, key);
        },
      });
    },
  };
  return { client, calls };
}

Deno.test("selectors use literal equality and refuse unknown, repeated, both or invalid args", () => {
  assertEquals(jobRecordSelector(params({ job_number: " SWF-%_TEST " })), {
    field: "job_number",
    value: "SWF-%_TEST",
  });
  for (
    const value of [
      params({}),
      params({ job_id: ID, job_number: "SWF-TEST" }),
      params({ job_id: "x" }),
      params({ job_id: ID, org_id: OTHER }),
      new URLSearchParams(`job_id=${ID}&job_id=${ID}`),
    ]
  ) {
    assertThrows(() => jobRecordSelector(value), JobRecordReadError);
  }
});

Deno.test("one authorised record preserves nested business JSON, nulls, archived state and explicit provenance without writes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Provider traffic forbidden");
  };
  try {
    const scope = {
      sections: [{
        description: "Fence",
        quantity: 18.25,
        public_url: "https://example.test/spec.pdf",
        values: [false, null, 0],
      }],
    };
    const pricing = { subtotal: 2345.67, tax: 234.567 };
    const f = fixture([
      row({
        scope_json: scope,
        pricing_json: pricing,
        metadata: { api_key: "must-not-escape" },
      }),
    ]);
    for (
      const selector of [{ job_id: ID }, { job_number: "SWF-TEST" }] as Array<
        Record<string, string>
      >
    ) {
      const result = await readJobRecord(f.client, params(selector), ORG);
      assertEquals(result.job.scope_json, scope);
      assertEquals(result.job.pricing_json, pricing);
      assertEquals(result.job.archived, true);
      assertEquals(Object.hasOwn(result.job, "metadata"), false);
      assertEquals(result.coverage.scope_json, "full");
      assertEquals(result.provenance.provider_live, false);
      assertEquals(result.provenance.stored_updated_at, null);
      assertEquals(result.links.jobs.deposit_invoice_id, null);
    }
    const empty = await readJobRecord(fixture().client, params(), ORG);
    assertEquals(empty.coverage.scope_json, "stored_null");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("absent and cross-org jobs reveal no existence; database failures and ambiguity remain explicit", async () => {
  for (const rows of [[], [row({ org_id: OTHER })]]) {
    await assertRejects(
      () => readJobRecord(fixture(rows).client, params(), ORG),
      JobRecordReadError,
      "Job not found",
    );
  }
  await assertRejects(
    () => readJobRecord(fixture([row(), row()]).client, params(), ORG),
    JobRecordReadError,
    "multiple jobs",
  );
  await assertRejects(
    () =>
      readJobRecord(
        fixture([], { message: "do not expose database detail" }).client,
        params(),
        ORG,
      ),
    JobRecordReadError,
    "could not be read",
  );
  await assertRejects(
    () => readJobRecord(fixture().client, params(), ""),
    JobRecordReadError,
    "verified organisation",
  );
});

Deno.test("nested credentials and credentials embedded in notes/URLs are redacted with no secret in warnings", async () => {
  const secret = "fixture-secret-value";
  const scope = {
    ordinary: "keep",
    nested: [
      {
        access_token: secret,
        client_secret: secret,
        bearer: secret,
        auth: secret,
        authentication: secret,
        service_role_key: secret,
      },
      `Portal https://example.test/portal/${secret}`,
      `https://example.test/a?X-Amz-Signature=${secret}`,
      `https://example.test/a#access_token=${secret}`,
      `Authorization: Bearer ${secret}`,
      `/portal/${secret}`,
      `/job?token=${secret}`,
      encodeURIComponent(`https://example.test/portal/${secret}`),
    ],
  };
  const result = await readJobRecord(
    fixture([
      row({
        scope_json: scope,
        pricing_json: { bearer: secret, auth: secret },
        notes: `api_key=${secret}`,
      }),
    ]).client,
    params(),
    ORG,
  );
  assertEquals(JSON.stringify(result).includes(secret), false);
  assertEquals((result.job.scope_json as any).ordinary, "keep");
  assertEquals(result.coverage.scope_json, "redacted");
  assertEquals(result.coverage.job_record_complete, false);
  assertEquals(result.redacted_paths.includes("/job/notes"), true);
});

Deno.test("unsafe field names fail closed and missing columns cannot masquerade as complete", async () => {
  const unsafe = row({
    scope_json: { "Bearer fixture-secret-value": "value" },
  });
  await assertRejects(
    () => readJobRecord(fixture([unsafe]).client, params(), ORG),
    JobRecordReadError,
    "unsafe field name",
  );
  const partial: any = row();
  delete partial.pricing_json;
  await assertRejects(
    () => readJobRecord(fixture([partial]).client, params(), ORG),
    JobRecordReadError,
    "projection was incomplete",
  );
});

Deno.test("2.6 MB stored scope is complete and oversized records are explicitly refused without truncation", async () => {
  const text = "x".repeat(2_600_000);
  const result = await readJobRecord(
    fixture([row({ scope_json: { text } })]).client,
    params(),
    ORG,
  );
  assertEquals((result.job.scope_json as any).text, text);
  assertEquals(result.coverage.scope_json, "full");
  const error = await assertRejects(
    () =>
      readJobRecord(
        fixture([row({ scope_json: { text: "x".repeat(4_200_000) } })]).client,
        params(),
        ORG,
      ),
    JobRecordReadError,
  );
  assertEquals(error.code, "JOB_RECORD_TOO_LARGE");
  assertEquals(error.details.full_delivery_supported, false);
});

Deno.test("real route uses staff/server authority, JWT tenant identity, GET only, and never public/routine access", async () => {
  const url = new URL(`https://example.test/?${params()}`);
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(_preferBearerForOpsApiAction(url), true);
  assertEquals(
    _authorizeOpsApiAction({
      url,
      authMode: "api_key",
      serverSecretPresented: false,
    }).ok,
    false,
  );
  const f = fixture();
  for (
    const auth of [
      { mode: "none", role: "owner", server: false },
      { mode: "api_key", role: "owner", server: false },
      { mode: "routine", role: "owner", server: true },
      { mode: "agent_read", role: "owner", server: true },
      { mode: "jwt", role: "lead_installer", server: false },
    ] as const
  ) {
    assertEquals(
      (await _readJobRecordAction(f.client, params(), "GET", auth.mode, {
        role: auth.role,
        orgId: ORG,
      }, auth.server)).status,
      403,
    );
  }
  assertEquals(f.calls.length, 0);
  assertEquals(
    (await _readJobRecordAction(f.client, params(), "GET", "jwt", {
      role: "owner",
      orgId: "",
    }, false)).status,
    403,
  );
  assertEquals(
    (await _readJobRecordAction(f.client, params(), "GET", "jwt", {
      role: "owner",
      orgId: OTHER,
    }, false)).status,
    404,
  );
  assertEquals(
    (await _readJobRecordAction(
      f.client,
      params(),
      "POST",
      "api_key",
      null,
      true,
    )).status,
    405,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      (await _readJobRecordAction(f.client, params(), "GET", "jwt", {
        role,
        orgId: ORG,
      }, false)).status,
      200,
    );
  }
  assertEquals(
    (await _readJobRecordAction(
      f.client,
      params(),
      "GET",
      "api_key",
      null,
      true,
    )).status,
    200,
  );
});
