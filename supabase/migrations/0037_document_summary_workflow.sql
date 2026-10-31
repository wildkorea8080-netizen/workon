-- 새 문서 요약 앱. 기존 업무와 데이터는 그대로 유지한다.
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary'));
