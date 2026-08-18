// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  emptySesCardEvidenceInventory,
  Q_PO_FLOOR,
  readSesCardEvidence,
  SES_ALL_CAPTAIN_QUESTIONS,
  SES_CAPTAIN_QUESTIONS,
  SES_EVIDENCE_FAMILIES,
  SES_EVIDENCE_ITEM_STANDING_QUESTIONS,
  SES_EVIDENCE_ITEMS,
  SES_EVIDENCE_REQUIREMENTS,
  SES_EVIDENCE_STAGES,
  SES_RESOLVED_CAPTAIN_QUESTIONS,
  sesCaptainQuestion,
  type SesCaptainQuestionId,
  type SesCardEvidenceInventory,
  type SesEvidenceFamily,
  sesEvidenceFamilyFromCard,
  sesEvidenceRequirement,
  type SesEvidenceStage,
} from "./makesafe_evidence_requirements.ts";

// ---------------------------------------------------------------------------
// The draft table, transcribed independently of the module.
//
// One line per (family, Ops display stage), seven letters in draft column order:
//   Builder WO | Prime/GHL | Trade report | Photos/media | SWMS | Invoice | PO
// R = REQUIRED, O = OPTIONAL, N = N-A, Q = QUESTION.
//
// Source: codex-evidence-ruler-draft-v1/report.md §§4.1-4.7, plus the two
// Captain rulings of 2026-08-01
// (data/decisions/2026-08-01-po-wo-invoice-ruling.md):
//
//   - `po_floor`, re-ruled: a purchase order is NOT required. The PO column is O
//     in all 49 rows — every family, every stage. The draft's Q and the
//     intervening R (the superseded "every card needs a po" answer) are both
//     gone from the table; both stay recorded on `Q_PO_FLOOR`.
//   - the work-order floor: a work order is required on EVERY card, no
//     exceptions. `builder_wo_doc` moves Q -> R at `completed` and `archive` for
//     every sealed family. It stays Q at `cancelled` (under the still-open
//     `cancelled_floor`).
//   - 2026-08-02 Docs Ready ruling: repair and restoration take the physical
//     evidence path while keeping family identity (sealed pack recipes).
// ---------------------------------------------------------------------------

const DRAFT_TABLE: Record<SesEvidenceFamily, Record<SesEvidenceStage, string>> =
  {
    // §4.1 General physical make-safe
    physical_makesafe: {
      new: "R N O O O O O",
      allocated: "R N O O O O O",
      trade_report_in: "R N R R O O O",
      report_ready: "R N Q Q Q Q O",
      completed: "R N Q Q Q R O",
      archive: "R N Q Q Q R O",
      cancelled: "Q N Q Q Q Q O",
    },
    // §4.2 Temporary-fence make-safe
    temporary_fencing: {
      new: "R N O O O O O",
      allocated: "R N O O O O O",
      trade_report_in: "R N R R O O O",
      report_ready: "R N Q Q Q Q O",
      completed: "R N Q Q Q R O",
      archive: "R N Q Q Q R O",
      cancelled: "Q N Q Q Q Q O",
    },
    // §4.3 Ordinary roof report, Prime portal mode
    ordinary_roof_portal: {
      new: "R O N N O O O",
      allocated: "R O N N O O O",
      trade_report_in: "R R N N O O O",
      report_ready: "R R N N Q Q O",
      completed: "R Q N N Q R O",
      archive: "R Q N N Q R O",
      cancelled: "Q Q N N Q Q O",
    },
    // §4.4 Own-document roof report (trade-report column is the roof PDF)
    own_template_roof: {
      new: "R N O N O O O",
      allocated: "R N O N O O O",
      trade_report_in: "R Q Q N O O O",
      report_ready: "R Q R N Q Q O",
      completed: "R Q Q N Q R O",
      archive: "R Q Q N Q R O",
      cancelled: "Q Q Q N Q Q O",
    },
    // §4.5 Assessment / quote
    assessment_quote: {
      new: "R O N O Q O O",
      allocated: "R O N O Q O O",
      trade_report_in: "R R N R Q O O",
      report_ready: "R R N R Q Q O",
      completed: "R Q N Q Q R O",
      archive: "R Q N Q Q R O",
      cancelled: "Q Q N Q Q Q O",
    },
    // §4.6 Repair — Captain 2026-08-02: match physical system
    repair: {
      new: "R N O O O O O",
      allocated: "R N O O O O O",
      trade_report_in: "R N R R O O O",
      report_ready: "R N Q Q Q Q O",
      completed: "R N Q Q Q R O",
      archive: "R N Q Q Q R O",
      cancelled: "Q N Q Q Q Q O",
    },
    // §4.7 Restoration — Captain 2026-08-02: same as any other job
    restoration: {
      new: "R N O O O O O",
      allocated: "R N O O O O O",
      trade_report_in: "R N R R O O O",
      report_ready: "R N Q Q Q Q O",
      completed: "R N Q Q Q R O",
      archive: "R N Q Q Q R O",
      cancelled: "Q N Q Q Q Q O",
    },
  };

