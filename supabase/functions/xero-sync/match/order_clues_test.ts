import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { orderAmountClue, sealedScopeOrderClue, type MatchOrder } from "./order_clues.ts";
import type { MatchDocument } from "./doc_clues.ts";
const d: MatchDocument = { subject_id: "xero_bill:B1", document_kind: "xero_bill", document_id: "B1", party_id: "supplier:1", party_name: "ZZTEST Steel Pty Ltd", document_number: "B1", reference: null, document_date: "2026-11-06", total_ex: 2000, lines: [] };
const o: MatchOrder = { order_kind: "dispatch_order", order_id: "O1", order_number: null, job_id: "J1", job_live: true, party_id: "supplier:1", party_name_key: null, sent_on: "2026-11-01", cost_ex: 2000, from_sealed_scope: true, matched: false };
Deno.test("equal sealed order yields a key with zero difference", () => {
  const c = sealedScopeOrderClue(d, [o]);
  assertEquals([c?.clue_code, c?.class, c?.job_id, c?.root, c?.detail?.difference], ["sealed_scope_order", "key", "J1", "order:O1", 0]);
});
Deno.test("a bill inside tolerance keeps its actual difference", () => {
  assertEquals(sealedScopeOrderClue({ ...d, total_ex: 2012.50 }, [o])?.detail?.difference, 12.5);
});
Deno.test("an amount outside tolerance or a zero cost never matches", () => {
  assertEquals(sealedScopeOrderClue({ ...d, total_ex: 2100 }, [o]), null);
  assertEquals(sealedScopeOrderClue({ ...d, total_ex: 0 }, [{ ...o, cost_ex: 0 }]), null);
});
Deno.test("two fitting orders across jobs name neither", () => {
  assertEquals(sealedScopeOrderClue(d, [o, { ...o, order_id: "O2", job_id: "J2" }]), null);
});
Deno.test("an unknown cost cannot match", () => {
  assertEquals(sealedScopeOrderClue(d, [{ ...o, cost_ex: null }]), null);
});
Deno.test("an order fifty days old cannot match", () => {
  assertEquals(sealedScopeOrderClue(d, [{ ...o, sent_on: "2026-09-17" }]), null);
});
Deno.test("matched or nonlive orders cannot match; a legacy PO supplies only its amount clue", () => {
  assertEquals(sealedScopeOrderClue(d, [{ ...o, matched: true }]), null);
  assertEquals(sealedScopeOrderClue(d, [{ ...o, job_live: false }]), null);
  const po = { ...o, order_kind: "purchase_order" as const, from_sealed_scope: false };
  assertEquals(sealedScopeOrderClue(d, [po]), null);
  assertEquals(orderAmountClue(d, [po])?.clue_code, "order_amount");
});
Deno.test("supplier name fallback is used only when the order has no party id", () => {
  assertEquals(sealedScopeOrderClue(d, [{ ...o, party_id: null, party_name_key: "zztest steel" }])?.job_id, "J1");
  assertEquals(sealedScopeOrderClue(d, [{ ...o, party_id: "supplier:2", party_name_key: "zztest steel" }]), null);
});
