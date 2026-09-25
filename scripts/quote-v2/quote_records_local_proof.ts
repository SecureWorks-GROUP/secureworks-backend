// Quote v2 stage 2 local proof: drive the REAL quote-v2 handler against a
// DISPOSABLE LOCAL database that test-quote-records-local.sh prepared, and
// write the party pages it serves. Nothing here reaches production: the
// database URL must be localhost, and no send path exists.
//
//   deno run --allow-run=psql --allow-write --allow-env \
//     scripts/quote-v2/quote_records_local_proof.ts --db-url <url> --out <dir>

import { handleQuoteV2Request } from "../../supabase/functions/quote-v2/handler.ts";

function arg(name: string): string {
  const i = Deno.args.indexOf(name);
  if (i < 0 || !Deno.args[i + 1]) throw new Error(`missing ${name}`);
  return Deno.args[i + 1];
}

const DB_URL = arg("--db-url");
const OUT = arg("--out");
if (
  !/^postgres(ql)?:\/\/([^/?#@]+@)?(127\.0\.0\.1|localhost)(:[0-9]+)?\/[^/?#]+$/
    .test(DB_URL)
) {
  throw new Error("--db-url must be a localhost database");
}

const lit = (v: unknown) =>
  v == null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`;

async function sql(
  query: string,
): Promise<{ out: string; err: string; ok: boolean }> {
  const env = { ...Deno.env.toObject() };
  for (
    const k of [
      "PGHOST",
      "PGHOSTADDR",
      "PGSERVICE",
      "PGPORT",
      "PGDATABASE",
      "PGUSER",
    ]
  ) {
    delete env[k];
  }
  const res = await new Deno.Command("psql", {
    args: [DB_URL, "-X", "-tA", "-v", "ON_ERROR_STOP=1", "-c", query],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    out: new TextDecoder().decode(res.stdout).trim(),
    err: new TextDecoder().decode(res.stderr).trim(),
    ok: res.success,
  };
}

const RPC_SQL: Record<string, (a: Record<string, unknown>) => string> = {
  quote_v2_open_party_link: (a) =>
    `select public.quote_v2_open_party_link(${lit(a.p_token)})`,
  quote_v2_accept: (a) =>
    `select public.quote_v2_accept(${lit(a.p_token)}, ${
      lit(a.p_revision_id)
    }::uuid, ${lit(a.p_content_hash)}, ${lit(a.p_accepted_name)})`,
};

const deps = {
  env: (_: string) => undefined,
  userIdentity: () => Promise.resolve(null),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    const build = RPC_SQL[fn];
    if (!build) throw new Error(`proof has no local mapping for ${fn}`);
    const r = await sql(build(args));
    if (!r.ok) {
      const m = /ERROR:\s+(.*)/.exec(r.err);
      return { data: null, error: { message: m ? m[1] : r.err } };
    }
    return { data: JSON.parse(r.out), error: null };
  },
};

async function token(label: string): Promise<string> {
  const r = await sql(
    `select token from quote_v2_proof_links where label = ${lit(label)}`,
  );
  if (!r.ok || !r.out) throw new Error(`no proof link ${label}`);
  return r.out;
}

const BASE = "http://localhost/functions/v1/quote-v2";
const results: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail: unknown = null) {
  results[name] = ok ? "pass" : { fail: detail };
  if (!ok) console.error(`FAIL ${name}`, detail ?? "");
}

async function open(label: string, file: string) {
  const res = await handleQuoteV2Request(
    new Request(`${BASE}?t=${await token(label)}`),
    deps,
  );
  const html = await res.text();
  await Deno.writeTextFile(`${OUT}/${file}`, html);
  const attr = (n: string) => new RegExp(`data-${n}="([^"]+)"`).exec(html)?.[1];
  return {
    status: res.status,
    html,
    revision: attr("revision"),
    hash: attr("hash"),
  };
}

