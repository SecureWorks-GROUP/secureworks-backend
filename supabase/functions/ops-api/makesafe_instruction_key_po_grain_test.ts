// deno-lint-ignore-file no-import-prefix
/**
 * Hostile probes for the captain's 2026-08-02 purchase-order grain ruling
 * (`data/decisions/2026-08-02-purchase-order-is-the-job-grain.md`).
 *
 * These are the four properties the ruling exists to guarantee, plus every
 * worked example the captain stated himself. The measurement that established
 * the ruling is safe against production is
 * `scripts/ses-identity-grain-measure.ts`; its findings are in
 * `docs/evidence/ses-identity-grain-conform-2026-08-02.md`.
 */
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  builderInstructionKey,
  builderInstructionKeysForCard,
  builderInstructionScope,
  declaredBuilderInstructionKeysForCard,
  distinctBuilderInstructionKeys,
  extractBuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";
import { matchExistingInstructionCards } from "./makesafe_instruction_mint_gate.ts";

function keyFor(
  text: string,
  options: { slug?: string | null; family?: string | null } = {},
): string | null {
  return builderInstructionKey(
    extractBuilderWorkOrderIdentity({
      externalRef: text,
      requestingCompanySlug: options.slug ?? null,
    }),
    { requestingCompanySlug: options.slug ?? null, family: options.family },
  );
}

// PROBE 1 — the failure that forced the ruling. One purchase order carried under
// two different group references produced two keys under the composite contract
// (`MLB-10001PO-44444` / `MLB-10002PO-44444`), so one job became two cards.
Deno.test("po grain: one purchase order under a drifted group reference is ONE key", () => {
  const drifts = [
    "MLB-10001PO-44444",
    "MLB-10002PO-44444", // different claim entirely — the probe that started this
    "MLB-RR-10001PO-44444", // business-unit infix
    "MLB 10001 PO 44444", // whitespace
    "mlb-10001po-44444", // case
    "MLB-10001-PO-44444", // hyphenation
    "MLB-10001PO-44444-R", // revision suffix outside the digit run
  ];
  const keys = new Set(drifts.map((text) => keyFor(text)));
  assertEquals([...keys], ["MLB:PO-44444"]);
});

// PROBE 2 — the opposite direction. Distinct purchase orders inside one
// work-order group must never collapse, or a real deliverable loses its card.
Deno.test("po grain: distinct purchase orders under one work-order group stay separate", () => {
  assertEquals(keyFor("MLB-26183PO-53995"), "MLB:PO-53995");
  assertEquals(keyFor("MLB-26183PO-54000"), "MLB:PO-54000");
  assertNotEquals(keyFor("MLB-26183PO-53995"), keyFor("MLB-26183PO-54000"));
});

// PROBE 3 — cross-builder collision. Production shows zero shared purchase-order
// digit runs across builders, but that is an observation over one PO-issuing
// builder, not a guarantee, so the scope is IN the key rather than assumed.
Deno.test("po grain: the same purchase-order digits never collide across builders", () => {
  const mlb = keyFor("MLB-26183PO-54000");
  const builderwest = keyFor("BWCWA-6781PO-54000");
  const bareUnderBuilderwest = keyFor("PO-54000", { slug: "bw" });
  const bareUnderMlb = keyFor("PO-54000", { slug: "mlb" });
  assertEquals(mlb, "MLB:PO-54000");
  assertEquals(builderwest, "BWCWA:PO-54000");
  assertNotEquals(mlb, builderwest);
  assertEquals(bareUnderBuilderwest, "BWCWA:PO-54000");
  assertEquals(bareUnderMlb, "MLB:PO-54000");
  // Builderwest (`bw`) and Western Building (`wb`) are two different builders
  // whose prefixes are near-anagrams. They must never share a scope.
  assertNotEquals(
    builderInstructionScope({ requestingCompanySlug: "bw" }),
    builderInstructionScope({ requestingCompanySlug: "wb" }),
  );
  // An unknown slug invents no scope.
  assertEquals(keyFor("PO-54000", { slug: "not-a-builder" }), null);
  assertEquals(keyFor("PO-54000"), null);
});

// PROBE 4 — the captain's own worked examples, each asserted as a CARD COUNT.
Deno.test("po grain: captain worked example — MLB-26183 with three POs gives three cards", () => {
  const keys = new Set([
    keyFor("MLB-26183PO-54000"),
    keyFor("MLB-26183PO-53995"),
    keyFor("MLB-26183PO-54281"),
  ]);
  assertEquals(keys.size, 3);
});

Deno.test("po grain: captain worked example — BWCWA6781 with PO-20877 and PO-20878 gives two cards", () => {
  const keys = new Set([
    keyFor("BWCWA6781 PO-20877", { slug: "bw" }),
    keyFor("BWCWA6781 PO-20878", { slug: "bw" }),
  ]);
  assertEquals(keys.size, 2);
  assertEquals([...keys].sort(), ["BWCWA:PO-20877", "BWCWA:PO-20878"]);
});

