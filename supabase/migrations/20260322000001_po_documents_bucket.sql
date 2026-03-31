-- Create po-documents storage bucket for PO PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('po-documents', 'po-documents', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access (PDFs need to be fetchable by send-po-email)
CREATE POLICY "Public read po-documents"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'po-documents');

-- Allow authenticated users to upload PO PDFs
CREATE POLICY "Authenticated upload po-documents"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'po-documents' AND auth.role() = 'authenticated');

-- Allow service role full access
CREATE POLICY "Service role manages po-documents"
  ON storage.objects FOR ALL
  USING (bucket_id = 'po-documents' AND auth.role() = 'service_role');
