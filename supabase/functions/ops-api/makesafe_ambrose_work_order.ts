// Ambrose Construct Group purchase-order field reader (deterministic, pure).
//
// Ambrose's purchase-order PDF is one fixed template whose labels the shared
// client-field reader does not know ("Insured Owner:", a "BEST CONTACT DETAILS"
// block keyed by "Contact Type:"), and it also carries OUR details under
// "SUBCONTRACTOR DETAILS" and the issuing supervisor's under "SUPERVISOR
// DETAILS". Reading it generically picks the wrong phone and email, so this
// reader takes each customer field only from the block that owns it, and
// returns null rather than guessing when that block is absent.
//
// Identity (job number, PO) is NOT read here; that is the shared identity
// module's Ambrose grammar (`normaliseAmbroseIdentityText`).

export interface AmbroseWorkOrderFields {
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  site_address: string | null;
  description: string | null;
}

function clean(value: unknown): string | null {
  const result = String(value ?? "").replace(/ /g, " ")
    .replace(/\s+/g, " ").trim();
  return result || null;
}

function lines(text: string | null | undefined): string[] {
  return String(text || "").split(/\r?\n/).map((line) => clean(line) || "");
}

function labelValue(line: string, label: RegExp): string | null {
  const match = line.match(label);
  return match ? clean(match[1]) : null;
}

const SECTION_HEADING =
  /^(?:SUBCONTRACTOR DETAILS|SUPERVISOR DETAILS|BEST CONTACT DETAILS|JOB DETAILS|Description of the Works\b)/i;

function section(all: string[], heading: RegExp): string[] {
  const start = all.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (let index = start + 1; index < all.length; index++) {
    if (SECTION_HEADING.test(all[index])) break;
    out.push(all[index]);
  }
  return out;
}

function phoneValue(value: string | null): string | null {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  return /^(?:\+?61|0)\d{8,9}$/.test(digits) ? clean(value) : null;
}

