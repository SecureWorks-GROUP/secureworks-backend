// Slice B0: the ONE fixture table for the placement keys and the token rule,
// shared by the TypeScript twin (job_refs.ts, job_refs_test.ts), the SQL
// helpers (the 20260924160000_context_unlinked_census migration contract, whose
// FIXTURES block job_refs_contract_rows_test.ts proves identical to this file)
// and the money track (money.md M7: one token rule, one CI fixture table).
//
// Strings come from the named rows in adminbucket.md, email.md and money.md
// (row labels only, never a customer name or contact detail); synthetic
// contact details stand in where a key's shape matters.

export type KeyFixture =
  | { kind: "tokens"; label: string; input: string; expected: string[] }
  | { kind: "phone"; label: string; input: string; expected: string | null }
  | { kind: "email"; label: string; input: string; expected: string | null }
  | {
    kind: "address";
    label: string;
    input: string;
    expected: { key: string | null; loose: string[] | null };
  };

export const JOB_REF_FIXTURES: KeyFixture[] = [
  // Token rule (money.md M7 list, adminbucket N4, N8, N22, sms R13, L1).
  { kind: "tokens", label: "INV-1075 legacy job number", input: "SW1346", expected: ["SW1346"] },
  { kind: "tokens", label: "unhyphenated form stays exact", input: "SWP26376", expected: ["SWP26376"] },
  { kind: "tokens", label: "typo suffix stays one token", input: "SWF-26777-V", expected: ["SWF-26777-V"] },
  { kind: "tokens", label: "N4 space-joined job number", input: "FW: Material Order Ref SWP 26195 - 1047995", expected: ["1047995", "26195", "SWP-26195", "SWP26195"] },
  { kind: "tokens", label: "N22 dated job number exact", input: "Re: SWG-20260713-BE install", expected: ["SWG-20260713-BE"] },
  { kind: "tokens", label: "lower case reads as upper", input: "about swp-26195 please", expected: ["SWP-26195"] },
  { kind: "tokens", label: "N8 two references", input: "paid invoice for SWP-26183 and SWP-26941", expected: ["SWP-26183", "SWP-26941"] },
  { kind: "tokens", label: "sms R13 a date is not a reference", input: "see you on the 21 Sep", expected: [] },
  { kind: "tokens", label: "an amount is not a reference", input: "the balance is $5,478", expected: [] },
  { kind: "tokens", label: "ACCREC number in a subject", input: "Re: Invoice #INV-1244", expected: ["INV-1244"] },
  { kind: "tokens", label: "space-joined invoice number", input: "paid INV 1244 today", expected: ["INV-1244", "INV1244"] },
  { kind: "tokens", label: "empty text", input: "", expected: [] },

  // Phone key: the four shapes of one mobile, placeholders and our lines.
  { kind: "phone", label: "international", input: "+61 412 345 678", expected: "412345678" },
  { kind: "phone", label: "local", input: "0412 345 678", expected: "412345678" },
  { kind: "phone", label: "international without plus", input: "61412345678", expected: "412345678" },
  { kind: "phone", label: "punctuated", input: "(04) 1234-5678", expected: "412345678" },
  { kind: "phone", label: "placeholder zeros", input: "0000000000", expected: null },
  { kind: "phone", label: "too short", input: "1234567", expected: null },
  { kind: "phone", label: "our line", input: "+61489267771", expected: null },
  { kind: "phone", label: "landline", input: "08 9123 4567", expected: "891234567" },

  // Email key.
  { kind: "email", label: "display-name form", input: "Customer A <Person.A@Example.com.au>", expected: "person.a@example.com.au" },
  { kind: "email", label: "trimmed and lower-cased", input: "  X.Y@Example.COM ", expected: "x.y@example.com" },
  { kind: "email", label: "our domain", input: "admin@secureworkswa.com.au", expected: null },
  { kind: "email", label: "our tool domain", input: "orders@secureworksgroup.app", expected: null },
  { kind: "email", label: "not an address", input: "unknown sender", expected: null },

  // Address key (adminbucket N2, N3, E7, E10; sites.md semantics).
  { kind: "address", label: "N3 text: 20A Beenan, no type", input: "Acknowledgement BDBPCERT-2026/3018 - 20A Beenan", expected: { key: null, loose: ["20 beenan"] } },
  { kind: "address", label: "N3 job: 20 Beenan Cl", input: "20 Beenan Cl, Karawara", expected: { key: "20 beenan cl", loose: ["20 beenan"] } },
  { kind: "address", label: "N3 letter suffix kept in the exact key", input: "20a Beenan Close, Karawara", expected: { key: "20a beenan cl", loose: ["20 beenan"] } },
  { kind: "address", label: "E10 text: Montane Tn", input: "Fw: 34 Montane Tn, Banksia Grove", expected: { key: "34 montane tn", loose: ["34 montane"] } },
  { kind: "address", label: "E10 job: Montane Turn", input: "34 Montane Turn, Banksia Grove WA 6031", expected: { key: "34 montane tn", loose: ["34 montane"] } },
  { kind: "address", label: "E7 slash form", input: "Re: Fencing Quote and Retaining - 4/6 St Joseph Close Stirling", expected: { key: "4/6 st joseph cl", loose: ["4 st joseph", "6 st joseph"] } },
  { kind: "address", label: "E7 job: 4 St Joseph Cl", input: "4 St Joseph Cl, Stirling", expected: { key: "4 st joseph cl", loose: ["4 st joseph"] } },
  { kind: "address", label: "N2 subject", input: "RFI - BC26/1697 - Application for Building Permit - 14 Bradley Street", expected: { key: "14 bradley st", loose: ["14 bradley"] } },
  { kind: "address", label: "N2 job", input: "14 Bradley St, Yokine", expected: { key: "14 bradley st", loose: ["14 bradley"] } },
  { kind: "address", label: "unit prefix kept", input: "3/20 Smith Street", expected: { key: "3/20 smith st", loose: ["3 smith", "20 smith"] } },
  { kind: "address", label: "street name under 4 letters", input: "12 Ash St", expected: { key: null, loose: null } },
  { kind: "address", label: "no address", input: "Please call me back", expected: { key: null, loose: null } },
];
