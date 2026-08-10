// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { updateMakesafeCompanyAddresses } from "./index.ts";

function makeClient(options: { auditError?: { message: string } | null } = {}) {
  const state = {
    id: "company-1",
    slug: "builder",
    report_recipient: "reports@builder.test",
    sender_patterns: ["builder.test"],
  };
  const events: any[] = [];
  const client = {
    from(table: string) {
      if (table === "business_events") {
        return {
          insert: async (row: any) => {
            events.push(row);
            return { error: options.auditError || null };
          },
        };
      }
      return {
        select(_columns: string) {
          return {
            eq(_column: string, _value: string) {
              return {
                maybeSingle: async () => ({ data: state, error: null }),
              };
            },
          };
        },
        update(patch: any) {
          return {
            eq: async (_column: string, _value: string) => {
              Object.assign(state, patch);
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client, state, events };
}

Deno.test("sanctioned company-address action adds and removes only a full address", async () => {
  const { client, state, events } = makeClient();
  const added = await updateMakesafeCompanyAddresses(
    client,
    {
      company_slug: "builder",
      operation: "add",
      address: "Branch@builder.test",
    },
    "captain@test.invalid",
  );
  assertEquals(added.changed, true);
  assertEquals(state.sender_patterns, ["builder.test", "branch@builder.test"]);
  assertEquals(events.length, 1);

  const removed = await updateMakesafeCompanyAddresses(
    client,
    {
      company_slug: "builder",
      operation: "remove",
      address: "branch@builder.test",
    },
    "captain@test.invalid",
  );
  assertEquals(removed.changed, true);
  assertEquals(state.sender_patterns, ["builder.test"]);
});

Deno.test("company-address action fails after a rejected audit insert", async () => {
  const { client } = makeClient({ auditError: { message: "audit unavailable" } });
  await assertRejects(
    () => updateMakesafeCompanyAddresses(client, {
      company_slug: "builder",
      operation: "add",
      address: "branch@builder.test",
    }),
    Error,
    "audit write failed",
  );
});

Deno.test("company-address dispatch remains privileged, POST-only, and routine-denied", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const routineStart = source.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set([");
  const routineEnd = source.indexOf("])\n", routineStart);
  const routineActions = source.slice(routineStart, routineEnd);
  const routeStart = source.indexOf("case 'update_makesafe_company_addresses': {");
  const routeEnd = source.indexOf("case 'update_makesafe_details':", routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert(routineStart >= 0 && routineEnd > routineStart);
  assert(routeStart >= 0 && routeEnd > routeStart);
  assert(!routineActions.includes("update_makesafe_company_addresses"));
  assertStringIncludes(route, "authMode === 'api_key'");
  assertStringIncludes(route, "authUser?.role === 'admin'");
  assertStringIncludes(route, "authUser?.role === 'owner'");
  assertStringIncludes(route, "if (!isPrivileged)");
  assertStringIncludes(route, "if (req.method !== 'POST')");
  assertStringIncludes(route, "}, 405)");
});

Deno.test("company-address action rejects domains, multiple addresses, and the primary recipient", async () => {
  const { client } = makeClient();
  await assertRejects(
    () =>
      updateMakesafeCompanyAddresses(client, {
        company_slug: "builder",
        operation: "add",
        address: "builder.test",
      }),
    Error,
    "full email",
  );
  await assertRejects(
    () =>
      updateMakesafeCompanyAddresses(client, {
        company_slug: "builder",
        operation: "add",
        address: "one@builder.test,two@builder.test",
      }),
    Error,
    "exactly one",
  );
  await assertRejects(
    () =>
      updateMakesafeCompanyAddresses(client, {
        company_slug: "builder",
        operation: "remove",
        address: "reports@builder.test",
      }),
    Error,
    "primary company anchor",
  );
});
