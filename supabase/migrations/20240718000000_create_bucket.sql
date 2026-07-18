INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('generated-videos', 'generated-videos', true, 524288000)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload
CREATE POLICY "Authenticated users can upload" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'generated-videos' AND auth.role() = 'authenticated');

-- Allow public read
CREATE POLICY "Public read access" ON storage.objects
  FOR SELECT USING (bucket_id = 'generated-videos');

-- Allow authenticated users to delete their own files
CREATE POLICY "Authenticated users can delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'generated-videos' AND auth.role() = 'authenticated');
