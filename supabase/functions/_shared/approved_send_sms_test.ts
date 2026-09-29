// Approved SMS through a fake GHL. No real provider is ever called.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApprovedSendRefusal, recordApproval } from "./approved_send.ts";
import {
  type GhlCall,
  GhlCallError,
  makeGhlCall,
  sendApprovedSms,
} from "./approved_send_sms.ts";
import { makeDeps, RECORDER, smsApprovalBody } from "./approved_send_test_fakes.ts";

const CALLER = { actor: "seat:rayleigh", credentialClass: "ops_agent_server_key" };

type Call = { path: string; method: string; body: any };

function fakeGhl(options: {
  existingContact?: { id: string; phone: string } | null;
  createdPhone?: string;
  sendError?: GhlCallError;
} = {}): { ghl: GhlCall; calls: Call[] } {
  const calls: Call[] = [];
  const contacts = new Map<string, string>();
  if (options.existingContact) contacts.set(options.existingContact.id, options.existingContact.phone);
  const ghl: GhlCall = (path, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method: init.method || "GET", body });
    if (path === "/contacts/search/duplicate") {
      const match = [...contacts].find(([, phone]) => phone === body.phone);
      return Promise.resolve({ contact: match ? { id: match[0], phone: match[1] } : null });
    }
    if (path === "/contacts/") {
      contacts.set("created-contact", options.createdPhone ?? body.phone);
      return Promise.resolve({ contact: { id: "created-contact" } });
    }
    if (path.startsWith("/contacts/")) {
      const id = decodeURIComponent(path.slice("/contacts/".length));
      return Promise.resolve({ contact: { id, phone: contacts.get(id) } });
    }
    if (path === "/conversations/messages") {
      if (options.sendError) return Promise.reject(options.sendError);
      return Promise.resolve({ messageId: "ghl-msg-1", conversationId: "conv-1" });
    }
    return Promise.reject(new Error(`unexpected GHL path ${path}`));
  };
  return { ghl, calls };
}

async function recordSms(deps: ReturnType<typeof makeDeps>, body = smsApprovalBody()) {
  const preview = await recordApproval(deps, RECORDER, body);
  const live = await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  });
  return live.approval_id!;
}

Deno.test("approved SMS goes to the exact mobile from the 771 line with no CRM contact supplied", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const provider = fakeGhl();
  const result = await sendApprovedSms({ ...deps, ghl: provider.ghl, locationId: "loc-1" }, id, CALLER);
  assertEquals(result.status, 200);
  assertEquals(result.body.state, "sent");
  assertEquals(result.body.provider_message_id, "ghl-msg-1");
  const send = provider.calls.find((call) => call.path === "/conversations/messages")!;
  assertEquals(send.body, {
    type: "SMS",
    contactId: "created-contact",
    message: "Running 10 min late, see you at 9:10",
    fromNumber: "+61489267771",
  });
  // Contact resolved (created) before the claim; one send only.
  assertEquals(provider.calls.filter((call) => call.path === "/conversations/messages").length, 1);
  const row = deps.store.rows.get(id)!;
  assertEquals(row.status, "sent");
  assertEquals(row.provider_message_id, "ghl-msg-1");
  assertEquals(deps.store.events(id), ["recorded", "claimed", "sent"]);
  const sentAudit = deps.store.auditRows.find((entry) => entry.event === "sent")!;
  assertEquals(sentAudit.provider_message_id, "ghl-msg-1");
  assertEquals((sentAudit.detail as any).to_mobile, "+61412345678");
});

Deno.test("a named SecureWorks line is honoured", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps, smsApprovalBody({
    sms: { to_mobile: "0412345678", message: "Booked for Tuesday", from_line: "+61489267776" },
  }));
  const provider = fakeGhl({ existingContact: { id: "c-9", phone: "+61412345678" } });
  const result = await sendApprovedSms({ ...deps, ghl: provider.ghl, locationId: "loc-1" }, id, CALLER);
  assertEquals(result.status, 200);
  const send = provider.calls.find((call) => call.path === "/conversations/messages")!;
  assertEquals(send.body.fromNumber, "+61489267776");
  assertEquals(send.body.contactId, "c-9");
  assertEquals(provider.calls.some((call) => call.path === "/contacts/"), false);
});

Deno.test("a provider contact whose phone differs is refused before the claim", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const provider = fakeGhl({ createdPhone: "+61499999999" });
  const error = await assertRejects(
    () => sendApprovedSms({ ...deps, ghl: provider.ghl, locationId: "loc-1" }, id, CALLER),
    ApprovedSendRefusal,
  );
  assertEquals(error.code, "sms_contact_phone_mismatch");
  assertEquals(deps.store.rows.get(id)!.status, "approved");
  assertEquals(provider.calls.some((call) => call.path === "/conversations/messages"), false);
});

Deno.test("a provider refusal records failed; the approval is used", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const provider = fakeGhl({ sendError: new GhlCallError(422, "GHL 422: invalid", false) });
  const result = await sendApprovedSms({ ...deps, ghl: provider.ghl, locationId: "loc-1" }, id, CALLER);
  assertEquals(result.status, 502);
  assertEquals(result.body.state, "failed");
  assertEquals(result.body.code, "provider_rejected");
  assertEquals(deps.store.rows.get(id)!.status, "failed");
  assertEquals(deps.store.events(id), ["recorded", "claimed", "failed"]);
  await assertRejects(
    () => sendApprovedSms({ ...deps, ghl: fakeGhl().ghl, locationId: "loc-1" }, id, CALLER),
    ApprovedSendRefusal,
  );
});

Deno.test("a timeout records outcome_unknown and is never resent", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  const provider = fakeGhl({ sendError: new GhlCallError(0, "timed out", true) });
  const result = await sendApprovedSms({ ...deps, ghl: provider.ghl, locationId: "loc-1" }, id, CALLER);
  assertEquals(result.body.state, "outcome_unknown");
  assertEquals(deps.store.rows.get(id)!.status, "outcome_unknown");
  const again = fakeGhl();
  const error = await assertRejects(
    () => sendApprovedSms({ ...deps, ghl: again.ghl, locationId: "loc-1" }, id, CALLER),
    ApprovedSendRefusal,
  );
  assertEquals(error.code, "approval_already_used");
  assertEquals(again.calls.length, 0);
});

Deno.test("a second send of a sent approval never reaches the provider", async () => {
  const deps = makeDeps();
  const id = await recordSms(deps);
  await sendApprovedSms({ ...deps, ghl: fakeGhl().ghl, locationId: "loc-1" }, id, CALLER);
  const replay = fakeGhl();
  await assertRejects(
    () => sendApprovedSms({ ...deps, ghl: replay.ghl, locationId: "loc-1" }, id, CALLER),
    ApprovedSendRefusal,
  );
  assertEquals(replay.calls.length, 0);
});

Deno.test("the GHL transport marks 5xx and network errors as outcome unknown", async () => {
  const fail5xx = makeGhlCall("t", () => Promise.resolve(new Response("boom", { status: 503 })));
  const e1 = await assertRejects(() => fail5xx("/x"), GhlCallError);
  assertEquals(e1.outcomeUnknown, true);
  const fail4xx = makeGhlCall("t", () => Promise.resolve(new Response("bad", { status: 400 })));
  const e2 = await assertRejects(() => fail4xx("/x"), GhlCallError);
  assertEquals(e2.outcomeUnknown, false);
  const network = makeGhlCall("t", () => Promise.reject(new TypeError("offline")));
  const e3 = await assertRejects(() => network("/x"), GhlCallError);
  assertEquals(e3.outcomeUnknown, true);
});
