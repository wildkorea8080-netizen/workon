-- 0087: 일괄 실행을 만든 곳(source) + 결과 메시지로 묶음 찾기 색인 — 입력형 앱 외부 연동의 비동기 호출(src/lib/apps/webhooks.ts)
--
-- 외부 시스템이 연동을 `"async": true`(또는 `Prefer: respond-async`)로 부르면 기다리지 않고 202와 묶음 번호를 받고, 그 직원의 한 줄짜리
-- 일괄 실행(app_batches, 0077)으로 들어가 실행기(5분)가 돌린다. 그런 묶음은 source = 'webhook' — 마침 메일을 보내지 않는다(호출마다 메일이 가지 않게).
-- 결과를 보낼 때(0076) 그 답변이 어느 묶음의 줄인지 찾아 몸의 run.batch_id로 싣는다 — 그 조회용 색인(app_batch_items.message_id).
-- 어느 연동이 넣은 묶음인지(webhook_id) — 외부 시스템이 같은 토큰으로 묶음 상태를 물을 때(GET /api/apps/webhook/batches/[id]) 그 연동이 넣은 묶음만 보이게.
-- 연동을 지우면 칸만 비운다(묶음·결과는 직원의 것이라 남는다). source = 'webhook'인 묶음에만 둔다.
-- 추가만, 여러 번 적용해도 안전. **코드 배포 전에 적용** — 새 코드가 마침 메일 판정에서 source를 읽어, 없으면 일괄 실행 마침 메일이 실패한다(warning만, 실행은 그대로).
ALTER TABLE public.app_batches ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_batches_source_check') THEN
    ALTER TABLE public.app_batches ADD CONSTRAINT app_batches_source_check CHECK (source IN ('manual', 'webhook'));
  END IF;
END $$;
ALTER TABLE public.app_batches ADD COLUMN IF NOT EXISTS webhook_id uuid REFERENCES public.app_webhooks(id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_batches_webhook_source_check') THEN
    ALTER TABLE public.app_batches ADD CONSTRAINT app_batches_webhook_source_check CHECK (webhook_id IS NULL OR source = 'webhook');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS app_batches_webhook_idx ON public.app_batches (webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_batch_items_message_idx ON public.app_batch_items (message_id) WHERE message_id IS NOT NULL;
