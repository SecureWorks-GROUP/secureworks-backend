// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveDispatchAttachments } from "./dispatch_attachments.ts";
Deno.test("job document/media IDs resolve canonical pointer and actual bytes, never browser URL/hash", async () => {
  const rows = [{
    id: "doc1",
    pdf_url: "https://storage.example.test/quote.pdf",
    file_name: "Quote.pdf",
  }];
  const result = await resolveDispatchAttachments(
    [{
      id: "doc1",
      source_ref: "https://attacker.test/file",
      revision: "timestamp",
    }],
    rows,
    [],
    (url, name) => {
      assertEquals(url, rows[0].pdf_url);
      assertEquals(name, "Quote.pdf");
      return Promise.resolve({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name,
        contentType: "application/pdf",
        contentBytes: btoa("abc"),
      });
    },
  );
  assertEquals(
    result[0].revision,
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
Deno.test("foreign attachment id refuses without fetching", async () => {
  await assertRejects(
    () =>
      resolveDispatchAttachments([{ id: "foreign" }], [], [], () => {
        throw Error("must not fetch");
      }),
    Error,
    "does not belong",
  );
});
