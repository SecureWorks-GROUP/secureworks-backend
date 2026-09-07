// deno-lint-ignore-file no-import-prefix require-await
// Regression: ops-api/index.ts Deno type-safety baseline (8 pre-existing errors).
// Proves control-flow wiring + pure typing helpers without production I/O.
// No network. No live Supabase. No Board/Xero mutation.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _collectUniqueStringIdsForTest,
  _syncFencingNeighboursForTest,
  _syncFromScopeJsonForTest,
} from "./index.ts";

const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

// ── Source-level control-flow regressions ───────────────────────────────────

Deno.test("trade portal outer switch includes get_trade_invoice + save_trade_invoice_draft", () => {
  // Outer fall-through cases narrow `action` for the inner switch. Omitting these
  // two made their inner cases unreachable (TS2678) while the live handlers still
  // existed — Deno check treated them as dead code.
  const tradeBlock = INDEX_SRC.match(
    /case 'my_jobs':[\s\S]*?case 'submit_makesafe_report': \{/,
  );
  assert(tradeBlock, "trade portal outer switch block not found");
  assert(
    tradeBlock[0].includes("case 'get_trade_invoice':"),
    "get_trade_invoice missing from outer trade case list",
  );
  assert(
    tradeBlock[0].includes("case 'save_trade_invoice_draft':"),
    "save_trade_invoice_draft missing from outer trade case list",
  );
  assert(
    tradeBlock[0].includes("case 'trade_quote_extract':"),
    "trade_quote_extract missing from outer trade case list",
  );
});

Deno.test("reconcile_transaction returns json so serve Handler never yields undefined", () => {
  // Prior bug: undeclared result assignment + break left the serve callback as
  // Promise<Response | undefined> (TS2345) and TS2304 on result.
  const start = INDEX_SRC.indexOf("case 'reconcile_transaction': {");
  assert(start >= 0, "reconcile_transaction case not found");
  const end = INDEX_SRC.indexOf("\n      }", start);
  assert(end > start, "reconcile_transaction case body end not found");
  const block = INDEX_SRC.slice(start, end);
  assert(
    block.includes(
      "return json({ success: true, transaction_id: xero_txn_id",
    ),
    "reconcile_transaction must return json with success/transaction_id/status shape",
  );
  // Executable assignment only (ignore comments that mention the old pattern).
  const executable = block
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join("\n");
  assert(
    !/\bresult\s*=/.test(executable),
    "reconcile_transaction must not assign undeclared result + break",
  );
  assert(
    !/\bbreak\b/.test(executable),
    "reconcile_transaction must return, not break out of the action switch",
  );
});

Deno.test("fencing neighbour sync handlers declare explicit Promise return types", () => {
  // Mutual recursion without annotations made both functions implicit any (TS7023).
  assert(
    /async function syncFencingNeighbours\([^)]*\):\s*Promise<FencingNeighbourSyncResult>/
      .test(
        INDEX_SRC,
      ),
    "syncFencingNeighbours must declare Promise<FencingNeighbourSyncResult>",
  );
  assert(
    /async function syncFromScopeJson\([^)]*\):\s*Promise<FencingNeighbourSyncResult>/
      .test(
        INDEX_SRC,
      ),
    "syncFromScopeJson must declare Promise<FencingNeighbourSyncResult>",
  );
});

// ── Pure helper: unique string id collection (detailJobIds / xeroContactIds) ─

Deno.test("collectUniqueStringIds narrows and dedupes string ids only", () => {
  assertEquals(
    _collectUniqueStringIdsForTest([
      "a",
      "",
      "b",
      "a",
      null,
      undefined,
      12,
      "c",
      false,
      "  ", // whitespace-only is still a non-empty string — keep as-is (source fidelity)
    ]),
    ["a", "b", "c", "  "],
  );
  assertEquals(_collectUniqueStringIdsForTest([]), []);
  assertEquals(_collectUniqueStringIdsForTest([null, 0, false, {}]), []);
});

