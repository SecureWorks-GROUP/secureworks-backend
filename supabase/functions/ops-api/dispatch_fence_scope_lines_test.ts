// deno-lint-ignore-file no-import-prefix no-explicit-any
// The fence scope offer (dispatch_fence_scope_lines.ts). The fixtures are the
// panel geometry of seven real fencing jobs (cases A to G), read-only on
// 19 Oct 2026 from the live scope_json.job.runs, not a frozen revision (no
// client, address, price or job number here), and each expectation is what
// that job's own purchase order actually carried.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FENCE_POST_LOOKUP,
  fenceRunsChangedSinceFrozen,
  fenceScopeSuggestedLines,
} from "./dispatch_fence_scope_lines.ts";

type PanelGroup = [
  count: number,
  height: number,
  retaining: number,
  long?: boolean,
];

function scope(
  profile: string,
  colour: string,
  runs: PanelGroup[][],
  gates: any[] = [],
) {
  return {
    job: {
      profile,
      colour,
      supplier: "SUPPLIER-A",
      gates,
      runs: runs.map((groups) => ({
        panels: groups.flatMap(([count, height, retaining, long]) =>
          Array.from({ length: count }, () => ({
            height,
            retaining,
            slopePlinths: 0,
            stepMm: 0,
            panelWidth: long ? "long" : "standard",
          }))
        ),
      })),
    },
  };
}

function offer(s: any) {
  const answer = fenceScopeSuggestedLines(s);
  assert(answer.ok, JSON.stringify(answer));
  return answer;
}

function qty(lines: any[], match: RegExp): number {
  return lines.filter((l) => match.test(l.description))
    .reduce((sum, l) => sum + (l.quantity ?? 0), 0);
}

function panelsByPost(lines: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines.filter((l) => /panel kit/.test(l.description))) {
    const post = /(\d+) mm post/.exec(l.description)![1];
    out[post] = (out[post] ?? 0) + l.quantity;
  }
  return out;
}

Deno.test("fence case A: 9 panels and 8 plinths, as its order", () => {
  const { lines } = offer(
    scope("Ridgeside", "Woodland Grey", [[[8, 1800, 150], [1, 1800, 0]]]),
  );
  assertEquals(qty(lines, /panel kit/), 9);
  assertEquals(qty(lines, /plinth/), 8);
  assertEquals(qty(lines, /Patio tube/), 0);
});

Deno.test("fence case B: 7 panels and 7 plinths, as its order", () => {
  const { lines } = offer(scope("Sameside", "Monument", [[[7, 1800, 150]]]));
  assertEquals(qty(lines, /panel kit/), 7);
  assertEquals(qty(lines, /plinth/), 7);
});

Deno.test("fence case C: 18 panels, 41 plinths, 6 patio tubes, as its order", () => {
  const { lines } = offer(scope("Trimclad", "Monument", [
    [[5, 1800, 300], [5, 1800, 600], [3, 1800, 300], [3, 1800, 150], [
      1,
      1200,
      150,
      true,
    ]],
    [[1, 1800, 150]],
  ]));
  assertEquals(qty(lines, /panel kit/), 18);
  assertEquals(qty(lines, /plinth/), 41);
  assertEquals(qty(lines, /Patio tube/), 6);
  assert(lines.some((l) => /1200 mm sheet.*long panel/.test(l.description)));
});

Deno.test("fence case D: 23 panels on 2700 posts and 3 on 2400, 27 plinths, as its order", () => {
  const { lines } = offer(scope("Sameside", "Monument", [
    [[4, 1800, 300], [10, 1800, 150]],
    [[9, 1800, 150], [3, 1800, 0]],
  ]));
  assertEquals(panelsByPost(lines), { "2700": 23, "2400": 3 });
  assertEquals(qty(lines, /plinth/), 27);
  assertEquals(qty(lines, /Patio tube/), 0);
});

Deno.test("fence case E: 3 panels on 2700 posts and 3 plinths, as its order", () => {
  const { lines } = offer(
    scope("Neetascreen", "Woodland Grey", [[[3, 1800, 150]]]),
  );
  assertEquals(panelsByPost(lines), { "2700": 3 });
  assertEquals(qty(lines, /plinth/), 3);
});

Deno.test("fence case F: 5 panels and 8 plinths match; the post length did not (order took 2400, the table says 2700)", () => {
  const { lines } = offer(scope("Sameside", "Domain", [
    [[1, 1800, 0]],
    [[4, 1800, 300]],
  ]));
  assertEquals(qty(lines, /panel kit/), 5);
  assertEquals(qty(lines, /plinth/), 8);
  // Recorded, not hidden: the real order bought 2400 mm posts for 300 mm of
  // retaining. The person reviews every line before it can be ordered.
  assertEquals(panelsByPost(lines), { "2400": 1, "2700": 4 });
});

