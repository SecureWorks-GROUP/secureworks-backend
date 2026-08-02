#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * SES identity grain — read-only production measurement of the captain's
 * 2026-08-02 ruling that THE PURCHASE ORDER IS THE JOB
 * (`data/decisions/2026-08-02-purchase-order-is-the-job-grain.md`).
 *
 * The ruling only works if a purchase order is actually unique. This script
 * establishes that from production before any key is trusted, and re-proves it
 * after any new correction tranche. It answers five questions:
 *
 *   Q1  Is a purchase order unique WITHIN a builder?
 *   Q2  Is a purchase order unique ACROSS builders?
 *   Q3  How often does the GROUP reference drift for one purchase order?
 *   Q4  How many cards can a purchase-order key even reach?
 *   Q5  Do the AJ and repair paths hold, and is any other builder silently
 *       relying on a claim-only fallback?
 *
 * TWO RULES, reported separately, because they answer different questions and
 * the difference is the whole finding:
 *
 *   DECLARED  the card's OWN purchase order — `jobs.metadata.builder_po_number`,
 *             a PO parsed from its own `external_ref`, or its authoritative
 *             `makesafe_intake_cases.builder_po_canonical`. This is what the
 *             card says it IS.
 *   OBSERVED  any PO token the identity grammar can read anywhere the mint gate
 *             looks, INCLUDING `job_documents` work-order filenames. MLB routinely
 *             attaches every work-order PDF of a claim to every card in that
 *             family, so an observed token is not proof of ownership.
 *
 * Blind spots, stated because a figure without them is not a measurement:
 * - It reads only what the shipped grammar can parse. A builder reference in a
 *   spelling `BUILDER_REF_RE` / `PO_RE` cannot see is counted as absent, not as
 *   unknown.
 * - It reads filenames and stored references, never PDF body text, so a PO that
 *   exists only inside a document's rendered text is invisible here.
 * - The population is SES board MEMBERSHIP including cancelled/lost (440 rows at
 *   2026-08-02), which is deliberately WIDER than the `active-v1` population
 *   contract. Captain decision C.5 is open; see `ses-board-population-contract.ts`.
 *
 * Production safety: the only production access is the Supabase Management API
 * `/database/query` endpoint with `read_only: true`; `assertReadOnlySql` refuses
 * anything that is not a SELECT/WITH before the request is sent, and
 * `assertNoPiiColumns` refuses any statement naming a client-identifying column.
 * NO write, NO backfill, NO re-keying.
 *
 * Usage:  SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read \
 *           scripts/ses-identity-grain-measure.ts [--json]
 */

import {
  builderInstructionKey,
  builderInstructionKeysForCard,
  builderInstructionScope,
  extractBuilderWorkOrderIdentity,
} from "../supabase/functions/ops-api/makesafe_builder_work_order_identity.ts";
import {
  sesBoardMembershipPredicate,
  sesBoardSyntheticExclusionPredicate,
} from "./ses-board-population-contract.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/**
 * The denominator this script reports against. It is NOT `active-v1`: the
 * identity question covers every card an instruction could ever have minted,
 * and a cancelled twin is exactly the defect the grain exists to prevent.
 */
export const SES_IDENTITY_GRAIN_POPULATION =
  "ses-identity-grain/membership-all-v1 " +
  "[SES board membership INCLUDING cancelled/lost, minus terminal synthetic " +
  "live-fire; wider than ses-board-population/active-v1 on purpose]";

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

