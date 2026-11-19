// More than one work order on a job (job_additional_work_orders.ts,
// migration 20261119090000):
//   1. which work order a trade's card bills next (pickTradeWorkOrder),
//   2. the next work order number,
//   3. the words a trade reads carry no amount,
//   4. the invoice mode loader: one work order reads exactly as before; with
//      an additional one the card bills the first one the trade has not
//      billed, while the cap reads the main work order (whose amount changes
//      carry the additional one); a failed billed read never degrades.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  AdditionalWorkOrderError,
  assertNoMoneyInText,
  nextAdditionalWorkOrderNumber,
  parseAdditionalAgreed,
  parseScopeItems,
  pickTradeWorkOrder,
} from "./job_additional_work_orders.ts";
import { loadTradeInvoiceJobModes, TradeInvoiceModeReadError } from "./trade_invoice_mode.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JEAN = "44c1f557-f7b2-4f99-9b6b-d7a0f904a0f5";
const OTHER = "9913309f-35ae-4a71-8e1f-f704ecc526ea";
const RESTO = "b94fe335-6047-43eb-bd8c-a6df770eb505";
const SOLO = "b94fe335-6047-43eb-bd8c-a6df770eb506";
const MAIN = "0130d614-ec87-4f9b-855b-2620b2438b67";
const EXTRA = "0130d614-ec87-4f9b-855b-2620b2438b68";
const SOLO_MAIN = "0130d614-ec87-4f9b-855b-2620b2438b69";

const main = { id: MAIN, kind: "job", wo_number: "WO-SWMS-261709", title: null, agreed_labour_ex: "80.00", approved_at: "2026-11-12T10:58:54Z", assigned_user_id: null };
const nobodyExtra = (o: any) => ({ ...o, assigned_user_id: null });
const extra = { id: EXTRA, kind: "additional", wo_number: "WO-SWRESTO-261719-2", title: "Restoration works", agreed_labour_ex: 432, approved_at: "2026-11-19T01:00:00Z", assigned_user_id: JEAN };

const nobody = nobodyExtra(extra);

// ── 1. The pick ─────────────────────────────────────────────────────────────

Deno.test("pick: the inspection billed, the restoration is next", () => {
  const { options, open } = pickTradeWorkOrder([extra, main], JEAN, 80);
  // The work order named for this trade is listed first; the main one the
  // trade already billed still reads billed.
  assertEquals(options.map((o) => [o.wo_number, o.main, o.billed]), [
    ["WO-SWRESTO-261719-2", false, false],
    ["WO-SWMS-261709", true, true],
  ]);
  assertEquals(open?.id, EXTRA);
  assertEquals(open?.agreed_ex, 432);
});

Deno.test("pick: nothing billed yet, the trade's own named work order before the main one", () => {
  assertEquals(pickTradeWorkOrder([extra, main], JEAN, 0).open?.id, EXTRA);
  // Named for nobody: the main work order first, as before.
  assertEquals(pickTradeWorkOrder([nobody, main], JEAN, 0).open?.id, MAIN);
});

Deno.test("pick: a part payment never covers a work order", () => {
  assertEquals(pickTradeWorkOrder([nobody, main], JEAN, 79.99).open?.id, MAIN);
  assertEquals(pickTradeWorkOrder([extra, main], JEAN, 431.99).open?.id, EXTRA);
});

Deno.test("pick: trade B is offered its own work order first, at its own amount, never the main one", () => {
  // Made-up amounts, roles only: main 500, B's named order 600.
  const mainOrder = { ...main, agreed_labour_ex: 500 };
  const forB = { ...extra, agreed_labour_ex: 600, assigned_user_id: OTHER };
  const b = pickTradeWorkOrder([mainOrder, forB], OTHER, 0);
  assertEquals([b.open?.id, b.open?.agreed_ex], [EXTRA, 600]);
  // Trade A is never offered B's order: one option, the main one.
  assertEquals(pickTradeWorkOrder([mainOrder, forB], JEAN, 500).options.map((o) => o.id), [MAIN]);
});

