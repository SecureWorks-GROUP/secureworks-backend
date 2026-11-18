# Trade self-add (P1-16.12)

`trade_self_add_v1` remains off. This slice installs no database object and turns on no switch. It uses the columns and switch already added by P1-16.11.

- `add_myself_to_job`: POST `{job_id, day?}`, signed-in caller only. Today or an earlier day in the current Perth pay week. One company, an open-for-work job, one booking per person/job/day. A duplicate returns the same booking without writing.
- The booking goes through `createAssignment`, including attendance-cycle binding and ghost observer handling. The server sets installer, self-added and pending acceptance. It changes no job status or customer-system schedule and sends no allocation message. Group enrollment uses the existing guarded clock-enrollment helper and cannot undo a successful booking.
- `jobs_near_me`: GET `lat,lng`, same sign-in and switch. Reads the company coordinate box, keeps the five closest jobs within 1 km, and stores no position. Returns only id, job number, suburb, work type and distance. It reads no customer contact or street address.
- A pending or refused self-booking grants no job-detail access. Search, calendar and personal job lists cannot use it as contact authority. The weekly hours card keeps its clockable assignment and self-added state with a contact-free job. Group discovery hides its customer name until accepted. Existing office and division-manager authority remains separate.
- A failed job, booking or calendar authority read fails visibly. A failed or missing switch reads off. An office or lead acceptance enables the existing allocated tier; a refusal removes that authority. Clock-on still uses ownership of the assignment, including before acceptance.

Prove it locally with:

```sh
deno test --no-check --allow-env --allow-read supabase/functions/ops-api/trade_self_add_test.ts
```

Expected: 10 passed, 0 failed. The focused contract drives the real assignment writer, attendance-cycle binding, clock ownership gate, access resolver and list readers with synthetic rows. It makes no production call and does not prove live deployment or the companion acceptance screens. The self-add, office review and Trade App screens (P1-16.12 to P1-16.15) must all be ready before activation.
