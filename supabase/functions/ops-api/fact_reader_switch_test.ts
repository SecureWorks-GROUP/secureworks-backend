// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assembleJobDossierForTest,
  _getJobContextFactsForTest,
} from "./index.ts";
import { debtContextCoverage, invoiceContext } from "./invoice_context.ts";
import { isCurrentContextFact } from "./context_visibility.ts";

const JOB = "00000000-0000-4000-8000-000000000401";
const ORG = "00000000-0000-4000-8000-000000000001";
const RETIRED =
  "The old AI facts list is retired. Read the job story for what was said and what is owed.";

function stub(flag: boolean | null | "error" | "throw") {
  const reads: string[] = [];
  const failures = new Set<string>();
  const tables: Record<string, any[]> = {
    feature_flags: flag === null
      ? []
      : [{ flag_name: "context_fact_read_v1", enabled: flag }],
    jobs: [{
      id: JOB,
      job_number: "ZZTEST-401",
      org_id: ORG,
      type: "fencing",
      status: "accepted",
      ghl_contact_id: "fixture-contact",
    }],
    current_job_context_facts: [{
      id: "fact-401",
      job_id: JOB,
      kind: "note",
      value: { text: "ZZTEST-401" },
      _context_store: "job_context",
      provenance: { extractor: "luna_v2" },
    }],
    xero_invoices: [{
      xero_invoice_id: "00000000-0000-4000-8000-000000000402",
      invoice_number: "ZZTEST-401",
      org_id: ORG,
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      job_id: JOB,
      xero_contact_id: "fixture-xero-contact",
      synced_at: new Date().toISOString(),
    }],
    ghl_conversation_cache: [{ job_id: JOB, message_count: 1 }],
  };
  return {
    reads,
    tables,
    failures,
    rpc: () => Promise.resolve({ data: [], error: null }),
    from(table: string) {
      reads.push(table);
      if (table === "feature_flags" && flag === "throw") {
        throw new Error("unavailable");
      }
      let single = false;
      const filters: Array<(r: any) => boolean> = [];
      const q: any = {};
      for (
        const method of [
          "select",
          "order",
          "limit",
          "range",
          "or",
          "not",
          "gt",
          "gte",
          "lt",
          "lte",
          "is",
        ]
      ) {
        q[method] = () => q;
      }
      q.eq = (key: string, value: unknown) => {
        filters.push((r) => r[key] === value);
        return q;
      };
      q.neq = (key: string, value: unknown) => {
        filters.push((r) => r[key] !== value);
        return q;
      };
      q.in = (key: string, values: unknown[]) => {
        filters.push((r) => values.includes(r[key]));
        return q;
      };
      q.ilike = (key: string, value: string) => {
        filters.push((r) =>
          String(r[key]).toLowerCase() === value.toLowerCase()
        );
        return q;
      };
      q.maybeSingle = q.single = () => {
        single = true;
        return q;
      };
      q.then = (resolve: any, reject: any) => {
        const rows = (tables[table] || []).filter((r) =>
          filters.every((f) => f(r))
        );
        return Promise.resolve(
          failures.has(table) || (table === "feature_flags" && flag === "error")
            ? { data: null, error: { message: "unavailable" } }
            : { data: single ? rows[0] ?? null : rows, error: null },
        ).then(resolve, reject);
      };
      return q;
    },
  };
}

