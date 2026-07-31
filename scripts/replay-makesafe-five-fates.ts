#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// SES Reporting U1 production replay harness.
//
// Safety contract: production access is GET/HEAD only. The harness rejects every
// other HTTP method before fetch, runs the pure deterministic planner, joins the
// existing durable ledger, and writes a PII-free local evidence report.

import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  type DeterministicAttachment,
  type DeterministicCompanyProfile,
  type DeterministicLink,
  type DeterministicSourceItem,
} from "../supabase/functions/ops-api/makesafe_deterministic_intake.ts";
import { enrichSourcesWithPdfText } from "../supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts";
import {
  buildFiveFatesReplayReport,
  type DurableCaseRow,
  type DurableCaseSourceRow,
  type DurableJobRow,
  type DurableSourceExceptionRow,
  type HistoricalShapeInput,
  type HugoBoardObservation,
  type IndependentShapeExpectation,
  structuralHash,
} from "../supabase/functions/ops-api/makesafe_intake_five_fates_replay.ts";
import {
  deriveFromDomain,
  isOwnDomain,
} from "../supabase/functions/ops-api/makesafe_compact_reads.ts";
import { stripEmailHtmlForTrade } from "../supabase/functions/ops-api/makesafe_email_links.ts";
import {
  MAKESAFE_BOARD_CONTRACT_VERSION,
  projectTradeMakesafeBoard,
} from "../supabase/functions/ops-api/makesafe_board_read_model.ts";

const MAILBOX = "ses@secureworkswa.com.au";
const PAGE_SIZE = 500;
const IN_FILTER_CHUNK = 25;

type JsonRow = Record<string, unknown>;

const COMMON_CORRECTED_FIELDS = {
  client_name: {
    regex:
      "(?:client|insured|customer|home\\s*owner|homeowner|owner)\\s*(?:name)?\\s*[:\\-]\\s*([A-Za-z][A-Za-z'\\-\\. ]{1,60})",
    source: "all" as const,
    group: 1,
    transform: "collapse_ws" as const,
  },
  client_phone: {
    regex:
      "(?:phone|mobile|contact|ph|tel)\\s*(?:no\\.?|number)?\\s*[:\\-]\\s*(\\+?[0-9][0-9 ()\\-]{6,})",
    source: "all" as const,
    group: 1,
    transform: "collapse_ws" as const,
  },
  site_address: {
    regex:
      "(?:site\\s*address|risk\\s*address|property\\s*address|address|property|site)\\s*[:\\-]\\s*([0-9][^\\n\\r]{4,80})",
    source: "all" as const,
    group: 1,
    transform: "collapse_ws" as const,
  },
};

function applyPendingCompanyRuleCorrection(
  profiles: readonly DeterministicCompanyProfile[],
): DeterministicCompanyProfile[] {
  const externalRefBySlug: Record<string, string> = {
    aj:
      "\\b((?:AJBR|AJS)[-\\s]?\\d{3,8}|Job\\s*No\\.?\\s*[:#-]?\\s*\\d{3,8})\\b",
    bw: "\\b((?:BWCWA|BWC|BW)[-\\s]?\\d{3,8})\\b",
    wb: "\\b(WB[-\\s]?\\d{3,8})\\b",
  };
  return profiles.map((profile) => {
    if (profile.parsingRules?.fields || !externalRefBySlug[profile.slug]) {
      return profile;
    }
    return {
      ...profile,
      parsingRules: {
        version: 2,
        template_first: false,
        confidence: "high",
        required: ["external_ref", "client_name", "site_address"],
        fields: {
          ...COMMON_CORRECTED_FIELDS,
          external_ref: {
            regex: externalRefBySlug[profile.slug],
            source: "all",
            group: 1,
            transform: "upper",
          },
        },
      },
    };
  });
}

export function assertReadOnlyRequest(init: RequestInit = {}): void {
  const method = String(init.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(
      `five-fates replay forbids production mutation method ${method}`,
    );
  }
}

