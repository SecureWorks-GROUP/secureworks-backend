#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * SES Phase C3 — backfill `jobs.site_suburb` on the board cards that render
 * "Suburb TBC" while their own source address names the suburb.
 *
 * Captain ruling, 2026-08-01: "ye of course backfill suburbs".
 *
 * Scope is a CLOSED, hand-checked fixture (`FIXTURE` below): the 30 board cards
 * that had a blank `site_suburb` on 2026-08-01. There is deliberately no
 * discovery step, so this script can never widen its own blast radius.
 *
 * What it writes: `jobs.site_suburb` only, and only where it is currently blank.
 * It never writes an address, never touches a stage, a status, an assignment, an
 * invoice or a communication. `update_job_field` is the existing typed ops-api
 * action for exactly this field; no new endpoint and no raw SQL write.
 *
 * Why suburb-only: the card field is suburb-scoped (`ops.html` renders
 * `j.site_suburb`), so writing the full address there would put a street address
 * on the board. The suburb is extracted from the address instead.
 *
 * Modes:
 *   dry-run  read-only plan: card | current value | new suburb | source quote
 *   apply    re-reads live state, refuses on any drift, writes, ledgers each card
 *   verify   re-reads and proves the ledger against production
 *
 * Environment: `SUPABASE_ACCESS_TOKEN` (read-only Management API) for every
 * mode; `SW_API_KEY` additionally for `apply`.
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;

export const RUN_LABEL = "ses-c3-suburb-backfill-v1";

const MODES = ["dry-run", "apply", "verify"] as const;
export type Mode = (typeof MODES)[number];

export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// The closed fixture
// ---------------------------------------------------------------------------

export interface FixtureRow {
  card: string;
  jobId: string;
  /**
   * The `makesafe_intake_cases` row whose own `site_address` independently
   * corroborates the job's, or null where the card predates deterministic
   * intake and only the job row carries the address.
   */
  caseId: string | null;
  /**
   * The source quote: the suburb-and-postcode tail of the card's own
   * `site_address`, verbatim. Street number and street name are deliberately
   * NOT reproduced here — this file is committed.
   */
  sourceTail: string;
  /** The suburb to write, or "" for a card with no locatable suburb. */
  suburb: string;
}

/**
 * The 30 blank-suburb board cards as at 2026-08-01. 29 carry a locatable
 * suburb; `SWMS-261124` is the one skip — its `site_address` is the literal
 * "Legacy backfill - site evidence unavailable", already Captain-accepted as
 * evidence-absent (see `data/ses-board-poke-triage-v1/report.md` item 1).
 */
