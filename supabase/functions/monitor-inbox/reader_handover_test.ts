// Slice EM2: the old monitor-inbox path leaves email evidence rows to the
// email reader only once the reader runs on its schedule; anything unreadable
// keeps the old path writing (a duplicate is recoverable, a lost email is not).
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readerOwnsEvidence, readReaderFlags } from "./reader_handover.ts";

Deno.test("handed over only when reader, schedule and program flags are all on", () => {
  assertEquals(
    readerOwnsEvidence({ reader: true, schedule: true, program: true }),
    true,
  );
  assertEquals(
    readerOwnsEvidence({ reader: true, schedule: false, program: true }),
    false,
  );
  assertEquals(
    readerOwnsEvidence({ reader: false, schedule: true, program: true }),
    false,
  );
  assertEquals(
    readerOwnsEvidence({ reader: true, schedule: true, program: false }),
    false,
  );
  assertEquals(
    readerOwnsEvidence({ reader: "true", schedule: true, program: true }),
    false,
  );
  assertEquals(readerOwnsEvidence(null), false);
});

Deno.test("an unreadable flag read keeps the old path writing", async () => {
  const failing = {
    rpc: () => Promise.resolve({ data: null, error: { code: "42883" } }),
  };
  assertEquals(readerOwnsEvidence(await readReaderFlags(failing)), false);
  const throwing = { rpc: () => Promise.reject(new Error("down")) };
  assertEquals(readerOwnsEvidence(await readReaderFlags(throwing)), false);
  const on = {
    rpc: () =>
      Promise.resolve({
        data: { reader: true, schedule: true, program: true },
        error: null,
      }),
  };
  assertEquals(readerOwnsEvidence(await readReaderFlags(on)), true);
});

Deno.test("the old path checks the handover before writing evidence and before reading groups", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // The evidence block is gated on writeEvidence; the group reader on the handover.
  assertEquals(
    /if \(writeEvidence && \(isSupplier \|\| isClient/.test(src),
    true,
  );
  assertEquals(
    /if \(!handedOver\) \{\s*for \(const groupMail of GROUP_MAILBOXES\)/.test(
      src,
    ),
    true,
  );
  // inbox_events is still written before the gate (fences and job read rely on it).
  assertEquals(
    src.indexOf("sb.from('inbox_events').insert") <
      src.indexOf("if (writeEvidence &&"),
    true,
  );
});
