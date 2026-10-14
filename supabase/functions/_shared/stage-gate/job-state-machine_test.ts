import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getKanbanStagesForType,
  getStagesForType,
  isLegalForType,
  MAKESAFE_STAGES,
  mapStatus,
} from "./job-state-machine.ts";

Deno.test("makesafe stage contract: simple operational pipeline only", () => {
  assertEquals(MAKESAFE_STAGES, [
    "accepted",
    "scheduled",
    "in_progress",
    "complete",
    "invoiced",
    "cancelled",
    "archived",
  ]);

  assertEquals(getStagesForType("makesafe"), MAKESAFE_STAGES);
  assertEquals(getKanbanStagesForType("makesafe"), MAKESAFE_STAGES);
});

Deno.test("makesafe stage contract: quote/deposit/material statuses are illegal", () => {
  for (
    const status of [
      "draft",
      "quoted",
      "partially_accepted",
      "awaiting_deposit",
      "approvals",
      "order_materials",
      "awaiting_supplier",
      "order_confirmed",
      "final_payment",
      "get_review",
    ]
  ) {
    assertEquals(
      isLegalForType(status, "makesafe"),
      false,
      `${status} must not be legal for makesafe`,
    );
  }
});

Deno.test("makesafe stage contract does not disturb existing job types", () => {
  assertEquals(isLegalForType("partially_accepted", "fencing"), true);
  assertEquals(isLegalForType("approvals", "patio"), true);
  assertEquals(isLegalForType("quoted", "quick_quote"), true);
  assertEquals(isLegalForType("quoted", "makesafe"), false);
});

Deno.test("paid close-out: get_review is a real fencing and patio stage, never make-safe or repair", () => {
  for (const type of ["fencing", "patio"]) {
    const stages = getStagesForType(type);
    assertEquals(isLegalForType("get_review", type), true, type);
    assertEquals(
      stages.indexOf("get_review"),
      stages.indexOf("invoiced") + 1,
      type,
    );
  }
  assertEquals(isLegalForType("get_review", "makesafe"), false);
  assertEquals(isLegalForType("get_review", "repair"), false);
  assertEquals(mapStatus("get_review").derived_view, false);
});
