// Canonical Graph-mail capture adapter. Monitor-inbox must call this instead of
// a raw business_events insert. Ambiguous refs stay unresolved.

export type GraphMailShape = {
  id?: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
};

export type WorkRef = { kind: "job" | "po" | "invoice"; id: string };

export function extractWorkTokens(subject: string, body: string) {
  const text = `${subject}\n${body}`;
  const jobs = [...text.matchAll(/\b(SW[A-Z]{1,3}-\d{4,8}|JOINT-MAIL-\d+)\b/gi)].map((m) => m[1].toUpperCase());
  const pos = [...text.matchAll(/\b(PO-?[A-Z0-9-]*\d+)\b/gi)].map((m) => m[1].toUpperCase());
  const invoices = [...text.matchAll(/\b(INV-[A-Z0-9-]+)\b/gi)].map((m) => m[1].toUpperCase());
  return {
    jobs: [...new Set(jobs)],
    pos: [...new Set(pos)],
    invoices: [...new Set(invoices)],
  };
}

export function chooseCanonicalLinks(found: {
  jobs: string[];
  pos: string[];
  invoices: string[];
}): { links: WorkRef[]; unresolved: boolean; reason: string } {
  if (found.jobs.length > 1 || found.pos.length > 1 || found.invoices.length > 1) {
    return { links: [], unresolved: true, reason: "ambiguous_work_refs" };
  }
  const links: WorkRef[] = [];
  if (found.jobs.length === 1) links.push({ kind: "job", id: found.jobs[0] });
  if (found.pos.length === 1) links.push({ kind: "po", id: found.pos[0] });
  if (found.invoices.length === 1) links.push({ kind: "invoice", id: found.invoices[0] });
  if (!links.length) return { links: [], unresolved: true, reason: "no_evidence" };
  return { links, unresolved: false, reason: "explicit_tokens" };
}

export async function captureCanonicalMailOccurrence(
  client: { rpc: Function },
  input: {
    orgId: string;
    mailbox: string;
    folder?: string;
    msg: GraphMailShape;
    actor: string;
    links: WorkRef[];
  },
) {
  const mail = {
    mailbox: input.mailbox,
    folder: input.folder || "inbox",
    graph_id: input.msg.id,
    internet_message_id: input.msg.internetMessageId || null,
    subject: input.msg.subject || "",
    body: input.msg.bodyPreview || "",
    from: input.msg.from?.emailAddress?.address || "",
    occurred_at: input.msg.receivedDateTime,
    thread_key: input.msg.conversationId || null,
  };
  const { data, error } = await client.rpc("record_context_mail_occurrence", {
    p_org_id: input.orgId,
    p_mail: mail,
    p_links: input.links,
    p_actor: input.actor,
  });
  if (error) throw new Error(error.message);
  return data;
}