export const FIXTURE: readonly FixtureRow[] = [
  {
    card: "SWMS-261022",
    jobId: "8fc27330-b743-49d5-861f-d75f42d1a010",
    caseId: null,
    sourceTail: ", Helena Valley, WA 6056",
    suburb: "Helena Valley",
  },
  {
    card: "SWMS-261064",
    jobId: "f706aba3-6431-4653-9f8a-8843bd642845",
    caseId: "4a13518f-d2a6-42ba-9b7d-c6693dd6032e",
    sourceTail: ", Dianella WA 6059",
    suburb: "Dianella",
  },
  {
    card: "SWMS-261067",
    jobId: "6261a9ad-9ad4-494d-8adc-0d2b91b86136",
    caseId: "4023a391-4d25-4700-abcc-ad9f22024420",
    sourceTail: ", Waikiki WA 6169",
    suburb: "Waikiki",
  },
  {
    card: "SWMS-261068",
    jobId: "36575a25-9580-42be-8cb8-26ba76f1fea7",
    caseId: "0f22d10b-4b54-43d4-8339-2302f7dc4ec4",
    sourceTail: ", DALKEITH WA 6009",
    suburb: "Dalkeith",
  },
  {
    card: "SWMS-261074",
    jobId: "253adac6-8d7b-44ab-9881-4703a5d838b3",
    caseId: "d4534747-ad27-47ee-98e4-8a89d57b6703",
    sourceTail: ", CANNING VALE WA 6155",
    suburb: "Canning Vale",
  },
  {
    card: "SWMS-261075",
    jobId: "4b319d53-3345-4de5-adca-3907825b140a",
    caseId: "ac159598-31d0-4152-b653-e6255a5a19e4",
    sourceTail: ", Thornlie WA 6108",
    suburb: "Thornlie",
  },
  {
    card: "SWMS-261076",
    jobId: "d5dc62f6-4efa-4f6b-ae4e-2efacc0fa74b",
    caseId: "7ebb687e-f6cf-4c28-8f34-490e15dd5d0b",
    sourceTail: ", Geographe WA 6280",
    suburb: "Geographe",
  },
  {
    card: "SWMS-261077",
    jobId: "e673aae5-e58c-48c9-aaa7-452c3c4c81b0",
    caseId: "1b7410ea-c055-4e0f-8836-506aa65c3f11",
    sourceTail: ", Connolly WA 6027",
    suburb: "Connolly",
  },
  {
    card: "SWMS-261082",
    jobId: "02d5f733-cc6d-4ee6-aa40-99e90c232184",
    caseId: "40fc0754-9161-401c-8c9b-0410393dd324",
    sourceTail: ", Dalyellup WA 6230",
    suburb: "Dalyellup",
  },
  {
    card: "SWMS-261083",
    jobId: "397785fc-bdc4-4e83-80e3-2f6a64be39cf",
    caseId: "f2735f7a-1629-4cdb-aa67-5b735410a53b",
    sourceTail: ", East Bunbury WA 6230",
    suburb: "East Bunbury",
  },
  {
    card: "SWMS-261084",
    jobId: "0e19ec6d-6ee3-43fe-81a8-08dbe985d413",
    caseId: "9f3a53f5-491d-41ea-af02-ff9cbec3db68",
    sourceTail: ", Kensington WA 6151",
    suburb: "Kensington",
  },
  {
    card: "SWMS-261085",
    jobId: "fad232ab-bdb7-411b-a14a-70953ea93a38",
    caseId: "e2930e65-9a10-499a-8c3b-fca122c60263",
    sourceTail: ", Yanchep WA 6035",
    suburb: "Yanchep",
  },
  {
    card: "SWMS-261086",
    jobId: "25e4d449-0fad-4248-95af-98a08a11c208",
    caseId: "84d347b4-c3c0-4617-87ff-4bc5a442d8d9",
    sourceTail: ", Ardross WA 6153",
    suburb: "Ardross",
  },
  {
    card: "SWMS-261087",
    jobId: "0b5fcd2f-03d4-4cd5-bb7e-5b4ec0aa37fa",
    caseId: "9a24c328-92d0-4033-a6a1-2b13b0f0ede6",
    sourceTail: ", Hocking WA 6065",
    suburb: "Hocking",
  },
  {
    card: "SWMS-261088",
    jobId: "4839a3e1-73b9-44b8-a104-fb9f6ed2629b",
    caseId: "0566215b-f024-442a-a4eb-c800b3c061b3",
    sourceTail: ", BALLAJURA WA 6066",
    suburb: "Ballajura",
  },
  {
    card: "SWMS-261089",
    jobId: "23e86acf-6115-4cdc-8a0c-60770dbf356d",
    caseId: "27175f06-edba-4d56-bfed-7929683bb0ca",
    sourceTail: ", KOONDOOLA WA 6064",
    suburb: "Koondoola",
  },
  {
    card: "SWMS-261091",
    jobId: "97b65ae9-f758-4134-bce8-62d245464f50",
    caseId: "9094c3be-db16-4de7-bbe4-9b93184f9e46",
    sourceTail: ", Bennett Springs WA 6063",
    suburb: "Bennett Springs",
  },
  {
    card: "SWMS-261092",
    jobId: "a99e4d75-57ff-4a5a-b32a-a2b901064a36",
    caseId: "9f949948-527b-4e1f-b531-bc2ed7a89a46",
    sourceTail: ", Darch WA 6065",
    suburb: "Darch",
  },
  {
    card: "SWMS-261093",
    jobId: "07f3e784-6000-40f1-942f-106c1543dd04",
    caseId: "7060d325-50e5-4d85-ac67-b0beb30b9764",
    sourceTail: ", Willetton WA 6155",
    suburb: "Willetton",
  },
  {
    card: "SWMS-261094",
    jobId: "ee22000f-d204-420e-b07c-be5155838e91",
    caseId: "6831141a-95b1-4bc6-bd90-93ff4b362f84",
    sourceTail: ", Riverton WA 6148",
    suburb: "Riverton",
  },
  {
    card: "SWMS-261095",
    jobId: "7078dac7-ee34-4ae1-95fa-cb355c30bade",
    caseId: "f2a59286-0fac-433a-9666-e0f46381f26b",
    sourceTail: ", Nollamara WA 6061",
    suburb: "Nollamara",
  },
  {
    card: "SWMS-261096",
    jobId: "72378851-1962-423d-9d9c-8b153a1cd71d",
    caseId: "df951de4-936c-429f-b286-9f31507b9af6",
    sourceTail: ", JOONDANNA WA 6060",
    suburb: "Joondanna",
  },
  {
    card: "SWMS-261097",
    jobId: "17999ba8-b669-4d9f-9561-6e887f92fe9d",
    caseId: "491eacc2-3498-4fb6-bb4d-0d0a661896ac",
    sourceTail: ", Greenfields WA 6210",
    suburb: "Greenfields",
  },
  {
    card: "SWMS-261099",
    jobId: "518ab499-0310-45c2-9e5b-85801f03038d",
    caseId: "bfb138b6-ca85-4098-ad82-ce9cd878ae3b",
    sourceTail: ", SINGLETON WA 6175",
    suburb: "Singleton",
  },
  {
    card: "SWMS-261100",
    jobId: "914ac1f8-606e-4efd-8e4a-8aa89bb9f162",
    caseId: "819522dc-e5ce-405c-82e9-cbd16f213892",
    sourceTail: ", Bedford WA 6052",
    suburb: "Bedford",
  },
  {
    card: "SWMS-261101",
    jobId: "8ed3b7d2-949a-4f5e-8951-34f9d723e59f",
    caseId: "f3683166-d830-4d18-bdfe-c5f8386b4b2f",
    sourceTail: ", Forrestfield WA 6058",
    suburb: "Forrestfield",
  },
  {
    card: "SWMS-261102",
    jobId: "f4da9dcc-6dbf-4f79-b072-d88dd5d1a7f7",
    caseId: "b6f69e71-5821-4726-aa09-f2466c108a2d",
    sourceTail: ", Alexander Heights WA 6064",
    suburb: "Alexander Heights",
  },
  {
    card: "SWMS-261109",
    jobId: "208450c0-7161-4b30-9514-66226b054609",
    caseId: "087c1efa-9119-4f7f-b760-08d5320da61d",
    sourceTail: ", Bertram WA 6167",
    suburb: "Bertram",
  },
  {
    card: "SWMS-261124",
    jobId: "46f9bd9e-a3ba-4012-8039-0e1a7cb2c18f",
    caseId: null,
    sourceTail: "",
    suburb: "",
  },
  {
    card: "SWMS-26393",
    jobId: "c19c09d2-d7a9-4c36-bd1b-e573503d72e1",
    caseId: null,
    sourceTail: ", Beeliar WA 6164",
    suburb: "Beeliar",
  },
];