const LETTER_TO_LEVEL: Record<string, string> = {
  R: "required",
  O: "optional",
  N: "not_applicable",
  Q: "question",
};

function present(
  overrides: Partial<SesCardEvidenceInventory> = {},
): SesCardEvidenceInventory {
  return { ...emptySesCardEvidenceInventory(), ...overrides };
}

/** An inventory holding every artifact, used to isolate ruler behaviour. */
function fullInventory(): SesCardEvidenceInventory {
  const inventory = emptySesCardEvidenceInventory();
  for (const item of SES_EVIDENCE_ITEMS) inventory[item] = { present: true };
  return inventory;
}

Deno.test("vocabulary is the seven families, seven stages and seven items", () => {
  assertEquals(SES_EVIDENCE_FAMILIES.length, 7);
  assertEquals(SES_EVIDENCE_STAGES.length, 7);
  assertEquals(SES_EVIDENCE_ITEMS.length, 7);
  assertEquals([...SES_EVIDENCE_STAGES], [
    "new",
    "allocated",
    "trade_report_in",
    "report_ready",
    "completed",
    "archive",
    "cancelled",
  ]);
  assertEquals([...SES_EVIDENCE_ITEMS], [
    "builder_wo_doc",
    "prime_link",
    "trade_report",
    "photos_media",
    "swms",
    "invoice",
    "po",
  ]);
});

Deno.test("every one of the 49 draft rows matches the codified matrix", () => {
  let asserted = 0;
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      const letters = DRAFT_TABLE[family][stage].split(" ");
      assertEquals(
        letters.length,
        SES_EVIDENCE_ITEMS.length,
        `${family}/${stage} draft row must have seven cells`,
      );
      SES_EVIDENCE_ITEMS.forEach((item, index) => {
        const expected = LETTER_TO_LEVEL[letters[index]];
        assert(expected, `unknown draft letter ${letters[index]}`);
        assertEquals(
          sesEvidenceRequirement(family, stage, item).level,
          expected,
          `${family}/${stage}/${item}`,
        );
      });
      asserted += 1;
    }
  }
  assertEquals(asserted, 49);
});

Deno.test("a question cell names Captain questions and a settled cell names none", () => {
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      for (const item of SES_EVIDENCE_ITEMS) {
        const cell = sesEvidenceRequirement(family, stage, item);
        if (cell.level === "question") {
          assert(
            cell.questions.length > 0,
            `${family}/${stage}/${item} is QUESTION with no Captain question`,
          );
          for (const id of cell.questions) {
            // Throws when the id is not one of the nine.
            const question = sesCaptainQuestion(id);
            assert(question.question.length > 40);
            // A ruled question may never gate a cell again.
            assertEquals(
              question.resolution,
              undefined,
              `${family}/${stage}/${item} is gated by resolved ${id}`,
            );
          }
        } else {
          assertEquals(
            cell.questions.length,
            0,
            `${family}/${stage}/${item} is settled but names a question`,
          );
        }
      }
    }
  }
});

