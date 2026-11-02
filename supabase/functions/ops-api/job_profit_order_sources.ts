// INT-23 / INT-25.3: expose the recorded bill -> order -> frozen demand chain.
// Read only. An order manifest is not an allocation of invoice money to lines.
// deno-lint-ignore-file no-explicit-any
import { readWorkOrderScopeIdentity } from "./job_work_order_scope_identity.ts";

const MAX_ROWS = 2000;
const LINE_ALLOCATION_UNKNOWN = {
  status: "unknown",
  reason: "invoice_line_allocation_not_recorded",
} as const;

export async function readJobProfitOrderSources(
  client: any,
  jobId: string,
  costEvents: any[],
) {
  const events = costEvents.filter((e) => e.source === "materials_fact");
  const unavailable = (reason: string) => ({
    status: "unknown",
    reason,
    basis: "returned_materials_fact_events",
    links: [],
  });
  if (events.length === 0) {
    return {
      status: "ok",
      reason: null,
      basis: "returned_materials_fact_events",
      links: [],
    };
  }
  try {
    const facts = await client.from("job_materials_facts")
      .select("id, job_id, xero_invoice_id, matched_po_id")
      .eq("job_id", jobId).limit(MAX_ROWS + 1);
    if (facts.error || !Array.isArray(facts.data)) {
      return unavailable("facts_unreadable");
    }
    if (facts.data.length > MAX_ROWS) return unavailable("fact_coverage_limit");
    const orders = await client.from("purchase_orders")
      .select("id, job_id, po_number, line_items")
      .eq("job_id", jobId).limit(MAX_ROWS + 1);
    if (orders.error || !Array.isArray(orders.data)) {
      return unavailable("orders_unreadable");
    }
    if (orders.data.length > MAX_ROWS) {
      return unavailable("order_coverage_limit");
    }
    const factById = new Map<string, any>(
      facts.data.map((f: any) => [f.id, f]),
    );
    const orderById = new Map<string, any>(
      orders.data.map((o: any) => [o.id, o]),
    );
    const manifests = new Map<
      string,
      Awaited<ReturnType<typeof readWorkOrderScopeIdentity>>
    >();
    const links: any[] = [];
    for (const event of events) {
      const fact = factById.get(event.source_id);
      const base = {
        fact_id: event.source_id,
        invoice_id: event.document_id ?? null,
        purchase_order_id: null as string | null,
        po_number: null as string | null,
        line_allocation: LINE_ALLOCATION_UNKNOWN,
      };
      const unknown = (reason: string) => ({
        ...base,
        status: "unknown",
        reason,
        scope_lines: null,
      });
      if (
        !fact || fact.job_id !== jobId ||
        fact.xero_invoice_id !== event.document_id
      ) {
        links.push(unknown("fact_identity_unverified"));
        continue;
      }
      base.purchase_order_id = fact.matched_po_id ?? null;
      if (!fact.matched_po_id) {
        links.push(unknown("order_link_not_recorded"));
        continue;
      }
      const order = orderById.get(fact.matched_po_id);
      if (!order || order.job_id !== jobId) {
        links.push(unknown("order_identity_unverified"));
        continue;
      }
      base.po_number = order.po_number ?? null;
      if (!Array.isArray(order.line_items) || order.line_items.length === 0) {
        links.push(unknown("order_lines_missing"));
        continue;
      }
      const scopeLines: any[] = [];
      const seen = new Set<string>();
      let problem: string | null = null;
      for (const line of order.line_items) {
        if (
          !line || typeof line.source_version_id !== "string" ||
          typeof line.source_line_id !== "string" || !line.source_line_id ||
          !["fence_scope_revision", "patio_scope_revision"].includes(
            line.source_kind,
          )
        ) {
          problem = "order_source_not_recorded";
          break;
        }
        const pair = JSON.stringify([
          line.source_version_id,
          line.source_line_id,
        ]);
        if (seen.has(pair)) {
          problem = "order_source_ambiguous";
          break;
        }
        seen.add(pair);
        let manifest = manifests.get(line.source_version_id);
        if (!manifest) {
          manifest = await readWorkOrderScopeIdentity(
            client,
            jobId,
            line.source_version_id,
          );
          manifests.set(line.source_version_id, manifest);
        }
        if (manifest.status !== "known") {
          problem = manifest.reason;
          break;
        }
        if (!manifest.scope_line_ids?.includes(line.source_line_id)) {
          problem = "order_line_absent_from_scope";
          break;
        }
        scopeLines.push({
          material_line_id: line.line_id ?? null,
          scope_revision_id: manifest.scope_revision_id,
          scope_revision_status: manifest.revision_status,
          scope_hash: manifest.scope_hash,
          scope_line_id: line.source_line_id,
        });
      }
      links.push(
        problem ? unknown(problem) : {
          ...base,
          status: "verified_order_manifest",
          reason: null,
          scope_lines: scopeLines,
        },
      );
    }
    return {
      status: "ok",
      reason: null,
      basis: "returned_materials_fact_events",
      links,
    };
  } catch {
    return unavailable("source_read_failed");
  }
}
