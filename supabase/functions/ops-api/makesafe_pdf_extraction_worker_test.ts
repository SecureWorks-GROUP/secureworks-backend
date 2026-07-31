// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  drainMakesafePdfExtraction,
} from "./makesafe_pdf_extraction_worker.ts";

function workerClient(
  row: any | null,
  blob: Blob | null = new Blob(["%PDF-1.7"]),
  options: {
    carriers?: Array<{ id: string; email_id: string }>;
    remaining?: number;
    minutes?: number;
    loseExtractionFence?: boolean;
  } = {},
) {
  const updates: any[] = [];
  let downloads = 0;
  const carriers = options.carriers || (row
    ? [{ id: row.id, email_id: row.email_id }]
    : []);
  const client = {
    updates,
    get downloads() {
      return downloads;
    },
    rpc: (name: string) =>
      Promise.resolve(name === "claim_makesafe_pdf_extraction"
        ? { data: row ? [row] : [], error: null }
        : {
          data: [{
            remaining_coordinates: options.remaining ?? 0,
            estimated_minutes: options.minutes ?? 0,
          }],
          error: null,
        }),
    storage: {
      from: () => ({
        download: () => {
          downloads++;
          return Promise.resolve({
            data: blob,
            error: blob ? null : new Error("storage offline"),
          });
        },
      }),
    },
    from: (table: string) => {
      if (table !== "email_attachments") throw new Error(`unexpected table ${table}`);
      return {
        update: (patch: any) => {
          const chain: any = {
            eq: () => chain,
            select: () => {
              updates.push(patch);
              const extractionWrite = Object.hasOwn(
                patch,
                "pdf_extraction_status",
              );
              return Promise.resolve({
                data: extractionWrite
                  ? options.loseExtractionFence ? [] : carriers
                  : [{ id: row?.id || carriers[0]?.id }],
                error: null,
              });
            },
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
  pdf_extraction_claim_token: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  pdf_handoff_status: "not_required",
  pdf_handoff_attempts: 0,
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
        extractor: "content_stream_v1" as const,
        pageCount: 1,
        truncated: false,
      }),
      onSettled: async (postId) => {
        settled.push(postId);
      },
    },
  );

  assertEquals(result.outcome, "extracted");
  assertEquals(result.source_post_id, "MLB-19475");
  assertEquals(result.char_count, 57);
  assertEquals(result.extractor, "content_stream_v1");
  assertEquals(settled, ["MLB-19475"]);
  assertEquals(client.updates.length, 3);
  assertEquals(client.updates[0].pdf_extraction_status, "extracted");
  assertEquals(client.updates[0].pdf_handoff_status, "pending");
  assertEquals(client.updates[2].pdf_handoff_status, "completed");
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

Deno.test("PDF belt terminalizes the final failed extraction attempt", async () => {
  const client = workerClient(
    { ...ROW, pdf_extraction_attempts: 3 },
    null,
  );
  const result = await drainMakesafePdfExtraction(client, {}, {
    now: () => new Date("2026-07-31T01:05:00.000Z"),
  });

  assertEquals(result.outcome, "quarantined");
  assertStringIncludes(result.reason || "", "retry_exhausted:download_failed");
  assertEquals(client.updates[0].pdf_extraction_next_attempt_at, null);
  assertEquals(client.updates[0].pdf_handoff_status, "pending");
});

Deno.test("PDF belt reports an explicit ETA for the one-per-minute historical drain", async () => {
  const client = workerClient(null, null, { remaining: 2, minutes: 7 });
  const result = await drainMakesafePdfExtraction(
    client,
    {},
    { now: () => new Date("2026-07-31T01:05:00.000Z") },
  );

  assertEquals(result.outcome, "no_work");
  assertEquals(result.remaining_backlog, 2);
  assertEquals(result.drain_eta_at, "2026-07-31T01:12:00.000Z");
});

Deno.test("PDF belt fans one SHA extraction to every carrier and settles each source", async () => {
  const carriers = [
    { id: ROW.id, email_id: "graph-source" },
    { id: "22222222-2222-2222-2222-222222222222", email_id: "mailbox-source" },
  ];
  const client = workerClient(
    { ...ROW, email_id: "graph-source" },
    new Blob(["%PDF-1.7"]),
    { carriers },
  );
  const settled: string[] = [];
  const result = await drainMakesafePdfExtraction(client, {}, {
    extract: async () => ({
      text: "Work Order MLB-19475",
      rawText: "",
      charCount: 20,
      mode: "text" as const,
      streamsDecoded: 1,
      extractor: "content_stream_v1" as const,
    }),
    onSettled: async (source) => {
      settled.push(source);
    },
  });

  assertEquals(result.outcome, "extracted");
  assertEquals(client.downloads, 1);
  assertEquals(settled.sort(), ["graph-source", "mailbox-source"]);
});

Deno.test("PDF handoff failure is durable and retryable without re-reading bytes", async () => {
  const retryRow = {
    ...ROW,
    pdf_extraction_status: "extracted",
    pdf_handoff_status: "processing",
  };
  const client = workerClient(retryRow);
  const result = await drainMakesafePdfExtraction(client, {}, {
    now: () => new Date("2026-07-31T01:05:00.000Z"),
    onSettled: () => Promise.reject(new Error("board unavailable")),
  });

  assertEquals(client.downloads, 0);
  assertStringIncludes(result.scan_error || "", "board unavailable");
  assertEquals(client.updates[0].pdf_handoff_status, "failed");
  assert(client.updates[0].pdf_handoff_next_attempt_at);
});

Deno.test("PDF belt refuses settlement after a lost claim fence", async () => {
  const client = workerClient(ROW, new Blob(["%PDF-1.7"]), {
    loseExtractionFence: true,
  });
  let settled = false;
  await assertRejects(
    () =>
      drainMakesafePdfExtraction(client, {}, {
        extract: async () => ({
          text: "Work Order MLB-19475",
          rawText: "",
          charCount: 20,
          mode: "text" as const,
          streamsDecoded: 1,
          extractor: "content_stream_v1" as const,
        }),
        onSettled: async () => {
          settled = true;
        },
      }),
    Error,
    "claim fence lost",
  );
  assertEquals(settled, false);
});
