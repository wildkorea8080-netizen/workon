-- 문서 번역 앱
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation'));
