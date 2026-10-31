-- 검토용 적용 묶음. 연결 DB에서 실행하지 않음. 0036~0041이 미적용인 경우에만 사용.
-- 기존 적용 내역과 백업 확인 후 실행. 재실행 시 제약 이름 중복으로 롤백될 수 있음.
BEGIN;

-- Source: 0036_work_app_snapshot.sql
-- 설정은 작업과 함께 보존한다. 기존 작업은 연결 없는 상태로 유지한다.
ALTER TABLE public.work_tasks ADD COLUMN IF NOT EXISTS app_snapshot jsonb;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_app_snapshot_shape CHECK (
  app_snapshot IS NULL OR COALESCE((
    jsonb_typeof(app_snapshot) = 'object'
    AND app_snapshot->>'schemaVersion' = '1'
    AND app_snapshot->>'agentId' IS NOT NULL
    AND (agent_id IS NULL OR app_snapshot->>'agentId' = agent_id::text)
  ), false)
);


-- Source: 0037_document_summary_workflow.sql
-- 새 문서 요약 앱. 기존 업무와 데이터는 그대로 유지한다.
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary'));


-- Source: 0038_document_rewrite_workflow.sql
-- 문장 교정·공문체 변환 앱
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite'));


-- Source: 0039_document_translation_workflow.sql
-- 문서 번역 앱
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation'));


-- Source: 0040_meeting_agenda_workflow.sql
-- 회의 안건 초안 앱
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation','meeting-agenda'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation','meeting-agenda'));


-- Source: 0041_document_faq_workflow.sql
-- 문서 기반 FAQ 초안 앱
ALTER TABLE public.work_tasks DROP CONSTRAINT work_tasks_workflow_key_check;
ALTER TABLE public.work_tasks ADD CONSTRAINT work_tasks_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation','meeting-agenda','document-faq'));
ALTER TABLE public.workflow_installations DROP CONSTRAINT workflow_installations_workflow_key_check;
ALTER TABLE public.workflow_installations ADD CONSTRAINT workflow_installations_workflow_key_check CHECK (workflow_key IN ('intake','official-letter','report','collection','settlement','regulations','meeting','reply','audit-response','handover','document-summary','document-rewrite','document-translation','meeting-agenda','document-faq'));


COMMIT;