async function accept(label: string, revision?: string, hash?: string) {
  const res = await handleQuoteV2Request(
    new Request(`${BASE}?action=accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        t: await token(label),
        revision_id: revision,
        content_hash: hash,
        accepted_name: "proof",
      }),
    }),
    deps,
  );
  return { status: res.status, body: await res.json() };
}

await Deno.mkdir(OUT, { recursive: true });

const gwOld = await open("gwelup-client-rev1", "gwelup-client-old-link.html");
check(
  "gwelup: the client's revision 1 link forwards to the client's revision 2",
  gwOld.status === 200 && gwOld.html.includes("This quote was updated") &&
    gwOld.html.includes("Quote for Stephen") &&
    gwOld.html.includes("revision 2") &&
    !gwOld.html.includes("Quote for Fiona"),
);
check(
  "gwelup: each party pays $2,381.50 of $4,763.00",
  gwOld.html.includes("$2,381.50") && gwOld.html.includes("$4,763.00") &&
    gwOld.html.includes("you 50%, Fiona 50%"),
);
const gwN = await open("gwelup-neighbour-rev2", "gwelup-neighbour.html");
check(
  "gwelup: the neighbour's link shows the neighbour's own quote",
  gwN.html.includes("Quote for Fiona") && gwN.html.includes("$2,381.50") &&
    gwN.html.includes("you 50%, Stephen 50%"),
);
const swp = await open("swp-26051-client", "swp-26051.html");
check(
  "SWP-26051: without the double-counted gutter beam, $29,631.23 inc",
  swp.html.includes("$29,631.23") && swp.html.includes("$26,937.48"),
);
const kiko = await open("kiko-client", "kiko.html");
check(
  "Kiko: $5,786.00 inc",
  kiko.html.includes("$5,786.00") && kiko.html.includes("$5,260.00"),
);

const oldNeighbour = await accept(
  "gwelup-neighbour-rev1",
  gwOld.revision
    ? (await sql(
      "select id from quote_v2_revisions where revision_number = 1 and job_id = '00000000-0000-4000-8000-000000261423'",
    )).out
    : undefined,
  "sha256:" + "0".repeat(64),
);
check(
  "gwelup: accepting a replaced revision is refused",
  oldNeighbour.status === 409 &&
    oldNeighbour.body.code === "quote_revision_not_current",
  oldNeighbour,
);
const c = await accept("gwelup-client-rev1", gwOld.revision, gwOld.hash);
check(
  "gwelup: the client accepts the current revision from the old link",
  c.status === 200 && c.body.state === "accepted",
  c,
);
let job = JSON.parse(
  (await sql(
    "select public.quote_v2_job_acceptance('00000000-0000-4000-8000-000000261423')",
  )).out,
);
check(
  "gwelup: one of two parties is not a job acceptance",
  job.fully_accepted === false,
  job,
);
const n = await accept("gwelup-neighbour-rev2", gwN.revision, gwN.hash);
check("gwelup: the neighbour accepts", n.status === 200, n);
job = JSON.parse(
  (await sql(
    "select public.quote_v2_job_acceptance('00000000-0000-4000-8000-000000261423')",
  )).out,
);
check(
  "gwelup: both parties with a share accepted, the job is accepted",
  job.fully_accepted === true,
  job,
);

const kikoStaff = JSON.parse(
  (await sql(
    "select public.quote_v2_staff_revision(public.quote_v2_current_revision('00000000-0000-4000-8000-00000000c1c0'))",
  )).out,
);
await Deno.writeTextFile(
  `${OUT}/kiko-staff.json`,
  JSON.stringify(kikoStaff, null, 2),
);
results.kiko_price_sources = kikoStaff.lines.map((
  l: Record<string, unknown>,
) => ({
  line: l.line_key,
  cost: l.line_cost_ex_gst,
  sell: l.line_sell_ex_gst,
  source: l.price_source,
}));

console.log(JSON.stringify(results, null, 2));
if (
  Object.values(results).some((v) => typeof v === "object" && v && "fail" in v)
) Deno.exit(1);
