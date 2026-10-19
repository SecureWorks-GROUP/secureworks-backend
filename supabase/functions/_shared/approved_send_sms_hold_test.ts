// SMS shares the approved-send content hold (Codex should-fix: SMS scope).
// Fake GHL and fake claim store only; no provider is ever called.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApprovedSendRefusal, recordApproval } from "./approved_send.ts";
import { type GhlCall, GhlCallError, sendApprovedSms } from "./approved_send_sms.ts";
import { makeDeps, RECORDER, smsApprovalBody } from "./approved_send_test_fakes.ts";

const CALLER = { actor: "seat:rayleigh", credentialClass: "ops_agent_server_key" };

function ghlFake(mode: () => "ok" | "timeout" | "hang") {
  const sends: unknown[] = [];
  const hangs: Array<() => void> = [];
  const phones = new Map<string, string>();
  const ghl: GhlCall = (path, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (path === "/contacts/search/duplicate") {
      const hit = [...phones].find(([, phone]) => phone === body.phone);
      return Promise.resolve({ contact: hit ? { id: hit[0], phone: hit[1] } : null });
    }
    if (path === "/contacts/") {
      phones.set("c1", body.phone);
      return Promise.resolve({ contact: { id: "c1" } });
    }
    if (path.startsWith("/contacts/")) return Promise.resolve({ contact: { id: "c1", phone: phones.get("c1") } });
    if (path === "/conversations/messages") {
      sends.push(body);
      const m = mode();
      if (m === "timeout") return Promise.reject(new GhlCallError(504, "timeout", true));
      if (m === "hang") {
        return new Promise((resolve) => hangs.push(() => resolve({ messageId: "m", conversationId: "c" })));
      }
      return Promise.resolve({ messageId: "m", conversationId: "c" });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  };
  return { ghl, sends, release: () => hangs.shift()?.() };
}

async function record(deps: ReturnType<typeof makeDeps>, extra: Record<string, unknown> = {}) {
  const body = { ...smsApprovalBody(), ...extra };
  const preview = await recordApproval(deps, RECORDER, body);
  const live = await recordApproval(deps, RECORDER, { ...body, dry_run: false, expected_payload_hash: preview.payload_hash });
  deps.clock.advanceMinutes(1); // real time passes between recording and sending
  return live.approval_id!;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 0));
  assert(check());
}

Deno.test("SMS: an unknown SMS holds a re-approval and an earlier approval of the same text", async () => {
  let m: "ok" | "timeout" | "hang" = "timeout";
  const g = ghlFake(() => m);
  const deps = { ...makeDeps(), ghl: g.ghl, locationId: "loc" };
  const earlier = await record(deps);
  const first = await record(deps);
  assertEquals((await sendApprovedSms(deps, first, CALLER)).body.state, "outcome_unknown");
  m = "ok";
  const again = await assertRejects(() => record(deps), ApprovedSendRefusal);
  assertEquals((again as ApprovedSendRefusal).code, "approval_prior_outcome_unknown");
  const held = await assertRejects(() => sendApprovedSms(deps, earlier, CALLER), ApprovedSendRefusal);
  assertEquals((held as ApprovedSendRefusal).code, "send_claim_held");
  assertEquals(g.sends.length, 1);
  // After the conversation is checked, the checked approval sends once.
  const checked = await record(deps, { sent_items_checked: true });
  assertEquals((await sendApprovedSms(deps, checked, CALLER)).body.state, "sent");
  assertEquals(g.sends.length, 2);
});

Deno.test("SMS: two approvals of the same text pressed together send one SMS", async () => {
  let m: "ok" | "timeout" | "hang" = "hang";
  const g = ghlFake(() => m);
  const deps = { ...makeDeps(), ghl: g.ghl, locationId: "loc" };
  const a = await record(deps);
  const b = await record(deps);
  const both = Promise.allSettled([sendApprovedSms(deps, a, CALLER), sendApprovedSms(deps, b, CALLER)]);
  await until(() => g.sends.length === 1);
  for (let i = 0; i < 200; i++) await Promise.resolve();
  m = "ok";
  g.release();
  const results = await both;
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  assertEquals(g.sends.length, 1);
});
