// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listMaterialsAiPlacements,
  MaterialsAiError,
  placementView,
  settingsPatch,
  undoMaterialsAiPlacement,
  updateMaterialsAiSettings,
} from "./materials_ai.ts";

const ID = "11111111-2222-4333-8444-555555555555";

Deno.test("AI bill reader: placement view falls back to placed", () => {
  assertEquals(placementView(null), "placed");
  assertEquals(placementView("UNDONE"), "undone");
  assertEquals(placementView("anything"), "placed");
});

Deno.test("AI bill reader: settings accept only bounded values", () => {
  assertEquals(settingsPatch({ confidence_bar: 0.9123 }), { confidence_bar: 0.912 });
  assertEquals(settingsPatch({ enabled: false, daily_call_cap: 0 }), { enabled: false, daily_call_cap: 0 });
  assertThrows(() => settingsPatch({ confidence_bar: 1 }), MaterialsAiError);
  assertThrows(() => settingsPatch({ daily_call_cap: 2.5 }), MaterialsAiError);
  assertThrows(() => settingsPatch({}), MaterialsAiError);
});

Deno.test("AI bill reader: an unreadable placement list is an error, never empty", async () => {
  const q: any = {
    select: () => q, in: () => q, is: () => q, eq: () => q, not: () => q, gte: () => q,
    order: () => q, limit: () => Promise.resolve({ data: null, error: { message: "boom" } }),
  };
  const err = await assertRejects(
    () => listMaterialsAiPlacements({ from: () => q }, { view: "placed" }),
    MaterialsAiError,
  );
  assertEquals(err.status, 503);
});

Deno.test("AI bill reader: undo passes the actor and maps a refusal to 409", async () => {
  const calls: any[] = [];
  const ok = {
    rpc: (name: string, args: any) => {
      calls.push([name, args]);
      return Promise.resolve({ data: { outcome: "undone" }, error: null });
    },
  };
  assertEquals(
    await undoMaterialsAiPlacement(ok, { placementId: ID, actor: "user:jan", note: "wrong job" }),
    { ok: true, outcome: "undone" },
  );
  assertEquals(calls[0], ["materials_ai_undo", { p_placement: ID, p_actor: "user:jan", p_note: "wrong job" }]);

  const refused = {
    rpc: () => Promise.resolve({ data: null, error: { message: "undo_refused: a person changed this bill since" } }),
  };
  const err = await assertRejects(
    () => undoMaterialsAiPlacement(refused, { placementId: ID, actor: "user:jan" }),
    MaterialsAiError,
  );
  assertEquals(err.status, 409);
  assertEquals(err.message, "a person changed this bill since");
  await assertRejects(() => undoMaterialsAiPlacement(ok, { placementId: "x", actor: "a" }), MaterialsAiError);
});

Deno.test("AI bill reader: a person's bar change is logged in the bar history", async () => {
  let written: any = null;
  const table: any = {
    select: () => table,
    eq: () => table,
    single: () => Promise.resolve(
      written ? { data: written, error: null } : { data: { confidence_bar: 0.85, bar_history: [] }, error: null },
    ),
    update: (row: any) => {
      written = row;
      return table;
    },
  };
  const out: any = await updateMaterialsAiSettings({ from: () => table }, { body: { confidence_bar: 0.9 }, actor: "user:jan" });
  assertEquals(out.ok, true);
  assertEquals(written.confidence_bar, 0.9);
  assertEquals(written.bar_history.length, 1);
  assertEquals(written.bar_history[0].from, 0.85);
  assertEquals(written.bar_history[0].why, "person");
});
