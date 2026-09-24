DO $$
BEGIN
  IF (SELECT count(*) FROM public.price_book_proposal_decisions d
      JOIN public.price_book_proposals p ON p.id = d.proposal_id
      WHERE p.evidence_ref IN ('pb10-proposal-a', 'pb10-proposal-b') AND d.decision = 'approved') <> 1 THEN
    RAISE EXCEPTION 'PB-10: exactly one of two proposals for one subject may be approved';
  END IF;
  IF (SELECT count(*) FROM public.price_book_costs
      WHERE item_key = 'pb10-subject-lock-item' AND NOT provisional) <> 1 THEN
    RAISE EXCEPTION 'PB-10: exactly one blessed row may result';
  END IF;
END $$;
