// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  approvedDocumentSnapshotPrice,
  approvedQuotePdf,
  claimUnapprovedLegacySend,
  markUnapprovedLegacySendSent,
  OWNER_APPROVAL_SAVED_REVISION_FLAG,
  ownerPriceBeforeSend,
  ownerPriceGate,
  unapprovedSendKeyForDocument,
  unapprovedSendKeyForQuickQuote,
} from "./owner_price_approval.ts";
import type { SealedSendSource } from "./quote_scope_revision_link.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const REV = "00000000-0000-4000-8000-000000000002";
const SHA_A = "a".repeat(64);
const sealed: SealedSendSource = {
  kind: "sealed",
  revision_id: REV,
  scope_json: {},
  pricing_json: {},
};

function client(opts: {
  rpc?: (
    name: string,
    args: any,
  ) => Promise<{ data: unknown; error: unknown }>;
  flag?: () => Promise<{ data: unknown; error: unknown }>;
  insert?: (row: any) => Promise<{ error: unknown }>;
}) {
  const calls: any[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) {
      calls.push({ rpc: name, args });
      return opts.rpc
        ? opts.rpc(name, args)
        : Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      calls.push({ from: table });
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          calls.push({ eq: [column, value] });
          return this;
        },
        maybeSingle() {
          return opts.flag
            ? opts.flag()
            : Promise.resolve({ data: null, error: null });
        },
        insert(row: any) {
          calls.push({ insert: row });
          return opts.insert
            ? opts.insert(row)
            : Promise.resolve({ error: null });
        },
      };
    },
  };
}

Deno.test("owner price gate: a saved revision with the owner's price decision is approved", async () => {
  const sb = client({
    rpc: () =>
      Promise.resolve({
        data: { id: "a1", kind: "price", quote_document_sha256s: [SHA_A] },
        error: null,
      }),
  });
  const gate = await ownerPriceGate(sb, JOB, sealed);
  assertEquals(gate, {
    kind: "approved",
    approval_id: "a1",
    scope_revision_id: REV,
    quote_document_sha256s: [SHA_A],
  });
  assertEquals(sb.calls[0], {
    rpc: "scope_price_owner_approval",
    args: { p_job_id: JOB, p_scope_revision_id: REV },
  });
});

const FLAG_ON = () => Promise.resolve({ data: { enabled: true }, error: null });
const FLAG_OFF = () => Promise.resolve({ data: { enabled: false }, error: null });

Deno.test("owner price gate: with the switch off, a saved revision with no price decision goes as today", async () => {
  for (const flag of [FLAG_OFF, undefined]) {
    const sb = client({ flag });
    assertEquals(await ownerPriceGate(sb, JOB, sealed), {
      kind: "legacy_unapproved",
      scope_revision_id: REV,
    });
    assertEquals(
      sb.calls.find((c) => c.eq)?.eq,
      ["flag_name", OWNER_APPROVAL_SAVED_REVISION_FLAG],
    );
  }
});

Deno.test("owner price gate: with the switch on, a saved revision with no price decision is refused", async () => {
  const gate = await ownerPriceGate(client({ flag: FLAG_ON }), JOB, sealed);
  assertEquals(gate.kind, "refused");
  if (gate.kind !== "refused") return;
  assertEquals(gate.status, 409);
  assertEquals(gate.body.code, "owner_price_approval_required");
});

Deno.test("owner price gate: no decision and an unreadable switch fails closed", async () => {
  const gate = await ownerPriceGate(
    client({ flag: () => Promise.resolve({ data: null, error: { code: "x" } }) }),
    JOB,
    sealed,
  );
  assertEquals(gate.kind, "refused");
  if (gate.kind !== "refused") return;
  assertEquals(gate.status, 503);
});

Deno.test("owner price gate: an unreadable decision fails closed", async () => {
  for (
    const rpc of [
      () => Promise.resolve({ data: null, error: { code: "57014" } }),
      () => Promise.reject(new Error("network")),
    ]
  ) {
    const gate = await ownerPriceGate(client({ rpc }), JOB, sealed);
    assertEquals(gate.kind, "refused");
    if (gate.kind !== "refused") return;
    assertEquals(gate.status, 503);
    assertEquals(gate.body.code, "owner_price_approval_unreadable");
  }
});

