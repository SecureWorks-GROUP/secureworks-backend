// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  drainMakesafePdfExtraction,
} from "./makesafe_pdf_extraction_worker.ts";

function workerClient(
  row: any | null,
  blob: Blob | null = new Blob(["%PDF-1.7"]),
) {
  const updates: any[] = [];
  const client = {
    updates,
    rpc: () => Promise.resolve({ data: row ? [row] : [], error: null }),
    storage: {
      from: () => ({
        download: () => Promise.resolve({
          data: blob,
          error: blob ? null : new Error("storage offline"),
        }),
      }),
    },
    from: (table: string) => {
      if (table !== "email_attachments") throw new Error(`unexpected table ${table}`);
      return {
        update: (patch: any) => {
          const chain: any = {
            eq: () => chain,
            then: (resolve: (value: any) => void) => {
              updates.push(patch);
              resolve({ error: null });
            },
          };
          return chain;
        },
        select: () => {
          const chain: any = {
            eq: () => chain,
            in: () => chain,
            then: (resolve: (value: any) => void) => resolve({ count: 0, error: null }),
          };
          return chain;
        },
      };
    },
  };
  return client;
}

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  email_id: "MLB-19475",
  storage_path: "MLB-19475/wo.pdf",
  size_bytes: 1200,
  pdf_extraction_status: "processing",
  pdf_extraction_attempts: 1,
};

Deno.test("PDF belt reads one stored PDF and hands the same source to deterministic intake", async () => {
  const client = workerClient(ROW);
  const settled: string[] = [];
  const result = await drainMakesafePdfExtraction(
    client,
    { attachmentId: ROW.id, freshOnly: true },
    {
      now: () => new Date("2026-07-31T01:05:00.000Z"),
      extract: async () => ({
        text: "Work Order Number MLB-19475PO-56336\nClient: Test Client",
        rawText: "",
        charCount: 57,
        mode: "text" as const,
        streamsDecoded: 1,
        extractor: "test-extractor",
        pageCount: 1,
        truncated: false,
      }),
      onSettled: async (postId) => settled.push(postId),
    },
  );

  assertEquals(result.outcome, "extracted");
  assertEquals(result.source_post_id, "MLB-19475");
  assertEquals(result.char_count, 57);
  assertEquals(result.extractor, "test-extractor");
  assertEquals(settled, ["MLB-19475"]);
  assertEquals(client.updates.length, 1);
  assertEquals(client.updates[0].pdf_extraction_status, "extracted");
  assertStringIncludes(client.updates[0].pdf_extraction_text, "MLB-19475");
});

Deno.test("PDF belt records a reason-coded retryable failure instead of silently skipping bytes", async () => {
  const client = workerClient(ROW, null);
  const result = await drainMakesafePdfExtraction(
    client,
    { attachmentId: ROW.id },
    { now: () => new Date("2026-07-31T01:05:00.000Z") },
  );

  assertEquals(result.outcome, "failed");
  assertStringIncludes(result.reason || "", "download_failed");
  assertEquals(client.updates[0].pdf_extraction_status, "failed");
  assert(client.updates[0].pdf_extraction_next_attempt_at);
});

Deno.test("PDF belt reports an explicit ETA for the one-per-minute historical drain", async () => {
  const client = workerClient(null);
  const result = await drainMakesafePdfExtraction(
    client,
    {},
    { now: () => new Date("2026-07-31T01:05:00.000Z") },
  );

  assertEquals(result.outcome, "no_work");
  assertEquals(result.remaining_backlog, 0);
  assertEquals(result.drain_eta_at, "2026-07-31T01:05:00.000Z");
});
