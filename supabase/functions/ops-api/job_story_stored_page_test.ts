import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readJobStory } from "./job_story_read.ts";

const JOB = "00000000-0000-4000-8000-000000000412";
const live = { version: "job-story-v1", job: { id: JOB }, loops: [] };
const stored = { ...live, loops: [{ key: "stored" }] };

Deno.test("stored story switch preserves live and historical reads and falls back on unusable pages", async () => {
  for (const enabled of [false, null, true]) {
    for (const historical of [false, true]) {
      const calls: string[] = [];
      const client = {
        from: () => ({
          select: () => ({
            eq: (key: string, value: string) => {
              assertEquals([key, value], [
                "flag_name",
                "job_page_stored_read_v1",
              ]);
              return ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: enabled === null ? null : { enabled },
                    error: null,
                  }),
              });
            },
          }),
        }),
        rpc: (fn: string) => {
          calls.push(fn);
          return Promise.resolve({
            data: fn === "job_page_get"
              ? {
                version: "job-page-v1",
                card: stored,
                status: "ready",
                stale: true,
                as_at: "2026-11-17T00:00:00Z",
                kept_ready: true,
                page_version: 1,
              }
              : live,
            error: null,
          });
        },
      };
      const result = await readJobStory(client, {
        jobId: JOB,
        ...(historical ? { asOf: "2026-11-16T00:00:00Z" } : {}),
      });
      assertEquals(result.status.ok, true);
      if (enabled === true && !historical) {
        assertEquals(calls, ["job_page_get"]);
        assertEquals(result.story.loops, stored.loops);
        assertEquals(result.story.meta.stored_page.stale, true);
        assertEquals(
          result.story.meta.stored_page.as_at,
          "2026-11-17T00:00:00Z",
        );
      } else {
        assertEquals(calls, ["context_job_story"]);
        assertEquals(result.story, live);
      }
    }
  }
  for (
    const page of [null, {}, [], "bad shape", {
      version: "job-page-v1",
      status: "failed",
      card: stored,
    }, {
      version: "job-page-v1",
      status: "ready",
      card: { ...stored, job: { id: "other" } },
    }, {
      version: "job-page-v1",
      status: "ready",
      card: { ...stored, version: "bad shape" },
    }, {
      version: "job-page-v1",
      status: "ready",
      card: null,
    }, {
      version: "job-page-v1",
      status: "building",
      card: stored,
    }]
  ) {
    const calls: unknown[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { enabled: true }, error: null }),
          }),
        }),
      }),
      rpc: (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return Promise.resolve({
          data: fn === "job_page_get" ? page : live,
          error: null,
        });
      },
    };
    const result = await readJobStory(client, { jobId: JOB });
    assertEquals(calls, [
      ["job_page_get", { p_job_id: JOB }],
      ["context_job_story", { p_job_id: JOB }],
    ]);
    assertEquals(result.story, live);
    assertEquals(result.status.ok, true);
  }
});

Deno.test("stored story RPC errors and throws fall back once to the live call", async () => {
  for (const throws of [false, true]) {
    const calls: unknown[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { enabled: true }, error: null }),
          }),
        }),
      }),
      rpc: (fn: string, args: unknown) => {
        calls.push([fn, args]);
        if (fn === "job_page_get") {
          if (throws) throw new Error("ZZTEST stored read failed");
          return Promise.resolve({
            data: { card: stored },
            error: { code: "XX000" },
          });
        }
        return Promise.resolve({ data: live, error: null });
      },
    };
    const result = await readJobStory(client, { jobId: JOB });
    assertEquals(calls, [
      ["job_page_get", { p_job_id: JOB }],
      ["context_job_story", { p_job_id: JOB }],
    ]);
    assertEquals(result.story, live);
    assertEquals(result.status.ok, true);
  }
});
