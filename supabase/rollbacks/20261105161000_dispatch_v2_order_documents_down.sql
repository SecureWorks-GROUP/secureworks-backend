-- Down for 20261105161000_dispatch_v2_order_documents. Roll back ops-api first
-- (dispatch_v2_order_documents.ts names the table). The documents already
-- saved stay on their jobs (job_documents and the job-documents bucket); only
-- the memory of which files were saved goes, so after a roll forward the
-- sweep could save a file a second time.
DROP TABLE IF EXISTS public.dispatch_v2_order_documents;
