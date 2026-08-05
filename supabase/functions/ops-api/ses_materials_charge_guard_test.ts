import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideStandardLabourMaterialsCharge,
  MATERIALS_CHARGE_FIGURE_REQUIRED,
  positiveMaterialsChargeExGst,
  recordedMaterialsUsed,
} from "./ses_materials_charge_guard.ts";

Deno.test("recordedMaterialsUsed drops none/placeholder ticks and keeps real materials", () => {
  assertEquals(
    recordedMaterialsUsed([
      "Polycarb sheet x 1",
      "Other / none",
      "None",
      "  ",
      "n/a",
      "Tarps / roof materials",
    ]),
    ["Polycarb sheet x 1", "Tarps / roof materials"],
  );
  assertEquals(recordedMaterialsUsed("One weatherproof sheet installed."), [
    "One weatherproof sheet installed.",
  ]);
  assertEquals(recordedMaterialsUsed([]), []);
  assertEquals(recordedMaterialsUsed(null), []);
  assertEquals(recordedMaterialsUsed("None"), []);
  assertEquals(
    recordedMaterialsUsed([
      { key: "tarp", selected: true, label: "Tarps / roof materials" },
      { key: "none", selected: false, label: "Other / none" },
    ]),
    ["Tarps / roof materials"],
  );
});

Deno.test("positiveMaterialsChargeExGst rejects zero and non-numbers", () => {
  assertEquals(positiveMaterialsChargeExGst(65), 65);
  assertEquals(positiveMaterialsChargeExGst("65.5"), 65.5);
  assertEquals(positiveMaterialsChargeExGst(0), null);
  assertEquals(positiveMaterialsChargeExGst(-1), null);
  assertEquals(positiveMaterialsChargeExGst("x"), null);
});

Deno.test("silent labour-only when materials_used is present must ask one figure", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Polycarb disposal / tipping", "Screws x 20"],
    materials_charge_ex_gst: null,
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "ask_one_figure");
  if (decision.action !== "ask_one_figure") return;
  assertEquals(decision.reason_code, MATERIALS_CHARGE_FIGURE_REQUIRED);
  assertEquals(decision.materials, [
    "Polycarb disposal / tipping",
    "Screws x 20",
  ]);
});

Deno.test("an operator materials_charge_ex_gst produces one charge line", () => {
  const decision = decideStandardLabourMaterialsCharge({
    materials_used: ["Polycarb disposal / tipping"],
    materials_charge_ex_gst: 65,
    priced_materials_line_count: 0,
  });
  assertEquals(decision.action, "charge_line");
  if (decision.action !== "charge_line") return;
  assertEquals(decision.amount_ex_gst, 65);
  assertEquals(decision.materials, ["Polycarb disposal / tipping"]);
});

Deno.test("typed priced materials lines satisfy the guard without a one-figure field", () => {
  assertEquals(
    decideStandardLabourMaterialsCharge({
      materials_used: ["Tarps / roof materials"],
      materials_charge_ex_gst: null,
      priced_materials_line_count: 1,
    }),
    { action: "none" },
  );
});

Deno.test("empty materials_used allows labour-only proposals", () => {
  assertEquals(
    decideStandardLabourMaterialsCharge({
      materials_used: ["Other / none"],
      materials_charge_ex_gst: null,
      priced_materials_line_count: 0,
    }),
    { action: "none" },
  );
});
