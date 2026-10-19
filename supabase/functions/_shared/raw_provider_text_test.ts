// Raw provider text that must not be echoed: a sentinel planted in a provider
// reply, an exception or a store error never reaches a reply or a stored row.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  safeErrorFacts,
  safeErrorLine,
  safeIdentifier,
  safeProviderId,
} from "./safe_identifier.ts";
import {
  ApprovedSendRefusal,
  recordApproval,
  supabaseApprovedSendStore,
  supabaseAttachmentReader,
} from "./approved_send.ts";
import { type GhlCall, GhlCallError, sendApprovedSms } from "./approved_send_sms.ts";
import { makeDeps, RECORDER, smsApprovalBody } from "./approved_send_test_fakes.ts";

const SENTINEL = "SENTINEL raw provider text jane@example.com 0412 999 888";
const CALLER = { actor: "seat:rayleigh", credentialClass: "ops_agent_server_key" };

function assertNoSentinel(value: unknown, label: string) {
  const text = JSON.stringify(value ?? null);
  assert(!text.includes("SENTINEL"), `${label} echoed raw provider text: ${text}`);
}

// A PostgREST client whose every call answers the same error.
function erroringClient(error: Record<string, unknown>): any {
  const result = Promise.resolve({ data: null, error });
  const builder: any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return result.then.bind(result);
      return () => builder;
    },
  });
  return { from: () => builder, storage: { from: () => builder } };
}

Deno.test("identifier validation: codes and states pass only with a safe shape", () => {
  assertEquals(safeIdentifier("ErrorMailboxBusy"), "ErrorMailboxBusy");
  assertEquals(safeIdentifier("ghl_send_failed_422"), "ghl_send_failed_422");
  assertEquals(safeIdentifier("42P01"), "42P01");
  assertEquals(safeIdentifier("a.b:c-d"), "a.b:c-d");
  assertEquals(safeIdentifier(""), null);
  assertEquals(safeIdentifier("has space"), null);
  assertEquals(safeIdentifier("x".repeat(65)), null);
  assertEquals(safeIdentifier(SENTINEL), null);
  assertEquals(safeIdentifier("jane@example.com"), null);
  assertEquals(safeIdentifier(422), null);
  assertEquals(safeIdentifier(null), null);
  assertEquals(safeIdentifier({ code: "x" }), null);
});

Deno.test("identifier validation: provider ids keep Graph and RFC shapes, nothing with spaces or quotes", () => {
  assertEquals(safeProviderId("<reply-1@secureworks>"), "<reply-1@secureworks>");
  assertEquals(safeProviderId("AAMkAGI2T/hI+5ZQ=="), "AAMkAGI2T/hI+5ZQ==");
  assertEquals(safeProviderId("ghl-msg-1"), "ghl-msg-1");
  assertEquals(safeProviderId("id with space"), null);
  assertEquals(safeProviderId('id"quoted'), null);
  assertEquals(safeProviderId("x".repeat(257)), null);
  assertEquals(safeProviderId(SENTINEL), null);
  assertEquals(safeProviderId(""), null);
  assertEquals(safeProviderId(12345), null);
});

Deno.test("identifier validation: error facts never read the message", () => {
  const plain = new Error(SENTINEL);
  assertEquals(safeErrorFacts(plain), { error_name: "Error" });
  assertEquals(safeErrorLine(plain), "Error");
  assertEquals(safeErrorLine(SENTINEL), "error");
  assertEquals(safeErrorLine(null), "error");

  const provider = Object.assign(new Error(SENTINEL), {
    name: "GraphProviderError",
    status: 503,
    context: { provider_code: "ErrorMailboxBusy" },
  });
  assertEquals(safeErrorFacts(provider), {
    error_name: "GraphProviderError",
    provider_status: 503,
    provider_code: "ErrorMailboxBusy",
  });
  assertEquals(safeErrorLine(provider), "GraphProviderError status=503 code=ErrorMailboxBusy");

  // Context wins over the error's own fields; unsafe shapes drop out.
  const mixed = Object.assign(new Error(SENTINEL), {
    status: 999,
    code: SENTINEL,
    context: { provider_status: 429 },
  });
  assertEquals(safeErrorFacts(mixed), { error_name: "Error", provider_status: 429 });
  const badName = Object.assign(new Error("x"), { name: SENTINEL });
  assertEquals(safeErrorFacts(badName), { error_name: null });
});

