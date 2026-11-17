/**
 * P0-14.3 and P0-14.4: what one daily-digest request does, the stored read's
 * body, the Perth Monday, and where the build's pieces sit in index.ts.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { digestMode, isMondayPerth, storedDigestBody } from "./digest_mode.ts";

Deno.test("digestMode: who builds, who reads", () => {
  const cases: Array<[string | null, string, boolean, string]> = [
    // no action: the old timer's shape still builds; everyone else reads
    [null, "POST", true, "build"],
    [null, "GET", true, "stored"],
    [null, "GET", false, "stored"],
    [null, "POST", false, "stored"],
    // build and canary need the server
    ["build", "POST", true, "build"],
    ["build", "POST", false, "forbidden"],
    ["canary", "POST", true, "canary"],
    ["canary", "GET", false, "forbidden"],
    // latest is the stored read by name
    ["latest", "GET", false, "stored"],
    ["latest", "POST", true, "stored"],
    // named actions above the full run keep their own branches
    ["weekly_pulse", "GET", false, "other"],
    ["weekly_pulse", "POST", true, "other"],
  ];
  for (const [action, method, isServerCaller, want] of cases) {
    assertEquals(
      digestMode({ action, method, isServerCaller }),
      want,
      `${action} ${method} ${isServerCaller}`,
    );
  }
});

Deno.test("storedDigestBody keeps the digest and marks it stored", () => {
  const body = storedDigestBody({
    digest_date: "2026-11-16",
    digest_json: {
      alerts: [{ title: "A" }],
      ai_narrative: "N",
      summary_text: "S",
      status: "amber",
    },
  });
  assertEquals(body.alerts, [{ title: "A" }]);
  assertEquals(body.ai_narrative, "N");
  assertEquals(body.summary_text, "S");
  assertEquals(body.stored, true);
  assertEquals(body.digest_date, "2026-11-16");
  assertEquals("not_built_yet" in body, false);
});

Deno.test("storedDigestBody with no row says not built yet", () => {
  assertEquals(storedDigestBody(null), {
    alerts: [],
    summary_text: "",
    stored: true,
    digest_date: null,
    not_built_yet: true,
  });
});

Deno.test("isMondayPerth reads the Perth day, not the UTC day", () => {
  // Sunday 23:00 UTC is Monday 07:00 in Perth: the daily build's Monday run.
  assert(isMondayPerth(new Date("2026-11-15T23:00:00.000Z")));
  assert(isMondayPerth(new Date("2026-11-16T15:59:00.000Z")));
  assert(!isMondayPerth(new Date("2026-11-16T16:00:00.000Z")));
  assert(!isMondayPerth(new Date("2026-11-15T15:59:00.000Z")));
  // The weekly test chats' timer: Sunday 21:30 UTC is Monday 05:30 Perth.
  assert(isMondayPerth(new Date("2026-11-15T21:30:00.000Z")));
});

// ── Source text: where things run ─────────────────────────────

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = SOURCE.indexOf("\nasync function ", start + 1);
  const nextFn = SOURCE.indexOf("\nfunction ", start + 1);
  const ends = [next, nextFn].filter((i) => i > 0);
  return SOURCE.slice(start, ends.length ? Math.min(...ends) : undefined);
}

// The request handler from the mode gate to its end: the full run.
const HANDLER = functionBody("_dailyDigestRequestHandlerForTest");
const GATE = HANDLER.indexOf("digestMode(");
const FULL_RUN = HANDLER.slice(GATE);

Deno.test("the full build starts only after the mode gate, and only on build", () => {
  assert(GATE > 0, "digestMode( is not called in the handler");
  assertEquals(HANDLER.slice(0, GATE).includes("generateDigest("), false);
  // Every other mode has returned before the full run's try.
  const tryAt = FULL_RUN.indexOf("\n  try {");
  const gateBlock = FULL_RUN.slice(0, tryAt);
  for (const mode of ["forbidden", "canary", "stored", "other"]) {
    assert(
      gateBlock.includes(`'${mode}'`),
      `the gate does not return for ${mode}`,
    );
  }
  assert(
    FULL_RUN.slice(tryAt).includes("generateDigest("),
    "generateDigest( is not in the build",
  );
});

Deno.test("the stored read makes one digest read, no model call, and fetches only through the pack trigger", () => {
  const stored = functionBody("storedDigestRead");
  assertEquals(stored.split(".from('daily_digests')").length - 1, 1);
  assertEquals(stored.split(".from(").length - 1, 1);
  assertEquals(/\bfetch\(/.test(stored), false);
  assertEquals(/fetchWithTimeout|anthropic|generate[A-Z]/.test(stored), false);
  assert(stored.includes("runCompletionPackTrigger(sb)"));
});

Deno.test("the test chats run only in the canary branch", () => {
  const calls = [...SOURCE.matchAll(/runCanaryChecks\(/g)].map((m) => m.index!);
  // The definition, plus the one call inside runCanaryMode.
  const def = SOURCE.indexOf("async function runCanaryChecks(");
  const canary = functionBody("runCanaryMode");
  const canaryStart = SOURCE.indexOf(canary);
  const outside = calls.filter((i) =>
    i !== def + "async function ".length &&
    !(i > canaryStart && i < canaryStart + canary.length)
  );
  assertEquals(outside, []);
  assertEquals(FULL_RUN.includes("runCanaryChecks("), false);
});

Deno.test("each weekly piece in the build runs only inside the Perth Monday block", () => {
  const monday = FULL_RUN.indexOf("if (isMondayPerth(new Date())) {");
  assert(monday > 0, "no Monday block in the build");
  // The block ends at the first line indented as its own `if`.
  const close = FULL_RUN.indexOf("\n    }\n", monday);
  const inside = FULL_RUN.slice(monday, close);
  const outside = FULL_RUN.slice(0, monday) + FULL_RUN.slice(close);
  for (
    const fn of [
      "generateLearningDigest(",
      "evaluateGraduation(",
      "generateWeeklyPulse(",
      "analyzeAIPerformance(",
      "generateObservationReport(",
      "generateShadowReport(",
      "generateWeeklyLetter(",
    ]
  ) {
    assert(inside.includes(fn), `${fn} is not in the Monday block`);
    assertEquals(
      outside.includes(fn),
      false,
      `${fn} runs outside the Monday block`,
    );
  }
  // Graduation downgrades stay daily.
  assert(outside.includes("checkGraduationDowngrades("));
});

Deno.test("no day-of-week check reads the UTC day", () => {
  assertEquals(/\.getDay\(\)/.test(SOURCE), false);
});