function emailValue(value: string | null): string | null {
  const email = clean(value);
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The insured owner's contact entry inside BEST CONTACT DETAILS: the lines
 * after "Contact Type: Insured Owner ..." up to the next contact. Ambrose lists
 * the decision maker first, then "Contact Type", "Email", "Mobile".
 */
function insuredContact(block: string[]): {
  name: string | null;
  phone: string | null;
  email: string | null;
} {
  const typeIndex = block.findIndex((line) =>
    /^contact\s+type\s*:\s*insured\s+owner\b/i.test(line)
  );
  if (typeIndex < 0) return { name: null, phone: null, email: null };
  const name = typeIndex > 0
    ? labelValue(
      block[typeIndex - 1],
      /^(?:decision\s+maker|site\s+contact)\s*:\s*(.+)$/i,
    )
    : null;
  let phone: string | null = null;
  let email: string | null = null;
  for (let index = typeIndex + 1; index < block.length; index++) {
    const line = block[index];
    if (/^(?:contact\s+type|site\s+contact|decision\s+maker)\s*:/i.test(line)) {
      break;
    }
    phone ||= phoneValue(
      labelValue(line, /^(?:mobile|phone|home|work)\s*:\s*(.+)$/i),
    );
    email ||= emailValue(labelValue(line, /^email\s*:\s*(.+)$/i));
  }
  return { name, phone, email };
}

// "Description of the Works Quantity Unit" up to the PO total: the room line,
// the scope sentences and the quantity row. The price is deliberately left out.
function worksDescription(all: string[]): string | null {
  const start = all.findIndex((line) =>
    /^description\s+of\s+the\s+works\b/i.test(line)
  );
  if (start < 0) return null;
  const out: string[] = [];
  for (let index = start + 1; index < all.length && out.length < 25; index++) {
    const line = all[index];
    if (
      /^total\s+purchase\s+order\s+price\b|^commercial-in-confidence\b/i.test(
        line,
      )
    ) {
      break;
    }
    if (!line || /^\d+(?:\.\d+)?\s+[A-Z]{1,4}$/.test(line)) continue;
    out.push(line);
  }
  return clean(out.join("\n").slice(0, 2_000));
}

export function readAmbroseWorkOrderFields(
  pdfText: string | null | undefined,
): AmbroseWorkOrderFields {
  const all = lines(pdfText);
  const job = section(all, /^JOB DETAILS$/i);
  const contact = insuredContact(section(all, /^BEST CONTACT DETAILS$/i));
  const insuredOwner =
    job.map((line) => labelValue(line, /^insured\s+owner\s*:\s*(.+)$/i)).find(
      Boolean,
    ) || null;
  // The site address is repeated in JOB DETAILS and on page one; both are
  // Ambrose's own, but the job-details copy is the labelled record.
  const siteAddress =
    job.map((line) => labelValue(line, /^site\s+address\s*:\s*(\d.*)$/i)).find(
      Boolean,
    ) ||
    all.map((line) => labelValue(line, /^site\s+address\s*:\s*(\d.*)$/i))
      .find(Boolean) ||
    null;
  return {
    client_name: insuredOwner || contact.name,
    client_phone: contact.phone,
    client_email: contact.email,
    site_address: siteAddress,
    description: worksDescription(all),
  };
}

/** "...: 20999101-02 -  25 Example Bend Testville WA 6000  is attached" */
export function ambroseSubjectSiteAddress(
  subject: string | null | undefined,
): string | null {
  const match = String(subject || "").match(
    /\bpurchase\s+order(?:\s+make\s+safe)?\s*:\s*\d{8}-\d{2}\s+-\s+(.+?)\s+is\s+attached\s*$/i,
  );
  return match ? clean(match[1]) : null;
}

// Street types seen on WA addresses. The suburb is whatever sits between the
// LAST street-type word and "WA <postcode>". No street type, no suburb: the
// intake suburb backstop then flags the card instead of a guessed suburb.
const STREET_TYPES = [
  "street",
  "st",
  "road",
  "rd",
  "avenue",
  "ave",
  "av",
  "drive",
  "dr",
  "court",
  "ct",
  "crescent",
  "cres",
  "close",
  "cl",
  "place",
  "pl",
  "way",
  "lane",
  "ln",
  "parade",
  "pde",
  "terrace",
  "tce",
  "boulevard",
  "blvd",
  "bvd",
  "circuit",
  "cct",
  "grove",
  "gr",
  "rise",
  "loop",
  "retreat",
  "mews",
  "gardens",
  "gdns",
  "vista",
  "view",
  "highway",
  "hwy",
  "square",
  "sq",
  "esplanade",
  "esp",
  "green",
  "link",
  "turn",
  "approach",
  "app",
  "entrance",
  "bend",
  "cove",
  "heights",
  "hts",
  "parkway",
  "pkwy",
  "ramble",
  "ridge",
  "chase",
  "walk",
  "circle",
  "cir",
  "glade",
  "gate",
  "quays",
  "promenade",
  "prom",
  "outlook",
  "pass",
  "track",
  "trail",
  "nook",
  "elbow",
  "mall",
  "row",
  "strand",
  "boardwalk",
];
const STREET_TYPE_SET = new Set(STREET_TYPES);
// Street-type words that also open WA suburbs ("St James", "Green Head").
const SUBURB_OPENING_TYPES = new Set(["st", "green"]);

export function ambroseSuburbFromAddress(
  address: string | null | undefined,
): string | null {
  const match = clean(address)?.match(/^(.*\S)\s+WA\s+\d{4}$/i);
  if (!match) return null;
  const words = match[1].split(" ");
  const word = (index: number) =>
    words[index].toLowerCase().replace(/[.,]$/, "");
  let streetEnd = -1;
  for (let index = 1; index < words.length; index++) {
    if (STREET_TYPE_SET.has(word(index))) streetEnd = index;
  }
  const previous = streetEnd - 1;
  if (
    streetEnd < words.length - 1 && previous >= 2 &&
    SUBURB_OPENING_TYPES.has(word(streetEnd)) &&
    STREET_TYPE_SET.has(word(previous)) &&
    !SUBURB_OPENING_TYPES.has(word(previous))
  ) {
    streetEnd = previous;
  }
  if (streetEnd < 0 || streetEnd === words.length - 1) return null;
  return clean(words.slice(streetEnd + 1).join(" "));
}
