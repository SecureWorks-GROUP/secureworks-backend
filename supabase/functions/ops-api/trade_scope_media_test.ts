// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  collectScopeMedia,
  deterministicScopeMediaId,
  existingMediaMatchesVideo,
  extractScopeMedia,
  extractScopePhotos,
  isJobMediaUniqueViolation,
  selectTradeJobMedia,
  TRADE_WALKTHROUGH_LABEL,
} from "./trade_scope_media.ts";

const WALKTHROUGH_URL = "https://cdn.example.test/jobs/swf-26101/walkthrough.mp4";
const PHOTO_URL = "https://cdn.example.test/jobs/swf-26101/front.jpg";

function tinyJpegDataUrl(): string {
  // 1x1 jpeg — enough to prove the upload path without a real image decode.
  return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wgARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGz/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=";
}

function makeExtractClient(
  existing: any[] = [],
  opts: {
    throwOnUpload?: boolean | ((path: string) => boolean);
    hideJobScan?: boolean;
    forceUniqueViolation?: boolean;
  } = {},
) {
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
              if (opts.hideJobScan && col === "job_id") {
                return Promise.resolve({ data: [], error: null });
              }
              const filtered = media.filter((r) =>
                String(r?.[col] ?? "") === String(val)
              );
              return Promise.resolve({ data: table === "job_media" ? filtered : [], error: null });
            },
          };
        },
        insert(row: any) {
          const id = row?.id || `m-${media.length + 1}`;
          if (
            opts.forceUniqueViolation ||
            media.some((r) => String(r?.id || "") === String(id))
          ) {
            return Promise.resolve({
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            });
          }
          const rec = { id, ...row };
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
            const shouldThrow = typeof opts.throwOnUpload === "function"
              ? opts.throwOnUpload(path)
              : !!opts.throwOnUpload;
            if (shouldThrow) throw new Error("storage upload threw");
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

Deno.test("deterministicScopeMediaId is stable for the same job+url", async () => {
  const first = await deterministicScopeMediaId("job-1", WALKTHROUGH_URL);
  const retry = await deterministicScopeMediaId("job-1", WALKTHROUGH_URL);
  const other = await deterministicScopeMediaId("job-1", PHOTO_URL);
  assertEquals(first, retry);
  assertEquals(first === other, false);
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first),
    true,
  );
  assertEquals(isJobMediaUniqueViolation({ code: "23505" }), true);
  assertEquals(isJobMediaUniqueViolation({ message: "duplicate key value" }), true);
  assertEquals(isJobMediaUniqueViolation({ code: "42501" }), false);
});

Deno.test("a 23505 insert recovers the winner and does not mint a second row", async () => {
  const id = await deterministicScopeMediaId("job-1", WALKTHROUGH_URL);
  const winner = {
    id,
    job_id: "job-1",
    type: "video",
    phase: "scope",
    storage_url: WALKTHROUGH_URL,
    label: TRADE_WALKTHROUGH_LABEL,
  };
  const client = makeExtractClient([winner], {
    hideJobScan: true,
    forceUniqueViolation: true,
  });
  const result = await extractScopeMedia(client, "job-1", {
    scopeMedia: { videoWalkthrough: WALKTHROUGH_URL },
  });
  assertEquals(client.media.filter((m: any) => m.type === "video").length, 1);
  assertEquals(result.videos, 0);
  assertEquals(result.rows[0].id, id);
  assertEquals(result.rows[0].storage_url, WALKTHROUGH_URL);
});

Deno.test("concurrent walkthrough registration converges on one row identity", async () => {
  const client = makeExtractClient([]);
  const scope = { scopeMedia: { videoWalkthrough: WALKTHROUGH_URL } };
  const [first, second] = await Promise.all([
    extractScopeMedia(client, "job-1", scope),
    extractScopeMedia(client, "job-1", scope),
  ]);
  const videos = client.media.filter((m: any) => m.type === "video");
  assertEquals(videos.length, 1);
  const expectedId = await deterministicScopeMediaId("job-1", WALKTHROUGH_URL);
  assertEquals(videos[0].id, expectedId);
  const returnedIds = [...first.rows, ...second.rows].map((r) => r.id);
  assertEquals(new Set(returnedIds).size, 1);
  assertEquals(returnedIds[0], expectedId);
  assertEquals(first.videos + second.videos, 1);
});

Deno.test("a throwing data:video candidate does not block a later playable URL", async () => {
  let uploads = 0;
  const client = makeExtractClient([], {
    throwOnUpload: () => {
      uploads++;
      return true;
    },
  });
  const result = await extractScopeMedia(client, "job-1", {
    scopeMedia: {
      videos: [
        { dataUrl: "data:video/mp4;base64,%%%not-base64%%%", label: "Broken" },
        { url: WALKTHROUGH_URL, label: TRADE_WALKTHROUGH_LABEL },
      ],
    },
  });
  assertEquals(result.videos, 1);
  assertEquals(result.rows[0].storage_url, WALKTHROUGH_URL);
  assertEquals(client.media.filter((m: any) => m.type === "video").length, 1);
  assertEquals(uploads, 0, "invalid data:video is skipped before storage");
});

Deno.test("a storage throw on one dataUrl photo still registers the next photo", async () => {
  const client = makeExtractClient([], {
    throwOnUpload: (path) => path.includes("/scope/0."),
  });
  const result = await extractScopeMedia(client, "job-1", {
    job: {
      scopeMedia: {
        photos: [
          { dataUrl: tinyJpegDataUrl(), label: "Bad first" },
          { url: PHOTO_URL, label: "Front" },
        ],
      },
    },
  });
  assertEquals(result.photos, 1);
  assertEquals(result.rows.map((r) => r.storage_url), [PHOTO_URL]);
  assertEquals(client.media.length, 1);
});
