#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * Bind-time renderer validity: blast radius, and the proof that it recovers the
 * right cards without opening the fence.
 *
 * The 2026-08-07 re-pin (repo 0caad8fe, #649) moved the authoritative renderer
 * constants. Both readers of a curated bind's renderer stamp compared it against
 * the CURRENT constants, so every bind made under the previous pin turned
 * untrusted at the instant the new build went live — `curated_source_missing` on
 * cards whose binds never changed. The register in
 * `makesafe_report_renderer_authority.ts` replaces that with bind-time validity.
 *
 * It REIMPLEMENTS NOTHING. The verdict per card comes from the shipped
 * predicate `makesafeRendererStampAuthorisedAtBind`, fed the card's real stored
 * stamp and its real bind instant. A second, cruder copy of "was this renderer
 * authorised" is exactly the defect this change exists to remove.
 *
 * Modes:
 *   --mode=derive   (default) read live rows read-only and run the WORKING TREE
 *                   predicate over them. Answers "which cards change verdict,
 *                   and does any card fail to recover". Valid before deploy.
 *   --mode=served   ask the DEPLOYED ops-api (`query_ses_review_cockpit`, a
 *                   read) whether each card's supporting report is still
 *                   refused. Post-deploy proof. Needs SW_SUPABASE_URL/SW_API_KEY.
 *
 * Production safety:
 * - the only database access is the Management API `/database/query` with
 *   `read_only: true`, so the database itself refuses a write;
 * - `assertReadOnlySql` refuses any non-SELECT/WITH statement before it is sent;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column. Nothing here selects a name, phone, email or street address;
 * - `--mode=served` calls one READ action and nothing else.
 *
 * NO write, NO re-bind, NO mint, NO approve, NO send, NO stage move.
 *
 * Exit code is non-zero when a card that should recover does not, or when a card
 * becomes trusted whose bind instant falls outside its identity's window.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run -A \
 *     scripts/ses-renderer-bind-time-validity-verify.ts
 *   SUPABASE_ACCESS_TOKEN=... SW_SUPABASE_URL=... SW_API_KEY=... deno run -A \
 *     scripts/ses-renderer-bind-time-validity-verify.ts --mode=served
 */

import {
  MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER,
  makesafeCurrentRendererAuthorityEntry,
  makesafeRendererAuthorityEntryForStamp,
  makesafeRendererStampAuthorisedAtBind,
} from "../supabase/functions/ops-api/makesafe_report_renderer_authority.ts";

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
  "refresh materialized",
  "do $$",
];

const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_name",
  "contact_phone",
  "contact_email",
  "policyholder",
];

function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!normalized.startsWith("select") && !normalized.startsWith("with")) {
    throw new Error("refusing a statement that is not a SELECT/WITH");
  }
  for (const verb of WRITE_VERBS) {
    // Single-word verbs match on word boundaries, so `create table` is refused
    // while the COLUMN `created_at` is not. A plain substring test refuses the
    // bind instant this whole measurement is about, and the tempting fix -
    // dropping the verb from the list - is the one that actually weakens the
    // guard. Multi-word verbs stay substring tests.
    const hit = /^[a-z]+$/.test(verb)
      ? new RegExp(`\\b${verb}\\b`).test(normalized)
      : normalized.includes(verb);
    if (hit) {
      throw new Error(`refusing a statement naming the write verb '${verb}'`);
    }
  }
}

function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refusing a statement naming '${column}'`);
    }
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-Renderer-Bind-Time-Validity/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as any).message)
        : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

/**
 * Every curated make-safe report bind on the estate, with the stamp it carries
 * and the instant its NEWEST bind event was written. The event is the only
 * record of when a stamp was made: `job_documents` has no update timestamp, and
 * `created_at` is document creation, which precedes the bind.
 */
const BINDS_SQL = `
select
  j.job_number,
  d.id::text                                                as document_id,
  d.data_snapshot_json->>'report_renderer_version'          as stamp_version,
  d.data_snapshot_json->>'report_renderer_source_revision'  as stamp_revision,
  d.data_snapshot_json->>'report_renderer_script_sha256'    as stamp_sha256,
  (d.data_snapshot_json->>'curated_source_identity' is not null) as is_curated_bind,
  d.cycle_attribution,
  (d.attendance_cycle_id = md.attendance_cycle_id)          as on_current_cycle,
  (
    select max(e.created_at)::text
    from job_events e
    where e.job_id = d.job_id
      and e.event_type = 'ses_curated_report_source_bind_validated'
      and e.detail_json->>'document_id' = d.id::text
  )                                                         as bound_at