Deno.test("approved send: a store error's text never reaches the refusal", async () => {
  const store = supabaseApprovedSendStore(erroringClient({ message: SENTINEL, code: "42P01", details: SENTINEL }));
  const refusal = await assertRejects(() => store.loadApproval("a-1"), ApprovedSendRefusal);
  assertEquals(refusal.code, "approval_store_unreadable");
  assertEquals(refusal.evidence, { store_code: "42P01" });
  assertNoSentinel(refusal.message, "store refusal message");
  assertNoSentinel(refusal.toBody(), "store refusal body");

  // A code that is itself free text is dropped, not echoed.
  const unsafe = supabaseApprovedSendStore(erroringClient({ message: SENTINEL, code: SENTINEL }));
  const second = await assertRejects(() => unsafe.findOutcomeUnknown("h"), ApprovedSendRefusal);
  assertEquals(second.evidence, {});
  assertNoSentinel(second.toBody(), "store refusal body");

  const audit = await assertRejects(() =>
    store.audit({ approval_id: "a-1", event: "recorded", channel: "sms" } as any)
  );
  assertNoSentinel((audit as Error).message, "audit write error");
  assert((audit as Error).message.includes("42P01"));
});

Deno.test("approved send: the money fence check failure carries no exception text", async () => {
  const client = {
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: "d-1", job_id: "j-1", type: "invoice", file_name: "INV.pdf", storage_url: null, pdf_url: null },
            error: null,
          }),
      };
      return builder;
    },
  };
  const read = supabaseAttachmentReader(client, () => Promise.reject(new Error(SENTINEL)));
  const refusal = await assertRejects(
    () => read({ source: "job_document", id: "d-1" } as any),
    ApprovedSendRefusal,
  );
  assertEquals(refusal.code, "approval_fence_check_failed");
  assertEquals(refusal.evidence, { job_document_id: "d-1", error_name: "Error" });
  assertNoSentinel(refusal.toBody(), "fence refusal body");
});

async function recordSms(deps: ReturnType<typeof makeDeps>) {
  const body = smsApprovalBody();
  const preview = await recordApproval(deps, RECORDER, body);
  const live = await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  });
  return live.approval_id!;
}

function ghlFake(options: { lookupError?: Error; sendError?: Error; messageId?: string }): GhlCall {
  return (path, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (path === "/contacts/search/duplicate") {
      if (options.lookupError) return Promise.reject(options.lookupError);
      return Promise.resolve({ contact: { id: "c-1", phone: body.phone } });
    }
    if (path.startsWith("/contacts/")) return Promise.resolve({ contact: { id: "c-1", phone: "+61412345678" } });
    if (path === "/conversations/messages") {
      if (options.sendError) return Promise.reject(options.sendError);
      return Promise.resolve({ messageId: options.messageId ?? "ghl-msg-1", conversationId: "conv-1" });
    }
    return Promise.reject(new Error(`unexpected GHL path ${path}`));
  };
}

Deno.test("approved SMS: a provider refusal's text reaches neither the reply nor the stored row", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const result = await sendApprovedSms(
    { ...deps, ghl: ghlFake({ sendError: new GhlCallError(422, SENTINEL, false) }), locationId: "loc-1" },
    id,
    CALLER,
  );
  assertEquals(result.body.state, "failed");
  assertEquals(result.body.error, "The provider refused the text.");
  assertEquals(result.body.provider_status, 422);
  assertEquals(result.body.error_name, "GhlCallError");
  assertNoSentinel(result.body, "SMS reply");
  assertNoSentinel(deps.store.rows.get(id), "stored SMS approval row");
  assertNoSentinel(deps.store.auditRows, "SMS audit rows");
});

Deno.test("approved SMS: an unknown outcome reply is fixed wording", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const result = await sendApprovedSms(
    { ...deps, ghl: ghlFake({ sendError: new GhlCallError(503, SENTINEL, true) }), locationId: "loc-1" },
    id,
    CALLER,
  );
  assertEquals(result.body.state, "outcome_unknown");
  assertEquals(result.body.error, "The text may have gone out. Check the provider inbox before sending again.");
  assertNoSentinel(result.body, "SMS reply");
  assertNoSentinel(deps.store.rows.get(id), "stored SMS approval row");
  assertNoSentinel(deps.store.auditRows, "SMS audit rows");
});

Deno.test("approved SMS: a contact lookup failure refuses without the provider's text", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const refusal = await assertRejects(
    () =>
      sendApprovedSms(
        { ...deps, ghl: ghlFake({ lookupError: new GhlCallError(500, SENTINEL, true) }), locationId: "loc-1" },
        id,
        CALLER,
      ),
    ApprovedSendRefusal,
  );
  assertEquals(refusal.code, "sms_contact_lookup_failed");
  assertEquals(refusal.evidence.provider_status, 500);
  assertNoSentinel(refusal.toBody(), "SMS contact refusal");
  assertEquals(deps.store.rows.get(id)!.status, "approved");
});

Deno.test("approved SMS: a provider message id that is free text is not stored", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const result = await sendApprovedSms(
    { ...deps, ghl: ghlFake({ messageId: SENTINEL }), locationId: "loc-1" },
    id,
    CALLER,
  );
  assertEquals(result.body.state, "sent");
  assertNoSentinel(result.body, "SMS reply");
  assertNoSentinel(deps.store.rows.get(id), "stored SMS approval row");
  assertNoSentinel(deps.store.auditRows, "SMS audit rows");
});
