// deno-lint-ignore-file no-import-prefix no-explicit-any
// The one lookup of the person an ops-key Dispatch press names
// (dispatch_operator.ts). Made-up addresses only.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findDispatchOperator } from "./dispatch_operator.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000009";

// PostgREST ILIKE: % and * are any run, _ is one character, a backslash makes
// the next character literal; case-blind.
function ilikeMatches(actual: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%" || c === "*") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is").test(actual);
}

function fakeUsers(users: any[], error: any = null) {
  const calls: any[] = [];
  const client = {
    from(table: string) {
      const filters: [string, string, string][] = [];
      const b: any = {
        select: () => b,
        eq: (c: string, v: string) => (filters.push(["eq", c, v]), b),
        ilike: (c: string, v: string) => (filters.push(["ilike", c, v]), b),
        then: (ok: any, bad: any) => {
          calls.push({ table, filters });
          if (error) {
            return Promise.resolve({ data: null, error }).then(ok, bad);
          }
          const data = users.filter((u) =>
            filters.every(([op, c, v]) =>
              op === "eq" ? u[c] === v : ilikeMatches(String(u[c] ?? ""), v)
            )
          );
          return Promise.resolve({ data, error: null }).then(ok, bad);
        },
      };
      return b;
    },
  };
  return { client, calls };
}

Deno.test("operator: matched case-blind, answered as users stores it", async () => {
  const { client, calls } = fakeUsers([
    { id: "u1", email: "Person.One@Example.test", org_id: ORG },
  ]);
  assertEquals(
    await findDispatchOperator(client, ORG, " person.one@example.TEST "),
    {
      email: "Person.One@Example.test",
    },
  );
  assertEquals(calls[0].table, "users");
  assertEquals(calls[0].filters[0], ["eq", "org_id", ORG]);
});

Deno.test("operator: a person in another organisation is never matched", async () => {
  const { client } = fakeUsers([
    { id: "u1", email: "person@example.test", org_id: OTHER },
  ]);
  assertEquals(
    await findDispatchOperator(client, ORG, "person@example.test"),
    null,
  );
});

Deno.test("operator: the right person is found when another organisation has the same email", async () => {
  const { client } = fakeUsers([
    { id: "u0", email: "person@example.test", org_id: OTHER },
    { id: "u1", email: "person@example.test", org_id: ORG },
  ]);
  assertEquals(await findDispatchOperator(client, ORG, "person@example.test"), {
    email: "person@example.test",
  });
});

Deno.test("operator: LIKE wildcards in the typed email match only themselves", async () => {
  const { client } = fakeUsers([
    { id: "u1", email: "axb@example.test", org_id: ORG },
    { id: "u2", email: "a%b@example.test", org_id: ORG },
  ]);
  assertEquals(
    await findDispatchOperator(client, ORG, "a_b@example.test"),
    null,
  );
  assertEquals(
    await findDispatchOperator(client, ORG, "a*b@example.test"),
    null,
  );
  assertEquals(await findDispatchOperator(client, ORG, "a%b@example.test"), {
    email: "a%b@example.test",
  });
});

Deno.test("operator: no email, no organisation or no match answers null", async () => {
  const { client, calls } = fakeUsers([
    { id: "u1", email: "person@example.test", org_id: ORG },
  ]);
  assertEquals(await findDispatchOperator(client, ORG, ""), null);
  assertEquals(await findDispatchOperator(client, ORG, undefined), null);
  assertEquals(
    await findDispatchOperator(client, "", "person@example.test"),
    null,
  );
  assertEquals(calls.length, 0);
  assertEquals(
    await findDispatchOperator(client, ORG, "someone@example.test"),
    null,
  );
});

Deno.test("operator: a failed read is thrown, never read as no person", async () => {
  const { client } = fakeUsers([], { message: "boom" });
  await assertRejects(() =>
    findDispatchOperator(client, ORG, "person@example.test")
  );
});