Deno.test("fact readers: retirement, T24 dossier, enabled fallback and minute cache", async () => {
  const realNow = Date.now;
  let now = realNow() + 60_001;
  Date.now = () => now;
  try {
    for (const flag of [false, true, null, "error", "throw"] as const) {
      now += 60_001;
      const client = stub(flag);
      const retired = flag === false;
      const direct = await _getJobContextFactsForTest(client, {
        job_uuids: [JOB],
      });
      const dossier: any = await _assembleJobDossierForTest(client, {
        job_id: JOB,
        mode: "chat_summary",
      });
      const deps = {
        client,
        orgId: ORG,
        isCurrentContextFact,
        getJobConversation: async () => ({ messages: [] }),
      };
      const invoice = await invoiceContext(
        new URLSearchParams({
          xero_invoice_id: "00000000-0000-4000-8000-000000000402",
        }),
        deps,
      );
      const coverage = await debtContextCoverage(new URLSearchParams(), deps);
      for (const answer of [direct, dossier, invoice, coverage.rows[0]]) {
        assertEquals("facts_retired" in answer, retired);
        if (retired) assertEquals(answer.facts_retired, true);
      }
      assertEquals(direct.rows.length, retired ? 0 : 1);
      assertEquals(dossier.facts.length, retired ? 0 : 1);
      assertEquals(dossier.temporaryFacts, []);
      assertEquals(dossier.diagnostics.warnings.includes(RETIRED), retired);
      assertEquals(invoice.facts.length, retired ? 0 : 1);
      assertEquals(coverage.rows[0].facts_count, retired ? 0 : 1);
      assertEquals(coverage.rows[0].complete, true);
      assertEquals(coverage.totals.complete, 1);
      assertEquals(coverage.totals.facts_present, retired ? 0 : 1);
      if (retired) {
        assertEquals(
          client.reads.filter((r) => r === "current_job_context_facts").length,
          0,
        );
        assert(
          !invoice.warnings.some((w) =>
            w.includes("extractor has not written")
          ),
        );
        assert(!invoice.blockers.some((b) => b.code === "facts_missing"));
        assert(!coverage.rows[0].blockers.includes("facts_missing"));
      } else {
        assertEquals(
          client.reads.filter((r) => r === "current_job_context_facts").length,
          5,
        );
      }
      assertEquals(client.reads.filter((r) => r === "feature_flags").length, 1);
    }
    // An office change takes effect at the minute boundary. A retry reads the
    // current rows; missing rows and failed switch reads retain the old path.
    now += 60_001;
    const client = stub(false);
    await _getJobContextFactsForTest(client, { job_uuids: [JOB] });
    client.tables.feature_flags[0].enabled = true;
    assertEquals(
      (await _getJobContextFactsForTest(client, { job_uuids: [JOB] })).rows,
      [],
    );
    now += 60_000;
    assertEquals(
      (await _getJobContextFactsForTest(client, { job_uuids: [JOB] })).rows
        .length,
      1,
    );
    client.tables.current_job_context_facts = [];
    assertEquals(
      (await _getJobContextFactsForTest(client, { job_uuids: [JOB] })).rows,
      [],
    );
    const deps = {
      client, orgId: ORG, isCurrentContextFact,
      getJobConversation: async () => ({ messages: [] }),
    };
    const missing = await debtContextCoverage(new URLSearchParams(), deps);
    assertEquals(missing.rows[0].complete, false);
    assert(missing.rows[0].blockers.includes("facts_missing"));
    client.tables.feature_flags[0].enabled = false;
    now += 60_001;
    const retiredCoverage = () => debtContextCoverage(new URLSearchParams(), deps);
    assertEquals((await retiredCoverage()).rows[0].complete, true);
    // Retirement waives only facts. Missing conversation and failed reads
    // still refuse completeness, including a repeated read after the fault.
    client.tables.ghl_conversation_cache = [];
    const noConversation = await retiredCoverage();
    assertEquals(noConversation.rows[0].complete, false);
    assert(noConversation.rows[0].blockers.includes("conversation_missing"));
    client.tables.ghl_conversation_cache = [{ job_id: JOB, message_count: 1 }];
    client.failures.add("ghl_conversation_cache");
    for (let retry = 0; retry < 2; retry++) {
      const failed = await retiredCoverage();
      assertEquals(failed.rows[0].complete, false);
      assert(failed.rows[0].blockers.includes("conversation_unreadable"));
    }
    client.failures.clear();
    assertEquals((await retiredCoverage()).rows[0].complete, true);
    client.tables.xero_invoices[0].synced_at = null;
    const officeChange = await retiredCoverage();
    assertEquals(officeChange.rows[0].complete, false);
    assert(officeChange.rows[0].blockers.includes("xero_stale"));
    assertEquals(client.reads.filter((r) => r === "feature_flags").length, 3);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("fact_readers_named", async () => {
  for (
    const [file, allowed] of [
      ["index.ts", ["getJobContextFacts", "assembleJobDossier"]],
      ["invoice_context.ts", ["factsCountByJob", "invoiceContext"]],
    ] as const
  ) {
    let owner: string | undefined;
    const lines = (await Deno.readTextFile(new URL(file, import.meta.url)))
      .split("\n");
    for (const [index, line] of lines.entries()) {
      const declaration = line.match(
        /^(?:export )?(?:async )?function (\w+)\(/,
      );
      if (declaration) owner = declaration[1];
      if (line.includes("current_job_context_facts")) {
        assert(
          (allowed as readonly string[]).includes(owner ?? ""),
          `${file}:${index + 1}: unlisted fact reader`,
        );
      }
      if (line === "}") owner = undefined;
    }
  }
});
