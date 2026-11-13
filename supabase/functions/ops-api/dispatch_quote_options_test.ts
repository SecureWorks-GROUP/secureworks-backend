// deno-lint-ignore-file no-import-prefix
// Ruling 14 step 1 (contract 4.4): a taken supplier option is one more sealed
// order line; an untaken one, a crew one and an office one are not.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { takenOptionOrderItems } from "./dispatch_quote_options.ts";
import { dispatchSuggestedLines } from "./dispatch_materials.ts";

const LIGHTS = {
  id: "lights", name: "Two downlights", goes: "supplier",
  sealed: { order_line: { id: "sl-1", description: "LED downlight", quantity: 2, unit: "each", colour: null, supplierId: "elec", supplierName: "Sparky Supplies" } },
};
const FENCE_GATE = {
  id: "gate", name: "Extra gate", goes: "supplier",
  sealed: { order_line: { id: "fx-1", description: "Gate kit", quantity: 1, unit: "each", colour: null, supplierName: "" } },
};
const CREW = { id: "c", name: "Crew", goes: "crew", sealed: { labour_line: { description: "x", total: 100 } } };
const OFFICE = { id: "o", name: "Skip", goes: "office", sealed: { office_line: { description: "Skip", quantity: 1 } } };

Deno.test("R14 dispatch: a taken supplier option is one sealed order line in its supplier's box", () => {
  const out = takenOptionOrderItems([LIGHTS, CREW, OFFICE]);
  assertEquals(out.items.map((i) => [i.description, i.quantity, i.unit, i.scope_line_id, i.supplier_id, i.supplier_name]),
    [["LED downlight", 2, "each", "sl-1", "elec", "Sparky Supplies"]]);
  assertEquals(out.notes, ["Taken quote option on this order: Two downlights."]);
  assertEquals(dispatchSuggestedLines(out.items).length, 1);
});

Deno.test("R14 dispatch: a fence option with no supplier is held on the draft list, never in a guessed box", () => {
  const out = takenOptionOrderItems([FENCE_GATE]);
  assertEquals(out.items.map((i) => [i.description, i.supplier_id]), [["Gate kit", null]]);
});

Deno.test("R14 dispatch: nothing taken adds nothing; a taken supplier line that gives no order line holds the fill", () => {
  assertEquals(takenOptionOrderItems([]), { state: "read", items: [], notes: [] });
  // Missing, empty, no description, or an office fixing: never "on the order" while dropped.
  for (const sealed of [
    {},
    { order_line: {} },
    { order_line: { id: "z", quantity: 1, unit: "each", supplierName: "Sparky Supplies" } },
    { order_line: { id: "z", description: "Screws", quantity: 1, unit: "box", supplierId: "office", supplierName: "Office" } },
  ]) {
    assertEquals(takenOptionOrderItems([LIGHTS, { id: "x", name: "Mystery", goes: "supplier", sealed }]),
      { state: "unusable", option_ids: ["x"] }, JSON.stringify(sealed));
  }
});

Deno.test("R14 dispatch: both fills add the taken options and refuse an unreadable record, pinned by source", () => {
  for (const file of ["./dispatch_v2_store.ts", "./dispatch_materials_store.ts"]) {
    const src = Deno.readTextFileSync(new URL(file, import.meta.url));
    const at = src.indexOf("await takenQuoteOptionOrderItems(client, job.id)");
    if (at < 0) throw new Error(`${file}: taken options not read`);
    const block = src.slice(at, at + 600);
    if (!block.includes('taken.state === "unreadable"') || !block.includes('"quote_options_unreadable"')) {
      throw new Error(`${file}: an unreadable option record must fill nothing`);
    }
    if (!block.includes('taken.state === "unusable"') || !block.includes('"quote_option_line_unusable"')) {
      throw new Error(`${file}: an unusable taken line must fill nothing`);
    }
  }
});

Deno.test("R14 dispatch: a taken supplier line Dispatch never puts on supplier copy holds both fills, never 'on this order' while dropped", () => {
  for (const description of ["Concrete bags for extra posts", "Concrete footings", "Tek screws 12g", "Delivery fee", "Labour to fit", "Removal of old sheets"]) {
    const sealed = { order_line: { id: "z", description, quantity: 2, unit: "each", supplierId: "elec", supplierName: "Sparky Supplies" } };
    assertEquals(takenOptionOrderItems([LIGHTS, { id: "x", name: "Extra", goes: "supplier", sealed }]),
      { state: "unusable", option_ids: ["x"] }, description);
  }
  // A line both fills keep is still read, with its note.
  const ok = takenOptionOrderItems([LIGHTS]);
  assertEquals(ok.state, "read");
});

Deno.test("R14 dispatch: the v2 fill never skips a taken option silently, pinned by source", () => {
  const src = Deno.readTextFileSync(new URL("./dispatch_v2_store.ts", import.meta.url));
  const at = src.indexOf("for (const item of taken.items) {");
  if (at < 0) throw new Error("the taken option loop moved");
  const block = src.slice(at, src.indexOf("notes.push(...taken.notes);", at));
  if (/\bcontinue\b/.test(block)) throw new Error("a taken option is skipped while its note says it is on the order");
  if (!block.includes('"quote_option_line_unusable"')) throw new Error("a line the fill cannot keep must refuse");
});
