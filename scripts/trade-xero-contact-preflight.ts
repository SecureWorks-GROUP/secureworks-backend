// Read-only preflight for the trade Xero supplier identity rule.
//
// It does not call Xero or the database. Feed it rows of
// (user id, name, email, cached contact id, contact name, contact email).
// It reports which of those current links the resolver would refuse.
//
//   deno task trade-xero-contact-preflight
//   deno run --allow-read scripts/trade-xero-contact-preflight.ts path.json

import { classifyTradeContactLink } from "../supabase/functions/ops-api/trade_xero_contact.ts";

type PreflightRow = {
  user_id?: string | null;
  name?: string | null;
  email?: string | null;
  cached_contact_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  basis?: string | null;
};

type PreflightFile = {
  note?: string;
  known?: PreflightRow[];
  unchecked_names?: string[];
};

function blank(value: string | null | undefined): string {
  const text = String(value || "").trim();
  return text || "-";
}

function verdictFor(row: PreflightRow) {
  return classifyTradeContactLink({
    name: row.name,
    email: row.email,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
  });
}

function reportRow(row: PreflightRow): string {
  const verdict = verdictFor(row);
  const how = verdict.by ? ` by ${verdict.by}` : "";
  return [
    verdict.result.toUpperCase() + how,
    `user ${blank(row.user_id)}`,
    `name ${blank(row.name)}`,
    `email ${blank(row.email)}`,
    `contact ${blank(row.cached_contact_id)}`,
    `'${blank(row.contact_name)}'`,
    `contact email ${blank(row.contact_email)}`,
    row.basis ? `(${row.basis})` : "",
  ].filter(Boolean).join(" | ");
}

const path = Deno.args[0] ||
  new URL("./fixtures/trade-xero-contact-preflight.json", import.meta.url)
    .pathname;
const file = JSON.parse(await Deno.readTextFile(path)) as PreflightFile;
const rows = file.known || [];
const refused = rows.filter((row) => verdictFor(row).result === "refuse");

if (file.note) console.log(file.note);
console.log("");
console.log(
  `Checked ${rows.length} fixture link${rows.length === 1 ? "" : "s"}.`,
);
for (const row of rows) console.log(reportRow(row));
console.log("");
console.log(
  refused.length === 0
    ? "No fixture link would be refused."
    : `${refused.length} fixture link${
      refused.length === 1 ? "" : "s"
    } would be refused.`,
);
const unchecked = file.unchecked_names || [];
if (unchecked.length > 0) {
  console.log("");
  console.log(
    "Not checked, because this repo has no contact name or email for them:",
  );
  for (const name of unchecked) console.log(`- ${name}`);
  console.log("");
  console.log(
    "A live read, still not taken here, would need for each user: users.id, users.name, users.email, users.xero_contact_id, and from Xero that contact's Name and EmailAddress. No Xero call and no production query is part of this script.",
  );
}
