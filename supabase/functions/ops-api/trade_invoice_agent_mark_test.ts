import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  agentMarkFromDraftRow,
  readTradeInvoiceAgentMark,
  stampTradeInvoiceAgentMark,
} from "./trade_invoice_agent_mark.ts";

// A tiny PostgREST stand-in: records every call and answers with what the
// test queued. It returns { data, error } and never throws, like the real one.
function fakeClient(answers: Array<{ data?: unknown; error?: unknown }>) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      const call: Record<string, unknown> = { table, eq: {} as Record<string, unknown> };
      calls.push(call);
      const chain = {
        select(columns: string) {
          call.select = columns;
          return chain;
        },
        update(values: unknown) {
          call.update = values;
          return chain;
        },
        eq(column: string, value: unknown) {
          (call.eq as Record<string, unknown>)[column] = value;
          return chain;
        },
        maybeSingle() {
          const answer = answers.shift() ?? { data: null, error: null };
          return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

Deno.test("a draft an agent added lines to carries a mark", () => {
  assertEquals(
    agentMarkFromDraftRow({ created_by_agent: true, agent_label: "grok", draft_origin: "agent" }),
    { created_by_agent: true, agent_label: "grok", draft_origin: "agent" },
  );
  // Staff started it, an agent added lines later: the origin stays staff.
  assertEquals(
    agentMarkFromDraftRow({ created_by_agent: true, agent_label: "  grok   bot ", draft_origin: "staff" }),
    { created_by_agent: true, agent_label: "grok bot", draft_origin: "staff" },
  );
  assertEquals(
    agentMarkFromDraftRow({ created_by_agent: true, agent_label: "", draft_origin: "robot" }),
    { created_by_agent: true, agent_label: null, draft_origin: null },
  );
});

Deno.test("a draft no agent touched carries no mark", () => {
  assertEquals(agentMarkFromDraftRow(null), null);
  assertEquals(agentMarkFromDraftRow({}), null);
  assertEquals(agentMarkFromDraftRow({ created_by_agent: false, agent_label: "grok" }), null);
  // Only the boolean true counts. A label alone names nobody.
  assertEquals(agentMarkFromDraftRow({ created_by_agent: "true", agent_label: "grok" }), null);
});

Deno.test("the mark is read from the trade's own draft, before it is replaced", async () => {
  const { client, calls } = fakeClient([
    { data: { id: "draft-1", created_by_agent: true, agent_label: "grok", draft_origin: "agent" } },
  ]);
  const mark = await readTradeInvoiceAgentMark(client, "draft-1", "user-1");
  assertEquals(mark, { created_by_agent: true, agent_label: "grok", draft_origin: "agent" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "trade_invoices");
  assertEquals(calls[0].eq, { id: "draft-1", user_id: "user-1" });
  assertEquals(calls[0].update, undefined);
});

Deno.test("no draft, or a failed read, gives no mark and does not throw", async () => {
  const none = fakeClient([]);
  assertEquals(await readTradeInvoiceAgentMark(none.client, null, "user-1"), null);
  assertEquals(none.calls.length, 0);

  const failed = fakeClient([{ error: { code: "42703" } }]);
  assertEquals(await readTradeInvoiceAgentMark(failed.client, "draft-1", "user-1"), null);

  const throwing = { from() { throw new Error("network"); } };
  assertEquals(await readTradeInvoiceAgentMark(throwing, "draft-1", "user-1"), null);
});

Deno.test("the invoice that replaced the draft is stamped with the three fields only", async () => {
  const { client, calls } = fakeClient([{ data: { id: "inv-2" } }]);
  const stamped = await stampTradeInvoiceAgentMark(client, "inv-2", "user-1", {
    created_by_agent: true,
    agent_label: "grok",
    draft_origin: "agent",
  });
  assertEquals(stamped, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].update, { created_by_agent: true, agent_label: "grok", draft_origin: "agent" });
  assertEquals(calls[0].eq, { id: "inv-2", user_id: "user-1" });
});

Deno.test("nothing is written without a mark, and a failed stamp never throws", async () => {
  const none = fakeClient([]);
  assertEquals(await stampTradeInvoiceAgentMark(none.client, "inv-2", "user-1", null), false);
  assertEquals(await stampTradeInvoiceAgentMark(none.client, null, "user-1", {
    created_by_agent: true,
    agent_label: "grok",
    draft_origin: "agent",
  }), false);
  assertEquals(none.calls.length, 0);

  const mark = { created_by_agent: true as const, agent_label: "grok", draft_origin: "agent" as const };
  const failed = fakeClient([{ error: { code: "23514" } }]);
  assertEquals(await stampTradeInvoiceAgentMark(failed.client, "inv-2", "user-1", mark), false);
  const noRow = fakeClient([{ data: null }]);
  assertEquals(await stampTradeInvoiceAgentMark(noRow.client, "inv-2", "user-1", mark), false);
  const throwing = { from() { throw new Error("network"); } };
  assertEquals(await stampTradeInvoiceAgentMark(throwing, "inv-2", "user-1", mark), false);
});

// ── wiring in generate_trade_invoice (source order, like the money audit) ──

const INDEX = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

Deno.test("generate_trade_invoice reads the mark before the persist and stamps it after", () => {
  const readAt = INDEX.indexOf("const priorDraftAgentMark = await readTradeInvoiceAgentMark(client, priorDraftId, tradeUser.id)");
  const payloadAt = INDEX.indexOf("const invoicePayload = {");
  const persistedAt = INDEX.indexOf("const invoice = { id: invoiceId }");
  const stampAt = INDEX.indexOf("await stampTradeInvoiceAgentMark(client, invoiceId, tradeUser.id, priorDraftAgentMark)");
  assertEquals(readAt > 0, true, "the draft's mark is read");
  assertEquals(readAt < payloadAt, true, "read before the new invoice is built, while the draft still exists");
  assertEquals(persistedAt > payloadAt, true);
  assertEquals(stampAt > persistedAt, true, "stamped only after the invoice is persisted");
  assertEquals(stampAt - persistedAt < 200, true, "stamped straight after the persist");
});

Deno.test("the office list and the trade's own list both return the mark", () => {
  for (const name of ["MY_TRADE_INVOICE_COLUMNS", "TRADE_BILLS_COLUMNS"]) {
    const at = INDEX.indexOf(`const ${name} = '`);
    const line = INDEX.slice(at, INDEX.indexOf("\n", at));
    assertEquals(line.includes("created_by_agent"), true, name + " carries created_by_agent");
    assertEquals(line.includes("agent_label"), true, name + " carries agent_label");
  }
});
