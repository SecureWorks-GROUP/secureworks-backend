// Static guard for the switch check files (Follow-up 56): each one stays a
// read. Run: deno test --allow-read scripts/proof/switch-checks/switch-checks_static_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

const here = new URL('.', import.meta.url)
const folders = ['stored-reader', 'draft-register'] as const
const allowedFunctions = new Set([
  'public.job_story_stored_profit_setup',
  'public.job_story_stored_profit_as_at',
  'public.context_job_story_book_stored',
  'public.context_job_story_book_fast',
])
const writeWords = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|LISTEN|NOTIFY|PREPARE|EXECUTE|DISCARD|RESET)\b/i
const writeFunctions = /\b(nextval|setval|set_config|pg_advisory\w*|pg_notify|dblink\w*|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf)\s*\(/i

// Comments, quoted strings and psql meta-command lines carry no SQL to run.
function sqlOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

async function checkFiles(): Promise<Array<{ folder: string; name: string; text: string }>> {
  const out = []
  for (const folder of folders) {
    for await (const entry of Deno.readDir(new URL(`${folder}/`, here))) {
      if (!entry.isFile || !entry.name.endsWith('.sql')) continue
      out.push({ folder, name: entry.name, text: await Deno.readTextFile(new URL(`${folder}/${entry.name}`, here)) })
    }
  }
  return out.sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`))
}

Deno.test('every check includes the shared session first and names itself by folder', async () => {
  const files = await checkFiles()
  assertEquals(files.length, 22)
  for (const f of files) {
    const lines = f.text.split('\n').filter((l) => !l.startsWith('--') && l.trim() !== '')
    const prefix = f.folder.replace('-', '_')
    assert(new RegExp(`^\\\\set zz_check '${prefix}\\.[a-z_]+'$`).test(lines[0]), `${f.name}: first line names the check`)
    assertEquals(lines[1], '\\ir ../session.sql', `${f.name}: second line includes the session`)
  }
})

Deno.test('no check writes, sets anything, or calls a function off the list', async () => {
  for (const f of await checkFiles()) {
    const sql = sqlOnly(f.text)
    assert(!writeWords.test(sql), `${f.folder}/${f.name}: write or session verb ${sql.match(writeWords)?.[0]}`)
    assert(!writeFunctions.test(sql), `${f.folder}/${f.name}: writing function ${sql.match(writeFunctions)?.[0]}`)
    assert(!/\bSET\b/i.test(sql), `${f.folder}/${f.name}: SET`)
    for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const name = `${m[1]}.${m[2]}`.toLowerCase()
      assert(allowedFunctions.has(name), `${f.folder}/${f.name}: calls ${name}`)
    }
  }
})

Deno.test('the session is read only, sees every row and takes one ZZTEST job', async () => {
  const text = await Deno.readTextFile(new URL('session.sql', here))
  const sql = sqlOnly(text)
  assert(text.includes('SET default_transaction_read_only = on;'))
  assert(text.includes("current_setting('transaction_read_only') = 'on'"))
  assert(text.includes('r.rolsuper OR r.rolbypassrls'))
  assertEquals(text.match(/LIKE 'ZZTEST%'/g)?.length, 2)
  assert(text.includes(') = 1 AS zz_one_job'))
  for (const guard of [':zz_read_only', ':zz_sees_all', ':zz_one_job']) {
    const at = text.indexOf(`\\if ${guard}`)
    assert(at > 0, `guard ${guard}`)
    assert(text.slice(at).split('\\endif')[0].includes('\\quit'), `${guard} stops the file`)
  }
  // The only SET is the read-only one; nothing else writes.
  assertEquals(sql.match(/\bSET\b/gi)?.length, 1)
  assert(!writeWords.test(sql.replace('SET default_transaction_read_only = on;', '')))
  assert(!writeFunctions.test(sql))
})

Deno.test('the local test refuses anything but a disposable localhost database', async () => {
  const text = await Deno.readTextFile(new URL('test-local.sh', here))
  assert(text.includes('"$ACK" = "I-confirm-this-is-disposable-local-postgres"'))
  assert(text.includes('postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*) ;;'))
  assert(text.includes('must target localhost'))
  const fixture = await Deno.readTextFile(new URL('fixtures/local-ready.sql', here))
  assert(fixture.startsWith('-- LOCAL TEST FIXTURE ONLY.'))
})
