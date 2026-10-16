// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  priceRecordedMaterialsFromRateCard,
  readSesMaterialsRateCard,
  SES_MATERIALS_RATE_CARD_MARKDOWN,
} from "./ses_materials_rate_card.ts";

Deno.test("the executable rate card parses the canonical markdown, not a numeric twin", () => {
  const card = readSesMaterialsRateCard();
  assertEquals(card.flashingTape, 35);
  assertEquals(card.silicone, 35);
  assertEquals(card.timberLength, 17);
  assertEquals(card.bugleEach, 1);
  assertEquals(card.starPicket, 13.5);
  assertEquals(card.consumablesStandard, 25);
  assertEquals(card.tarpBands, [
    { upToSquareMetres: 10.8, amount: 150 },
    { upToSquareMetres: 19.8, amount: 185 },
    { upToSquareMetres: 29.9, amount: 230 },
    { upToSquareMetres: 55.5, amount: 275 },
  ]);
  assertEquals(card.proposalBasketFloor, 45);
  assertEquals(card.roundMultiple, 5);
  assertEquals(
    SES_MATERIALS_RATE_CARD_MARKDOWN.includes("# Materials rate card"),
    true,
  );
});

Deno.test("settled Sikaflex and tape bill the styled whole-unit lines", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Silicone x 1",
    "Flashing tape x 0.4m",
  ]);
  assertEquals(result.kind, "settled");
  if (result.kind !== "settled") return;
  assertEquals(
    result.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit_price_ex_gst: line.unit_price_ex_gst,
    })),
    [
      {
        description: "Materials used: Sikaflex x 1 (whole cartridge)",
        quantity: 1,
        unit_price_ex_gst: 36,
      },
      {
        description: "Materials used: Flashing tape x 1 (whole roll)",
        quantity: 1,
        unit_price_ex_gst: 36,
      },
    ],
  );
  assertEquals(result.omitted, []);
});

Deno.test("nails and a short timber length settle from the card", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Nails x 5",
    "Timber x 0.2m",
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
      { quantity: 1, unit_price_ex_gst: 17 },
    ],
  );
  assertEquals(result.omitted, []);
});

Deno.test("bugle screws inside the timber rate are not billed again", () => {
  const included = priceRecordedMaterialsFromRateCard([
    "Timber x 2.4m",
    "Bugle screws x 2",
  ]);
  assertEquals(included.kind, "settled");
  if (included.kind !== "settled") return;
  assertEquals(included.lines.length, 1);
  assertEquals(included.lines[0].unit_price_ex_gst, 17);
  assertEquals(
    included.lines.some((line) => /^Materials used: Bugle/.test(line.description)),
    false,
  );

  const extras = priceRecordedMaterialsFromRateCard([
    "Timber x 4.8m",
    "Bugle screws x 6",
  ]);
  assertEquals(extras.kind, "settled");
  if (extras.kind !== "settled") return;
  const bugles = extras.lines.find((line) =>
    line.description.startsWith("Materials used: Bugle")
  );
  assertEquals(bugles?.quantity, 2);
  assertEquals(bugles?.unit_price_ex_gst, 1);
});

Deno.test("36 square metres of tarp plus clips bills the extra-large band and the ties rate", () => {
  const result = priceRecordedMaterialsFromRateCard([
    "Make-safe tarp x 36m2",
    "Clips x 30",
  ]);
  assertEquals(result.kind, "settled");
  if (result.kind !== "settled") return;
  assertEquals(
    result.lines.map((line) => line.unit_price_ex_gst),
    [276, 25],
  );
  assertEquals(result.omitted, []);
});

Deno.test("object-form quantities are kept and unmatched ticks are not billed", () => {
  const result = priceRecordedMaterialsFromRateCard([
    { label: "Dehumidifier", quantity: 1, unit: "each" },
    { label: "Fans", quantity: 3, unit: "each" },
    { label: "Green tape", quantity: 15, unit: "m" },
  ]);
  assertEquals(result.kind, "unquantified");
  assertEquals(result.materials.map((fact) => fact.quantity), [1, 3, 15]);
});

Deno.test("an absent quantity stays review-only instead of being invented", () => {
  const result = priceRecordedMaterialsFromRateCard(["Timber"]);
  assertEquals(result, {
    kind: "unquantified",
    materials: [{ label: "Timber", quantity: null, unit: null }],
  });
});
