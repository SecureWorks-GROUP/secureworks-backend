# Fence opportunity duplicate mapping evidence

- Snapshot: production, read-only, `2026-07-23T06:15:54Z`.
- Scope: every `jobs` group duplicated on `(org_id, type, ghl_opportunity_id)`.
- Result: **76 groups / 209 rows**: 70 fencing groups / 174 rows and 6 patio groups / 35 rows.
- No client names, addresses, phone numbers, email addresses, or JSON payloads are included.
- Source migration: `supabase/migrations/20260720235959_fence_opportunity_mapping_dedupe.sql`.

## Repo-hygiene follow-up: `public.job_scope` schema drift

`public.job_scope` exists in the live production schema but has **no repository migration** (schema drift). The dedupe migration counts its rows as legacy job-scope artifact evidence, but only through the `public._fence_opportunity_mapping_job_scope_count(uuid)` helper, which returns `0` when `to_regclass('public.job_scope')` is `NULL`. This keeps the migration applying cleanly on fresh migration-provisioned databases where the table is absent, while still tallying live `job_scope` evidence in production. Follow-up: add a repository migration for `public.job_scope` (or confirm and drop it) so the repo and live schema converge. This does not change the documented production winner evidence below, which was snapshotted with `job_scope` present.

## Finding

The population is not mostly empty retry husks. Only **13 rows** meet the strict husk definition: draft, empty scope, empty pricing, no quote/financial/operational/artifact/lifecycle evidence, and at most one event. The other rows contain scoped work, GHL pricing, documents, quotes, invoices, assignments, or lifecycle evidence. **48 groups are genuinely ambiguous** because at least two rows carry quote, financial, or operational relation evidence.

The safe provisional action is to keep the deterministic richest-evidence winner mapped, audit every original mapping, and set only loser `ghl_opportunity_id` values to `NULL`. No job or attached evidence is deleted or merged. A captain can reverse any provisional choice from `fence_opportunity_mapping_audit`.

## Deterministic winner rule

Rows are ordered by this lexicographic evidence vector, descending:

1. breadth across financial, quote, operations, artifact, lifecycle, scope, pricing, and distinct event-type categories;
2. presence and count of financial evidence;
3. quote count;
4. operations count;
5. artifact count;
6. lifecycle count;
7. non-empty scope and pricing;
8. distinct event-type count;
9. for an exact evidence tie, latest `updated_at` with non-empty scope, then latest update/create and UUID.

Raw event volume is reported but does not rank winners because automation created up to thousands of events on individual retry rows.

### Evidence abbreviations

- `F`: Xero invoices/projects, purchase orders, work orders, trade invoice lines, or direct quote/deposit invoice mappings.
- `Q`: quote revisions.
- `O`: assignments, variations, council submissions, run lines, or job contacts.
- `A`: documents, media, scope revisions, or legacy job-scope rows.
- `E`: raw event count / distinct event-type count.
- Scope and pricing values are byte sizes only. `5` is `{}` in PostgreSQL `jsonb` storage.

## Classification totals

| Classification | Rows |
|---|---:|
| `linked_business_record` | 124 |
| `scoped_or_lifecycle_record` | 69 |
| `empty_retry_husk` | 13 |
| `thin_mapping_record` | 3 |

## Ambiguous groups for captain review

Recommendation for every listed case: use the provisional winner shown in the full table, retain all loser jobs untouched except for the audited opportunity unmapping, and manually reverse only if an operator identifies a different canonical job.

| Type | Opportunity | Rich business rows | Provisional winner |
|---|---|---:|---|
| fencing | `1OZEj2jbjXbjO85E03sK` | 2 | `3db9e9c0-1ffd-4503-ba85-41108d912532` (SWF-26401) |
| fencing | `1bPqJdUpRvCEYsTFfbvm` | 2 | `e6620447-1a8e-41cc-8e15-23a9ecbd4ee5` (SWF-26568) |
| fencing | `1jfVZcewnioPm7fQda3W` | 3 | `03ccee27-0fc6-428c-9c55-7b05daf89fb9` (SWF-26470) |
| fencing | `6NDZZpM366s6meIcsAy6` | 2 | `927dfd7a-9b78-4316-988a-2cdb4adde196` (SWF-26873) |
| fencing | `6u74kQsUFI6O05poUpbs` | 2 | `5dd7702b-bb3a-41c4-a387-b9734dabad3d` (SWF-26342) |
| fencing | `7BRwdd0WJDqtKcUeU7cK` | 2 | `f59bebf6-13d2-436e-9a17-a86ffa6df4d0` (SWF-26881) |
| fencing | `8Szxwd6ZOyCnRlO84nuN` | 2 | `27fb99d1-b557-4da2-8588-015547a5ca35` (SWF-26571) |
| fencing | `8WbIj61TZQbTtRgsUOIg` | 2 | `895dbd20-1df1-4862-b183-4795e93961cb` (SWF-26070) |
| fencing | `9K3JCc2dTyMns4UFdC6c` | 3 | `9deb6c9b-076e-4b98-945a-43595ee27e8d` (SWF-26635) |
| fencing | `9cGgHt4S6zR3n9s103wh` | 4 | `1ed8bc74-3e98-4250-8e45-044328e84fb6` (SWF-26162) |
| fencing | `CYemTP8XAOPTr9MP4rdS` | 2 | `a24adb51-b5a4-4ece-a120-dee793deb4cb` (SWF-26119) |
| fencing | `E2Rq6P3BC1ssCikeLdA9` | 2 | `7e11fa17-ff41-4e98-a019-09476c724093` (SWF-26368) |
| fencing | `FBTIsqiN2gAAxINgKCTQ` | 2 | `6ccd6236-0c4e-416b-ab42-e3c6fd3c9b14` (SWF-26356) |
| fencing | `HEccubrtQ5FirJcVD74w` | 3 | `b461c00b-7b0b-4296-a1f2-539cae2bd3bf` (SWF-26380) |
| fencing | `IGlDcw9riLCBoIFRKHsr` | 2 | `f386b1f4-7094-4e9b-822e-73d0b50c53dc` (SWF-26670) |
| fencing | `JSOLTGsCF7qukZrBMyWY` | 3 | `768a13b8-0785-499d-9dc8-7117988f11e8` (SWF-26498) |
| fencing | `Jvo9KaWDvOUr8dzbDSev` | 3 | `434203f0-1334-484f-a9ac-e33c5fc88774` (SWF-26167) |
| fencing | `LHX6bwep7usKuYHPgVcY` | 2 | `81b50396-e1fb-4877-aa13-34f706439cf7` (SWF-26057) |
| fencing | `LZlqklUChAZrPwkEEUTR` | 3 | `702418ec-c087-4442-82ec-89b1b5cfbda8` (SWF-26314) |
| fencing | `MO3Vb0uMGVyVO4Prk4X6` | 2 | `c2506079-bcf2-466a-8461-9e7d872f817f` (SWF-26177) |
| fencing | `Mrkshc5G02ta654XF3UL` | 2 | `a46030a3-a898-4433-997f-98ed25b6b10a` (SWF-26675) |
| fencing | `Q4APzYscfkQa16xtxR4k` | 3 | `ffbe887a-0ebf-45d7-9b13-fec71a7055c1` (SWF-26060) |
| fencing | `SVs9T60EPXC3Jdyoi3Kd` | 2 | `43f181f3-8241-41e6-9e73-cc5903c01090` (SWF-26385) |
| fencing | `SipaNUyqmGm8ZgH6jtCF` | 2 | `b843350a-9d74-4834-ab26-06f86c860275` (SWF-26600) |
| fencing | `T5iWnkpAyR6Mvc5Buwri` | 2 | `e2a3838d-502e-46b1-8b83-b5f651c28cca` (SWF-26624) |
| fencing | `Uy2ve6VdHlFXd0t2fqdZ` | 2 | `21baad95-e5a0-4a7b-9f7c-39fea91abe62` (SWF-26492) |
| fencing | `V5wVpmALKk00ALTl9lLI` | 2 | `71e95ee4-1028-4b0d-9201-d287f7a6d7a8` (SWF-26614) |
| fencing | `VpQB11mLIOhuvnF4Wt9N` | 2 | `9e23d5ac-b495-4edb-9541-28962c2c46f8` (SWF-26085) |
| fencing | `Wp9n8UDJ8NO2e2WiKZXl` | 4 | `7550b8a7-92f2-4865-a222-76915f3a4683` (SWF-26695) |
| fencing | `Wpbzvh2KLHbLSLlpELQ3` | 4 | `a40c3931-bb5d-44eb-9952-095356aca738` (SWF-26330) |
| fencing | `ZuAqELfloKkPp2wmDbWf` | 2 | `ff21f64b-4055-436a-b73d-c3f50c20ce43` (SWF-26545) |
| fencing | `a5yHXaKm6Fq5GAw0tl7m` | 3 | `3287572b-7b9a-415b-8175-3389bfe8519c` (SWF-26649) |
| fencing | `am1MItsY6B6vvp4bN89m` | 2 | `3ec2c834-6076-4777-8227-5f2403d312c6` (SWF-26174) |
| fencing | `bSsxwM6blIqo2wRR5KZM` | 2 | `9d7d5056-fbb8-4496-809c-c8ff879eae3f` (SWF-26326) |
| fencing | `cabvgxafzp25BaHEpFda` | 2 | `438b5b52-c5f9-4e71-9703-8b725328b09f` (SWF-26460) |
| fencing | `cqvBvTid22qvjBLc7AdK` | 3 | `faf794e5-aaa1-4d82-9416-d7d8a6818c96` (SWF-26551) |
| fencing | `gBkQrVJla8vjHHyQz20N` | 2 | `7efcf5b0-29fb-485d-a981-e47aff56c281` (SWF-26392) |
| fencing | `jaG8WpJrsGFZ4HHyAQNX` | 2 | `2f6f15d0-8826-4188-8fc8-88ebd73fd59b` (SWF-26110) |
| fencing | `lKEUe2F51VgEzUgGcYN0` | 2 | `76fb74b0-ed2b-46d4-854b-e0e5eb306594` (SWF-26541) |
| fencing | `sY8EsJrGVjiWiz1MgjAB` | 2 | `2b16f829-6043-4533-9f88-c572ac196d2b` (SWF-26029) |
| fencing | `seXHsRvUk39hPf23Hdiv` | 2 | `b59824dd-1a20-426e-8514-c1be9a95849b` (SWF-26082) |
| fencing | `szSPnOh6nq5Orz2RJI3U` | 2 | `a2b7aacc-93f2-403f-a934-50d910fc6387` (SWF-26548) |
| fencing | `xMdGXsHwlmmbND1n1kQX` | 3 | `e7c944a2-62e0-4953-a0b4-24c79f47c58f` (SWF-26475) |
| fencing | `xrubpIzV04L8pI0Yn2LE` | 2 | `e3ee3c16-796a-4711-a430-3bf5a5b8a569` (SWF-26764) |
| fencing | `yVp0pS0k2lii63fS4BjP` | 2 | `c230b1ab-17cf-4e3a-b228-1d7852152bd8` (SWF-26605) |
| fencing | `zvtzmarOjGIMNzZ1NlqR` | 2 | `68e2e301-aa3a-4d5d-9924-d907643e1cba` (SWF-26075) |
| patio | `F93lPc4Rz7GOddmOpfpX` | 2 | `476ba779-9573-440b-8e8f-0327289db13f` (SWP-26235) |
| patio | `IZkEmNWWb1JGsynhTKx8` | 2 | `6f2b2f6a-5840-482b-b14b-8d295eb37403` (SWP-26031) |