Deno.test("pick: every work order billed, none open", () => {
  const { options, open } = pickTradeWorkOrder([extra, main], JEAN, 512);
  assertEquals(open, null);
  assert(options.every((o) => o.billed));
});

Deno.test("pick: a work order for another trade is not offered", () => {
  const { options, open } = pickTradeWorkOrder([extra, main], OTHER, 80);
  assertEquals(options.map((o) => o.id), [MAIN]);
  assertEquals(open, null);
});

Deno.test("pick: draft or crew rows and a missing amount are never offered", () => {
  const { options } = pickTradeWorkOrder([
    main,
    { ...extra, agreed_labour_ex: null },
    { ...extra, id: "x", kind: "crew" },
  ], JEAN, 0);
  assertEquals(options.map((o) => o.id), [MAIN]);
});

// ── 2. Numbers ──────────────────────────────────────────────────────────────

Deno.test("number: the second, then one past the highest", () => {
  assertEquals(nextAdditionalWorkOrderNumber("SWRESTO-261719", [{ kind: "job", wo_number: "WO-SWMS-261709" }]), "WO-SWRESTO-261719-2");
  assertEquals(
    nextAdditionalWorkOrderNumber("SWRESTO-261719", [
      { kind: "job", wo_number: "WO-SWMS-261709" },
      { kind: "additional", wo_number: "WO-SWRESTO-261719-2" },
      { kind: "additional", wo_number: "WO-SWRESTO-261719-4" },
    ]),
    "WO-SWRESTO-261719-5",
  );
});

// ── 3. Words a trade reads ──────────────────────────────────────────────────

Deno.test("words: no amount or rate in what a trade reads", () => {
  assertThrows(() => assertNoMoneyInText("Demo day $352", "The title"), AdditionalWorkOrderError);
  assertThrows(() => assertNoMoneyInText("8 hours at 44/hr", "The title"), AdditionalWorkOrderError);
  assertThrows(() => assertNoMoneyInText("44 per hour", "The title"), AdditionalWorkOrderError);
  assertNoMoneyInText("Strip linings to 1.5 m, 3 RCD boxes, 8 hours", "Scope");
  assertThrows(() => parseScopeItems([{ description: "Tip run $250" }]), AdditionalWorkOrderError);
  assertEquals(parseScopeItems([{ description: " Strip out ", hours: "8" }, "Pickup"]), [
    { description: "Strip out", hours: 8 },
    { description: "Pickup" },
  ]);
});

Deno.test("amount: more than 0, to the cent", () => {
  assertEquals(parseAdditionalAgreed("432"), 432);
  assertEquals(parseAdditionalAgreed(352.004), 352);
  assertThrows(() => parseAdditionalAgreed(0), AdditionalWorkOrderError);
  assertThrows(() => parseAdditionalAgreed(""), AdditionalWorkOrderError);
});

// ── 4. The invoice mode loader ──────────────────────────────────────────────

type World = { workOrders: any[]; lines?: any[]; failLines?: boolean };