Deno.test("fence case G: 1 panel on a 2400 post, 2 gate kits, 4 gate posts, as its order", () => {
  const { lines } = offer(scope("Trimclad", "Basalt", [[[1, 1800, 0]]], [
    { type: "single", width: 1500 },
    { type: "single", width: 1170 },
  ]));
  assertEquals(panelsByPost(lines), { "2400": 1 });
  assertEquals(qty(lines, /gate kit/), 2);
  assertEquals(qty(lines, /^Gate post$/), 4);
});

Deno.test("every line is a suggestion shape: description within 300, a unit, a whole quantity, no price", () => {
  const { lines, held, scope_supplier } = offer(
    scope("Ridgeside", "Woodland Grey", [[[8, 1800, 150], [1, 1800, 0]]]),
  );
  for (const l of lines) {
    assert(l.description.length > 0 && l.description.length <= 300);
    assert(l.unit && l.unit.length <= 30);
    assert(Number.isInteger(l.quantity));
    assert(!("unit_price" in l));
  }
  assertEquals(
    lines.map((l) => l.description),
    [
      "Ridgeside fence panel kit, Woodland Grey, 1800 mm sheet, 2700 mm post",
      "Ridgeside fence panel kit, Woodland Grey, 1800 mm sheet, 2400 mm post",
      "Retaining plinth 150 mm, Woodland Grey",
    ],
  );
  assertEquals(scope_supplier, "SUPPLIER-A");
  assert(held.some((h) => /end post/.test(h)));
  assert(held.some((h) => /Concrete is a crew buy/.test(h)));
});

Deno.test("slope plinths add to retaining and the plinths per panel stop at four", () => {
  const { lines } = offer({
    job: {
      runs: [{
        panels: [{ height: 1800, retaining: 600, slopePlinths: 2 }],
      }],
    },
  });
  assertEquals(qty(lines, /plinth/), 4);
  assertEquals(panelsByPost(lines), { "3000": 1 });
});

Deno.test("an unreadable panel refuses the whole offer; nothing part-read is offered", () => {
  const bad = [
    [{ height: 1650, retaining: 0 }, "panel_height_unknown"],
    [{ height: 1800, retaining: 100 }, "panel_retaining_unreadable"],
    [{ height: 1800, retaining: -150 }, "panel_retaining_unreadable"],
    [{ height: "tall", retaining: 0 }, "panel_height_unknown"],
  ] as const;
  for (const [panel, reason] of bad) {
    const answer = fenceScopeSuggestedLines({
      job: { runs: [{ panels: [{ height: 1800, retaining: 0 }, panel] }] },
    });
    assertEquals(answer, { ok: false, reason });
  }
  assertEquals(fenceScopeSuggestedLines(null), {
    ok: false,
    reason: "no_runs",
  });
  assertEquals(fenceScopeSuggestedLines({ config: { length: 5 } }), {
    ok: false,
    reason: "no_runs",
  });
  assertEquals(fenceScopeSuggestedLines({ job: { runs: [{ panels: [] }] } }), {
    ok: false,
    reason: "no_panels",
  });
});

Deno.test("the post table is the fence designer's: sheet + plinths + 600 in the ground, bought in 2400/2700/3000", () => {
  for (const [sheet, row] of Object.entries(FENCE_POST_LOOKUP)) {
    for (const [ret, post] of Object.entries(row)) {
      assert([2400, 2700, 3000].includes(post));
      // A post is never shorter than the sheet plus its plinths.
      assert(post >= Number(sheet) + Number(ret), `${sheet}/${ret}`);
    }
  }
});

Deno.test("scope change since frozen: compared as JSON values, key order ignored; no live runs is no change", () => {
  const frozen = {
    job: { runs: [{ panels: [{ height: 1800, retaining: 150 }] }] },
  };
  assertEquals(
    fenceRunsChangedSinceFrozen(frozen, [{
      panels: [{ retaining: 150, height: 1800 }],
    }]),
    false,
  );
  assertEquals(
    fenceRunsChangedSinceFrozen(frozen, [{
      panels: [{ height: 1800, retaining: 0 }],
    }]),
    true,
  );
  assertEquals(fenceRunsChangedSinceFrozen(frozen, null), false);
  assertEquals(fenceRunsChangedSinceFrozen({ job: {} }, []), true);
});
