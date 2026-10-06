// Gap map W9: one email sent to several of the old path's mailboxes is saved
// as one evidence row. The rows below are the live shapes counted on 6 Oct
// 2026 (synthetic ids and addresses).
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CopyLookup,
  findStoredCopy,
  type MailIdentity,
  OLD_PATH_EVIDENCE_SOURCES,
  type StoredMail,
  supabaseCopyLookup,
} from "./self_copy.ts";

const MAIL: MailIdentity = {
  internetMessageId: "<SY4PR01MB0001@example.prod.outlook.com>",
  from: "accounts@supplier.example",
  subject: "Order confirmation PO-261001",
  bodyPreview: "Please find attached your order confirmation.",
  receivedAt: "2026-10-02T09:47:04Z",
  mailbox: "jan@secureworkswa.com.au",
};

function lookup(
  byId: StoredMail[] | Error,
  bySame: StoredMail[] | Error,
  calls: string[] = [],
): CopyLookup {
  return {
    byInternetMessageId(id) {
      calls.push(`id:${id}`);
      return byId instanceof Error
        ? Promise.reject(byId)
        : Promise.resolve(byId);
    },
    bySameMail(m) {
      calls.push(`same:${m.receivedAt}`);
      return bySame instanceof Error
        ? Promise.reject(bySame)
        : Promise.resolve(bySame);
    },
  };
}

Deno.test("the same internet message id from another mailbox is a copy", async () => {
  const calls: string[] = [];
  const a = await findStoredCopy(
    lookup(
      [{
        id: "e-1",
        internet_message_id: MAIL.internetMessageId,
        mailbox: "marnin@secureworkswa.com.au",
      }],
      [],
      calls,
    ),
    MAIL,
  );
  assertEquals(a, { copy: true, id: "e-1", rule: "internet_message_id" });
  assertEquals(calls, [`id:${MAIL.internetMessageId}`]);
});

Deno.test("a row saved before the id was kept: same sender, subject, words and time from another mailbox", async () => {
  const a = await findStoredCopy(
    lookup([], [{
      id: "e-2",
      internet_message_id: null,
      mailbox: "marnin@secureworkswa.com.au",
    }]),
    MAIL,
  );
  assertEquals(a, { copy: true, id: "e-2", rule: "same_mail_same_time" });
});

Deno.test("a second delivery to the same mailbox is not a copy (two separate deliveries)", async () => {
  const a = await findStoredCopy(
    lookup([], [{
      id: "e-3",
      internet_message_id: null,
      mailbox: MAIL.mailbox,
    }]),
    MAIL,
  );
  assertEquals(a, { copy: false });
});

Deno.test("an older row with its own different internet message id is another email", async () => {
  const a = await findStoredCopy(
    lookup([], [{
      id: "e-4",
      internet_message_id: "<other@example>",
      mailbox: "admin@secureworkswa.com.au",
    }]),
    MAIL,
  );
  assertEquals(a, { copy: false });
});

Deno.test("no internet message id: only the same-mail read decides", async () => {
  const calls: string[] = [];
  const a = await findStoredCopy(
    lookup([{ id: "never", internet_message_id: null, mailbox: null }], [
      {
        id: "e-5",
        internet_message_id: null,
        mailbox: "admin@secureworkswa.com.au",
      },
    ], calls),
    { ...MAIL, internetMessageId: null },
  );
  assertEquals(a, { copy: true, id: "e-5", rule: "same_mail_same_time" });
  assertEquals(calls, [`same:${MAIL.receivedAt}`]);
});

Deno.test("no received time or no sender: never matched by content", async () => {
  const calls: string[] = [];
  const any = [{
    id: "e-6",
    internet_message_id: null,
    mailbox: "admin@secureworkswa.com.au",
  }];
  assertEquals(
    await findStoredCopy(lookup([], any, calls), {
      ...MAIL,
      internetMessageId: null,
      receivedAt: null,
    }),
    { copy: false },
  );
  assertEquals(
    await findStoredCopy(lookup([], any, calls), {
      ...MAIL,
      internetMessageId: null,
      from: " ",
    }),
    { copy: false },
  );
  assertEquals(calls, []);
});

Deno.test("an unreadable lookup writes the row (a duplicate is recoverable, a lost email is not)", async () => {
  assertEquals(
    await findStoredCopy(lookup(new Error("down"), []), MAIL),
    { copy: false, unreadable: true },
  );
  assertEquals(
    await findStoredCopy(lookup([], new Error("down")), MAIL),
    { copy: false, unreadable: true },
  );
});

// A PostgREST double: records the filters and answers with fixed rows.
function fakeClient(answer: { data: unknown; error: unknown }) {
  const seen: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "contains", "limit"]) {
    builder[m] = (...args: unknown[]) => {
      seen.push([m, ...args]);
      return m === "limit" ? Promise.resolve(answer) : builder;
    };
  }
  return {
    seen,
    from(table: string) {
      seen.push(["from", table]);
      return builder;
    },
  };
}

Deno.test("the reads are containment reads on the old path's own rows", async () => {
  const sb = fakeClient({
    data: [{
      id: "e-7",
      internet_message_id: "<x>",
      mailbox: "admin@secureworkswa.com.au",
    }],
    error: null,
  });
  const l = supabaseCopyLookup(sb);
  assertEquals(await l.byInternetMessageId("<x>"), [
    {
      id: "e-7",
      internet_message_id: "<x>",
      mailbox: "admin@secureworkswa.com.au",
    },
  ]);
  assertEquals(sb.seen.slice(0, 4), [
    ["from", "business_events"],
    [
      "select",
      "id,internet_message_id:payload->>internet_message_id,mailbox:payload->>mailbox",
    ],
    ["in", "source", OLD_PATH_EVIDENCE_SOURCES],
    ["contains", "payload", { internet_message_id: "<x>" }],
  ]);
  sb.seen.length = 0;
  await l.bySameMail(MAIL);
  assertEquals(sb.seen.slice(2, 5), [
    ["in", "source", OLD_PATH_EVIDENCE_SOURCES],
    ["eq", "occurred_at", MAIL.receivedAt],
    ["contains", "payload", {
      from: MAIL.from,
      subject: MAIL.subject,
      body_preview: MAIL.bodyPreview,
    }],
  ]);
  const failing = supabaseCopyLookup(
    fakeClient({ data: null, error: { code: "57014" } }),
  );
  assertEquals(await findStoredCopy(failing, MAIL), {
    copy: false,
    unreadable: true,
  });
});

Deno.test("the old path keeps the id, checks before writing evidence, and still writes inbox_events first", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("$select=id,internetMessageId,"), true);
  assertEquals(
    src.includes("internet_message_id: msg.internetMessageId || undefined"),
    true,
  );
  const gate = src.indexOf("if (writeEvidence && (isSupplier");
  const check = src.indexOf("findStoredCopy(supabaseCopyLookup(sb)");
  assertEquals(gate > 0 && check > gate, true);
  // The check runs before either evidence write (T7 or legacy insert).
  assertEquals(check < src.indexOf("await recordEvidence(sb, {"), true);
  assertEquals(
    check < src.indexOf("sb.from('business_events').insert(legacySpineRow)"),
    true,
  );
  assertEquals(src.indexOf("sb.from('inbox_events').insert") < check, true);
});
