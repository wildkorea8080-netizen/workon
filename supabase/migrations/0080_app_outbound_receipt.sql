-- 0080: 앱 결과 보내기의 받는 쪽 접수 정보(2026-11-10) — 받는 시스템(전자결재·그룹웨어 등)이 2xx 응답 몸에
-- {"receipt": {"reference": "접수 번호", "url": "https://…"}}를 주면 다듬어 남기고, 그 결과를 실행한 직원의 '보낸 결과' 목록에 보인다
-- (src/lib/apps/outbound/spec.ts `parseOutboundReceipt`, docs/benchmarks/allganize/APP_OUTBOUND.md).
-- 응답 몸은 앞 4KB만 읽고 번호(100자)·https 주소(500자) 말고는 저장하지 않는다.
-- 추가만(칸 둘·CHECK·색인). 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드가 보낸 뒤 이 칸을 쓰고 직원 목록이 읽어, 없으면 보낸 기록 마무리가 실패한다.
ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS receipt_ref text;
ALTER TABLE public.app_outbound_deliveries ADD COLUMN IF NOT EXISTS receipt_url text;

ALTER TABLE public.app_outbound_deliveries DROP CONSTRAINT IF EXISTS app_outbound_deliveries_receipt_check;
ALTER TABLE public.app_outbound_deliveries ADD CONSTRAINT app_outbound_deliveries_receipt_check
  CHECK ((receipt_ref IS NULL OR char_length(receipt_ref) BETWEEN 1 AND 100)
    AND (receipt_url IS NULL OR (char_length(receipt_url) <= 500 AND receipt_url LIKE 'https://%'))
    -- 접수 정보는 보낸 기록에만
    AND (status = 'sent' OR (receipt_ref IS NULL AND receipt_url IS NULL)));

-- 직원의 '보낸 결과' 목록
CREATE INDEX IF NOT EXISTS app_outbound_deliveries_user_idx ON public.app_outbound_deliveries (user_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
