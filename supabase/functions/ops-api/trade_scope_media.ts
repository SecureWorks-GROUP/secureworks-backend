// Trade-app scope media: collect walkthroughs/photos from both scope_json
// paths, register playable job_media rows, and keep videos on the trade list.
//
// The fencing/patio tools persist walkthroughs under `scopeMedia` OR
// `job.scopeMedia` (`video`, `videoWalkthrough`, `videoFileName`, size) and
// often never write a `job_media` video row. extractScopePhotos used to look
// only at the top-level photo array and abort if any scope photo already
// existed, which left the player dead (SWF-26101 class).
//
// Nice-to-have (out of scope): transcode .mov → mp4 for Safari/iOS playback.

import { filterMediaForCurrentCycle } from "./makesafe_cycle_evidence.ts";

export const TRADE_WALKTHROUGH_LABEL = "Walkthrough";

const HTTP_URL_RE = /^https?:\/\//i;
const VIDEO_TYPE_RE = /video|walkthrough|\.mov$|\.mp4$|\.webm$|\.m4v$/i;

export type ScopePhotoCandidate = {
  label: string;
  dataUrl?: string;
  storageUrl?: string;
};

export type ScopeVideoCandidate = {
  label: string;
  storageUrl?: string;
  dataUrl?: string;
  fileName?: string;
  size?: number;
};

