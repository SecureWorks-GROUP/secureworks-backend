# Mailer ops visibility — live send ledger 2026-08-05

**Status:** 14 external emails delivered and proved in admin@ Sent Items.
**Action:** `ops-api?action=send_mailer_ops_visibility`
**Deploy:** GitHub Actions run `31012899493` (ops-api live with schema fixes).
**Window (UTC):** 2026-08-05 ~14:03–14:06.

## Why this ledger exists

First **proven** delivery to an external builder work-order mailer
(`mlb.mailer@primeeco.tech`) through the mailer-ops path, with Sent Items
message ids and the mandatory `ses@secureworkswa.com.au` CC on every message.
No invoice rode this path.

## Dry-run gate caught a second phantom before any email left

After PR #600 fixed `jobs.requesting_company_slug` (and related company
columns on the wrong table), a **Maylands `dry_run: true`** still failed with:

```text
column makesafe_intake_cases.status does not exist
```

Live column is `state`. That was fixed in PR #601. **Zero external mail**
was sent until both dry runs (report + photo) on Maylands returned clean,
then live `dry_run: false` proceeded under Captain order.

Machine-readable copy: [`ledger.json`](./ledger.json).

## Common envelope (all 14)

| Field | Value |
|-------|--------|
| FROM | `admin@secureworkswa.com.au` |
| TO | `mlb.mailer@primeeco.tech` |
| CC | `ses@secureworkswa.com.au` |
| Operation header | `x-secureworks-ses-operation` |
| Invoice | none (structurally impossible on this route) |
| Proof surfaces | `admin_sent_items`, `ses_intake_cc` |

## The 14 sends

| # | Card | Job | Route | Subject as sent | Attachments | message_id (prefix) | operation_token |
|---|------|-----|-------|-----------------|-------------|---------------------|-----------------|
| 1 | Maylands | `SWMS-261017` | report | NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-578d56af-c61a-5f0d-80b9-59b0aebd4ac2` |
| 2 | Maylands | `SWMS-261017` | photo | NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051 | 11 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-1181ffc3-9efb-5f94-80d3-8a06ca85a33b` |
| 3 | Floreat Everton | `SWMS-261080` | report | NEW WORK ORDER - MLB-27148 5 EVERTON ST, Floreat, WA 6014 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-4e8adf57-8864-5800-92d8-89dc34b7e035` |
| 4 | Floreat Everton | `SWMS-261080` | photo | NEW WORK ORDER - MLB-27148 5 EVERTON ST, Floreat, WA 6014 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-55a0ab98-2aad-59ba-a705-3726f9263c9b` |
| 5 | Floreat Draper | `SWMS-261020` | report | NEW WORK ORDER - MLB-27037 5 Draper St, Floreat, WA 6014 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-c10f0fa4-fe52-5e05-a334-abf9544debf5` |
| 6 | Floreat Draper | `SWMS-261020` | photo | NEW WORK ORDER - MLB-27037 5 Draper St, Floreat, WA 6014 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-4eba63d6-2ed5-58e8-b321-514a1f4f4946` |
| 7 | Morley | `SWMS-261115` | report | NEW WORK ORDER - MLB-27387 27 Kennedy Road, Morley, WA 6062 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-f4c2770c-9742-5761-a527-f07ef46cc4e7` |
| 8 | Morley | `SWMS-261115` | photo | NEW WORK ORDER - MLB-27387 27 Kennedy Road, Morley, WA 6062 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-7e215f6c-1be6-5cfd-ad65-23c0f7f07052` |
| 9 | Ballajura | `SWMS-26902` | report | NEW WORK ORDER - MLB-26443 208 Summerlakes Pde, Ballajura, WA 6066 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-1634697a-d7f4-59fd-8af9-0592d522a143` |
| 10 | Ballajura | `SWMS-26902` | photo | NEW WORK ORDER - MLB-26443 208 Summerlakes Pde, Ballajura, WA 6066 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-99266438-3111-5aa6-8882-0c07905d3147` |
| 11 | Woodvale | `SWMS-261128` | report | NEW WORK ORDER - MLB-27335 10 MONTASH RETREAT, Woodvale, WA 6026 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-56eb5eba-f0f2-5394-bfcf-12a4da480da0` |
| 12 | Woodvale | `SWMS-261128` | photo | NEW WORK ORDER - MLB-27335 10 MONTASH RETREAT, Woodvale, WA 6026 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-e7a682f9-7a7e-5453-ac75-d8d439ee5ea8` |
| 13 | Carine | `SWMS-261129` | report | NEW WORK ORDER - MLB-25876 48 Doriot Way, Carine, WA 6020 | 1 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-cdeeecda-58c2-5bc1-a297-9e219ff47010` |
| 14 | Carine | `SWMS-261129` | photo | NEW WORK ORDER - MLB-25876 48 Doriot Way, Carine, WA 6020 | 12 | `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5…` | `SES-bbb8f271-5515-5a01-8012-d5af7874d2ed` |

## Per-send detail

### 1. SWMS-261017 — report (Maylands)

- **job_id:** `1e05db49-cc42-477b-9689-cbdceed649da`
- **attempt_key:** `maylands-report-live-v1-20260805T140357Z`
- **subject as sent:** NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-MLB-26267-Maylands-e925c4e48396.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5buAAA=`
- **internet_message_id:** `<SY8P300MB084067FB6E29E97D368B797E93D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-578d56af-c61a-5f0d-80b9-59b0aebd4ac2`
- **operation_header:** `x-secureworks-ses-operation`

