// ════════════════════════════════════════════════════════════
// A5 — ARRIVAL-TEXT NOTIFY TESTS (routing / dedup / message / fire-once)
// ════════════════════════════════════════════════════════════
// Pure-Deno, no network. Tests the pure routing/message/dedup helpers plus the
// DB-bound fire-once send (stub client capturing the ledger insert + SMS sends).
//
// RUN: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/makesafe_notify_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  arrivalDedupKey,
  arrivalRecipientsFor,
  buildArrivalMessage,
  DEFAULT_NOTIFY_SETTINGS,
  isRoofArrival,
  loadNotifySettings,
  type NotifySettings,
  sendMakesafeArrivalTexts,
  shouldSendArrival,
  stripDashes,
} from "./makesafe_notify.ts";

const S: NotifySettings = {
  notify_enabled: true,
  alarm_enabled: true,
  arrival_general_phones: ["+61400753169"], // Hugo
  arrival_roof_phones: ["+61400753169", "+61417795299"], // Hugo + Nithin
  alarm_phones: [],
  from_number: "+61489267776",
};

// ── routing ──
Deno.test("notify: roof report routes to roof recipients (Hugo + Nithin)", () => {
  assertEquals(isRoofArrival("roof_report", null), true);
  assertEquals(isRoofArrival(null, "roof_report"), true);
  assertEquals(arrivalRecipientsFor("roof_report", null, S), ["+61400753169", "+61417795299"]);
  assertEquals(arrivalRecipientsFor(null, "roof_report", S), ["+61400753169", "+61417795299"]);
});

Deno.test("notify: general/temp/assessment route to general recipient (Hugo only)", () => {
  assertEquals(arrivalRecipientsFor("general_makesafe", null, S), ["+61400753169"]);
  assertEquals(arrivalRecipientsFor("temp_fence_makesafe", null, S), ["+61400753169"]);
  assertEquals(arrivalRecipientsFor("assessment_report_quote", "assessment_report", S), ["+61400753169"]);
});

Deno.test("notify: recipients deduped + blanks dropped", () => {
  const s2 = { ...S, arrival_general_phones: ["+61400753169", "", "+61400753169"] };
  const r = arrivalRecipientsFor("general_makesafe", null, s2);
  assertEquals(r, ["+61400753169"]);
  assert(!r.includes(""));
});

// ── dedup key ──
Deno.test("notify: dedup key prefers normalised ref, falls back to graph id, else null", () => {
  assertEquals(arrivalDedupKey("MLB-26678", "AAMk123"), "ref:mlb26678");
  assertEquals(arrivalDedupKey(null, "AAMk123"), "gmid:AAMk123");
  assertEquals(arrivalDedupKey("   ", "   "), null);
  // twins with the same ref collapse to the same key
  assertEquals(arrivalDedupKey("MLB 26678", "x"), arrivalDedupKey("mlb-26678", "y"));
});

// ── message ──
Deno.test("notify: message format is plain, no em dashes, has ref/addr/company", () => {
  const m = buildArrivalMessage({
    family: "general_makesafe",
    externalRef: "MLB-26678",
    siteAddress: "80 San Jacinta Rd",
    siteSuburb: "Seville Grove",
    companyName: "ML Builders",
  });
  assertEquals(m, "New make-safe MLB-26678: 80 San Jacinta Rd, Seville Grove (ML Builders)");
  assert(!/[‒–—―]/.test(m), "no em/en dashes allowed in owner comms");
});

Deno.test("notify: roof message uses the roof label", () => {
  const m = buildArrivalMessage({ reportType: "roof_report", externalRef: "MLB-1", siteAddress: "1 A St", companyName: "MLB" });
  assertStringIncludes(m, "New roof report make-safe MLB-1");
});

Deno.test("notify: stripDashes converts em/en dashes to a hyphen", () => {
  assertEquals(stripDashes("a — b – c"), "a - b - c");
});

