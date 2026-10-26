-- Down for 20261023214100_dispatch_v2_emails_approved_supplier_store. Drops the approved supplier
-- order email list and its links, and nothing else: suppliers is never touched (this list was kept
-- apart from suppliers.email on purpose). Roll ops-api back first, and roll
-- 20261023214200_dispatch_v2_emails_draft_list_and_order_emails back before this one: its order
-- emails point at the approved list.
DROP TABLE IF EXISTS public.dispatch_approved_supplier_email_links;
DROP TABLE IF EXISTS public.dispatch_approved_supplier_emails;