// ---------------------------------------------------------------------------
// Derivation (pure)
// ---------------------------------------------------------------------------

/**
 * The suburb-bearing tail of a WA address: everything between the last comma
 * that precedes it and the `WA <postcode>` terminator.
 *
 * Deliberately wider than the in-repo `addressSuburb()`
 * (`makesafe_aj_intake_reconciliation.ts`) in exactly two ways, both of which
 * that helper's own regex fails on in production:
 *   - an optional comma between the suburb and `WA` (`…, Helena Valley, WA 6056`)
 *   - a trailing country (`… WA 6164, Australia`)
 * Widening the runtime helper is the separate forward-extraction fix; this
 * script is the backfill of what the runtime already failed to record.
 */
const SUBURB_TAIL_RE =
  /,\s*([A-Za-z][A-Za-z' -]*?)\s*,?\s*(?:WA|W\.A\.)\s+\d{4}\s*$/i;
const TRAILING_COUNTRY_RE = /\s*,?\s*AUSTRALIA\s*$/i;

/**
 * Title case, the dominant house shape for `jobs.site_suburb` (335 of 377
 * populated board values on 2026-08-01). The verbatim source token is kept
 * alongside the written value in the ledger, so the normalisation is auditable
 * and reversible.
 */
export function titleCaseSuburb(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1))
    .replace(/\s+/g, " ");
}