Deno.test("the open Captain questions are complete, unique and all reachable", () => {
  assertEquals(SES_CAPTAIN_QUESTIONS.length, 6);
  assertEquals(
    SES_CAPTAIN_QUESTIONS.map((question) => question.id),
    [
      "ghl_equivalence",
      "report_ready_authority",
      "terminal_evidence",
      "report_only_swms",
      "own_document_roof_report_in",
      "cancelled_floor",
    ],
  );
  for (const question of SES_CAPTAIN_QUESTIONS) {
    assert(question.title.length > 0);
    assert(question.basis.length > 0);
    assertEquals(question.resolution, undefined, question.id);
  }
  // The draft raised nine; ruled ones are retained for provenance only.
  assertEquals(SES_ALL_CAPTAIN_QUESTIONS.length, 9);
  assertEquals(SES_RESOLVED_CAPTAIN_QUESTIONS.map((q) => q.id), [
    "po_floor",
    "repair_recipe",
    "restoration_recipe",
  ]);
  assertEquals(
    SES_ALL_CAPTAIN_QUESTIONS[0].id,
    "po_floor",
    "draft §6 order is preserved across the open/resolved split",
  );
  assertEquals(SES_ALL_CAPTAIN_QUESTIONS.map((q) => q.id), [
    "po_floor",
    "ghl_equivalence",
    "report_ready_authority",
    "terminal_evidence",
    "report_only_swms",
    "own_document_roof_report_in",
    "repair_recipe",
    "restoration_recipe",
    "cancelled_floor",
  ]);

  const reachable = new Set<SesCaptainQuestionId>();
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      for (const item of SES_EVIDENCE_ITEMS) {
        for (
          const id of sesEvidenceRequirement(family, stage, item).questions
        ) {
          reachable.add(id);
        }
      }
    }
  }
  // GHL equivalence qualifies how an item may be satisfied at all rather than
  // changing a cell's level, so it lives on the item, not in a cell.
  assert(!reachable.has("ghl_equivalence"));
  assertEquals(
    SES_EVIDENCE_ITEM_STANDING_QUESTIONS.prime_link,
    ["ghl_equivalence"],
  );
  reachable.add("ghl_equivalence");
  // Ruled questions are unreachable from every cell — that is the point.
  assert(!reachable.has("po_floor"));
  assert(!reachable.has("repair_recipe"));
  assert(!reachable.has("restoration_recipe"));
  // Six open questions: five cell-reachable + ghl standing (added above).
  assertEquals(reachable.size, 6);
  assertThrows(() =>
    sesCaptainQuestion("not_a_question" as SesCaptainQuestionId)
  );
});

Deno.test("the po_floor ruling is recorded, and a ruled question cannot gate a cell", () => {
  assertEquals(SES_RESOLVED_CAPTAIN_QUESTIONS.map((row) => row.id), [
    "po_floor",
    "repair_recipe",
    "restoration_recipe",
  ]);
  // The constant survives the ruling so the 49 settled cells keep their origin.
  const ruled = sesCaptainQuestion("po_floor");
  assertEquals(ruled, Q_PO_FLOOR);
  assertEquals(ruled.resolution?.ruled_on, "2026-08-01");
  assertStringIncludes(ruled.resolution?.ruling ?? "", "NOT required");
  assert((ruled.resolution?.effect ?? "").length > 40);

  // Every PO cell in all 49 rows is OPTIONAL, naming no question.
  let cells = 0;
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      const cell = sesEvidenceRequirement(family, stage, "po");
      assertEquals(cell.level, "optional", `${family}/${stage}`);
      assertEquals(cell.questions, [], `${family}/${stage}`);
      cells += 1;
    }
  }
  assertEquals(cells, 49);
});

