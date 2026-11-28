-- 0137: 답변 멈추기 (src/lib/assistant/stop.ts · POST /api/conversations/[id]/stop)
--
-- 직원이 길게 흐르는 답을 도중에 멈춘다. 연결이 끊겨도 답은 끝까지 만들어 저장한다는 약속을 지키려고 멈춤은 따로 보낸 요청으로 한다 —
-- 화면이 멈출 답 id를 이 칸에 적고, 답을 만드는 함수가 짧은 간격으로 읽어 이 턴의 답 id면 받기를 그만두고 받은 데까지 저장한다.
-- 답 행은 아직 없을 때라 외래 키를 걸지 않는다(id만 맞대 본다). 다음 턴의 답 id와는 맞지 않으므로 지우지 않아도 된다.
-- 추가만, 여러 번 적용해도 안전. 코드 배포 전에 적용 — 새 코드의 멈춤 요청이 이 칸을 쓴다(없으면 멈추기만 실패하고 답은 그대로).

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS stop_message_id uuid;