export type ExtractScopeMediaResult = {
  photos: number;
  videos: number;
  rows: any[];
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isHttpMediaUrl(value: unknown): value is string {
  return typeof value === "string" && HTTP_URL_RE.test(value.trim());
}

function firstHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isHttpMediaUrl(value)) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstHttpUrl(
        (value as any).storage_url,
        (value as any).cloudUrl,
        (value as any).url,
        (value as any).publicUrl,
        (value as any).src,
        (value as any).videoWalkthrough,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

function looksLikeVideo(value: unknown): boolean {
  if (typeof value === "string") {
    return isHttpMediaUrl(value) || VIDEO_TYPE_RE.test(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const type = String(row.type || row.contentType || row.mime || "");
  const name = String(
    row.fileName || row.videoFileName || row.name || row.label || "",
  );
  return type.startsWith("video") ||
    VIDEO_TYPE_RE.test(name) ||
    !!(row.videoWalkthrough || row.videoFileName || row.videoSize);
}

function photoFromUnknown(value: unknown, fallbackLabel: string): ScopePhotoCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const dataUrl = typeof row.dataUrl === "string" && row.dataUrl.startsWith("data:")
    ? row.dataUrl
    : undefined;
  const storageUrl = firstHttpUrl(
    row.storage_url,
    row.cloudUrl,
    row.url,
    row.publicUrl,
    row.src,
  );
  if (!dataUrl && !storageUrl) return null;
  if (looksLikeVideo(row)) return null;
  return {
    label: String(row.label || fallbackLabel),
    dataUrl,
    storageUrl,
  };
}

function videoFromUnknown(value: unknown, fallbackLabel: string): ScopeVideoCandidate | null {
  if (typeof value === "string") {
    if (isHttpMediaUrl(value)) {
      return { label: fallbackLabel, storageUrl: value.trim() };
    }
    if (VIDEO_TYPE_RE.test(value)) {
      return { label: fallbackLabel, fileName: value };
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const storageUrl = firstHttpUrl(
    row.storage_url,
    row.cloudUrl,
    row.url,
    row.publicUrl,
    row.src,
    row.videoWalkthrough,
    row.objectUrl,
  );
  const dataUrl = typeof row.dataUrl === "string" &&
      row.dataUrl.startsWith("data:video")
    ? row.dataUrl
    : undefined;
  const fileName = String(
    row.fileName || row.videoFileName || row.videoName || row.name || "",
  ).trim() || undefined;
  const size = Number(row.size ?? row.videoSize ?? row.originalSize);
  if (!storageUrl && !dataUrl && !fileName && !(Number.isFinite(size) && size > 0)) {
    return null;
  }
  if (!storageUrl && !dataUrl && !fileName && !looksLikeVideo(row)) return null;
  return {
    label: String(row.label || fallbackLabel),
    storageUrl,
    dataUrl,
    fileName,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
  };
}

function pushUniquePhoto(out: ScopePhotoCandidate[], photo: ScopePhotoCandidate | null) {
  if (!photo) return;
  const key = photo.storageUrl || photo.dataUrl || photo.label;
  if (out.some((p) => (p.storageUrl || p.dataUrl || p.label) === key)) return;
  out.push(photo);
}

function pushUniqueVideo(out: ScopeVideoCandidate[], video: ScopeVideoCandidate | null) {
  if (!video) return;
  const key = video.storageUrl || video.dataUrl || video.fileName || video.label;
  if (out.some((v) => (v.storageUrl || v.dataUrl || v.fileName || v.label) === key)) {
    return;
  }
  out.push(video);
}

function collectFromMediaBlock(
  block: unknown,
  photos: ScopePhotoCandidate[],
  videos: ScopeVideoCandidate[],
) {
  const media = asObject(block);
  if (!Object.keys(media).length) return;

  const photoList = Array.isArray(media.photos) ? media.photos : [];
  photoList.forEach((row, i) =>
    pushUniquePhoto(photos, photoFromUnknown(row, `Scope photo ${i + 1}`))
  );

  const before = videos.length;
  const videoList = [
    media.video,
    media.videoWalkthrough,
    ...(Array.isArray(media.videos) ? media.videos : []),
  ];
  for (const row of videoList) {
    pushUniqueVideo(videos, videoFromUnknown(row, TRADE_WALKTHROUGH_LABEL));
  }

  // Filename/size sit beside the URL on the same block. Only use them as a
  // fallback when this block has not already produced a video.
  if (
    videos.length === before &&
    (media.videoFileName || media.videoUrl || media.videoWalkthroughUrl || media.videoSize)
  ) {
    pushUniqueVideo(
      videos,
      videoFromUnknown({
        fileName: media.videoFileName,
        url: media.videoUrl || media.videoWalkthroughUrl,
        videoSize: media.videoSize,
        label: media.videoLabel || TRADE_WALKTHROUGH_LABEL,
      }, TRADE_WALKTHROUGH_LABEL),
    );
  }
}

export function collectScopeMedia(scopeJson: unknown): {
  photos: ScopePhotoCandidate[];
  videos: ScopeVideoCandidate[];
} {
  const scope = asObject(scopeJson);
  const job = asObject(scope.job);
  const photos: ScopePhotoCandidate[] = [];
  const videos: ScopeVideoCandidate[] = [];

  collectFromMediaBlock(scope.scopeMedia, photos, videos);
  collectFromMediaBlock(job.scopeMedia, photos, videos);
  collectFromMediaBlock(scope, photos, videos);
  collectFromMediaBlock(job, photos, videos);

  return { photos, videos };
}

export function existingMediaMatchesVideo(
  row: any,
  video: ScopeVideoCandidate,
): boolean {
  if (!row || String(row.type || "").toLowerCase() !== "video") return false;
  const url = String(row.storage_url || "");
  if (video.storageUrl && url === video.storageUrl) return true;
  if (video.fileName && url.toLowerCase().includes(video.fileName.toLowerCase())) {
    return true;
  }
  const label = String(row.label || "");
  if (
    !video.storageUrl &&
    !video.fileName &&
    /walkthrough/i.test(label) &&
    /walkthrough/i.test(video.label)
  ) {
    return true;
  }
  return false;
}

export function isTradeVideoRow(row: any): boolean {
  return String(row?.type || "").toLowerCase() === "video";
}

/**
 * Current-cycle evidence plus every job video. Reattend must not hide the
 * only walkthrough just because it is unbound / prior-cycle scope media.
 */
export function selectTradeJobMedia(
  media: any[] | null | undefined,
  detail: any,
  currentAttendanceCycleId?: string | null,
): any[] {
  const rows = media || [];
  const cycle = filterMediaForCurrentCycle(
    rows,
    detail,
    currentAttendanceCycleId,
  );
  const seen = new Set(
    cycle.map((row) => String(row?.id || row?.storage_url || "")).filter(Boolean),
  );
  const out = [...cycle];
  for (const row of rows) {
    if (!isTradeVideoRow(row)) continue;
    const key = String(row?.id || row?.storage_url || "");
    if (key && seen.has(key)) continue;
    if (!key && out.includes(row)) continue;
    out.push(row);
    if (key) seen.add(key);
  }
  return out;
}

function extFromMimeOrName(mime: string, fileName?: string): string {
  const named = String(fileName || "").split(".").pop()?.toLowerCase();
  if (named && /^[a-z0-9]{2,5}$/.test(named)) return named;
  if (mime.includes("png")) return "png";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
  if (mime.startsWith("video/")) return "mp4";
  return "jpg";
}

/**
 * Same identity coordinate as ghl-proxy `deterministicMediaId` so a walkthrough
 * URL registered here or via register_media is one job_media primary key.
 * Concurrent trade_job_detail reads therefore collide on id (23505) instead of
 * inserting two random UUIDs that response-side dedupe still shows as twins.
 */
export async function deterministicScopeMediaId(
  jobId: string,
  storageUrl: string,
): Promise<string> {
  const input = `${jobId}\n${storageUrl}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function isJobMediaUniqueViolation(error: unknown): boolean {
  const anyErr = error as { code?: string; message?: string; details?: string };
  const msg = String(anyErr?.message || anyErr?.details || error || "");
  return anyErr?.code === "23505" || /duplicate key value|unique constraint/i.test(msg);
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  try {
    const base64 = dataUrl.split(",")[1];
    if (!base64) return null;
    const mimeMatch = dataUrl.match(/data:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0));
    return { mime, bytes };
  } catch {
    return null;
  }
}

async function loadExistingMedia(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("job_media")
    .select("id, type, phase, storage_url, label")
    .eq("job_id", jobId);
  if (error) {
    console.log("[ops-api] scope media existing read failed:", error.message);
    return [];
  }
  return data || [];
}

type RegisterMediaResult = { row: any; created: boolean };

async function resolveUniqueInsertWinner(
  client: any,
  jobId: string,
  row: Record<string, unknown>,
): Promise<any | null> {
  const id = String(row.id || "");
  if (id) {
    const { data, error } = await client.from("job_media")
      .select("id, type, phase, storage_url, label")
      .eq("id", id);
    if (!error) {
      const found = Array.isArray(data) ? data[0] : data;
      if (found) return found;
    }
  }
  const fresh = await loadExistingMedia(client, jobId);
  const url = String(row.storage_url || "");
  return fresh.find((existing) =>
    (id && String(existing?.id || "") === id) ||
    (url && String(existing?.storage_url || "") === url)
  ) || null;
}

async function insertMediaRow(
  client: any,
  jobId: string,
  row: Record<string, unknown>,
): Promise<RegisterMediaResult | null> {
  const { data, error } = await client.from("job_media").insert(row);
  if (error) {
    if (isJobMediaUniqueViolation(error)) {
      const winner = await resolveUniqueInsertWinner(client, jobId, row);
      if (winner) return { row: winner, created: false };
    }
    console.log("[ops-api] scope media insert failed:", error.message);
    return null;
  }
  const created = data && !Array.isArray(data)
    ? data
    : { ...row, ...(data?.[0] || {}) };
  return { row: created, created: true };
}

function rememberExisting(existing: any[], row: any) {
  const id = String(row?.id || "");
  const url = String(row?.storage_url || "");
  if (
    existing.some((seen) =>
      (id && String(seen?.id || "") === id) ||
      (url && String(seen?.storage_url || "") === url)
    )
  ) {
    return;
  }
  existing.push(row);
}

async function registerUrlMedia(
  client: any,
  jobId: string,
  kind: "photo" | "video",
  storageUrl: string,
  label: string,
  existing: any[],
): Promise<RegisterMediaResult | null> {
  if (existing.some((row) => String(row?.storage_url || "") === storageUrl)) {
    return null;
  }
  const id = await deterministicScopeMediaId(jobId, storageUrl);
  const row = {
    id,
    job_id: jobId,
    phase: "scope",
    type: kind,
    storage_url: storageUrl,
    label,
    created_at: new Date().toISOString(),
  };
  const inserted = await insertMediaRow(client, jobId, row);
  if (inserted) rememberExisting(existing, inserted.row);
  return inserted;
}

async function uploadDataUrlMedia(
  client: any,
  jobId: string,
  kind: "photo" | "video",
  dataUrl: string,
  label: string,
  fileName: string | undefined,
  index: number,
  existing: any[],
): Promise<RegisterMediaResult | null> {
  try {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return null;
    const ext = extFromMimeOrName(decoded.mime, fileName);
    const bucket = kind === "video" ? "job-videos" : "job-photos";
    try {
      await client.storage.createBucket(bucket, { public: true });
    } catch {
      /* exists */
    }
    const path = kind === "video"
      ? `${jobId}/scope/walkthrough-${index}.${ext}`
      : `${jobId}/scope/${index}.${ext}`;
    const { error: uploadError } = await client.storage
      .from(bucket)
      .upload(path, decoded.bytes, { contentType: decoded.mime, upsert: true });
    if (uploadError) {
      console.log(
        `[ops-api] scope ${kind} ${index} upload failed:`,
        uploadError.message,
      );
      return null;
    }
    const { data: urlData } = client.storage.from(bucket).getPublicUrl(path);
    const publicUrl = urlData?.publicUrl;
    if (!isHttpMediaUrl(publicUrl)) return null;
    return await registerUrlMedia(client, jobId, kind, publicUrl, label, existing);
  } catch (err: any) {
    console.log(`[ops-api] scope ${kind} ${index} error:`, err?.message);
    return null;
  }
}

/**
 * Extract/register scope photos and videos into job_media.
 * Idempotent at the primary key: the same job+URL always inserts the same
 * id, and a unique-violation recovers the winner instead of minting a twin.
 * A missing walkthrough is still registered even when scope photos already
 * exist. Filename-only metadata without a URL is not turned into a dead
 * player row. One candidate's decode/storage throw does not abort the rest.
 */
export async function extractScopeMedia(
  client: any,
  jobId: string,
  scopeJson: unknown,
): Promise<ExtractScopeMediaResult> {
  const collected = collectScopeMedia(scopeJson);
  if (collected.photos.length === 0 && collected.videos.length === 0) {
    return { photos: 0, videos: 0, rows: [] };
  }

  const existing = await loadExistingMedia(client, jobId);
  const hasScopePhoto = existing.some((row) =>
    String(row?.phase || "") === "scope" &&
    String(row?.type || "photo").toLowerCase() === "photo"
  );
  const rows: any[] = [];
  let photos = 0;
  let videos = 0;

  for (const [i, video] of collected.videos.entries()) {
    try {
      if (existing.some((row) => existingMediaMatchesVideo(row, video))) continue;
      if (video.storageUrl) {
        const inserted = await registerUrlMedia(
          client,
          jobId,
          "video",
          video.storageUrl,
          video.label || TRADE_WALKTHROUGH_LABEL,
          existing,
        );
        if (inserted?.created) videos++;
        if (inserted?.row) rows.push(inserted.row);
        continue;
      }
      if (video.dataUrl) {
        const inserted = await uploadDataUrlMedia(
          client,
          jobId,
          "video",
          video.dataUrl,
          video.label || TRADE_WALKTHROUGH_LABEL,
          video.fileName,
          i,
          existing,
        );
        if (inserted?.created) videos++;
        if (inserted?.row) rows.push(inserted.row);
      }
      // Filename/size-only: no inventing a signed or guessed URL.
    } catch (err: any) {
      console.log(`[ops-api] scope video ${i} error:`, err?.message);
    }
  }

  if (!hasScopePhoto) {
    for (let i = 0; i < collected.photos.length; i++) {
      try {
        const photo = collected.photos[i];
        if (photo.storageUrl) {
          const inserted = await registerUrlMedia(
            client,
            jobId,
            "photo",
            photo.storageUrl,
            photo.label,
            existing,
          );
          if (inserted?.created) photos++;
          if (inserted?.row) rows.push(inserted.row);
          continue;
        }
        if (!photo.dataUrl) continue;
        const inserted = await uploadDataUrlMedia(
          client,
          jobId,
          "photo",
          photo.dataUrl,
          photo.label,
          undefined,
          i,
          existing,
        );
        if (inserted?.created) photos++;
        if (inserted?.row) rows.push(inserted.row);
      } catch (err: any) {
        console.log(`[ops-api] scope photo ${i} error:`, err?.message);
      }
    }
  }

  if (photos || videos) {
    console.log(
      `[ops-api] extracted ${photos} scope photos and ${videos} videos for job ${jobId}`,
    );
  }
  return { photos, videos, rows };
}

/** Back-compat name: still extracts photos, and also missing walkthroughs. */
export async function extractScopePhotos(
  client: any,
  jobId: string,
  scopeJson: unknown,
): Promise<number> {
  const result = await extractScopeMedia(client, jobId, scopeJson);
  return result.photos + result.videos;
}
