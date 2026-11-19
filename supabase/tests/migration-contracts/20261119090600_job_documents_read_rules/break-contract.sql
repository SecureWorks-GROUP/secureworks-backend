-- Put the open 2025 read rule back beside the new rules: the contract must
-- fail on its first behaviour check, anon reading rows without a token.
CREATE POLICY "Public can view shared docs"
  ON public.job_documents FOR SELECT
  USING (share_token IS NOT NULL AND sent_to_client = true);