Deno.test("the superseded PO floor is recorded, not erased", () => {
  // The point of the resolved-question mechanism is that a ruling is recorded
  // and never silently absorbed. A ruling that OVERTURNS another is recorded the
  // same way: the overturned text stays readable, with its date and the reason
  // it stopped governing, so a measurement taken under it is still attributable.
  const superseded = Q_PO_FLOOR.resolution?.supersedes ?? [];
  assertEquals(superseded.length, 1);
  const [first] = superseded;
  assertEquals(first.ruled_on, "2026-08-01");
  assertEquals(first.ruling, "of course every card needs a po");
  assertStringIncludes(first.effect, "REQUIRED");
  assertEquals(first.superseded_on, "2026-08-01");
  assertStringIncludes(first.superseded_reason, "WORK ORDERS");
  // The current ruling is the one the table implements, not the superseded one.
  assertStringIncludes(Q_PO_FLOOR.resolution?.effect ?? "", "OPTIONAL");
});

Deno.test("the work-order floor reaches every stage of every sealed family", () => {
  // "WORK ORDER: required on EVERY card, no exceptions" (2026-08-01). Terminal
  // stages included: a finished or archived job still has to show the document
  // its invoice was raised against.
  // All seven families are sealed; WO is required at every non-cancelled stage.
  assertEquals(SES_EVIDENCE_FAMILIES.length, 7);
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      const cell = sesEvidenceRequirement(family, stage, "builder_wo_doc");
      if (stage === "cancelled") {
        // A cancelled card is what `cancelled_floor` is still open about, and
        // this ruling did not name it.
        assertEquals(cell.level, "question", `${family}/cancelled`);
        assertEquals(
          cell.questions,
          ["cancelled_floor"],
          `${family}/cancelled`,
        );
        continue;
      }
      assertEquals(cell.level, "required", `${family}/${stage}`);
      assertEquals(cell.questions, [], `${family}/${stage}`);
    }
  }
});

Deno.test("a card with no builder work order fails at completed and archive", () => {
  for (const stage of ["completed", "archive"] as const) {
    const withWo = readSesCardEvidence({
      family: "physical_makesafe",
      stage,
      inventory: present({
        builder_wo_doc: { present: true },
        invoice: { present: true },
      }),
    });
    assertEquals(withWo.missing, [], stage);
    assertEquals(withWo.verdict, "undetermined", stage);

    const withoutWo = readSesCardEvidence({
      family: "physical_makesafe",
      stage,
      inventory: present({ invoice: { present: true } }),
    });
    assertEquals(withoutWo.missing, ["builder_wo_doc"], stage);
    assertEquals(withoutWo.verdict, "fail", stage);
  }
});

Deno.test("SWMS stays outside the independent family x stage evidence ruler", () => {
  // The typed workflow registry and `ses_family_matrix.ts` now own SWMS policy.
  // This independent evidence ruler stays observational: making it a second
  // executable requirement table would recreate the drift AC18 removes.
  // `report_only_swms` remains open because the roof/assessment accuracy gate
  // has not yet promoted include-now into a hard release requirement.
  assert(SES_CAPTAIN_QUESTIONS.some((row) => row.id === "report_only_swms"));
  assertEquals(sesCaptainQuestion("report_only_swms").resolution, undefined);
  for (const stage of SES_EVIDENCE_STAGES) {
    // This ruler observes physical and fencing SWMS without becoming its gate.
    assertEquals(
      sesEvidenceRequirement("physical_makesafe", stage, "swms").level,
      stage === "report_ready" || stage === "completed" ||
        stage === "archive" || stage === "cancelled"
        ? "question"
        : "optional",
      `physical_makesafe/${stage}`,
    );
    // No SWMS cell is REQUIRED here; the workflow registry owns that decision.
    for (const family of SES_EVIDENCE_FAMILIES) {
      assert(
        sesEvidenceRequirement(family, stage, "swms").level !== "required",
        `${family}/${stage}/swms became a gate`,
      );
    }
  }
});