export function assertReadOnlySql(sql: string): void {
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

export function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refused statement naming PII column "${column}"`);
    }
  }
}

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-identity-grain-measure/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as any).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

const MEMBERSHIP = `${sesBoardMembershipPredicate("j", "d2")}
  and ${sesBoardSyntheticExclusionPredicate("j")}`;

const CARD_SQL = `
select
  j.id as job_id, j.job_number, j.status, j.type,
  j.metadata->>'makesafe_job_family' as makesafe_job_family,
  j.metadata->>'builder_claim_ref' as md_claim,
  j.metadata->>'builder_po_number' as md_po,
  j.metadata->>'builder_work_order_number' as md_wo,
  j.metadata->>'external_ref' as md_external_ref,
  j.metadata->'requesting_company'->>'slug' as md_slug,
  d.external_ref as detail_external_ref,
  d.requesting_company_slug as slug
from jobs j
left join makesafe_job_details d on d.job_id = j.id
where ${MEMBERSHIP}
order by j.created_at
`;

const DOC_SQL = `
select doc.job_id, doc.file_name, doc.storage_url
from job_documents doc
join jobs j on j.id = doc.job_id
where doc.type = 'work_order' and ${MEMBERSHIP}
`;

const CASE_SQL = `
select c.job_id, c.builder_po_canonical, c.builder_wo_canonical, c.is_authoritative
from makesafe_intake_cases c
join jobs j on j.id = c.job_id
where ${MEMBERSHIP}
`;

/** The exception pile, which the board population cannot see at all. */
const EXCEPTION_SQL = `
select
  state,
  count(*) as cases,
  count(*) filter (where builder_po_canonical is not null) as with_po,
  count(*) filter (where upper(builder_po_canonical) = 'BOX') as box_token,
  count(*) filter (
    where builder_po_canonical is not null and upper(builder_po_canonical) <> 'BOX'
  ) as real_po
from makesafe_intake_cases
group by state
order by cases desc
`;

const COMPANY_SQL =
  `select slug, name, active from makesafe_companies order by slug`;

type Observation = {
  jobNumber: string;
  status: string;
  scope: string;
  po: string;
  groupRef: string | null;
  declared: boolean;
};

export interface IdentityGrainMeasurement {
  population: string;
  measured_at: string;
  cards: number;
  q1_within_builder: {
    rule: string;
    declared_pairs: number;
    declared_collisions: Array<{ key: string; cards: string[] }>;
    observed_pairs: number;
    observed_collisions: Array<{ key: string; cards: string[] }>;
  };
  q2_across_builders: {
    distinct_po_digit_runs: number;
    digit_runs_under_more_than_one_scope: Array<
      { digits: string; scopes: string[] }
    >;
    po_issuing_scopes: Record<string, number>;
  };
  q3_group_reference_drift: {
    pairs_with_more_than_one_group_ref: Array<
      { key: string; groupRefs: string[] }
    >;
    composite_key_splits: Array<{ key: string; compositeKeys: string[] }>;
  };
  q4_coverage: {
    cards_with_declared_po: number;
    cards_with_observed_po_only: number;
    cards_with_no_po: number;
    cards_with_a_conforming_key: number;
    by_scope: Record<
      string,
      { cards: number; declared_po: number; observed_po: number; keyed: number }
    >;
    exception_pile: Array<Record<string, any>>;
  };
  q5_fallback_paths: {
    companies: Array<Record<string, any>>;
    aj_cards: number;
    aj_cards_with_any_po_token: number;
    claim_only_scopes: Record<string, { cards: number; refs: string[] }>;
    repair_family_cards: number;
  };
}

function poDigits(po: string | null | undefined): string | null {
  return String(po || "").match(/(\d{3,})$/)?.[1] || null;
}

export async function measureIdentityGrain(): Promise<
  IdentityGrainMeasurement
> {
  const [cards, docs, cases, exceptions, companies] = await Promise.all([
    query(CARD_SQL),
    query(DOC_SQL),
    query(CASE_SQL),
    query(EXCEPTION_SQL),
    query(COMPANY_SQL),
  ]);

  const namesByJob = new Map<string, string[]>();
  for (const doc of docs) {
    const name = String(doc.file_name || doc.storage_url || "");
    if (!name) continue;
    namesByJob.set(String(doc.job_id), [
      ...(namesByJob.get(String(doc.job_id)) || []),
      name,
    ]);
  }
  const casePoByJob = new Map<string, string[]>();
  for (const row of cases) {
    if (!row.builder_po_canonical) continue;
    const id = String(row.job_id);
    casePoByJob.set(id, [
      ...(casePoByJob.get(id) || []),
      String(row.builder_po_canonical).toUpperCase(),
    ]);
  }

  const declared: Observation[] = [];
  const observed: Observation[] = [];
  const perCard: Array<{
    jobNumber: string;
    scope: string | null;
    family: string | null;
    declaredPo: Set<string>;
    observedPo: Set<string>;
    keys: string[];
    groupRef: string | null;
  }> = [];

  for (const card of cards) {
    const slug = card.slug || card.md_slug || null;
    const metadata = {
      builder_claim_ref: card.md_claim,
      builder_po_number: card.md_po,
      builder_work_order_number: card.md_wo,
      external_ref: card.md_external_ref,
      makesafe_job_family: card.makesafe_job_family,
    };
    const attachmentNames = namesByJob.get(String(card.job_id)) || [];
    const keys = builderInstructionKeysForCard({
      requestingCompanySlug: slug,
      family: card.makesafe_job_family,
      metadata,
      detailExternalRef: card.detail_external_ref,
      attachmentNames,
    });

    // Per-source identity, split by whether the source is the card's OWN
    // declaration or a document merely attached to it.
    const structured = [card.md_wo, card.md_claim, card.md_po].filter(Boolean)
      .join(" ");
    const declaredSources = [
      structured,
      card.md_external_ref,
      card.detail_external_ref,
    ].filter(Boolean).map(String);
    const declaredPo = new Set<string>(
      casePoByJob.get(String(card.job_id)) || [],
    );
    const observedPo = new Set<string>();
    let groupRef: string | null = null;
    let scope: string | null = null;

    const absorb = (
      text: string,
      isDeclared: boolean,
      viaFilename: boolean,
    ) => {
      const identity = extractBuilderWorkOrderIdentity(
        viaFilename
          ? { requestingCompanySlug: slug, attachmentNames: [text] }
          : { externalRef: text, requestingCompanySlug: slug },
      );
      groupRef = groupRef || identity.builder_claim_ref;
      scope = scope || builderInstructionScope({
        claimRef: identity.builder_claim_ref,
        workOrderNumber: identity.builder_work_order_number,
        requestingCompanySlug: slug,
      });
      if (identity.builder_po_number) {
        (isDeclared ? declaredPo : observedPo).add(
          identity.builder_po_number.toUpperCase(),
        );
      }
    };
    for (const text of declaredSources) absorb(text, true, false);
    for (const name of attachmentNames) absorb(name, false, true);

    const cardScope = scope ||
      builderInstructionScope({ requestingCompanySlug: slug });
    for (const po of declaredPo) {
      if (!cardScope) continue;
      const record: Observation = {
        jobNumber: card.job_number,
        status: card.status,
        scope: cardScope,
        po,
        groupRef,
        declared: true,
      };
      declared.push(record);
      observed.push(record);
    }
    for (const po of observedPo) {
      if (!cardScope || declaredPo.has(po)) continue;
      observed.push({
        jobNumber: card.job_number,
        status: card.status,
        scope: cardScope,
        po,
        groupRef,
        declared: false,
      });
    }
    perCard.push({
      jobNumber: card.job_number,
      scope: cardScope,
      family: card.makesafe_job_family || null,
      declaredPo,
      observedPo,
      keys,
      groupRef,
    });
  }

  const groupBy = (rows: Observation[]) => {
    const map = new Map<string, Observation[]>();
    for (const row of rows) {
      const key = `${row.scope}:${row.po}`;
      map.set(key, [...(map.get(key) || []), row]);
    }
    return map;
  };
  const collisionsOf = (map: Map<string, Observation[]>) =>
    [...map.entries()]
      .map(([key, rows]) => ({
        key,
        cards: [...new Set(rows.map((r) => `${r.jobNumber}[${r.status}]`))]
          .sort(),
      }))
      .filter((entry) => entry.cards.length > 1)
      .sort((a, b) => a.key.localeCompare(b.key));

  const declaredMap = groupBy(declared);
  const observedMap = groupBy(observed);

  const digitScopes = new Map<string, Set<string>>();
  const poIssuingScopes: Record<string, number> = {};
  for (const row of observed) {
    const digits = poDigits(row.po);
    if (!digits) continue;
    digitScopes.set(
      digits,
      (digitScopes.get(digits) || new Set()).add(row.scope),
    );
    poIssuingScopes[row.scope] = (poIssuingScopes[row.scope] || 0) + 1;
  }

  const driftPairs = [...observedMap.entries()]
    .map(([key, rows]) => ({
      key,
      groupRefs: [
        ...new Set(rows.map((r) => r.groupRef).filter(Boolean)),
      ] as string[],
    }))
    .filter((entry) => entry.groupRefs.length > 1);
  const compositeSplits = [...observedMap.entries()]
    .map(([key, rows]) => ({
      key,
      compositeKeys: [
        ...new Set(
          rows.map((r) => `${r.groupRef || "(none)"}${r.po}`.toUpperCase()),
        ),
      ],
    }))
    .filter((entry) => entry.compositeKeys.length > 1);

  const byScope: IdentityGrainMeasurement["q4_coverage"]["by_scope"] = {};
  for (const card of perCard) {
    const scope = card.scope || "(no builder scope)";
    byScope[scope] ||= { cards: 0, declared_po: 0, observed_po: 0, keyed: 0 };
    byScope[scope].cards++;
    if (card.declaredPo.size) byScope[scope].declared_po++;
    if (card.observedPo.size) byScope[scope].observed_po++;
    if (card.keys.length) byScope[scope].keyed++;
  }

  const claimOnlyScopes: Record<string, { cards: number; refs: string[] }> = {};
  for (const card of perCard) {
    if (!card.scope || card.scope === "AJ") continue;
    if (card.declaredPo.size || card.observedPo.size) continue;
    if (!card.groupRef) continue;
    claimOnlyScopes[card.scope] ||= { cards: 0, refs: [] };
    claimOnlyScopes[card.scope].cards++;
    claimOnlyScopes[card.scope].refs.push(card.groupRef);
  }

  return {
    population: SES_IDENTITY_GRAIN_POPULATION,
    measured_at: new Date().toISOString(),
    cards: cards.length,
    q1_within_builder: {
      rule:
        "DECLARED = the card's own PO (metadata / own external_ref / authoritative " +
        "intake case). OBSERVED additionally counts a PO read from a work-order " +
        "filename, which MLB attaches family-wide and is therefore not ownership.",
      declared_pairs: declaredMap.size,
      declared_collisions: collisionsOf(declaredMap),
      observed_pairs: observedMap.size,
      observed_collisions: collisionsOf(observedMap),
    },
    q2_across_builders: {
      distinct_po_digit_runs: digitScopes.size,
      digit_runs_under_more_than_one_scope: [...digitScopes.entries()]
        .filter(([, scopes]) => scopes.size > 1)
        .map(([digits, scopes]) => ({ digits, scopes: [...scopes].sort() })),
      po_issuing_scopes: poIssuingScopes,
    },
    q3_group_reference_drift: {
      pairs_with_more_than_one_group_ref: driftPairs,
      composite_key_splits: compositeSplits,
    },
    q4_coverage: {
      cards_with_declared_po: perCard.filter((c) => c.declaredPo.size).length,
      cards_with_observed_po_only:
        perCard.filter((c) => !c.declaredPo.size && c.observedPo.size).length,
      cards_with_no_po:
        perCard.filter((c) => !c.declaredPo.size && !c.observedPo.size).length,
      cards_with_a_conforming_key: perCard.filter((c) => c.keys.length).length,
      by_scope: byScope,
      exception_pile: exceptions,
    },
    q5_fallback_paths: {
      companies,
      aj_cards: perCard.filter((c) => c.scope === "AJ").length,
      aj_cards_with_any_po_token:
        perCard.filter((c) =>
          c.scope === "AJ" && (c.declaredPo.size || c.observedPo.size)
        ).length,
      claim_only_scopes: claimOnlyScopes,
      repair_family_cards: perCard.filter((c) => c.family === "repair").length,
    },
  };
}

if (import.meta.main) {
  const result = await measureIdentityGrain();
  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const q1 = result.q1_within_builder;
    const q2 = result.q2_across_builders;
    const q3 = result.q3_group_reference_drift;
    const q4 = result.q4_coverage;
    const q5 = result.q5_fallback_paths;
    console.log(`population : ${result.population}`);
    console.log(`measured   : ${result.measured_at}`);
    console.log(`cards      : ${result.cards}\n`);
    console.log(
      `Q1 within-builder uniqueness: ${q1.declared_collisions.length} DECLARED ` +
        `collision(s) over ${q1.declared_pairs} pairs; ` +
        `${q1.observed_collisions.length} OBSERVED collision(s) over ` +
        `${q1.observed_pairs} pairs`,
    );
    for (const c of q1.declared_collisions) {
      console.log(`   declared  ${c.key}  ${c.cards.join(", ")}`);
    }
    console.log(
      `\nQ2 cross-builder uniqueness: ${q2.digit_runs_under_more_than_one_scope.length} ` +
        `of ${q2.distinct_po_digit_runs} PO digit run(s) appear under >1 builder; ` +
        `PO-issuing scopes ${JSON.stringify(q2.po_issuing_scopes)}`,
    );
    console.log(
      `\nQ3 group-reference drift: ${q3.pairs_with_more_than_one_group_ref.length} ` +
        `purchase order(s) carry >1 group reference; the composite key would split ` +
        `${q3.composite_key_splits.length} of them into separate cards`,
    );
    console.log(
      `\nQ4 coverage: declared PO ${q4.cards_with_declared_po}, ` +
        `attachment-only PO ${q4.cards_with_observed_po_only}, ` +
        `no PO ${q4.cards_with_no_po}, keyed ${q4.cards_with_a_conforming_key} ` +
        `of ${result.cards}`,
    );
    console.table(q4.by_scope);
    console.table(q4.exception_pile);
    console.log(
      `\nQ5 AJ cards ${q5.aj_cards}, of which carry any PO token ` +
        `${q5.aj_cards_with_any_po_token}; repair-family cards ` +
        `${q5.repair_family_cards}`,
    );
    console.log(
      `   scopes still relying on a group ref alone: ` +
        JSON.stringify(
          Object.fromEntries(
            Object.entries(q5.claim_only_scopes).map((
              [k, v],
            ) => [k, { cards: v.cards, refs: [...new Set(v.refs)].sort() }]),
          ),
        ),
    );
    console.log(
      `   key for each: ` +
        JSON.stringify(
          Object.fromEntries(
            Object.keys(q5.claim_only_scopes).map((scope) => [
              scope,
              builderInstructionKey(
                {
                  /* group ref only, no PO */
                  builder_claim_ref: `${scope}-12345`,
                  builder_work_order_number: null,
                  builder_po_number: null,
                  evidence_sources: [],
                },
              ),
            ]),
          ),
        ),
    );
  }
}
