-- Down for 20261023230000_dispatch_v2_replies_tables. Roll back
-- 20261023230100_dispatch_v2_replies_schedule first (it schedules the scan that
-- writes these tables), then ops-api (the dispatch_v2_replies* actions name
-- them). Every matched supplier email, linked supplier number and delivery
-- suggestion is lost with the tables; the emails themselves stay in
-- business_events, and an accepted date stays on its order.
DROP TABLE IF EXISTS public.dispatch_v2_delivery_suggestions;
DROP TABLE IF EXISTS public.dispatch_v2_supplier_order_refs;
DROP TABLE IF EXISTS public.dispatch_v2_supplier_emails;
DROP TABLE IF EXISTS public.dispatch_v2_reply_scan_state;