Deno.test("question attribution follows the draft's stated conflicts", () => {
  // Draft §6 question 1 (PO) is ruled and no longer attributed anywhere; its
  // promoted cells are asserted in the po_floor ruling test above.

  // report_ready trusts recorded pack state, so the artifacts the Captain
  // requires there are open under question 3.
  assert(
    sesEvidenceRequirement("physical_makesafe", "report_ready", "trade_report")
      .questions.includes("report_ready_authority"),
  );
  assert(
    sesEvidenceRequirement("assessment_quote", "report_ready", "invoice")
      .questions.includes("report_ready_authority"),
  );

  // Terminal display state is structurally preserved (question 4) — for the
  // columns the 2026-08-01 work-order ruling did not reach. `builder_wo_doc` is
  // no longer one of them; the report/photo/SWMS columns still are.
  for (const stage of ["completed", "archive"] as const) {
    for (const item of ["trade_report", "photos_media", "swms"] as const) {
      assert(
        sesEvidenceRequirement("physical_makesafe", stage, item)
          .questions.includes("terminal_evidence"),
        `${stage}/${item}`,
      );
    }
    assertEquals(
      sesEvidenceRequirement("physical_makesafe", stage, "builder_wo_doc")
        .questions,
      [],
      stage,
    );
  }

  // Report-only SWMS (question 5): assessment is open at every stage; portal and
  // own-document roof are open from report_ready onward.
  for (const stage of SES_EVIDENCE_STAGES) {
    const cell = sesEvidenceRequirement("assessment_quote", stage, "swms");
    assertEquals(cell.level, "question");
    assert(cell.questions.includes("report_only_swms"), stage);
  }
  assert(
    sesEvidenceRequirement("ordinary_roof_portal", "report_ready", "swms")
      .questions.includes("report_only_swms"),
  );

  // Own-document roof report-in proof (question 6).
  assert(
    sesEvidenceRequirement("own_template_roof", "trade_report_in", "prime_link")
      .questions.includes("own_document_roof_report_in"),
  );
  assert(
    sesEvidenceRequirement(
      "own_template_roof",
      "trade_report_in",
      "trade_report",
    ).questions.includes("own_document_roof_report_in"),
  );

  // Repair and restoration are sealed on the physical path — resolved questions
  // must not reappear on any cell.
  for (const family of ["repair", "restoration"] as const) {
    for (const stage of SES_EVIDENCE_STAGES) {
      for (const item of SES_EVIDENCE_ITEMS) {
        const cell = sesEvidenceRequirement(family, stage, item);
        assert(
          !cell.questions.includes("repair_recipe"),
          `${family}/${stage}/${item}`,
        );
        assert(
          !cell.questions.includes("restoration_recipe"),
          `${family}/${stage}/${item}`,
        );
      }
    }
    // Physical shape: portal N-A, WO required outside cancelled.
    assertEquals(
      sesEvidenceRequirement(family, "trade_report_in", "prime_link").level,
      "not_applicable",
    );
    assertEquals(
      sesEvidenceRequirement(family, "trade_report_in", "trade_report").level,
      "required",
    );
    assertEquals(
      sesEvidenceRequirement(family, "trade_report_in", "photos_media").level,
      "required",
    );
  }

  // Cancelled cards have no evidence floor (question 9) — and `po` is settled
  // family- and stage-independently as OPTIONAL, so it is not one either.
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const item of SES_EVIDENCE_ITEMS) {
      const cell = sesEvidenceRequirement(family, "cancelled", item);
      if (item === "po") {
        assertEquals(cell.level, "optional", `${family}/cancelled/po`);
        continue;
      }
      if (cell.level !== "question") {
        // The only settled cancelled cells are family N-A rules.
        assertEquals(cell.level, "not_applicable", `${family}/${item}`);
        continue;
      }
      assert(
        cell.questions.includes("cancelled_floor"),
        `${family}/cancelled/${item}`,
      );
    }
  }
});

