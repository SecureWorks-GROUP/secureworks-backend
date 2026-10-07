// History depth PR B (7 Oct 2026): the one builder-reference tokenizer
// (_shared/makesafe_refs.ts builderRefTokens). The email reader writes its
// tokens on every Outlook row (payload.builder_refs) and its deep load keeps an
// email whose tokens include a monitored make-safe job's stored reference: both
// sides go through this function. Every reference here is made up.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  builderRefTokens,
  REF_PREFIX_FLOOR,
} from "../_shared/makesafe_refs.ts";
import { deepScopeFrom, timeMap } from "./handler.ts";

Deno.test("builder references: claims, MLB units, purchase orders, composites; canonical, distinct, in order", () => {
  for (
    const [text, want] of [
      ["Make safe AJBR 67134 please", ["AJBR-67134"]],
      ["ABJR-67134 (typo)", ["AJBR-67134"]],
      ["AJBR 1234 is too short", []],
      ["Order MS191190", ["MS-191190"]],
      ["Unit MLB-RR-24010", ["MLB-RR-24010"]],
      ["MLB-26537PO-56922", ["MLB-26537", "PO-56922"]],
      ["PO#56922 and po 12345", ["PO-56922", "PO-12345"]],
      ["MLB 26537, then MLB-26537 again", ["MLB-26537"]],
      ["Our job SWMS-26845 and SWP-26195", []],
      ["PO Box 1234, Perth", []],
      ["Make Safe 67005", []],
      ["", []],
    ] as const
  ) {
    assertEquals(builderRefTokens(text), [...want], text);
  }
  // A bare 5-digit reference counts only where asked (a job's own stored ref, an email subject).
  assertEquals(
    builderRefTokens("Make Safe 67005", REF_PREFIX_FLOOR, {
      bareNumeric: true,
    }),
    ["67005"],
  );
  assertEquals(
    builderRefTokens("RR-12345", REF_PREFIX_FLOOR, { bareNumeric: true }),
    [],
  );
  assertEquals(
    builderRefTokens("SWP-26195", REF_PREFIX_FLOOR, { bareNumeric: true }),
    [],
  );
  // A company prefix from makesafe_companies.parsing_rules.
  assertEquals(builderRefTokens("KBA88123", [...REF_PREFIX_FLOOR, "KBA"]), [
    "KBA-88123",
  ]);
  assertEquals(builderRefTokens("KBA88123"), []);
});

Deno.test("deep scope wiring: keys normalised as the reader reads mail, the earliest time kept, unreadable times dropped", () => {
  const s = deepScopeFrom({
    version: "email-deep-v1",
    jobs: 3,
    job_numbers: {
      "swf-26001": "2026-01-01T00:00:00.000Z",
      "SWF-26002": "not a time",
    },
    client_emails: { "Pat.One@Example.TEST": "2025-12-01T00:00:00.000Z" },
    builder_refs: {
      "MLB-26537PO-56922": "2026-01-01T00:00:00.000Z",
      "PO-56922": "2025-11-01T00:00:00.000Z",
      "67005": "2026-02-01T00:00:00.000Z",
    },
  }, REF_PREFIX_FLOOR);
  assertEquals(s.version, "email-deep-v1");
  assertEquals(s.jobs, 3);
  assertEquals([...s.jobNumbers], [[
    "SWF-26001",
    Date.parse("2026-01-01T00:00:00Z"),
  ]]);
  assertEquals([...s.clientEmails], [[
    "pat.one@example.test",
    Date.parse("2025-12-01T00:00:00Z"),
  ]]);
  assertEquals(
    [...s.builderRefs].sort(),
    [
      ["67005", Date.parse("2026-02-01T00:00:00Z")],
      ["MLB-26537", Date.parse("2026-01-01T00:00:00Z")],
      ["PO-56922", Date.parse("2025-11-01T00:00:00Z")],
    ],
  );
  assertEquals(timeMap(null, (k) => [k]).size, 0);
  assertEquals(timeMap([1, 2], (k) => [k]).size, 0);
});