## Full evidence table

| Type | Opportunity | Action | Classification | Job | Number | Status | Scope bytes | Pricing bytes | F | Q | O | A | Lifecycle | E | Rank |
|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| fencing | `07NxcthXpjTeAgP0FG5f` | **KEEP** | `linked_business_record` | `88411259-ee12-412e-a12f-ff0454a8d6cf` | SWF-26664 | quoted | 18277 | 1272 | 0 | 1 | 2 | 3 | 3 | 5/4 | `7,0,0,1,2,3,3,1,1,4` |
| fencing | `07NxcthXpjTeAgP0FG5f` | unmap | `thin_mapping_record` | `40aa9e5d-a0aa-4103-a1cb-f56fad6f4390` | SWF-26665 | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 3/2 | `1,0,0,0,0,0,0,0,0,2` |
| fencing | `1OZEj2jbjXbjO85E03sK` | **KEEP** | `linked_business_record` | `3db9e9c0-1ffd-4503-ba85-41108d912532` | SWF-26401 | quoted | 24884 | 1487 | 0 | 1 | 0 | 2 | 2 | 19/4 | `6,0,0,1,0,2,2,1,1,4` |
| fencing | `1OZEj2jbjXbjO85E03sK` | unmap | `linked_business_record` | `facfe1ec-c53d-48e8-bab7-ab48de5ebb1a` | SWF-26400 | quoted | 23972 | 1454 | 0 | 1 | 0 | 1 | 2 | 22/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `1bPqJdUpRvCEYsTFfbvm` | **KEEP** | `linked_business_record` | `e6620447-1a8e-41cc-8e15-23a9ecbd4ee5` | SWF-26568 | awaiting_deposit | 6055 | 1395 | 3 | 1 | 2 | 3 | 5 | 30/12 | `8,1,3,1,2,3,5,1,1,12` |
| fencing | `1bPqJdUpRvCEYsTFfbvm` | unmap | `linked_business_record` | `09023546-2c8b-4bb9-bfab-71271d1e0c56` | SWF-26569 | awaiting_deposit | 8635 | 1112 | 3 | 1 | 0 | 2 | 5 | 24/9 | `7,1,3,1,0,2,5,1,1,9` |
| fencing | `1jfVZcewnioPm7fQda3W` | **KEEP** | `linked_business_record` | `03ccee27-0fc6-428c-9c55-7b05daf89fb9` | SWF-26470 | scheduled | 1278340 | 1263 | 2 | 1 | 1 | 1 | 5 | 40/9 | `8,1,2,1,1,1,5,1,1,9` |
| fencing | `1jfVZcewnioPm7fQda3W` | unmap | `linked_business_record` | `3c3262c6-894d-40fc-afda-18f3a8802b70` | SWF-26473 | scheduled | 22012 | 1374 | 4 | 1 | 0 | 5 | 6 | 40/12 | `7,1,4,1,0,5,6,1,1,12` |
| fencing | `1jfVZcewnioPm7fQda3W` | unmap | `linked_business_record` | `6af83055-8656-4b0d-a2f9-39d0997fb5ce` | SWF-26472 | scheduled | 1617120 | 1289 | 2 | 1 | 0 | 2 | 5 | 19/9 | `7,1,2,1,0,2,5,1,1,9` |
| fencing | `2NnVZBIl0a6JbxPkEKRc` | **KEEP** | `scoped_or_lifecycle_record` | `e209e016-b754-41f0-adbd-68617ad7d7f7` | SWF-26058 | cancelled | 21116 | 1081 | 0 | 0 | 0 | 4 | 1 | 194/4 | `5,0,0,0,0,4,1,1,1,4` |
| fencing | `2NnVZBIl0a6JbxPkEKRc` | unmap | `scoped_or_lifecycle_record` | `1f4901d3-7a92-46cb-9d48-9232c8a865fc` | none | cancelled | 84044 | 81 | 0 | 0 | 0 | 1 | 1 | 16/2 | `5,0,0,0,0,1,1,1,1,2` |
| fencing | `3wBCFWw3xi4CL5yZfVyI` | **KEEP** | `linked_business_record` | `fdaf168d-9a0a-4d3c-962a-e2e7b7418718` | SWF-26371 | quoted | 1737508 | 1288 | 0 | 1 | 0 | 1 | 2 | 28/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `3wBCFWw3xi4CL5yZfVyI` | unmap | `scoped_or_lifecycle_record` | `ab7ba054-c540-460b-92b7-3e6d83d5baee` | none | complete | 5 | 81 | 0 | 0 | 0 | 0 | 5 | 0/0 | `2,0,0,0,0,0,5,0,1,0` |
| fencing | `4w0QB4dA0t8FnFYyG6uK` | **KEEP** | `scoped_or_lifecycle_record` | `0be2083e-0394-47a2-8085-7b02f3d7c81f` | SWF-25031 | quoted | 1713512 | 1015 | 0 | 0 | 0 | 10 | 2 | 46/3 | `5,0,0,0,0,10,2,1,1,3` |
| fencing | `4w0QB4dA0t8FnFYyG6uK` | unmap | `scoped_or_lifecycle_record` | `8e4a8d33-aacf-40b1-97d4-b997dd8ca7bb` | SWF-26063 | draft | 160253 | 1391 | 0 | 0 | 0 | 2 | 0 | 15/4 | `4,0,0,0,0,2,0,1,1,4` |
| fencing | `4w0QB4dA0t8FnFYyG6uK` | unmap | `scoped_or_lifecycle_record` | `bf7d061b-3a6a-4b43-8688-9cc2c96a7528` | SWF-26062 | draft | 212572 | 5 | 0 | 0 | 0 | 1 | 0 | 18/2 | `3,0,0,0,0,1,0,1,0,2` |
| fencing | `52M29SiTI58D9HRhuW1e` | **KEEP** | `scoped_or_lifecycle_record` | `b0e94292-189d-4405-ac58-c12704125f92` | SWF-26352 | draft | 3068 | 1542 | 0 | 0 | 0 | 0 | 0 | 7/2 | `3,0,0,0,0,0,0,1,1,2` |
| fencing | `52M29SiTI58D9HRhuW1e` | unmap | `scoped_or_lifecycle_record` | `563068e9-40c4-46b0-8d00-6524d7cab4ed` | SWF-26209 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `6NDZZpM366s6meIcsAy6` | **KEEP** | `linked_business_record` | `927dfd7a-9b78-4316-988a-2cdb4adde196` | SWF-26873 | quoted | 1697132 | 1380 | 0 | 1 | 0 | 5 | 3 | 18/5 | `6,0,0,1,0,5,3,1,1,5` |
| fencing | `6NDZZpM366s6meIcsAy6` | unmap | `linked_business_record` | `6a112912-7a08-4705-9193-278db7b26a65` | SWF-26874 | quoted | 33308 | 1364 | 0 | 1 | 0 | 3 | 2 | 12/4 | `6,0,0,1,0,3,2,1,1,4` |
| fencing | `6u74kQsUFI6O05poUpbs` | **KEEP** | `linked_business_record` | `5dd7702b-bb3a-41c4-a387-b9734dabad3d` | SWF-26342 | quoted | 74604 | 1508 | 0 | 1 | 0 | 1 | 2 | 16/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `6u74kQsUFI6O05poUpbs` | unmap | `linked_business_record` | `95aa826f-db83-44d1-a9b9-50bbbbe39f94` | SWF-26341 | quoted | 146576 | 1551 | 0 | 1 | 0 | 1 | 2 | 25/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `7BRwdd0WJDqtKcUeU7cK` | **KEEP** | `linked_business_record` | `f59bebf6-13d2-436e-9a17-a86ffa6df4d0` | SWF-26881 | awaiting_deposit | 65152 | 1504 | 2 | 0 | 1 | 6 | 5 | 1670/8 | `7,1,2,0,1,6,5,1,1,8` |
| fencing | `7BRwdd0WJDqtKcUeU7cK` | unmap | `linked_business_record` | `4c38dc41-1dea-4513-b9fb-b150714ef53a` | SWF-26798 | quoted | 20515 | 1472 | 0 | 1 | 0 | 3 | 3 | 11/5 | `6,0,0,1,0,3,3,1,1,5` |
| fencing | `7OfQtqbnPUhCzlHTlqF7` | **KEEP** | `linked_business_record` | `7752dcfb-c6ab-48f3-b666-d4246eea761b` | SWF-26317 | archived | 58764 | 1240 | 5 | 0 | 2 | 8 | 6 | 321/13 | `7,1,5,0,2,8,6,1,1,13` |
| fencing | `7OfQtqbnPUhCzlHTlqF7` | unmap | `scoped_or_lifecycle_record` | `50c2d8a7-054b-445e-847c-ba62b12b3dc9` | SWF-26196 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `8Szxwd6ZOyCnRlO84nuN` | **KEEP** | `linked_business_record` | `27fb99d1-b557-4da2-8588-015547a5ca35` | SWF-26571 | awaiting_deposit | 5923 | 1090 | 2 | 1 | 0 | 2 | 5 | 18/9 | `7,1,2,1,0,2,5,1,1,9` |
| fencing | `8Szxwd6ZOyCnRlO84nuN` | unmap | `linked_business_record` | `9ad01bd4-d4a9-4a3c-9680-d758f00b8e49` | SWF-26570 | quoted | 5524 | 1208 | 0 | 1 | 0 | 2 | 3 | 10/5 | `6,0,0,1,0,2,3,1,1,5` |
| fencing | `8WbIj61TZQbTtRgsUOIg` | **KEEP** | `linked_business_record` | `895dbd20-1df1-4862-b183-4795e93961cb` | SWF-26070 | archived | 75488 | 1282 | 4 | 0 | 2 | 11 | 6 | 1910/16 | `7,1,4,0,2,11,6,1,1,16` |
| fencing | `8WbIj61TZQbTtRgsUOIg` | unmap | `linked_business_record` | `c6821a89-4738-4f82-adc9-2f48c506d148` | SWF-25010 | archived | 1602 | 592 | 1 | 0 | 0 | 6 | 3 | 327/5 | `6,1,1,0,0,6,3,1,1,5` |
| fencing | `8WbIj61TZQbTtRgsUOIg` | unmap | `scoped_or_lifecycle_record` | `fc429427-84d1-4d8e-b13e-6570bd9f6d5e` | none | complete | 1632 | 79 | 0 | 0 | 0 | 1 | 4 | 1104/2 | `5,0,0,0,0,1,4,1,1,2` |
| fencing | `9K3JCc2dTyMns4UFdC6c` | **KEEP** | `linked_business_record` | `9deb6c9b-076e-4b98-945a-43595ee27e8d` | SWF-26635 | quoted | 1852054 | 1292 | 0 | 1 | 2 | 1 | 2 | 14/3 | `7,0,0,1,2,1,2,1,1,3` |
| fencing | `9K3JCc2dTyMns4UFdC6c` | unmap | `linked_business_record` | `d9d104fb-a71b-4361-b76d-5f77b1ce5299` | SWF-26636 | quoted | 16126 | 1311 | 0 | 1 | 0 | 4 | 3 | 8/4 | `6,0,0,1,0,4,3,1,1,4` |
| fencing | `9K3JCc2dTyMns4UFdC6c` | unmap | `linked_business_record` | `3e33a2d2-f071-4736-b442-924b83f79d57` | SWF-26637 | quoted | 21482 | 1312 | 0 | 1 | 0 | 3 | 3 | 7/5 | `6,0,0,1,0,3,3,1,1,5` |
| fencing | `9cGgHt4S6zR3n9s103wh` | **KEEP** | `linked_business_record` | `1ed8bc74-3e98-4250-8e45-044328e84fb6` | SWF-26162 | in_progress | 103720 | 1382 | 4 | 1 | 3 | 17 | 6 | 84/14 | `8,1,4,1,3,17,6,1,1,14` |
| fencing | `9cGgHt4S6zR3n9s103wh` | unmap | `linked_business_record` | `6ab74b35-8c6b-44f4-81b6-bc6c92984927` | SWF-26331 | quoted | 9424 | 1096 | 3 | 1 | 0 | 1 | 4 | 65/6 | `7,1,3,1,0,1,4,1,1,6` |
| fencing | `9cGgHt4S6zR3n9s103wh` | unmap | `linked_business_record` | `69a54cd1-6004-4b6e-a13c-7e6e240edf55` | SWF-26166 | awaiting_deposit | 39108 | 1112 | 2 | 1 | 0 | 5 | 5 | 21/9 | `7,1,2,1,0,5,5,1,1,9` |
| fencing | `9cGgHt4S6zR3n9s103wh` | unmap | `linked_business_record` | `c52a13cb-41b1-4fff-9118-64b77e132d11` | SWF-26165 | quoted | 48588 | 1218 | 0 | 1 | 0 | 1 | 2 | 8/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `CMOJnuTlBmkYUsGGugfG` | **KEEP** | `linked_business_record` | `68a3b89e-bfff-41bb-821f-8db4d1e1da1b` | SWF-26623 | quoted | 1722020 | 1414 | 0 | 1 | 0 | 1 | 2 | 18/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `CMOJnuTlBmkYUsGGugfG` | unmap | `scoped_or_lifecycle_record` | `33705381-7355-4b96-8651-10a4629e2ac2` | none | quoted | 5 | 81 | 0 | 0 | 0 | 0 | 3 | 0/0 | `2,0,0,0,0,0,3,0,1,0` |
| fencing | `CYemTP8XAOPTr9MP4rdS` | **KEEP** | `linked_business_record` | `a24adb51-b5a4-4ece-a120-dee793deb4cb` | SWF-26119 | archived | 1475860 | 1915 | 10 | 0 | 8 | 15 | 7 | 1499/14 | `7,1,10,0,8,15,7,1,1,14` |
| fencing | `CYemTP8XAOPTr9MP4rdS` | unmap | `linked_business_record` | `730b6d4e-66b7-4535-9777-f9341587ec26` | none | quoted | 5 | 5 | 1 | 0 | 0 | 0 | 3 | 0/0 | `2,1,1,0,0,0,3,0,0,0` |
| fencing | `CmYEq1iQmZBRPmFpy44x` | **KEEP** | `scoped_or_lifecycle_record` | `bcaa4480-5ca2-4d2e-a422-ab347248bd8a` | SWF-26076 | quoted | 143615 | 1539 | 0 | 0 | 0 | 2 | 2 | 35/4 | `5,0,0,0,0,2,2,1,1,4` |
| fencing | `CmYEq1iQmZBRPmFpy44x` | unmap | `scoped_or_lifecycle_record` | `ef753617-7318-402f-8e44-b08b52979843` | SWF-26077 | draft | 27519 | 1411 | 0 | 0 | 0 | 1 | 1 | 11/3 | `5,0,0,0,0,1,1,1,1,3` |
| fencing | `E2Rq6P3BC1ssCikeLdA9` | **KEEP** | `linked_business_record` | `7e11fa17-ff41-4e98-a019-09476c724093` | SWF-26368 | invoiced | 1456184 | 1417 | 6 | 1 | 1 | 4 | 6 | 91/14 | `8,1,6,1,1,4,6,1,1,14` |
| fencing | `E2Rq6P3BC1ssCikeLdA9` | unmap | `linked_business_record` | `486bb7ce-b67a-462f-bfa8-eea0260a8ac2` | SWF-26079 | archived | 126416 | 1377 | 5 | 0 | 6 | 4 | 7 | 399/14 | `7,1,5,0,6,4,7,1,1,14` |
| fencing | `FBTIsqiN2gAAxINgKCTQ` | **KEEP** | `linked_business_record` | `6ccd6236-0c4e-416b-ab42-e3c6fd3c9b14` | SWF-26356 | quoted | 217996 | 1486 | 0 | 1 | 0 | 15 | 3 | 20/5 | `6,0,0,1,0,15,3,1,1,5` |
| fencing | `FBTIsqiN2gAAxINgKCTQ` | unmap | `linked_business_record` | `ff736b06-11a1-4270-8dc7-eaf4d3b70c46` | SWF-26357 | quoted | 121980 | 1316 | 0 | 1 | 0 | 9 | 3 | 18/6 | `6,0,0,1,0,9,3,1,1,6` |
| fencing | `GkKbmzJ3AGDaU00TKMgS` | **KEEP** | `linked_business_record` | `7b2b44f8-347b-43d1-9aa9-1f7bb105e01e` | SWF-26128 | quoted | 108420 | 1518 | 0 | 0 | 2 | 1 | 2 | 63/2 | `6,0,0,0,2,1,2,1,1,2` |
| fencing | `GkKbmzJ3AGDaU00TKMgS` | unmap | `scoped_or_lifecycle_record` | `cf555227-4e9c-4c7f-8656-f05ae8da07ec` | SWF-26132 | draft | 113564 | 1400 | 0 | 0 | 0 | 0 | 0 | 14/2 | `3,0,0,0,0,0,0,1,1,2` |
| fencing | `HEccubrtQ5FirJcVD74w` | **KEEP** | `linked_business_record` | `b461c00b-7b0b-4296-a1f2-539cae2bd3bf` | SWF-26380 | invoiced | 1984320 | 1516 | 4 | 1 | 1 | 22 | 6 | 38/14 | `8,1,4,1,1,22,6,1,1,14` |
| fencing | `HEccubrtQ5FirJcVD74w` | unmap | `linked_business_record` | `37357a62-1360-4bfc-be9b-b2a1a3e0390a` | SWF-26466 | archived | 934468 | 1375 | 2 | 1 | 0 | 1 | 6 | 36/8 | `7,1,2,1,0,1,6,1,1,8` |
| fencing | `HEccubrtQ5FirJcVD74w` | unmap | `linked_business_record` | `b9ec536e-9a4a-4759-b263-e17e6a02e291` | SWF-26499 | quoted | 1712937 | 1381 | 2 | 1 | 0 | 1 | 2 | 11/4 | `7,1,2,1,0,1,2,1,1,4` |
| fencing | `IGlDcw9riLCBoIFRKHsr` | **KEEP** | `linked_business_record` | `f386b1f4-7094-4e9b-822e-73d0b50c53dc` | SWF-26670 | quoted | 37916 | 1407 | 0 | 1 | 2 | 7 | 2 | 36/3 | `7,0,0,1,2,7,2,1,1,3` |
| fencing | `IGlDcw9riLCBoIFRKHsr` | unmap | `linked_business_record` | `cd38c7fb-e662-4c4f-a870-ddc1983a4613` | SWF-26799 | quoted | 37008 | 1438 | 0 | 1 | 0 | 5 | 2 | 13/4 | `6,0,0,1,0,5,2,1,1,4` |
| fencing | `JSOLTGsCF7qukZrBMyWY` | **KEEP** | `linked_business_record` | `768a13b8-0785-499d-9dc8-7117988f11e8` | SWF-26498 | scheduled | 1370656 | 1373 | 6 | 1 | 1 | 3 | 6 | 39/13 | `8,1,6,1,1,3,6,1,1,13` |
| fencing | `JSOLTGsCF7qukZrBMyWY` | unmap | `linked_business_record` | `c88d0769-a821-4be0-94cc-4db338cf0699` | SWF-26403 | quoted | 1451836 | 1385 | 1 | 1 | 0 | 2 | 3 | 30/5 | `7,1,1,1,0,2,3,1,1,5` |
| fencing | `JSOLTGsCF7qukZrBMyWY` | unmap | `linked_business_record` | `b4432481-1a08-44cd-b9e7-7895b2887cb4` | SWF-26404 | quoted | 1121104 | 1385 | 0 | 1 | 0 | 2 | 3 | 37/5 | `6,0,0,1,0,2,3,1,1,5` |
| fencing | `JSOLTGsCF7qukZrBMyWY` | unmap | `scoped_or_lifecycle_record` | `9654f0fe-7315-47ee-a629-5d94df414127` | SWF-26402 | draft | 1126183 | 1355 | 0 | 0 | 0 | 1 | 1 | 7/3 | `5,0,0,0,0,1,1,1,1,3` |
| fencing | `JvZfEY025fcydTGJLBYd` | **KEEP** | `linked_business_record` | `e2ef7be3-9b30-4d2b-805a-19ec8b697906` | SWF-26397 | quoted | 1786952 | 1378 | 0 | 1 | 0 | 1 | 2 | 38/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `JvZfEY025fcydTGJLBYd` | unmap | `empty_retry_husk` | `5be6ebdd-3f31-4f75-827d-da10ab2edad2` | SWF-26398 | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| fencing | `Jvo9KaWDvOUr8dzbDSev` | **KEEP** | `linked_business_record` | `434203f0-1334-484f-a9ac-e33c5fc88774` | SWF-26167 | quoted | 1086248 | 1747 | 0 | 1 | 3 | 12 | 3 | 11/5 | `7,0,0,1,3,12,3,1,1,5` |
| fencing | `Jvo9KaWDvOUr8dzbDSev` | unmap | `linked_business_record` | `513ad042-ef49-4141-b6b5-de727227e8da` | SWF-26168 | quoted | 91272 | 1283 | 0 | 1 | 0 | 1 | 2 | 25/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `Jvo9KaWDvOUr8dzbDSev` | unmap | `linked_business_record` | `bc788208-89a6-4620-b037-74ccab6bf549` | none | complete | 5 | 81 | 3 | 0 | 0 | 0 | 5 | 0/0 | `3,1,3,0,0,0,5,0,1,0` |
| fencing | `KU0jbTgMXlwwXj0O1NSB` | **KEEP** | `scoped_or_lifecycle_record` | `26e87dcc-847d-4593-bf57-87f3552d3d9a` | SWF-26065 | quoted | 48472 | 1329 | 0 | 0 | 0 | 1 | 2 | 24/3 | `5,0,0,0,0,1,2,1,1,3` |
| fencing | `KU0jbTgMXlwwXj0O1NSB` | unmap | `scoped_or_lifecycle_record` | `c91fc29f-ea61-4f0c-805e-8f5a8444f5ce` | none | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `LHX6bwep7usKuYHPgVcY` | **KEEP** | `linked_business_record` | `81b50396-e1fb-4877-aa13-34f706439cf7` | SWF-26057 | archived | 106830 | 1615 | 7 | 0 | 4 | 19 | 6 | 389/18 | `7,1,7,0,4,19,6,1,1,18` |
| fencing | `LHX6bwep7usKuYHPgVcY` | unmap | `linked_business_record` | `16f7fdfd-2961-4630-9bdd-ce555d386fc4` | SWF-26370 | archived | 14700 | 1292 | 2 | 1 | 0 | 2 | 6 | 25/8 | `7,1,2,1,0,2,6,1,1,8` |
| fencing | `LHX6bwep7usKuYHPgVcY` | unmap | `scoped_or_lifecycle_record` | `67612b00-7f86-4ac3-8929-92e3d76dd6f5` | none | draft | 1348152 | 5 | 0 | 0 | 0 | 1 | 0 | 10/2 | `3,0,0,0,0,1,0,1,0,2` |
| fencing | `LZlqklUChAZrPwkEEUTR` | **KEEP** | `linked_business_record` | `702418ec-c087-4442-82ec-89b1b5cfbda8` | SWF-26314 | quoted | 744497 | 1406 | 0 | 1 | 0 | 14 | 2 | 23/6 | `6,0,0,1,0,14,2,1,1,6` |
| fencing | `LZlqklUChAZrPwkEEUTR` | unmap | `linked_business_record` | `a034f855-c9aa-4e25-9131-bf515816c75a` | SWF-26315 | quoted | 725996 | 1406 | 0 | 1 | 0 | 11 | 2 | 13/4 | `6,0,0,1,0,11,2,1,1,4` |
| fencing | `LZlqklUChAZrPwkEEUTR` | unmap | `linked_business_record` | `2c856b39-8c92-4bb6-b208-479b295e6123` | SWF-26316 | quoted | 624201 | 1494 | 0 | 1 | 0 | 10 | 2 | 33/6 | `6,0,0,1,0,10,2,1,1,6` |
| fencing | `MO3Vb0uMGVyVO4Prk4X6` | **KEEP** | `linked_business_record` | `c2506079-bcf2-466a-8461-9e7d872f817f` | SWF-26177 | archived | 205748 | 1672 | 6 | 1 | 18 | 56 | 6 | 706/18 | `8,1,6,1,18,56,6,1,1,18` |
| fencing | `MO3Vb0uMGVyVO4Prk4X6` | unmap | `linked_business_record` | `49dca268-b8e1-4042-a2a6-c43f96099dfa` | SWF-26179 | scheduled | 34101 | 1296 | 7 | 0 | 1 | 2 | 3 | 225/6 | `7,1,7,0,1,2,3,1,1,6` |
| fencing | `MfUsYJFVZ9KKfKMKKH40` | **KEEP** | `linked_business_record` | `851896ce-0d0e-4ae8-accb-08d44d608e5a` | SWF-26041 | archived | 1620368 | 1849 | 22 | 0 | 7 | 1 | 5 | 579/18 | `7,1,22,0,7,1,5,1,1,18` |
| fencing | `MfUsYJFVZ9KKfKMKKH40` | unmap | `scoped_or_lifecycle_record` | `c015ffb1-b9fb-4c23-bf8f-99d7dd8b977a` | none | complete | 5 | 81 | 0 | 0 | 0 | 0 | 4 | 1/1 | `3,0,0,0,0,0,4,0,1,1` |
| fencing | `Mrkshc5G02ta654XF3UL` | **KEEP** | `linked_business_record` | `a46030a3-a898-4433-997f-98ed25b6b10a` | SWF-26675 | quoted | 1842025 | 1484 | 0 | 1 | 4 | 1 | 2 | 3/3 | `7,0,0,1,4,1,2,1,1,3` |
| fencing | `Mrkshc5G02ta654XF3UL` | unmap | `linked_business_record` | `7ed91b44-9c2c-4d99-8ffb-7bb19ec5382a` | SWF-26676 | quoted | 1842872 | 1484 | 0 | 1 | 0 | 5 | 3 | 12/5 | `6,0,0,1,0,5,3,1,1,5` |
| fencing | `NZxZfLQcjxSOLF3CrCmS` | **KEEP** | `linked_business_record` | `1fb2f0fe-e8cb-4529-8480-1aa82354ef4e` | SWF-26321 | quoted | 1892764 | 1404 | 0 | 1 | 0 | 3 | 2 | 24/6 | `6,0,0,1,0,3,2,1,1,6` |
| fencing | `NZxZfLQcjxSOLF3CrCmS` | unmap | `scoped_or_lifecycle_record` | `76faa931-3aa4-418e-9caf-e82c2566b6ef` | SWF-26202 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `Q4APzYscfkQa16xtxR4k` | **KEEP** | `linked_business_record` | `ffbe887a-0ebf-45d7-9b13-fec71a7055c1` | SWF-26060 | draft | 34763 | 1401 | 1 | 0 | 0 | 2 | 1 | 11/4 | `6,1,1,0,0,2,1,1,1,4` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `linked_business_record` | `12989e18-787e-49de-94fe-a120dbbdd26c` | SWF-26036 | quoted | 81516 | 1702 | 0 | 0 | 2 | 2 | 1 | 14/7 | `6,0,0,0,2,2,1,1,1,7` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `linked_business_record` | `673b544c-bfbf-4823-a558-2cd44e356bbf` | SWF-26027 | quoted | 1952288 | 1160 | 0 | 0 | 2 | 1 | 1 | 15/5 | `6,0,0,0,2,1,1,1,1,5` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `scoped_or_lifecycle_record` | `2edc965c-1eea-4649-97a8-86a7896028ee` | SWF-26061 | draft | 57120 | 1376 | 0 | 0 | 0 | 2 | 1 | 13/5 | `5,0,0,0,0,2,1,1,1,5` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `scoped_or_lifecycle_record` | `e59884f1-c730-4db6-9809-5aa91a5fe109` | SWF-26059 | quoted | 32823 | 79 | 0 | 0 | 0 | 1 | 2 | 20/2 | `5,0,0,0,0,1,2,1,1,2` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `scoped_or_lifecycle_record` | `94cb1205-78b3-477b-8307-5758c18149ef` | none | draft | 1462 | 5 | 0 | 0 | 0 | 1 | 0 | 51/2 | `3,0,0,0,0,1,0,1,0,2` |
| fencing | `Q4APzYscfkQa16xtxR4k` | unmap | `empty_retry_husk` | `b4477a4c-bdeb-4f87-be82-f0eb75464e9f` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| fencing | `Rn0DqbdPlgF64yJjeEmR` | **KEEP** | `scoped_or_lifecycle_record` | `27029aa1-5850-400a-869d-f1bfd88be033` | SWF-26161 | quoted | 1838385 | 1344 | 0 | 0 | 0 | 18 | 2 | 16/2 | `5,0,0,0,0,18,2,1,1,2` |
| fencing | `Rn0DqbdPlgF64yJjeEmR` | unmap | `scoped_or_lifecycle_record` | `d126bcdb-0a93-405b-a21e-2af1e2adc936` | SWF-26164 | draft | 2168 | 737 | 0 | 0 | 0 | 0 | 0 | 94/2 | `3,0,0,0,0,0,0,1,1,2` |
| fencing | `SUjLvkq3lq9ithLddlfj` | **KEEP** | `scoped_or_lifecycle_record` | `a823b68d-bfb5-4dd8-8912-6b1893934899` | SWF-26028 | quoted | 81368 | 1147 | 0 | 0 | 0 | 1 | 1 | 70/6 | `5,0,0,0,0,1,1,1,1,6` |
| fencing | `SUjLvkq3lq9ithLddlfj` | unmap | `scoped_or_lifecycle_record` | `22d9585a-c52a-46e8-9b59-3117474451b9` | none | cancelled | 1710 | 85 | 0 | 0 | 0 | 1 | 1 | 3/2 | `5,0,0,0,0,1,1,1,1,2` |
| fencing | `SVs9T60EPXC3Jdyoi3Kd` | **KEEP** | `linked_business_record` | `43f181f3-8241-41e6-9e73-cc5903c01090` | SWF-26385 | quoted | 1336920 | 1558 | 0 | 1 | 0 | 2 | 3 | 30/5 | `6,0,0,1,0,2,3,1,1,5` |
| fencing | `SVs9T60EPXC3Jdyoi3Kd` | unmap | `linked_business_record` | `43c09f19-0072-4a27-81ea-eaa1ad788dbe` | SWF-26386 | quoted | 1311512 | 1484 | 0 | 1 | 0 | 1 | 2 | 38/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `SipaNUyqmGm8ZgH6jtCF` | **KEEP** | `linked_business_record` | `b843350a-9d74-4834-ab26-06f86c860275` | SWF-26600 | lost | 20017 | 1254 | 0 | 1 | 0 | 3 | 3 | 15/6 | `6,0,0,1,0,3,3,1,1,6` |
| fencing | `SipaNUyqmGm8ZgH6jtCF` | unmap | `linked_business_record` | `449705ac-0d98-4b45-9ded-9ba6ee3aea66` | SWF-26601 | lost | 17870 | 1314 | 0 | 1 | 0 | 3 | 3 | 15/6 | `6,0,0,1,0,3,3,1,1,6` |
| fencing | `T5iWnkpAyR6Mvc5Buwri` | **KEEP** | `linked_business_record` | `e2a3838d-502e-46b1-8b83-b5f651c28cca` | SWF-26624 | in_progress | 1681648 | 1588 | 6 | 1 | 4 | 7 | 6 | 64/11 | `8,1,6,1,4,7,6,1,1,11` |
| fencing | `T5iWnkpAyR6Mvc5Buwri` | unmap | `linked_business_record` | `3ba3bc16-66be-47f6-bd0d-ec0c29975a34` | SWF-26382 | quoted | 1480096 | 1397 | 0 | 1 | 0 | 1 | 2 | 30/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `Uy2ve6VdHlFXd0t2fqdZ` | **KEEP** | `linked_business_record` | `21baad95-e5a0-4a7b-9f7c-39fea91abe62` | SWF-26492 | lost | 1385720 | 1268 | 0 | 1 | 0 | 3 | 3 | 27/6 | `6,0,0,1,0,3,3,1,1,6` |
| fencing | `Uy2ve6VdHlFXd0t2fqdZ` | unmap | `linked_business_record` | `06e36fe0-08ae-440a-a816-04237796cc2c` | SWF-26493 | lost | 1736928 | 1286 | 0 | 1 | 0 | 2 | 3 | 17/6 | `6,0,0,1,0,2,3,1,1,6` |
| fencing | `Uy2ve6VdHlFXd0t2fqdZ` | unmap | `scoped_or_lifecycle_record` | `047d3b26-3ff0-4ac3-86b5-886d3cd9b700` | SWF-26494 | draft | 17172 | 1104 | 0 | 0 | 0 | 1 | 0 | 6/2 | `4,0,0,0,0,1,0,1,1,2` |
| fencing | `V5wVpmALKk00ALTl9lLI` | **KEEP** | `linked_business_record` | `71e95ee4-1028-4b0d-9201-d287f7a6d7a8` | SWF-26614 | awaiting_supplier | 20531 | 1551 | 3 | 1 | 2 | 11 | 7 | 38/16 | `8,1,3,1,2,11,7,1,1,16` |
| fencing | `V5wVpmALKk00ALTl9lLI` | unmap | `linked_business_record` | `25067ceb-bb79-4756-9b0c-0d5dcccff4b9` | none | complete | 5 | 5 | 3 | 0 | 0 | 0 | 5 | 0/0 | `2,1,3,0,0,0,5,0,0,0` |
| fencing | `VpQB11mLIOhuvnF4Wt9N` | **KEEP** | `linked_business_record` | `9e23d5ac-b495-4edb-9541-28962c2c46f8` | SWF-26085 | archived | 81459 | 1109 | 3 | 0 | 3 | 2 | 5 | 47/11 | `7,1,3,0,3,2,5,1,1,11` |
| fencing | `VpQB11mLIOhuvnF4Wt9N` | unmap | `linked_business_record` | `0c0ddfb8-b5d3-484c-8fd5-b992edad9f5d` | none | cancelled | 5 | 81 | 11 | 0 | 0 | 0 | 4 | 32/4 | `4,1,11,0,0,0,4,0,1,4` |
| fencing | `VpQB11mLIOhuvnF4Wt9N` | unmap | `scoped_or_lifecycle_record` | `333d5d97-7dec-4814-aaac-1ee516534e39` | SWF-26068 | draft | 83168 | 1320 | 0 | 0 | 0 | 2 | 0 | 44/6 | `4,0,0,0,0,2,0,1,1,6` |
| fencing | `WClBkVEjSqcT4kpKP228` | **KEEP** | `scoped_or_lifecycle_record` | `760e543c-21d6-4d3a-95a8-960001be1eed` | SWF-26105 | quoted | 38636 | 1396 | 0 | 0 | 0 | 6 | 2 | 38/6 | `5,0,0,0,0,6,2,1,1,6` |
| fencing | `WClBkVEjSqcT4kpKP228` | unmap | `scoped_or_lifecycle_record` | `f0dd38b7-9638-4eee-8331-57bc08a7d112` | SWF-26104 | quoted | 37480 | 1386 | 0 | 0 | 0 | 4 | 2 | 30/4 | `5,0,0,0,0,4,2,1,1,4` |
| fencing | `Wp9n8UDJ8NO2e2WiKZXl` | **KEEP** | `linked_business_record` | `7550b8a7-92f2-4865-a222-76915f3a4683` | SWF-26695 | archived | 2286470 | 1387 | 6 | 1 | 1 | 11 | 6 | 29/15 | `8,1,6,1,1,11,6,1,1,15` |
| fencing | `Wp9n8UDJ8NO2e2WiKZXl` | unmap | `linked_business_record` | `d0ab0583-b47e-4f6d-ad2c-a26bb0566c03` | SWF-26054 | archived | 96660 | 1353 | 2 | 0 | 2 | 1 | 7 | 67/8 | `7,1,2,0,2,1,7,1,1,8` |
| fencing | `Wp9n8UDJ8NO2e2WiKZXl` | unmap | `linked_business_record` | `e3a0c46c-fc2c-4b13-aef4-9fbe54d50423` | SWF-26388 | quoted | 188072 | 1444 | 0 | 1 | 0 | 1 | 2 | 46/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `Wp9n8UDJ8NO2e2WiKZXl` | unmap | `linked_business_record` | `1a1db322-9a51-4c72-ba0c-e88e7827c849` | none | complete | 5 | 81 | 1 | 0 | 0 | 0 | 3 | 1/1 | `4,1,1,0,0,0,3,0,1,1` |
| fencing | `Wpbzvh2KLHbLSLlpELQ3` | **KEEP** | `linked_business_record` | `a40c3931-bb5d-44eb-9952-095356aca738` | SWF-26330 | quoted | 2103372 | 1571 | 0 | 1 | 0 | 3 | 2 | 85/5 | `6,0,0,1,0,3,2,1,1,5` |
| fencing | `Wpbzvh2KLHbLSLlpELQ3` | unmap | `linked_business_record` | `03265dc2-4690-4e72-88ab-efa78b775803` | SWF-26191 | quoted | 1916312 | 1309 | 0 | 1 | 0 | 3 | 2 | 24/4 | `6,0,0,1,0,3,2,1,1,4` |
| fencing | `Wpbzvh2KLHbLSLlpELQ3` | unmap | `linked_business_record` | `30809adb-c3b1-487d-946d-dde132980f1e` | SWF-26190 | quoted | 17056 | 1334 | 0 | 1 | 0 | 1 | 2 | 16/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `Wpbzvh2KLHbLSLlpELQ3` | unmap | `linked_business_record` | `e24d2dc9-94bd-4751-b875-1f6b5275e1a1` | SWF-26189 | quoted | 1992612 | 1282 | 0 | 1 | 0 | 1 | 2 | 20/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `ZRBND0Tz7JHWA6gs3lQt` | **KEEP** | `scoped_or_lifecycle_record` | `a1464beb-3ca4-4fd6-a247-8f9d6e1b2cfa` | SWF-26097 | quoted | 1730472 | 1474 | 0 | 0 | 0 | 8 | 3 | 29/6 | `5,0,0,0,0,8,3,1,1,6` |
| fencing | `ZRBND0Tz7JHWA6gs3lQt` | unmap | `scoped_or_lifecycle_record` | `56d01013-d82d-41f4-b7b8-ec517a4d28a2` | SWF-26096 | quoted | 98308 | 1494 | 0 | 0 | 0 | 8 | 2 | 27/4 | `5,0,0,0,0,8,2,1,1,4` |
| fencing | `ZuAqELfloKkPp2wmDbWf` | **KEEP** | `linked_business_record` | `ff21f64b-4055-436a-b73d-c3f50c20ce43` | SWF-26545 | quoted | 16967 | 1546 | 0 | 1 | 0 | 5 | 3 | 14/5 | `6,0,0,1,0,5,3,1,1,5` |
| fencing | `ZuAqELfloKkPp2wmDbWf` | unmap | `linked_business_record` | `055e36ac-65e2-4dfa-85c4-6ff81b288af6` | SWF-26544 | quoted | 15764 | 1496 | 0 | 1 | 0 | 4 | 3 | 20/4 | `6,0,0,1,0,4,3,1,1,4` |
| fencing | `a5yHXaKm6Fq5GAw0tl7m` | **KEEP** | `linked_business_record` | `3287572b-7b9a-415b-8175-3389bfe8519c` | SWF-26649 | quoted | 929074 | 1504 | 0 | 1 | 4 | 1 | 2 | 32/3 | `7,0,0,1,4,1,2,1,1,3` |
| fencing | `a5yHXaKm6Fq5GAw0tl7m` | unmap | `linked_business_record` | `48a77614-db38-43ab-8d94-c5ac1f01ed91` | SWF-26650 | quoted | 925868 | 1356 | 0 | 1 | 0 | 3 | 3 | 32/5 | `6,0,0,1,0,3,3,1,1,5` |
| fencing | `a5yHXaKm6Fq5GAw0tl7m` | unmap | `linked_business_record` | `3d6e5a33-fe26-423d-be40-0d56c1098d18` | SWF-26500 | quoted | 1809832 | 1486 | 0 | 1 | 0 | 1 | 2 | 22/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `am1MItsY6B6vvp4bN89m` | **KEEP** | `linked_business_record` | `3ec2c834-6076-4777-8227-5f2403d312c6` | SWF-26174 | archived | 1004327 | 1278 | 2 | 1 | 1 | 7 | 6 | 81/17 | `8,1,2,1,1,7,6,1,1,17` |
| fencing | `am1MItsY6B6vvp4bN89m` | unmap | `linked_business_record` | `b10ee3c9-976c-4db1-8717-6cf5c891c1da` | none | quoted | 5 | 81 | 4 | 0 | 0 | 0 | 3 | 0/0 | `3,1,4,0,0,0,3,0,1,0` |
| fencing | `bSsxwM6blIqo2wRR5KZM` | **KEEP** | `linked_business_record` | `9d7d5056-fbb8-4496-809c-c8ff879eae3f` | SWF-26326 | archived | 76243 | 1281 | 6 | 1 | 2 | 9 | 7 | 46/16 | `8,1,6,1,2,9,7,1,1,16` |
| fencing | `bSsxwM6blIqo2wRR5KZM` | unmap | `linked_business_record` | `d73ea4d4-1f00-41f8-8fa0-7ba7e3e00780` | SWF-26327 | quoted | 29104 | 1682 | 0 | 1 | 0 | 8 | 2 | 36/6 | `6,0,0,1,0,8,2,1,1,6` |
| fencing | `bSsxwM6blIqo2wRR5KZM` | unmap | `thin_mapping_record` | `39edcd66-fb06-458b-b338-453993b63b8a` | SWF-26325 | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 5/2 | `1,0,0,0,0,0,0,0,0,2` |
| fencing | `cabvgxafzp25BaHEpFda` | **KEEP** | `linked_business_record` | `438b5b52-c5f9-4e71-9703-8b725328b09f` | SWF-26460 | quoted | 28175 | 1432 | 0 | 1 | 0 | 2 | 3 | 18/5 | `6,0,0,1,0,2,3,1,1,5` |
| fencing | `cabvgxafzp25BaHEpFda` | unmap | `linked_business_record` | `f6355186-82ec-4f2a-b49d-278798a07be1` | SWF-26461 | quoted | 43768 | 1519 | 0 | 1 | 0 | 1 | 2 | 18/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `cqvBvTid22qvjBLc7AdK` | **KEEP** | `linked_business_record` | `faf794e5-aaa1-4d82-9416-d7d8a6818c96` | SWF-26551 | archived | 1866784 | 1414 | 4 | 1 | 2 | 3 | 7 | 38/15 | `8,1,4,1,2,3,7,1,1,15` |
| fencing | `cqvBvTid22qvjBLc7AdK` | unmap | `linked_business_record` | `5164763c-42a9-4262-a33d-1c028f53551b` | SWF-26553 | archived | 5860 | 1234 | 6 | 1 | 0 | 4 | 7 | 84/15 | `7,1,6,1,0,4,7,1,1,15` |
| fencing | `cqvBvTid22qvjBLc7AdK` | unmap | `linked_business_record` | `99dd7abe-686f-4a8a-8bdf-1b4671f95927` | SWF-26552 | draft | 2579 | 1396 | 1 | 0 | 0 | 0 | 0 | 2/2 | `4,1,1,0,0,0,0,1,1,2` |
| fencing | `cvhh8xOkLER69zx4buZv` | **KEEP** | `scoped_or_lifecycle_record` | `3c09918a-8e73-495c-8ca3-667f9a9fae0d` | SWF-26323 | draft | 1176593 | 1489 | 0 | 0 | 0 | 1 | 0 | 24/2 | `4,0,0,0,0,1,0,1,1,2` |
| fencing | `cvhh8xOkLER69zx4buZv` | unmap | `scoped_or_lifecycle_record` | `c155b145-dfc3-4b98-8c21-8c36547a2f60` | SWF-26205 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `f4iQAKMEVWyYxKTI3CHS` | **KEEP** | `linked_business_record` | `0d0d3ab0-213b-4cd2-9680-0d15bee6ea94` | SWF-26049 | archived | 1692287 | 1632 | 3 | 0 | 2 | 2 | 6 | 537/12 | `7,1,3,0,2,2,6,1,1,12` |
| fencing | `f4iQAKMEVWyYxKTI3CHS` | unmap | `scoped_or_lifecycle_record` | `5804daab-6ad9-46b7-8192-84ef1e673e34` | none | in_progress | 5 | 81 | 0 | 0 | 0 | 0 | 3 | 0/0 | `2,0,0,0,0,0,3,0,1,0` |
| fencing | `g9JRubjfRPxuEqYlGTqR` | **KEEP** | `scoped_or_lifecycle_record` | `f9cf4eeb-b1a4-419e-8033-b9c9a9d865fa` | SWF-26135 | quoted | 1539096 | 1396 | 0 | 0 | 0 | 3 | 3 | 12/4 | `5,0,0,0,0,3,3,1,1,4` |
| fencing | `g9JRubjfRPxuEqYlGTqR` | unmap | `scoped_or_lifecycle_record` | `9f9ebe81-7390-4e80-8b1d-4252ba6402f8` | SWF-26137 | quoted | 8037 | 1539 | 0 | 0 | 0 | 2 | 3 | 12/5 | `5,0,0,0,0,2,3,1,1,5` |
| fencing | `g9JRubjfRPxuEqYlGTqR` | unmap | `scoped_or_lifecycle_record` | `24e6b7f9-ac7a-42d3-9c7b-d37c4327e1ac` | SWF-26136 | quoted | 7855 | 1430 | 0 | 0 | 0 | 2 | 2 | 18/4 | `5,0,0,0,0,2,2,1,1,4` |
| fencing | `gBkQrVJla8vjHHyQz20N` | **KEEP** | `linked_business_record` | `7efcf5b0-29fb-485d-a981-e47aff56c281` | SWF-26392 | in_progress | 958708 | 1405 | 8 | 1 | 4 | 9 | 7 | 95/16 | `8,1,8,1,4,9,7,1,1,16` |
| fencing | `gBkQrVJla8vjHHyQz20N` | unmap | `linked_business_record` | `223229da-18d7-4b84-919c-b8e935c9769d` | SWF-26391 | accepted | 1892616 | 1408 | 0 | 1 | 3 | 16 | 4 | 15/5 | `7,0,0,1,3,16,4,1,1,5` |
| fencing | `gBkQrVJla8vjHHyQz20N` | unmap | `scoped_or_lifecycle_record` | `c7126c40-390c-49c6-aae2-de3a77d723f3` | SWF-26390 | draft | 1758348 | 1599 | 0 | 0 | 0 | 0 | 0 | 2/2 | `3,0,0,0,0,0,0,1,1,2` |
| fencing | `jaG8WpJrsGFZ4HHyAQNX` | **KEEP** | `linked_business_record` | `2f6f15d0-8826-4188-8fc8-88ebd73fd59b` | SWF-26110 | archived | 84408 | 1437 | 3 | 0 | 4 | 4 | 7 | 146/11 | `7,1,3,0,4,4,7,1,1,11` |
| fencing | `jaG8WpJrsGFZ4HHyAQNX` | unmap | `linked_business_record` | `6283bdb0-21cd-4a0f-9d7f-7160bb2041a5` | SWF-26111 | lost | 86192 | 1473 | 2 | 0 | 0 | 6 | 3 | 23/4 | `6,1,2,0,0,6,3,1,1,4` |
| fencing | `lKEUe2F51VgEzUgGcYN0` | **KEEP** | `linked_business_record` | `76fb74b0-ed2b-46d4-854b-e0e5eb306594` | SWF-26541 | awaiting_deposit | 1813748 | 1397 | 2 | 1 | 0 | 2 | 5 | 25/10 | `7,1,2,1,0,2,5,1,1,10` |
| fencing | `lKEUe2F51VgEzUgGcYN0` | unmap | `linked_business_record` | `8207ebfe-e3e3-4d8a-b78d-ddaacc338e92` | SWF-26543 | quoted | 114992 | 1388 | 1 | 1 | 0 | 10 | 3 | 13/5 | `7,1,1,1,0,10,3,1,1,5` |
| fencing | `lKEUe2F51VgEzUgGcYN0` | unmap | `scoped_or_lifecycle_record` | `a1878d8f-51be-45cf-b9b3-7f9578986115` | SWF-26542 | draft | 1767 | 853 | 0 | 0 | 0 | 0 | 0 | 3/2 | `3,0,0,0,0,0,0,1,1,2` |
| fencing | `s7O2DyZRVBxdIoPUysLE` | **KEEP** | `linked_business_record` | `63537766-936f-4002-aecf-7fb5a74038a1` | SWF-26362 | quoted | 74336 | 1323 | 0 | 1 | 0 | 1 | 2 | 37/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `s7O2DyZRVBxdIoPUysLE` | unmap | `scoped_or_lifecycle_record` | `4c46ca3b-6568-4b09-a7bf-d2e315ca178c` | SWF-26197 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `sY8EsJrGVjiWiz1MgjAB` | **KEEP** | `linked_business_record` | `2b16f829-6043-4533-9f88-c572ac196d2b` | SWF-26029 | archived | 74243 | 1347 | 5 | 0 | 2 | 4 | 5 | 88/17 | `7,1,5,0,2,4,5,1,1,17` |
| fencing | `sY8EsJrGVjiWiz1MgjAB` | unmap | `linked_business_record` | `28ded283-93f7-48fe-8f8e-51da47db8dd7` | SWF-26025 | quoted | 2350912 | 2498 | 0 | 0 | 5 | 3 | 1 | 225/8 | `6,0,0,0,5,3,1,1,1,8` |
| fencing | `seXHsRvUk39hPf23Hdiv` | **KEEP** | `linked_business_record` | `b59824dd-1a20-426e-8514-c1be9a95849b` | SWF-26082 | archived | 74944 | 1511 | 1 | 0 | 3 | 5 | 3 | 83/11 | `7,1,1,0,3,5,3,1,1,11` |
| fencing | `seXHsRvUk39hPf23Hdiv` | unmap | `linked_business_record` | `5f6c9c12-e4ff-43a4-89e3-cb921dd6df4d` | none | quoted | 5 | 81 | 2 | 0 | 0 | 0 | 4 | 31/4 | `4,1,2,0,0,0,4,0,1,4` |
| fencing | `szSPnOh6nq5Orz2RJI3U` | **KEEP** | `linked_business_record` | `a2b7aacc-93f2-403f-a934-50d910fc6387` | SWF-26548 | quoted | 1549996 | 1528 | 0 | 1 | 0 | 13 | 2 | 32/6 | `6,0,0,1,0,13,2,1,1,6` |
| fencing | `szSPnOh6nq5Orz2RJI3U` | unmap | `linked_business_record` | `691debff-065e-4f69-8e10-b8de6fed485a` | SWF-26549 | quoted | 78760 | 1427 | 0 | 1 | 0 | 8 | 2 | 21/4 | `6,0,0,1,0,8,2,1,1,4` |
| fencing | `tLrwiYaQfqcq0uQMn1Zp` | **KEEP** | `scoped_or_lifecycle_record` | `e0879446-d854-47e7-9e8c-b1c085471f9b` | none | quoted | 1945733 | 81 | 0 | 0 | 0 | 1 | 2 | 74/3 | `5,0,0,0,0,1,2,1,1,3` |
| fencing | `tLrwiYaQfqcq0uQMn1Zp` | unmap | `scoped_or_lifecycle_record` | `5c60f1fe-0edb-4e7b-b103-486c24508492` | SWF-26156 | draft | 1858866 | 1356 | 0 | 0 | 0 | 8 | 0 | 2/2 | `4,0,0,0,0,8,0,1,1,2` |
| fencing | `vkkbf6hWWYdv7pys1ep7` | **KEEP** | `linked_business_record` | `01fe98e5-d2a2-46a5-97fa-afd7d6727733` | SWF-26351 | quoted | 1576932 | 1609 | 0 | 1 | 0 | 1 | 2 | 44/4 | `6,0,0,1,0,1,2,1,1,4` |
| fencing | `vkkbf6hWWYdv7pys1ep7` | unmap | `scoped_or_lifecycle_record` | `51c6f748-78ca-4846-af40-293f7b3870df` | SWF-26319 | draft | 5 | 5 | 0 | 0 | 0 | 2 | 0 | 13/2 | `2,0,0,0,0,2,0,0,0,2` |
| fencing | `vkkbf6hWWYdv7pys1ep7` | unmap | `scoped_or_lifecycle_record` | `80df7865-595a-455b-8c9c-45c0d9e09dcb` | SWF-26318 | draft | 5 | 5 | 0 | 0 | 0 | 1 | 0 | 22/2 | `2,0,0,0,0,1,0,0,0,2` |
| fencing | `vkkbf6hWWYdv7pys1ep7` | unmap | `scoped_or_lifecycle_record` | `ade4fcf2-120f-42f7-bfa5-87497b3ca896` | SWF-26203 | draft | 5 | 81 | 0 | 0 | 0 | 0 | 0 | 0/0 | `1,0,0,0,0,0,0,0,1,0` |
| fencing | `vkkbf6hWWYdv7pys1ep7` | unmap | `thin_mapping_record` | `9e7e6b71-2152-4509-801f-24d2f47d5cf6` | SWF-26350 | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 4/2 | `1,0,0,0,0,0,0,0,0,2` |
| fencing | `xMdGXsHwlmmbND1n1kQX` | **KEEP** | `linked_business_record` | `e7c944a2-62e0-4953-a0b4-24c79f47c58f` | SWF-26475 | quoted | 17696 | 1263 | 0 | 1 | 0 | 9 | 2 | 18/4 | `6,0,0,1,0,9,2,1,1,4` |
| fencing | `xMdGXsHwlmmbND1n1kQX` | unmap | `linked_business_record` | `6a3a9b9b-2b11-4564-91a6-a609a94a8c99` | SWF-26616 | quoted | 5313 | 1282 | 0 | 1 | 0 | 4 | 2 | 10/6 | `6,0,0,1,0,4,2,1,1,6` |
| fencing | `xMdGXsHwlmmbND1n1kQX` | unmap | `linked_business_record` | `728b7966-a31f-4908-b701-567f7f9ab5cd` | SWF-26617 | quoted | 5410 | 1259 | 0 | 1 | 0 | 3 | 3 | 12/5 | `6,0,0,1,0,3,3,1,1,5` |
| fencing | `xrubpIzV04L8pI0Yn2LE` | **KEEP** | `linked_business_record` | `e3ee3c16-796a-4711-a430-3bf5a5b8a569` | SWF-26764 | archived | 2097512 | 1477 | 6 | 1 | 3 | 5 | 6 | 43/15 | `8,1,6,1,3,5,6,1,1,15` |
| fencing | `xrubpIzV04L8pI0Yn2LE` | unmap | `linked_business_record` | `36b67a15-50b7-48a7-b508-3e13df3f571c` | SWF-26765 | quoted | 23596 | 1238 | 1 | 1 | 2 | 5 | 3 | 17/4 | `8,1,1,1,2,5,3,1,1,4` |
| fencing | `y2cDdk4cHzwGq4r4hmS2` | **KEEP** | `scoped_or_lifecycle_record` | `7016013e-e38f-41d4-802d-a8b08a20a399` | SWF-26108 | quoted | 71028 | 1362 | 0 | 0 | 0 | 8 | 2 | 37/6 | `5,0,0,0,0,8,2,1,1,6` |
| fencing | `y2cDdk4cHzwGq4r4hmS2` | unmap | `scoped_or_lifecycle_record` | `edc9635f-3a9f-40a3-8db1-7700be905c96` | none | cancelled | 5 | 81 | 0 | 0 | 0 | 0 | 1 | 0/0 | `2,0,0,0,0,0,1,0,1,0` |
| fencing | `yVp0pS0k2lii63fS4BjP` | **KEEP** | `linked_business_record` | `c230b1ab-17cf-4e3a-b228-1d7852152bd8` | SWF-26605 | quoted | 6800 | 1389 | 0 | 1 | 0 | 3 | 3 | 18/5 | `6,0,0,1,0,3,3,1,1,5` |
| fencing | `yVp0pS0k2lii63fS4BjP` | unmap | `linked_business_record` | `7c18e21b-c1d9-4760-b74f-bd7ceee53d07` | SWF-26573 | quoted | 1859296 | 1379 | 0 | 1 | 0 | 2 | 3 | 13/5 | `6,0,0,1,0,2,3,1,1,5` |
| fencing | `zvtzmarOjGIMNzZ1NlqR` | **KEEP** | `linked_business_record` | `68e2e301-aa3a-4d5d-9924-d907643e1cba` | SWF-26075 | archived | 86668 | 1853 | 15 | 0 | 9 | 8 | 5 | 127/13 | `7,1,15,0,9,8,5,1,1,13` |
| fencing | `zvtzmarOjGIMNzZ1NlqR` | unmap | `linked_business_record` | `8ad5bc77-50e5-48b6-bff7-34a7234b977d` | SWF-26078 | archived | 73133 | 1661 | 7 | 0 | 8 | 13 | 6 | 63/12 | `7,1,7,0,8,13,6,1,1,12` |
| fencing | `zvtzmarOjGIMNzZ1NlqR` | unmap | `scoped_or_lifecycle_record` | `72b9ac3c-a6bd-412f-a903-64d70d329393` | none | quoted | 2588 | 904 | 0 | 0 | 0 | 0 | 2 | 39/3 | `4,0,0,0,0,0,2,1,1,3` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | **KEEP** | `scoped_or_lifecycle_record` | `3d6868b1-3a39-4e15-945f-708547299e5b` | SWP-26021 | cancelled | 3399 | 1495 | 0 | 0 | 0 | 6 | 4 | 124/5 | `5,0,0,0,0,6,4,1,1,5` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `ccb5a023-193a-4bbf-98aa-4945522019d9` | none | cancelled | 3075 | 1309 | 0 | 0 | 0 | 1 | 1 | 24/2 | `5,0,0,0,0,1,1,1,1,2` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `25c19089-ac61-4557-8209-a488f187e35a` | none | cancelled | 3191 | 1467 | 0 | 0 | 0 | 1 | 1 | 817/2 | `5,0,0,0,0,1,1,1,1,2` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `a23048b9-50a7-4a26-9cc2-3f6eb9f05af5` | none | cancelled | 3009 | 1498 | 0 | 0 | 0 | 1 | 1 | 151/2 | `5,0,0,0,0,1,1,1,1,2` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `9bb6e295-d2d2-4b1a-8aec-7fa65f5d81e6` | none | cancelled | 3009 | 1498 | 0 | 0 | 0 | 1 | 1 | 10/2 | `5,0,0,0,0,1,1,1,1,2` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `a8cc1a96-0a08-424f-9e4b-d9a30bbdddcb` | none | cancelled | 5 | 5 | 0 | 0 | 0 | 0 | 1 | 1/1 | `2,0,0,0,0,0,1,0,0,1` |
| patio | `AzkjMPu8v9hhYAa6uLJq` | unmap | `scoped_or_lifecycle_record` | `7049dd26-baa3-47b6-9263-597064c96d76` | none | cancelled | 5 | 5 | 0 | 0 | 0 | 0 | 1 | 1/1 | `2,0,0,0,0,0,1,0,0,1` |
| patio | `F93lPc4Rz7GOddmOpfpX` | **KEEP** | `linked_business_record` | `476ba779-9573-440b-8e8f-0327289db13f` | SWP-26235 | archived | 4402 | 1845 | 7 | 0 | 3 | 55 | 3 | 13/7 | `7,1,7,0,3,55,3,1,1,7` |
| patio | `F93lPc4Rz7GOddmOpfpX` | unmap | `linked_business_record` | `82b0a623-8c2b-49ec-a6ba-49bb9512418c` | SWP-26358 | archived | 5 | 199 | 4 | 0 | 0 | 3 | 5 | 22/7 | `5,1,4,0,0,3,5,0,1,7` |
| patio | `IZkEmNWWb1JGsynhTKx8` | **KEEP** | `linked_business_record` | `6f2b2f6a-5840-482b-b14b-8d295eb37403` | SWP-26031 | awaiting_supplier | 3203 | 1404 | 4 | 0 | 1 | 20 | 5 | 210/15 | `7,1,4,0,1,20,5,1,1,15` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `scoped_or_lifecycle_record` | `75abe3a6-653d-4a70-9e39-62f798a3e0bb` | SWP-26032 | draft | 3687 | 1644 | 0 | 0 | 0 | 5 | 0 | 30/7 | `4,0,0,0,0,5,0,1,1,7` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `scoped_or_lifecycle_record` | `d0bda60d-29ec-4e81-9cee-9c27dc1f68c7` | none | draft | 3210 | 1596 | 0 | 0 | 0 | 1 | 0 | 12/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `scoped_or_lifecycle_record` | `c48d58db-13b4-4830-8ad0-54691be4b2ee` | none | draft | 3141 | 1596 | 0 | 0 | 0 | 1 | 0 | 3/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `scoped_or_lifecycle_record` | `8a701ec6-81ae-4106-92d5-5d6c49133189` | none | draft | 3126 | 1498 | 0 | 0 | 0 | 1 | 0 | 158/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `linked_business_record` | `60ec8dee-34b8-4900-9d94-784faf32dcc1` | none | draft | 5 | 81 | 1 | 0 | 0 | 0 | 0 | 0/0 | `2,1,1,0,0,0,0,0,1,0` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `empty_retry_husk` | `8402b585-9754-435d-b5f0-eac83290b16f` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `empty_retry_husk` | `1c937320-3d28-43c9-a522-5d894c6daa48` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `empty_retry_husk` | `bfa9778f-3407-49ae-a694-7f5fc3ed958b` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `IZkEmNWWb1JGsynhTKx8` | unmap | `empty_retry_husk` | `ccae3c8e-e32f-4a94-b3fc-e3f8e9781d1a` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | **KEEP** | `scoped_or_lifecycle_record` | `69c63992-b911-4cec-ab1e-5a008d4c5bb9` | SWP-26026 | quoted | 3811 | 1752 | 0 | 0 | 0 | 9 | 1 | 122/8 | `5,0,0,0,0,9,1,1,1,8` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `scoped_or_lifecycle_record` | `06ec9a44-cd30-4a0b-97d6-49165bc4b46f` | none | draft | 3536 | 1634 | 0 | 0 | 0 | 1 | 0 | 2/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `scoped_or_lifecycle_record` | `5c3144a5-eea7-412c-b8d7-4584670f75f4` | none | draft | 3283 | 1503 | 0 | 0 | 0 | 1 | 0 | 18/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `scoped_or_lifecycle_record` | `30d96091-0c23-41fc-ac07-f50b79bb3c8b` | none | draft | 3710 | 1694 | 0 | 0 | 0 | 1 | 0 | 57/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `empty_retry_husk` | `45a863ef-498c-4386-a69e-334802a743f9` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `empty_retry_husk` | `f318d579-e03a-4320-8a8b-9d33b751ebd9` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `Qk9I41P4bgdIV4rFmoJk` | unmap | `empty_retry_husk` | `5bc895a3-f43a-4149-b02a-30a092e99ce5` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `acG3mYgp83HrxAuy7UNL` | **KEEP** | `linked_business_record` | `963e0f1e-f023-4348-b669-411a0bbeb39f` | SWP-26040 | archived | 8413 | 543 | 7 | 0 | 10 | 157 | 7 | 169/21 | `7,1,7,0,10,157,7,1,1,21` |
| patio | `acG3mYgp83HrxAuy7UNL` | unmap | `scoped_or_lifecycle_record` | `493f0d48-0b41-41ef-8435-e4513a705974` | none | draft | 3230 | 1461 | 0 | 0 | 0 | 1 | 0 | 650/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `eesE5swW9y5krXvA9Wwt` | **KEEP** | `scoped_or_lifecycle_record` | `fc7ce409-aaaa-4cd5-bf2b-e650f4773e75` | SWP-26034 | quoted | 3493 | 1646 | 0 | 0 | 0 | 12 | 1 | 170/9 | `5,0,0,0,0,12,1,1,1,9` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `scoped_or_lifecycle_record` | `01f51f6b-68cc-475f-9d4d-e76189bff000` | none | draft | 3154 | 1586 | 0 | 0 | 0 | 1 | 0 | 15/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `scoped_or_lifecycle_record` | `805e8ce7-fc66-4246-bacd-41712eae4b25` | none | draft | 3510 | 1644 | 0 | 0 | 0 | 1 | 0 | 2/2 | `4,0,0,0,0,1,0,1,1,2` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `empty_retry_husk` | `a37cdd75-cdd1-495e-b094-4152cd85318e` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `empty_retry_husk` | `c42b951b-728c-4f3d-b08d-befbb20eb779` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `empty_retry_husk` | `d17f75f0-23ab-4856-9ff0-07a3d0f61d06` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |
| patio | `eesE5swW9y5krXvA9Wwt` | unmap | `empty_retry_husk` | `42c116f5-8a5a-49b6-8479-9594fd3850fe` | none | draft | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 1/1 | `1,0,0,0,0,0,0,0,0,1` |

## Production apply order

Apply only after the PR is merged and the release checkout is on clean `main`. The two SQL files must run in this order. `ON_ERROR_STOP` and one transaction per file prevent a partial migration:

```bash
psql "$PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 \
  -f supabase/migrations/20260720235959_fence_opportunity_mapping_dedupe.sql
psql "$PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 \
  -f supabase/migrations/20260721000001_fence_job_mint.sql
```

If the approved Supabase migration connection is used instead of `psql`, submit the full contents of the same two files as two migrations in the same order. Do not use a broad `db push`: production migration history is intentionally sparse and unrelated pending files must not be swept in.

## Production verification queries

```sql
SELECT org_id, type, ghl_opportunity_id, count(*)
FROM public.jobs WHERE ghl_opportunity_id IS NOT NULL
GROUP BY 1,2,3 HAVING count(*) > 1;

SELECT to_regprocedure('public.reserve_fence_job_mint(uuid,uuid,uuid,text,text,text,text,text,uuid[],text,text,text,text,text,text,text)');

SELECT resolution_action, count(*)
FROM public.fence_opportunity_mapping_audit
GROUP BY resolution_action ORDER BY resolution_action;
```
