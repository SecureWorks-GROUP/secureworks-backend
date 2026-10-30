-- TP-15/TP-16: an invoice balance does not stand for a separate unanswered matter.
-- On invoice loops, only explicit payment-closing notes share the balance item.
-- No source, ledger status, amount, role, scheduler or permission is changed.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE f text; h text;
BEGIN
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)');
 IF h='ddab6cd2bf43ecf5c88fcf03b7ba0374' THEN RETURN; END IF;
 IF h IS DISTINCT FROM 'db181308debc03dfd15b433f45abf573' THEN RAISE EXCEPTION 'invoice_matter_identity_preimage_mismatch'; END IF;
 IF strpos(f,$before$FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))$before$)=0 THEN RAISE EXCEPTION 'invoice_matter_identity_patch_missing'; END IF;
 EXECUTE replace(f,$before$FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))$before$,$after$FROM lop l JOIN recg g ON
    (g.about_key = l.about_key
     AND NOT (g.about_key LIKE 'invoice:%'
              AND g.rule IN ('R1_overdue','M1_money_due','R2_part_paid','R3_draft')
              AND coalesce(l.closes_on, '') <> 'payment'))
    OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))$after$);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM 'ddab6cd2bf43ecf5c88fcf03b7ba0374' THEN RAISE EXCEPTION 'invoice_matter_identity_postimage_mismatch'; END IF;
END $patch$;
