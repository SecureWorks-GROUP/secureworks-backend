import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { answerNeedsScoper, notifyNeedsScoper, openNeedsScoperItem } from "./needs_scoper.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const auth = { mode: "jwt" as const, user: { id: "user-1", orgId: ORG } };

Deno.test("needs scoper notify is fake transport and never live send", async () => {
  const client = {
    rpc: async (name: string) => {
      assertEquals(name, "notify_needs_scoper");
      return { data: { status: "sent", live_send: false, transport: "fake" }, error: null };
    },
  };
  const out = await notifyNeedsScoper(client, { item_id: "i1", body: "q", from_number: "+61489267771" }, auth, ORG);
  assertEquals(out.live_send, false);
  assertEquals(out.transport, "fake");
});

Deno.test("answering a scoper item does not approve client send", async () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assertEquals(name, "answer_needs_scoper");
      assertEquals(args.p_actor, "user-1");
      return { data: { status: "answered", client_send_approved: false, auto_forwarded_to_client: false }, error: null };
    },
  };
  const out = await answerNeedsScoper(client, { item_id: "i1", answer: "keep the line" }, auth, ORG);
  assertEquals(out.client_send_approved, false);
});

Deno.test("open uses signed-in actor", async () => {
  const client = {
    rpc: async (_n: string, args: Record<string, unknown>) => {
      assertEquals(args.p_actor, "user-1");
      return { data: { outcome: "opened", client_send_approved: false }, error: null };
    },
  };
  const out = await openNeedsScoperItem(client, {
    owner_key: "nithin",
    conversation_id: "c1",
    question: "q",
  }, auth, ORG);
  assertEquals(out.outcome, "opened");
});