Deno.test("owner price gate: a refused sealed source is left to its own refusal", async () => {
  const sb = client({});
  const gate = await ownerPriceGate(sb, JOB, {
    kind: "refused",
    status: 409,
    body: { error: "x", code: "x", reason: "x" },
  });
  assertEquals(gate, { kind: "not_judged" });
  assertEquals(sb.calls, []);
});

Deno.test("owner price gate: a send naming no saved revision follows the switch", async () => {
  const off = client({
    flag: () => Promise.resolve({ data: { enabled: false }, error: null }),
  });
  assertEquals(await ownerPriceGate(off, JOB, { kind: "legacy" }), {
    kind: "legacy_unapproved",
    scope_revision_id: null,
  });
  assertEquals(
    off.calls.find((c) => c.eq)?.eq,
    ["flag_name", OWNER_APPROVAL_SAVED_REVISION_FLAG],
  );
  const missing = client({});
  assertEquals(await ownerPriceGate(missing, JOB, { kind: "legacy" }), {
    kind: "legacy_unapproved",
    scope_revision_id: null,
  });
  const on = await ownerPriceGate(
    client({
      flag: () => Promise.resolve({ data: { enabled: true }, error: null }),
    }),
    JOB,
    { kind: "legacy" },
  );
  assertEquals(on.kind, "refused");
  if (on.kind !== "refused") return;
  assertEquals(on.status, 409);
  assertEquals(on.body.code, "owner_price_approval_requires_saved_revision");
  const unreadable = await ownerPriceGate(
    client({
      flag: () => Promise.resolve({ data: null, error: { code: "x" } }),
    }),
    JOB,
    { kind: "legacy" },
  );
  assertEquals(unreadable.kind, "refused");
  if (unreadable.kind !== "refused") return;
  assertEquals(unreadable.status, 503);
});

const legacyOff = () =>
  Promise.resolve({ data: { enabled: false }, error: null });
const recordCalls = (sb: { calls: any[] }) =>
  sb.calls.filter((c) => c.rpc === "record_quote_send_price_unapproved");

Deno.test("unapproved send record: the claim is written before the email, ids only", async () => {
  const sb = client({
    rpc: () => Promise.resolve({ data: { recorded: true }, error: null }),
  });
  const send = {
    send_key: unapprovedSendKeyForDocument("d1"),
    job_id: JOB,
    path: "send" as const,
    document_id: "d1",
  };
  assertEquals(await claimUnapprovedLegacySend(sb, send), { ok: true });
  assertEquals(recordCalls(sb)[0].args, {
    p_send_key: "quote_document:d1",
    p_job_id: JOB,
    p_path: "send",
    p_document_id: "d1",
    p_state: "claimed",
    p_scope_revision_id: null,
  });
  assertEquals(unapprovedSendKeyForQuickQuote("c1"), "quick_quote:c1");
});

Deno.test("unapproved send record: a claim that cannot be written stops the send", async () => {
  for (
    const rpc of [
      () => Promise.resolve({ data: null, error: { code: "57014" } }),
      () => Promise.resolve({ data: { recorded: false }, error: null }),
      () => Promise.reject(new Error("network")),
    ]
  ) {
    const out = await claimUnapprovedLegacySend(client({ rpc }), {
      send_key: "quote_document:d1",
      job_id: JOB,
      path: "send-runs",
      document_id: "d1",
    });
    assertEquals(out.ok, false);
    if (out.ok) return;
    assertEquals(
      [out.status, out.body.code],
      [503, "owner_price_unapproved_send_unrecorded"],
    );
  }
});

Deno.test("unapproved send record: marking sent moves the claim and never throws", async () => {
  const sb = client({
    rpc: () => Promise.resolve({ data: { recorded: true }, error: null }),
  });
  const send = {
    send_key: "quick_quote:c1",
    job_id: JOB,
    path: "quick-quote" as const,
    document_id: null,
  };
  assertEquals(await markUnapprovedLegacySendSent(sb, send), true);
  assertEquals(recordCalls(sb)[0].args.p_state, "sent");
  // No claim (recorded false), a refusal or a dropped call: false, no throw.
  for (
    const rpc of [
      () => Promise.resolve({ data: { recorded: false }, error: null }),
      () => Promise.resolve({ data: null, error: { code: "x" } }),
      () => Promise.reject(new Error("down")),
    ]
  ) {
    assertEquals(await markUnapprovedLegacySendSent(client({ rpc }), send), false);
  }
});