Deno.test("po grain: captain worked example — AJBR 67009 and AJBR 67010 give one card each", () => {
  assertEquals(keyFor("AJBR 67009"), "AJ:JOB-67009");
  assertEquals(keyFor("AJBR 67010"), "AJ:JOB-67010");
  assertNotEquals(keyFor("AJBR 67009"), keyFor("AJBR 67010"));
  // AJ spelling variants for the same digits are deliberately one identity
  // (Track A D7): ABJR is a live-mail typo of AJBR.
  for (
    const spelling of ["AJBR-67009", "AJBR67009", "ABJR 67009", "AJS 67009"]
  ) {
    assertEquals(keyFor(spelling), "AJ:JOB-67009");
  }
  // Ruling 13: a short digit run after an AJ prefix is junk, never an identity.
  assertEquals(keyFor("ABJR 1234"), null);
});

// PROBE 5 — the real production shape the composite key could NOT see. The
// archived card declares only `BWCWA6781` and carries the purchase order in its
// work-order filename; the live card declares `PO20877`. Under the composite
// contract the first yielded NO key at all, so the captain's own confirmed
// duplicate was invisible to the gate.
Deno.test("po grain: Builderwest duplicate is visible when the group ref and the PO sit on different cards", () => {
  const archived = builderInstructionKeysForCard({
    requestingCompanySlug: "bw",
    metadata: { external_ref: "BWCWA6781" },
    detailExternalRef: "BWCWA6781",
    attachmentNames: ["work_order_PO20877_Secure_Works_WA.pdf"],
  });
  const live = builderInstructionKeysForCard({
    requestingCompanySlug: "bw",
    metadata: {
      external_ref: "PO20877",
      builder_claim_ref: "BWCWA-6781",
      builder_po_number: "PO-20877",
    },
    detailExternalRef: "PO20877",
    attachmentNames: ["work_order_PO20877_Secure_Works_WA.pdf"],
  });
  assertEquals(archived, ["BWCWA:PO-20877"]);
  assertEquals(live, ["BWCWA:PO-20877"]);
  const matches = matchExistingInstructionCards(
    live,
    [{
      job_id: "job-archived",
      external_ref: "BWCWA6781",
      requesting_company_slug: "bw",
      jobs: { job_number: "BWCWA6781", status: "archived", metadata: {} },
    }],
    [{
      job_id: "job-archived",
      type: "work_order",
      file_name: "work_order_PO20877_Secure_Works_WA.pdf",
    }],
  );
  assertEquals(matches.length, 1);
  assertEquals(matches[0].jobNumber, "BWCWA6781");
});

// PROBE 6 — no claim-only fallback survives except AJ's. Western Building's
// reference carries a second per-instruction number (`WB69684-178656`) that a
// claim-only key silently discards, and KBA has no production row proving it is
// a one-deliverable builder either.
Deno.test("po grain: only AJ keeps a one-number identity", () => {
  assertEquals(keyFor("WB69684", { slug: "wb" }), null);
  assertEquals(keyFor("KBA-12345", { slug: "kba" }), null);
  assertEquals(keyFor("MLB-26183"), null);
  assertEquals(keyFor("BWCWA6781", { slug: "bw" }), null);
  assertEquals(keyFor("AJBR 67009"), "AJ:JOB-67009");
});

// PROBE 7 — repair keys on the work order, and only when the caller states the
// family. UNEXERCISED in production: zero of the 440 board cards carry the
// `repair` family at 2026-08-02, and the ruling flags its own repair reading as
// provisional, so nothing else may reach this branch by accident.
Deno.test("po grain: repair keys on the work order and cannot be reached without the family", () => {
  assertEquals(keyFor("MLB-26183", { family: "repair" }), "MLB:WO-26183");
  assertEquals(keyFor("MLB-26183", { family: "general_makesafe" }), null);
  assertEquals(keyFor("MLB-26183"), null);
  // A repair instruction that DOES carry a purchase order still keys on the PO:
  // the work-order grain is the fallback for having no PO, not an override.
  assertEquals(
    keyFor("MLB-26183PO-54000", { family: "repair" }),
    "MLB:PO-54000",
  );
  // The PO and WO grains occupy separate namespaces, so a repair work order can
  // never collide with a purchase order that happens to share its digits.
  assertNotEquals(
    keyFor("MLB-54000", { family: "repair" }),
    keyFor("MLB-26183PO-54000"),
  );
});