Deno.test("the matrix is cumulative across non-terminal stages", () => {
  const nonTerminal: SesEvidenceStage[] = [
    "new",
    "allocated",
    "trade_report_in",
    "report_ready",
  ];
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const item of SES_EVIDENCE_ITEMS) {
      let seenRequired = false;
      for (const stage of nonTerminal) {
        const level = sesEvidenceRequirement(family, stage, item).level;
        if (seenRequired) {
          assert(
            level === "required" || level === "question",
            `${family}/${stage}/${item} weakened a REQUIRED item to ${level}`,
          );
        }
        if (level === "required") seenRequired = true;
      }
    }
  }
});

Deno.test("family N-A columns match the draft's family recipes", () => {
  // Physical work has no portal deliverable.
  for (const stage of SES_EVIDENCE_STAGES) {
    for (const family of ["physical_makesafe", "temporary_fencing"] as const) {
      assertEquals(
        sesEvidenceRequirement(family, stage, "prime_link").level,
        "not_applicable",
      );
    }
    // Report-only roof owes no trade report or photo pack; the portal is the
    // report.
    assertEquals(
      sesEvidenceRequirement("ordinary_roof_portal", stage, "trade_report")
        .level,
      "not_applicable",
    );
    assertEquals(
      sesEvidenceRequirement("ordinary_roof_portal", stage, "photos_media")
        .level,
      "not_applicable",
    );
    // Own-document roof owes the SecureWorks PDF but no photo pack.
    assertEquals(
      sesEvidenceRequirement("own_template_roof", stage, "photos_media").level,
      "not_applicable",
    );
    // Assessment is a portal family: no local trade report.
    assertEquals(
      sesEvidenceRequirement("assessment_quote", stage, "trade_report").level,
      "not_applicable",
    );
  }
});

Deno.test("temporary fencing inherits the physical row exactly", () => {
  for (const stage of SES_EVIDENCE_STAGES) {
    for (const item of SES_EVIDENCE_ITEMS) {
      assertEquals(
        sesEvidenceRequirement("temporary_fencing", stage, item),
        sesEvidenceRequirement("physical_makesafe", stage, item),
        `${stage}/${item}`,
      );
    }
  }
});

Deno.test("reader grades required, optional and not-applicable cells", () => {
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      trade_report: { present: true },
      photos_media: { present: true, count: 6 },
      po: { present: true },
    }),
  });
  const byItem = Object.fromEntries(
    reading.items.map((row) => [row.item, row]),
  );
  assertEquals(byItem.builder_wo_doc.status, "present");
  assertEquals(byItem.trade_report.status, "present");
  assertEquals(byItem.photos_media.status, "present");
  assertEquals(byItem.photos_media.observed_count, 6);
  // N-A for the family.
  assertEquals(byItem.prime_link.status, "not_required");
  // OPTIONAL and absent is not a shortfall.
  assertEquals(byItem.swms.status, "not_required");
  assertEquals(byItem.invoice.status, "not_required");
  // The PO column is OPTIONAL everywhere since the 2026-08-01 re-ruling, but a
  // PO that exists is still reported as present rather than dropped.
  assertEquals(byItem.po.requirement, "optional");
  assertEquals(byItem.po.status, "present");
  assertEquals(byItem.po.observed_present, true);
  assertEquals(byItem.po.open_questions, []);
  // Every remaining cell is settled, so this card actually passes.
  assertEquals(reading.verdict, "pass");
  assertEquals(reading.missing, []);
});

Deno.test("a card with no builder PO is observed, not failed", () => {
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      trade_report: { present: true },
      photos_media: { present: true, count: 6 },
    }),
  });
  const po = reading.items.find((row) => row.item === "po")!;
  assertEquals(po.requirement, "optional");
  assertEquals(po.status, "not_required");
  assertEquals(po.observed_present, false);
  assertEquals(reading.missing, []);
  assertEquals(reading.verdict, "pass");
});