### 2. SWMS-261017 — photo (Maylands)

- **job_id:** `1e05db49-cc42-477b-9689-cbdceed649da`
- **attempt_key:** `maylands-photo-live-v1-20260805T140402Z`
- **subject as sent:** NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 11
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpeg`, `site-photo-07.jpeg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5bvAAA=`
- **internet_message_id:** `<SY8P300MB0840FD55C0287BF66471BD2593D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-1181ffc3-9efb-5f94-80d3-8a06ca85a33b`
- **operation_header:** `x-secureworks-ses-operation`

### 3. SWMS-261080 — report (Floreat Everton)

- **job_id:** `f8c19311-611d-4c8f-87b6-bb2005c47bda`
- **attempt_key:** `f8c19311-report-live-v1-20260805T140417Z`
- **subject as sent:** NEW WORK ORDER - MLB-27148 5 EVERTON ST, Floreat, WA 6014
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-MLB-27148-Floreat-c7b46b9ba21f.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5bwAAA=`
- **internet_message_id:** `<SY8P300MB08401073A3D304A6C3CE956C93D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-4e8adf57-8864-5800-92d8-89dc34b7e035`
- **operation_header:** `x-secureworks-ses-operation`

### 4. SWMS-261080 — photo (Floreat Everton)

- **job_id:** `f8c19311-611d-4c8f-87b6-bb2005c47bda`
- **attempt_key:** `f8c19311-photo-live-v1-20260805T140421Z`
- **subject as sent:** NEW WORK ORDER - MLB-27148 5 EVERTON ST, Floreat, WA 6014
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5bxAAA=`
- **internet_message_id:** `<SY8P300MB0840B2DD8AE235790D70911693D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-55a0ab98-2aad-59ba-a705-3726f9263c9b`
- **operation_header:** `x-secureworks-ses-operation`

### 5. SWMS-261020 — report (Floreat Draper)

- **job_id:** `db3f2242-d10c-42f0-80b9-7d684e62c6fe`
- **attempt_key:** `db3f2242-report-live-v1-20260805T140436Z`
- **subject as sent:** NEW WORK ORDER - MLB-27037 5 Draper St, Floreat, WA 6014
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-MLB-27037-Floreat-7fcdc093ec46.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5byAAA=`
- **internet_message_id:** `<SY8P300MB0840244753B13DEF8DD3885893D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-c10f0fa4-fe52-5e05-a334-abf9544debf5`
- **operation_header:** `x-secureworks-ses-operation`

### 6. SWMS-261020 — photo (Floreat Draper)

- **job_id:** `db3f2242-d10c-42f0-80b9-7d684e62c6fe`
- **attempt_key:** `db3f2242-photo-live-v1-20260805T140441Z`
- **subject as sent:** NEW WORK ORDER - MLB-27037 5 Draper St, Floreat, WA 6014
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5bzAAA=`
- **internet_message_id:** `<SY8P300MB08402E3116FF9A517853EF4293D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-4eba63d6-2ed5-58e8-b321-514a1f4f4946`
- **operation_header:** `x-secureworks-ses-operation`

### 7. SWMS-261115 — report (Morley)

- **job_id:** `d97067be-62e7-48e2-acff-344bb7473dd5`
- **attempt_key:** `d97067be-report-live-v1-20260805T140454Z`
- **subject as sent:** NEW WORK ORDER - MLB-27387 27 Kennedy Road, Morley, WA 6062
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-MLB-27387-Morley-ffac55a6dd9a.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b0AAA=`
- **internet_message_id:** `<SY8P300MB08404B0D304D08A076EC0CB793D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-f4c2770c-9742-5761-a527-f07ef46cc4e7`
- **operation_header:** `x-secureworks-ses-operation`

### 8. SWMS-261115 — photo (Morley)

- **job_id:** `d97067be-62e7-48e2-acff-344bb7473dd5`
- **attempt_key:** `d97067be-photo-live-v1-20260805T140459Z`
- **subject as sent:** NEW WORK ORDER - MLB-27387 27 Kennedy Road, Morley, WA 6062
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b1AAA=`
- **internet_message_id:** `<SY8P300MB0840537E67F72AFC8290365993D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-7e215f6c-1be6-5cfd-ad65-23c0f7f07052`
- **operation_header:** `x-secureworks-ses-operation`

### 9. SWMS-26902 — report (Ballajura)

- **job_id:** `7aa83351-a1c1-450f-af9d-77e7777da92a`
- **attempt_key:** `7aa83351-report-live-v1-20260805T140546Z`
- **subject as sent:** NEW WORK ORDER - MLB-26443 208 Summerlakes Pde, Ballajura, WA 6066
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-SWMS-26902-Ballajura-a562153ce17f.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b2AAA=`
- **internet_message_id:** `<SY8P300MB08409E609552D93AE9F162D693D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-1634697a-d7f4-59fd-8af9-0592d522a143`
- **operation_header:** `x-secureworks-ses-operation`