// PROBE 8 — multi-instruction input is enumerated, never silently reduced to one.
// The approval path refuses a draft carrying more than one DISTINCT canonical
// key (`index.ts`, "Instruction identity conflict"), which is what makes this
// enumeration a refusal rather than a guess.
Deno.test("po grain: a card carrying two purchase orders enumerates both keys", () => {
  const keys = builderInstructionKeysForCard({
    requestingCompanySlug: "mlb",
    metadata: { external_ref: "MLB-26183" },
    detailExternalRef: "MLB-26183",
    attachmentNames: [
      "work_order_MLB-26183PO-53995_Secureworks_Group_Pty_Ltd.pdf",
      "work_order_MLB-26183PO-54000_Secureworks_Group_Pty_Ltd.pdf",
    ],
  });
  assertEquals(keys, ["MLB:PO-53995", "MLB:PO-54000"]);
});

// PROBE 9 — one instruction carrying BOTH its work-order number and its PO is
// ONE identity, not a conflict. The live failure (2026-08-31): repair draft
// MLB-24645 / PO-59875 (22 Pitt Street, Pingelly) enumerated `MLB:PO-59875`
// from its structured triple and `MLB:WO-24645` from its bare external_ref,
// and Approve refused one work order as two instructions. The WO-grain key is
// the repair FALLBACK for having no PO (probe 7), so a DECLARED same-scope PO
// key subsumes it; nothing else does.
const pingellyIdentity = {
  requestingCompanySlug: "mlb",
  family: "repair",
  metadata: {
    external_ref: "MLB-24645",
    builder_claim_ref: "MLB-24645",
    builder_work_order_number: "MLB-24645",
    builder_po_number: "PO-59875",
  },
  detailExternalRef: "MLB-24645",
};

Deno.test("po grain: a repair WO carrying both numbers collapses to its one PO key", () => {
  const enumerated = builderInstructionKeysForCard({
    ...pingellyIdentity,
    attachmentNames: [
      "work_order_MLB-24645PO-59875_Secureworks_Group_Pty_Ltd.pdf",
    ],
  });
  // The enumeration itself deliberately still carries both readings — existing
  // -card matching needs the WO fallback so a WO-only re-send finds its card.
  assertEquals(enumerated, ["MLB:PO-59875", "MLB:WO-24645"]);
  // Pingelly DECLARES its purchase order in the typed triple, so a PO scope is
  // present in the declared set and authorises the collapse.
  assertEquals(
    declaredBuilderInstructionKeysForCard(pingellyIdentity),
    ["MLB:PO-59875", "MLB:WO-24645"],
  );
  assertEquals(
    distinctBuilderInstructionKeys(
      enumerated,
      declaredBuilderInstructionKeysForCard(pingellyIdentity),
    ),
    ["MLB:PO-59875"],
  );
});

// PROBE 9b — an OBSERVED purchase order is not ownership. MLB attaches every
// PDF of a claim to every card in that family, so a sibling job's work order
// sitting on this card yields a PO key the card does not own. Letting that key
// subsume the card's own work-order grain would collapse two instructions into
// one and then stamp the sibling's PO as this card's money reference, so the
// collapse requires the card's OWN DECLARED PO and this shape keeps refusing.
Deno.test("po grain: a PO read only off a sibling's attached filename never collapses the card's own WO", () => {
  const claimOnlyIdentity = {
    requestingCompanySlug: "mlb",
    family: "repair",
    metadata: {
      external_ref: "MLB-26344",
      builder_claim_ref: "MLB-26344",
    },
    detailExternalRef: "MLB-26344",
  };
  const enumerated = builderInstructionKeysForCard({
    ...claimOnlyIdentity,
    attachmentNames: ["work_order_PO-57087_Other_Job.pdf"],
  });
  assertEquals(enumerated, ["MLB:PO-57087", "MLB:WO-26344"]);
  // Nothing about this card declares a purchase order.
  assertEquals(declaredBuilderInstructionKeysForCard(claimOnlyIdentity), [
    "MLB:WO-26344",
  ]);
  assertEquals(
    distinctBuilderInstructionKeys(
      enumerated,
      declaredBuilderInstructionKeysForCard(claimOnlyIdentity),
    ),
    ["MLB:PO-57087", "MLB:WO-26344"],
  );
});

