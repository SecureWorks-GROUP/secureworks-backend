// F-ACT (INTEGRATION X31): the one actor rule, on the doors X31 names.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTOR_HEADER,
  ACTOR_MISSING,
  resolveRequestActor,
} from "./request_actor.ts";

const h = (value?: string) =>
  new Headers(value === undefined ? {} : { [ACTOR_HEADER]: value });

Deno.test("signed-in Ops browser: the verified user, and a header on the same call is ignored", () => {
  assertEquals(
    resolveRequestActor({
      verifiedUserId: "5f0c7a3e-0000-4000-8000-000000000001",
      headers: h("workflow:spoof"),
    }),
    {
      actor: "user:5f0c7a3e-0000-4000-8000-000000000001",
      source: "jwt",
      missing: false,
    },
  );
});

Deno.test("MCP or sw-axi on the server key, before F-ACT-RT: actor_missing, source none", () => {
  assertEquals(resolveRequestActor({ verifiedUserId: null, headers: h() }), {
    actor: ACTOR_MISSING,
    source: "none",
    missing: true,
  });
  assertEquals(resolveRequestActor({ headers: h("   ") }).source, "none");
});

Deno.test("MCP after F-ACT-RT: the captain id or a workflow name, kept verbatim as a claim", () => {
  for (
    const actor of [
      "marnin",
      "workflow:ghl-message-reconcile",
      "workflow:debt-chase:marnin",
      "shaun@secureworkswa.com.au",
    ]
  ) {
    assertEquals(resolveRequestActor({ headers: h(` ${actor} `) }), {
      actor,
      source: "header",
      missing: false,
    });
  }
});

Deno.test("a malformed header is actor_missing and its value never survives", () => {
  for (
    const bad of [
      "not a valid actor; drop table",
      "x".repeat(129),
      "a/b",
      '"quoted"',
      ACTOR_MISSING,
    ]
  ) {
    const r = resolveRequestActor({ headers: h(bad) });
    assertEquals(r, {
      actor: ACTOR_MISSING,
      source: "header_invalid",
      missing: true,
    }, bad);
  }
});

Deno.test("an empty verified id is not a user", () => {
  assertEquals(
    resolveRequestActor({ verifiedUserId: "  ", headers: h("workflow:x") }),
    { actor: "workflow:x", source: "header", missing: false },
  );
});