Deno.test("collectUniqueStringIds matches get_trade_invoice job_id filtering intent", () => {
  // Mirrors detailLines.map(l => l?.job_id) then filter non-empty strings.
  const detailLines = [
    { job_id: "job-1" },
    { job_id: null },
    { job_id: "job-2" },
    { job_id: "job-1" },
    {},
    { job_id: "" },
  ];
  const detailJobIds = _collectUniqueStringIdsForTest(
    detailLines.map((l) => l?.job_id),
  );
  assertEquals(detailJobIds, ["job-1", "job-2"]);
  // filter((id) => !refByJob[id]) must accept string[] without cast
  const refByJob: Record<string, string> = { "job-1": "AJBR-1" };
  const missing = detailJobIds.filter((id) => !refByJob[id]);
  assertEquals(missing, ["job-2"]);
});

// ── Sync handlers: early exit shape (no GHL/Xero/network) ───────────────────

function makeSyncClient(job: Record<string, unknown> | null) {
  return {
    from(_table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.single = async () =>
        job
          ? { data: job, error: null }
          : { data: null, error: { message: "not found" } };
      chain.update = () => ({ eq: async () => ({ data: null, error: null }) });
      const insertResult = {
        select: () => ({
          single: async () => ({ data: { id: "new" }, error: null }),
        }),
        catch: async () => null,
      };
      chain.insert = () => insertResult;
      return chain;
    },
  };
}

Deno.test("syncFencingNeighbours early-exits when no neighbours in pricing or scope", async () => {
  const client = makeSyncClient({
    id: "job-1",
    job_number: "F-1",
    type: "fencing",
    client_name: "Test",
    client_phone: "",
    client_email: "",
    site_address: "",
    site_suburb: "",
    ghl_contact_id: null,
    xero_contact_id: null,
    pricing_json: {},
    scope_json: { job: { neighboursRequired: false, neighbours: [] } },
  });
  const result = await _syncFencingNeighboursForTest(client, {
    job_id: "job-1",
  });
  assertEquals(result.success, true);
  assertEquals(result.synced_count, 0);
  assertEquals(result.message, "No neighbours to sync");
});

Deno.test("syncFromScopeJson builds splits then re-enters fencing sync", async () => {
  let pricingWritten: unknown = null;
  const job = {
    id: "job-2",
    job_number: "F-2",
    type: "fencing",
    client_name: "Client",
    client_phone: "",
    client_email: "",
    site_address: "",
    site_suburb: "",
    ghl_contact_id: null,
    xero_contact_id: null,
    pricing_json: {},
    scope_json: {
      job: {
        neighboursRequired: true,
        neighbours: [],
        runs: [{ lengthM: 10, name: "Run 1" }],
        pricePerMetre: 100,
      },
    },
  };
  let callCount = 0;
  const client = {
    from(_table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.single = async () => {
        callCount++;
        if (callCount === 1) {
          return { data: { ...job }, error: null };
        }
        // Second entry (after synthetic splits write): process primary + neighbour.
        return {
          data: {
            ...job,
            pricing_json: {
              neighbour_splits: {
                method: "per_run",
                neighbours: [{
                  name: "N",
                  phone: "",
                  portion_ex_gst: 0,
                  share_percent: 50,
                }],
              },
            },
          },
          error: null,
        };
      };
      chain.update = (payload: Record<string, unknown>) => {
        pricingWritten = payload.pricing_json;
        return {
          eq: async () => ({ data: null, error: null }),
        };
      };
      const insertResult = {
        select: () => ({
          single: async () => ({ data: { id: "c1" }, error: null }),
        }),
        catch: async () => null,
      };
      chain.insert = () => insertResult;
      return chain;
    },
  };

  const result = await _syncFromScopeJsonForTest(client, job, {
    neighboursRequired: true,
    neighbours: [{ id: "nb1", firstName: "Pat", lastName: "N", phone: "" }],
    runs: [{ lengthM: 10, name: "Run 1", neighbourId: "nb1" }],
    pricePerMetre: 100,
  });

  assertEquals(result.success, true);
  assert(
    result.synced_count >= 1,
    "expected at least primary + neighbour contact",
  );
  assert(
    pricingWritten != null,
    "scope path must persist synthetic neighbour_splits",
  );
});
