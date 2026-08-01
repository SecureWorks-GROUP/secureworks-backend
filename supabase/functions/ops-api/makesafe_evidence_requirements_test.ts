// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
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
// Source: codex-evidence-ruler-draft-v1/report.md §§4.1-4.7, plus the Captain
// ruling of 2026-08-01 on `po_floor` ("of course every card needs a po"), which
// promotes the PO column from Q to R in all 49 rows — every family, every stage,
// including the two unsealed recipes.
// ---------------------------------------------------------------------------

const DRAFT_TABLE: Record<SesEvidenceFamily, Record<SesEvidenceStage, string>> =
  {
    // §4.1 General physical make-safe
    physical_makesafe: {
      new: "R N O O O O R",
      allocated: "R N O O O O R",
      trade_report_in: "R N R R O O R",
      report_ready: "R N Q Q Q Q R",
      completed: "Q N Q Q Q R R",
      archive: "Q N Q Q Q R R",
      cancelled: "Q N Q Q Q Q R",
    },
    // §4.2 Temporary-fence make-safe
    temporary_fencing: {
      new: "R N O O O O R",
      allocated: "R N O O O O R",
      trade_report_in: "R N R R O O R",
      report_ready: "R N Q Q Q Q R",
      completed: "Q N Q Q Q R R",
      archive: "Q N Q Q Q R R",
      cancelled: "Q N Q Q Q Q R",
    },
    // §4.3 Ordinary roof report, Prime portal mode
    ordinary_roof_portal: {
      new: "R O N N O O R",
      allocated: "R O N N O O R",
      trade_report_in: "R R N N O O R",
      report_ready: "R R N N Q Q R",
      completed: "Q Q N N Q R R",
      archive: "Q Q N N Q R R",
      cancelled: "Q Q N N Q Q R",
    },
    // §4.4 Own-document roof report (trade-report column is the roof PDF)
    own_template_roof: {
      new: "R N O N O O R",
      allocated: "R N O N O O R",
      trade_report_in: "R Q Q N O O R",
      report_ready: "R Q R N Q Q R",
      completed: "Q Q Q N Q R R",
      archive: "Q Q Q N Q R R",
      cancelled: "Q Q Q N Q Q R",
    },
    // §4.5 Assessment / quote
    assessment_quote: {
      new: "R O N O Q O R",
      allocated: "R O N O Q O R",
      trade_report_in: "R R N R Q O R",
      report_ready: "R R N R Q Q R",
      completed: "Q Q N Q Q R R",
      archive: "Q Q N Q Q R R",
      cancelled: "Q Q N Q Q Q R",
    },
    // §4.6 Repair, recipe unsealed
    repair: {
      new: "Q Q Q Q Q Q R",
      allocated: "Q Q Q Q Q Q R",
      trade_report_in: "Q Q Q Q Q Q R",
      report_ready: "Q Q Q Q Q Q R",
      completed: "Q Q Q Q Q Q R",
      archive: "Q Q Q Q Q Q R",
      cancelled: "Q Q Q Q Q Q R",
    },
    // §4.7 Restoration, recipe unsealed
    restoration: {
      new: "Q Q Q Q Q Q R",
      allocated: "Q Q Q Q Q Q R",
      trade_report_in: "Q Q Q Q Q Q R",
      report_ready: "Q Q Q Q Q Q R",
      completed: "Q Q Q Q Q Q R",
      archive: "Q Q Q Q Q Q R",
      cancelled: "Q Q Q Q Q Q R",
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

Deno.test("the eight open Captain questions are complete, unique and all reachable", () => {
  assertEquals(SES_CAPTAIN_QUESTIONS.length, 8);
  assertEquals(
    SES_CAPTAIN_QUESTIONS.map((question) => question.id),
    [
      "ghl_equivalence",
      "report_ready_authority",
      "terminal_evidence",
      "report_only_swms",
      "own_document_roof_report_in",
      "repair_recipe",
      "restoration_recipe",
      "cancelled_floor",
    ],
  );
  for (const question of SES_CAPTAIN_QUESTIONS) {
    assert(question.title.length > 0);
    assert(question.basis.length > 0);
    assertEquals(question.resolution, undefined, question.id);
  }
  // The draft raised nine; the ruled one is retained for provenance only.
  assertEquals(SES_ALL_CAPTAIN_QUESTIONS.length, 9);
  assertEquals(
    SES_ALL_CAPTAIN_QUESTIONS[0].id,
    "po_floor",
    "draft §6 order is preserved across the open/resolved split",
  );

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
  // The ruled question is unreachable from every cell — that is the point.
  assert(!reachable.has("po_floor"));
  assertEquals(reachable.size, 8);
  assertThrows(() =>
    sesCaptainQuestion("not_a_question" as SesCaptainQuestionId)
  );
});

Deno.test("the po_floor ruling is recorded, and a ruled question cannot gate a cell", () => {
  assertEquals(SES_RESOLVED_CAPTAIN_QUESTIONS.map((row) => row.id), [
    "po_floor",
  ]);
  // The constant survives the ruling so the 49 promoted cells keep their origin.
  const ruled = sesCaptainQuestion("po_floor");
  assertEquals(ruled, Q_PO_FLOOR);
  assertEquals(ruled.resolution?.ruled_on, "2026-08-01");
  assertEquals(ruled.resolution?.ruling, "of course every card needs a po");
  assert((ruled.resolution?.effect ?? "").length > 40);

  // Every PO cell in all 49 rows is now REQUIRED, naming no question.
  let cells = 0;
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const stage of SES_EVIDENCE_STAGES) {
      const cell = sesEvidenceRequirement(family, stage, "po");
      assertEquals(cell.level, "required", `${family}/${stage}`);
      assertEquals(cell.questions, [], `${family}/${stage}`);
      cells += 1;
    }
  }
  assertEquals(cells, 49);
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

  // Terminal display state is structurally preserved (question 4).
  for (const stage of ["completed", "archive"] as const) {
    assert(
      sesEvidenceRequirement("physical_makesafe", stage, "builder_wo_doc")
        .questions.includes("terminal_evidence"),
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

  // Unsealed recipes (questions 7 and 8) cover every cell of their family
  // except `po`, which the 2026-08-01 ruling settled for every family.
  for (
    const [family, id] of [
      ["repair", "repair_recipe"],
      ["restoration", "restoration_recipe"],
    ] as const
  ) {
    for (const stage of SES_EVIDENCE_STAGES) {
      for (const item of SES_EVIDENCE_ITEMS) {
        assertEquals(
          sesEvidenceRequirement(family, stage, item).questions,
          item === "po" ? [] : [id],
          `${family}/${stage}/${item}`,
        );
      }
    }
  }

  // Cancelled cards have no evidence floor (question 9) — except the PO floor,
  // which the ruling made family- and stage-independent.
  for (const family of SES_EVIDENCE_FAMILIES) {
    for (const item of SES_EVIDENCE_ITEMS) {
      const cell = sesEvidenceRequirement(family, "cancelled", item);
      if (item === "po") {
        assertEquals(cell.level, "required", `${family}/cancelled/po`);
        continue;
      }
      if (cell.level !== "question") {
        // The only settled cancelled cells are family N-A rules.
        assertEquals(cell.level, "not_applicable", `${family}/${item}`);
        continue;
      }
      if (family === "repair" || family === "restoration") continue;
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
  // The PO column is REQUIRED everywhere since the 2026-08-01 ruling.
  assertEquals(byItem.po.requirement, "required");
  assertEquals(byItem.po.status, "present");
  assertEquals(byItem.po.open_questions, []);
  // Every remaining cell is settled, so this card actually passes.
  assertEquals(reading.verdict, "pass");
  assertEquals(reading.missing, []);
});

Deno.test("a card with no builder PO now fails on the PO floor", () => {
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
  assertEquals(po.requirement, "required");
  assertEquals(po.status, "missing");
  assertEquals(reading.missing, ["po"]);
  assertEquals(reading.verdict, "fail");
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

Deno.test("repair and restoration are undetermined once their PO floor is met", () => {
  for (const family of ["repair", "restoration"] as const) {
    for (const stage of SES_EVIDENCE_STAGES) {
      // Every cell but `po` is open under the family's unsealed recipe, so a
      // card holding its PO can never do better than undetermined...
      const withPo = readSesCardEvidence({
        family,
        stage,
        inventory: fullInventory(),
      });
      assertEquals(withPo.verdict, "undetermined", `${family}/${stage}`);
      assertEquals(withPo.unresolved.length, SES_EVIDENCE_ITEMS.length - 1);
      assertEquals(withPo.missing, [], `${family}/${stage}`);

      // ...and an unsealed recipe is no exemption from the floor: no PO is a
      // real failure even here.
      const withoutPo = readSesCardEvidence({
        family,
        stage,
        inventory: emptySesCardEvidenceInventory(),
      });
      assertEquals(withoutPo.verdict, "fail", `${family}/${stage}`);
      assertEquals(withoutPo.missing, ["po"], `${family}/${stage}`);
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
    "ses-evidence-requirements/c1-unlinked-invoice-v3",
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
