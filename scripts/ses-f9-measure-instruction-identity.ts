#!/usr/bin/env -S deno run --allow-env --allow-net

// Privacy-safe, read-only production measurement for SES F9. The query returns
// counts and job references only: no client/contact/address fields are selected.
const projectRef = "kevgrhcjxspbxgovpmfl";
const accessToken = Deno.env.get("SUPABASE_ACCESS_TOKEN");
if (!accessToken) throw new Error("SUPABASE_ACCESS_TOKEN is required");

const query = `
WITH cards AS (
  SELECT d.job_id, d.external_ref, d.requesting_company_slug, j.job_number,
         COALESCE(jsonb_agg(jsonb_build_object(
           'type', doc.type,
           'file_name', doc.file_name
         )) FILTER (WHERE doc.id IS NOT NULL), '[]'::jsonb) AS docs
  FROM makesafe_job_details d
  JOIN jobs j ON j.id = d.job_id
  LEFT JOIN job_documents doc ON doc.job_id = d.job_id
  GROUP BY d.job_id, d.external_ref, d.requesting_company_slug, j.job_number
), measured AS (
  SELECT *,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(docs) x
      WHERE lower(COALESCE(x->>'type', '')) = 'work_order'
        AND COALESCE(x->>'file_name', '')
          ~* '(^|[/_])(?:work[_ -]?order[_ -]?)?MLB[-_ ]+[A-Z]{2}[-_ ]+[0-9]{3,}[^0-9A-Z]*P[ _-]*O[ _#-]*[0-9]{3,}'
    ) OR COALESCE(external_ref, '')
          ~* '(^|[^A-Z0-9])MLB[- ]+[A-Z]{2}[- ]+[0-9]{3,}[^0-9A-Z]*P[ -]*O[ # -]*[0-9]{3,}'
      AS f1_new,
    lower(COALESCE(requesting_company_slug, '')) = 'aj'
      AND trim(COALESCE(external_ref, '')) ~ '^[0-9]{5,}$' AS f2_new,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(docs) x
      WHERE lower(COALESCE(x->>'type', '')) = 'work_order'
        AND regexp_replace(split_part(COALESCE(x->>'file_name', ''), '?', 1), '^.*/', '')
          ~* '^work-order-SWMS-[0-9]+[.]pdf$'
    ) AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(docs) x
      WHERE lower(COALESCE(x->>'type', '')) = 'work_order'
        AND regexp_replace(split_part(COALESCE(x->>'file_name', ''), '?', 1), '^.*/', '')
          !~* '^work-order-SWMS-[0-9]+[.]pdf$'
    ) AS f6_loses_wo
  FROM cards
)
SELECT
  count(*) FILTER (WHERE f1_new)::int AS f1_mlb_infix_cards,
  count(*) FILTER (WHERE f2_new)::int AS f2_aj_bare_digit_cards,
  count(*) FILTER (WHERE f6_loses_wo)::int AS f6_cards_losing_apparent_wo,
  COALESCE(jsonb_agg(job_number ORDER BY job_number) FILTER (WHERE f1_new), '[]'::jsonb) AS f1_job_refs,
  COALESCE(jsonb_agg(job_number ORDER BY job_number) FILTER (WHERE f2_new), '[]'::jsonb) AS f2_job_refs,
  COALESCE(jsonb_agg(job_number ORDER BY job_number) FILTER (WHERE f6_loses_wo), '[]'::jsonb) AS f6_job_refs
FROM measured;`;

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, read_only: true }),
  },
);
if (!response.ok) {
  throw new Error(`read-only management query failed (${response.status})`);
}
console.log(JSON.stringify(await response.json(), null, 2));