Deno.test("before send: no approver set, switch off: a saved-revision send goes and is recorded first", async () => {
  const sb = client({
    flag: FLAG_OFF,
    rpc: (name) =>
      Promise.resolve({
        data: name === "record_quote_send_price_unapproved" ? { recorded: true } : null,
        error: null,
      }),
  });
  const out = await ownerPriceBeforeSend(sb, {
    job_id: JOB,
    sealed,
    path: "quick-quote",
    send_key: "quick_quote:c1",
    document_id: null,
  });
  assertEquals(out.kind, "go");
  if (out.kind !== "go") return;
  assertEquals(out.approved, null);
  assertEquals(out.unapproved?.scope_revision_id, REV);
  assertEquals(recordCalls(sb).length, 1);
  assertEquals(recordCalls(sb)[0].args.p_scope_revision_id, REV);
  assertEquals(recordCalls(sb)[0].args.p_state, "claimed");
});

Deno.test("before send: switch on, a named revision with no price decision is refused and nothing is recorded", async () => {
  const sb = client({
    flag: FLAG_ON,
    rpc: (name) =>
      Promise.resolve({
        data: name === "record_quote_send_price_unapproved" ? { recorded: true } : null,
        error: null,
      }),
  });
  const out = await ownerPriceBeforeSend(sb, {
    job_id: JOB,
    sealed,
    path: "quick-quote",
    send_key: "quick_quote:c1",
    document_id: null,
  });
  assertEquals(out.kind, "refused");
  if (out.kind !== "refused") return;
  assertEquals([out.status, out.body.code], [409, "owner_price_approval_required"]);
  assertEquals(recordCalls(sb), []);
});

Deno.test("before send: an approved revision goes with no record", async () => {
  const sb = client({
    rpc: () => Promise.resolve({ data: { id: "a1", kind: "price" }, error: null }),
  });
  const out = await ownerPriceBeforeSend(sb, {
    job_id: JOB,
    sealed,
    path: "send",
    send_key: "quote_document:d1",
    document_id: "d1",
  });
  assertEquals(out.kind, "go");
  if (out.kind !== "go") return;
  assertEquals(out.unapproved, null);
  assertEquals(out.approved?.approval_id, "a1");
  assertEquals(recordCalls(sb), []);
});

Deno.test("before send: a send naming no revision is recorded first, or refused when it cannot be", async () => {
  const ok = client({
    flag: legacyOff,
    rpc: () => Promise.resolve({ data: { recorded: true }, error: null }),
  });
  const out = await ownerPriceBeforeSend(ok, {
    job_id: JOB,
    sealed: { kind: "legacy" },
    path: "quick-quote",
    send_key: "quick_quote:c1",
    document_id: null,
  });
  assertEquals(out, {
    kind: "go",
    unapproved: {
      send_key: "quick_quote:c1",
      job_id: JOB,
      path: "quick-quote",
      document_id: null,
      scope_revision_id: null,
    },
    approved: null,
  });
  assertEquals(recordCalls(ok).length, 1);
  const down = await ownerPriceBeforeSend(
    client({
      flag: legacyOff,
      rpc: () => Promise.resolve({ data: null, error: { code: "x" } }),
    }),
    {
      job_id: JOB,
      sealed: { kind: "legacy" },
      path: "send",
      send_key: "quote_document:d1",
      document_id: "d1",
    },
  );
  assertEquals(down.kind, "refused");
  if (down.kind !== "refused") return;
  assertEquals(down.body.code, "owner_price_unapproved_send_unrecorded");
  // With the switch on, a send naming no revision is refused before any record.
  const on = client({
    flag: () => Promise.resolve({ data: { enabled: true }, error: null }),
  });
  const refused = await ownerPriceBeforeSend(on, {
    job_id: JOB,
    sealed: { kind: "legacy" },
    path: "send",
    send_key: "quote_document:d1",
    document_id: "d1",
  });
  assertEquals(refused.kind, "refused");
  assertEquals(recordCalls(on), []);
});

