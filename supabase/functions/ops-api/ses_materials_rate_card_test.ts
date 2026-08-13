// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  priceRecordedMaterialsFromRateCard,
  readSesMaterialsRateCard,
  SES_MATERIALS_RATE_CARD_MARKDOWN,
} from "./ses_materials_rate_card.ts";

Deno.test("the executable rate card parses the canonical markdown, not a numeric twin", () => {
  const card = readSesMaterialsRateCard();
  assertEquals(card.flashingTape, 25);
  assertEquals(card.silicone, 25);
  assertEquals(card.starPicket, 13.5);
  assertEquals(card.consumablesStandard, 25);
  assertEquals(card.tarpBands, [
    { upToSquareMetres: 10.8, amount: 80 },
    { upToSquareMetres: 19.8, amount: 110 },
    { upToSquareMetres: 29.9, amount: 145 },
    { upToSquareMetres: 55.5, amount: 190 },
  ]);
  assertEquals(card.proposalBasketFloor, 45);
  assertEquals(card.roundMultiple, 5);
  assertEquals(
    SES_MATERIALS_RATE_CARD_MARKDOWN.includes("# Materials rate card"),
    true,
  );
});

Deno.test("settled silicone and tape retain whole-unit lines from the markdown", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Silicone x 1",
    "Flashing tape x 0.4m",
  ]);
  assertEquals(result.kind, "settled");
  if (result.kind !== "settled") return;
  assertEquals(
    result.lines.map((line) => ({
      quantity: line.quantity,
      unit_price_ex_gst: line.unit_price_ex_gst,
    })),
    [
      { quantity: 1, unit_price_ex_gst: 25 },
      { quantity: 1, unit_price_ex_gst: 25 },
    ],
  );
});

Deno.test("nails and timber propose from card evidence and style upward", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Nails x 5",
    "Timber x 0.2m",
  ]);
  assertEquals(result.kind, "proposal");
  if (result.kind !== "proposal") return;
  assertEquals(result.raw_amount_ex_gst, 70);
  assertEquals(result.amount_ex_gst, 71);
  assertEquals(result.rate_card_keys, [
    "cable_ties_consumables",
    "accepted_materials_basket_floor",
  ]);
  assertEquals(result.materials.map((fact) => fact.quantity), [5, 0.2]);
  assertEquals(result.provenance.captain_review_required, true);
});

Deno.test("36 square metres of tarp plus quantified clips selects the tarp band and non-round styling", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Make-safe tarp x 36m2",
    "Clips x 30",
  ]);
  assertEquals(result.kind, "proposal");
  if (result.kind !== "proposal") return;
  assertEquals(result.raw_amount_ex_gst, 215);
  assertEquals(result.amount_ex_gst, 216);
  assertEquals(result.rate_card_keys, [
    "tarpaulin",
    "cable_ties_consumables",
  ]);
  assertEquals(result.materials.map((fact) => fact.quantity), [36, 30]);
});

Deno.test("object-form report quantities survive into a review proposal", () => {
  const result = priceRecordedMaterialsFromRateCard([
    { label: "Dehumidifier", quantity: 1, unit: "each" },
    { label: "Fans", quantity: 3, unit: "each" },
    { label: "Green tape", quantity: 15, unit: "m" },
  ]);
  assertEquals(result.kind, "proposal");
  if (result.kind !== "proposal") return;
  assertEquals(result.raw_amount_ex_gst, 45);
  assertEquals(result.amount_ex_gst, 46);
  assertEquals(result.materials.map((fact) => fact.quantity), [1, 3, 15]);
});

Deno.test("an absent quantity stays review-only instead of being invented", () => {
  const result = priceRecordedMaterialsFromRateCard(["Timber"]);
  assertEquals(result, {
    kind: "unquantified",
    materials: [{ label: "Timber", quantity: null, unit: null }],
  });
});
