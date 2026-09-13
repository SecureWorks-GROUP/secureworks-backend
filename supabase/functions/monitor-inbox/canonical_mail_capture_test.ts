import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  captureCanonicalMailOccurrence,
  chooseCanonicalLinks,
  extractWorkTokens,
} from "./canonical_mail_capture.ts";

Deno.test("Graph-shaped supplier message extracts unique job/PO/invoice tokens", () => {
  const tokens = extractWorkTokens(
    "PO-JOINT-1 / JOINT-MAIL-1 / INV-JOINT-1 delivery",
    "Confirming purchase order PO-JOINT-1 for job JOINT-MAIL-1 invoice INV-JOINT-1",
  );
  const chosen = chooseCanonicalLinks({
    jobs: ["job-uuid-from-lookup"],
    pos: ["po-uuid-from-lookup"],
    invoices: ["joint-xero-invoice-0001"],
  });
  assertEquals(tokens.jobs.includes("JOINT-MAIL-1"), true);
  assertEquals(tokens.pos[0].startsWith("PO"), true);
  assertEquals(tokens.invoices.includes("INV-JOINT-1"), true);
  assertEquals(chosen.unresolved, false);
  assertEquals(chosen.links.length, 3);
});

Deno.test("two jobs stay unresolved and do not force a thread onto one job", () => {
  const chosen = chooseCanonicalLinks({
    jobs: ["job-a", "job-b"],
    pos: [],
    invoices: [],
  });
  assertEquals(chosen.unresolved, true);
  assertEquals(chosen.links.length, 0);
  assertEquals(chosen.reason, "ambiguous_work_refs");
});

Deno.test("capture adapter calls record_context_mail_occurrence, not a raw insert", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      return { data: { ok: true, created: true, event_id: "e1" }, error: null };
    },
  };
  const out = await captureCanonicalMailOccurrence(client, {
    orgId: "00000000-0000-0000-0000-000000000001",
    mailbox: "admin@secureworkswa.com.au",
    msg: {
      id: "graph-supplier-1",
      internetMessageId: "<po-confirm@supplier.example>",
      conversationId: "thread-1",
      subject: "PO-JOINT-1 / JOINT-MAIL-1 / INV-JOINT-1 delivery",
      bodyPreview: "Supplier confirmation for the purchase order, job and invoice.",
      from: { emailAddress: { address: "supplier@example.test", name: "Example Fencing Supplies" } },
      receivedDateTime: "2026-09-13T03:00:00Z",
      hasAttachments: true,
    },
    actor: "monitor-inbox",
    links: [
      { kind: "job", id: "job-1" },
      { kind: "po", id: "po-1" },
      { kind: "invoice", id: "inv-1" },
    ],
  });
  assertEquals(calls, ["record_context_mail_occurrence"]);
  assertEquals(out.created, true);
});