Deno.test("before send: a source that could not be judged sends nothing", async () => {
  const out = await ownerPriceBeforeSend(client({}), {
    job_id: JOB,
    sealed: { kind: "refused", status: 409, body: { error: "x", code: "x", reason: "x" } },
    path: "send",
    send_key: "quote_document:d1",
    document_id: "d1",
  });
  assertEquals(out.kind, "refused");
  if (out.kind !== "refused") return;
  assertEquals(out.body.code, "owner_price_approval_not_judged");
});

async function hex(bytes: Uint8Array<ArrayBuffer>) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
const pdfFetch = (bytes: Uint8Array<ArrayBuffer> | null) =>
  (() =>
    Promise.resolve(
      bytes ? new Response(bytes) : new Response("gone", { status: 404 }),
    )) as unknown as typeof fetch;
const gateFor = (documents: string[] | null) => ({
  kind: "approved" as const,
  approval_id: "a1",
  scope_revision_id: REV,
  quote_document_sha256s: documents,
});

Deno.test("owner price gate: a decision record with no or a malformed document list covers no PDF", async () => {
  for (const list of [undefined, ["not-a-hash"], "x"]) {
    const sb = client({
      rpc: () => Promise.resolve({ data: { id: "a1", quote_document_sha256s: list }, error: null }),
    });
    const gate = await ownerPriceGate(sb, JOB, sealed);
    assertEquals(gate.kind === "approved" && gate.quote_document_sha256s, null);
  }
});

Deno.test("approved quote PDF: only a PDF the owner's decision covers goes out, as those bytes", async () => {
  const approved = new TextEncoder().encode("%PDF approved figures");
  const other = new TextEncoder().encode("%PDF other figures");
  const gate = gateFor([await hex(approved)]);
  const ok = await approvedQuotePdf(gate, "https://example.test/a.pdf", pdfFetch(approved));
  assertEquals(ok.ok, true);
  if (!ok.ok) return;
  assertEquals([ok.sha256, ok.bytes], [await hex(approved), approved]);
  // A caller-supplied PDF with other figures is refused.
  const refused = await approvedQuotePdf(gate, "https://example.test/b.pdf", pdfFetch(other));
  assertEquals(refused.ok, false);
  if (refused.ok) return;
  assertEquals([refused.status, refused.body.code], [409, "owner_price_pdf_not_approved"]);
  // A decision that covers no document covers no PDF.
  const none = await approvedQuotePdf(gateFor([]), "https://example.test/a.pdf", pdfFetch(approved));
  assertEquals(none.ok === false && none.body.code, "owner_price_pdf_not_approved");
});

Deno.test("approved quote PDF: a PDF that cannot be read, or a decision with no list, sends nothing", async () => {
  const bytes = new TextEncoder().encode("%PDF x");
  const sha = await hex(bytes);
  for (
    const [gate, f] of [
      [gateFor([sha]), pdfFetch(null)],
      [gateFor([sha]), (() => Promise.reject(new Error("down"))) as unknown as typeof fetch],
      [gateFor([sha]), pdfFetch(new Uint8Array(0))],
      [gateFor(null), pdfFetch(bytes)],
    ] as const
  ) {
    const out = await approvedQuotePdf(gate, "https://example.test/a.pdf", f);
    assertEquals(out.ok, false);
    if (out.ok) return;
    assertEquals([out.status, out.body.code], [503, "owner_price_pdf_unreadable"]);
  }
});

Deno.test("approved document price: the page's stored price must be a figure of the approved price", () => {
  const pricing = {
    totalIncGST: 33.03,
    parties: [{ id: "__client__", inc_gst: 20.01 }, { id: "p2", inc_gst: 13.02 }],
  };
  assertEquals(approvedDocumentSnapshotPrice({ totalIncGST: 33.03 }, pricing), { ok: true });
  assertEquals(approvedDocumentSnapshotPrice({ total: "13.02" }, pricing), { ok: true });
  assertEquals(approvedDocumentSnapshotPrice({ supporting_docs: [] }, pricing), { ok: true });
  assertEquals(approvedDocumentSnapshotPrice(null, pricing), { ok: true });
  for (const snapshot of [{ totalIncGST: 66.06 }, { total: "abc" }, { totalIncGST: 33.04 }]) {
    const out = approvedDocumentSnapshotPrice(snapshot, pricing);
    assertEquals(out.ok === false && [out.status, out.body.code], [409, "owner_price_document_price_mismatch"]);
  }
});