from job_documents d
join jobs j on j.id = d.job_id
left join makesafe_job_details md on md.job_id = d.job_id
where d.type = 'makesafe_report'
  and d.data_snapshot_json->>'report_renderer_script_sha256' is not null
order by 1
`;

interface BindRow {
  job_number: string;
  document_id: string;
  stamp_version: string | null;
  stamp_revision: string | null;
  stamp_sha256: string | null;
  /** A durable curated bind at all, as opposed to a bare renderer stamp. */
  is_curated_bind: boolean | null;
  cycle_attribution: string | null;
  on_current_cycle: boolean | null;
  bound_at: string | null;
}

/** The question the two call sites asked BEFORE this change: is it today's pin? */
function trustedUnderCurrentPinOnly(row: BindRow): boolean {
  const current = makesafeCurrentRendererAuthorityEntry();
  return row.stamp_revision === current.source_revision &&
    row.stamp_sha256 === current.script_sha256;
}

async function derive(): Promise<number> {
  const rows = await query<BindRow>(BINDS_SQL);
  const recovered: BindRow[] = [];
  const unchangedTrusted: BindRow[] = [];
  const stillRefused: BindRow[] = [];
  let newlyRefused = 0;

  for (const row of rows) {
    const stamp = {
      version: row.stamp_version,
      source_revision: row.stamp_revision,
      script_sha256: row.stamp_sha256,
    };
    const before = trustedUnderCurrentPinOnly(row);
    const after = makesafeRendererStampAuthorisedAtBind(stamp, row.bound_at);
    if (after && !before) recovered.push(row);
    else if (after && before) unchangedTrusted.push(row);
    else if (!after) {
      stillRefused.push(row);
      if (before) newlyRefused += 1;
    }
  }

  console.log("register:");
  for (const entry of MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER) {
    console.log(
      `  ${entry.script_sha256.slice(0, 12)}  ${entry.authorised_from} -> ${
        entry.authorised_until ?? "(open)"
      }`,
    );
  }
  console.log(`\ncurated binds on the estate: ${rows.length}`);
  console.log(
    `  trusted before and after (current pin): ${unchangedTrusted.length}`,
  );
  console.log(`  RECOVERED by bind-time validity:        ${recovered.length}`);
  console.log(
    `  still refused:                          ${stillRefused.length}`,
  );
  console.log(`  newly refused (must be 0):              ${newlyRefused}`);
  const cardsRecovered = new Set(recovered.map((row) => row.job_number));
  const cardsStuck = new Set(
    stillRefused.filter((row) => !cardsRecovered.has(row.job_number))
      .map((row) => row.job_number),
  );
  console.log(
    `  CARDS recovered:                        ${cardsRecovered.size}`,
  );
  console.log(`  cards with no recovering bind:          ${cardsStuck.size}\n`);

  for (const row of recovered) {
    const entry = makesafeRendererAuthorityEntryForStamp({
      version: row.stamp_version,
      source_revision: row.stamp_revision,
      script_sha256: row.stamp_sha256,
    });
    console.log(
      `  recovered ${row.job_number.padEnd(14)} bound ${row.bound_at} ` +
        `under ${entry?.script_sha256.slice(0, 12)} ` +
        `(current cycle: ${row.on_current_cycle === true})`,
    );
  }
  // A row that does not recover under bind-time validity has a problem BEYOND
  // this regression. Name it, with the reason, rather than papering over it -
  // and separate "this card is broken" from "this card carries a second
  // document that was never a curated bind and is refused for its own reason".
  for (const row of stillRefused) {
    const alsoRecovered = recovered.some((other) =>
      other.job_number === row.job_number
    );
    const why = row.is_curated_bind !== true
      ? "not a curated bind at all (no curated_source_identity): refused before the re-pin too, for its own reason"
      : row.bound_at
      ? "curated bind whose instant falls outside every register window"
      : "curated bind with no bind event, so no instant can be proved";
    console.log(
      `  STILL REFUSED ${row.job_number} doc ${
        row.document_id.slice(0, 8)
      }: ${why}` +
        (alsoRecovered
          ? " - the card's OWN curated bind recovered separately"
          : " - THIS CARD DOES NOT RECOVER"),
    );
  }

  // The fence, re-proved against live data rather than only in unit tests: no
  // recovered card may have a bind instant outside its own identity's window.
  let fenceBreaches = 0;
  for (const row of recovered) {
    const entry = makesafeRendererAuthorityEntryForStamp({
      version: row.stamp_version,
      source_revision: row.stamp_revision,
      script_sha256: row.stamp_sha256,
    });
    if (!entry || entry.authorised_until === null || !row.bound_at) {
      fenceBreaches += 1;
      continue;
    }
    const bound = Date.parse(row.bound_at);
    if (
      !(bound >= Date.parse(entry.authorised_from) &&
        bound < Date.parse(entry.authorised_until))
    ) fenceBreaches += 1;
  }
  console.log(
    `\nfence breaches among recovered cards (must be 0): ${fenceBreaches}`,
  );

  return (newlyRefused === 0 && fenceBreaches === 0) ? 0 : 1;
}

const SERVED_CARDS = [
  "SWMS-261157",
  "SWMS-261140",
  "SWMS-261161",
  "SWMS-261156",
];

/**
 * Ask the DEPLOYED backend, per card, whether it can still prove a curated
 * report source.
 *
 * The probe is `prepare_ses_docket_revision` with `dry_run: true`, and it has to
 * be: the affected cards have NO current docket revision (that is the symptom -
 * prepare refuses `curated_source_missing`), so the cockpit read has nothing to
 * answer about and returns 409 "No current SES docket revision exists". A dry
 * run guards `deps.persist`, so it writes no revision, no artifact, no money and
 * no state; it mints, approves, authorises and sends nothing.
 *
 * The verdict is the presence of a `curated_source_missing` /
 * `curated_source_drift` blocker, NOT overall readiness: these cards may still
 * be held for unrelated reasons (pricing, SWMS facts, routing) and that is not
 * this change's business.
 */
async function served(): Promise<number> {
  const base = requiredEnv("SW_SUPABASE_URL").replace(/\/+$/, "");
  const key = requiredEnv("SW_API_KEY");
  let failures = 0;
  for (const jobNumber of SERVED_CARDS) {
    const response = await fetch(
      `${base}/functions/v1/ops-api?action=prepare_ses_docket_revision`,
      {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          dry_run: true,
          idempotency_key: `renderer-bind-time-validity-verify:${jobNumber}`,
          selection: { mode: "job_number", job_number: jobNumber },
        }),
      },
    );
    const payload = await response.json().catch(() => null);
    const text = JSON.stringify(payload ?? {});
    const curatedRefused = text.includes("curated_source_missing") ||
      text.includes("curated_source_drift") ||
      text.includes("active_renderer_input_binding_missing");
    console.log(
      `${jobNumber.padEnd(14)} HTTP ${response.status}  ` +
        `curated source refused: ${curatedRefused}`,
    );
    if (response.status !== 200 || curatedRefused) failures += 1;
  }
  console.log(
    `\ncards still refusing a curated source (must be 0): ${failures}`,
  );
  return failures === 0 ? 0 : 1;
}

const mode = Deno.args.find((arg) => arg.startsWith("--mode="))?.slice(7) ||
  "derive";
if (mode !== "derive" && mode !== "served") {
  console.error("--mode must be 'derive' or 'served'");
  Deno.exit(2);
}
Deno.exit(mode === "derive" ? await derive() : await served());
