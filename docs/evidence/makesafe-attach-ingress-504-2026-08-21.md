# MakeSafe attach HTTP 504: pre-runtime ingress evidence

Date: 2026-08-21 UTC

Production project: `kevgrhcjxspbxgovpmfl`

Affected action: `POST /functions/v1/ops-api?action=attach_makesafe_document`

## Verdict

The observed HTTP 504s did not reach the Supabase Edge Function runtime. They
ended in the Cloudflare/Supabase ingress layer before a function deployment or
execution was assigned. The evidence does not implicate the handler's storage
write, database insert, or any downstream call because none of those can run
without an Edge execution.

This was not a direct-to-Storage upload. The caller sent base64 JSON to the
Supabase Functions URL above. A direct Storage transport would use a
`/storage/v1/object/...` URL; no such request was involved in these failures.
Moving the binary to a signed/direct Storage upload and sending only its URL to
`attach_makesafe_document` is a reasonable caller/transport redesign, but it is
a mitigation outside this incident's proven cause, not a demonstrated fix for
the ingress failure.

The repository hardening shipped beside this report removes a bucket-management
call from the PDF hot path and makes active document-row idempotency database
owned. Those are genuine defects, but **they do not fix this production 504**.

## Failure evidence

Supabase's read-only `function_edge_logs` records four matching failures on the
same action. The two SWMS-26980 report attempts are the final two rows:

| Response time (UTC) | PDF bytes | HTTP request bytes | Edge duration | Result |
| --- | ---: | ---: | ---: | --- |
| 2026-08-21 09:10:39 | 2,719,995 | 3,626,826 | 160,057 ms | HTTP 504, empty body |
| 2026-08-21 09:14:59 | 968,933 | 1,292,078 | 160,054 ms | HTTP 504, empty body |

Two earlier requests from the same caller and route show the same boundary:

| Response time (UTC) | HTTP request bytes | Edge duration | Result |
| --- | ---: | ---: | --- |
| 2026-08-21 06:39:12 | 3,877,918 | 160,068 ms | HTTP 504, empty body |
| 2026-08-21 07:08:00 | 10,891,774 | 160,055 ms | HTTP 504, empty body |

Every 504 has the same runtime-negative metadata:

- `deployment_id=null`, `function_id=null`, `version=null`
- `execution_id=null`
- response `server=cloudflare`
- `x_served_by=null` and `x_sb_edge_region=null`
- response `content_length=0`
- Cloudflare ingress `colo=PER`, protocol `HTTP/1.1`

Supabase documents a 150-second request idle timeout that returns HTTP 504 when
no response has started: <https://supabase.com/docs/guides/functions/limits>.
The roughly 160-second edge observations are consistent with that platform
timeout plus gateway overhead. In this incident the null deployment/execution
fields and missing function log show the timer expired before runtime dispatch,
not while this handler was synchronously processing the PDF.

That is materially different from requests that enter the Edge runtime. For
example, the same production action completed two larger request bodies on
2026-08-20:

| Time (UTC) | HTTP request bytes | Duration | Runtime evidence |
| --- | ---: | ---: | --- |
| 2026-08-20 03:03:10 | 5,215,045 | 8,559 ms | execution ID, deployment v1164, `supabase-edge-runtime`, `ap-southeast-1` |
| 2026-08-20 03:09:09 | 5,045,593 | 2,141 ms | execution ID, deployment v1164, `supabase-edge-runtime`, `ap-southeast-1` |

The 1.29 MB failure therefore is not explained by a fixed request-size ceiling:
the action has successfully entered the runtime with requests roughly four
times larger.

## Same-size no-write control

A safe refusal probe used the same action and job/document class, which is
guaranteed to reject before storage or database writes because
`makesafe_report` is forbidden on that report-type job. Its JSON body was
1,292,054 bytes, effectively the same ingress size as the failed 1,292,078-byte
request. It reached the runtime and returned the expected HTTP 400 in 403 ms:

- `execution_id=1e7e3f57-0f53-4921-bbbd-fc92a99a90b8`
- deployment version `1169`
- `x_served_by=supabase-edge-runtime`
- `x_sb_edge_region=ap-southeast-2`

A 77-byte control returned the same refusal in 414 ms with its own execution
ID. The large body itself can therefore traverse ingress when the route is
healthy.

## Runtime-log boundary

The handler logs `[ops-api] action=<action> method=<method>` before it parses a
POST body (`supabase/functions/ops-api/index.ts`, outer request handler). A
read-only `function_logs` query over 09:08:00-09:17:30 UTC found zero
`attach_makesafe_document` action lines covering both 504s. The same query over
the control window returned action lines carrying both control execution IDs.

Together with the null execution metadata, this proves the failed requests died
before the runtime, not inside base64 decode, bucket access, Storage upload, or
the `job_documents` insert.

## Durable-state checks

Read-only production checks after the failures found:

- no `job_documents` `makesafe_report` row for SWMS-26980;
- no Storage object at the attempted
  `job-documents/<job-id>/SWMS-26980-roof-report.pdf` path;
- zero active duplicate `(job_id, type, file_name)` groups across the five typed
  MakeSafe attach classes;
- the `job-documents` bucket already exists, is public, and has no bucket-level
  file-size or MIME allow-list configured.

These checks are consequences and environment facts, not the primary boundary
proof. The null execution/runtime metadata is the decisive evidence.

## Where to route the real fix

The next owner should start with Supabase Support or the platform owner for the
Cloudflare-to-Edge dispatch path. Provide the exact UTC timestamps, project ref,
request content lengths, 160-second durations, `colo=PER`, `HTTP/1.1`, and the
fact that all deployment/execution/runtime identifiers are null. Ask them to
inspect request-body ingestion and function dispatch before execution
assignment, and to explain the intermittent contrast with the same-size control
and larger successful requests.

The caller owner should separately assess a signed/direct Storage upload for
the PDF followed by the existing small URL attach request. That avoids carrying
base64 through the Functions ingress and is the preferred binary transport, but
it spans the external reporting caller and cannot be honestly presented as the
root-cause repair without upstream ingress evidence.

## Reproduction queries (read-only)

Edge metadata was queried through Supabase's GET-only analytics endpoint,
bounded to the incident window:

```sql
select timestamp, event_message, metadata
from function_edge_logs
where event_message like '%attach_makesafe_document%'
order by timestamp;
```

Runtime arrival was checked independently:

```sql
select timestamp, event_message, metadata
from function_logs
where event_message like '%attach_makesafe_document%'
order by timestamp;
```

Database and Storage facts were queried through the Management API database
endpoint with `read_only:true`. No production write, upload, document bind,
invoice mint, authorisation, void, or send was performed during this diagnosis.
