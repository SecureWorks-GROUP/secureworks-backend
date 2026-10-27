// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _extractMaterialsFromScopeForTest } from "./index.ts";
import {
  isOfficeFixingLine,
  isScopeEnginePatioRecord,
  scopeEngineMaterialLines,
} from "./scope_engine_materials.ts";

// As the Scope Engine patio tool saves it (scope-engine-v2 jobsystem.ts).
const record = {
  tool: "patio-scoper",
  version: "2.0",
  draft: { design: { widthMm: 7200, projectionMm: 4500, posts: 3 } },
  lines: [
    { id: "l-sheet", description: "Trimdek roof sheet 4,600, Surfmist", quantity: 10, unit: "sheet", colour: "Surfmist" },
    { id: "l-post", description: "100x100 SHS post 2,900", quantity: 3, unit: "length", colour: "Monument" },
    { id: "l-tbc", description: "Patioline gutter 7,400", quantity: null, unit: "length", colour: null },
    { id: "l-fix", description: "Tek screws 14g x 22", quantity: 200, unit: "each", colour: null, supplier: "office" },
    { id: "l-fix2", description: "Wafer heads", quantity: 50, unit: "each", colour: null, supplier: { id: "Office" } },
    { id: "l-blank", description: "  ", quantity: 1, unit: "each", colour: null },
  ],
};

Deno.test("a Scope Engine record lists its own lines, office fixings left off", () => {
  assertEquals(isScopeEnginePatioRecord(record), true);
  assertEquals(_extractMaterialsFromScopeForTest(record, null), [
    { description: "Trimdek roof sheet 4,600, Surfmist", quantity: 10, unit: "sheet", unit_price: 0 },
    { description: "100x100 SHS post 2,900", quantity: 3, unit: "length", unit_price: 0 },
    { description: "Patioline gutter 7,400", quantity: null, unit: "length", unit_price: 0 },
  ]);
  // The same record as a JSON string reads the same.
  assertEquals(
    _extractMaterialsFromScopeForTest(JSON.stringify(record), null),
    scopeEngineMaterialLines(record.lines),
  );
});

Deno.test("an engine record never falls back to dimension guesses or quote lines", () => {
  const empty = { ...record, lines: [] };
  const pricing = { items: [{ description: "Colorbond panels", quantity: 4, unit_price: 99 }] };
  assertEquals(_extractMaterialsFromScopeForTest(empty, pricing), []);
});

Deno.test("office supplier is read from supplier, supplierId or supplier_id", () => {
  assertEquals(isOfficeFixingLine({ supplier: "office" }), true);
  assertEquals(isOfficeFixingLine({ supplierId: " OFFICE " }), true);
  assertEquals(isOfficeFixingLine({ supplier_id: "office" }), true);
  assertEquals(isOfficeFixingLine({ supplier: "stratco" }), false);
  assertEquals(isOfficeFixingLine({}), false);
});

Deno.test("older patio and fence scopes are untouched", () => {
  assertEquals(isScopeEnginePatioRecord({ config: { length: 6000 } }), false);
  assertEquals(isScopeEnginePatioRecord({ tool: "patio-scoper" }), false);
  const old = _extractMaterialsFromScopeForTest({ config: { length: "6000", projection: "4000", roofing: "trimdek" } }, null);
  assertEquals(old[0].description.startsWith("Trimdek"), true);
});
