// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  collectScopeMedia,
  deterministicScopeMediaId,
  existingMediaMatchesPhoto,
  existingMediaMatchesVideo,
  extractScopeMedia,
  extractScopePhotos,
  isHttpMediaUrl,
  isJobMediaUniqueViolation,
  scopeDataUrlContentId,
  scopeDataUrlIdentityKey,
  scopeDataUrlObjectPath,
  selectTradeJobMedia,
  storageUrlCarriesContentId,
  TRADE_WALKTHROUGH_LABEL,
} from "./trade_scope_media.ts";

const WALKTHROUGH_URL = "https://cdn.example.test/jobs/swf-26101/walkthrough.mp4";
const PHOTO_URL = "https://cdn.example.test/jobs/swf-26101/front.jpg";
const REAR_PHOTO_URL = "https://cdn.example.test/jobs/swf-26101/rear.jpg";

function tinyJpegDataUrl(): string {
  // 1x1 jpeg — enough to prove the upload path without a real image decode.
  return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wgARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGz/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=";
}

function tinyPngDataUrl(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}

function tinyVideoDataUrl(): string {
  return "data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=";
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

Deno.test("isHttpMediaUrl accepts https only", () => {
  assertEquals(isHttpMediaUrl(WALKTHROUGH_URL), true);
  assertEquals(isHttpMediaUrl("http://cdn.example.test/jobs/swf-26101/walkthrough.mp4"), false);
  assertEquals(isHttpMediaUrl("blob:https://local/abc"), false);
  assertEquals(isHttpMediaUrl("data:video/mp4;base64,AAAA"), false);
});

Deno.test("collectScopeMedia ignores http:// video URLs", () => {
  const collected = collectScopeMedia({
    scopeMedia: {
      videoWalkthrough: "http://cdn.example.test/jobs/swf-26101/walkthrough.mp4",
    },
  });
  assertEquals(collected.videos.some((v) => v.storageUrl), false);
});

Deno.test("collectScopeMedia ignores data:video and does not keep a data URL", () => {
  const collected = collectScopeMedia({
    scopeMedia: {
      videos: [{ dataUrl: tinyVideoDataUrl(), label: TRADE_WALKTHROUGH_LABEL }],
    },
  });
  assertEquals(collected.videos, []);
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
    scopeMedia: { photos: [{ url: PHOTO_URL, label: "Front" }] },
  });
  assertEquals(result.videos, 1);
  assertEquals(result.photos, 0, "the already-registered front photo is skipped by URL");
  assertEquals(result.rows[0].type, "video");
  assertEquals(result.rows[0].phase, "scope");
  assertEquals(result.rows[0].label, TRADE_WALKTHROUGH_LABEL);
  assertEquals(result.rows[0].storage_url, WALKTHROUGH_URL);
  assertEquals(client.uploads.length, 0, "public URLs are reused, never re-signed");
});

Deno.test("extractScopeMedia: existing front photo does not skip a missing rear photo", async () => {
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
    scopeMedia: {
      photos: [
        { url: PHOTO_URL, label: "Front" },
        { url: REAR_PHOTO_URL, label: "Rear" },
      ],
    },
  });
  assertEquals(result.photos, 1);
  assertEquals(result.videos, 0);
  assertEquals(client.uploads.length, 0);
  assertEquals(result.rows.map((r) => r.storage_url), [REAR_PHOTO_URL]);
  assertEquals(client.media.filter((m: any) => m.type === "photo").length, 2);
});

Deno.test("extractScopeMedia: existing front photo still uploads a missing dataUrl rear", async () => {
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
    scopeMedia: {
      photos: [
        { url: PHOTO_URL, label: "Front" },
        { dataUrl: tinyJpegDataUrl(), label: "Rear" },
      ],
    },
  });
  assertEquals(result.photos, 1);
  assertEquals(client.uploads.length, 1);
  assertEquals(client.uploads[0].bucket, "job-photos");
  assertEquals(result.rows[0].label, "Rear");
  assertEquals(client.media.filter((m: any) => m.type === "photo").length, 2);
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

Deno.test("existingMediaMatchesPhoto: same https URL only, type defaults to photo", () => {
  const photo = { label: "Front", storageUrl: PHOTO_URL };
  assertEquals(
    existingMediaMatchesPhoto({ type: "photo", storage_url: PHOTO_URL }, photo),
    true,
  );
  assertEquals(
    existingMediaMatchesPhoto({ storage_url: PHOTO_URL }, photo),
    true,
  );
  assertEquals(
    existingMediaMatchesPhoto({ type: "video", storage_url: PHOTO_URL }, photo),
    false,
  );
  assertEquals(
    existingMediaMatchesPhoto({ type: "photo", storage_url: REAR_PHOTO_URL }, photo),
    false,
  );
  assertEquals(
    existingMediaMatchesPhoto({ type: "photo", storage_url: PHOTO_URL }, {
      label: "Rear",
      dataUrl: tinyJpegDataUrl(),
    }),
    false,
  );
});

