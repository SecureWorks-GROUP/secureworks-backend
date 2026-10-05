// One email, one evidence row (gap map W9, 6 Oct 2026).
//
// The old monitor-inbox path polls five mailboxes. One email sent to several
// of them (marnin@, jan@, nithin@, admin@) arrives once per mailbox, each with
// its own Graph message id, and the path used to save one business_events row
// per mailbox: 187 of the 334 copy rows on live jobs counted on 6 Oct 2026.
// Each copy is read by the model and doubles a count in the job's story.
//
// Before the evidence row is written the path asks whether this path already
// saved the same email from another mailbox:
//   1. by Graph's internetMessageId, which is the same in every mailbox that
//      received the email (the evidence row keeps it in
//      payload.internet_message_id); else
//   2. for rows saved before the id was kept: a row of this path with the same
//      sender, subject and words at the exact same received time, from
//      another mailbox, that carries no internet message id of its own (or the
//      same one).
// A copy writes no evidence row. Its inbox_events row is still written as
// before (the reply and forward fences and the job read use it).
//
// An unreadable lookup writes the row as before: a duplicate evidence row is
// recoverable, a lost email is not (the same rule as reader_handover.ts).

/** business_events.source values of the old path's evidence rows. */
export const OLD_PATH_EVIDENCE_SOURCES = ["monitor-inbox", "monitor_inbox"];

export interface MailIdentity {
  /** Graph internetMessageId; null when Graph gave none. */
  internetMessageId: string | null;
  /** payload.from as the evidence row stores it. */
  from: string;
  /** payload.subject as the evidence row stores it (first 200 characters). */
  subject: string;
  /** payload.body_preview as the evidence row stores it. */
  bodyPreview: string;
  /** Graph receivedDateTime: the evidence row's occurred_at. */
  receivedAt: string | null;
  mailbox: string;
}

export interface StoredMail {
  id: string;
  internet_message_id: string | null;
  mailbox: string | null;
}

export interface CopyLookup {
  /** Old-path rows whose payload.internet_message_id is this id. */
  byInternetMessageId(id: string): Promise<StoredMail[]>;
  /** Old-path rows with this sender, subject and words at this exact time. */
  bySameMail(mail: MailIdentity): Promise<StoredMail[]>;
}

export type CopyAnswer =
  | {
    copy: true;
    id: string;
    rule: "internet_message_id" | "same_mail_same_time";
  }
  | { copy: false; unreadable?: true };

/** Whether this path already saved this email from another mailbox. */
export async function findStoredCopy(
  lookup: CopyLookup,
  mail: MailIdentity,
): Promise<CopyAnswer> {
  const imid = clean(mail.internetMessageId);
  try {
    if (imid) {
      const rows = await lookup.byInternetMessageId(imid);
      const hit = rows.find((r) => typeof r.id === "string" && r.id);
      if (hit) return { copy: true, id: hit.id, rule: "internet_message_id" };
    }
    if (!clean(mail.receivedAt) || !clean(mail.from)) return { copy: false };
    const rows = await lookup.bySameMail(mail);
    const hit = rows.find((r) =>
      typeof r.id === "string" && r.id &&
      // Another mailbox's delivery of the same email, never a second
      // delivery to this mailbox.
      clean(r.mailbox) !== null && clean(r.mailbox) !== clean(mail.mailbox) &&
      // A row with its own different internet message id is another email.
      (clean(r.internet_message_id) === null ||
        clean(r.internet_message_id) === imid)
    );
    if (hit) return { copy: true, id: hit.id, rule: "same_mail_same_time" };
    return { copy: false };
  } catch {
    return { copy: false, unreadable: true };
  }
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function storedRows(data: unknown): StoredMail[] {
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    id: String((r as Record<string, unknown>)?.id ?? ""),
    internet_message_id: clean(
      (r as Record<string, unknown>)?.internet_message_id,
    ),
    mailbox: clean((r as Record<string, unknown>)?.mailbox),
  }));
}

/**
 * The two reads over one service-role client. Both are containment reads on
 * payload (the business_events payload index answers them). A PostgREST error
 * throws, so findStoredCopy reads it as unreadable and the row is written.
 */
// deno-lint-ignore no-explicit-any
export function supabaseCopyLookup(sb: any): CopyLookup {
  const columns =
    "id,internet_message_id:payload->>internet_message_id,mailbox:payload->>mailbox";
  return {
    async byInternetMessageId(id) {
      const { data, error } = await sb.from("business_events")
        .select(columns)
        .in("source", OLD_PATH_EVIDENCE_SOURCES)
        .contains("payload", { internet_message_id: id })
        .limit(5);
      if (error) throw new Error("copy_lookup_failed");
      return storedRows(data);
    },
    async bySameMail(mail) {
      const { data, error } = await sb.from("business_events")
        .select(columns)
        .in("source", OLD_PATH_EVIDENCE_SOURCES)
        .eq("occurred_at", mail.receivedAt)
        .contains("payload", {
          from: mail.from,
          subject: mail.subject,
          body_preview: mail.bodyPreview,
        })
        .limit(5);
      if (error) throw new Error("copy_lookup_failed");
      return storedRows(data);
    },
  };
}