function fakeClient(world: World) {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const rows = (): any[] => {
        if (table === "users") return [{ id: JEAN, org_id: ORG, invoice_type: "hourly", managed_verticals: [], invoice_any_job: null }];
        if (table === "jobs") {
          return [RESTO, SOLO].map((id, i) => ({
            id, org_id: ORG, type: "makesafe", job_number: `SWRESTO-26171${9 + i}`,
            metadata: { makesafe_job_family: "restoration" }, created_by: null,
          }));
        }
        if (table === "work_orders") return world.workOrders;
        if (table === "trade_invoice_lines") return world.lines ?? [];
        return [];
      };
      const value = (row: any, col: string) =>
        col.split(".").reduce((v: any, k) => (v == null ? v : v[k]), row);
      const result = () => {
        if (table === "trade_invoice_lines" && world.failLines) return { data: null, error: { message: "boom" } };
        return {
          data: rows().filter((row) =>
            filters.every(([op, col, val]) =>
              op === "eq"
                ? String(value(row, col)) === String(val)
                : (val as unknown[]).map(String).includes(String(value(row, col)))
            )
          ),
          error: null,
        };
      };
      const builder: any = {
        select: () => builder,
        neq: () => builder,
        order: () => builder,
        range: () => builder,
        eq(col: string, val: unknown) {
          filters.push(["eq", col, val]);
          return builder;
        },
        in(col: string, val: unknown[]) {
          filters.push(["in", col, val]);
          return builder;
        },
        maybeSingle() {
          const r = result();
          return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

const row = (o: any) => ({ org_id: ORG, status: "approved", ...o });
const WOS = [
  row({ ...main, job_id: RESTO }),
  row({ ...extra, job_id: RESTO }),
  row({ id: SOLO_MAIN, kind: "job", job_id: SOLO, agreed_labour_ex: 160, approved_at: "2026-11-12T00:00:00Z" }),
];
const inspectionLine = {
  id: "l1", job_id: RESTO, line_type: "work order", line_total_ex: 80,
  trade_invoices: { user_id: JEAN, status: "paid" },
};

const load = (client: any, jobIds = [RESTO, SOLO]) =>
  loadTradeInvoiceJobModes(client, {
    tradeId: JEAN,
    orgId: ORG,
    jobIds,
    jobVertical: (job: any) => String(job.type),
    normaliseManagedVerticals: () => [],
  });

Deno.test("loader: one work order on a job reads exactly as before", async () => {
  const out = await load(fakeClient({ workOrders: WOS, lines: [inspectionLine] }), [SOLO]);
  const solo = out.jobs[0] as any;
  assertEquals(solo.invoice_mode, "work_order");
  assertEquals([solo.work_order_agreed_ex, solo.job_work_order_id], [160, SOLO_MAIN]);
  assert(!("cap_work_order_id" in solo) && !("work_orders" in solo));
});

Deno.test("loader: the inspection billed, the card bills the restoration; the cap reads the main order", async () => {
  const out = await load(fakeClient({ workOrders: WOS, lines: [inspectionLine] }));
  const resto = out.jobs.find((j) => j.job_id === RESTO) as any;
  assertEquals(resto.invoice_mode, "work_order");
  assertEquals([resto.work_order_agreed_ex, resto.job_work_order_id], [432, EXTRA]);
  assertEquals([resto.cap_work_order_id, resto.cap_agreed_ex], [MAIN, 80]);
  assertEquals(resto.work_orders.map((o: any) => [o.id, o.billed]), [[EXTRA, false], [MAIN, true]]);
  // Other trades' amounts never reach an answer a trade reads.
  assert(!("additional_orders" in resto));
});

Deno.test("loader: only the cap asks for every additional work order; a one work order job never carries it", async () => {
  const forOther = [row({ ...main, job_id: RESTO }), row({ ...extra, job_id: RESTO, assigned_user_id: OTHER }), WOS[2]];
  const client = fakeClient({ workOrders: forOther, lines: [inspectionLine] });
  const out = await loadTradeInvoiceJobModes(client, {
    tradeId: JEAN,
    orgId: ORG,
    jobIds: [RESTO, SOLO],
    jobVertical: (job: any) => String(job.type),
    normaliseManagedVerticals: () => [],
    includeAdditionalOrders: true,
  });
  const resto = out.jobs.find((j) => j.job_id === RESTO) as any;
  // This trade is not offered the order named for another trade (one option,
  // the main one), but the cap still sees it.
  assertEquals(resto.job_work_order_id, MAIN);
  assert(!("work_orders" in resto));
  assertEquals(resto.additional_orders, [{ assigned_user_id: OTHER, agreed_ex: 432 }]);
  assert(!("additional_orders" in (out.jobs.find((j) => j.job_id === SOLO) as any)));
});

Deno.test("loader: what a trade billed is read by the cap's rule (held lines wait, an override wins)", async () => {
  const nobodyWos = [row({ ...main, job_id: RESTO }), row({ ...nobody, job_id: RESTO })];
  const held = await load(fakeClient({
    workOrders: nobodyWos,
    lines: [{ ...inspectionLine, trade_invoices: { user_id: JEAN, status: "paid", invoice_kind: "held" } }],
  }), [RESTO]);
  assertEquals((held.jobs[0] as any).job_work_order_id, MAIN);
  const overridden = await load(fakeClient({
    workOrders: nobodyWos,
    lines: [{ ...inspectionLine, line_total_ex: 70, override_amount: 80 }],
  }), [RESTO]);
  assertEquals((overridden.jobs[0] as any).job_work_order_id, EXTRA);
});

Deno.test("loader: a draft or rejected invoice does not count as billed", async () => {
  for (const status of ["draft", "ops-reject"]) {
    const out = await load(fakeClient({
      workOrders: [row({ ...main, job_id: RESTO }), row({ ...nobody, job_id: RESTO })],
      lines: [{ ...inspectionLine, trade_invoices: { user_id: JEAN, status } }],
    }), [RESTO]);
    assertEquals((out.jobs[0] as any).job_work_order_id, MAIN, status);
  }
});

Deno.test("loader: commission and another trade's lines never count", async () => {
  const out = await load(fakeClient({
    workOrders: [row({ ...main, job_id: RESTO }), row({ ...nobody, job_id: RESTO })],
    lines: [
      { ...inspectionLine, line_type: "commission" },
      { ...inspectionLine, id: "l2", trade_invoices: { user_id: OTHER, status: "paid" } },
    ],
  }), [RESTO]);
  assertEquals((out.jobs[0] as any).job_work_order_id, MAIN);
});

Deno.test("loader: what was billed cannot be read, so nothing is decided", async () => {
  await assertRejects(
    () => load(fakeClient({ workOrders: WOS, failLines: true }), [RESTO]),
    TradeInvoiceModeReadError,
  );
});

Deno.test("pick: billed covers the work orders it fits; a smaller named order added later is open", () => {
  // Made-up amounts: the trade billed the main work order (500); a named
  // work order of 200 for the same trade is approved after. The 500 covers
  // the main one, never the newer 200, so the card offers the 200.
  const mainOrder = { ...main, agreed_labour_ex: 500 };
  const small = { ...extra, agreed_labour_ex: 200 };
  const { options, open } = pickTradeWorkOrder([small, mainOrder], JEAN, 500);
  assertEquals(options.map((o) => [o.id, o.billed]), [[EXTRA, false], [MAIN, true]]);
  assertEquals([open?.id, open?.agreed_ex], [EXTRA, 200]);
  // Nothing billed: the trade's own named order is still offered first.
  assertEquals(pickTradeWorkOrder([small, mainOrder], JEAN, 0).open?.id, EXTRA);
  // Both billed: nothing open.
  assertEquals(pickTradeWorkOrder([small, mainOrder], JEAN, 700).open, null);
  // 600 billed covers the main 500 only (the most that fits), so the 200 is open.
  assertEquals(pickTradeWorkOrder([small, mainOrder], JEAN, 600).open?.id, EXTRA);
  // 200 billed covers the named 200: the main one is open.
  assertEquals(pickTradeWorkOrder([small, mainOrder], JEAN, 200).open?.id, MAIN);
});

Deno.test("pick: a larger named order billed first covers itself, never the older main one", () => {
  // Main 80, the trade's own named order 432 (offered first), billed 432:
  // the card offers the main 80 next, never the 432 again.
  const after = pickTradeWorkOrder([extra, main], JEAN, 432);
  assertEquals(after.options.map((o) => [o.id, o.billed]), [[EXTRA, true], [MAIN, false]]);
  assertEquals([after.open?.id, after.open?.agreed_ex], [MAIN, 80]);
  // Made-up amounts, trade B: main 500 and B's named 600; B billed 600, so
  // B is not asked for 600 again.
  const forB = { ...extra, agreed_labour_ex: 600, assigned_user_id: OTHER };
  const b = pickTradeWorkOrder([{ ...main, agreed_labour_ex: 500 }, forB], OTHER, 600);
  assertEquals(b.options.map((o) => [o.id, o.billed]), [[EXTRA, true], [MAIN, false]]);
  // Equal amounts: the earliest approved is covered.
  const twin = pickTradeWorkOrder([{ ...extra, agreed_labour_ex: 80 }, main], JEAN, 80);
  assertEquals(twin.options.map((o) => [o.id, o.billed]), [[EXTRA, false], [MAIN, true]]);
});
