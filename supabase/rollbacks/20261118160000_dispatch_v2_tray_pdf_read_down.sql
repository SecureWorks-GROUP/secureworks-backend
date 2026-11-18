-- Down for 20261118160000_dispatch_v2_tray_pdf_read.
--
-- Drops the two item 16b functions. Roll back the ops-api change as well, or
-- the tray read reports pdf_reads_read 'failed' (the tray still works, with no
-- "Read from the PDF" line) and the reply scan reports tray_pdf_reads ok false.
--
-- The read requests already filed (context_document_text_requests rows with
-- requested_by 'dispatch tray (item 16b)') are left on purpose: the document
-- reader keeps its answers against them, and taking a request away would make
-- a read on no job unreachable rather than undone. Remove them by hand if
-- wanted:
--   DELETE FROM public.context_document_text_requests
--    WHERE requested_by = 'dispatch tray (item 16b)';

DROP FUNCTION IF EXISTS public.dispatch_v2_tray_pdf_reads(uuid[]);
DROP FUNCTION IF EXISTS public.dispatch_v2_tray_pdf_read_request(integer);
