// ════════════════════════════════════════════════════════════
// B5 — SLA LATENCY TESTS (email received -> card created)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Covers computeLatencySla percentiles + edge cases.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_intake_sla_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeLatencySla } from "./makesafe_intake_sla.ts";

// helper: build a row that is `sec` seconds slow.
function row(sec: number) {
  const rec = new Date("2026-07-04T02:00:00.000Z");
  const cre = new Date(rec.getTime() + sec * 1000);
  return { received_at: rec.toISOString(), created_at: cre.toISOString() };
}

Deno.test("SLA: empty input -> all zero, 0 samples", () => {
  assertEquals(computeLatencySla([]), { samples: 0, p50_sec: 0, p95_sec: 0, max_sec: 0 });
  assertEquals(computeLatencySla(null), { samples: 0, p50_sec: 0, p95_sec: 0, max_sec: 0 });
});

Deno.test("SLA: single row -> p50=p95=max=that latency", () => {
  const r = computeLatencySla([row(90)]);
  assertEquals(r.samples, 1);
  assertEquals(r.p50_sec, 90);
  assertEquals(r.p95_sec, 90);
  assertEquals(r.max_sec, 90);
});

Deno.test("SLA: percentiles over a known spread", () => {
  // Ten drafts: 30,60,90,120,150,180,210,240,270,300 sec.
  const rows = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300].map(row);
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 10);
  // nearest-rank p50 over 10 items = index ceil(0.5*10)-1 = 4 -> 150
  assertEquals(r.p50_sec, 150);
  // p95 over 10 = ceil(0.95*10)-1 = 9 -> 300
  assertEquals(r.p95_sec, 300);
  assertEquals(r.max_sec, 300);
});

Deno.test("SLA: rows missing a timestamp are excluded", () => {
  const rows = [
    row(60),
    { received_at: null, created_at: "2026-07-04T02:01:00Z" },
    { received_at: "2026-07-04T02:00:00Z", created_at: null },
    { received_at: "nonsense", created_at: "also-bad" },
  ];
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 1);
  assertEquals(r.max_sec, 60);
});

Deno.test("SLA: negative latency (clock skew) is dropped, never counted", () => {
  // created_at BEFORE received_at -> negative delta -> excluded.
  const rows = [
    { received_at: "2026-07-04T02:05:00Z", created_at: "2026-07-04T02:00:00Z" },
    row(120),
  ];
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 1);
  assertEquals(r.max_sec, 120);
});

Deno.test("SLA: seconds are rounded", () => {
  const rec = new Date("2026-07-04T02:00:00.000Z");
  const cre = new Date(rec.getTime() + 90_400); // 90.4s
  const r = computeLatencySla([{ received_at: rec.toISOString(), created_at: cre.toISOString() }]);
  assertEquals(r.max_sec, 90);
});