### 10. SWMS-26902 — photo (Ballajura)

- **job_id:** `7aa83351-a1c1-450f-af9d-77e7777da92a`
- **attempt_key:** `7aa83351-photo-live-v1-20260805T140550Z`
- **subject as sent:** NEW WORK ORDER - MLB-26443 208 Summerlakes Pde, Ballajura, WA 6066
- **subject_source:** `intake_draft_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b3AAA=`
- **internet_message_id:** `<SY8P300MB0840DA7ACE645F4B857A3B3393D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-99266438-3111-5aa6-8882-0c07905d3147`
- **operation_header:** `x-secureworks-ses-operation`

### 11. SWMS-261128 — report (Woodvale)

- **job_id:** `047dbe8d-e632-4d29-adaa-5a3d42f38542`
- **attempt_key:** `047dbe8d-report-live-v1-20260805T140603Z`
- **subject as sent:** NEW WORK ORDER - MLB-27335 10 MONTASH RETREAT, Woodvale, WA 6026
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-SWMS-261128-Woodvale-3873894d3b52.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b4AAA=`
- **internet_message_id:** `<SY8P300MB08404E7E412958AFBAAD2E4C93D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-56eb5eba-f0f2-5394-bfcf-12a4da480da0`
- **operation_header:** `x-secureworks-ses-operation`

### 12. SWMS-261128 — photo (Woodvale)

- **job_id:** `047dbe8d-e632-4d29-adaa-5a3d42f38542`
- **attempt_key:** `047dbe8d-photo-live-v1-20260805T140607Z`
- **subject as sent:** NEW WORK ORDER - MLB-27335 10 MONTASH RETREAT, Woodvale, WA 6026
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b5AAA=`
- **internet_message_id:** `<SY8P300MB084001D8164139141C20F40493D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-e7a682f9-7a7e-5453-ac75-d8d439ee5ea8`
- **operation_header:** `x-secureworks-ses-operation`

### 13. SWMS-261129 — report (Carine)

- **job_id:** `8a631233-2f23-4756-9e7a-8528fe980610`
- **attempt_key:** `8a631233-report-live-v1-20260805T140621Z`
- **subject as sent:** NEW WORK ORDER - MLB-25876 48 Doriot Way, Carine, WA 6020
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 1
- **attachment names:** `Make-Safe-Report-SWMS-261129-Carine-fc9fdf7b7883.pdf`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b6AAA=`
- **internet_message_id:** `<SY8P300MB0840996D41D5ADA19B11D50293D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-cdeeecda-58c2-5bc1-a297-9e219ff47010`
- **operation_header:** `x-secureworks-ses-operation`

### 14. SWMS-261129 — photo (Carine)

- **job_id:** `8a631233-2f23-4756-9e7a-8528fe980610`
- **attempt_key:** `8a631233-photo-live-v1-20260805T140628Z`
- **subject as sent:** NEW WORK ORDER - MLB-25876 48 Doriot Way, Carine, WA 6020
- **subject_source:** `emails_subject`
- **recipients:** TO `mlb.mailer@primeeco.tech` · CC `ses@secureworkswa.com.au`
- **attachment count:** 12
- **attachment names:** `site-photo-01.jpg`, `site-photo-02.jpg`, `site-photo-03.jpg`, `site-photo-04.jpg`, `site-photo-05.jpg`, `site-photo-06.jpg`, `site-photo-07.jpg`, `site-photo-08.jpg`, `site-photo-09.jpg`, `site-photo-10.jpg`, `site-photo-11.jpg`, `site-photo-12.jpg`
- **message_id:** `AAMkADE1Zjk0YmY3LTJkYjMtNDk4YS1hYjE2LWM5ODViYTZkOWRkZQBGAAAAAABRIFe74Q0ORre95NRvsgLFBwCdk5KDKwsUTpeEHVKg6rR_AAAAAAEJAACdk5KDKwsUTpeEHVKg6rR_AAI1-5b7AAA=`
- **internet_message_id:** `<SY8P300MB084078A883E33C163E826D9593D32@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>`
- **operation_token:** `SES-bbb8f271-5515-5a01-8012-d5af7874d2ed`
- **operation_header:** `x-secureworks-ses-operation`

## Boundaries held

- No invoice attachment; no approve / authorise / void / mint.
- No `execute_ses_release_revision`.
- Unknown outcomes: none (no redispatch required).
- Bertram / Munster / Queens Park not touched.