export interface SuburbDerivation {
  /** The suburb token exactly as the source address spells it. */
  raw: string;
  /** The value that would be written. */
  suburb: string;
  /** The suburb-and-postcode tail, the committed source quote. */
  sourceTail: string;
}

export function deriveSuburb(address: string): SuburbDerivation | null {
  const trimmed = (address ?? "").trim();
  if (!trimmed) return null;
  const withoutCountry = trimmed.replace(TRAILING_COUNTRY_RE, "");
  const match = SUBURB_TAIL_RE.exec(withoutCountry);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return {
    raw,
    suburb: titleCaseSuburb(raw),
    sourceTail: match[0].trim(),
  };
}

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

/** Board-shape facts captured before and after, so a write can be proven inert. */
export interface CardStage {
  job_status: string | null;
  substatus: string | null;
  detail_computed_status: string | null;
  latest_status_application: string | null;
}

export interface LiveCard {
  card: string;
  jobId: string;
  siteAddress: string | null;
  siteSuburb: string | null;
  caseId: string | null;
  caseAddress: string | null;
  stage: CardStage;
}

export type Decision =
  | { action: "fill"; suburb: string; raw: string; sourceTail: string }
  | { action: "skip"; reason: string }
  | { action: "refuse"; reason: string };

/**
 * Decide one card from live state alone, then check it against the fixture.
 *
 * The derivation is recomputed from production rather than trusted from the
 * fixture: the fixture is the authorisation list, not the data source. Any
 * disagreement is a refusal, never a silent overwrite.
 */
export function evaluateCard(row: FixtureRow, live: LiveCard | null): Decision {
  if (!live) return { action: "refuse", reason: "card_not_found" };
  if (live.jobId !== row.jobId) {
    return { action: "refuse", reason: "job_id_drift" };
  }
  if ((live.siteSuburb ?? "").trim() !== "") {
    return {
      action: "skip",
      reason: `already_populated:${live.siteSuburb}`,
    };
  }
  const derived = deriveSuburb(live.siteAddress ?? "");
  if (!derived) {
    if (row.suburb !== "") {
      return { action: "refuse", reason: "fixture_expected_a_suburb" };
    }
    return { action: "skip", reason: "no_locatable_suburb_in_source" };
  }
  if (row.suburb === "") {
    return { action: "refuse", reason: "fixture_expected_no_suburb" };
  }
  if (derived.suburb !== row.suburb) {
    return {
      action: "refuse",
      reason: `derived_${derived.suburb}_but_fixture_${row.suburb}`,
    };
  }
  if (derived.sourceTail !== row.sourceTail.trim()) {
    return { action: "refuse", reason: "source_quote_drift" };
  }
  // Where the card has an intake case, its independently extracted address must
  // still agree; a disagreement means the two sources no longer name one site.
  if (live.caseAddress !== null) {
    const caseDerived = deriveSuburb(live.caseAddress);
    if (!caseDerived || caseDerived.suburb !== derived.suburb) {
      return { action: "refuse", reason: "intake_case_address_disagrees" };
    }
  }
  return {
    action: "fill",
    suburb: derived.suburb,
    raw: derived.raw,
    sourceTail: derived.sourceTail,
  };
}

export function stageUnchanged(before: CardStage, after: CardStage): boolean {
  return before.job_status === after.job_status &&
    before.substatus === after.substatus &&
    before.detail_computed_status === after.detail_computed_status &&
    before.latest_status_application === after.latest_status_application;
}

