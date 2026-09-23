// Slice B0 (adminbucket.md, INTEGRATION X23): the TypeScript twin of the
// placement track's SQL key helpers in
// supabase/migrations/20260924160000_context_unlinked_census.sql.
//
// One rule set for texts, email, calls and money: the same token rule, the
// same phone and email keys and the same address key in SQL and TypeScript.
// The fixture table in job_refs_fixtures.ts runs against both (job_refs_test.ts
// here, the migration contract in SQL); change both bodies together or CI
// fails.
//
// Pure functions only: no provider, database or model call.

const OUR_LINES = new Set([
  "489267771",
  "489267772",
  "489267774",
  "489267776",
  "489267778",
]);

const OUR_DOMAINS =
  /@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$/;

/** Phone identity key: the last 9 digits. Null for fewer than 8 digits, one
 * repeated digit, or one of our five lines. SQL: context_phone_key. */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/[^0-9]/g, "");
  if (d.length < 8 || /^(\d)\1*$/.test(d)) return null;
  const key = d.slice(-9);
  return OUR_LINES.has(key) ? null : key;
}

/** Email identity key: lower-case trimmed; "Name <a@b>" reads a@b. Null when
 * not an address or in one of our domains. SQL: context_email_key. */
export function emailKey(email: string | null | undefined): string | null {
  const raw = String(email ?? "");
  const angled = /<([^<>]*)>/.exec(raw);
  const a = (angled ? angled[1] : raw).trim().toLowerCase();
  if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a)) return null;
  return OUR_DOMAINS.test(a) ? null : a;
}

const STREET_TYPES: Record<string, string> = {
  road: "rd",
  rd: "rd",
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  av: "ave",
  court: "ct",
  ct: "ct",
  crt: "ct",
  close: "cl",
  cl: "cl",
  way: "way",
  wy: "way",
  place: "pl",
  pl: "pl",
  crescent: "cres",
  cres: "cres",
  cr: "cres",
  drive: "dr",
  dr: "dr",
  turn: "tn",
  tn: "tn",
  terrace: "tce",
  tce: "tce",
  grove: "grv",
  grv: "grv",
  parade: "pde",
  pde: "pde",
  boulevard: "blvd",
  blvd: "blvd",
  loop: "lp",
  lp: "lp",
  highway: "hwy",
  hwy: "hwy",
  lane: "ln",
  ln: "ln",
  circuit: "cct",
  cct: "cct",
  gardens: "gdns",
  gdns: "gdns",
  esplanade: "esp",
  esp: "esp",
  square: "sq",
  sq: "sq",
  retreat: "rtt",
  rtt: "rtt",
  promenade: "prom",
  prom: "prom",
  parkway: "pkwy",
  pkwy: "pkwy",
  rise: "rise",
  mews: "mews",
};

/** The one street-type table: canonical short form, or null. SQL:
 * context_street_type. */
export function streetType(word: string): string | null {
  return Object.hasOwn(STREET_TYPES, word.toLowerCase())
    ? STREET_TYPES[word.toLowerCase()]
    : null;
}

export type AddressMention = {
  /** Exact key: number (unit and letter suffix kept), street name, canonical
   * type. Null when the mention has no street-type word. */
  addressKey: string | null;
  /** Loose keys: number without suffix (each number of a slash form) and the
   * street name without its type. */
  looseKeys: string[];
  typed: boolean;
  slashForm: boolean;
};

const NAME_PREFIXES = new Set(["st", "saint", "mt", "mount", "port", "lake"]);

/** Every street address in a text, in order. SQL: context_address_mentions. */
export function addressMentions(
  text: string | null | undefined,
): AddressMention[] {
  let s = String(text ?? "").toLowerCase();
  s = s.replace(/['`’]/g, "");
  s = s.replace(/\s*\/\s*/g, "/");
  s = s.replace(/,/g, " , ");
  s = s.replace(/[^a-z0-9/,]+/g, " ");
  s = s.trim();
  if (s === "") return [];
  const toks = s.split(/ +/);
  const out: AddressMention[] = [];
  let i = 0;
  while (i < toks.length) {
    const m = /^([0-9]{1,5})([a-z]?)(?:\/([0-9]{1,5})([a-z]?))?$/.exec(toks[i]);
    const n1 = m ? m[1].replace(/^0+/, "") : "";
    if (!m || n1 === "") {
      i++;
      continue;
    }
    const names: string[] = [];
    let typ: string | null = null;
    let j = i + 1;
    while (j < toks.length && names.length < 4) {
      const w = toks[j];
      if (!/^[a-z]+$/.test(w)) break;
      if (names.length >= 1 && streetType(w) !== null) {
        typ = streetType(w);
        j++;
        break;
      }
      names.push(w);
      j++;
    }
    if (names.length === 0) {
      i++;
      continue;
    }
    const nm = typ !== null
      ? names.join(" ")
      : NAME_PREFIXES.has(names[0]) && names.length >= 2
      ? `${names[0]} ${names[1]}`
      : names[0];
    if (nm.replace(/ /g, "").length < 4) {
      i++;
      continue;
    }
    let num = n1 + m[2];
    const looseKeys = [`${n1} ${nm}`];
    if (m[3] !== undefined) {
      const n2 = m[3].replace(/^0+/, "");
      num = `${num}/${n2}${m[4]}`;
      if (n2 !== "" && n2 !== n1) looseKeys.push(`${n2} ${nm}`);
    }
    out.push({
      addressKey: typ !== null ? `${num} ${nm} ${typ}` : null,
      looseKeys,
      typed: typ !== null,
      slashForm: m[3] !== undefined,
    });
    i = typ !== null ? j : i + 1;
  }
  return out;
}

/** Exact key of the first typed address in one string (a job site_address).
 * SQL: context_address_key. */
export function addressKey(address: string | null | undefined): string | null {
  return addressMentions(address).find((m) => m.typed)?.addressKey ?? null;
}

/** Loose keys of the first typed address, else of the first address. SQL:
 * context_address_loose_keys. */
export function addressLooseKeys(
  address: string | null | undefined,
): string[] | null {
  const all = addressMentions(address);
  return (all.find((m) => m.typed) ?? all[0])?.looseKeys ?? null;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reference tokens of a text, sorted and distinct: L1's exact whole tokens
 * (upper case, at least 5 characters, containing a digit) plus a space-joined
 * "AB 1234" as AB-1234 and AB1234. Lower case needs no extra because tokens are
 * upper-cased, as L1 compares. SQL: context_job_ref_tokens. */
export function jobRefTokens(text: string | null | undefined): string[] {
  const t = String(text ?? "").replace(/[^a-zA-Z0-9-]+/g, " ").toUpperCase()
    .trim();
  const toks = new Set<string>(t === "" ? [""] : t.split(" "));
  for (const m of t.matchAll(/(?:^| )([A-Z]{2,4}) ([0-9]{4,})(?= |$)/g)) {
    toks.add(`${m[1]}-${m[2]}`);
    toks.add(`${m[1]}${m[2]}`);
  }
  return [...toks].filter((w) => w.length >= 5 && /[0-9]/.test(w)).sort(
    byCodeUnit,
  );
}
