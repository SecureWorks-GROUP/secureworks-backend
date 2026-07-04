// ════════════════════════════════════════════════════════════
// B4 — NOISE GATE: known-builder pricing/disregard replies
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Proves a narrow set of pricing/enquiry/"please disregard"
// replies with NO WO PDF are dropped (no junk card), while the gate FAILS OPEN: a WO
// PDF or a genuine new-WO subject always survives, a report-capture pattern still
// reaches report handling, and an unknown new WO is never dropped by the noise rule.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_noise_gate_test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isGenuineNewWorkOrder,
  subjectIsKnownBuilderNoise,
} from "./makesafe_intake_gate.ts";

const BUILDER = "workorders@ajs.build"; // non-own-domain

Deno.test("B4: subjectIsKnownBuilderNoise matches pricing/disregard, not bare quote/query", () => {
  assert(subjectIsKnownBuilderNoise("Our Ref: MLB-25795 - pricing query"));
  assert(subjectIsKnownBuilderNoise("please disregard previous email"));
  assert(subjectIsKnownBuilderNoise("Disregard the last one"));
  assert(subjectIsKnownBuilderNoise("price enquiry re MLB-25795"));
  // Deliberately NOT noise:
  assertEquals(subjectIsKnownBuilderNoise("Assess and quote - 12 Smith St"), false);
  assertEquals(subjectIsKnownBuilderNoise("customer query about timing"), false);
  assertEquals(subjectIsKnownBuilderNoise(""), false);
});

Deno.test("B4: noise reply with NO PDF -> dropped (no draft)", () => {
  const g = isGenuineNewWorkOrder("Our Ref: MLB-25795 - pricing query", BUILDER, 0);
  assertEquals(g.ok, false);
  assertEquals(g.reason, "known_builder_noise");
});

Deno.test("B4 FAIL OPEN: noise subject but a WO PDF present -> kept as work_order", () => {
  const g = isGenuineNewWorkOrder("Our Ref: MLB-25795 - pricing query", BUILDER, 1);
  assertEquals(g.ok, true);
  assertEquals(g.kind, "work_order");
  assertEquals(g.reason, "work_order_pdf");
});

Deno.test("B4 FAIL OPEN: a genuine NEW WORK ORDER subject is never dropped as noise", () => {
  // Even if a stray noise word appeared, the positive new-WO subject wins first.
  const g = isGenuineNewWorkOrder("NEW WORK ORDER - MLB-26678 - pricing query note", BUILDER, 0);
  assertEquals(g.ok, true);
  assertEquals(g.reason, "new_work_order_subject");
});

Deno.test("B4 FAIL OPEN: a report-capture pattern (no noise) still reaches report handling", () => {
  const g = isGenuineNewWorkOrder("Our Ref: MLB-25795 - 47 Hale St, Eaton - re-attend", BUILDER, 0);
  assertEquals(g.ok, true);
  assertEquals(g.kind, "report");
});

Deno.test("B4 FAIL OPEN: 'please disregard' reply with no PDF is dropped, but a plain unknown WO is not", () => {
  const dropped = isGenuineNewWorkOrder("please disregard my previous message", BUILDER, 0);
  assertEquals(dropped.ok, false);
  assertEquals(dropped.reason, "known_builder_noise");

  // An unknown/new-sender WO with a PDF but no ref/keyword is still captured.
  const kept = isGenuineNewWorkOrder("Site attendance needed 14 Jones Way", BUILDER, 1);
  assertEquals(kept.ok, true);
});
