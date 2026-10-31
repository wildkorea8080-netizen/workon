-- One stored artifact per user and immutable answer hash. Concurrent requests reuse it.
CREATE UNIQUE INDEX IF NOT EXISTS generated_files_app_result_unique
  ON public.generated_files(user_id, template_ref)
  WHERE template_ref LIKE 'app-result:%';
NOTIFY pgrst, 'reload schema';
