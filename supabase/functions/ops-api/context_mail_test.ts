import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  correctMessageWorkLink,
  openMessageAttachment,
  recordContextMailOccurrence,
  readMessageWorkLinks,
} from "./context_mail.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

Deno.test("JWT correction uses signed-in actor and org, not body spoof", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: { ok: true, actor: args.p_actor }, error: null };
    },
  };
  await correctMessageWorkLink(
    client,
    { event_id: "e1", op: "unlink", kind: "job", target_id: "j1", actor: "spoofed" },
    { mode: "jwt", user: { id: "user-1", orgId: ORG } },
    ORG,
  );
  assertEquals(calls[0].name, "correct_message_work_link");
  assertEquals(calls[0].args.p_actor, "user-1");
  assertEquals(calls[0].args.p_org_id, ORG);
});

Deno.test("mail occurrence producer is the RPC, not a raw insert", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      return { data: { ok: true, event_id: "e1", created: true }, error: null };
    },
  };
  const out = await recordContextMailOccurrence(
    client,
    {
      mail: {
        mailbox: "ops@example.test",
        folder: "inbox",
        graph_id: "g1",
        internet_message_id: "<joint-mail@example.test>",
        subject: "SWF-261000 / PO-JOINT-1 / INV-JOINT-1",
        body: "Work instruction for the job, PO and invoice.",
        from: "supplier@example.test",
      },
      links: [
        { kind: "job", id: "j1" },
        { kind: "po", id: "p1" },
        { kind: "invoice", id: "inv1" },
      ],
    },
    { mode: "jwt", user: { id: "user-1", orgId: ORG } },
    ORG,
  );
  assertEquals(calls, ["record_context_mail_occurrence"]);
  assertEquals(out.created, true);
});

Deno.test("reader calls read_message_work_links", async () => {
  const client = {
    rpc: async (name: string) => {
      assertEquals(name, "read_message_work_links");
      return { data: { links: [{ kind: "job" }], occurrences: [{}] }, error: null };
    },
  };
  const out = await readMessageWorkLinks(
    client,
    { event_id: "e1" },
    { mode: "api_key", user: null },
    ORG,
  );
  assertEquals(out.links.length, 1);
});

Deno.test("attachment open is a permissioned RPC, not a borrowed object id", async () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assertEquals(name, "open_message_attachment");
      assertEquals(args.p_org_id, ORG);
      return { data: null, error: { message: "message_attachment_scope_mismatch" } };
    },
  };
  await assertRejects(() =>
    openMessageAttachment(
      client,
      { event_id: "e1", store: "job_documents", object_id: "other-job-doc" },
      { mode: "jwt", user: { id: "user-1", orgId: ORG } },
      ORG,
    )
  );
});

Deno.test("JWT org mismatch is refused", async () => {
  await assertRejects(() =>
    correctMessageWorkLink(
      { rpc: async () => ({ data: {}, error: null }) },
      { event_id: "e1", op: "link", kind: "job", target_id: "j1" },
      { mode: "jwt", user: { id: "user-1", orgId: "other-org" } },
      ORG,
    )
  );
});