// ── gate ──
Deno.test("notify: shouldSendArrival gates on kill switch / reopen / degraded / key", () => {
  assertEquals(shouldSendArrival({ notifyEnabled: false, isReopen: false, extractionDegraded: false, hasDedupKey: true }).ok, false);
  assertEquals(shouldSendArrival({ notifyEnabled: true, isReopen: true, extractionDegraded: false, hasDedupKey: true }).ok, false);
  assertEquals(shouldSendArrival({ notifyEnabled: true, isReopen: false, extractionDegraded: true, hasDedupKey: true }).ok, false);
  assertEquals(shouldSendArrival({ notifyEnabled: true, isReopen: false, extractionDegraded: false, hasDedupKey: false }).ok, false);
  assertEquals(shouldSendArrival({ notifyEnabled: true, isReopen: false, extractionDegraded: false, hasDedupKey: true }).ok, true);
});

// ── DB-bound fire-once send ──
function makeNotifyClient(insertErr?: any) {
  const inserts: any[] = [];
  return {
    _inserts: inserts,
    from: (_t: string) => ({
      insert: (row: any) => {
        inserts.push(row);
        return Promise.resolve({ error: insertErr ?? null });
      },
    }),
  } as any;
}

Deno.test("notify send: fires once, records the ledger, texts every recipient", async () => {
  const client = makeNotifyClient();
  const sent: any[] = [];
  const r = await sendMakesafeArrivalTexts(
    client,
    S,
    { sendSms: async (p: string, m: string) => { sent.push({ p, m }); return true; } },
    { orgId: "org", externalRef: "MLB-26678", graphMessageId: "g", family: "roof_report", reportType: "roof_report", siteAddress: "80 San Jacinta Rd", siteSuburb: "Seville Grove", companyName: "ML Builders" },
  );
  assertEquals(r.sent, true);
  assertEquals(sent.length, 2); // Hugo + Nithin
  assertEquals(client._inserts.length, 1);
  assertEquals(client._inserts[0].kind, "arrival");
  assertEquals(client._inserts[0].dedup_key, "ref:mlb26678");
});

Deno.test("notify send: 23505 collision (twin/re-send/re-extract) -> already_sent, no SMS", async () => {
  const client = makeNotifyClient({ code: "23505", message: "duplicate key value" });
  const sent: any[] = [];
  const r = await sendMakesafeArrivalTexts(
    client,
    S,
    { sendSms: async () => { sent.push(1); return true; } },
    { orgId: "org", externalRef: "MLB-26678", graphMessageId: "g", family: "general_makesafe", reportType: null, siteAddress: "x", siteSuburb: null, companyName: "MLB" },
  );
  assertEquals(r.reason, "already_sent");
  assertEquals(sent.length, 0);
});

Deno.test("notify send: kill switch OFF -> no ledger, no SMS", async () => {
  const client = makeNotifyClient();
  const sent: any[] = [];
  const r = await sendMakesafeArrivalTexts(
    client,
    { ...S, notify_enabled: false },
    { sendSms: async () => { sent.push(1); return true; } },
    { orgId: "org", externalRef: "MLB-1", graphMessageId: "g", family: "general_makesafe", reportType: null, siteAddress: "x", siteSuburb: null, companyName: "MLB" },
  );
  assertEquals(r.reason, "notify_disabled");
  assertEquals(client._inserts.length, 0);
  assertEquals(sent.length, 0);
});

Deno.test("notify send: no dedup key -> skip (never texts a keyless WO)", async () => {
  const client = makeNotifyClient();
  const r = await sendMakesafeArrivalTexts(
    client,
    S,
    { sendSms: async () => true },
    { orgId: "org", externalRef: null, graphMessageId: null, family: "general_makesafe", reportType: null, siteAddress: "x", siteSuburb: null, companyName: "MLB" },
  );
  assertEquals(r.reason, "no_dedup_key");
});

Deno.test("notify: loadNotifySettings falls back to seeded defaults on read error", async () => {
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "no table" } }) }) }) }),
  } as any;
  const s = await loadNotifySettings(client);
  assertEquals(s.notify_enabled, true);
  assertEquals(s.arrival_general_phones, DEFAULT_NOTIFY_SETTINGS.arrival_general_phones);
  assertEquals(s.arrival_roof_phones, DEFAULT_NOTIFY_SETTINGS.arrival_roof_phones);
});
