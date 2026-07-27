// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LivefireClient } from "./client.ts";
import { buildFixtureRun } from "./fixtures.ts";

Deno.test("real-front-door client emits only the exact self-addressed envelope", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Request | null = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    captured = new Request(input, init);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          from: "marnin@secureworkswa.com.au",
          to: ["ses@secureworkswa.com.au"],
          cc: [],
          bcc: [],
        }),
        { status: 200 },
      ),
    );
  };
  try {
    const run = await buildFixtureRun({
      runId: "018f7f2c-4db4-7c61-92c7-2b2b97e0a111",
      expiresAtMs: Date.now() + 60_000,
      secret: "test-secret",
    });
    const client = new LivefireClient({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      opsApiKey: "ops-api-test",
    });
    await client.sendFixture(run.fixtures[0]);
    const request = captured!;
    assertEquals(request.headers.get("x-api-key"), "ops-api-test");
    assertStringIncludes(
      request.url,
      "/functions/v1/send-outlook-email",
    );
    const body = await request.json();
    assertEquals(body.from, "marnin@secureworkswa.com.au");
    assertEquals(body.to, ["ses@secureworkswa.com.au"]);
    assertEquals(body.cc, []);
    assertEquals(body.bcc, []);
    assertEquals(body.job_id, undefined);
    assertEquals(body.ghl_contact_id, undefined);
    assertEquals(body.attachments.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("storage cleanup sends only the exact guarded object paths", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Request | null = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    captured = new Request(input, init);
    return Promise.resolve(new Response("[]", { status: 200 }));
  };
  try {
    const client = new LivefireClient({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      opsApiKey: "ops-api-test",
    });
    const paths = [
      "synthetic-post/fixture.pdf",
      "synthetic-post/evidence.pdf",
    ];
    await client.removeStorageObjects("makesafe-emails", paths);
    const request = captured!;
    assertEquals(request.method, "DELETE");
    assertStringIncludes(request.url, "/storage/v1/object/makesafe-emails");
    assertEquals(await request.json(), { prefixes: paths });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("edge actions use the explicit production ops key", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Request | null = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    captured = new Request(input, init);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  try {
    const client = new LivefireClient({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      opsApiKey: "ops-api-test",
    });
    await client.action("ops-api", "synthetic_livefire_capability");
    const request = captured!;
    assertEquals(request.headers.get("apikey"), "service-role-test");
    assertEquals(
      request.headers.get("authorization"),
      "Bearer service-role-test",
    );
    assertEquals(request.headers.get("x-api-key"), "ops-api-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
