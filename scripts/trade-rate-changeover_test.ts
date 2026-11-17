import {
  type Database,
  type Dependencies,
  type Query,
  runChangeover,
} from "./trade-rate-changeover.ts";

const scratch = "/Volumes/SSD/agent-scratch/cx-p1-02-rates";
const file = `${scratch}/ZZTEST.csv`;
const idsFile = `${scratch}/ZZTEST-active.txt`;
const monday = "2026-11-16";
// Generated fixture coordinates and amounts never enter the repository.
const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
const amounts = ids.map((_, i) => (i + 1).toFixed(2));
const csv = (keys = ids, rates = amounts) =>
  "user_id,new_hourly_rate\n" +
  keys.map((id, i) => `${id},${rates[i]}`).join("\n");
function assert(ok: unknown, message = "assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

function harness(sheet = csv(), active = ids.join("\n")) {
  const output: string[] = [];
  const org = crypto.randomUUID();
  let committed: { rates: unknown[][]; start: unknown; flag: boolean } = {
    rates: [],
    start: null,
    flag: false,
  };
  let transactions = 0;
  let connections = 0;
  let failInsert = false;
  let existing = false;
  let missingFlag = false;
  let closed = false;
  const db: Database = {
    async transaction<T>(write: boolean, body: (query: Query) => Promise<T>) {
      transactions++;
      const draft = structuredClone(committed);
      const result = await body(async (sql, params = []) => {
        if (sql.includes("FROM public.users")) {
          return ids.map((user_id) => ({ user_id, org_id: org }));
        }
        if (sql.includes("FROM public.trade_rates")) {
          return existing ? [{ user_id: ids[0], org_id: org }] : [];
        }
        assert(write, "a dry run attempted a write");
        if (sql.startsWith("INSERT INTO public.trade_rates")) {
          if (failInsert && draft.rates.length === 1) {
            throw new Error("database failure");
          }
          draft.rates.push([...params]);
          return [];
        }
        if (sql.startsWith("UPDATE public.trade_pay_settings")) {
          draft.start = params[0];
          return [{ id: 1 }];
        }
        if (sql.startsWith("UPDATE public.feature_flags")) {
          if (missingFlag) return [];
          draft.flag = true;
          return [{ flag_name: "trade_pay_inclusive_super_v1" }];
        }
        throw new Error("unexpected query");
      });
      if (write) committed = draft;
      return result;
    },
    async close() {
      closed = true;
    },
  };
  const deps: Dependencies = {
    readTextFile: async (path) => path === idsFile ? active : sheet,
    realPath: async (path) => path,
    gitEntryExists: async () => false,
    connect: async () => {
      connections++;
      return db;
    },
    print: (line) => output.push(line),
  };
  return {
    deps,
    output,
    state: () => ({ committed, transactions, connections, closed }),
    fail: () => {
      failInsert = true;
    },
    conflict: () => {
      existing = true;
    },
    missingFlag: () => {
      missingFlag = true;
    },
  };
}
const args = ["--file", file, "--effective-from", monday];

Deno.test("dry run previews exactly the input rows and writes nothing", async () => {
  const h = harness();
  assert(await runChangeover(args, h.deps) === 0);
  assert(
    h.output.slice(0, 3).every((line, i) =>
      line === `${ids[i]}, ${monday}, ${amounts[i]}`
    ),
  );
  assert(h.output.includes("insert 3"));
  assert(h.output.includes("already present 0"));
  assert(h.state().committed.rates.length === 0 && !h.state().committed.flag);
  assert(h.state().closed);
});

Deno.test("invalid input refuses before connecting, without exposing values", async () => {
  const bad = [
    { args: ["--file", file, "--effective-from", "2026-11-17"], sheet: csv() },
    { args, sheet: csv(ids, [amounts[0] + "1", ...amounts.slice(1)]) },
    { args, sheet: csv([ids[0], ids[0], ids[2]]) },
    { args, sheet: csv(ids, ["", ...amounts.slice(1)]) },
    { args, sheet: csv(["ZZTEST-invalid", ...ids.slice(1)]) },
    { args: [...args, "--apply"], sheet: csv() },
  ];
  for (const input of bad) {
    const h = harness(input.sheet);
    assert(await runChangeover(input.args, h.deps) === 1);
    assert(h.state().connections === 0);
    assert(!ids.some((id) => h.output.join("\n").includes(id)));
    if (input.sheet !== csv()) assert(h.output.join("\n").includes("row "));
  }
});

Deno.test("repo paths, including a symlink destination, are refused", async () => {
  const h = harness();
  h.deps.gitEntryExists = async (path) => path.endsWith("/ZZTEST-repo/.git");
  h.deps.realPath = async () => "/ZZTEST-repo/sheet.csv";
  assert(await runChangeover(args, h.deps) === 1);
  assert(h.state().connections === 0);
});

Deno.test("existing date lists the conflict and stops inserts", async () => {
  const h = harness();
  h.conflict();
  assert(
    await runChangeover([...args, "--apply", "--with-switch"], h.deps) === 1,
  );
  assert(h.output.includes("already present 1"));
  assert(h.output.includes(`already present: ${ids[0]}`));
  assert(h.state().committed.rates.length === 0 && !h.state().committed.flag);
});

Deno.test("apply commits rates, date and switch as one change", async () => {
  const h = harness();
  assert(
    await runChangeover([...args, "--apply", "--with-switch"], h.deps) === 0,
  );
  const { committed, transactions } = h.state();
  assert(transactions === 1 && committed.rates.length === 3);
  assert(
    committed.rates.every((row, i) =>
      row[1] === ids[i] && row[2] === amounts[i] && row[3] === monday
    ),
  );
  assert(committed.start === monday && committed.flag);
  assert(h.output.includes("inserted 3") && h.output.includes("switch on"));
});

Deno.test("failed insert or absent switch rolls back the entire changeover", async () => {
  for (const failure of ["insert", "switch"]) {
    const h = harness();
    if (failure === "insert") h.fail();
    else h.missingFlag();
    assert(
      await runChangeover([...args, "--apply", "--with-switch"], h.deps) === 1,
    );
    assert(h.state().committed.rates.length === 0);
    assert(h.state().committed.start === null && !h.state().committed.flag);
    assert(h.state().closed);
  }
});

Deno.test("coverage prints all four counts only and never connects", async () => {
  const h = harness(csv([ids[0], ids[0], ids[2]]), [ids[0], ids[1]].join("\n"));
  assert(
    await runChangeover(
      ["--coverage", "--file", file, "--ids", idsFile],
      h.deps,
    ) === 1,
  );
  assert(
    h.output.join("\n") ===
      "on both lists 1\non the sheet twice 1\nactive but not on the sheet 1\non the sheet but not active 1",
  );
  assert(h.state().connections === 0);
  const complete = harness();
  assert(
    await runChangeover(
      ["--coverage", "--file", file, "--ids", idsFile],
      complete.deps,
    ) === 0,
  );
  assert(complete.output[0] === "on both lists 3");
  assert(complete.output.slice(1).every((line) => line.endsWith(" 0")));
  assert(complete.state().connections === 0);
});