// ---------------------------------------------------------------------------
// Production access
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function managementQuery(
  query: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-C3-Suburb-Backfill/1.0",
    },
    // Every statement this script issues is a SELECT; the write path is the
    // typed ops-api action, never this endpoint.
    body: JSON.stringify({ query, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `management query HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  if (!Array.isArray(payload)) {
    throw new Error("management query returned a non-row payload");
  }
  return payload as Record<string, unknown>[];
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function loadLiveCards(): Promise<Map<string, LiveCard>> {
  const ids = FIXTURE.map((row) => `${sqlText(row.jobId)}::uuid`).join(",");
  const rows = await managementQuery(`
    SELECT j.id::text AS job_id,
           j.job_number,
           j.site_address,
           j.site_suburb,
           j.status AS job_status,
           d.substatus,
           d.computed_status AS detail_computed_status,
           c.id::text AS case_id,
           c.site_address AS case_address,
           (SELECT a.after_status
              FROM makesafe_board_status_applications a
             WHERE a.job_id = j.id
             ORDER BY a.applied_at DESC
             LIMIT 1) AS latest_status_application
      FROM jobs j
      LEFT JOIN makesafe_job_details d ON d.job_id = j.id
      LEFT JOIN LATERAL (
        SELECT ic.id, ic.site_address
          FROM makesafe_intake_cases ic
         WHERE ic.job_id = j.id
         ORDER BY ic.created_at ASC
         LIMIT 1
      ) c ON TRUE
     WHERE j.id IN (${ids})`);

  const live = new Map<string, LiveCard>();
  for (const row of rows) {
    const card = String(row.job_number);
    live.set(card, {
      card,
      jobId: String(row.job_id),
      siteAddress: text(row.site_address),
      siteSuburb: text(row.site_suburb),
      caseId: text(row.case_id),
      caseAddress: text(row.case_address),
      stage: {
        job_status: text(row.job_status),
        substatus: text(row.substatus),
        detail_computed_status: text(row.detail_computed_status),
        latest_status_application: text(row.latest_status_application),
      },
    });
  }
  return live;
}

async function writeSuburb(row: FixtureRow, suburb: string): Promise<void> {
  const response = await fetch(
    `${FUNCTIONS_BASE}/ops-api?action=update_job_field`,
    {
      method: "POST",
      headers: {
        "x-api-key": requiredEnv("SW_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: row.jobId,
        field: "site_suburb",
        value: suburb,
        operator_email: RUN_LABEL,
      }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !(payload as { success?: boolean })?.success) {
    throw new Error(
      `${row.card} update_job_field HTTP ${response.status}: ${
        JSON.stringify(payload)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

interface PlanCard {
  card: string;
  job_id: string;
  case_id: string | null;
  current_site_suburb: string | null;
  new_site_suburb: string | null;
  source_quote: string | null;
  source_token_verbatim: string | null;
  corroborating_case_address_tail: string | null;
  decision: Decision;
  stage_before: CardStage;
}

interface Plan {
  run: string;
  mode: string;
  ruling: string;
  cards: PlanCard[];
}

async function buildPlan(): Promise<Plan> {
  const live = await loadLiveCards();
  const cards: PlanCard[] = [];
  for (const row of FIXTURE) {
    const found = live.get(row.card) ?? null;
    const decision = evaluateCard(row, found);
    const caseDerived = found?.caseAddress
      ? deriveSuburb(found.caseAddress)
      : null;
    cards.push({
      card: row.card,
      job_id: row.jobId,
      case_id: found?.caseId ?? null,
      current_site_suburb: found?.siteSuburb ?? null,
      new_site_suburb: decision.action === "fill" ? decision.suburb : null,
      source_quote: decision.action === "fill" ? decision.sourceTail : null,
      source_token_verbatim: decision.action === "fill" ? decision.raw : null,
      corroborating_case_address_tail: caseDerived?.sourceTail ?? null,
      decision,
      stage_before: found?.stage ??
        {
          job_status: null,
          substatus: null,
          detail_computed_status: null,
          latest_status_application: null,
        },
    });
  }
  return {
    run: RUN_LABEL,
    mode: "dry-run",
    ruling: "Captain 2026-08-01: ye of course backfill suburbs",
    cards,
  };
}

function printPlan(plan: Plan): void {
  console.log(
    `${"card".padEnd(13)} ${"current".padEnd(9)} ${
      "new suburb".padEnd(18)
    } source quote`,
  );
  console.log("-".repeat(96));
  for (const card of plan.cards) {
    const current = card.current_site_suburb === null
      ? "NULL"
      : `"${card.current_site_suburb}"`;
    const next = card.decision.action === "fill"
      ? card.new_site_suburb!
      : `(${card.decision.action}: ${card.decision.reason})`;
    console.log(
      `${card.card.padEnd(13)} ${current.padEnd(9)} ${next.padEnd(18)} ${
        card.source_quote ?? "-"
      }`,
    );
  }
  const fills = plan.cards.filter((c) => c.decision.action === "fill").length;
  const skips = plan.cards.filter((c) => c.decision.action === "skip").length;
  const refusals =
    plan.cards.filter((c) => c.decision.action === "refuse").length;
  console.log("-".repeat(96));
  console.log(`fill=${fills} skip=${skips} refuse=${refusals}`);
}

interface LedgerEntry {
  card: string;
  job_id: string;
  before: { site_suburb: string | null };
  after: { site_suburb: string | null };
  source_quote: string;
  source_token_verbatim: string;
  corroborating_case_id: string | null;
  written_at: string;
  written_by: string;
}

async function runApply(planPath: string, ledgerPath: string): Promise<void> {
  const plan = JSON.parse(await Deno.readTextFile(planPath)) as Plan;
  const refused = plan.cards.filter((c) => c.decision.action === "refuse");
  if (refused.length > 0) {
    throw new Error(
      `plan has ${refused.length} refused card(s); resolve before applying`,
    );
  }

  // Re-read immediately before writing: the plan authorises, production decides.
  const live = await loadLiveCards();
  const ledger: LedgerEntry[] = [];
  const skipped: { card: string; reason: string }[] = [];

  for (const row of FIXTURE) {
    const planned = plan.cards.find((c) => c.card === row.card);
    if (!planned) throw new Error(`${row.card} missing from the plan`);
    const found = live.get(row.card) ?? null;
    const decision = evaluateCard(row, found);
    if (decision.action === "refuse") {
      throw new Error(`${row.card} refused at apply time: ${decision.reason}`);
    }
    if (decision.action === "skip") {
      if (planned.decision.action === "fill") {
        throw new Error(
          `${row.card} was planned as a fill but is now ${decision.reason}`,
        );
      }
      skipped.push({ card: row.card, reason: decision.reason });
      continue;
    }
    if (planned.decision.action !== "fill") {
      throw new Error(`${row.card} became fillable after the plan; re-plan`);
    }
    if (planned.new_site_suburb !== decision.suburb) {
      throw new Error(`${row.card} suburb drifted from the plan`);
    }

    const before = found!.siteSuburb;
    await writeSuburb(row, decision.suburb);
    ledger.push({
      card: row.card,
      job_id: row.jobId,
      before: { site_suburb: before },
      after: { site_suburb: decision.suburb },
      source_quote: decision.sourceTail,
      source_token_verbatim: decision.raw,
      corroborating_case_id: found!.caseId,
      written_at: new Date().toISOString(),
      written_by: RUN_LABEL,
    });
    // Written one card at a time so an interruption leaves a truthful ledger.
    await Deno.writeTextFile(
      ledgerPath,
      JSON.stringify(
        { run: RUN_LABEL, applied: ledger, skipped, plan: planPath },
        null,
        2,
      ),
    );
    console.log(`applied ${row.card} -> ${decision.suburb}`);
  }

  await Deno.writeTextFile(
    ledgerPath,
    JSON.stringify(
      { run: RUN_LABEL, applied: ledger, skipped, plan: planPath },
      null,
      2,
    ),
  );
  console.log(`applied=${ledger.length} skipped=${skipped.length}`);
}

async function runVerify(
  planPath: string,
  ledgerPath: string,
  outputPath: string | null,
): Promise<void> {
  const plan = JSON.parse(await Deno.readTextFile(planPath)) as Plan;
  const ledgerFile = JSON.parse(await Deno.readTextFile(ledgerPath)) as {
    applied: LedgerEntry[];
    skipped: { card: string; reason: string }[];
  };
  const live = await loadLiveCards();

  const failures: string[] = [];
  const verified: Record<string, unknown>[] = [];

  for (const entry of ledgerFile.applied) {
    const found = live.get(entry.card);
    if (!found) {
      failures.push(`${entry.card}: no longer readable`);
      continue;
    }
    if (found.siteSuburb !== entry.after.site_suburb) {
      failures.push(
        `${entry.card}: expected "${entry.after.site_suburb}", read "${found.siteSuburb}"`,
      );
    }
    const planned = plan.cards.find((c) => c.card === entry.card)!;
    if (!stageUnchanged(planned.stage_before, found.stage)) {
      failures.push(`${entry.card}: board stage changed`);
    }
    verified.push({
      card: entry.card,
      site_suburb: found.siteSuburb,
      stage_unchanged: stageUnchanged(planned.stage_before, found.stage),
      source_quote: entry.source_quote,
    });
  }

  for (const skip of ledgerFile.skipped) {
    const found = live.get(skip.card);
    const planned = plan.cards.find((c) => c.card === skip.card)!;
    if (found && (found.siteSuburb ?? "").trim() !== "") {
      failures.push(`${skip.card}: skipped card was written anyway`);
    }
    if (found && !stageUnchanged(planned.stage_before, found.stage)) {
      failures.push(`${skip.card}: board stage changed`);
    }
    verified.push({
      card: skip.card,
      site_suburb: found?.siteSuburb ?? null,
      skipped_reason: skip.reason,
      stage_unchanged: found
        ? stageUnchanged(planned.stage_before, found.stage)
        : null,
    });
  }

  const result = {
    run: RUN_LABEL,
    applied: ledgerFile.applied.length,
    skipped: ledgerFile.skipped.length,
    failures,
    cards: verified,
  };
  if (outputPath) {
    await Deno.writeTextFile(outputPath, JSON.stringify(result, null, 2));
  }
  console.log(
    `verified applied=${result.applied} skipped=${result.skipped} failures=${failures.length}`,
  );
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  if (failures.length > 0) throw new Error("verification failed");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseMode(value: string | null): Mode {
  const mode = (value ?? "").trim() as Mode;
  if (!MODES.includes(mode)) {
    throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
  }
  return mode;
}

function option(args: string[], name: string): string | null {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function printHelp(): void {
  console.log(`${RUN_LABEL} — backfill jobs.site_suburb on the SES board.

usage,"scripts/apply-ses-c3-suburb-backfill-v1.ts --mode <mode> [options]"
--mode,"dry-run, apply, or verify"
--plan,"plan JSON path (written by dry-run, read by apply/verify)"
--ledger,"apply ledger JSON path"
--output,"verify result JSON path"

env,SUPABASE_ACCESS_TOKEN,"all modes (read-only Management API)"
env,SW_API_KEY,"apply only"

example,"--mode dry-run --plan plan.json"
example,"--mode apply --plan plan.json --ledger ledger.json"
example,"--mode verify --plan plan.json --ledger ledger.json --output verify.json"`);
}

export async function run(args: string[] = Deno.args): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const mode = parseMode(option(args, "--mode"));
  const planPath = option(args, "--plan");
  const ledgerPath = option(args, "--ledger");

  if (mode === "dry-run") {
    const plan = await buildPlan();
    printPlan(plan);
    if (planPath) {
      await Deno.writeTextFile(planPath, JSON.stringify(plan, null, 2));
      console.log(`wrote ${planPath}`);
    }
    return;
  }
  if (!planPath) throw new UsageError(`--plan is required for --mode ${mode}`);
  if (!ledgerPath) {
    throw new UsageError(`--ledger is required for --mode ${mode}`);
  }
  if (mode === "apply") {
    await runApply(planPath, ledgerPath);
    return;
  }
  await runVerify(planPath, ledgerPath, option(args, "--output"));
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(String(error.message));
      printHelp();
      Deno.exit(2);
    }
    console.error(String(error instanceof Error ? error.message : error));
    Deno.exit(1);
  }
}
