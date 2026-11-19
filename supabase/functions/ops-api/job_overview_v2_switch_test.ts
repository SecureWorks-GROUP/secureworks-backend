// deno-lint-ignore-file no-import-prefix
// Ruling 13: the office job_detail answer carries job_overview_v2_enabled, read
// through readSwitch from the job_overview_v2 row (a missing or unreadable row is
// off), and the switch is seeded off. The Trade App's job detail does not carry it.
// Run: deno test --allow-read supabase/functions/ops-api/job_overview_v2_switch_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const here = new URL(".", import.meta.url);
const index = Deno.readTextFileSync(new URL("index.ts", here));
const FIELD = "    job_overview_v2_enabled: await readSwitch(client, 'job_overview_v2'),\n";

function body(name: string): string {
  const start = index.indexOf(`\nasync function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = index.indexOf("\nasync function ", start + 1);
  return index.slice(start, next < 0 ? undefined : next);
}

Deno.test("office job_detail returns job_overview_v2_enabled from the switch, once", () => {
  assertEquals(index.split(FIELD).length - 1, 1);
  assert(body("jobDetail").includes("    job: jobLite,\n    group_work_order_enabled: await groupFeatureOn(client),\n" + FIELD));
});

Deno.test("the Trade App job detail does not carry job_overview_v2_enabled", () => {
  assertEquals(index.split("job_overview_v2_enabled").length - 1, 1);
});

Deno.test("the switch is seeded off and its down keeps an on row", () => {
  const root = new URL("../../", here);
  const up = Deno.readTextFileSync(new URL("migrations/20261119090800_job_overview_v2_switch.sql", root));
  assert(/VALUES \('job_overview_v2', false,/.test(up));
  assert(up.includes("ON CONFLICT (flag_name) DO NOTHING;"));
  const down = Deno.readTextFileSync(new URL("rollbacks/20261119090800_job_overview_v2_switch_down.sql", root));
  assert(down.includes("WHERE flag_name = 'job_overview_v2' AND enabled = false;"));
});