async function readOnlyFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const requestMethod = init.method ||
    (input instanceof Request ? input.method : "GET");
  assertReadOnlyRequest({ ...init, method: requestMethod });
  return await fetch(input, { ...init, method: requestMethod || "GET" });
}

function option(name: string, fallback?: string): string | undefined {
  const equals = Deno.args.find((item) => item.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : fallback;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

function chunks<T>(values: readonly T[], size = IN_FILTER_CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function postgrestIn(values: readonly string[]): string {
  const escaped = values.map((value) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  );
  return `in.(${escaped.join(",")})`;
}

function linksFromBody(postId: string, body: string): DeterministicLink[] {
  const result = new Map<string, DeterministicLink>();
  for (const match of body.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0].replace(/[),.;]+$/g, "");
    result.set(url, { url, sourcePostId: postId });
  }
  return [...result.values()];
}

function headers(key: string): HeadersInit {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

async function restPage(input: {
  baseUrl: string;
  key: string;
  table: string;
  params: Readonly<Record<string, string>>;
}): Promise<JsonRow[]> {
  const url = new URL(`${input.baseUrl}/rest/v1/${input.table}`);
  for (const [name, value] of Object.entries(input.params)) {
    url.searchParams.set(name, value);
  }
  const response = await readOnlyFetch(url, { headers: headers(input.key) });
  if (!response.ok) {
    throw new Error(
      `read-only ${input.table} query failed (${response.status}): ${await response
        .text()}`,
    );
  }
  return await response.json();
}

async function restAll(input: {
  baseUrl: string;
  key: string;
  table: string;
  params: Readonly<Record<string, string>>;
  maxRows?: number;
}): Promise<JsonRow[]> {
  const output: JsonRow[] = [];
  const maximum = input.maxRows ?? Number.POSITIVE_INFINITY;
  for (let offset = 0; output.length < maximum; offset += PAGE_SIZE) {
    const rows = await restPage({
      ...input,
      params: {
        ...input.params,
        limit: String(Math.min(PAGE_SIZE, maximum - output.length)),
        offset: String(offset),
      },
    });
    output.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return output;
}

async function rowsForValues(input: {
  baseUrl: string;
  key: string;
  table: string;
  select: string;
  column: string;
  values: readonly string[];
}): Promise<JsonRow[]> {
  const output: JsonRow[] = [];
  for (const group of chunks([...new Set(input.values)])) {
    if (!group.length) continue;
    output.push(
      ...await restAll({
        baseUrl: input.baseUrl,
        key: input.key,
        table: input.table,
        params: {
          select: input.select,
          [input.column]: postgrestIn(group),
        },
      }),
    );
  }
  return output;
}

function attachmentFromRow(row: JsonRow): DeterministicAttachment {
  return {
    id: String(row.id),
    sourcePostId: String(row.email_id),
    name: typeof row.name === "string" ? row.name : null,
    contentType: typeof row.content_type === "string" ? row.content_type : null,
    storagePath: typeof row.storage_path === "string" ? row.storage_path : null,
    status: typeof row.status === "string" ? row.status : null,
    sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : null,
    sha256: typeof row.sha256 === "string" ? row.sha256 : null,
    pdfExtractionStatus: typeof row.pdf_extraction_status === "string"
      ? row.pdf_extraction_status
      : null,
    pdfExtractionText: typeof row.pdf_extraction_text === "string"
      ? row.pdf_extraction_text
      : null,
    pdfExtractionCharCount: typeof row.pdf_extraction_char_count === "number"
      ? row.pdf_extraction_char_count
      : null,
    pdfExtractionPageCount: typeof row.pdf_extraction_page_count === "number"
      ? row.pdf_extraction_page_count
      : null,
    pdfExtractionExtractor: typeof row.pdf_extraction_extractor === "string"
      ? row.pdf_extraction_extractor
      : null,
    pdfExtractionTruncated: row.pdf_extraction_truncated === true,
    pdfExtractionReason: typeof row.pdf_extraction_reason === "string"
      ? row.pdf_extraction_reason
      : null,
  };
}

function storageObjectUrl(baseUrl: string, bucket: string, path: string): URL {
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `${baseUrl}/storage/v1/object/authenticated/${
      encodeURIComponent(bucket)
    }/${safePath}`,
  );
}

async function observeHugoBoard(input: {
  baseUrl: string;
  key: string;
}): Promise<HugoBoardObservation> {
  const profiles = await restAll({
    baseUrl: input.baseUrl,
    key: input.key,
    table: "users",
    params: {
      select: "id,name,role,managed_verticals",
      name: "ilike.Hugo",
    },
  });
  if (profiles.length !== 1) {
    throw new Error(`Hugo profile read resolved ${profiles.length} rows`);
  }
  const profile = profiles[0];
  const supabaseModuleUrl = "https://esm.sh/@supabase/supabase-js@2";
  const supabaseModule = await import(supabaseModuleUrl);
  const client = supabaseModule.createClient(input.baseUrl, input.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });
  // The function is already a test-only export used by board parity tests. A
  // variable dynamic import avoids making this standalone proof inherit the
  // monolithic ops-api index's unrelated typecheck debt.
  const opsModuleUrl = new URL(
    "../supabase/functions/ops-api/index.ts",
    import.meta.url,
  ).href;
  const opsModule = await import(opsModuleUrl);
  const canonicalRows = await opsModule._loadCanonicalMakesafeBoardForTest(
    client,
  );
  const viewer = {
    userId: String(profile.id),
    role: String(profile.role || ""),
    managedVerticals: Array.isArray(profile.managed_verticals)
      ? profile.managed_verticals.map(String)
      : [],
  };
  const projection = projectTradeMakesafeBoard(canonicalRows, viewer);
  if (
    !projection.permissions.sees_all_makesafes ||
    !projection.permissions.can_allocate
  ) {
    throw new Error(
      "production Hugo profile lacks all-makesafe board authority",
    );
  }
  return {
    observed_at: new Date().toISOString(),
    method: "shared_server_read_model_with_production_hugo_profile",
    contract_version: MAKESAFE_BOARD_CONTRACT_VERSION,
    viewer_profile_hash: structuralHash(String(profile.id)),
    visible_job_ids: projection.rows.map((row: { id?: unknown }) =>
      String(row.id || "")
    ).filter(Boolean),
    permissions: {
      sees_all_makesafes: projection.permissions.sees_all_makesafes,
      can_allocate: projection.permissions.can_allocate,
    },
  };
}

async function run(): Promise<void> {
  const baseUrl = requiredEnv("SUPABASE_URL");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const days = Math.max(1, Math.min(365, Number(option("--days", "180"))));
  const maxSources = Math.max(
    1,
    Math.min(5000, Number(option("--max-sources", "2000"))),
  );
  const outputPath = option(
    "--output",
    "docs/evidence/ses-reporting-u1-five-fates-replay.json",
  )!;
  const cataloguePath = option(
    "--catalogue",
    "docs/evidence/ses-reporting-u1-independent-shape-catalogue.json",
  )!;
  const catalogue = JSON.parse(await Deno.readTextFile(cataloguePath)) as {
    shapes: IndependentShapeExpectation[];
  };
  if (!Array.isArray(catalogue.shapes) || catalogue.shapes.length !== 36) {
    throw new Error(
      "independent corpus catalogue must contain exactly 36 shapes",
    );
  }
  const allowedFates = new Set([
    "live_job",
    "blocked_live_job",
    "reason_coded_exception",
    "revision_or_reattendance",
    "accounted_non_work",
  ]);
  const shapeIds = new Set(catalogue.shapes.map((item) => item.shape_id));
  if (
    shapeIds.size !== 36 ||
    catalogue.shapes.some((item) => !allowedFates.has(item.expected_fate))
  ) {
    throw new Error(
      "each independent corpus shape must have one unique id and exactly one valid expected fate",
    );
  }
  const nowIso = option("--now", new Date().toISOString())!;
  const since = new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();

  const emailRows = await restAll({
    baseUrl,
    key,
    table: "emails",
    params: {
      select:
        "post_id,internet_message_id,conversation_id,thread_id,subject,body_content,body_preview,from_email,from_name,received_at",
      mailbox: `eq.${MAILBOX}`,
      received_at: `gte.${since}`,
      order: "received_at.asc,post_id.asc",
    },
    maxRows: maxSources,
  });
  const postIds = emailRows.map((row) => String(row.post_id));

  const [
    attachmentRows,
    companyRows,
    caseSourceRows,
    sourceExceptionRows,
  ] = await Promise.all([
    rowsForValues({
      baseUrl,
      key,
      table: "email_attachments",
      select:
        "id,email_id,name,content_type,storage_path,status,size_bytes,sha256,pdf_extraction_status,pdf_extraction_text,pdf_extraction_char_count,pdf_extraction_page_count,pdf_extraction_extractor,pdf_extraction_truncated,pdf_extraction_reason",
      column: "email_id",
      values: postIds,
    }),
    restAll({
      baseUrl,
      key,
      table: "makesafe_companies",
      params: {
        select: "id,slug,name,sender_patterns,parsing_rules",
        active: "eq.true",
      },
    }),
    rowsForValues({
      baseUrl,
      key,
      table: "makesafe_intake_case_sources",
      select: "post_id,case_id,created_at,received_at",
      column: "post_id",
      values: postIds,
    }),
    restAll({
      baseUrl,
      key,
      table: "email_events_raw",
      params: {
        select: "post_id,change_type,exclusion_reason,observed_at",
        mailbox: `eq.${MAILBOX}`,
        change_type: "like.intake_exception_%",
      },
    }),
  ]);

  const attachmentsByPost = new Map<string, DeterministicAttachment[]>();
  for (const row of attachmentRows) {
    const item = attachmentFromRow(row);
    attachmentsByPost.set(item.sourcePostId, [
      ...(attachmentsByPost.get(item.sourcePostId) || []),
      item,
    ]);
  }
  const liveProfiles: DeterministicCompanyProfile[] = companyRows.map((
    row,
  ) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    senderPatterns: Array.isArray(row.sender_patterns)
      ? row.sender_patterns.map(String)
      : [],
    parsingRules: row.parsing_rules && typeof row.parsing_rules === "object"
      ? row.parsing_rules as DeterministicCompanyProfile["parsingRules"]
      : null,
  }));
  const profiles = applyPendingCompanyRuleCorrection(liveProfiles);

  const rawBodyByPost = new Map<string, string>();
  const baseSources: DeterministicSourceItem[] = emailRows.map((row) => {
    const postId = String(row.post_id);
    const rawBody = String(row.body_content || row.body_preview || "");
    rawBodyByPost.set(postId, rawBody);
    const fromEmail = typeof row.from_email === "string"
      ? row.from_email
      : null;
    return {
      postId,
      internetMessageId: typeof row.internet_message_id === "string"
        ? row.internet_message_id
        : null,
      conversationId: typeof row.conversation_id === "string"
        ? row.conversation_id
        : null,
      threadId: typeof row.thread_id === "string" ? row.thread_id : null,
      fromEmail,
      fromName: typeof row.from_name === "string" ? row.from_name : null,
      subject: typeof row.subject === "string" ? row.subject : null,
      body: stripEmailHtmlForTrade(rawBody) || String(row.body_preview || ""),
      receivedAt: String(row.received_at),
      attachments: attachmentsByPost.get(postId) || [],
      links: linksFromBody(postId, rawBody),
      direction: isOwnDomain(deriveFromDomain(fromEmail))
        ? "own_outbound"
        : "inbound",
    };
  });

  // Reuse the production PDF extraction boundary for rows that have not yet
  // crossed the belt. Persisted belt results are consumed above as exact
  // extracted documents and do not spend this local replay fallback budget.
  // The fallback's 50-document cap and deterministic ordering remain intact so
  // a read-only replay cannot invent an unlimited parser. The newest half
  // mirrors readInputs' recent page priority. Live arrivals are handled by the
  // one-PDF worker; this cap is historical replay protection, not the live law.
  const recentPriority = baseSources.slice(
    -Math.min(
      baseSources.length,
      Math.max(1, Math.floor(Math.min(maxSources, 500) / 2)),
    ),
  ).map((source) => source.postId);
  const sources = await enrichSourcesWithPdfText(
    {
      storage: {
        from: (bucket: string) => ({
          download: async (path: string) => {
            const response = await readOnlyFetch(
              storageObjectUrl(baseUrl, bucket, path),
              { headers: headers(key) },
            );
            return response.ok
              ? { data: await response.blob(), error: null }
              : {
                data: null,
                error: new Error(`storage GET failed (${response.status})`),
              };
          },
        }),
      },
    },
    baseSources,
    [],
    recentPriority,
  );
  const plan = buildDeterministicIntakePlan(sources, profiles);

  const caseIds = caseSourceRows.map((row) => String(row.case_id));
  const caseRows = await rowsForValues({
    baseUrl,
    key,
    table: "makesafe_intake_cases",
    select:
      "id,instruction_key,lineage_id,parent_case_id,parent_relation,state,reason_code,blocked_reasons,job_id,created_at,received_at",
    column: "id",
    values: caseIds,
  });
  const jobIds = caseRows.flatMap((row) =>
    typeof row.job_id === "string" ? [row.job_id] : []
  );
  const jobRows = await rowsForValues({
    baseUrl,
    key,
    table: "jobs",
    select: "id,created_at,status",
    column: "id",
    values: jobIds,
  });

  const historicalSources: HistoricalShapeInput[] = sources.map((source) => {
    const adapted = adaptDeterministicSource(source, profiles);
    return {
      source,
      rawBody: rawBodyByPost.get(source.postId) || "",
      adapterId: adapted.adapterId,
      adapterVersion: adapted.adapterVersion,
    };
  });
  const hugoBoard = await observeHugoBoard({ baseUrl, key });
  const report = buildFiveFatesReplayReport({
    plan,
    sources: historicalSources,
    caseSources: caseSourceRows as unknown as DurableCaseSourceRow[],
    cases: caseRows as unknown as DurableCaseRow[],
    jobs: jobRows as unknown as DurableJobRow[],
    sourceExceptions:
      sourceExceptionRows as unknown as DurableSourceExceptionRow[],
    independentShapes: catalogue.shapes,
    hugoBoard,
    nowIso,
  });

  const liveRuleCoverage = liveProfiles.map((profile) => ({
    slug: profile.slug,
    has_field_rules: Boolean(profile.parsingRules?.fields),
    intentionally_no_fields: Boolean(
      (profile.parsingRules as Record<string, unknown> | null)
        ?.intentionally_no_fields,
    ),
  }));
  const artifact = {
    ...report,
    execution_context: {
      production_access: "read_only_get_head_only",
      planner_code: "working_tree_candidate",
      company_rule_input:
        "live_profiles_plus_unapplied_20260726000001_slug_correction_overlay",
    },
    company_parsing_rule_coverage: {
      live_observed_read_only: liveRuleCoverage,
      live_missing_field_rules: liveRuleCoverage.filter((item) =>
        !item.has_field_rules && !item.intentionally_no_fields
      ).map((item) => item.slug),
      candidate_missing_field_rules: profiles.filter((profile) =>
        !profile.parsingRules?.fields &&
        !(profile.parsingRules as Record<string, unknown> | null)
          ?.intentionally_no_fields
      ).map((profile) => profile.slug),
      correction_migration:
        "supabase/migrations/20260726000001_makesafe_company_parsing_rules_slug_correction.sql",
      production_migration_applied: false,
    },
  };
  await Deno.writeTextFile(
    outputPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(JSON.stringify(
    {
      output: outputPath,
      corpus: report.corpus,
      proof_status: report.proof_status,
      planner_fate_counts: report.planner_fate_counts,
      durable_fate_counts: report.durable_fate_counts,
      independent_ground_truth: report.independent_ground_truth,
      five_minute_hugo_visibility: report.five_minute_hugo_visibility,
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  await run();
}
