#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * Read-only measurement: photo-pack attachment count and total bytes per SES
 * card that holds completion_photo docket artifacts.
 *
 * Production safety:
 * - Supabase Management API `/database/query` with `read_only: true` only
 * - refuses non-SELECT and PII columns before the request is sent
 * - no writes, no sends, no prepare
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read --allow-write \
 *     scripts/ses-photo-mail-volume-measure.ts
 *
 * Emits JSON to stdout and optionally writes
 * docs/evidence/ses-photo-mail-volume-measure-<date>.json when --write is set.
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const WRITE_VERBS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment on",
  "copy",
  "call",
  "do ",
  "vacuum",
  "refresh materialized",
];

const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_phone",
  "contact_email",
];

// Documented ceilings (same constants as the runtime guard).
const MESSAGE_LIMIT = 35 * 1024 * 1024;
const GROUP_PER_FILE = 3 * 1024 * 1024;

function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error(`refused non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused statement naming write verb "${verb}"`);
    }
  }
}

function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refused statement naming PII column "${column}"`);
    }
  }
}

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-ses-photo-mail-volume-measure/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as { message?: string }).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

async function main() {
  // Per current docket revision: count and sum of completion_photo artifacts.
  // "Verified photo pack" ≈ physical docket with completion_photo rows on the
  // current revision. No client-identifying columns.
  const rows = await query<{
    job_number: string;
    job_id: string;
    builder_key: string | null;
    family: string | null;
    photo_count: number;
    total_raw_bytes: number;
    max_photo_bytes: number;
  }>(`
    WITH current_dockets AS (
      SELECT DISTINCT ON (r.job_id)
        r.id AS docket_revision_id,
        r.job_id,
        r.envelope
      FROM makesafe_docket_revisions r
      WHERE r.job_id IS NOT NULL
      ORDER BY r.job_id, r.committed_at DESC NULLS LAST, r.id DESC
    ),
    photo_stats AS (
      SELECT
        a.revision_id AS docket_revision_id,
        count(*)::int AS photo_count,
        coalesce(sum(a.size_bytes), 0)::bigint AS total_raw_bytes,
        coalesce(max(a.size_bytes), 0)::bigint AS max_photo_bytes
      FROM makesafe_docket_artifacts a
      WHERE a.role = 'completion_photo'
        AND a.size_bytes IS NOT NULL
        AND a.size_bytes > 0
      GROUP BY a.revision_id
    )
    SELECT
      j.job_number,
      j.id AS job_id,
      coalesce(
        d.envelope #>> '{v2,classification,builder_key}',
        d.envelope #>> '{spine,builder_key}',
        j.requesting_company_slug
      ) AS builder_key,
      d.envelope #>> '{v2,classification,family}' AS family,
      p.photo_count,
      p.total_raw_bytes,
      p.max_photo_bytes
    FROM photo_stats p
    JOIN current_dockets d ON d.docket_revision_id = p.docket_revision_id
    JOIN jobs j ON j.id = d.job_id
    WHERE j.status IS DISTINCT FROM 'cancelled'
      AND coalesce(j.status, '') IS DISTINCT FROM 'lost'
    ORDER BY p.total_raw_bytes DESC
  `);

  const totals = rows.map((r) => Number(r.total_raw_bytes) || 0).sort((a, b) =>
    a - b
  );
  const counts = rows.map((r) => Number(r.photo_count) || 0).sort((a, b) =>
    a - b
  );
  const overMessage = rows.filter((r) =>
    Number(r.total_raw_bytes) > MESSAGE_LIMIT
  );
  const overGroupPerFile = rows.filter((r) =>
    Number(r.max_photo_bytes) >= GROUP_PER_FILE
  );
  // AJS user-mailbox path: raw total vs 35 MiB. Group path also base64-expands.
  const overBase64Message = rows.filter((r) => {
    const raw = Number(r.total_raw_bytes) || 0;
    const b64 = Math.ceil(raw / 3) * 4;
    return b64 > MESSAGE_LIMIT;
  });

  const report = {
    measured_at: new Date().toISOString(),
    population:
      "current makesafe_docket_revisions with completion_photo artifacts; non-cancelled/lost jobs",
    card_count: rows.length,
    graph_ceilings: {
      message_size_limit_bytes: MESSAGE_LIMIT,
      group_post_per_attachment_bytes: GROUP_PER_FILE,
      sources: [
        "https://learn.microsoft.com/en-us/graph/api/attachment-createuploadsession",
        "https://learn.microsoft.com/en-us/graph/api/post-post-attachments",
        "https://learn.microsoft.com/en-us/graph/api/resources/attachment",
      ],
    },
    distribution: {
      photo_count: {
        min: counts[0] ?? null,
        p50: percentile(counts, 50),
        p90: percentile(counts, 90),
        p99: percentile(counts, 99),
        max: counts[counts.length - 1] ?? null,
      },
      total_raw_bytes: {
        min: totals[0] ?? null,
        p50: percentile(totals, 50),
        p90: percentile(totals, 90),
        p99: percentile(totals, 99),
        max: totals[totals.length - 1] ?? null,
      },
      cards_over_35mib_raw: overMessage.length,
      cards_over_35mib_base64_estimate: overBase64Message.length,
      cards_with_any_photo_at_or_over_3mib: overGroupPerFile.length,
    },
    heaviest_10: rows.slice(0, 10).map((r) => ({
      job_number: r.job_number,
      builder_key: r.builder_key,
      family: r.family,
      photo_count: Number(r.photo_count),
      total_raw_bytes: Number(r.total_raw_bytes),
      total_raw_mib: Number(
        (Number(r.total_raw_bytes) / (1024 * 1024)).toFixed(2),
      ),
      max_photo_bytes: Number(r.max_photo_bytes),
      exceeds_35mib_raw: Number(r.total_raw_bytes) > MESSAGE_LIMIT,
      exceeds_35mib_base64: Math.ceil(Number(r.total_raw_bytes) / 3) * 4 >
        MESSAGE_LIMIT,
      max_photo_over_3mib_group_limit:
        Number(r.max_photo_bytes) > GROUP_PER_FILE,
    })),
    prior_board_volume_pins_from_agents_md: {
      note:
        "Pinned in Agents.md / makesafe_report_photo_budget_test.ts from an earlier storage.objects metadata read; re-prove with this script when token works.",
      heaviest: [
        { photos: 51, mib: 33.5 },
        { photos: 69, mib: 27.9 },
        { photos: 50, mib: 20.9 },
      ],
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (Deno.args.includes("--write")) {
    const day = new Date().toISOString().slice(0, 10);
    const path =
      `docs/evidence/ses-photo-mail-volume-measure-${day}.json`;
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
    console.error(`wrote ${path}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err?.stack || err));
    Deno.exit(1);
  });
}
