import {
  _resetSwitchCacheForTest,
  readSwitch,
  readSwitches,
  SWITCH_ANSWER_TTL_MS,
} from "./switch_cache.ts";

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`${actual} != ${expected}`);
}

type Row = { flag_name: string; enabled: boolean };

function flagClient(
  rows: Row[],
  opts: { error?: boolean; throws?: boolean } = {},
) {
  const reads: Array<{ mode: "eq" | "in"; names: string[] }> = [];
  const client = {
    reads,
    from(table: string) {
      if (table !== "feature_flags") throw new Error(`unexpected ${table}`);
      return {
        select(_cols: string) {
          return {
            eq(_col: string, name: string) {
              return {
                limit(_n: number) {
                  reads.push({ mode: "eq", names: [name] });
                  if (opts.throws) throw new Error("transport");
                  if (opts.error) {
                    return Promise.resolve({
                      data: null,
                      error: { message: "x" },
                    });
                  }
                  return Promise.resolve({
                    data: rows.filter((r) => r.flag_name === name).slice(0, 1)
                      .map((r) => ({ enabled: r.enabled })),
                    error: null,
                  });
                },
              };
            },
            in(_col: string, names: string[]) {
              reads.push({ mode: "in", names: [...names] });
              if (opts.throws) throw new Error("transport");
              if (opts.error) {
                return Promise.resolve({ data: null, error: { message: "x" } });
              }
              return Promise.resolve({
                data: rows.filter((r) => names.includes(r.flag_name)),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  return client;
}

Deno.test("readSwitch: one name twice is one read", async () => {
  const client = flagClient([{ flag_name: "a_v1", enabled: true }]);
  equal(await readSwitch(client, "a_v1", 1_000), true);
  equal(await readSwitch(client, "a_v1", 1_000 + 44_999), true);
  equal(client.reads.length, 1);
});

Deno.test("readSwitches: five names is one read, then readSwitch of each is none", async () => {
  const names = ["a_v1", "b_v1", "c_v1", "d_v1", "e_v1"];
  const client = flagClient([
    { flag_name: "a_v1", enabled: true },
    { flag_name: "b_v1", enabled: false },
    { flag_name: "c_v1", enabled: true },
  ]);
  const got = await readSwitches(client, names, 1_000);
  equal(client.reads.length, 1);
  equal(client.reads[0].mode, "in");
  equal(client.reads[0].names.length, 5);
  equal(got.a_v1, true);
  equal(got.b_v1, false);
  equal(got.c_v1, true);
  equal(got.d_v1, false);
  equal(got.e_v1, false);
  for (const name of names) await readSwitch(client, name, 2_000);
  equal(client.reads.length, 1);
});

Deno.test("readSwitches: only names with no fresh answer are read", async () => {
  const client = flagClient([{ flag_name: "a_v1", enabled: true }]);
  await readSwitch(client, "a_v1", 1_000);
  await readSwitches(client, ["a_v1", "b_v1"], 2_000);
  equal(client.reads.length, 2);
  equal(client.reads[1].names.join(","), "b_v1");
  await readSwitches(client, ["a_v1", "b_v1"], 3_000);
  equal(client.reads.length, 2);
});

Deno.test("readSwitch: a missing row reads off", async () => {
  const client = flagClient([]);
  equal(await readSwitch(client, "nope_v1", 1_000), false);
});

Deno.test("readSwitch: an error or throw reads off and is not remembered", async () => {
  const bad = flagClient([{ flag_name: "a_v1", enabled: true }], {
    error: true,
  });
  equal(await readSwitch(bad, "a_v1", 1_000), false);
  equal(await readSwitch(bad, "a_v1", 1_001), false);
  equal(bad.reads.length, 2);
  const thrower = flagClient([{ flag_name: "a_v1", enabled: true }], {
    throws: true,
  });
  equal(await readSwitch(thrower, "a_v1", 1_000), false);
  equal(await readSwitch(thrower, "a_v1", 1_001), false);
  equal(thrower.reads.length, 2);
});

Deno.test("readSwitches: an error reads every name off and remembers none", async () => {
  const bad = flagClient([{ flag_name: "a_v1", enabled: true }], {
    error: true,
  });
  const got = await readSwitches(bad, ["a_v1", "b_v1"], 1_000);
  equal(got.a_v1, false);
  equal(got.b_v1, false);
  await readSwitches(bad, ["a_v1", "b_v1"], 1_001);
  equal(bad.reads.length, 2);
});

Deno.test("readSwitch: expires at 45,001 ms", async () => {
  const rows = [{ flag_name: "a_v1", enabled: true }];
  const client = flagClient(rows);
  equal(await readSwitch(client, "a_v1", 1_000), true);
  rows[0].enabled = false;
  equal(
    await readSwitch(client, "a_v1", 1_000 + SWITCH_ANSWER_TTL_MS - 1),
    true,
  );
  equal(
    await readSwitch(client, "a_v1", 1_000 + SWITCH_ANSWER_TTL_MS + 1),
    false,
  );
  equal(client.reads.length, 2);
});

Deno.test("two clients do not share an answer without EdgeRuntime", async () => {
  // deno-lint-ignore no-explicit-any
  equal("EdgeRuntime" in (globalThis as any), false);
  const a = flagClient([{ flag_name: "a_v1", enabled: true }]);
  const b = flagClient([{ flag_name: "a_v1", enabled: false }]);
  equal(await readSwitch(a, "a_v1", 1_000), true);
  equal(await readSwitch(b, "a_v1", 1_000), false);
});

Deno.test("inside EdgeRuntime one answer is shared by every client", async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  g.EdgeRuntime = { waitUntil: () => {} };
  _resetSwitchCacheForTest();
  try {
    const a = flagClient([{ flag_name: "a_v1", enabled: true }]);
    const b = flagClient([{ flag_name: "a_v1", enabled: false }]);
    equal(await readSwitch(a, "a_v1", 1_000), true);
    equal(await readSwitch(b, "a_v1", 1_001), true);
    equal(b.reads.length, 0);
  } finally {
    delete g.EdgeRuntime;
    _resetSwitchCacheForTest();
  }
});