Deno.test("an absent PO is still reported on the card, at every stage", () => {
  // "Expected to usually exist, but absence is not a failure" — the column has
  // to stay legible either way, or the board loses sight of the PO entirely.
  for (const stage of SES_EVIDENCE_STAGES) {
    const withPo = readSesCardEvidence({
      family: "physical_makesafe",
      stage,
      inventory: present({ po: { present: true, detail: "PO20877" } }),
    });
    const seen = withPo.items.find((row) => row.item === "po")!;
    assertEquals(seen.observed_present, true, stage);
    assertEquals(seen.detail, "PO20877", stage);
    assert(!withPo.missing.includes("po"), stage);

    const withoutPo = readSesCardEvidence({
      family: "physical_makesafe",
      stage,
      inventory: emptySesCardEvidenceInventory(),
    });
    const absent = withoutPo.items.find((row) => row.item === "po")!;
    assertEquals(absent.observed_present, false, stage);
    assert(!withoutPo.missing.includes("po"), stage);
  }
});

Deno.test("a genuinely absent required item fails the card", () => {
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      photos_media: { present: true, count: 5 },
      po: { present: true },
    }),
  });
  assertEquals(reading.verdict, "fail");
  assertEquals(reading.missing, ["trade_report"]);
  assertEquals(reading.lost_in_transit, []);
});

Deno.test("a card short only on question cells is undetermined, never failing", () => {
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      const reading = readSesCardEvidence({
        family,
        stage,
        inventory: fullInventory(),
      });
      assertEquals(reading.missing, [], `${family}/${stage}`);
      assert(
        reading.verdict !== "fail",
        `${family}/${stage} failed a fully evidenced card`,
      );
      const expected = reading.unresolved.length > 0 ? "undetermined" : "pass";
      assertEquals(reading.verdict, expected, `${family}/${stage}`);
    }
  }
});

Deno.test("repair and restoration grade like physical make-safe once sealed", () => {
  for (const family of ["repair", "restoration"] as const) {
    for (const stage of SES_EVIDENCE_STAGES) {
      // Fully evidenced card matches physical_makesafe: pass when no open
      // questions remain on that stage, otherwise undetermined.
      const full = readSesCardEvidence({
        family,
        stage,
        inventory: fullInventory(),
      });
      const physical = readSesCardEvidence({
        family: "physical_makesafe",
        stage,
        inventory: fullInventory(),
      });
      assertEquals(full.verdict, physical.verdict, `${family}/${stage}`);
      assertEquals(full.missing, physical.missing, `${family}/${stage}`);
      assertEquals(
        [...full.unresolved].sort(),
        [...physical.unresolved].sort(),
        `${family}/${stage}`,
      );

      // Empty card: WO is required outside cancelled, so it fails like physical.
      const empty = readSesCardEvidence({
        family,
        stage,
        inventory: emptySesCardEvidenceInventory(),
      });
      const emptyPhysical = readSesCardEvidence({
        family: "physical_makesafe",
        stage,
        inventory: emptySesCardEvidenceInventory(),
      });
      assertEquals(empty.verdict, emptyPhysical.verdict, `${family}/${stage}`);
      assertEquals(empty.missing, emptyPhysical.missing, `${family}/${stage}`);
    }
  }
});

Deno.test("a question cell stays unresolved even when the artifact is present", () => {
  const reading = readSesCardEvidence({
    family: "assessment_quote",
    stage: "report_ready",
    inventory: fullInventory(),
  });
  const swms = reading.items.find((row) => row.item === "swms")!;
  assertEquals(swms.status, "unresolved_question");
  assertEquals(swms.observed_present, true);
  assertEquals(swms.open_questions, ["report_only_swms"]);
});

Deno.test("a GHL-only portal link is undetermined rather than missing", () => {
  const reading = readSesCardEvidence({
    family: "ordinary_roof_portal",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      prime_link: { present: false, substitute_present: true },
      po: { present: true },
    }),
  });
  const prime = reading.items.find((row) => row.item === "prime_link")!;
  assertEquals(prime.requirement, "required");
  assertEquals(prime.status, "unresolved_question");
  assertEquals(prime.open_questions, ["ghl_equivalence"]);
  assertEquals(reading.verdict, "undetermined");
  assertEquals(reading.missing, []);
  assert(reading.open_questions.some((row) => row.id === "ghl_equivalence"));
});

