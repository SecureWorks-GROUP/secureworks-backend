// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildSesMeasurementGeneration,
  canonicalJson,
  type HashableCard,
  sesCardInputFacts,
  sesCardInputHash,
} from "../ses-measurement-generation.ts";

function card(overrides: Partial<HashableCard> = {}): HashableCard {
  return {
    job_id: "11111111-1111-4111-8111-111111111111",
    job_ref: "SWMS-260001",
    job_status: "in_progress",
    archived: false,
    family: "physical_makesafe",
    family_refusal: null,
    stage: "allocated",
    computed_stage: "allocated",
    display_overlay_stage: null,
    substatus: "scheduled",
    company_slug: "mlb",
    cycle_number: 1,
    reattend_boundary: false,
    completion_photo_count: 5,
    inventory: {
      builder_wo_doc: { present: true, detail: "typed work_order row" },
      prime_link: { present: false, detail: "no typed link" },
      trade_report: { present: true, count: 1, detail: "submitted" },
      photos_media: { present: true, count: 5, detail: "5 photos" },
      swms: { present: false, detail: "no SWMS" },
      invoice: { present: false, detail: "no live ACCREC invoice" },
      po: { present: true, detail: "PO recovered from external_ref" },
    },
    ...overrides,
  };
}

Deno.test("canonical JSON sorts keys at every depth", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  // Array order is meaningful and must NOT be sorted away.
  assertNotEquals(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

Deno.test("canonical JSON treats absent and undefined optionals alike", () => {
  assertEquals(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

Deno.test("the same card facts hash identically across runs", async () => {
  assertEquals(await sesCardInputHash(card()), await sesCardInputHash(card()));
});

// This is the whole point of the drift key: a card that moved underneath an
// approved apply must stop matching.
Deno.test("any fact that drives family, stage or verdict moves the hash", async () => {
  const base = await sesCardInputHash(card());
  const movers: Array<Partial<HashableCard>> = [
    { family: "own_template_roof" },
    { stage: "report_ready" },
    { computed_stage: "archive" },
    { display_overlay_stage: "archive" },
    { job_status: "complete" },
    { archived: true },
    { substatus: "admin_to_send_report" },
    { company_slug: "bw" },
    { cycle_number: 2 },
    { reattend_boundary: true },
    { completion_photo_count: 4 },
    { family_refusal: "unknown family" },
  ];
  for (const mover of movers) {
    assertNotEquals(
      await sesCardInputHash(card(mover)),
      base,
      `${JSON.stringify(mover)} must move the input hash`,
    );
  }
});

Deno.test("an evidence presence change moves the hash", async () => {
  const base = await sesCardInputHash(card());
  const flipped = card({
    inventory: {
      ...card().inventory,
      swms: { present: true, detail: "no SWMS" },
    },
  });
  assertNotEquals(await sesCardInputHash(flipped), base);
});

Deno.test("an evidence count change moves the hash", async () => {
  const base = await sesCardInputHash(card());
  const fewer = card({
    inventory: {
      ...card().inventory,
      photos_media: { present: true, count: 4, detail: "5 photos" },
    },
  });
  assertNotEquals(await sesCardInputHash(fewer), base);
});

// Free-text provenance is measurement prose, not card state. Rewording a
// message must never invalidate an already-approved apply set.
Deno.test("rewording the free-text detail does NOT move the hash", async () => {
  const base = await sesCardInputHash(card());
  const reworded = card({
    inventory: {
      ...card().inventory,
      po: { present: true, detail: "purchase order read from external_ref" },
    },
  });
  assertEquals(await sesCardInputHash(reworded), base);
});

Deno.test("the hashed projection carries no free-text detail", () => {
  const facts = sesCardInputFacts(card());
  for (const [item, fact] of Object.entries(facts.evidence)) {
    assert(
      !("detail" in fact),
      `${item} leaked its free-text detail into the hash`,
    );
  }
  // ...and no client-shaped key reached it either.
  const serialized = canonicalJson(facts);
  for (
    const pattern of [
      /client_name/i,
      /client_phone/i,
      /client_email/i,
      /site_address/i,
      /@[a-z0-9.-]+\.[a-z]{2,}/i,
    ]
  ) {
    assert(!pattern.test(serialized), `hash input matched ${pattern}`);
  }
});

Deno.test("every evidence item is projected, present or not", () => {
  const facts = sesCardInputFacts(card({ inventory: {} }));
  assertEquals(Object.keys(facts.evidence).sort(), [
    "builder_wo_doc",
    "invoice",
    "photos_media",
    "po",
    "prime_link",
    "swms",
    "trade_report",
  ]);
});

// D.0 rule 3's independent-verification step is "a second agent re-runs the
// harness and reproduces the same generation hash". That is only possible if
// the id is content-derived.
Deno.test("the generation id is content-derived, not clock-derived", async () => {
  const cardHashes = [
    { job_id: "b", input_hash: "h2" },
    { job_id: "a", input_hash: "h1" },
  ];
  const first = await buildSesMeasurementGeneration({
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1 [NOT FINAL]",
    rulerContractVersion: "ruler/v1",
    cardHashes,
  });
  const later = await buildSesMeasurementGeneration({
    snapshotAt: "2026-08-02T12:34:56.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1 [NOT FINAL]",
    rulerContractVersion: "ruler/v1",
    cardHashes,
  });
  assertEquals(first.generation_id, later.generation_id);
  assertNotEquals(first.snapshot_at, later.snapshot_at);
});

Deno.test("read order does not change the generation id", async () => {
  const forward = await buildSesMeasurementGeneration({
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1",
    rulerContractVersion: "ruler/v1",
    cardHashes: [
      { job_id: "a", input_hash: "h1" },
      { job_id: "b", input_hash: "h2" },
    ],
  });
  const reversed = await buildSesMeasurementGeneration({
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1",
    rulerContractVersion: "ruler/v1",
    cardHashes: [
      { job_id: "b", input_hash: "h2" },
      { job_id: "a", input_hash: "h1" },
    ],
  });
  assertEquals(forward.generation_id, reversed.generation_id);
});

Deno.test("a different population or ruler is a different generation", async () => {
  const args = {
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1",
    rulerContractVersion: "ruler/v1",
    cardHashes: [{ job_id: "a", input_hash: "h1" }],
  };
  const base = await buildSesMeasurementGeneration(args);
  const otherPopulation = await buildSesMeasurementGeneration({
    ...args,
    populationContractVersion: "pop/v2",
  });
  const otherRuler = await buildSesMeasurementGeneration({
    ...args,
    rulerContractVersion: "ruler/v2",
  });
  assertNotEquals(base.generation_id, otherPopulation.generation_id);
  assertNotEquals(base.generation_id, otherRuler.generation_id);
});

Deno.test("a moved card moves the generation id", async () => {
  const args = {
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1",
    rulerContractVersion: "ruler/v1",
    cardHashes: [{ job_id: "a", input_hash: "h1" }],
  };
  const base = await buildSesMeasurementGeneration(args);
  const moved = await buildSesMeasurementGeneration({
    ...args,
    cardHashes: [{ job_id: "a", input_hash: "h1-changed" }],
  });
  assertNotEquals(base.generation_id, moved.generation_id);
});

Deno.test("the generation header carries every D.0 rule 3 field", async () => {
  const generation = await buildSesMeasurementGeneration({
    snapshotAt: "2026-08-01T00:00:00.000Z",
    populationContractVersion: "pop/v1",
    populationContract: "pop/v1 [NOT FINAL]",
    rulerContractVersion: "ruler/v1",
    cardHashes: [{ job_id: "a", input_hash: "h1" }],
  });
  assertEquals(Object.keys(generation).sort(), [
    "card_count",
    "generation_id",
    "population_contract",
    "population_contract_version",
    "ruler_contract_version",
    "snapshot_at",
  ]);
  assertEquals(generation.card_count, 1);
  assert(/^[0-9a-f]{64}$/.test(generation.generation_id));
});
