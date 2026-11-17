import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideMatch } from "./decide.ts";
import type { Clue, ClueType } from "./types.ts";

const types: Record<string, ClueType> = {
  job_number: {
    code: "job_number",
    class: "key",
    family: "doc_text",
    mode: "counts",
  },
  sealed_scope_order: {
    code: "sealed_scope_order",
    class: "key",
    family: "order",
    mode: "counts",
  },
  order_number: {
    code: "order_number",
    class: "key",
    family: "order",
    mode: "counts",
  },
  order_amount: {
    code: "order_amount",
    class: "clue",
    family: "order",
    mode: "counts",
  },
  delivery_address: {
    code: "delivery_address",
    class: "clue",
    family: "address",
    mode: "suggest_only",
  },
  ai_read: { code: "ai_read", class: "ai", family: "ai", mode: "suggest_only" },
  overhead_account: {
    code: "overhead_account",
    class: "clue",
    family: "account",
    mode: "suggest_only",
  },
};
function clue(code: string, job_id = "J1", root = "doc:B1"): Clue {
  return {
    clue_code: code,
    class: types[code].class,
    family: types[code].family,
    root,
    outcome: "job",
    job_id,
    names_one: true,
  };
}
const key = () => clue("job_number");
const order = () => clue("sealed_scope_order", "J1", "order:O1");

Deno.test("T1 independent document and sealed order auto-place J1 (SWF-990001)", () => {
  assertEquals(decideMatch([key(), order()], types, []), {
    result: "auto",
    job_id: "J1",
    clue_indexes: [0, 1],
  });
});
Deno.test("T2 one key suggests J1", () => {
  assertEquals(decideMatch([key()], types, []), {
    result: "suggest",
    reason: "one_clue",
    outcome: "job",
    job_id: "J1",
    from_clue_index: 0,
  });
});
Deno.test("T3 a named order and its amount share one root", () => {
  assertEquals(
    decideMatch(
      [
        clue("order_number", "J1", "order:O1"),
        clue("order_amount", "J1", "order:O1"),
      ],
      types,
      [],
    ).result,
    "suggest",
  );
});
Deno.test("T4 two AI answers remain suggestions even if their mode is counts", () => {
  const r = decideMatch([clue("ai_read"), clue("ai_read", "J1", "ai:2")], {
    ...types,
    ai_read: { ...types.ai_read, mode: "counts" },
  }, []);
  assertEquals(r, {
    result: "suggest",
    reason: "ai_only",
    outcome: "job",
    job_id: "J1",
    from_clue_index: 0,
  });
});
Deno.test("T5 AI plus a key remains one clue, with the key preferred", () => {
  assertEquals(decideMatch([clue("ai_read"), key()], types, []), {
    result: "suggest",
    reason: "one_clue",
    outcome: "job",
    job_id: "J1",
    from_clue_index: 1,
  });
});
Deno.test("T6 no clues gives none; a stop alone still reaches a person", () => {
  assertEquals(decideMatch([], types, []), {
    result: "none",
    reason: "no_clue",
  });
  assertEquals(
    decideMatch([], types, [{
      code: "possible_duplicate",
      words: "Review duplicate",
    }]),
    { result: "suggest", reason: "possible_duplicate" },
  );
});
Deno.test("T7 conflicting jobs J1 and J2 (SWP-990002) suggest neither, even with an off type", () => {
  assertEquals(
    decideMatch([key(), clue("sealed_scope_order", "J2", "order:O2")], {
      ...types,
      sealed_scope_order: { ...types.sealed_scope_order, mode: "off" },
    }, []),
    { result: "suggest", reason: "two_jobs_named" },
  );
});
Deno.test("T8 address mode controls counting, not whether it is suggested", () => {
  const clues = [key(), clue("delivery_address", "J1", "job:J1:site")];
  assertEquals(decideMatch(clues, types, []).result, "suggest");
  assertEquals(
    decideMatch(clues, {
      ...types,
      delivery_address: { ...types.delivery_address, mode: "counts" },
    }, []),
    { result: "auto", job_id: "J1", clue_indexes: [0, 1] },
  );
});
Deno.test("T9 overhead is suggested and never auto-placed", () => {
  const c: Clue = { ...clue("overhead_account"), outcome: "overhead" };
  delete c.job_id;
  assertEquals(decideMatch([c], types, []), {
    result: "suggest",
    reason: "one_clue",
    outcome: "overhead",
    from_clue_index: 0,
  });
});
Deno.test("T10 stops defeat an otherwise automatic match", () => {
  assertEquals(
    decideMatch([key(), order()], types, [{
      code: "possible_duplicate",
      words: "Review duplicate",
    }]),
    {
      result: "suggest",
      reason: "possible_duplicate",
      outcome: "job",
      job_id: "J1",
      from_clue_index: 0,
    },
  );
});
Deno.test("T11 a narrower neither contests nor supplies an automatic match", () => {
  const narrower: Clue = {
    ...key(),
    clue_code: "division_tag",
    class: "narrower",
    family: "tag",
    job_id: "J2",
  };
  assertEquals(decideMatch([key(), order(), narrower], types, []), {
    result: "auto",
    job_id: "J1",
    clue_indexes: [0, 1],
  });
  assertEquals(decideMatch([narrower], types, []), {
    result: "none",
    reason: "no_clue",
  });
});
Deno.test("T12 different roots within one family do not count twice", () => {
  assertEquals(
    decideMatch(
      [
        clue("order_number", "J1", "order:O1"),
        clue("order_amount", "J1", "order:O2"),
      ],
      types,
      [],
    ).result,
    "suggest",
  );
});
