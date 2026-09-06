// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  collectScopeMedia,
  existingMediaMatchesVideo,
  extractScopeMedia,
  extractScopePhotos,
  selectTradeJobMedia,
  TRADE_WALKTHROUGH_LABEL,
} from "./trade_scope_media.ts";

const WALKTHROUGH_URL = "https://cdn.example.test/jobs/swf-26101/walkthrough.mp4";
const PHOTO_URL = "https://cdn.example.test/jobs/swf-26101/front.jpg";

function tinyJpegDataUrl(): string {
  // 1x1 jpeg — enough to prove the upload path without a real image decode.
  return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wgARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGz/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=";
}

function makeExtractClient(existing: any[] = []) {
  const media = existing.map((row) => ({ ...row }));
  const uploads: Array<{ bucket: string; path: string }> = [];
  const api = {
    media,
    uploads,
    from(table: string) {
      return {
        select(_cols?: string) {
          return {
            eq(col: string, val: any) {
              const filtered = media.filter((r) =>
                String(r?.[col] ?? "") === String(val)
              );
              return Promise.resolve({ data: table === "job_media" ? filtered : [], error: null });
            },
          };
        },
        insert(row: any) {
          const rec = { id: `m-${media.length + 1}`, ...row };
          media.push(rec);
          return Promise.resolve({ data: rec, error: null });
        },
      };
    },
    storage: {
      createBucket: async () => ({}),
      from(bucket: string) {
        return {
          upload: async (path: string) => {
            uploads.push({ bucket, path });
            return { error: null };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://storage.test/${bucket}/${path}` },
          }),
        };
      },
    },
  };
  return api;
}

Deno.test("collectScopeMedia reads job.scopeMedia videos and top-level photos", () => {
  const collected = collectScopeMedia({
    scopeMedia: {
      photos: [{ label: "Front", url: PHOTO_URL }],
    },
    job: {
      scopeMedia: {
        videoWalkthrough: WALKTHROUGH_URL,
        videoFileName: "site-walkthrough.mov",
        videoSize: 18432000,
      },
    },
  });
  assertEquals(collected.photos.length, 1);
  assertEquals(collected.photos[0].storageUrl, PHOTO_URL);
  assertEquals(collected.videos.length, 1);
  assertEquals(collected.videos[0].storageUrl, WALKTHROUGH_URL);
  assertEquals(collected.videos[0].label, TRADE_WALKTHROUGH_LABEL);
});

Deno.test("collectScopeMedia reads a video object parked on top-level scopeMedia", () => {
  const collected = collectScopeMedia({
    scopeMedia: {
      photos: [],
      video: {
        label: "Site walkthrough",
        cloudUrl: WALKTHROUGH_URL,
        videoFileName: "walk.mp4",
        originalSize: 99,
      },
    },
  });
  assertEquals(collected.videos.map((v) => v.storageUrl), [WALKTHROUGH_URL]);
});

Deno.test("collectScopeMedia ignores blob: object URLs and filename-only stays metadata", () => {
  const collected = collectScopeMedia({
    job: {
      scopeMedia: {
        video: {
          objectUrl: "blob:https://local/abc",
          videoFileName: "IMG_1234.MOV",
          videoSize: 5000,
        },
      },
    },
  });
  assertEquals(collected.videos.length, 1);
  assertEquals(collected.videos[0].storageUrl, undefined);
  assertEquals(collected.videos[0].fileName, "IMG_1234.MOV");
});

Deno.test("extractScopeMedia registers a walkthrough URL even when scope photos already exist", async () => {
  const client = makeExtractClient([
    {
      id: "photo-1",
      job_id: "job-1",
      phase: "scope",
      type: "photo",
      storage_url: PHOTO_URL,
      label: "Front",
    },
  ]);
  const result = await extractScopeMedia(client, "job-1", {
    job: { scopeMedia: { videoWalkthrough: WALKTHROUGH_URL } },
    scopeMedia: { photos: [{ dataUrl: tinyJpegDataUrl(), label: "Would re-upload" }] },
  });
  assertEquals(result.videos, 1);
  assertEquals(result.photos, 0, "existing scope photos must not be re-extracted");
  assertEquals(result.rows[0].type, "video");
  assertEquals(result.rows[0].phase, "scope");
  assertEquals(result.rows[0].label, TRADE_WALKTHROUGH_LABEL);
  assertEquals(result.rows[0].storage_url, WALKTHROUGH_URL);
  assertEquals(client.uploads.length, 0, "public URLs are reused, never re-signed");
});

