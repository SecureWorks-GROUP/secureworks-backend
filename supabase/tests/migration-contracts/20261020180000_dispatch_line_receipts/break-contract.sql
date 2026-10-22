-- Drop the guard: the contract must then fail on the first edit it tries.
DROP TRIGGER trg_job_material_line_receipts_guard ON public.job_material_line_receipts;