Deno.test("existingMediaMatchesPhoto: contentId matches a generated digest URL", async () => {
  const dataUrl = tinyJpegDataUrl();
  const contentId = await scopeDataUrlContentId(dataUrl);
  if (!contentId) throw new Error("expected content id");
  const path = scopeDataUrlObjectPath("job-1", "photo", contentId, "jpg");
  const generated = `https://storage.test/job-photos/${path}`;
  assertEquals(storageUrlCarriesContentId(generated, contentId), true);
  assertEquals(storageUrlCarriesContentId(PHOTO_URL, contentId), false);
  assertEquals(
    existingMediaMatchesPhoto(
      { type: "photo", storage_url: generated },
      { label: "Rear", dataUrl, contentId },
    ),
    true,
  );
  assertEquals(
    existingMediaMatchesPhoto(
      { type: "photo", storage_url: PHOTO_URL },
      { label: "Rear", dataUrl, contentId },
    ),
    false,
  );
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
  assertEquals(uploads, 0, "data:video is ignored — never uploaded on read");
});

Deno.test("a storage throw on one dataUrl photo still registers the next photo", async () => {
  const client = makeExtractClient([], {
    throwOnUpload: () => true,
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

Deno.test("data-URL upload path and media id are content-stable, not array-index", async () => {
  const dataUrl = tinyJpegDataUrl();
  const contentId = await scopeDataUrlContentId(dataUrl);
  if (!contentId) throw new Error("expected content id");
  const client = makeExtractClient([]);
  const result = await extractScopeMedia(client, "job-1", {
    scopeMedia: { photos: [{ dataUrl, label: "Rear" }] },
  });
  assertEquals(result.photos, 1);
  assertEquals(client.uploads.length, 1);
  assertEquals(
    client.uploads[0].path,
    scopeDataUrlObjectPath("job-1", "photo", contentId, "jpg"),
  );
  assertEquals(client.uploads[0].path.includes("/scope/0."), false);
  const expectedId = await deterministicScopeMediaId(
    "job-1",
    scopeDataUrlIdentityKey("photo", contentId),
  );
  assertEquals(client.media[0].id, expectedId);
  assertEquals(storageUrlCarriesContentId(client.media[0].storage_url, contentId), true);
});

Deno.test("reordering data-URL photos does not mint a second row for the same bytes", async () => {
  const rear = tinyJpegDataUrl();
  const front = tinyPngDataUrl();
  const client = makeExtractClient([]);
  const first = await extractScopeMedia(client, "job-1", {
    scopeMedia: { photos: [{ dataUrl: rear, label: "Rear" }] },
  });
  assertEquals(first.photos, 1);
  const reordered = await extractScopeMedia(client, "job-1", {
    scopeMedia: {
      photos: [
        { dataUrl: front, label: "Front" },
        { dataUrl: rear, label: "Rear" },
      ],
    },
  });
  assertEquals(reordered.photos, 1, "only the newly inserted front photo registers");
  assertEquals(client.media.filter((m: any) => m.type === "photo").length, 2);
  const rearAgain = await extractScopeMedia(client, "job-1", {
    scopeMedia: {
      photos: [
        { dataUrl: front, label: "Front" },
        { dataUrl: rear, label: "Rear" },
      ],
    },
  });
  assertEquals(rearAgain.photos, 0);
  assertEquals(client.media.filter((m: any) => m.type === "photo").length, 2);
  assertEquals(client.uploads.length, 2);
});

Deno.test("data:video on trade_job_detail read is ignored — no upload, no invented URL", async () => {
  const dataUrl = tinyVideoDataUrl();
  const client = makeExtractClient([]);
  const first = await extractScopeMedia(client, "job-1", {
    scopeMedia: { videos: [{ dataUrl, label: TRADE_WALKTHROUGH_LABEL }] },
  });
  assertEquals(first.videos, 0);
  assertEquals(first.rows, []);
  assertEquals(client.uploads.length, 0);
  assertEquals(client.media.filter((m: any) => m.type === "video").length, 0);
  const withHttps = await extractScopeMedia(client, "job-1", {
    scopeMedia: {
      videos: [
        { url: WALKTHROUGH_URL, label: TRADE_WALKTHROUGH_LABEL },
        { dataUrl, label: "Ignored" },
      ],
    },
  });
  assertEquals(withHttps.videos, 1, "only the existing https walkthrough registers");
  assertEquals(client.media.filter((m: any) => m.type === "video").length, 1);
  assertEquals(client.uploads.length, 0);
});

Deno.test("extractScopeMedia does not register an http:// walkthrough", async () => {
  const client = makeExtractClient([]);
  const result = await extractScopeMedia(client, "job-1", {
    scopeMedia: {
      videoWalkthrough: "http://cdn.example.test/jobs/swf-26101/walkthrough.mp4",
    },
  });
  assertEquals(result.videos, 0);
  assertEquals(result.rows, []);
  assertEquals(client.media.length, 0);
});
