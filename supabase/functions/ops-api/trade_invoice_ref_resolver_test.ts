import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _refMatchesExternalRefForTest,
  _resolveJobsByExternalRefForTest,
} from "./index.ts";

function makeResolverClient(details: any[], jobs: any[]) {
  function builder(table: string) {
    const rows = table === "makesafe_job_details"
      ? details.slice()
      : jobs.slice();
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      ilike: (col: string, pattern: string) => {
        const needle = String(pattern).replace(/%/g, "").toLowerCase();
        preds.push((r) =>
          String(r?.[col] || "").toLowerCase().includes(needle)
        );
        return b;
      },
      not: (col: string, op: string, val: string) => {
        if (op === "in") {
          const excluded = val.replace(/[()]/g, "").split(",").map((s) =>
            s.trim().replace(/^['\"]|['\"]$/g, "")
          );
          preds.push((r) => !excluded.includes(String(r?.[col] || "")));
        }
        return b;
      },
      in: async (col: string, vals: any[]) => {
        const data = rows.filter((r) =>
          vals.includes(r?.[col]) && preds.every((p) => p(r))
        );
        return { data, error: null };
      },
      limit: async () => {
        const data = rows.filter((r) => preds.every((p) => p(r)));
        return { data, error: null };
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("trade invoice ref matcher accepts AJ shorthand for stored AJBR refs", () => {
  assertEquals(_refMatchesExternalRefForTest("AJ66934", "AJBR-66934"), true);
  assertEquals(_refMatchesExternalRefForTest("AJBR 66934", "AJ66934"), true);
  assertEquals(_refMatchesExternalRefForTest("66934", "AJBR-66934"), true);
});

Deno.test("trade invoice ref matcher keeps unrelated prefixes separate", () => {
  assertEquals(_refMatchesExternalRefForTest("AJ66934", "MLB-66934"), false);
  assertEquals(_refMatchesExternalRefForTest("AJS66934", "AJBR-66934"), false);
  assertEquals(_refMatchesExternalRefForTest("MLB25248", "MLB-25248"), true);
});

Deno.test("trade invoice resolver maps AJ typed refs to active AJBR jobs", async () => {
  const client = makeResolverClient(
    [
      { job_id: "job-aj", external_ref: "AJBR-66934" },
      { job_id: "job-mlb", external_ref: "MLB-66934" },
    ],
    [
      { id: "job-aj", job_number: "SWMS-AJ", status: "complete" },
      { id: "job-mlb", job_number: "SWMS-MLB", status: "complete" },
    ],
  );

  const res = await _resolveJobsByExternalRefForTest(
    client,
    ["AJ66934"],
    "('cancelled','archived')",
  );

  assertEquals(Object.keys(res.byId).sort(), ["job-aj"]);
  assertEquals(res.byRef.AJ66934.map((j: any) => j.id), ["job-aj"]);
});

Deno.test("trade invoice resolver leaves bare numeric duplicate cores ambiguous", async () => {
  const client = makeResolverClient(
    [
      { job_id: "job-aj", external_ref: "AJBR-66934" },
      { job_id: "job-mlb", external_ref: "MLB-66934" },
    ],
    [
      { id: "job-aj", job_number: "SWMS-AJ", status: "complete" },
      { id: "job-mlb", job_number: "SWMS-MLB", status: "complete" },
    ],
  );

  const res = await _resolveJobsByExternalRefForTest(
    client,
    ["66934"],
    "('cancelled','archived')",
  );

  assertEquals(Object.keys(res.byId).sort(), ["job-aj", "job-mlb"]);
  assertEquals(res.byRef["66934"].map((j: any) => j.id).sort(), [
    "job-aj",
    "job-mlb",
  ]);
});
