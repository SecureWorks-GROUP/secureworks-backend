# Luna door (`ops-api?action=luna_door`)

The one way a local context reader reaches the Luna extraction path. The
Railway worker (secureworks-jarvis `luna-context-worker.ts`) talks to the
database with the service-role key. A reader on the owner's Mac holds no
database key, so it calls this door instead. The door runs the worker's own
database calls server-side, under the service role, and returns what each one
returned. Code: `supabase/functions/ops-api/luna_door.ts`. Tests:
`luna_door_test.ts` (op mapping, refusals, guards, the database binding) and
`luna_door_handler_test.ts` (the real ops-api handler).

It adds no SQL and changes no SQL function. The lane switch, the pass lease,
per-job run ceilings, pacing, the run lease, the 400-a-day model-call cap and
the custody write are all enforced by the same functions the worker calls.

## Who may call it

- **Credential:** `OPS_AGENT_SERVER_KEY` only, as `Authorization: Bearer` or
  `x-api-key`, and it must be the only credential on the request. Refused
  (`403 luna_door_credential_refused`, or the front door's `401`): no key,
  the browser-distributed `SW_API_KEY`, the service-role key, the routine key,
  any signed-in user session, and the agent key presented beside any of them.
  `SW_API_KEY` is deliberately refused: it ships in browser pages, and this
  door writes context facts, spends the shared model-call allowance and reads
  full client message rows.
- **Actor:** `x-sw-actor` is required and must start with `luna-local:` (for
  example `luna-local:claude`, `luna-local:cursor-grok`). It is trusted only
  because the agent key is a server secret (`_shared/request_actor.ts`). It
  lands on the ops-api request log line
  (`[ops-api] action=luna_door ... actor=luna-local:claude actor_source=header`),
  and every refusal logs `[ops-api] luna_door refused actor=... status=... code=...`.
  Anything else is `403 luna_door_actor_refused`.
- **Method:** POST only (`405 luna_door_method`).

## Request and response

```
POST ops-api?action=luna_door
{ "op": "<op>", "args": { ... } }
```

The body may carry only `op` and `args`; each op accepts only its own argument
names (below). An unknown op is `400 luna_door_op_unknown`; an unknown body
field, an unknown argument, a non-uuid id, a bad date, an out-of-range number
or a value outside a closed list is `400 luna_door_args_invalid`. Nothing is
read or written before validation passes. The body is capped at 6 MiB
(`413 luna_door_body_too_large`).

A served op answers `200 { op, data, error }`: `data` and `error` are
supabase-js's own result of that one call, with `error` reduced to
`{ message, code }`. A database refusal (for example the probe's
`luna_job_revision_invalid`) is therefore a `200` with `error` set, exactly as
the worker's own call would see it.

## Ops

Section letters are the Luna call inventory (FM `data/cio-luna-door/contract.md`).
Each op is one fixed call. The attribution phase (section B) is not exposed,
and nor are the brief's business-record reads (D7): a local reader runs with
the brief off.

| op | args | database call | inventory |
|---|---|---|---|
| `lane_enabled` | `lane: "extraction"` | rpc `automation_lane_enabled({lane})` | A1, C1, D8, D12 |
| `claim_pass` | `run_date` | rpc `claim_context_pass({p_run_date})` | A2 |
| `cadence_policy` | none | rpc `context_cadence_policy()` | A3 |
| `renew_pass` | `run_date, lease_token` | rpc `renew_context_pass` | A4, D1 |
| `extraction_candidates` | `limit?` (1..400, default 400) | rpc `context_extraction_candidates({p_limit})` | C2 |
| `revision_rpc_probe` | none | rpc `persist_luna_context_revision` with all nine arguments null (writes nothing) | C3 |
| `feature_flag` | `flag`: `context_job_brief_v1`, `context_job_brief_single_call_v1` or `context_luna_fallback_claude_v1` | `feature_flags` `select enabled` `eq flag_name` `maybeSingle` | C4, C5, D11 |
| `claim_extraction_run` | `job_id, run_date, pass_lease_token` | rpc `claim_context_extraction_run({p_job_id, p_run_date, p_phase: "extraction"})` | D2 |
| `extraction_events` | `job_id, run_id, lease_token, limit?` (1..25, default 25) | rpc `context_extraction_events({p_job_id, p_limit})` | D3 |
| `extraction_event_flags` | `job_id, run_id, lease_token, event_ids` (at most 25 uuids) | rpc `context_extraction_event_flags` | D4 |
| `job_row` | `job_id, run_id, lease_token` | `jobs` `select id,job_number,type,status,site_suburb,ghl_contact_id` `eq id` `single` | D5 |
| `current_facts_page` | `job_id, run_id, lease_token, offset` (multiple of 200, at most 9,800) | `current_job_context_facts` `select *` `eq job_id` `order id, _context_store` `range(offset, offset+199)` | D6 |
| `renew_extraction_run` | `run_id, lease_token` | rpc `renew_context_extraction_run` | D9 |
| `reserve_model_call` | `run_id, lease_token` | rpc `reserve_context_model_call({p_phase: "extraction", p_run_id, p_lease_token})` | D10 |
| `persist_revision` | `run_id, lease_token, job_id, events` (1..25 objects), `new`, `supersedes`, `retracts` (0..200 objects each), `tokens_in` | rpc `persist_luna_context_revision` with `p_extractor_version: "luna_v2"` | D13 |
| `finish_extraction_run` | `run_id, lease_token, status` (`done` or `failed`), `event_ids` (none when failed), `tokens_in, facts_new, facts_superseded, facts_retracted, error?, retry_at?` | rpc `finish_context_extraction_run` | D14 |
| `finish_pass` | `run_date, lease_token, status` (`done` or `failed`), `retry_at?, error?` | rpc `finish_context_pass` | E1 |

`error` values are short codes (`[a-z0-9_.:-]`, at most 120 characters);
`retry_at` is an ISO timestamp.

## The two guards the door adds

Both only narrow; neither changes what a call does.

- **`claim_extraction_run`** first renews the caller's pass
  (`renew_context_pass`; the worker renews before every claim). A caller that
  does not hold the day's pass is `409 luna_door_pass_lease_lost`, so the door
  and the Railway worker can never both be claiming. It then reads
  `tick_max_jobs` and `tick_max_seconds` from `context_cadence_policy()` and
  refuses (`429 luna_door_tick_max_jobs`) when that many extraction runs for
  the date are live or finished inside the last `tick_max_seconds`: the
  server-side form of the worker's per-tick job bound (10 jobs per 300 s
  today).
- **Job-scoped reads** (`extraction_events`, `extraction_event_flags`,
  `job_row`, `current_facts_page`) are served only while the caller holds that
  job's live extraction run (`context_extraction_runs`: that id, lease token
  and job, phase extraction, running, lease unexpired). Otherwise
  `409 luna_door_run_not_held`. A guard read that fails is
  `503 luna_door_guard_unreadable`, never a pass.

The daily cap is not re-implemented: `reserve_model_call` always reserves as
`extraction` against the caller's run and returns the rpc's own
`{outcome: reserved | cap | paused | stale}`. No op spends, refunds or reuses a
reservation any other way.

## A local reader's loop

`lane_enabled` → `claim_pass` (keep its `lease_token`; `renew_pass` every
60 s) → `cadence_policy` → `extraction_candidates` → `revision_rpc_probe` →
per job: `claim_extraction_run` → `extraction_events` → (if any)
`extraction_event_flags`, `job_row`, `current_facts_page` until a short page →
per model call `lane_enabled`, `renew_extraction_run`, `reserve_model_call`
→ `lane_enabled` → `persist_revision` (which finishes the run), or
`finish_extraction_run` for an empty batch or a failure → `finish_pass`.
