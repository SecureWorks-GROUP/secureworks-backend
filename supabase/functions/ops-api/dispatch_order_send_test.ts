// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 5 (docs/dispatch-slice-5-contract.md): the supplier email as
// Resend receives it, and what its answer means. The transport is stubbed;
// nothing here reaches the network.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDispatchEmail,
  classifyDispatchSend,
  DISPATCH_ORDERS_FROM,
  dispatchBytesToBase64,
  dispatchDraftIdempotencyKey,
  dispatchReplyIdempotencyKey,
  dispatchReplySubject,
  dispatchReplyToAddress,
  isRfcMessageId,
  resendDispatchTransport,
  runDispatchSend,
} from "./dispatch_order_send.ts";

const BODY =
  "Hi team,\n\nPlease find attached PO-1000001 for job SWR-900002.\n\n4 Rail\n2 <Post> & cap\n\nThanks,\nSecureWorks Group";

Deno.test("payload: from the orders address, one address, the tagged reply, the PDF, no CC or BCC", () => {
  const p = buildDispatchEmail({
    to: "orders@steel-supplies.test",
    subject: "Purchase order PO-1000001 for SWR-900002",
    bodyText: BODY,
    poNumber: "PO-1000001",
    jobNumber: "SWR-900002",
    pdf: { fileName: "PO-1000001.pdf", base64: "JVBERi0=" },
  });
  assertEquals(p.from, "SecureWorks Group <orders@secureworksgroup.app>");
  assertEquals(p.from, DISPATCH_ORDERS_FROM);
  assertEquals(p.to, ["orders@steel-supplies.test"]);
  assertEquals(p.reply_to, "orders+PO-1000001-SWR-900002@secureworksgroup.app");
  assertEquals(p.attachments, [{
    filename: "PO-1000001.pdf",
    content: "JVBERi0=",
  }]);
  assertEquals(p.text, BODY);
  assert(!("cc" in p) && !("bcc" in p) && !("headers" in p));
  // The reference banner, the message as paragraphs (escaped), the signature.
  assert(p.html.includes("Job reference"));
  assert(p.html.includes("SWR-900002"));
  assert(p.html.includes("2 &lt;Post&gt; &amp; cap"));
  assert(
    p.html.includes(
      "<strong>SecureWorks Group</strong><br>Purchase order PO-1000001 · Job SWR-900002",
    ),
  );
  assertEquals(
    buildDispatchEmail({
      to: "a@b.test",
      subject: "s",
      bodyText: "t",
      poNumber: "PO-1",
      jobNumber: "SWF-1",
    }).html,
    buildDispatchEmail({
      to: "a@b.test",
      subject: "s",
      bodyText: "t",
      poNumber: "PO-1",
      jobNumber: "SWF-1",
    }).html,
  );
});

Deno.test("payload: In-Reply-To and References only from a real Message-ID, never a Resend id", () => {
  const withId = buildDispatchEmail({
    to: "a@b.test",
    subject: "s",
    bodyText: "t",
    poNumber: "PO-1",
    jobNumber: null,
    inReplyTo: "<abc@mail.supplier.test>",
  });
  assertEquals(withId.headers, {
    "In-Reply-To": "<abc@mail.supplier.test>",
    "References": "<abc@mail.supplier.test>",
  });
  const bare = buildDispatchEmail({
    to: "a@b.test",
    subject: "s",
    bodyText: "t",
    poNumber: "PO-1",
    jobNumber: null,
    inReplyTo: "abc@mail.supplier.test",
  });
  assertEquals(bare.headers?.["In-Reply-To"], "<abc@mail.supplier.test>");
  const resendId = buildDispatchEmail({
    to: "a@b.test",
    subject: "s",
    bodyText: "t",
    poNumber: "PO-1",
    jobNumber: null,
    inReplyTo: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
  });
  assert(!("headers" in resendId));
  assert(!isRfcMessageId(null));
  assertEquals(
    dispatchReplyToAddress("PO-1", null),
    "orders+PO-1@secureworksgroup.app",
  );
  assertEquals(
    buildDispatchEmail({
      to: "a@b.test",
      subject: "s",
      bodyText: "t",
      poNumber: null,
      jobNumber: "SWF-1",
    }).reply_to,
    "orders@secureworksgroup.app",
  );
});

Deno.test("answer: 2xx sent; 409 not confirmed; other 4xx refused; 5xx not confirmed", () => {
  assertEquals(classifyDispatchSend({ status: 200, body: { id: "r1" } }), {
    kind: "sent",
    id: "r1",
  });
  assertEquals(classifyDispatchSend({ status: 202, body: null }), {
    kind: "sent",
    id: null,
  });
  assertEquals(
    classifyDispatchSend({
      status: 409,
      body: { name: "concurrent_idempotent_requests", message: "in progress" },
    }),
    { kind: "unknown", reason: "in progress" },
  );
  assertEquals(
    classifyDispatchSend({
      status: 422,
      body: { message: "Invalid `to` field" },
    }),
    { kind: "refused", reason: "Invalid `to` field" },
  );
  assertEquals(classifyDispatchSend({ status: 429, body: null }), {
    kind: "refused",
    reason: "HTTP 429",
  });
  assertEquals(
    classifyDispatchSend({ status: 503, body: null }).kind,
    "unknown",
  );
});

Deno.test("run: a throw or a timeout is not confirmed, never refused, and calls the transport once", async () => {
  let calls = 0;
  const out = await runDispatchSend(() => {
    calls++;
    return Promise.reject(new Error("network down"));
  }, { payload: {} as any, idempotencyKey: "k" });
  assertEquals(out, { kind: "unknown", reason: "network down" });
  assertEquals(calls, 1);
});

Deno.test("transport: one POST to Resend with the idempotency key; a missing key sends nothing", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "r1" }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
  const answer = await resendDispatchTransport("key", fakeFetch)({
    payload: { to: ["a@b.test"] } as any,
    idempotencyKey: dispatchDraftIdempotencyKey("d1"),
  });
  assertEquals(answer, { status: 200, body: { id: "r1" } });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "https://api.resend.com/emails");
  assertEquals(
    (seen[0].init.headers as any)["Idempotency-Key"],
    "dispatch-draft-d1",
  );
  const noKey = await runDispatchSend(resendDispatchTransport("", fakeFetch), {
    payload: {} as any,
    idempotencyKey: "k",
  });
  assertEquals(noKey.kind, "unknown");
  assertEquals(seen.length, 1);
});

Deno.test("keys, reply subject and base64", () => {
  const key = dispatchReplyIdempotencyKey(
    "f1000000-0000-4000-8000-000000000001",
    "a".repeat(64),
  );
  assert(key.length <= 256);
  assertEquals(
    dispatchReplySubject("Purchase order PO-1"),
    "Re: Purchase order PO-1",
  );
  assertEquals(
    dispatchReplySubject("RE: Purchase order PO-1"),
    "RE: Purchase order PO-1",
  );
  assertEquals(
    dispatchBytesToBase64(new TextEncoder().encode("%PDF-")),
    "JVBERi0=",
  );
  const big = new Uint8Array(100_000).fill(65);
  assertEquals(atob(dispatchBytesToBase64(big)).length, 100_000);
});
