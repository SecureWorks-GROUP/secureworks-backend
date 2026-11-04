-- Someone changed v_dispatch_order_bills after 20261104010000 (same columns, other body): the migration must
-- refuse, not overwrite it.
CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS
SELECT NULL::text AS order_kind, NULL::uuid AS order_id, NULL::uuid AS org_id, NULL::uuid AS job_id,
       NULL::text AS job_number, NULL::uuid AS supplier_id, NULL::text AS supplier_name, NULL::text AS order_status,
       NULL::timestamptz AS ordered_at, NULL::text AS xero_invoice_id, NULL::text AS invoice_number,
       NULL::text AS bill_contact_name, NULL::text AS bill_status, NULL::date AS bill_date, NULL::numeric AS bill_sub_total,
       NULL::text AS supplier_match, NULL::text AS rule, NULL::text AS matched_ref, NULL::text AS ref_saved_via,
       NULL::text AS matched_job_number, NULL::boolean AS linked, NULL::text AS not_linked_reason,
       NULL::integer AS orders_named
 WHERE false;
