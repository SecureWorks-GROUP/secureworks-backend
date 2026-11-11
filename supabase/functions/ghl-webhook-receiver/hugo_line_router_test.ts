// Hugo's line router (hugo_line_router.ts): a text to +61 489 267 776 routes
// the contact to Hugo's Insurance pipeline. Fake GHL only, no network.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  HUGO_USER_ID,
  INSURANCE_FIRST_STAGE_ID,
  INSURANCE_PIPELINE_ID,
  isHugoLine,
  routeHugoLine,
  routerMode,
} from "./hugo_line_router.ts";

const NOW = Date.parse("2026-11-11T03:00:00.000Z");
const CONTACT = "contactAAA111";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function fakeGhl(opts: {
  inboundTo?: string;
  inboundAt?: string;
  contactOwner?: string | null;
  openOpp?: { id: string; assignedTo: string } | null;
  failPath?: string;
}) {
  const calls: Call[] = [];
  const fetchFn =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path: url.pathname, body });
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status });
      if (opts.failPath && url.pathname.startsWith(opts.failPath)) {
        return json({}, 500);
      }
      if (url.pathname === "/conversations/search") {
        return json({ conversations: [{ id: "convBBB222" }] });
      }
      if (url.pathname === "/conversations/convBBB222/messages") {
        return json({
          messages: {
            messages: [
              {
                id: "msgOUT1",
                direction: "outbound",
                to: "+61400000000",
                dateAdded: "2026-11-11T02:59:00.000Z",
              },
              {
                id: "msgIN1",
                direction: "inbound",
                to: opts.inboundTo ?? "+61489267776",
                dateAdded: opts.inboundAt ?? "2026-11-11T02:58:00.000Z",
              },
              {
                id: "msgIN0",
                direction: "inbound",
                to: "+61489267772",
                dateAdded: "2026-11-01T02:58:00.000Z",
              },
            ],
          },
        });
      }
      if (url.pathname === `/contacts/${CONTACT}` && method === "GET") {
        return json({
          contact: {
            id: CONTACT,
            firstName: "Jo",
            lastName: "Citizen",
            assignedTo: opts.contactOwner ?? null,
          },
        });
      }
      if (url.pathname === "/opportunities/search") {
        return json({
          opportunities: opts.openOpp
            ? [{
              id: opts.openOpp.id,
              pipelineId: INSURANCE_PIPELINE_ID,
              status: "open",
              assignedTo: opts.openOpp.assignedTo,
            }]
            : [],
        });
      }
      if (url.pathname === "/opportunities/" && method === "POST") {
        return json({ opportunity: { id: "oppNEW999" } });
      }
      if (method === "PUT") return json({ succeded: true });
      return json({}, 404);
    }) as typeof fetch;
  return { calls, fetchFn };
}

function env(mode: string | undefined) {
  const vars: Record<string, string | undefined> = {
    HUGO_LINE_ROUTER_MODE: mode,
    GHL_API_TOKEN: "test-token",
    GHL_LOCATION_ID: "loc123456",
  };
  return (name: string) => vars[name];
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

Deno.test("hugo line: the number matches in any form, other lines do not", () => {
  assertEquals(isHugoLine("+61489267776"), true);
  assertEquals(isHugoLine("0489 267 776"), true);
  assertEquals(isHugoLine("+61489267771"), false);
  assertEquals(isHugoLine(null), false);
  assertEquals(routerMode(undefined), "off");
  assertEquals(routerMode("LIVE"), "live");
  assertEquals(routerMode("yes"), "off");
});

Deno.test("hugo line: off by default reads and writes nothing", async () => {
  const g = fakeGhl({});
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env(undefined),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "off");
  assertEquals(g.calls.length, 0);
});

Deno.test("hugo line: live creates Hugo's opportunity and assigns the contact", async () => {
  const g = fakeGhl({ contactOwner: "someoneElse1" });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "routed");
  assertEquals(r.contactAssigned, true);
  assertEquals(r.opportunity, "created");
  assertEquals(r.opportunityId, "oppNEW999");
  const w = writes(g.calls);
  assertEquals(w.length, 2);
  assertEquals(w[0], {
    method: "PUT",
    path: `/contacts/${CONTACT}`,
    body: { assignedTo: HUGO_USER_ID },
  });
  assertEquals(w[1].path, "/opportunities/");
  assertEquals(w[1].body?.pipelineId, INSURANCE_PIPELINE_ID);
  assertEquals(w[1].body?.pipelineStageId, INSURANCE_FIRST_STAGE_ID);
  assertEquals(w[1].body?.assignedTo, HUGO_USER_ID);
  assertEquals(w[1].body?.contactId, CONTACT);
  assertEquals(w[1].body?.name, "Jo Citizen");
  assertEquals(w[1].body?.status, "open");
});

Deno.test("hugo line: an open Insurance card owned by someone else is given to Hugo", async () => {
  const g = fakeGhl({
    contactOwner: HUGO_USER_ID,
    openOpp: { id: "oppOLD123", assignedTo: "someoneElse1" },
  });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "routed");
  assertEquals(r.opportunity, "reassigned");
  assertEquals(writes(g.calls), [{
    method: "PUT",
    path: "/opportunities/oppOLD123",
    body: { assignedTo: HUGO_USER_ID },
  }]);
});

Deno.test("hugo line: running again for the same text writes nothing", async () => {
  const g = fakeGhl({
    contactOwner: HUGO_USER_ID,
    openOpp: { id: "oppOLD123", assignedTo: HUGO_USER_ID },
  });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "routed");
  assertEquals(r.opportunity, "already_hugo");
  assertEquals(writes(g.calls).length, 0);
});

Deno.test("hugo line: a text to another of our lines is left alone", async () => {
  const g = fakeGhl({ inboundTo: "+61489267772" });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "skipped");
  assertEquals(r.reason, "not_hugo_line");
  assertEquals(writes(g.calls).length, 0);
});

Deno.test("hugo line: an app delivery naming another line reads nothing", async () => {
  const g = fakeGhl({});
  const r = await routeHugoLine({ contactId: CONTACT, to: "+61489267774" }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.reason, "not_hugo_line");
  assertEquals(g.calls.length, 0);
});

Deno.test("hugo line: an old text is not acted on", async () => {
  const g = fakeGhl({ inboundAt: "2026-11-11T01:00:00.000Z" });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.reason, "inbound_not_fresh");
  assertEquals(writes(g.calls).length, 0);
});

Deno.test("hugo line: dry run reports and writes nothing", async () => {
  const g = fakeGhl({ contactOwner: null });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("dry_run"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "would_route");
  assertEquals(r.contactAssigned, true);
  assertEquals(r.opportunity, "created");
  assertEquals(writes(g.calls).length, 0);
});

Deno.test("hugo line: a GHL failure is an error code, never a throw", async () => {
  const g = fakeGhl({ failPath: "/opportunities/search" });
  const r = await routeHugoLine({ contactId: CONTACT }, {
    env: env("live"),
    fetch: g.fetchFn,
    now: () => NOW,
  });
  assertEquals(r.outcome, "error");
  assertEquals(r.reason, "ghl_get_500");
  assertEquals(writes(g.calls).length, 0);
});