Deno.test("an optional prime cell with only a GHL link is still undetermined", () => {
  const reading = readSesCardEvidence({
    family: "ordinary_roof_portal",
    stage: "new",
    inventory: present({
      builder_wo_doc: { present: true },
      prime_link: { present: false, substitute_present: true },
    }),
  });
  const prime = reading.items.find((row) => row.item === "prime_link")!;
  assertEquals(prime.requirement, "optional");
  assertEquals(prime.status, "unresolved_question");
});

Deno.test("a substitute is ignored for items with no standing question", () => {
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      photos_media: { present: true, count: 5 },
      trade_report: { present: false, substitute_present: true },
      po: { present: true },
    }),
  });
  assertEquals(reading.missing, ["trade_report"]);
  assertEquals(reading.verdict, "fail");
});

Deno.test("missing evidence with an upload record is flagged lost in transit", () => {
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "trade_report_in",
    inventory: present({
      builder_wo_doc: { present: true },
      trade_report: { present: true },
      photos_media: {
        present: false,
        count: 0,
        transit_record_without_artifact: true,
        detail: "submitted service report records photos; job_media has none",
      },
      po: { present: true },
    }),
  });
  const photos = reading.items.find((row) => row.item === "photos_media")!;
  assertEquals(photos.status, "missing");
  assertEquals(photos.signal, "lost_in_transit");
  assertEquals(photos.detail?.includes("job_media"), true);
  assertEquals(reading.lost_in_transit, ["photos_media"]);
  // Lost in transit is still a shortfall: it is a signal, not an excuse.
  assertEquals(reading.verdict, "fail");
});

Deno.test("family resolution refuses unknown and honours restoration authority", () => {
  assertEquals(sesEvidenceFamilyFromCard({}), null);
  assertEquals(
    sesEvidenceFamilyFromCard({ makesafe_job_family: "general_makesafe" }),
    "physical_makesafe",
  );
  assertEquals(
    sesEvidenceFamilyFromCard({ makesafe_job_family: "temp_fence_makesafe" }),
    "temporary_fencing",
  );
  assertEquals(
    sesEvidenceFamilyFromCard({ makesafe_job_family: "roof_report" }),
    "ordinary_roof_portal",
  );
  assertEquals(
    sesEvidenceFamilyFromCard({
      makesafe_job_family: "roof_report",
      strata: true,
    }),
    "own_template_roof",
  );
  assertEquals(
    sesEvidenceFamilyFromCard({ makesafe_job_family: "assessment_report" }),
    "assessment_quote",
  );
  assertEquals(
    sesEvidenceFamilyFromCard({ makesafe_job_family: "repair" }),
    "repair",
  );
  // insurance_job_type outranks a stale family token.
  assertEquals(
    sesEvidenceFamilyFromCard({
      makesafe_job_family: "general_makesafe",
      insurance_job_type: "restoration",
    }),
    "restoration",
  );
});

Deno.test("readings carry the contract version and deduped open questions", () => {
  const reading = readSesCardEvidence({
    family: "own_template_roof",
    stage: "archive",
    inventory: fullInventory(),
  });
  assertEquals(
    reading.contract_version,
    "ses-evidence-requirements/c1-repair-restoration-sealed-v5",
  );
  const ids = reading.open_questions.map((question) => question.id);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, [
    "terminal_evidence",
    "report_only_swms",
    "own_document_roof_report_in",
  ]);
});

Deno.test("the matrix is frozen against accidental cell edits at read time", () => {
  const before = sesEvidenceRequirement("physical_makesafe", "new", "invoice");
  const reading = readSesCardEvidence({
    family: "physical_makesafe",
    stage: "new",
    inventory: fullInventory(),
  });
  assertEquals(reading.items.length, 7);
  assertEquals(
    sesEvidenceRequirement("physical_makesafe", "new", "invoice"),
    before,
  );
  assertEquals(
    SES_EVIDENCE_REQUIREMENTS.physical_makesafe.new.builder_wo_doc.level,
    "required",
  );
});