Deno.test("po grain: the collapse subsumes ONLY a same-scope DECLARED WO fallback", () => {
  const declared = (...keys: string[]) => keys;
  // Two purchase orders are still two instructions.
  assertEquals(
    distinctBuilderInstructionKeys(
      ["MLB:PO-53995", "MLB:PO-54000"],
      declared("MLB:PO-53995", "MLB:PO-54000"),
    ),
    ["MLB:PO-53995", "MLB:PO-54000"],
  );
  // A WO fallback under a DIFFERENT builder scope is another builder's
  // instruction and still conflicts.
  assertEquals(
    distinctBuilderInstructionKeys(
      ["MLB:PO-59875", "WB:WO-69684"],
      declared("MLB:PO-59875"),
    ),
    ["MLB:PO-59875", "WB:WO-69684"],
  );
  // Drifted group references beside one declared PO collapse onto the PO — the
  // same direction probe 1 pins for the composite string form.
  assertEquals(
    distinctBuilderInstructionKeys(
      ["MLB:PO-59875", "MLB:WO-24645", "MLB:WO-24646"],
      declared("MLB:PO-59875"),
    ),
    ["MLB:PO-59875"],
  );
  // A repair card with NO PO anywhere keeps its WO-grain identity untouched.
  assertEquals(
    distinctBuilderInstructionKeys(
      ["MLB:WO-24645"],
      declared("MLB:WO-24645"),
    ),
    ["MLB:WO-24645"],
  );
  // AJ's job-number grain is not a WO fallback and is never subsumed.
  assertEquals(
    distinctBuilderInstructionKeys(
      ["AJ:JOB-67009", "MLB:PO-54000"],
      declared("AJ:JOB-67009", "MLB:PO-54000"),
    ),
    ["AJ:JOB-67009", "MLB:PO-54000"],
  );
  // Fail closed: a caller that proves no declared provenance gets no collapse.
  assertEquals(
    distinctBuilderInstructionKeys(["MLB:PO-59875", "MLB:WO-24645"]),
    ["MLB:PO-59875", "MLB:WO-24645"],
  );
});

// PROBE 10 — the two SIDES of the mint gate deliberately read different grains.
// This card's own identity (the F9 conflict decision, the availability probe's
// candidate keys, and the mint reservation) is the DISTINCT set, so a card is
// only ever claimed at the grain that is genuinely its own instruction. The
// EXISTING-card side keeps the full enumeration, so a card that stored only its
// group reference is still findable. One MLB claim routinely hosts several
// purchase orders (MLB-26183 carried three, each its own card), so reserving
// the claim-grain WO fallback would lock every sibling PO out of the board.
function candidateKeysFor(input: {
  externalRef: string;
  claimRef?: string;
  workOrderNumber?: string;
  poNumber?: string;
  attachmentNames?: string[];
}): string[] {
  const identity = {
    requestingCompanySlug: "mlb",
    family: "repair",
    metadata: {
      external_ref: input.externalRef,
      builder_claim_ref: input.claimRef,
      builder_work_order_number: input.workOrderNumber,
      builder_po_number: input.poNumber,
    },
    detailExternalRef: input.externalRef,
  };
  return distinctBuilderInstructionKeys(
    builderInstructionKeysForCard({
      ...identity,
      attachmentNames: input.attachmentNames || [],
    }),
    declaredBuilderInstructionKeysForCard(identity),
  );
}

const pingellyCardRow = {
  job_id: "job-pingelly",
  external_ref: "MLB-24645",
  requesting_company_slug: "mlb",
  jobs: {
    job_number: "SWR-26001",
    status: "active",
    metadata: {
      makesafe_job_family: "repair",
      builder_claim_ref: "MLB-24645",
      builder_work_order_number: "MLB-24645",
      builder_po_number: "PO-59875",
    },
  },
};

Deno.test("po grain: a second distinct PO on the same claim is NOT blocked by the first repair card", () => {
  const sibling = candidateKeysFor({
    externalRef: "MLB-24645",
    claimRef: "MLB-24645",
    workOrderNumber: "MLB-24645",
    poNumber: "PO-60112",
  });
  assertEquals(sibling, ["MLB:PO-60112"]);
  assertEquals(
    matchExistingInstructionCards(sibling, [pingellyCardRow], []),
    [],
  );
});

Deno.test("po grain: a WO-only re-send of the SAME instruction still finds its card", () => {
  const resend = candidateKeysFor({
    externalRef: "MLB-24645",
    claimRef: "MLB-24645",
    workOrderNumber: "MLB-24645",
  });
  assertEquals(resend, ["MLB:WO-24645"]);
  const matches = matchExistingInstructionCards(
    resend,
    [pingellyCardRow],
    [],
  );
  assertEquals(matches.length, 1);
  assertEquals(matches[0].jobNumber, "SWR-26001");
});

Deno.test("po grain: a re-send carrying both numbers still finds the same card on its PO", () => {
  const resend = candidateKeysFor({
    externalRef: "MLB-24645",
    claimRef: "MLB-24645",
    workOrderNumber: "MLB-24645",
    poNumber: "PO-59875",
  });
  assertEquals(resend, ["MLB:PO-59875"]);
  const matches = matchExistingInstructionCards(
    resend,
    [pingellyCardRow],
    [],
  );
  assertEquals(matches.length, 1);
  assertEquals(matches[0].jobNumber, "SWR-26001");
});