Deno.test("extractScopeMedia is idempotent for the same walkthrough URL", async () => {
  const client = makeExtractClient([]);
  const scope = { scopeMedia: { video: { storage_url: WALKTHROUGH_URL } } };
  const first = await extractScopeMedia(client, "job-1", scope);
  const second = await extractScopeMedia(client, "job-1", scope);
  assertEquals(first.videos, 1);
  assertEquals(second.videos, 0);
  assertEquals(client.media.filter((m: any) => m.type === "video").length, 1);
});

Deno.test("extractScopeMedia does not invent a player row from filename-only metadata", async () => {
  const client = makeExtractClient([]);
  const result = await extractScopeMedia(client, "job-1", {
    job: { scopeMedia: { videoFileName: "walkthrough.mov", videoSize: 12000 } },
  });
  assertEquals(result.videos, 0);
  assertEquals(result.rows, []);
  assertEquals(client.media.length, 0);
});

Deno.test("extractScopeMedia uploads a dataUrl photo from job.scopeMedia", async () => {
  const client = makeExtractClient([]);
  const result = await extractScopeMedia(client, "job-1", {
    job: {
      scopeMedia: {
        photos: [{ dataUrl: tinyJpegDataUrl(), label: "Rear" }],
      },
    },
  });
  assertEquals(result.photos, 1);
  assertEquals(result.rows[0].label, "Rear");
  assertEquals(client.uploads[0].bucket, "job-photos");
  assertEquals(String(result.rows[0].storage_url).startsWith("https://storage.test/"), true);
});

Deno.test("extractScopePhotos still reports combined extracted media", async () => {
  const client = makeExtractClient([]);
  const n = await extractScopePhotos(client, "job-1", {
    scopeMedia: { videoWalkthrough: WALKTHROUGH_URL },
  });
  assertEquals(n, 1);
});

Deno.test("existingMediaMatchesVideo matches URL or filename fragment", () => {
  assertEquals(
    existingMediaMatchesVideo(
      { type: "video", storage_url: WALKTHROUGH_URL },
      { label: "Walkthrough", storageUrl: WALKTHROUGH_URL },
    ),
    true,
  );
  assertEquals(
    existingMediaMatchesVideo(
      { type: "video", storage_url: "https://cdn/x/IMG_1234.MOV" },
      { label: "Walkthrough", fileName: "IMG_1234.MOV" },
    ),
    true,
  );
  assertEquals(
    existingMediaMatchesVideo(
      { type: "photo", storage_url: WALKTHROUGH_URL },
      { label: "Walkthrough", storageUrl: WALKTHROUGH_URL },
    ),
    false,
  );
});

Deno.test("selectTradeJobMedia keeps current-cycle photos and recovers the unbound walkthrough", () => {
  const media = [
    {
      id: "old-photo",
      type: "photo",
      phase: "scope",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    },
    {
      id: "new-photo",
      type: "photo",
      phase: "completion",
      attendance_cycle_id: "cycle-2",
      cycle_attribution: "bound",
    },
    {
      id: "walk",
      type: "video",
      phase: "scope",
      label: "Walkthrough",
      storage_url: WALKTHROUGH_URL,
    },
    {
      id: "other-vid",
      type: "video",
      phase: "completion",
      label: "Install clip",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    },
  ];
  const selected = selectTradeJobMedia(media, { reattend_count: 1, cycle_number: 2 }, "cycle-2");
  assertEquals(selected.map((r) => r.id).sort(), ["new-photo", "other-vid", "walk"]);
});

Deno.test("selectTradeJobMedia without a reattend boundary returns every row", () => {
  const media = [
    { id: "p", type: "photo" },
    { id: "v", type: "video" },
  ];
  assertEquals(selectTradeJobMedia(media, { reattend_count: 0 }, null).map((r) => r.id), [
    "p",
    "v",
  ]);
});
