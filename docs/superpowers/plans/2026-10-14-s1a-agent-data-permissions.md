# S1-a 비서 데이터·권한 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비서를 나만의·부서·공식 세 단계로 나누고, 설정을 바꿀 때마다 판을 남기며, 고칠 수 있는 사람을 서버의 순수 함수 하나로 판정한다.

**Architecture:** `agents` 행이 현재 상태를 들고 `agent_history`가 판 사본을 든다(A안). 저장·판 기록·판 번호 올리기는 Postgres 함수 `save_agent` 하나가 한 트랜잭션으로 한다. 권한은 DB를 보지 않는 `agent-permissions.ts`가 판정하고, 라우트는 요청자 범위(`actor-scope.ts`)와 비서 정보(`agent-store.ts`)를 넘기기만 한다. 옛 칸(`is_personal`·`enabled_connectors`)은 트리거로 새 칸과 맞춰 두어 S1-b 배포 전까지 옛 대화 코드가 그대로 돈다.

**Tech Stack:** Next.js 14 App Router · TypeScript · Supabase(PostgREST + `supabaseAdmin`) · PostgreSQL plpgsql · vitest · `pg`(검증 스크립트)

**Spec:** `docs/superpowers/specs/2026-10-14-s1-agent-structure-and-executor-design.md` (2·3·6절)

## Global Constraints

- 응답 규약: 성공 `{ ok: true, data }`, 실패 `{ ok: false, error: { message } }` — 메시지는 한국어
- 서버 DB 접근은 `supabaseAdmin`, 환경변수는 `src/lib/config.ts` 경유 (직접 `process.env` 금지)
- 타입 에러가 있으면 빌드가 실패한다 (`ignoreBuildErrors` 없음). Supabase 행 콜백은 인라인 타입을 단다
- 마이그레이션은 `npm run db:migrate`가 파일 전체를 한 트랜잭션으로 실행한다 — 파일 안에 `BEGIN`/`COMMIT`을 넣지 않는다
- 파일은 UTF-8로 저장한다 (PowerShell `>>` 금지)
- 실패가 권한을 넓히면 안 된다 — 조회 실패 시 가장 좁은 쪽으로 닫는다
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 판 사본에 담는 칸(정확히 이 11개): `name · description · icon · color · category · usage_guide · starter_prompts · system_prompt · model_id · capabilities · template_ids`
- 판 사본에 담지 않는 칸: `is_published · display_order · visibility · is_active · tier · agent_type · link_url`
- 쓰는 중인 양식은 비서당 10개까지
- 이 묶음의 능력 id는 정확히 `doc_search · public_data · image`

## 설계 문서와 달라지는 점 (구현 전 사용자 확인 완료 전제)

조사 중 발견한 사실 때문에 설계를 세 군데 다듬는다. 계획 승인이 곧 이 변경의 승인이다.

1. **지우기 = 숨김 처리(`deleted_at`).** `conversations.agent_id`가 `ON DELETE` 없이 `agents`를 참조해, 대화가 한 번이라도 있는 비서는 지금도 지워지지 않는다(23503). 행을 실제로 지우면 `agent_history`와 `messages.agent_version`이 가리킬 판도 사라져 감사 목적(설계 2.6)이 깨진다. 그래서 `deleted_at`을 찍고 `is_active=false`로 둔다. 화면에서는 사라지고 되살리는 화면은 만들지 않는다 — 사용자에게는 설계대로 '되돌릴 수 없는 지우기'다.
2. **능력 범위 검사는 `public_data`에만.** `doc_search`(자기 비서에 올린 문서)와 `image`(자기가 첨부한 사진)는 기관 밖으로 나가지 않는다. 이 둘까지 '기관이 공식 비서에서 쓰는 것만'으로 묶으면 지금 문서를 올려 쓰는 나만의 비서가 막힌다. 범위 검사의 원래 목적은 관리자가 정한 외부 연결을 직원이 넘지 못하게 하는 것이다.
3. **참고 문서 지우기는 '비서를 지울 수 있는 사람'만.** 문서는 되돌리기 대상이 아니다(결정 3). 되돌릴 수 없는 것은 좁게 연다는 결정 4의 원칙을 그대로 적용한다. 올리기는 '고칠 수 있는 사람'이다.

설계 3.2의 '지금과 달라지는 점' 문장도 사실에 맞게 고친다: 지금은 관리자가 **자기 부서에 걸린 비서만** 고칠 수 있다(`PATCH /api/agents/[id]`가 `department_id = 관리자 부서`로 거른다). 앞으로는 관리 범위를 따른다.

## Review Focus

- **같은 부서의 두 직원이 같은 이름으로 나만의 비서를 만든다** → 둘 다 만들어져야 한다. 지금은 `agents(department_id, name)` 유일 인덱스 때문에 두 번째가 23505로 실패한다. Task 1이 인덱스를 단계별로 나누고 Task 9의 `db:test-agents`가 확인한다.
- **여러 비서에 문서를 한 번에 올리면서 권한 없는 비서를 섞는다** → 전부 거절해야 한다. 지금 `/api/upload`는 첫 번째 비서만 검사한다. Task 7이 비서 전부를 검사하고 원본 검사 테스트로 고정한다.
- **부서원 둘이 같은 판을 동시에 고친다** → 뒤에 저장한 쪽은 409와 최신 판 번호를 받아야 한다. Task 1의 `save_agent`와 Task 9가 확인한다.
- **배포 사이(0026 적용 후, S1-a 코드 배포 전)에 옛 코드가 비서를 만들거나 커넥터를 바꾼다** → `tier`·`capabilities`가 따라가야 한다. Task 1의 맞춤 트리거와 Task 9가 확인한다.
- **여러 비서가 함께 쓰는 문서 파일을 한 비서에서 지운다** → 다른 비서의 문서 파일은 남아야 한다. 지금은 저장소 파일을 바로 지운다. Task 7이 다른 행이 같은 `storage_path`를 쓰면 파일을 남긴다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `supabase/migrations/0026_agent_tiers.sql` (새) | 칸·테이블·제약·트리거·`save_agent`·`change_agent_tier`·`enable_agent_capability`·옮기기 |
| `src/lib/agent-permissions.ts` (새) | 순수 판정 함수와 타입 |
| `src/lib/capabilities/settings.ts` (새) | 능력 id 목록 · 설정 정규화 · 기관 범위 계산 (순수) |
| `src/lib/agent-patch.ts` (새) | 요청 본문을 판 설정/운영 값으로 나누고 검사 (순수) |
| `src/lib/actor-scope.ts` (새) | 세션 → 요청자 범위 (DB) |
| `src/lib/agent-store.ts` (새) | 비서 조회·저장·단계 변경·기록·숨김 (DB) |
| `src/lib/connector-scope.ts` (고침) | `capabilities`·`tier` 기준으로 기관 범위 계산 |
| `src/app/api/agents/**` (고침·새) | 권한 모듈 경유, 판 저장, 단계 이동, 기록, 되돌리기, 양식 |
| `src/app/api/admin/agents/**` (고침) | 승인·반려·신청 목록을 관리 범위·판 번호로 |
| `src/app/api/upload/route.ts`, `src/app/api/documents/route.ts` (고침) | 비서 전부 권한 검사 · 문서 기록 |
| `src/lib/install-presets.ts`, `scripts/seed-agents.mjs` (고침) | 단계·능력 · `--update`는 `save_agent` |
| `src/components/admin/AgentsManager.tsx`, `src/components/chat/CreateAgentModal.tsx` (고침) | 새 요청 형식(`capabilities`·`base_version`) |
| `scripts/db-test-agents.mjs` (새) | 실제 DB에서 트랜잭션 + ROLLBACK 검증 |
| `scripts/db-check.mjs`, `scripts/isolation-check.mjs` (고침) | 0026 점검 |
| `tests/agent-permissions.test.ts`, `tests/capability-settings.test.ts`, `tests/agent-patch.test.ts`, `tests/agent-route-permissions.test.ts` (새) · `tests/route-auth.test.ts` (고침) | 회귀 |

---

### Task 1: 마이그레이션 0026

**Files:**
- Create: `supabase/migrations/0026_agent_tiers.sql`
- Test: `tests/agent-migration.test.ts`

**Interfaces:**
- Produces (DB):
  - `agents.tier text NOT NULL` (`personal|department|official`), `model_id text`, `capabilities jsonb NOT NULL`, `version integer NOT NULL`, `deleted_at timestamptz`, `approval_version integer`, `approval_requested_by uuid`
  - `agent_templates(id, agent_id, name, storage_path, file_name, mime_type, size_bytes, created_by, created_at, retired_at DEFAULT now())`
  - `agent_history(id, agent_id, kind, version, snapshot, changed_by, detail, created_at)`
  - `messages.agent_version integer`
  - `save_agent(p_agent_id uuid, p_base_version int, p_patch jsonb, p_actor uuid, p_kind text, p_detail jsonb) → jsonb` : `{ok:true, version}` | `{ok:false, reason:'conflict', current_version}` | `{ok:false, reason:'not_found'}` · 양식 11개 이상이면 SQLSTATE 23514
  - `change_agent_tier(p_agent_id uuid, p_tier text, p_actor uuid, p_department_id uuid, p_visibility text) → jsonb` : `{ok:true}` | `{ok:false, reason:'not_found'}` · 이름 겹침은 23505
  - `enable_agent_capability(p_agent_id uuid, p_capability text, p_actor uuid) → void`
  - `agent_snapshot(agents) → jsonb`

- [ ] **Step 1: 실패하는 테스트 작성** — 마이그레이션이 설계의 핵심 규칙을 담았는지 원본으로 고정한다. 실제 동작은 Task 9가 DB에서 본다.

```typescript
// tests/agent-migration.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * 0026은 S1 전체의 바탕이다. 여기 규칙이 빠지면 오류 없이 결과만 틀린다
 * (판이 안 남거나, 옛 코드가 만든 비서의 단계가 비거나). 실제 동작은
 * `npm run db:test-agents`가 DB에서 확인하고, 여기서는 규칙이 파일에
 * 들어 있는지만 본다.
 */
const sql = readFileSync('supabase/migrations/0026_agent_tiers.sql', 'utf8');

describe('0026 비서 단계', () => {
  it('파일 안에서 트랜잭션을 열지 않는다', () => {
    // db:migrate가 파일 전체를 한 트랜잭션으로 감싼다. 안에서 COMMIT하면
    // 실패해도 앞부분이 남는다.
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('단계를 기존 is_personal에서 채운다', () => {
    expect(sql).toContain("CASE WHEN COALESCE(is_personal, false) THEN 'personal' ELSE 'official' END");
  });

  it('부서 비서는 공개 범위가 부서여야 한다', () => {
    expect(sql).toContain("CHECK (tier <> 'department' OR visibility = 'department')");
  });

  it('이름 유일성을 단계별로 나눈다', () => {
    // 같은 부서 직원 둘이 같은 이름의 나만의 비서를 못 만들던 문제
    expect(sql).toContain('DROP INDEX IF EXISTS agents_department_name_idx');
    expect(sql).toMatch(/agents_personal_name_idx[\s\S]*\(owner_id, name\)[\s\S]*tier = 'personal'/);
  });

  it('save_agent가 판 번호를 비교한다', () => {
    expect(sql).toContain("'reason', 'conflict'");
    expect(sql).toContain('FOR UPDATE');
  });

  it('양식은 save_agent만 활성화한다', () => {
    // 새 양식 행은 retired 상태로 들어가고 save_agent가 판을 올리며 켠다.
    // 그래야 양식 추가도 판 사본에 남는다.
    expect(sql).toMatch(/retired_at\s+timestamptz\s+DEFAULT now\(\)/);
    expect(sql).toContain("USING ERRCODE = '23514'");
  });

  it('모든 기존 비서에 판 1을 남긴다', () => {
    expect(sql).toContain("'migrated'");
  });

  it('새로 만든 비서는 트리거가 판 1을 남긴다', () => {
    expect(sql).toContain('AFTER INSERT ON agents');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-migration.test.ts`
Expected: FAIL — `ENOENT: no such file ... 0026_agent_tiers.sql`

- [ ] **Step 3: 마이그레이션 작성**

```sql
-- =============================================================
-- 0026_agent_tiers.sql
-- 비서 단계(나만의·부서·공식) · 판 기록 · 능력 · 양식 자리 (S1-a)
--
-- 설계: docs/superpowers/specs/2026-10-14-s1-agent-structure-and-executor-design.md
--
-- 배포 순서: 이 파일 → S1-a 코드 → (S1-c 끝) 0027에서 옛 칸 제거.
-- 옛 코드가 is_personal · enabled_connectors만 써도 tier · capabilities가
-- 따라가도록 트리거로 맞춘다. 반대 방향도 맞춘다 — S1-b 전까지 대화
-- 코드는 enabled_connectors를 읽는다.
-- =============================================================


-- ── 1. agents 칸 ──────────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS tier text,
  ADD COLUMN IF NOT EXISTS model_id text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_version integer,
  ADD COLUMN IF NOT EXISTS approval_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- tier에는 DEFAULT를 두지 않는다. 기본값이 있으면 옛 코드가 is_personal=true로
-- 만든 행에 'official'이 먼저 들어가 트리거가 구분할 수 없다.
UPDATE agents
   SET tier = CASE WHEN COALESCE(is_personal, false) THEN 'personal' ELSE 'official' END
 WHERE tier IS NULL;

ALTER TABLE agents ALTER COLUMN tier SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_tier_check') THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_tier_check CHECK (tier IN ('personal', 'department', 'official'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_department_tier_visibility_check') THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_department_tier_visibility_check
      CHECK (tier <> 'department' OR visibility = 'department');
  END IF;
END $$;

COMMENT ON COLUMN agents.tier IS
  '단계의 유일한 근거. personal=본인만, department=주인 부서와 하위 부서가 쓰고 주인 부서원이 고침, official=관리자가 고침.';
COMMENT ON COLUMN agents.model_id IS '이 비서의 모델. NULL이면 기관 기본 모델.';
COMMENT ON COLUMN agents.capabilities IS
  '켜진 능력과 설정. 예: {"public_data":{"connectors":["law"]},"image":{}}. 정규화는 src/lib/capabilities/settings.ts.';
COMMENT ON COLUMN agents.version IS '현재 판 번호. save_agent만 올린다.';
COMMENT ON COLUMN agents.deleted_at IS
  '지운 시각. 행을 지우지 않는 이유: 대화(conversations.agent_id)와 판 기록이 이 비서를 가리킨다.';


-- ── 2. 능력 옮기기 ────────────────────────────────────────────
-- 지금 동작을 그대로 옮긴다: 대화형은 모두 사진을 받고, 문서가 있으면
-- 검색하고, 커넥터가 켜져 있으면 공공데이터를 조회한다.
UPDATE agents a
   SET capabilities = jsonb_strip_nulls(jsonb_build_object(
         'image',       CASE WHEN a.agent_type = 'chat' THEN '{}'::jsonb END,
         'doc_search',  CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.agent_id = a.id)
                            THEN '{}'::jsonb END,
         'public_data', CASE WHEN COALESCE(cardinality(a.enabled_connectors), 0) > 0
                            THEN jsonb_build_object('connectors', to_jsonb(a.enabled_connectors)) END))
 WHERE a.capabilities = '{}'::jsonb;


-- ── 3. 이름 유일성 ────────────────────────────────────────────
-- 예전 인덱스는 (department_id, name) 하나라, 같은 부서 직원 둘이 같은
-- 이름의 나만의 비서를 만들 수 없었다. 나만의 비서는 본인 안에서만 겹치지
-- 않으면 된다. 지운 비서는 이름을 놓아준다.
DROP INDEX IF EXISTS agents_department_name_idx;
CREATE UNIQUE INDEX IF NOT EXISTS agents_shared_name_idx
  ON agents(department_id, name) WHERE tier <> 'personal' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_personal_name_idx
  ON agents(owner_id, name) WHERE tier = 'personal' AND deleted_at IS NULL;


-- ── 4. 옛 칸 맞춤 트리거 (0027에서 제거) ─────────────────────
CREATE OR REPLACE FUNCTION agent_capability_connectors(caps jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(caps -> 'public_data' -> 'connectors', '[]'::jsonb))),
    '{}'::text[])
$$;

CREATE OR REPLACE FUNCTION agents_sync_legacy_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 단계 ↔ is_personal
  IF TG_OP = 'INSERT' THEN
    IF NEW.tier IS NULL THEN
      NEW.tier := CASE WHEN COALESCE(NEW.is_personal, false) THEN 'personal' ELSE 'official' END;
    END IF;
  ELSIF NEW.tier IS NOT DISTINCT FROM OLD.tier AND NEW.is_personal IS DISTINCT FROM OLD.is_personal THEN
    -- 옛 승인 코드는 is_personal=false만 바꾼다
    NEW.tier := CASE WHEN COALESCE(NEW.is_personal, false) THEN 'personal' ELSE 'official' END;
  END IF;
  NEW.is_personal := (NEW.tier = 'personal');

  -- 능력 ↔ enabled_connectors
  IF TG_OP = 'INSERT' THEN
    IF NEW.capabilities = '{}'::jsonb THEN
      -- 능력을 모르는 옛 코드의 생성. 지금 동작(사진 + 켠 커넥터)으로 채운다.
      NEW.capabilities := jsonb_strip_nulls(jsonb_build_object(
        'image',       CASE WHEN COALESCE(NEW.agent_type, 'chat') = 'chat' THEN '{}'::jsonb END,
        'public_data', CASE WHEN COALESCE(cardinality(NEW.enabled_connectors), 0) > 0
                            THEN jsonb_build_object('connectors', to_jsonb(NEW.enabled_connectors)) END));
    END IF;
    NEW.enabled_connectors := agent_capability_connectors(NEW.capabilities);
  ELSIF NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
    NEW.enabled_connectors := agent_capability_connectors(NEW.capabilities);
  ELSIF NEW.enabled_connectors IS DISTINCT FROM OLD.enabled_connectors THEN
    NEW.capabilities := CASE
      WHEN COALESCE(cardinality(NEW.enabled_connectors), 0) > 0
        THEN NEW.capabilities || jsonb_build_object('public_data',
               jsonb_build_object('connectors', to_jsonb(NEW.enabled_connectors)))
      ELSE NEW.capabilities - 'public_data'
    END;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agents_sync_legacy ON agents;
CREATE TRIGGER trg_agents_sync_legacy
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_sync_legacy_columns();


-- ── 5. 양식 파일 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  storage_path text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text,
  size_bytes   integer NOT NULL CHECK (size_bytes >= 0),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 새 행은 꺼진 채로 들어간다. save_agent가 판을 올리며 켠다 — 그래야
  -- 양식 추가도 판 사본에 남고 되돌리기 대상이 된다. 교체·제거도 행과
  -- 파일을 지우지 않고 여기만 찍는다.
  retired_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_active
  ON agent_templates(agent_id) WHERE retired_at IS NULL;

COMMENT ON TABLE agent_templates IS
  '비서의 양식 파일(HWP·HWPX·DOCX). 쓰는 중인 것은 비서당 10개. 채우는 일은 S2.';


-- ── 6. 판 기록 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN (
               'created', 'migrated', 'settings', 'revert', 'preset_update',
               'tier', 'document_added', 'document_removed', 'deleted')),
  version    integer,
  snapshot   jsonb,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 판 번호가 있는 종류만 사본을 갖는다
  CONSTRAINT agent_history_version_snapshot_check CHECK (
    (kind IN ('created', 'migrated', 'settings', 'revert', 'preset_update'))
      = (version IS NOT NULL AND snapshot IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_history_version_idx
  ON agent_history(agent_id, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_history_agent_idx
  ON agent_history(agent_id, created_at DESC);

COMMENT ON TABLE agent_history IS
  '비서 타임라인. 설정 판(사본 포함) · 단계 변경 · 참고 문서 올림/지움 · 지움.';


-- ── 7. 메시지에 판 번호 ───────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_version integer;
COMMENT ON COLUMN messages.agent_version IS
  '이 답을 만든 비서의 판 번호. 감사에서 "그때 어떤 지시문으로 답했나"에 답한다.';


-- ── 8. 판 사본 ────────────────────────────────────────────────
-- 사본에 담는 칸은 이 함수 한 곳에서 정한다.
CREATE OR REPLACE FUNCTION agent_snapshot(a agents)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'name',            a.name,
    'description',     a.description,
    'icon',            a.icon,
    'color',           a.color,
    'category',        a.category,
    'usage_guide',     a.usage_guide,
    'starter_prompts', to_jsonb(a.starter_prompts),
    'system_prompt',   a.system_prompt,
    'model_id',        a.model_id,
    'capabilities',    a.capabilities,
    'template_ids',    COALESCE(
                         (SELECT jsonb_agg(t.id ORDER BY t.created_at)
                            FROM agent_templates t
                           WHERE t.agent_id = a.id AND t.retired_at IS NULL),
                         '[]'::jsonb))
$$;


-- ── 9. 기존 비서에 판 1 ───────────────────────────────────────
INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by, detail)
SELECT a.id, 'migrated', a.version, agent_snapshot(a), NULL,
       jsonb_build_object('note', '0026 이전 데이터')
  FROM agents a
 WHERE NOT EXISTS (
         SELECT 1 FROM agent_history h WHERE h.agent_id = a.id AND h.version = a.version);


-- ── 10. 새 비서는 판 1을 자동으로 ─────────────────────────────
-- 만드는 경로가 여럿이다(관리자 생성, 나만의 비서, 기본 비서 설치, 옛 코드).
-- 경로마다 기록 코드를 두면 하나는 빠진다.
CREATE OR REPLACE FUNCTION agents_record_created()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by)
  VALUES (NEW.id, 'created', NEW.version, agent_snapshot(NEW), NEW.created_by);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_agents_record_created ON agents;
CREATE TRIGGER trg_agents_record_created
  AFTER INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_record_created();


-- ── 11. save_agent ────────────────────────────────────────────
-- 저장 · 판 번호 올리기 · 판 기록을 한 번에 한다. 권한은 호출 전에
-- 애플리케이션(agent-permissions.ts)이 판정한다 — 이 함수는 판의
-- 무결성만 책임진다.
CREATE OR REPLACE FUNCTION save_agent(
  p_agent_id     uuid,
  p_base_version integer,
  p_patch        jsonb,
  p_actor        uuid,
  p_kind         text,
  p_detail       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cur          agents%ROWTYPE;
  saved        agents%ROWTYPE;
  before_snap  jsonb;
  after_snap   jsonb;
  active_count integer;
BEGIN
  IF p_kind NOT IN ('settings', 'revert', 'preset_update') THEN
    RAISE EXCEPTION 'save_agent: 허용되지 않는 kind %', p_kind;
  END IF;

  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 함께 고칠 때 덮어쓰기 막기
  IF p_base_version IS DISTINCT FROM cur.version THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict', 'current_version', cur.version);
  END IF;

  before_snap := agent_snapshot(cur);

  IF p_patch ? 'template_ids' THEN
    UPDATE agent_templates SET retired_at = now()
     WHERE agent_id = p_agent_id AND retired_at IS NULL
       AND id::text NOT IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    UPDATE agent_templates SET retired_at = NULL
     WHERE agent_id = p_agent_id AND retired_at IS NOT NULL
       AND id::text IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    SELECT count(*) INTO active_count
      FROM agent_templates WHERE agent_id = p_agent_id AND retired_at IS NULL;
    IF active_count > 10 THEN
      RAISE EXCEPTION '양식은 비서당 10개까지입니다.' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE agents SET
    name            = CASE WHEN p_patch ? 'name'          THEN p_patch ->> 'name'          ELSE name END,
    description     = CASE WHEN p_patch ? 'description'   THEN p_patch ->> 'description'   ELSE description END,
    icon            = CASE WHEN p_patch ? 'icon'          THEN p_patch ->> 'icon'          ELSE icon END,
    color           = CASE WHEN p_patch ? 'color'         THEN p_patch ->> 'color'         ELSE color END,
    category        = CASE WHEN p_patch ? 'category'      THEN p_patch ->> 'category'      ELSE category END,
    usage_guide     = CASE WHEN p_patch ? 'usage_guide'   THEN p_patch ->> 'usage_guide'   ELSE usage_guide END,
    system_prompt   = CASE WHEN p_patch ? 'system_prompt' THEN p_patch ->> 'system_prompt' ELSE system_prompt END,
    model_id        = CASE WHEN p_patch ? 'model_id'      THEN p_patch ->> 'model_id'      ELSE model_id END,
    starter_prompts = CASE
                        WHEN NOT (p_patch ? 'starter_prompts') THEN starter_prompts
                        WHEN jsonb_typeof(p_patch -> 'starter_prompts') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'starter_prompts'))
                        ELSE NULL
                      END,
    capabilities    = CASE
                        WHEN NOT (p_patch ? 'capabilities') THEN capabilities
                        WHEN jsonb_typeof(p_patch -> 'capabilities') = 'object' THEN p_patch -> 'capabilities'
                        ELSE '{}'::jsonb
                      END,
    version         = cur.version + 1,
    -- 기본 비서 갱신(p_actor NULL)은 '사람이 고친 비서' 표시를 남기지 않는다
    updated_by      = COALESCE(p_actor, updated_by),
    updated_at      = now()
  WHERE id = p_agent_id
  RETURNING * INTO saved;

  after_snap := agent_snapshot(saved);

  INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by, detail)
  VALUES (
    p_agent_id, p_kind, saved.version, after_snap, p_actor,
    COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('fields', COALESCE(
      (SELECT jsonb_agg(n.key ORDER BY n.key)
         FROM jsonb_each(after_snap) AS n(key, value)
        WHERE n.value IS DISTINCT FROM before_snap -> n.key),
      '[]'::jsonb)));

  RETURN jsonb_build_object('ok', true, 'version', saved.version);
END $$;


-- ── 12. 단계 변경 ─────────────────────────────────────────────
-- 판 번호는 올리지 않는다(사본 칸이 아님). 단계와 기록은 함께 남긴다.
CREATE OR REPLACE FUNCTION change_agent_tier(
  p_agent_id      uuid,
  p_tier          text,
  p_actor         uuid,
  p_department_id uuid,
  p_visibility    text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cur agents%ROWTYPE;
BEGIN
  IF p_tier NOT IN ('department', 'official') THEN
    RAISE EXCEPTION 'change_agent_tier: 올릴 수 없는 단계 %', p_tier;
  END IF;

  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  UPDATE agents SET
    tier             = p_tier,
    owner_id         = NULL,
    department_id    = COALESCE(p_department_id, department_id),
    visibility       = p_visibility,
    approval_status  = CASE WHEN p_tier = 'official' THEN 'approved' ELSE approval_status END,
    approval_version = CASE WHEN p_tier = 'official' THEN NULL ELSE approval_version END,
    updated_by       = p_actor,
    updated_at       = now()
  WHERE id = p_agent_id;

  INSERT INTO agent_history (agent_id, kind, changed_by, detail)
  VALUES (p_agent_id, 'tier', p_actor,
          jsonb_build_object('from', cur.tier, 'to', p_tier, 'visibility', p_visibility));

  RETURN jsonb_build_object('ok', true);
END $$;


-- ── 13. 능력 하나 켜기 (문서 업로드가 doc_search를 켤 때) ──────
-- 지금은 문서만 올리면 바로 검색된다. 같은 동작을 지키되 판에도 남긴다.
CREATE OR REPLACE FUNCTION enable_agent_capability(
  p_agent_id   uuid,
  p_capability text,
  p_actor      uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cur agents%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR cur.capabilities ? p_capability THEN
    RETURN;
  END IF;
  PERFORM save_agent(
    p_agent_id, cur.version,
    jsonb_build_object('capabilities', cur.capabilities || jsonb_build_object(p_capability, '{}'::jsonb)),
    p_actor, 'settings', jsonb_build_object('reason', 'auto_enable', 'capability', p_capability));
END $$;


-- ── 확인 ─────────────────────────────────────────────────────
SELECT tier AS 단계, count(*) AS 비서수,
       count(*) FILTER (WHERE capabilities ? 'doc_search')  AS 문서찾기,
       count(*) FILTER (WHERE capabilities ? 'public_data') AS 공공데이터
  FROM agents GROUP BY tier ORDER BY tier;
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/agent-migration.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0026_agent_tiers.sql tests/agent-migration.test.ts
git commit -m "feat(db): 0026 비서 단계·판 기록·능력·양식 자리

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 권한 판정 모듈

**Files:**
- Create: `src/lib/agent-permissions.ts`
- Test: `tests/agent-permissions.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type AgentTier = 'personal' | 'department' | 'official';
  export type AgentVisibility = 'organization' | 'department';
  export interface AgentAccessInfo { id: string; tier: AgentTier; department_id: string; organization_id: string | null; visibility: AgentVisibility; owner_id: string | null; created_by: string | null; is_active: boolean; is_published: boolean; deleted_at: string | null; approval_status: string | null; version: number; approval_version: number | null; }
  export const AGENT_ACCESS_COLUMNS: string;
  export interface ActorScope { userId: string; isAdmin: boolean; departmentId: string; organizationId: string | null; visibleDepartmentIds: string[]; managedDepartmentIds: string[]; managesWholeOrganization: boolean; }
  export function canUseAgent(agent: AgentAccessInfo, actor: ActorScope): boolean;
  export function canEditAgent(agent: AgentAccessInfo, actor: ActorScope): boolean;
  export function canDeleteAgent(agent: AgentAccessInfo, actor: ActorScope): boolean;
  export function canPromoteToDepartment(agent: AgentAccessInfo, actor: ActorScope): boolean;
  export function canRequestOfficial(agent: AgentAccessInfo, actor: ActorScope): boolean;
  export function canApproveOfficial(agent: AgentAccessInfo, actor: ActorScope, targetVisibility: AgentVisibility): boolean;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — 설계 3.2 표 전체를 고정한다.

```typescript
// tests/agent-permissions.test.ts
import { describe, it, expect } from 'vitest';
import {
  canUseAgent,
  canEditAgent,
  canDeleteAgent,
  canPromoteToDepartment,
  canRequestOfficial,
  canApproveOfficial,
  type AgentAccessInfo,
  type ActorScope,
} from '@/lib/agent-permissions';

/**
 * 설계 3.2 판정 표.
 *
 * 부서 구조 (기관 ORG):
 *   TOP(최상위) ─ PLAN(기획예산실) ─ BUDGET(예산팀)
 *               └ HR(인사팀)
 * 다른 기관 OTHER의 부서 X.
 */
const ORG = 'org-1';

function agent(over: Partial<AgentAccessInfo>): AgentAccessInfo {
  return {
    id: 'a1', tier: 'official', department_id: 'PLAN', organization_id: ORG,
    visibility: 'organization', owner_id: null, created_by: 'creator',
    is_active: true, is_published: true, deleted_at: null, approval_status: null,
    version: 1, approval_version: null,
    ...over,
  };
}

function employee(dept: string, visible: string[], over: Partial<ActorScope> = {}): ActorScope {
  return {
    userId: `u-${dept}`, isAdmin: false, departmentId: dept, organizationId: ORG,
    visibleDepartmentIds: visible, managedDepartmentIds: [], managesWholeOrganization: false,
    ...over,
  };
}

const planMember = employee('PLAN', ['PLAN', 'TOP']);
const budgetMember = employee('BUDGET', ['BUDGET', 'PLAN', 'TOP']);
const hrMember = employee('HR', ['HR', 'TOP']);
const planAdmin = employee('PLAN', ['PLAN', 'TOP'], {
  userId: 'admin-plan', isAdmin: true, managedDepartmentIds: ['PLAN', 'BUDGET'],
});
const topAdmin = employee('TOP', ['TOP'], {
  userId: 'admin-top', isAdmin: true, managedDepartmentIds: ['TOP', 'PLAN', 'BUDGET', 'HR'],
  managesWholeOrganization: true,
});
const otherOrgAdmin = employee('X', ['X'], {
  userId: 'admin-x', organizationId: 'org-2', isAdmin: true,
  managedDepartmentIds: ['X'], managesWholeOrganization: true,
});

describe('나만의 비서', () => {
  const mine = agent({ tier: 'personal', owner_id: planMember.userId, visibility: 'organization' });

  it('본인만 쓰고 고치고 지운다', () => {
    expect(canUseAgent(mine, planMember)).toBe(true);
    expect(canEditAgent(mine, planMember)).toBe(true);
    expect(canDeleteAgent(mine, planMember)).toBe(true);
  });

  it('관리자도 남의 나만의 비서는 못 건드린다', () => {
    expect(canUseAgent(mine, topAdmin)).toBe(false);
    expect(canEditAgent(mine, topAdmin)).toBe(false);
    expect(canDeleteAgent(mine, topAdmin)).toBe(false);
  });
});

describe('부서 비서 (주인 부서 PLAN)', () => {
  const dept = agent({ tier: 'department', department_id: 'PLAN', visibility: 'department', created_by: planMember.userId });

  it('주인 부서와 하위 부서가 쓴다', () => {
    expect(canUseAgent(dept, planMember)).toBe(true);
    expect(canUseAgent(dept, budgetMember)).toBe(true);
    expect(canUseAgent(dept, hrMember)).toBe(false);
  });

  it('고치기는 주인 부서 소속과 관리 범위 관리자만', () => {
    expect(canEditAgent(dept, planMember)).toBe(true);
    // 하위 부서 직원은 쓰기만 한다
    expect(canEditAgent(dept, budgetMember)).toBe(false);
    expect(canEditAgent(dept, planAdmin)).toBe(true);
    expect(canEditAgent(dept, topAdmin)).toBe(true);
  });

  it('지우기는 처음 만든 사람과 관리자만', () => {
    const coworker = employee('PLAN', ['PLAN', 'TOP'], { userId: 'coworker' });
    expect(canEditAgent(dept, coworker)).toBe(true);
    expect(canDeleteAgent(dept, coworker)).toBe(false);
    expect(canDeleteAgent(dept, planMember)).toBe(true);
    expect(canDeleteAgent(dept, planAdmin)).toBe(true);
  });

  it('인사이동한 만든 사람은 권한을 잃는다', () => {
    const moved = employee('HR', ['HR', 'TOP'], { userId: planMember.userId });
    expect(canEditAgent(dept, moved)).toBe(false);
    // 지우기 권한은 '처음 만든 사람'이라 남는다 — 같은 기관 안에서만
    expect(canDeleteAgent(dept, moved)).toBe(true);
  });
});

describe('공식 비서', () => {
  const orgWide = agent({ tier: 'official', visibility: 'organization', department_id: 'TOP' });
  const narrowed = agent({ tier: 'official', visibility: 'department', department_id: 'PLAN' });

  it('기관 전체 비서는 같은 기관 전원이 쓴다', () => {
    expect(canUseAgent(orgWide, hrMember)).toBe(true);
    expect(canUseAgent(orgWide, otherOrgAdmin)).toBe(false);
  });

  it('기관 전체 비서는 기관 전체 관리자만 고친다', () => {
    expect(canEditAgent(orgWide, topAdmin)).toBe(true);
    expect(canEditAgent(orgWide, planAdmin)).toBe(false);
    expect(canEditAgent(orgWide, planMember)).toBe(false);
  });

  it('부서로 좁힌 비서는 그 부서를 관리하는 관리자가 고친다', () => {
    expect(canUseAgent(narrowed, budgetMember)).toBe(true);
    expect(canUseAgent(narrowed, hrMember)).toBe(false);
    expect(canEditAgent(narrowed, planAdmin)).toBe(true);
    expect(canEditAgent(narrowed, planMember)).toBe(false);
    expect(canDeleteAgent(narrowed, planAdmin)).toBe(true);
  });

  it('노출 대기 중이면 고칠 수 있는 관리자만 쓴다', () => {
    const hidden = { ...orgWide, is_published: false };
    expect(canUseAgent(hidden, hrMember)).toBe(false);
    expect(canUseAgent(hidden, topAdmin)).toBe(true);
  });
});

describe('공통 차단', () => {
  it('다른 기관은 무엇도 못 한다', () => {
    const narrowed = agent({ tier: 'official', visibility: 'department', department_id: 'X', organization_id: ORG });
    expect(canEditAgent(narrowed, otherOrgAdmin)).toBe(false);
    expect(canUseAgent(narrowed, otherOrgAdmin)).toBe(false);
  });

  it('기관을 모르는 요청자는 무엇도 못 한다', () => {
    const lost = { ...planMember, organizationId: null };
    expect(canUseAgent(agent({}), lost)).toBe(false);
  });

  it('꺼지거나 지운 비서는 아무도 못 쓴다', () => {
    expect(canUseAgent(agent({ is_active: false }), topAdmin)).toBe(false);
    expect(canUseAgent(agent({ deleted_at: '2026-10-14' }), topAdmin)).toBe(false);
    expect(canEditAgent(agent({ deleted_at: '2026-10-14' }), topAdmin)).toBe(false);
  });
});

describe('단계 이동', () => {
  it('나만의 → 부서는 본인만', () => {
    const mine = agent({ tier: 'personal', owner_id: planMember.userId });
    expect(canPromoteToDepartment(mine, planMember)).toBe(true);
    expect(canPromoteToDepartment(mine, topAdmin)).toBe(false);
    expect(canPromoteToDepartment(agent({ tier: 'department' }), planMember)).toBe(false);
  });

  it('공식 신청은 고칠 수 있는 사람이, 신청 중이 아닐 때만', () => {
    const dept = agent({ tier: 'department', visibility: 'department', department_id: 'PLAN' });
    expect(canRequestOfficial(dept, planMember)).toBe(true);
    expect(canRequestOfficial(dept, budgetMember)).toBe(false);
    expect(canRequestOfficial({ ...dept, approval_status: 'pending' }, planMember)).toBe(false);
    expect(canRequestOfficial(agent({ tier: 'official' }), topAdmin)).toBe(false);
  });

  it('승인은 공식이 된 뒤 고칠 수 있는 관리자만', () => {
    const pending = agent({ tier: 'department', visibility: 'department', department_id: 'PLAN', approval_status: 'pending' });
    expect(canApproveOfficial(pending, planAdmin, 'department')).toBe(true);
    expect(canApproveOfficial(pending, planAdmin, 'organization')).toBe(false);
    expect(canApproveOfficial(pending, topAdmin, 'organization')).toBe(true);
    expect(canApproveOfficial(pending, planMember, 'department')).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-permissions.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agent-permissions"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/agent-permissions.ts
/**
 * 비서 권한 판정 — 설계 3절.
 *
 * DB를 보지 않는 순수 함수만 둔다. 비서 정보와 요청자 범위를 받아 판정만
 * 돌려준다. 그래야 판정 표 전체를 단위 테스트로 고정할 수 있다
 * (tests/agent-permissions.test.ts).
 *
 * 예전에는 판정이 라우트마다 흩어져 있었다 — 대화는 chat/route.ts 안에서,
 * 수정은 'ADMIN이면 통과'로. 한 곳만 어긋나도 드러나지 않는 구조였다.
 * 비서를 바꾸는 라우트는 전부 이 모듈을 거친다
 * (tests/agent-route-permissions.test.ts가 원본으로 확인한다).
 */

export type AgentTier = 'personal' | 'department' | 'official';
export type AgentVisibility = 'organization' | 'department';

export interface AgentAccessInfo {
  id: string;
  tier: AgentTier;
  /** 부서 비서는 주인 부서, 공식 비서는 걸린 부서, 나만의 비서는 만든 당시 부서 */
  department_id: string;
  organization_id: string | null;
  visibility: AgentVisibility;
  owner_id: string | null;
  created_by: string | null;
  is_active: boolean;
  is_published: boolean;
  deleted_at: string | null;
  approval_status: string | null;
  version: number;
  approval_version: number | null;
}

/** loadAgentAccess가 select하는 칸. AgentAccessInfo와 함께 고친다. */
export const AGENT_ACCESS_COLUMNS =
  'id, tier, department_id, organization_id, visibility, owner_id, created_by, ' +
  'is_active, is_published, deleted_at, approval_status, version, approval_version';

export interface ActorScope {
  userId: string;
  isAdmin: boolean;
  departmentId: string;
  organizationId: string | null;
  /** 자기 부서 + 상위 부서 (getVisibleDepartmentIds) */
  visibleDepartmentIds: string[];
  /** 관리자만 채운다. 자기 부서 + 하위, 최상위면 기관 전체 (getManagedDepartmentIds) */
  managedDepartmentIds: string[];
  /** 최상위 부서 소속 관리자 */
  managesWholeOrganization: boolean;
}

/** 모든 판정의 전제. 기관을 모르면 무엇도 허용하지 않는다. */
function sameOrganization(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return Boolean(actor.organizationId) && agent.organization_id === actor.organizationId;
}

function managesAgentDepartment(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return actor.isAdmin && actor.managedDepartmentIds.includes(agent.department_id);
}

export function canEditAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 주인 부서 소속만. 하위 부서 직원은 쓰기만 한다 — 상위 부서가 만든
      // 비서를 하위 부서 누구나 바꾸면 책임 소재가 흐려진다(결정 4).
      return actor.departmentId === agent.department_id || managesAgentDepartment(agent, actor);
    case 'official':
      return agent.visibility === 'organization'
        ? actor.isAdmin && actor.managesWholeOrganization
        : managesAgentDepartment(agent, actor);
  }
}

export function canUseAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at || !agent.is_active) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 주인 부서가 내 부서 계통(자기 + 상위)에 있으면 = 내가 주인 부서이거나 그 하위
      return actor.visibleDepartmentIds.includes(agent.department_id);
    case 'official':
      // 노출 대기 중은 공개 전에 관리자가 직접 써 보는 단계다
      if (!agent.is_published) return canEditAgent(agent, actor);
      return agent.visibility === 'organization'
        ? true
        : actor.visibleDepartmentIds.includes(agent.department_id);
  }
}

export function canDeleteAgent(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.deleted_at) return false;
  if (!sameOrganization(agent, actor)) return false;

  switch (agent.tier) {
    case 'personal':
      return agent.owner_id === actor.userId;
    case 'department':
      // 지우기는 되돌릴 수 없다. 부서원 아무나 지우면 한 사람의 실수로
      // 부서 전체가 쓰던 비서가 사라진다(결정 4).
      return agent.created_by === actor.userId || managesAgentDepartment(agent, actor);
    case 'official':
      return canEditAgent(agent, actor);
  }
}

export function canPromoteToDepartment(agent: AgentAccessInfo, actor: ActorScope): boolean {
  return agent.tier === 'personal' && canEditAgent(agent, actor);
}

export function canRequestOfficial(agent: AgentAccessInfo, actor: ActorScope): boolean {
  if (agent.tier === 'official') return false;
  if (agent.approval_status === 'pending') return false;
  return canEditAgent(agent, actor);
}

/**
 * 승인할 수 있는 관리자 = 공식이 된 뒤 그 비서를 고칠 수 있는 관리자.
 * 기관 전체로 여는 승인은 기관 전체 관리자만 한다.
 */
export function canApproveOfficial(
  agent: AgentAccessInfo,
  actor: ActorScope,
  targetVisibility: AgentVisibility
): boolean {
  if (agent.deleted_at || !actor.isAdmin) return false;
  if (!sameOrganization(agent, actor)) return false;
  return targetVisibility === 'organization'
    ? actor.managesWholeOrganization
    : actor.managedDepartmentIds.includes(agent.department_id);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/agent-permissions.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-permissions.ts tests/agent-permissions.test.ts
git commit -m "feat: 비서 권한 판정 모듈 — 세 단계 판정 표

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 능력 설정과 기관 범위

**Files:**
- Create: `src/lib/capabilities/settings.ts`
- Modify: `src/lib/connector-scope.ts` (전체 교체)
- Test: `tests/capability-settings.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const CAPABILITY_IDS: readonly ['doc_search', 'public_data', 'image'];
  export type CapabilityId = (typeof CAPABILITY_IDS)[number];
  export interface CapabilitySettings { doc_search?: Record<string, never>; image?: Record<string, never>; public_data?: { connectors: string[] }; }
  export type NormalizeResult = { ok: true; value: CapabilitySettings } | { ok: false; message: string };
  export function normalizeCapabilities(raw: unknown, opts: { knownConnectorIds: string[] }): NormalizeResult;
  export interface CapabilityScope { publicDataConnectors: Set<string> }
  export function deriveCapabilityScope(rows: { capabilities: unknown }[], knownConnectorIds: string[]): CapabilityScope;
  export function scopeViolations(caps: CapabilitySettings, scope: CapabilityScope): string[];
  export function clampToScope(caps: CapabilitySettings, scope: CapabilityScope): CapabilitySettings;
  // connector-scope.ts
  export async function getCapabilityScope(departmentId: string): Promise<CapabilityScope>;
  export async function getPersonalConnectorIds(departmentId: string): Promise<string[]>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/capability-settings.test.ts
import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_IDS,
  normalizeCapabilities,
  deriveCapabilityScope,
  scopeViolations,
  clampToScope,
} from '@/lib/capabilities/settings';

const known = { knownConnectorIds: ['law', 'kosis'] };

describe('능력 설정 정규화', () => {
  it('S1의 능력은 셋이다', () => {
    expect([...CAPABILITY_IDS]).toEqual(['doc_search', 'public_data', 'image']);
  });

  it('비어 있으면 빈 설정', () => {
    expect(normalizeCapabilities(null, known)).toEqual({ ok: true, value: {} });
    expect(normalizeCapabilities({}, known)).toEqual({ ok: true, value: {} });
  });

  it('설정이 없는 능력은 빈 객체로 맞춘다', () => {
    expect(normalizeCapabilities({ image: { junk: 1 }, doc_search: {} }, known)).toEqual({
      ok: true,
      value: { image: {}, doc_search: {} },
    });
  });

  it('모르는 능력은 거절한다', () => {
    const r = normalizeCapabilities({ table_merge: {} }, known);
    expect(r.ok).toBe(false);
  });

  it('없는 커넥터는 거절한다', () => {
    const r = normalizeCapabilities({ public_data: { connectors: ['law', 'g2b'] } }, known);
    expect(r).toEqual({ ok: false, message: '쓸 수 없는 공공데이터 연결입니다: g2b' });
  });

  it('커넥터가 비면 공공데이터 능력을 뺀다', () => {
    expect(normalizeCapabilities({ public_data: { connectors: [] } }, known)).toEqual({ ok: true, value: {} });
  });

  it('배열·문자열은 객체가 아니다', () => {
    expect(normalizeCapabilities(['image'], known).ok).toBe(false);
    expect(normalizeCapabilities({ image: true }, known).ok).toBe(false);
  });
});

describe('기관 범위', () => {
  const scope = deriveCapabilityScope(
    [
      { capabilities: { public_data: { connectors: ['law'] } } },
      { capabilities: { public_data: { connectors: ['dart'] } } }, // 키가 빠진 커넥터
      { capabilities: null },
    ],
    ['law', 'kosis']
  );

  it('공식 비서가 켠 커넥터만, 지금 쓸 수 있는 것만', () => {
    expect([...scope.publicDataConnectors]).toEqual(['law']);
  });

  it('문서 찾기와 사진은 범위 검사 대상이 아니다', () => {
    // 자기 비서의 문서·자기가 첨부한 사진은 기관 밖으로 나가지 않는다
    expect(scopeViolations({ doc_search: {}, image: {} }, scope)).toEqual([]);
  });

  it('범위 밖 커넥터를 짚는다', () => {
    expect(scopeViolations({ public_data: { connectors: ['law', 'kosis'] } }, scope)).toEqual(['kosis']);
  });

  it('대화할 때는 범위 밖을 걷어낸다', () => {
    expect(clampToScope({ image: {}, public_data: { connectors: ['kosis'] } }, scope)).toEqual({ image: {} });
    expect(clampToScope({ public_data: { connectors: ['law', 'kosis'] } }, scope)).toEqual({
      public_data: { connectors: ['law'] },
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/capability-settings.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/capabilities/settings"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/capabilities/settings.ts
/**
 * 능력 설정 — 어떤 능력이 있고, 설정이 어떤 꼴이어야 하며, 기관이 어디까지
 * 열어 두었는가. DB를 보지 않는 순수 함수만 둔다.
 *
 * 능력의 실행(도구·prepare)은 S1-b의 능력 목록(`./index.ts`)이 맡는다.
 * 그 목록의 id가 여기 CAPABILITY_IDS와 같은지 테스트가 확인한다.
 */

export const CAPABILITY_IDS = ['doc_search', 'public_data', 'image'] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilitySettings {
  doc_search?: Record<string, never>;
  image?: Record<string, never>;
  public_data?: { connectors: string[] };
}

export type NormalizeResult = { ok: true; value: CapabilitySettings } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCapabilities(
  raw: unknown,
  opts: { knownConnectorIds: string[] }
): NormalizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, message: '능력 설정 형식이 올바르지 않습니다.' };

  const value: CapabilitySettings = {};
  const known = new Set(opts.knownConnectorIds);

  for (const [id, settings] of Object.entries(raw)) {
    if (!(CAPABILITY_IDS as readonly string[]).includes(id)) {
      return { ok: false, message: `알 수 없는 능력입니다: ${id}` };
    }
    if (!isPlainObject(settings)) {
      return { ok: false, message: `능력 설정 형식이 올바르지 않습니다: ${id}` };
    }

    if (id === 'public_data') {
      const connectors = settings.connectors;
      if (!Array.isArray(connectors) || connectors.some((c) => typeof c !== 'string')) {
        return { ok: false, message: '공공데이터 연결 목록 형식이 올바르지 않습니다.' };
      }
      const unknown = connectors.filter((c) => !known.has(c));
      if (unknown.length > 0) {
        return { ok: false, message: `쓸 수 없는 공공데이터 연결입니다: ${unknown.join(', ')}` };
      }
      const unique = [...new Set(connectors as string[])];
      // 연결이 하나도 없는 공공데이터 능력은 켜 둔 의미가 없다
      if (unique.length > 0) value.public_data = { connectors: unique };
    } else {
      // 설정이 없는 능력. 딸려 온 값은 버린다.
      value[id as 'doc_search' | 'image'] = {};
    }
  }

  return { ok: true, value };
}

/**
 * 나만의·부서 비서가 켤 수 있는 범위.
 *
 * '기관이 공식 비서에서 이미 쓰고 있는가'로 정한다(connector-scope.ts의
 * 원래 설계). 별도 허용 목록을 두면 관리자가 같은 결정을 두 곳에서 하게 된다.
 *
 * 범위 검사는 public_data에만 건다. 문서 찾기는 자기 비서에 올린 문서를,
 * 사진 읽기는 자기가 첨부한 사진을 쓸 뿐이라 기관 밖으로 나가지 않는다.
 * 이 둘까지 묶으면 지금 문서를 올려 쓰는 나만의 비서가 막힌다.
 */
export interface CapabilityScope {
  publicDataConnectors: Set<string>;
}

export function deriveCapabilityScope(
  rows: { capabilities: unknown }[],
  knownConnectorIds: string[]
): CapabilityScope {
  const known = new Set(knownConnectorIds);
  const publicDataConnectors = new Set<string>();

  for (const row of rows) {
    const caps = isPlainObject(row.capabilities) ? row.capabilities : {};
    const pd = isPlainObject(caps.public_data) ? caps.public_data : null;
    const connectors = Array.isArray(pd?.connectors) ? pd.connectors : [];
    for (const id of connectors) {
      // 키가 빠져 목록에서 사라진 커넥터가 저장돼 있을 수 있다
      if (typeof id === 'string' && known.has(id)) publicDataConnectors.add(id);
    }
  }

  return { publicDataConnectors };
}

/** 범위 밖인 것. 저장할 때 거절 사유로 쓴다. */
export function scopeViolations(caps: CapabilitySettings, scope: CapabilityScope): string[] {
  return (caps.public_data?.connectors ?? []).filter((id) => !scope.publicDataConnectors.has(id));
}

/**
 * 범위 밖을 걷어낸 설정. 대화할 때 쓴다 — 관리자가 나중에 기관에서 끈
 * 연결을 기존 나만의·부서 비서에서도 거둬들이는 길이다.
 */
export function clampToScope(caps: CapabilitySettings, scope: CapabilityScope): CapabilitySettings {
  const result: CapabilitySettings = { ...caps };
  if (caps.public_data) {
    const kept = caps.public_data.connectors.filter((id) => scope.publicDataConnectors.has(id));
    if (kept.length > 0) result.public_data = { connectors: kept };
    else delete result.public_data;
  }
  return result;
}
```

```typescript
// src/lib/connector-scope.ts  (전체 교체)
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { connectorCatalog } from '@/lib/connectors';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { deriveCapabilityScope, type CapabilityScope } from '@/lib/capabilities/settings';

/**
 * 나만의·부서 비서가 켤 수 있는 능력 범위.
 *
 * 판정 근거는 "내가 볼 수 있는 공식 비서 중 하나라도 그것을 켜 두었는가"다.
 * 관리자가 그 연결을 이 기관에서 쓰기로 이미 판단했다는 뜻이기 때문이다.
 * 계산은 capabilities/settings.ts의 순수 함수가 한다.
 */
export async function getCapabilityScope(departmentId: string): Promise<CapabilityScope> {
  const known = connectorCatalog().map((c) => c.id);
  if (known.length === 0) return { publicDataConnectors: new Set() };

  const scope = await getAccessScope(departmentId);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('capabilities')
    .or(visibilityFilter(scope))
    .eq('tier', 'official')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (error) {
    // 조회 실패가 권한을 넓히면 안 된다. 아무것도 못 켜는 쪽으로 닫는다.
    console.error('[connector-scope] 공식 비서 조회 실패', error);
    return { publicDataConnectors: new Set() };
  }

  return deriveCapabilityScope((data ?? []) as { capabilities: unknown }[], known);
}

/** 화면의 커넥터 선택지(/api/connectors). */
export async function getPersonalConnectorIds(departmentId: string): Promise<string[]> {
  const scope = await getCapabilityScope(departmentId);
  return [...scope.publicDataConnectors];
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/capability-settings.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/capabilities/settings.ts src/lib/connector-scope.ts tests/capability-settings.test.ts
git commit -m "feat: 능력 설정 정규화와 기관 범위

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 요청 본문 나누기

**Files:**
- Create: `src/lib/agent-patch.ts`
- Test: `tests/agent-patch.test.ts`

**Interfaces:**
- Consumes: `parseCatalogFields(body, currentType)` · `AgentType` (`src/lib/agent-catalog.ts`), `normalizeCapabilities`, `CapabilitySettings` (Task 3)
- Produces:
  ```typescript
  export const SNAPSHOT_KEYS: readonly ['name','description','icon','color','category','usage_guide','starter_prompts','system_prompt','model_id','capabilities','template_ids'];
  export interface AgentSettingsPatch { name?: string; description?: string | null; icon?: string | null; color?: string | null; category?: string | null; usage_guide?: string | null; starter_prompts?: string[] | null; system_prompt?: string | null; model_id?: string | null; capabilities?: CapabilitySettings; template_ids?: string[]; }
  export interface SplitResult { settings: AgentSettingsPatch; operational: Record<string, unknown>; error?: string }
  export function splitAgentBody(body: Record<string, unknown>, opts: { currentType: AgentType; knownConnectorIds: string[]; knownModelIds: string[] }): SplitResult;
  export function changedSettingKeys(current: Record<string, unknown>, patch: AgentSettingsPatch): string[];
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/agent-patch.test.ts
import { describe, it, expect } from 'vitest';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS } from '@/lib/agent-patch';

const opts = { currentType: 'chat' as const, knownConnectorIds: ['law'], knownModelIds: ['claude-sonnet-4-6', 'claude-haiku-4-5'] };

describe('요청 본문 나누기', () => {
  it('판 설정과 운영 값을 가른다', () => {
    const r = splitAgentBody(
      { name: ' 공문 비서 ', system_prompt: '지시', is_published: true, display_order: 3, visibility: 'department' },
      opts
    );
    expect(r.error).toBeUndefined();
    expect(r.settings).toEqual({ name: '공문 비서', system_prompt: '지시' });
    expect(r.operational).toEqual({ is_published: true, display_order: 3, visibility: 'department' });
  });

  it('카탈로그 칸도 성격대로 나눈다', () => {
    const r = splitAgentBody({ icon: '📨', usage_guide: '안내', starter_prompts: 'a\nb', agent_type: 'chat' }, opts);
    expect(r.settings).toEqual({ icon: '📨', usage_guide: '안내', starter_prompts: ['a', 'b'] });
    expect(r.operational).toEqual({ agent_type: 'chat' });
  });

  it('빈 이름은 거절한다', () => {
    expect(splitAgentBody({ name: '  ' }, opts).error).toBe('비서 이름은 비워 둘 수 없습니다.');
  });

  it('모델은 등록된 것만, 빈 값은 기본 모델', () => {
    expect(splitAgentBody({ model_id: 'claude-haiku-4-5' }, opts).settings.model_id).toBe('claude-haiku-4-5');
    expect(splitAgentBody({ model_id: '' }, opts).settings.model_id).toBeNull();
    expect(splitAgentBody({ model_id: 'gpt-5' }, opts).error).toBe('등록되지 않은 모델입니다.');
  });

  it('능력은 정규화해서 받는다', () => {
    const r = splitAgentBody({ capabilities: { image: {}, public_data: { connectors: ['law'] } } }, opts);
    expect(r.settings.capabilities).toEqual({ image: {}, public_data: { connectors: ['law'] } });
  });

  it('옛 enabled_connectors는 받지 않는다', () => {
    // 옛 화면이 남아 있으면 조용히 무시되지 않고 드러나야 한다
    expect(splitAgentBody({ enabled_connectors: ['law'] }, opts).error).toContain('capabilities');
  });

  it('template_ids는 본문으로 받지 않는다', () => {
    // 양식은 양식 라우트만 바꾼다. 본문으로 받으면 남의 파일 id를 끼워 넣을 수 있다.
    expect(splitAgentBody({ template_ids: ['x'] }, opts).error).toBeDefined();
  });

  it('잘못된 공개 범위는 거절한다', () => {
    expect(splitAgentBody({ visibility: 'all' }, opts).error).toBeDefined();
  });
});

describe('바뀐 칸 찾기', () => {
  it('같은 값을 다시 보내면 바뀐 것이 없다', () => {
    const current = { name: 'A', starter_prompts: ['x'], capabilities: { image: {} } };
    expect(changedSettingKeys(current, { name: 'A', starter_prompts: ['x'], capabilities: { image: {} } })).toEqual([]);
  });

  it('다른 값만 짚는다', () => {
    expect(changedSettingKeys({ name: 'A', description: null }, { name: 'B', description: null })).toEqual(['name']);
  });

  it('판 사본 칸은 11개다', () => {
    expect(SNAPSHOT_KEYS).toHaveLength(11);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-patch.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/agent-patch"`

- [ ] **Step 3: 구현**

```typescript
// src/lib/agent-patch.ts
import { parseCatalogFields, type AgentType } from '@/lib/agent-catalog';
import { normalizeCapabilities, type CapabilitySettings } from '@/lib/capabilities/settings';

/**
 * 비서 수정 요청을 두 갈래로 나눈다.
 *
 * - 판 설정: 판 사본에 들어가고 save_agent로만 바꾼다(되돌리기 대상)
 * - 운영 값: 노출·정렬·공개 범위·사용 여부·유형. 운영자가 조정하는 값이라
 *   되돌리기가 건드리면 안 된다(설계 2.4)
 *
 * SNAPSHOT_KEYS는 0026의 agent_snapshot()과 같아야 한다.
 */
export const SNAPSHOT_KEYS = [
  'name', 'description', 'icon', 'color', 'category', 'usage_guide',
  'starter_prompts', 'system_prompt', 'model_id', 'capabilities', 'template_ids',
] as const;

export interface AgentSettingsPatch {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  category?: string | null;
  usage_guide?: string | null;
  starter_prompts?: string[] | null;
  system_prompt?: string | null;
  model_id?: string | null;
  capabilities?: CapabilitySettings;
  /** 양식 라우트만 채운다. 요청 본문으로는 받지 않는다. */
  template_ids?: string[];
}

export interface SplitResult {
  settings: AgentSettingsPatch;
  operational: Record<string, unknown>;
  error?: string;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function splitAgentBody(
  body: Record<string, unknown>,
  opts: { currentType: AgentType; knownConnectorIds: string[]; knownModelIds: string[] }
): SplitResult {
  const result: SplitResult = { settings: {}, operational: {} };
  const fail = (error: string): SplitResult => ({ ...result, error });

  if (body.enabled_connectors !== undefined) {
    return fail('enabled_connectors는 더 이상 받지 않습니다. capabilities.public_data로 보내 주세요.');
  }
  if (body.template_ids !== undefined) {
    return fail('양식은 양식 관리에서 바꿔 주세요.');
  }

  // 아이콘·카테고리·안내·예시·유형·주소 검사는 생성과 수정이 같은 규칙을 쓴다
  const { payload: catalog, error } = parseCatalogFields(body, opts.currentType);
  if (error) return fail(error);

  if (catalog.icon !== undefined) result.settings.icon = catalog.icon;
  if (catalog.category !== undefined) result.settings.category = catalog.category;
  if (catalog.usage_guide !== undefined) result.settings.usage_guide = catalog.usage_guide;
  if (catalog.starter_prompts !== undefined) result.settings.starter_prompts = catalog.starter_prompts;
  if (catalog.is_published !== undefined) result.operational.is_published = catalog.is_published;
  if (catalog.display_order !== undefined) result.operational.display_order = catalog.display_order;
  if (catalog.agent_type !== undefined) result.operational.agent_type = catalog.agent_type;
  if (catalog.link_url !== undefined) result.operational.link_url = catalog.link_url;

  if (body.name !== undefined) {
    const name = textOrNull(body.name);
    if (!name) return fail('비서 이름은 비워 둘 수 없습니다.');
    result.settings.name = name;
  }
  if (body.description !== undefined) result.settings.description = textOrNull(body.description);
  if (body.system_prompt !== undefined) result.settings.system_prompt = textOrNull(body.system_prompt);
  if (body.color !== undefined) result.settings.color = textOrNull(body.color);

  if (body.model_id !== undefined) {
    if (body.model_id === null || body.model_id === '') {
      result.settings.model_id = null; // 기관 기본 모델
    } else if (typeof body.model_id === 'string' && opts.knownModelIds.includes(body.model_id)) {
      result.settings.model_id = body.model_id;
    } else {
      return fail('등록되지 않은 모델입니다.');
    }
  }

  if (body.capabilities !== undefined) {
    const normalized = normalizeCapabilities(body.capabilities, { knownConnectorIds: opts.knownConnectorIds });
    if (!normalized.ok) return fail(normalized.message);
    result.settings.capabilities = normalized.value;
  }

  if (body.visibility !== undefined) {
    if (body.visibility !== 'organization' && body.visibility !== 'department') {
      return fail("공개 범위는 'organization' 또는 'department'만 가능합니다.");
    }
    result.operational.visibility = body.visibility;
  }
  if (body.is_active !== undefined) result.operational.is_active = Boolean(body.is_active);

  return result;
}

/** 같은 값을 다시 보낸 저장으로 빈 판이 쌓이지 않게 한다. */
export function changedSettingKeys(current: Record<string, unknown>, patch: AgentSettingsPatch): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => JSON.stringify(value ?? null) !== JSON.stringify(current[key] ?? null))
    .map(([key]) => key);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/agent-patch.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-patch.ts tests/agent-patch.test.ts
git commit -m "feat: 비서 수정 요청을 판 설정과 운영 값으로 나누기

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 요청자 범위와 비서 저장소

**Files:**
- Create: `src/lib/actor-scope.ts`
- Create: `src/lib/agent-store.ts`
- Modify: `src/lib/db.ts` (Agent 타입)

**Interfaces:**
- Consumes: `ActorScope`, `AgentAccessInfo`, `AGENT_ACCESS_COLUMNS`, `AgentTier`, `AgentVisibility` (Task 2), `AgentSettingsPatch` (Task 4)
- Produces:
  ```typescript
  // actor-scope.ts
  export async function getActorScope(session: Session | null): Promise<ActorScope | null>;
  // agent-store.ts
  export async function loadAgentAccess(agentId: string): Promise<AgentAccessInfo | null>;
  export type SaveResult = { ok: true; version: number } | { ok: false; reason: 'conflict'; currentVersion: number } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'template_limit' } | { ok: false; reason: 'duplicate_name' } | { ok: false; reason: 'error'; message: string };
  export async function saveAgentSettings(agentId: string, baseVersion: number, patch: AgentSettingsPatch, actorId: string | null, kind: 'settings' | 'revert' | 'preset_update', detail?: Record<string, unknown>): Promise<SaveResult>;
  export async function changeAgentTier(args: { agentId: string; tier: 'department' | 'official'; actorId: string; departmentId: string | null; visibility: AgentVisibility }): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'duplicate_name' | 'error'; message?: string }>;
  export async function recordAgentEvent(agentId: string, kind: 'document_added' | 'document_removed' | 'deleted', actorId: string | null, detail?: Record<string, unknown>): Promise<void>;
  export async function softDeleteAgent(agentId: string, actorId: string): Promise<boolean>;
  export async function enableAgentCapability(agentId: string, capability: 'doc_search', actorId: string | null): Promise<void>;
  export interface AgentHistoryRow { id: string; kind: string; version: number | null; snapshot: Record<string, unknown> | null; changed_by: string | null; changed_by_name: string | null; detail: Record<string, unknown>; created_at: string }
  export async function getAgentHistory(agentId: string, limit?: number): Promise<AgentHistoryRow[]>;
  export async function getVersionSnapshot(agentId: string, version: number): Promise<Record<string, unknown> | null>;
  export function saveFailureResponse(result: Exclude<SaveResult, { ok: true }>): { status: number; message: string; details?: Record<string, unknown> };
  ```

- [ ] **Step 1: `getActorScope` 작성**

```typescript
// src/lib/actor-scope.ts
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdminSession } from '@/lib/auth';
import { getVisibleDepartmentIds, getManagedDepartmentIds } from '@/lib/department-scope';
import type { ActorScope } from '@/lib/agent-permissions';

/**
 * 세션 → 권한 판정에 쓰는 요청자 범위.
 *
 * 소속을 알 수 없으면 null을 돌려준다. 라우트는 403으로 거절한다 —
 * 소속을 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0).
 * 부서 조회가 실패하면 기관을 모르는 상태가 되어 모든 판정이 거절된다.
 */
export async function getActorScope(session: Session | null): Promise<ActorScope | null> {
  const userId = session?.user?.id;
  if (!userId) return null;

  let departmentId: string | null = session.user.departmentId ?? null;
  if (!departmentId) {
    const { data } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', userId)
      .maybeSingle();
    departmentId = data?.department_id ?? null;
  }
  if (!departmentId) return null;

  const isAdmin = isAdminSession(session);
  const [{ data: dept }, visibleDepartmentIds, managedDepartmentIds] = await Promise.all([
    supabaseAdmin
      .from('departments')
      .select('organization_id, parent_id')
      .eq('id', departmentId)
      .maybeSingle(),
    getVisibleDepartmentIds(departmentId),
    isAdmin ? getManagedDepartmentIds(departmentId) : Promise.resolve([] as string[]),
  ]);

  const organizationId: string | null = dept?.organization_id ?? null;

  return {
    userId,
    isAdmin,
    departmentId,
    organizationId,
    visibleDepartmentIds,
    managedDepartmentIds,
    // getManagedDepartmentIds와 같은 규칙: 상위가 없는 부서 소속 관리자는 기관 전체
    managesWholeOrganization: isAdmin && Boolean(organizationId) && dept?.parent_id == null,
  };
}
```

- [ ] **Step 2: `agent-store.ts` 작성**

```typescript
// src/lib/agent-store.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  AGENT_ACCESS_COLUMNS,
  type AgentAccessInfo,
  type AgentVisibility,
} from '@/lib/agent-permissions';
import type { AgentSettingsPatch } from '@/lib/agent-patch';

/**
 * 비서 저장소 — 판 무결성이 걸린 쓰기는 전부 여기를 거친다.
 *
 * 권한은 판정하지 않는다. 라우트가 agent-permissions로 먼저 판정하고
 * 여기를 부른다. 여기서는 DB 함수(save_agent · change_agent_tier)의
 * 결과를 라우트가 쓰기 좋은 꼴로 바꾼다.
 */

export async function loadAgentAccess(agentId: string): Promise<AgentAccessInfo | null> {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select(AGENT_ACCESS_COLUMNS)
    .eq('id', agentId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as AgentAccessInfo;
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'conflict'; currentVersion: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'template_limit' }
  | { ok: false; reason: 'duplicate_name' }
  | { ok: false; reason: 'error'; message: string };

export async function saveAgentSettings(
  agentId: string,
  baseVersion: number,
  patch: AgentSettingsPatch,
  actorId: string | null,
  kind: 'settings' | 'revert' | 'preset_update',
  detail: Record<string, unknown> = {}
): Promise<SaveResult> {
  const { data, error } = await supabaseAdmin.rpc('save_agent', {
    p_agent_id: agentId,
    p_base_version: baseVersion,
    p_patch: patch,
    p_actor: actorId,
    p_kind: kind,
    p_detail: detail,
  });

  if (error) {
    if (error.code === '23514') return { ok: false, reason: 'template_limit' };
    if (error.code === '23505') return { ok: false, reason: 'duplicate_name' };
    console.error('[agent-store] save_agent 실패', error);
    return { ok: false, reason: 'error', message: error.message };
  }

  const result = data as { ok: boolean; version?: number; reason?: string; current_version?: number };
  if (result.ok && typeof result.version === 'number') return { ok: true, version: result.version };
  if (result.reason === 'conflict') {
    return { ok: false, reason: 'conflict', currentVersion: result.current_version ?? -1 };
  }
  return { ok: false, reason: 'not_found' };
}

/** 저장 실패를 라우트 응답으로. 메시지를 라우트마다 따로 쓰지 않는다. */
export function saveFailureResponse(result: Exclude<SaveResult, { ok: true }>): {
  status: number;
  message: string;
  details?: Record<string, unknown>;
} {
  switch (result.reason) {
    case 'conflict':
      return {
        status: 409,
        message: '다른 분이 먼저 고쳤습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.',
        details: { reason: 'conflict', currentVersion: result.currentVersion },
      };
    case 'not_found':
      return { status: 404, message: '비서를 찾을 수 없습니다.' };
    case 'template_limit':
      return { status: 400, message: '양식은 비서당 10개까지입니다.' };
    case 'duplicate_name':
      return { status: 409, message: '같은 이름의 비서가 이미 있습니다.' };
    case 'error':
      return { status: 500, message: '비서 저장 중 오류가 발생했습니다.' };
  }
}

export async function changeAgentTier(args: {
  agentId: string;
  tier: 'department' | 'official';
  actorId: string;
  departmentId: string | null;
  visibility: AgentVisibility;
}): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'duplicate_name' | 'error'; message?: string }> {
  const { data, error } = await supabaseAdmin.rpc('change_agent_tier', {
    p_agent_id: args.agentId,
    p_tier: args.tier,
    p_actor: args.actorId,
    p_department_id: args.departmentId,
    p_visibility: args.visibility,
  });
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'duplicate_name' };
    console.error('[agent-store] change_agent_tier 실패', error);
    return { ok: false, reason: 'error', message: error.message };
  }
  return (data as { ok: boolean }).ok ? { ok: true } : { ok: false, reason: 'not_found' };
}

/** 판 번호가 없는 기록(문서 올림·지움, 지움). 실패해도 본 작업은 되돌리지 않는다. */
export async function recordAgentEvent(
  agentId: string,
  kind: 'document_added' | 'document_removed' | 'deleted',
  actorId: string | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_history')
    .insert({ agent_id: agentId, kind, changed_by: actorId, detail });
  if (error) console.error('[agent-store] 기록 실패', kind, agentId, error.message);
}

/**
 * 지우기 = 숨김. 행을 지우면 대화(conversations.agent_id)가 막고,
 * 판 기록과 messages.agent_version이 가리킬 대상도 사라진다.
 */
export async function softDeleteAgent(agentId: string, actorId: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('agents')
    .update({ deleted_at: new Date().toISOString(), is_active: false, updated_by: actorId })
    .eq('id', agentId)
    .is('deleted_at', null);
  if (error) {
    console.error('[agent-store] 지우기 실패', agentId, error.message);
    return false;
  }
  await recordAgentEvent(agentId, 'deleted', actorId);
  return true;
}

export async function enableAgentCapability(
  agentId: string,
  capability: 'doc_search',
  actorId: string | null
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('enable_agent_capability', {
    p_agent_id: agentId,
    p_capability: capability,
    p_actor: actorId,
  });
  if (error) console.error('[agent-store] 능력 켜기 실패', agentId, capability, error.message);
}

export interface AgentHistoryRow {
  id: string;
  kind: string;
  version: number | null;
  snapshot: Record<string, unknown> | null;
  changed_by: string | null;
  changed_by_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function getAgentHistory(agentId: string, limit = 100): Promise<AgentHistoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_history')
    .select('id, kind, version, snapshot, changed_by, detail, created_at, changer:users!changed_by(full_name, email)')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[agent-store] 기록 조회 실패', agentId, error.message);
    return [];
  }
  return (data ?? []).map(
    (row: {
      id: string; kind: string; version: number | null; snapshot: Record<string, unknown> | null;
      changed_by: string | null; detail: Record<string, unknown>; created_at: string;
      changer: { full_name: string | null; email: string | null } | null;
    }) => ({
      id: row.id,
      kind: row.kind,
      version: row.version,
      snapshot: row.snapshot,
      changed_by: row.changed_by,
      changed_by_name: row.changer?.full_name ?? row.changer?.email ?? null,
      detail: row.detail ?? {},
      created_at: row.created_at,
    })
  );
}

export async function getVersionSnapshot(agentId: string, version: number): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin
    .from('agent_history')
    .select('snapshot')
    .eq('agent_id', agentId)
    .eq('version', version)
    .maybeSingle();
  return (data?.snapshot as Record<string, unknown> | undefined) ?? null;
}
```

- [ ] **Step 3: `src/lib/db.ts`의 `Agent` 타입에 칸 추가** — `link_url?: string | null;` 줄 아래에 넣는다.

```typescript
  /** 단계 — 권한의 근거 (0026). is_personal은 0027에서 사라진다 */
  tier: 'personal' | 'department' | 'official';
  /** 이 비서의 모델. null이면 기관 기본 모델 (0026) */
  model_id?: string | null;
  /** 켜진 능력과 설정 (0026). 정규화는 capabilities/settings.ts */
  capabilities?: Record<string, unknown>;
  /** 현재 판 번호 (0026). 저장할 때 base_version으로 돌려보낸다 */
  version: number;
  deleted_at?: string | null;
  approval_version?: number | null;
  approval_requested_by?: string | null;
```

- [ ] **Step 4: 타입 확인**

Run: `npx tsc --noEmit`
Expected: 오류 0건. `tier`·`version`을 필수로 두었으므로 `Agent` 객체를 직접 만드는 코드가 있으면 여기서 드러난다 — 그 자리에 `tier`·`version`을 채워 고친다.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actor-scope.ts src/lib/agent-store.ts src/lib/db.ts
git commit -m "feat: 요청자 범위와 비서 저장소

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 비서 수정·삭제·생성 라우트

**Files:**
- Modify: `src/app/api/agents/[id]/route.ts` (전체 교체)
- Modify: `src/app/api/agents/route.ts` (GET 필터 · POST 생성)
- Modify: `src/app/api/agents/personal/route.ts` (전체 교체)
- Modify: `src/app/api/agents/personal/[id]/route.ts` (전체 교체)
- Create: `src/lib/agent-route-helpers.ts`
- Test: `tests/agent-route-permissions.test.ts`

**Interfaces:**
- Consumes: Task 2·3·4·5 전부, `connectorCatalog()`, `enabledModels()`(`@/lib/models`), `getAllowedModelIds(orgId)`
- Produces:
  - `PATCH /api/agents/[id]` body: 판 설정 칸 + `base_version`(나만의 비서는 생략 가능) + 운영 칸(공식 비서만). 성공 `{ ok: true, data: Agent }`, 동시 수정 409 `{ error: { message, details: { reason: 'conflict', currentVersion } } }`
  - `DELETE /api/agents/[id]` → 숨김
  - `POST /api/agents` (관리자) → 공식 비서 생성
  - `POST /api/agents/personal` body `{ tier?: 'personal' | 'department', name, description, system_prompt|systemPrompt, icon, color, category, model_id, capabilities }`
  - `agent-route-helpers.ts`:
    ```typescript
    export function jsonError(message: string, status: number, details?: Record<string, unknown>): NextResponse;
    export async function validateModelForOrganization(modelId: string | null | undefined, organizationId: string | null): Promise<string | null>; // 오류 메시지 또는 null
    export async function checkCapabilityScope(tier: AgentTier, caps: CapabilitySettings | undefined, departmentId: string): Promise<string | null>;
    export function knownIds(): { knownConnectorIds: string[]; knownModelIds: string[] };
    ```

- [ ] **Step 1: 실패하는 원본 검사 작성**

```typescript
// tests/agent-route-permissions.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

/**
 * 비서를 바꾸는 라우트는 전부 agent-permissions를 거친다 (설계 3.5).
 *
 * route-auth.test.ts와 같은 방식이다. 한 핸들러에만 검사를 넣고 다른
 * 핸들러를 빠뜨리는 실수가 forbidden-words에서 실제로 있었다.
 */
const PERMISSION_CALL = /can(Edit|Delete|Use)Agent|canPromoteToDepartment|canRequestOfficial|canApproveOfficial/;

/** [파일, 확인할 핸들러] */
const MUTATING: [string, string[]][] = [
  ['src/app/api/agents/[id]/route.ts', ['PATCH', 'DELETE']],
  ['src/app/api/agents/personal/[id]/route.ts', ['PUT', 'DELETE']],
  ['src/app/api/agents/personal/[id]/request-approval/route.ts', ['POST']],
  ['src/app/api/agents/[id]/promote/route.ts', ['POST']],
  ['src/app/api/agents/[id]/revert/route.ts', ['POST']],
  ['src/app/api/agents/[id]/history/route.ts', ['GET']],
  ['src/app/api/agents/[id]/templates/route.ts', ['GET', 'POST']],
  ['src/app/api/agents/[id]/templates/[templateId]/route.ts', ['DELETE']],
  ['src/app/api/admin/agents/[id]/approve/route.ts', ['POST']],
  ['src/app/api/admin/agents/[id]/reject/route.ts', ['POST']],
  ['src/app/api/upload/route.ts', ['POST']],
  ['src/app/api/documents/route.ts', ['DELETE']],
];

function handlerBody(src: string, method: string): string | null {
  const marker = `export async function ${method}`;
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('비서 변경 라우트의 권한 판정', () => {
  for (const [file, methods] of MUTATING) {
    for (const method of methods) {
      it(`${method} ${file.replace('src/app/api', '')}`, () => {
        expect(existsSync(file), `${file} 없음`).toBe(true);
        const body = handlerBody(readFileSync(file, 'utf8'), method);
        expect(body, `${method} 핸들러 없음`).not.toBeNull();
        expect(PERMISSION_CALL.test(body!), 'agent-permissions 판정 호출 없음').toBe(true);
      });
    }
  }

  it('업로드는 고른 비서 전부를 검사한다', () => {
    // 예전에는 첫 번째 비서만 검사해 나머지 비서에 권한 없이 문서가 붙었다
    const src = readFileSync('src/app/api/upload/route.ts', 'utf8');
    expect(src).not.toContain('agentIds[0]');
    expect(src).toMatch(/for \(const \w+ of agentIds\)/);
  });

  it('문서 지우기는 비서를 지울 수 있는 사람만', () => {
    // 문서는 되돌리기 대상이 아니다. 되돌릴 수 없는 것은 좁게 연다(결정 4).
    const body = handlerBody(readFileSync('src/app/api/documents/route.ts', 'utf8'), 'DELETE')!;
    expect(body).toContain('canDeleteAgent');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-route-permissions.test.ts`
Expected: FAIL — 대부분의 항목이 `agent-permissions 판정 호출 없음` 또는 `파일 없음`. (이 테스트는 Task 6·7·8을 거치며 하나씩 통과한다.)

- [ ] **Step 3: 공용 도우미 작성**

```typescript
// src/lib/agent-route-helpers.ts
import { NextResponse } from 'next/server';
import { connectorCatalog } from '@/lib/connectors';
import { enabledModels } from '@/lib/models';
import { getAllowedModelIds } from '@/lib/model-policy';
import { getCapabilityScope } from '@/lib/connector-scope';
import { scopeViolations, type CapabilitySettings } from '@/lib/capabilities/settings';
import type { AgentTier } from '@/lib/agent-permissions';

export function jsonError(message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error: details ? { message, details } : { message } },
    { status }
  );
}

export function knownIds(): { knownConnectorIds: string[]; knownModelIds: string[] } {
  return {
    knownConnectorIds: connectorCatalog().map((c) => c.id),
    knownModelIds: enabledModels().map((m) => m.id),
  };
}

/**
 * 비서에 정할 모델이 기관 허용 범위 안인가. 문제가 없으면 null.
 * 대화할 때도 다시 건다(S1-b) — 기관이 나중에 허용 목록에서 빼는 경우가 있다.
 */
export async function validateModelForOrganization(
  modelId: string | null | undefined,
  organizationId: string | null
): Promise<string | null> {
  if (modelId === undefined || modelId === null) return null;
  const allowed = await getAllowedModelIds(organizationId);
  return allowed.includes(modelId) ? null : '이 기관에서 허용하지 않은 모델입니다.';
}

/** 나만의·부서 비서는 기관이 공식 비서에서 쓰는 연결만 켤 수 있다 (설계 3.4). */
export async function checkCapabilityScope(
  tier: AgentTier,
  caps: CapabilitySettings | undefined,
  departmentId: string
): Promise<string | null> {
  if (tier === 'official' || !caps) return null;
  const violations = scopeViolations(caps, await getCapabilityScope(departmentId));
  return violations.length > 0
    ? `기관에서 쓰지 않는 공공데이터 연결은 켤 수 없습니다: ${violations.join(', ')}`
    : null;
}
```

- [ ] **Step 4: `src/app/api/agents/[id]/route.ts` 전체 교체**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse, softDeleteAgent } from '@/lib/agent-store';
import { splitAgentBody, changedSettingKeys, SNAPSHOT_KEYS } from '@/lib/agent-patch';
import type { AgentType } from '@/lib/agent-catalog';
import {
  jsonError,
  knownIds,
  validateModelForOrganization,
  checkCapabilityScope,
} from '@/lib/agent-route-helpers';

/**
 * 비서 고치기 — 세 단계 공통.
 *
 * 판 설정은 save_agent로(판이 남는다), 운영 값(노출·정렬·공개 범위·사용
 * 여부·유형)은 직접 바꾼다. 운영 값은 공식 비서에만 있다 — 나만의 비서는
 * 본인만 보고, 부서 비서는 공개 범위가 '부서'로 고정이다.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 고칠 권한이 없습니다.', 403);

    const body = (await request.json()) as Record<string, unknown>;

    const { data: current } = await supabaseAdmin
      .from('agents')
      .select(`agent_type, ${SNAPSHOT_KEYS.filter((k) => k !== 'template_ids').join(', ')}`)
      .eq('id', params.id)
      .single();
    const currentRow = (current ?? {}) as Record<string, unknown>;

    const split = splitAgentBody(body, {
      currentType: ((currentRow.agent_type as AgentType) ?? 'chat'),
      ...knownIds(),
    });
    if (split.error) return jsonError(split.error, 400);

    // ── 운영 값 ──
    if (Object.keys(split.operational).length > 0) {
      if (agent.tier !== 'official') {
        return jsonError('노출·공개 범위·유형은 공식 비서에서만 바꿀 수 있습니다.', 400);
      }
      const { error } = await supabaseAdmin
        .from('agents')
        .update({ ...split.operational, updated_by: actor.userId })
        .eq('id', params.id);
      if (error) return jsonError('비서 설정 변경 중 오류가 발생했습니다.', 500);
    }

    // ── 판 설정 ──
    const changed = changedSettingKeys(currentRow, split.settings);
    if (changed.length > 0) {
      const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
      if (modelError) return jsonError(modelError, 400);

      const scopeError = await checkCapabilityScope(agent.tier, split.settings.capabilities, actor.departmentId);
      if (scopeError) return jsonError(scopeError, 403);

      // 나만의 비서는 고치는 사람이 본인뿐이라 판 번호를 생략할 수 있다.
      // 부서·공식 비서는 함께 고치므로 반드시 받는다.
      const rawBase = body.base_version;
      let baseVersion: number;
      if (typeof rawBase === 'number') baseVersion = rawBase;
      else if (agent.tier === 'personal') baseVersion = agent.version;
      else return jsonError('base_version이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요.', 400);

      const onlyChanged = Object.fromEntries(
        changed.map((key) => [key, split.settings[key as keyof typeof split.settings]])
      );
      const saved = await saveAgentSettings(params.id, baseVersion, onlyChanged, actor.userId, 'settings');
      if (!saved.ok) {
        const failure = saveFailureResponse(saved);
        return jsonError(failure.message, failure.status, failure.details);
      }
    }

    const { data: agentRow } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).single();
    return NextResponse.json({ ok: true, data: agentRow });
  } catch (error) {
    console.error('[agents PATCH]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canDeleteAgent(agent, actor)) return jsonError('이 비서를 지울 권한이 없습니다.', 403);

    const done = await softDeleteAgent(params.id, actor.userId);
    if (!done) return jsonError('비서 삭제 중 오류가 발생했습니다.', 500);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[agents DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 5: `src/app/api/agents/route.ts` 고치기**

GET의 목록 쿼리 세 곳에 지운 비서 제외를 더하고, 일반 목록이 부서 비서를 포함하도록 바꾼다.

즐겨찾기 쿼리(`.in('id', favoriteIds)` 다음 줄)에 추가:
```typescript
        .is('deleted_at', null)
```

`// 내 비서 탭` 쿼리를 다음으로 바꾼다:
```typescript
    // 내 비서 탭 — 나만의 비서. 부서를 옮겨도 내 것이므로 부서로 거르지 않는다.
    if (personalOnly) {
      const { data: agents, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .eq('tier', 'personal')
        .eq('owner_id', session.user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
```

관리 화면 목록(`manage=true`)은 볼 수 있는 범위가 아니라 **관리 범위**로 고른다. 볼 수 있는 범위(자기 부서 + 상위)로 고르면 최상위 관리자가 하위 부서의 부서 비서를 관리 목록에서 못 본다. 또 관리 화면은 꺼 둔 비서도 보여야 다시 켤 수 있다. `// 카테고리 / 전체 비서` 주석 바로 앞에 추가:
```typescript
    // 관리 화면 — 관리 범위의 공식·부서 비서. 꺼 둔 것도 보인다(다시 켜려면 보여야 한다).
    if (manageMode) {
      const actor = await getActorScope(session);
      if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
      const managed = actor.managedDepartmentIds.join(',');

      let manageQuery = supabaseAdmin
        .from('agents')
        .select('*')
        .eq('organization_id', actor.organizationId)
        .neq('tier', 'personal')
        .is('deleted_at', null)
        // 기관 전체 공식 비서 + 관리 범위 부서에 걸린 비서(부서로 좁힌 공식 · 부서 비서)
        .or(`and(tier.eq.official,visibility.eq.organization),department_id.in.(${managed})`);

      if (category && category !== '전체') manageQuery = manageQuery.eq('category', category);

      const { data: agents, error } = await manageQuery
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) return jsonError('에이전트 조회 중 오류가 발생했습니다.', 500);
      return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
    }
```
(이 파일 import에 `getActorScope`·`jsonError`가 POST 수정에서 이미 들어온다.)

`// 카테고리 / 전체 비서` 쿼리를 다음으로 바꾼다:
```typescript
    // 카테고리 / 전체 비서 — 공식 비서 + 내 부서 계통의 부서 비서.
    // 부서 비서는 visibility='department'라 visibilityFilter가 내 부서 계통만 남긴다.
    const departmentOnly = searchParams.get('department') === 'true';
    let query = supabaseAdmin
      .from('agents')
      .select('*')
      .or(visibleFilter)
      .eq('is_active', true)
      .is('deleted_at', null);

    query = departmentOnly ? query.eq('tier', 'department') : query.neq('tier', 'personal');

    // 노출 대기중은 공식 비서에만 있다. 부서 비서는 승인 없이 바로 쓴다(결정 4).
    // (관리 화면은 위에서 따로 돌려줬다)
    query = query.or('tier.eq.department,is_published.eq.true');
```
(`.or()`를 두 번 부르면 PostgREST가 AND로 묶는다. 기존 `if (!manageMode) { query = query.eq('is_published', true); }` 블록은 지운다.)

POST의 insert 본문을 다음으로 바꾼다 (body 구조 분해 줄 `const { name, description, system_prompt, config, enabled_connectors, visibility } = body;`부터 insert 끝까지):
```typescript
    const body = (await request.json()) as Record<string, unknown>;

    const split = splitAgentBody(body, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    if (!split.settings.name) return jsonError('에이전트 이름은 필수입니다.', 400);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: departmentId,
        tier: 'official',
        ...split.settings,
        // 사진 읽기는 기본으로 켠다. 지금 모든 대화형 비서가 사진을 받는다.
        capabilities: split.settings.capabilities ?? { image: {} },
        created_by: session.user.id,
        updated_by: session.user.id,
        // 기본은 기관 전체 공개. 규정·매뉴얼 대부분이 전 직원 공통이다.
        visibility: split.operational.visibility === 'department' ? 'department' : 'organization',
        // 새 비서는 '노출 대기중'에서 시작한다(0019 기본값 false).
        ...split.operational,
      })
      .select()
      .single();
```
import 줄에 추가: `import { splitAgentBody } from '@/lib/agent-patch';`, `import { getActorScope } from '@/lib/actor-scope';`, `import { jsonError, knownIds, validateModelForOrganization } from '@/lib/agent-route-helpers';`. 쓰지 않게 된 `parseCatalogFields` import는 지운다.

- [ ] **Step 6: `src/app/api/agents/personal/route.ts` 전체 교체**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { splitAgentBody } from '@/lib/agent-patch';
import {
  jsonError,
  knownIds,
  validateModelForOrganization,
  checkCapabilityScope,
} from '@/lib/agent-route-helpers';

/**
 * 직원이 만드는 비서 — 나만의 비서 또는 부서 비서.
 *
 * 부서 비서는 승인 없이 바로 만든다(결정 4). 주인 부서는 만든 사람의
 * 지금 부서다. 다른 부서를 고를 수 없다 — 고를 수 있으면 아무 부서에나
 * 비서를 밀어 넣을 수 있다.
 */
export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('tier', 'personal')
      .eq('owner_id', session.user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) return jsonError('나만의 비서 조회 중 오류가 발생했습니다.', 500);
    return NextResponse.json({ ok: true, data: agents });
  } catch (error) {
    console.error('[personal agents GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const raw = (await request.json()) as Record<string, unknown>;
    const tier = raw.tier === 'department' ? 'department' : 'personal';

    // 옛 화면은 systemPrompt(camelCase)로 보낸다
    const { tier: _tier, systemPrompt, ...rest } = raw;
    const body: Record<string, unknown> = {
      ...rest,
      ...(systemPrompt !== undefined && rest.system_prompt === undefined ? { system_prompt: systemPrompt } : {}),
    };

    const split = splitAgentBody(body, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    if (!split.settings.name) return jsonError('비서 이름은 필수입니다.', 400);
    if (Object.keys(split.operational).length > 0) {
      return jsonError('노출·공개 범위·유형은 공식 비서에서만 정할 수 있습니다.', 400);
    }

    const capabilities = split.settings.capabilities ?? { image: {} };

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);

    // 화면에서 걸러 보내더라도 그건 표시일 뿐이다. 실제 제한은 여기서 건다.
    const scopeError = await checkCapabilityScope(tier, capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: actor.departmentId,
        tier,
        ...split.settings,
        capabilities,
        category: split.settings.category ?? '전체',
        owner_id: tier === 'personal' ? actor.userId : null,
        visibility: tier === 'department' ? 'department' : 'organization',
        // 부서 비서는 승인 없이 바로 쓴다. 나만의 비서는 본인만 본다.
        is_published: true,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return jsonError(
          tier === 'department' ? '부서에 같은 이름의 비서가 이미 있습니다.' : '같은 이름의 비서가 이미 있습니다.',
          409
        );
      }
      return jsonError('비서 생성 중 오류가 발생했습니다.', 500);
    }

    return NextResponse.json({ ok: true, data: agent }, { status: 201 });
  } catch (error) {
    console.error('[personal agents POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 7: `src/app/api/agents/personal/[id]/route.ts` 전체 교체** — 같은 판정·저장 경로로 보낸다. 나만의 비서 화면이 이 주소를 쓰고 있어 남긴다.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse, softDeleteAgent } from '@/lib/agent-store';
import { splitAgentBody } from '@/lib/agent-patch';
import { jsonError, knownIds, validateModelForOrganization, checkCapabilityScope } from '@/lib/agent-route-helpers';

/** 옛 주소. 판정과 저장은 /api/agents/[id]와 같은 모듈을 거친다. */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at || agent.tier !== 'personal') return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('본인의 비서만 수정할 수 있습니다.', 403);

    const { systemPrompt, base_version, ...rest } = (await request.json()) as Record<string, unknown>;
    const split = splitAgentBody(
      { ...rest, ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}) },
      { currentType: 'chat', ...knownIds() }
    );
    if (split.error) return jsonError(split.error, 400);
    if (Object.keys(split.operational).length > 0) {
      return jsonError('노출·공개 범위·유형은 공식 비서에서만 바꿀 수 있습니다.', 400);
    }

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);
    const scopeError = await checkCapabilityScope('personal', split.settings.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const saved = await saveAgentSettings(
      params.id,
      typeof base_version === 'number' ? base_version : agent.version,
      split.settings,
      actor.userId,
      'settings'
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[personal agent PUT]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at || agent.tier !== 'personal') return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canDeleteAgent(agent, actor)) return jsonError('본인의 비서만 삭제할 수 있습니다.', 403);

    const done = await softDeleteAgent(params.id, actor.userId);
    if (!done) return jsonError('비서 삭제 중 오류가 발생했습니다.', 500);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[personal agent DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 8: 테스트·타입 확인**

Run: `npx vitest run tests/agent-route-permissions.test.ts && npx tsc --noEmit`
Expected: `agents/[id]`의 PATCH·DELETE, `personal/[id]`의 PUT·DELETE 항목이 PASS. 나머지 항목은 아직 FAIL(Task 7·8에서 통과). tsc 오류 0건.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent-route-helpers.ts src/app/api/agents/route.ts src/app/api/agents/[id]/route.ts src/app/api/agents/personal/route.ts src/app/api/agents/personal/[id]/route.ts tests/agent-route-permissions.test.ts
git commit -m "feat: 비서 수정·삭제·생성을 권한 모듈과 save_agent로

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 단계 이동 · 승인 · 문서

**Files:**
- Create: `src/app/api/agents/[id]/promote/route.ts`
- Modify: `src/app/api/agents/personal/[id]/request-approval/route.ts` (전체 교체)
- Modify: `src/app/api/admin/agents/[id]/approve/route.ts` (전체 교체)
- Modify: `src/app/api/admin/agents/[id]/reject/route.ts` (권한 부분)
- Modify: `src/app/api/admin/agents/approvals/route.ts` (조회 범위)
- Modify: `src/app/api/upload/route.ts` (권한 · 기록 · 능력 켜기)
- Modify: `src/app/api/documents/route.ts` (DELETE)
- Modify: `tests/route-auth.test.ts`

**Interfaces:**
- Consumes: Task 2·5·6
- Produces:
  - `POST /api/agents/[id]/promote` → 나만의 → 부서
  - `POST /api/agents/personal/[id]/request-approval` → 나만의·부서 비서 모두 신청 가능. `approval_version`·`approval_requested_by` 기록
  - `POST /api/admin/agents/[id]/approve` body `{ visibility?: 'organization'|'department', scope?: 'all'|'department' }` → 판이 바뀌었으면 409 `{ details: { reason: 'changed_since_request' } }`
  - `GET /api/admin/agents/approvals` → 관리 범위 안의 신청, `requester` 포함

- [ ] **Step 1: 나만의 → 부서**

```typescript
// src/app/api/agents/[id]/promote/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canPromoteToDepartment } from '@/lib/agent-permissions';
import { loadAgentAccess, changeAgentTier } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/**
 * 나만의 비서를 부서 비서로 올린다 — 사본을 만들지 않고 그 비서를 옮긴다(결정 1).
 * 주인 부서는 올리는 사람의 지금 부서다. 승인은 없다(결정 4).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canPromoteToDepartment(agent, actor)) return jsonError('본인의 나만의 비서만 부서 비서로 올릴 수 있습니다.', 403);

    const result = await changeAgentTier({
      agentId: params.id,
      tier: 'department',
      actorId: actor.userId,
      departmentId: actor.departmentId,
      visibility: 'department',
    });
    if (!result.ok) {
      if (result.reason === 'duplicate_name') return jsonError('부서에 같은 이름의 비서가 이미 있습니다. 이름을 바꾼 뒤 다시 올려 주세요.', 409);
      if (result.reason === 'not_found') return jsonError('비서를 찾을 수 없습니다.', 404);
      return jsonError('부서 비서로 올리는 중 오류가 발생했습니다.', 500);
    }
    return NextResponse.json({ ok: true, data: { tier: 'department' } });
  } catch (error) {
    console.error('[agents promote]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 2: 공식 신청 (`request-approval/route.ts` 전체 교체)**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canRequestOfficial } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/**
 * 공식 등록 신청 — 나만의 비서와 부서 비서 모두.
 *
 * 신청 시점의 판 번호를 남긴다. 부서 비서는 신청 중에도 부서원이 고칠 수
 * 있어서, 관리자가 검토한 판과 실제로 공식이 되는 판이 달라질 수 있다.
 * 승인할 때 이 번호와 지금 판을 비교한다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (agent.approval_status === 'pending') return jsonError('이미 승인 신청 중입니다.', 409);
    if (agent.tier === 'official') return jsonError('이미 공식 비서입니다.', 409);
    if (!canRequestOfficial(agent, actor)) return jsonError('이 비서를 신청할 권한이 없습니다.', 403);

    const body = await request.json().catch(() => ({}));
    const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

    const { error } = await supabaseAdmin
      .from('agents')
      .update({
        approval_status: 'pending',
        approval_note: note,
        approval_version: agent.version,
        approval_requested_by: actor.userId,
      })
      .eq('id', params.id);

    if (error) return jsonError('승인 신청 중 오류가 발생했습니다.', 500);

    return NextResponse.json({ ok: true, data: { success: true, message: '관리자에게 신청됐습니다.' } });
  } catch (error) {
    console.error('[request-approval POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 3: 승인 (`approve/route.ts` 전체 교체)**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canApproveOfficial, type AgentVisibility } from '@/lib/agent-permissions';
import { loadAgentAccess, changeAgentTier } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('부서 정보를 찾을 수 없습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (agent.approval_status !== 'pending') return jsonError('승인 대기 상태인 비서만 승인할 수 있습니다.', 409);

    const body = await request.json().catch(() => ({}));
    // 예전 화면은 scope: 'all' | 'department'로 보낸다
    const visibility: AgentVisibility =
      body.visibility === 'organization' || body.scope === 'all' ? 'organization' : 'department';

    if (!canApproveOfficial(agent, actor, visibility)) {
      return jsonError(
        visibility === 'organization'
          ? '기관 전체 공개 승인은 기관 전체를 관리하는 관리자만 할 수 있습니다.'
          : '이 부서의 비서를 승인할 권한이 없습니다.',
        403
      );
    }

    // 관리자가 검토한 판과 공식이 될 판이 같아야 한다
    if (agent.approval_version !== null && agent.approval_version !== agent.version) {
      return jsonError('신청 뒤 내용이 바뀌었습니다. 다시 확인해 주세요.', 409, {
        reason: 'changed_since_request',
        requestedVersion: agent.approval_version,
        currentVersion: agent.version,
      });
    }

    const result = await changeAgentTier({
      agentId: params.id,
      tier: 'official',
      actorId: actor.userId,
      departmentId: null, // 걸린 부서는 그대로
      visibility,
    });
    if (!result.ok) {
      if (result.reason === 'duplicate_name') return jsonError('같은 부서에 같은 이름의 비서가 이미 있습니다.', 409);
      return jsonError('승인 처리 중 오류가 발생했습니다.', 500);
    }

    return NextResponse.json({ ok: true, data: { id: params.id, tier: 'official', visibility } });
  } catch (error) {
    console.error('[admin approve POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 4: 반려 (`reject/route.ts`)** — 부서 조회 블록(`const departmentId = ...`부터 `existing` 조회와 404 처리까지)을 다음으로 바꾸고, 이후의 `existing.approval_status` 참조를 `agent.approval_status`로 바꾼다. import에 `getActorScope`, `canApproveOfficial`, `loadAgentAccess`를 더한다.

```typescript
    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) {
      return NextResponse.json({ ok: false, error: { message: '비서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 반려도 승인과 같은 사람이 한다 — 부서 범위로 판정한다
    if (!canApproveOfficial(agent, actor, 'department')) {
      return NextResponse.json({ ok: false, error: { message: '이 부서의 비서를 반려할 권한이 없습니다.' } }, { status: 403 });
    }
```
반려 update의 `.eq('id', params.id)` 앞에 있는 필드에 `approval_version: null`을 더한다.

- [ ] **Step 5: 신청 목록 (`approvals/route.ts`)** — `departmentId` 조회 대신 관리 범위로 거르고 신청자를 함께 싣는다. `const departmentId = ...` 블록부터 쿼리 끝까지를 다음으로 바꾼다. import에 `getActorScope`를 더한다.

```typescript
    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') ?? 'pending';

    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select(`
        *,
        owner:users!owner_id ( id, email, full_name ),
        requester:users!approval_requested_by ( id, email, full_name )
      `)
      .in('department_id', actor.managedDepartmentIds)
      .eq('approval_status', status)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
```

- [ ] **Step 6: 업로드 (`upload/route.ts`)** — `// 권한 체크는 첫 번째 agentId 기준`부터 그 `if (session.user.role !== 'ADMIN') { ... }` 블록 끝까지를 다음으로 바꾼다. import에 `getActorScope`, `canEditAgent`, `loadAgentAccess`, `recordAgentEvent`, `enableAgentCapability`를 더한다.

```typescript
  // 고른 비서 전부를 검사한다. 예전에는 첫 번째만 검사해, 내 비서를 앞에
  // 두고 남의 비서를 뒤에 붙이면 권한 없이 문서가 붙었다.
  const actor = await getActorScope(session);
  if (!actor) {
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '소속 부서가 지정되지 않았습니다.' } },
      { status: 403 }
    );
  }
  for (const id of agentIds) {
    const target = await loadAgentAccess(id);
    if (!target || !canEditAgent(target, actor)) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '문서를 붙일 권한이 없는 비서가 포함돼 있습니다.' } },
        { status: 403 }
      );
    }
  }
```

문서 행 저장이 성공한 직후(`if (insertError || !insertedDocs?.length) { ... }` 블록 바로 다음)에 추가:

```typescript
  // 비서 타임라인에 남기고, 문서 찾기를 켠다. 지금은 문서만 올리면 바로
  // 검색되므로 같은 동작을 지킨다 — 켜는 일도 판에 남는다.
  for (const id of agentIds) {
    await recordAgentEvent(id, 'document_added', session.user.id, { file_name: file.name });
    await enableAgentCapability(id, 'doc_search', session.user.id);
  }
```

- [ ] **Step 7: 문서 지우기 (`documents/route.ts` DELETE 전체 교체)** — import에 `getActorScope`, `canDeleteAgent`, `loadAgentAccess`, `recordAgentEvent`를 더한다.

```typescript
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
    }

    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const { documentId } = await request.json();
    if (!documentId) {
      return NextResponse.json({ ok: false, error: { message: 'documentId가 필요합니다.' } }, { status: 400 });
    }

    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, storage_path, agent_id, department_id, file_name')
      .eq('id', documentId)
      .maybeSingle();

    if (!doc) {
      return NextResponse.json({ ok: false, error: { message: '문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 문서는 되돌리기 대상이 아니다(결정 3). 되돌릴 수 없는 것은 좁게 연다 —
    // 그 비서를 지울 수 있는 사람만 문서도 지운다(결정 4의 원칙).
    // 비서에 걸리지 않은 문서는 그 부서를 관리하는 관리자만.
    let allowed = false;
    if (doc.agent_id) {
      const agent = await loadAgentAccess(doc.agent_id);
      allowed = Boolean(agent) && canDeleteAgent(agent!, actor);
    } else {
      allowed = actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id);
    }
    if (!allowed) {
      return NextResponse.json({ ok: false, error: { message: '이 문서를 지울 권한이 없습니다.' } }, { status: 403 });
    }

    const { error } = await supabaseAdmin.from('documents').delete().eq('id', documentId);
    if (error) {
      return NextResponse.json({ ok: false, error: { message: '문서 삭제 실패', details: error } }, { status: 500 });
    }

    // 여러 비서에 한 번에 올린 문서는 저장소 파일 하나를 함께 쓴다.
    // 다른 행이 남아 있으면 파일을 지우지 않는다.
    if (doc.storage_path) {
      const { count } = await supabaseAdmin
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('storage_path', doc.storage_path);
      if ((count ?? 0) === 0) {
        await supabaseAdmin.storage.from('documents').remove([doc.storage_path]);
      }
    }

    if (doc.agent_id) {
      await recordAgentEvent(doc.agent_id, 'document_removed', actor.userId, { file_name: doc.file_name });
    }

    return NextResponse.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}
```

`isAdminSession` import가 이 파일에서 더 쓰이지 않으면 지운다(GET에서 쓰면 둔다).

- [ ] **Step 8: `tests/route-auth.test.ts` 고치기**

`EMPLOYEE_ROUTES`에 새 직원 경로를 더한다(`'/agents/favorite',` 다음 줄):
```typescript
  '/agents/[id]/history',
  '/agents/[id]/promote',
  '/agents/[id]/revert',
  '/agents/[id]/templates',
  '/agents/[id]/templates/[templateId]',
```

`it('문서 삭제는 관리자만 할 수 있다', ...)` 블록을 다음으로 바꾼다:
```typescript
  it('문서 삭제는 그 비서를 지울 수 있는 사람만', () => {
    // 문서는 되돌리기 대상이 아니다. 예전에는 관리자만 지울 수 있었고, 부서
    // 비서가 생기면서 '그 비서를 지울 수 있는 사람'으로 넓혔다 — 부서 비서는
    // 처음 만든 사람과 관리자다. 직원 누구나로 넓어지면 안 된다.
    const del = handlers.find((h) => h.route === '/documents' && h.method === 'DELETE');
    expect(del, 'DELETE /documents').toBeDefined();
    expect(del!.body).toContain('canDeleteAgent');
    expect(del!.body).not.toContain('canEditAgent');
  });
```

- [ ] **Step 9: 확인**

Run: `npx vitest run tests/agent-route-permissions.test.ts tests/route-auth.test.ts && npx tsc --noEmit`
Expected: 이번 작업 대상 항목이 PASS. 아직 없는 라우트(`revert`·`history`·`templates`) 항목만 FAIL. tsc 오류 0건.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/agents/[id]/promote src/app/api/agents/personal/[id]/request-approval src/app/api/admin/agents src/app/api/upload/route.ts src/app/api/documents/route.ts tests/route-auth.test.ts
git commit -m "feat: 단계 이동·승인·문서를 권한 모듈로, 업로드는 비서 전부 검사

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 기록 · 되돌리기 · 양식 라우트

**Files:**
- Create: `src/app/api/agents/[id]/history/route.ts`
- Create: `src/app/api/agents/[id]/revert/route.ts`
- Create: `src/app/api/agents/[id]/templates/route.ts`
- Create: `src/app/api/agents/[id]/templates/[templateId]/route.ts`
- Create: `src/lib/template-files.ts`
- Test: `tests/template-files.test.ts`

**Interfaces:**
- Consumes: Task 2·4·5·6
- Produces:
  - `GET /api/agents/[id]/history` → `{ ok: true, data: { version: number, items: AgentHistoryRow[] } }`
  - `POST /api/agents/[id]/revert` body `{ version: number, base_version: number }` → `{ ok: true, data: { version } }`
  - `GET /api/agents/[id]/templates` → `{ ok: true, data: { version, items: { id, name, file_name, size_bytes, created_at }[] } }`
  - `POST /api/agents/[id]/templates` multipart `file`, `name`, `base_version`
  - `DELETE /api/agents/[id]/templates/[templateId]?base_version=N`
  - `template-files.ts`: `export const TEMPLATE_EXTENSIONS: readonly ['hwp','hwpx','docx']; export const MAX_TEMPLATES = 10; export function validateTemplateFile(name: string, size: number): string | null; export function templateStoragePath(orgId: string, agentId: string, fileId: string, fileName: string): string;`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/template-files.test.ts
import { describe, it, expect } from 'vitest';
import { validateTemplateFile, templateStoragePath, MAX_TEMPLATES } from '@/lib/template-files';
import { MAX_UPLOAD_BYTES } from '@/lib/file-types';

describe('양식 파일', () => {
  it('한글·워드만 받는다', () => {
    expect(validateTemplateFile('기안문.hwpx', 1000)).toBeNull();
    expect(validateTemplateFile('기안문.HWP', 1000)).toBeNull();
    expect(validateTemplateFile('양식.docx', 1000)).toBeNull();
    expect(validateTemplateFile('양식.pdf', 1000)).toBe('양식은 HWP·HWPX·DOCX 파일만 올릴 수 있습니다.');
  });

  it('업로드 상한을 따른다', () => {
    expect(validateTemplateFile('a.hwpx', MAX_UPLOAD_BYTES + 1)).toContain('MB');
  });

  it('저장 경로는 기관·비서 아래, 원래 이름은 쓰지 않는다', () => {
    // 원래 파일명을 경로에 넣으면 '../' 같은 이름으로 경로를 거슬러 오를 수 있다
    const path = templateStoragePath('org', 'agent', 'f1', '../../x.hwpx');
    expect(path).toBe('templates/org/agent/f1.hwpx');
  });

  it('상한은 10개', () => {
    expect(MAX_TEMPLATES).toBe(10);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/template-files.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/template-files"`

- [ ] **Step 3: `template-files.ts` 작성**

```typescript
// src/lib/template-files.ts
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_LABEL } from '@/lib/file-types';

/** 기관 서식. 채우는 일은 S2가 한다 — 여기서는 받아 두는 규칙만. */
export const TEMPLATE_EXTENSIONS = ['hwp', 'hwpx', 'docx'] as const;
export const MAX_TEMPLATES = 10;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function validateTemplateFile(name: string, size: number): string | null {
  if (!(TEMPLATE_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
    return '양식은 HWP·HWPX·DOCX 파일만 올릴 수 있습니다.';
  }
  if (size > MAX_UPLOAD_BYTES) return `양식 파일은 ${MAX_UPLOAD_SIZE_LABEL}까지 올릴 수 있습니다.`;
  return null;
}

/** 원래 파일명은 DB(file_name)에만 둔다. 경로에는 id와 확장자만. */
export function templateStoragePath(orgId: string, agentId: string, fileId: string, fileName: string): string {
  return `templates/${orgId}/${agentId}/${fileId}.${extensionOf(fileName)}`;
}
```

- [ ] **Step 4: 기록 라우트**

```typescript
// src/app/api/agents/[id]/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, getAgentHistory } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/** 변경 기록은 그 비서를 고칠 수 있는 사람이 본다. 지시문 전문이 들어 있다. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('변경 기록을 볼 권한이 없습니다.', 403);

    const items = await getAgentHistory(params.id);
    return NextResponse.json({ ok: true, data: { version: agent.version, items } });
  } catch (error) {
    console.error('[agent history GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 5: 되돌리기 라우트**

```typescript
// src/app/api/agents/[id]/revert/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, getVersionSnapshot, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { SNAPSHOT_KEYS, type AgentSettingsPatch } from '@/lib/agent-patch';
import { jsonError, validateModelForOrganization, checkCapabilityScope } from '@/lib/agent-route-helpers';
import { normalizeCapabilities } from '@/lib/capabilities/settings';
import { connectorCatalog } from '@/lib/connectors';

/**
 * 옛 판으로 되돌린다. 옛 사본을 현재로 다시 쓰고 그것도 새 판으로 남긴다.
 *
 * 옛 판의 모델·능력이 지금 기관 규칙에 맞지 않을 수 있다(그 사이 기관이
 * 모델을 막았거나 연결을 껐다). 그대로 되살리면 규칙을 우회하는 길이
 * 되므로 저장할 때와 같은 검사를 다시 건다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('이 비서를 고칠 권한이 없습니다.', 403);

    const body = await request.json().catch(() => ({}));
    if (typeof body.version !== 'number' || typeof body.base_version !== 'number') {
      return jsonError('version과 base_version이 필요합니다.', 400);
    }
    if (body.version === agent.version) return jsonError('지금 판입니다.', 400);

    const snapshot = await getVersionSnapshot(params.id, body.version);
    if (!snapshot) return jsonError('그 판을 찾을 수 없습니다.', 404);

    const patch: AgentSettingsPatch = {};
    for (const key of SNAPSHOT_KEYS) {
      if (key in snapshot) (patch as Record<string, unknown>)[key] = snapshot[key];
    }

    const caps = normalizeCapabilities(patch.capabilities, { knownConnectorIds: connectorCatalog().map((c) => c.id) });
    if (!caps.ok) return jsonError(`그 판의 능력 설정을 지금 쓸 수 없습니다: ${caps.message}`, 400);
    patch.capabilities = caps.value;

    const modelError = await validateModelForOrganization(patch.model_id, actor.organizationId);
    if (modelError) return jsonError(`그 판의 모델을 지금 쓸 수 없습니다. ${modelError}`, 400);
    const scopeError = await checkCapabilityScope(agent.tier, patch.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const saved = await saveAgentSettings(params.id, body.base_version, patch, actor.userId, 'revert', {
      reverted_from: body.version,
    });
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[agent revert POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 6: 양식 목록·추가 라우트**

```typescript
// src/app/api/agents/[id]/templates/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';
import { validateTemplateFile, templateStoragePath, MAX_TEMPLATES } from '@/lib/template-files';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

async function activeTemplates(agentId: string) {
  const { data } = await supabaseAdmin
    .from('agent_templates')
    .select('id, name, file_name, size_bytes, created_at')
    .eq('agent_id', agentId)
    .is('retired_at', null)
    .order('created_at', { ascending: true });
  return (data ?? []) as { id: string; name: string; file_name: string; size_bytes: number; created_at: string }[];
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 볼 권한이 없습니다.', 403);

    return NextResponse.json({ ok: true, data: { version: agent.version, items: await activeTemplates(params.id) } });
  } catch (error) {
    console.error('[agent templates GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/**
 * 양식 추가. 행은 꺼진 채로 넣고(0026 기본값), save_agent가 판을 올리며
 * 켠다. 판이 어긋나 저장이 거절되면 꺼진 행과 파일만 남는다 — 아무에게도
 * 보이지 않으므로 해가 없다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 올릴 권한이 없습니다.', 403);

    const form = await request.formData();
    const file = form.get('file');
    const name = String(form.get('name') ?? '').trim();
    const baseVersion = Number(form.get('base_version'));

    if (!(file instanceof File)) return jsonError('양식 파일이 필요합니다.', 400);
    if (!name || name.length > 60) return jsonError('양식 이름은 1~60자로 입력해 주세요.', 400);
    if (!Number.isInteger(baseVersion)) return jsonError('base_version이 필요합니다.', 400);

    const fileError = validateTemplateFile(file.name, file.size);
    if (fileError) return jsonError(fileError, 400);

    const current = await activeTemplates(params.id);
    if (current.length >= MAX_TEMPLATES) return jsonError(`양식은 비서당 ${MAX_TEMPLATES}개까지입니다.`, 400);

    const fileId = randomUUID();
    const storagePath = templateStoragePath(agent.organization_id ?? 'none', params.id, fileId, file.name);
    const { error: uploadError } = await supabaseAdmin.storage
      .from(SUPABASE_DOCUMENTS_BUCKET)
      .upload(storagePath, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
    if (uploadError) return jsonError('양식 파일 저장에 실패했습니다.', 500);

    const { error: insertError } = await supabaseAdmin.from('agent_templates').insert({
      id: fileId,
      agent_id: params.id,
      name,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      created_by: actor.userId,
    });
    if (insertError) return jsonError('양식 등록에 실패했습니다.', 500);

    const saved = await saveAgentSettings(
      params.id,
      baseVersion,
      { template_ids: [...current.map((t) => t.id), fileId] },
      actor.userId,
      'settings',
      { template_added: name }
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }

    return NextResponse.json({ ok: true, data: { version: saved.version, id: fileId } }, { status: 201 });
  } catch (error) {
    console.error('[agent templates POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 7: 양식 빼기 라우트**

```typescript
// src/app/api/agents/[id]/templates/[templateId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';

/** 양식 빼기. 행과 파일은 남긴다 — 판을 되돌리면 다시 살아난다. */
export async function DELETE(request: NextRequest, { params }: { params: { id: string; templateId: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 뺄 권한이 없습니다.', 403);

    const baseVersion = Number(new URL(request.url).searchParams.get('base_version'));
    if (!Number.isInteger(baseVersion)) return jsonError('base_version이 필요합니다.', 400);

    const { data } = await supabaseAdmin
      .from('agent_templates')
      .select('id, name')
      .eq('agent_id', params.id)
      .is('retired_at', null);
    const active = (data ?? []) as { id: string; name: string }[];
    const target = active.find((t) => t.id === params.templateId);
    if (!target) return jsonError('양식을 찾을 수 없습니다.', 404);

    const saved = await saveAgentSettings(
      params.id,
      baseVersion,
      { template_ids: active.filter((t) => t.id !== params.templateId).map((t) => t.id) },
      actor.userId,
      'settings',
      { template_removed: target.name }
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[agent template DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
```

- [ ] **Step 8: 확인**

Run: `npx vitest run tests/template-files.test.ts tests/agent-route-permissions.test.ts tests/route-auth.test.ts && npx tsc --noEmit`
Expected: 전부 PASS. tsc 오류 0건.

- [ ] **Step 9: Commit**

```bash
git add src/lib/template-files.ts src/app/api/agents/[id]/history src/app/api/agents/[id]/revert src/app/api/agents/[id]/templates tests/template-files.test.ts
git commit -m "feat: 비서 변경 기록·되돌리기·양식 파일 라우트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 기본 비서 · 화면 요청 형식 · DB 검증

**Files:**
- Modify: `src/lib/install-presets.ts`
- Modify: `scripts/seed-agents.mjs`
- Modify: `src/components/admin/AgentsManager.tsx` (`toRequestBody`, 수정 저장, 승인 범위)
- Modify: `src/components/chat/CreateAgentModal.tsx` (생성 요청 본문)
- Create: `scripts/db-test-agents.mjs`
- Modify: `package.json` (scripts)
- Modify: `scripts/db-check.mjs`, `scripts/isolation-check.mjs`
- Test: `tests/agent-presets-tier.test.ts`

**Interfaces:**
- Consumes: Task 3·5, `saveAgentSettings`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/agent-presets-tier.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { presetCapabilities } from '@/lib/install-presets';

describe('기본 비서 설치', () => {
  it('사진 읽기를 켜고 커넥터는 공공데이터 능력으로', () => {
    expect(presetCapabilities({ connectors: ['law'] } as never)).toEqual({
      image: {},
      public_data: { connectors: ['law'] },
    });
    expect(presetCapabilities({} as never)).toEqual({ image: {} });
  });

  it('옛 칸을 직접 쓰지 않는다', () => {
    // 0027에서 사라지는 칸이다. 지금 쓰면 그때 설치가 멈춘다.
    const src = readFileSync('src/lib/install-presets.ts', 'utf8');
    expect(src).not.toContain('enabled_connectors');
    expect(src).not.toContain('is_personal');
  });

  it('--update는 save_agent로 판을 남긴다', () => {
    const src = readFileSync('src/lib/install-presets.ts', 'utf8');
    expect(src).toContain("'preset_update'");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/agent-presets-tier.test.ts`
Expected: FAIL — `presetCapabilities is not exported`

- [ ] **Step 3: `install-presets.ts` 고치기**

import에 추가:
```typescript
import { saveAgentSettings } from '@/lib/agent-store';
import type { CapabilitySettings } from '@/lib/capabilities/settings';
```

파일 끝의 `buildRow` 앞에 추가하고 `buildRow`를 바꾼다:
```typescript
/** 기본 비서의 능력. 사진 읽기는 모든 대화형 비서에 켠다. */
export function presetCapabilities(preset: AgentPreset): CapabilitySettings {
  return preset.connectors?.length
    ? { image: {}, public_data: { connectors: preset.connectors } }
    : { image: {} };
}

function buildRow(preset: AgentPreset, departmentId: string, order: number) {
  return {
    department_id: departmentId,
    tier: 'official',
    name: preset.name,
    description: preset.description,
    system_prompt: preset.systemPrompt,
    config: {},
    is_active: true,
    // 큐레이션한 세트라 바로 쓸 수 있게 노출한다. 관리자가 직접 만드는 비서는
    // 0019 기본값에 따라 '노출 대기중'에서 시작한다 — 성격이 다르다.
    is_published: true,
    // 범용 비서라 부서를 가릴 이유가 없다. 전 직원이 쓴다.
    visibility: 'organization',
    category: preset.category,
    icon: preset.icon,
    color: preset.color,
    display_order: order,
    agent_type: 'chat',
    owner_id: null,
    capabilities: presetCapabilities(preset),
  };
}
```

`--update` 조회와 갱신 부분을 바꾼다 — `.select('id, updated_by')`부터 `if (updateError) { ... } else { updated += 1; }`까지:
```typescript
      .select('id, updated_by, version')
      .eq('organization_id', organizationId)
      .eq('name', preset.name)
      .eq('tier', 'official')
      .is('deleted_at', null)
      .maybeSingle();

    if (!existing) {
      skipped += 1;
      continue;
    }

    // 사람이 손댄 흔적이 있으면 그대로 둔다. save_agent는 사람의 저장에서
    // updated_by를 채우고 기본 비서 갱신(actor NULL)에서는 비워 둔다.
    if (existing.updated_by) {
      preserved.push(preset.name);
      skipped += 1;
      continue;
    }

    // 갱신 대상은 프리셋이 정의하는 것들뿐이다. 노출 여부·공개 범위·정렬처럼
    // 운영자가 조정하는 값은 건드리지 않는다. 판으로 남긴다.
    const saved = await saveAgentSettings(
      existing.id,
      existing.version,
      {
        description: preset.description,
        system_prompt: preset.systemPrompt,
        icon: preset.icon,
        color: preset.color,
        category: preset.category,
        capabilities: presetCapabilities(preset),
      },
      null,
      'preset_update'
    );

    if (!saved.ok) {
      console.warn('[install-presets] 비서 갱신 실패', preset.name, saved.reason);
      skipped += 1;
    } else {
      updated += 1;
    }
```

- [ ] **Step 4: `seed-agents.mjs` 고치기** — `.select('is_published, display_order, agent_type')`를 `.select('is_published, display_order, agent_type, tier, version')`로, 오류 메시지의 `0019_agent_catalog.sql`을 `0019 또는 0026`으로, `.eq('is_personal', false)`를 `.eq('tier', 'official')`로 바꾼다.

- [ ] **Step 5: 화면 요청 형식 맞추기**

`src/components/admin/AgentsManager.tsx`:
- `AgentFormData`에 `version: number;`와 `capabilities: Record<string, unknown>;`를 더하고 `EMPTY_FORM`에 `version: 0, capabilities: { image: {} },`를 더한다.
- `toFormData(agent)`에 `version: agent.version, capabilities: (agent.capabilities as Record<string, unknown>) ?? {},`를 더한다.
- `toRequestBody(form)`에서 `enabled_connectors: form.enabled_connectors,` 줄을 다음으로 바꾼다:
```typescript
    // 공공데이터 연결은 능력 설정의 일부다. 다른 능력(문서 찾기·사진)은 그대로 둔다.
    capabilities: (() => {
      const { public_data: _old, ...others } = form.capabilities;
      return form.enabled_connectors.length > 0
        ? { ...others, public_data: { connectors: form.enabled_connectors } }
        : others;
    })(),
```
- 수정 저장(`fetch(\`/api/agents/${editingAgent.id}\`, { method: 'PATCH', ...`)의 본문을 `JSON.stringify({ ...toRequestBody(editFormData), base_version: editFormData.version })`로 바꾸고, 응답 처리에서 409를 구분한다:
```typescript
      if (res.status === 409) {
        setError('다른 분이 먼저 고쳤습니다. 목록을 새로고침한 뒤 다시 고쳐 주세요.');
        await fetchAgents();
        return;
      }
```
- 승인 요청 본문 `{ scope: approveScope }`를 `{ visibility: approveScope === 'all' ? 'organization' : 'department' }`로 바꾸고, 409 응답이면 `result.error.message`를 그대로 띄운다.

`src/components/chat/CreateAgentModal.tsx`의 생성 요청 본문(`fetch('/api/agents/personal', ...)`)에서 `enabled_connectors: selectedConnectors,`를 다음으로 바꾼다:
```typescript
          capabilities: {
            image: {},
            ...(selectedConnectors.length > 0 ? { public_data: { connectors: selectedConnectors } } : {}),
          },
```

- [ ] **Step 6: DB 검증 스크립트 작성**

```javascript
// scripts/db-test-agents.mjs
/**
 * save_agent · 트리거를 실제 DB에서 확인한다.
 *
 *   npm run db:test-agents
 *
 * 한 트랜잭션 안에서 만들고 확인한 뒤 ROLLBACK한다. 아무것도 남지 않는다.
 * 단위 테스트로는 이 프로젝트에서 실제로 난 버그(트리거 부재 등)를 못
 * 잡는다 — CLAUDE.md '검증 장치'.
 *
 * DATABASE_URL이 필요하다 (db:migrate와 같다).
 */
import { readFileSync, existsSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  }
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('DATABASE_URL이 없습니다. npm run db:migrate 안내를 참고하세요.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

let failures = 0;
function check(label, pass, extra = '') {
  if (!pass) failures += 1;
  console.log(`${pass ? 'OK  ' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`);
}

/** 오류가 나야 하는 문장. 세이브포인트로 감싸 트랜잭션을 살린다. */
async function expectError(label, sql, params, code) {
  await client.query('SAVEPOINT sp');
  try {
    await client.query(sql, params);
    check(label, false, '오류가 나지 않음');
  } catch (err) {
    check(label, err.code === code, `${err.code} ${err.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT sp');
  }
}

const tag = `db-test-${Date.now()}`;

try {
  await client.query('BEGIN');

  const { rows: [dept] } = await client.query(
    'SELECT id, organization_id FROM departments WHERE organization_id IS NOT NULL LIMIT 1'
  );
  if (!dept) throw new Error('기관에 연결된 부서가 없습니다.');

  // ── 생성 트리거 ──
  const { rows: [created] } = await client.query(
    `INSERT INTO agents (department_id, name, tier, capabilities)
     VALUES ($1, $2, 'official', '{"image":{}}') RETURNING id, version`,
    [dept.id, `${tag}-a`]
  );
  const { rows: h1 } = await client.query(
    `SELECT kind, version FROM agent_history WHERE agent_id = $1`, [created.id]
  );
  check('새 비서는 판 1이 남는다', h1.length === 1 && h1[0].kind === 'created' && h1[0].version === 1);

  // ── 저장과 동시 수정 ──
  const { rows: [conflict] } = await client.query(
    `SELECT save_agent($1, 0, '{"name":"x"}', NULL, 'settings') AS r`, [created.id]
  );
  check('판이 다르면 거절한다', conflict.r.reason === 'conflict' && conflict.r.current_version === 1);

  const { rows: [saved] } = await client.query(
    `SELECT save_agent($1, 1, $2, NULL, 'settings') AS r`,
    [created.id, JSON.stringify({ name: `${tag}-b`, system_prompt: '새 지시' })]
  );
  check('저장하면 판이 오른다', saved.r.ok === true && saved.r.version === 2);

  const { rows: [v2] } = await client.query(
    `SELECT snapshot, detail FROM agent_history WHERE agent_id = $1 AND version = 2`, [created.id]
  );
  check('판 사본에 새 값이 있다', v2?.snapshot?.system_prompt === '새 지시');
  check('바뀐 칸을 기록한다', JSON.stringify(v2?.detail?.fields) === JSON.stringify(['name', 'system_prompt']));

  // ── 되돌리기 ──
  const { rows: [v1] } = await client.query(
    `SELECT snapshot FROM agent_history WHERE agent_id = $1 AND version = 1`, [created.id]
  );
  const { rows: [reverted] } = await client.query(
    `SELECT save_agent($1, 2, $2, NULL, 'revert', '{"reverted_from":1}') AS r`,
    [created.id, JSON.stringify(v1.snapshot)]
  );
  const { rows: [afterRevert] } = await client.query(
    `SELECT name, system_prompt, version FROM agents WHERE id = $1`, [created.id]
  );
  check('되돌리기도 새 판이다', reverted.r.version === 3 && afterRevert.version === 3);
  check('되돌리면 옛 값이 돌아온다', afterRevert.name === `${tag}-a` && afterRevert.system_prompt === null);

  // ── 양식 상한 ──
  for (let i = 0; i < 11; i += 1) {
    await client.query(
      `INSERT INTO agent_templates (agent_id, name, storage_path, file_name, size_bytes)
       VALUES ($1, $2, 'x', 'x.hwpx', 1)`, [created.id, `양식${i}`]
    );
  }
  const { rows: tpl } = await client.query(
    `SELECT id, retired_at FROM agent_templates WHERE agent_id = $1 ORDER BY name`, [created.id]
  );
  check('새 양식은 꺼진 채로 들어간다', tpl.every((t) => t.retired_at !== null));
  await expectError(
    '양식 11개는 거절한다',
    `SELECT save_agent($1, 3, $2, NULL, 'settings')`,
    [created.id, JSON.stringify({ template_ids: tpl.map((t) => t.id) })],
    '23514'
  );
  const { rows: [ten] } = await client.query(
    `SELECT save_agent($1, 3, $2, NULL, 'settings') AS r`,
    [created.id, JSON.stringify({ template_ids: tpl.slice(0, 10).map((t) => t.id) })]
  );
  check('양식 10개는 받는다', ten.r.ok === true);

  // ── 옛 코드 호환 트리거 ──
  const { rows: [legacy] } = await client.query(
    `INSERT INTO agents (department_id, name, is_personal, enabled_connectors)
     VALUES ($1, $2, true, '{law}') RETURNING tier, capabilities`,
    [dept.id, `${tag}-legacy`]
  );
  check('옛 코드가 만든 나만의 비서도 단계가 찬다', legacy.tier === 'personal');
  check('옛 코드의 커넥터가 능력으로 옮겨진다',
    JSON.stringify(legacy.capabilities.public_data) === '{"connectors":["law"]}' && 'image' in legacy.capabilities);

  const { rows: [approved] } = await client.query(
    `UPDATE agents SET is_personal = false WHERE name = $1 RETURNING tier`, [`${tag}-legacy`]
  );
  check('옛 승인 코드가 is_personal만 바꿔도 단계가 따라간다', approved.tier === 'official');

  const { rows: [conn] } = await client.query(
    `UPDATE agents SET capabilities = '{"public_data":{"connectors":["kosis"]}}' WHERE id = $1
     RETURNING enabled_connectors`, [created.id]
  );
  check('새 능력이 옛 커넥터 칸으로 따라간다', JSON.stringify(conn.enabled_connectors) === '["kosis"]');

  // ── 이름 유일성 ──
  await expectError(
    '같은 부서에 같은 이름의 공유 비서는 막는다',
    `INSERT INTO agents (department_id, name, tier) VALUES ($1, $2, 'official')`,
    [dept.id, `${tag}-a`],
    '23505'
  );
  const { rows: users } = await client.query(
    'SELECT id FROM users WHERE department_id = $1 LIMIT 2', [dept.id]
  );
  if (users.length === 2) {
    for (const u of users) {
      await client.query(
        `INSERT INTO agents (department_id, name, tier, owner_id) VALUES ($1, $2, 'personal', $3)`,
        [dept.id, `${tag}-mine`, u.id]
      );
    }
    check('같은 부서의 두 직원이 같은 이름의 나만의 비서를 만든다', true);
  } else {
    console.log('건너뜀  같은 부서 직원이 둘 이상 없어 나만의 비서 이름 검사를 못 함');
  }

  // ── 부서 비서 제약 ──
  await expectError(
    '부서 비서는 기관 전체 공개가 될 수 없다',
    `INSERT INTO agents (department_id, name, tier, visibility) VALUES ($1, $2, 'department', 'organization')`,
    [dept.id, `${tag}-dept`],
    '23514'
  );

  // ── 단계 변경 ──
  const { rows: [tierChange] } = await client.query(
    `SELECT change_agent_tier($1, 'department', NULL, $2, 'department') AS r`,
    [created.id, dept.id]
  );
  const { rows: [tierRow] } = await client.query(
    `SELECT kind, detail, version FROM agent_history WHERE agent_id = $1 AND kind = 'tier'`, [created.id]
  );
  check('단계 변경은 기록되고 판 번호는 없다',
    tierChange.r.ok === true && tierRow?.version === null && tierRow?.detail?.to === 'department');
} catch (err) {
  failures += 1;
  console.error('FAIL  예기치 못한 오류:', err.message);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}

console.log(failures === 0 ? '\n전부 통과. (ROLLBACK — 남은 데이터 없음)' : `\n실패 ${failures}건.`);
process.exit(failures === 0 ? 0 : 1);
```

`package.json`의 `"db:migrate"` 줄 다음에 추가:
```json
    "db:test-agents": "tsx scripts/db-test-agents.mjs",
```

- [ ] **Step 7: `db-check.mjs`에 0026 점검 추가**

`checks` 배열 끝(`0021 model_policy_logs` 줄 다음)에 추가:
```javascript
  ['0026', 'agents 단계·판 칸',          () => db.from('agents').select('tier, model_id, capabilities, version, deleted_at').limit(1)],
  ['0026', 'agent_history 테이블',       () => db.from('agent_history').select('id, kind, version').limit(1)],
  ['0026', 'agent_templates 테이블',     () => db.from('agent_templates').select('id, retired_at').limit(1)],
  ['0026', 'messages.agent_version',     () => db.from('messages').select('agent_version').limit(1)],
```

`// ── 기관 브랜딩·모델 정책` 블록 앞에 추가:
```javascript
// ── 비서 단계와 판 (0026) ───────────────────────────────────
// 판 기록이 빠지면 되돌리기와 감사 대응("그때 어떤 지시문이었나")이 조용히
// 불가능해진다. 트리거는 PostgREST로 못 보므로 증상을 본다.
console.log('\n=== 비서 단계와 판 ===');
{
  const { data: agents, error } = await db
    .from('agents')
    .select('id, name, tier, is_personal, visibility, version, capabilities, model_id')
    .is('deleted_at', null);
  const { data: history, error: hError } = await db
    .from('agent_history')
    .select('agent_id, version')
    .not('version', 'is', null);

  if (error || hError) {
    console.log(`      조회 실패: ${(error ?? hError).message.slice(0, 60)}`);
    ok = false;
  } else {
    const versions = new Set(history.map((h) => `${h.agent_id}:${h.version}`));
    const noCurrent = agents.filter((a) => !versions.has(`${a.id}:${a.version}`));
    const mismatch = agents.filter((a) => (a.tier === 'personal') !== Boolean(a.is_personal));
    const badDept = agents.filter((a) => a.tier === 'department' && a.visibility !== 'department');
    const KNOWN_CAPS = ['doc_search', 'public_data', 'image'];
    const badCaps = agents.filter((a) => Object.keys(a.capabilities ?? {}).some((k) => !KNOWN_CAPS.includes(k)));
    const tally = agents.reduce((m, a) => ({ ...m, [a.tier]: (m[a.tier] ?? 0) + 1 }), {});

    console.log(`OK    단계별 ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    for (const [label, rows] of [
      ['현재 판 기록 없음', noCurrent],
      ['tier와 is_personal 불일치 (0027 전까지)', mismatch],
      ['부서 비서인데 공개 범위가 부서가 아님', badDept],
      ['모르는 능력 id', badCaps],
    ]) {
      if (rows.length) ok = false;
      console.log(`${rows.length ? '주의' : 'OK  '}  ${label} ${rows.length}개${rows.length ? ` — ${rows.slice(0, 5).map((a) => a.name).join(', ')}` : ''}`);
    }
  }
}
```

- [ ] **Step 8: `isolation-check.mjs`에 부서 비서 점검 추가** — `// ── 5. 대화·메시지` 블록 앞에 추가:

```javascript
// ── 4-1. 부서 비서의 주인 부서와 기관 ───────────────────────
// 부서 비서는 visibility='department'라 visibilityFilter의 부서 조건으로만
// 보인다. 주인 부서와 비서의 기관이 어긋나면 그 조건이 기관을 넘는다.
console.log('\n=== 4-1. 부서 비서 기관 일치 ===');
{
  const { data: deptAgents } = await db
    .from('agents')
    .select('name, department_id, organization_id')
    .eq('tier', 'department')
    .is('deleted_at', null);
  const deptOrg = new Map(depts.map((d) => [d.id, d.organization_id]));
  const crossed = (deptAgents ?? []).filter((a) => deptOrg.get(a.department_id) !== a.organization_id);
  violations += crossed.length;
  console.log(`${crossed.length ? '위반' : 'OK  '}  부서 비서 ${deptAgents?.length ?? 0}개 중 기관 어긋남 ${crossed.length}개`);
}
```
(`depts`는 이 스크립트의 '준비' 단계에서 `id, organization_id`를 포함해 읽어 둔 부서 목록이다. 그 select에 `organization_id`가 없으면 더한다.)

- [ ] **Step 9: 전체 확인**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 전부 PASS, tsc 오류 0건.

- [ ] **Step 10: Commit**

```bash
git add src/lib/install-presets.ts scripts/seed-agents.mjs src/components/admin/AgentsManager.tsx src/components/chat/CreateAgentModal.tsx scripts/db-test-agents.mjs scripts/db-check.mjs scripts/isolation-check.mjs package.json tests/agent-presets-tier.test.ts
git commit -m "feat: 기본 비서·화면을 새 형식으로, DB 검증 스크립트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 적용 · 실측 · 배포

**Files:**
- Modify: `CLAUDE.md` (마이그레이션 표 · 검증 장치 · 비서 카탈로그 절)

- [ ] **Step 1: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공. (개발 서버가 떠 있으면 먼저 멈추고 `.next`를 지운다 — 빌드가 개발 서버의 `.next`를 덮는다.)

- [ ] **Step 2: 사용자에게 0026 적용을 요청한다** — 사용자가 직접 실행한다(DB 접속 문자열은 사용자의 `.env.local`에 있다).

```bash
npm run db:migrate -- 0026
```
Expected: 마지막 확인 표에 단계별 비서 수, `문서찾기`·`공공데이터` 수가 나온다. `personal` 수는 기존 나만의 비서 수, 나머지는 `official`.

- [ ] **Step 3: 실측**

```bash
npm run db:test-agents
```
Expected: `전부 통과. (ROLLBACK — 남은 데이터 없음)`

```bash
npm run db:check
```
Expected: `0026` 항목 OK, `현재 판 기록 없음 0개`, `tier와 is_personal 불일치 0개`.

```bash
npm run isolation:check
```
Expected: `4-1. 부서 비서 기관 일치` OK (부서 비서 0개).

- [ ] **Step 4: 화면 실측 (preview)** — 개발 서버를 띄우고 관리자 계정으로 확인한다(사용자가 로그인).
  1. 관리 화면에서 공식 비서 하나의 지시문을 고쳐 저장 → 성공
  2. 같은 비서를 두 탭에서 열고 차례로 저장 → 두 번째 탭에 "다른 분이 먼저 고쳤습니다"
  3. 직원 화면에서 나만의 비서 만들기 → 성공, 같은 부서 다른 직원이 같은 이름으로 만들기 → 성공
  4. 대화가 있는 나만의 비서 지우기 → 목록에서 사라짐(예전에는 23503으로 실패)
  5. 기존 비서와 대화 → 지금처럼 답함(옛 대화 코드가 `enabled_connectors`를 읽음)

- [ ] **Step 5: `CLAUDE.md` 갱신**

마이그레이션 표의 `0017` 줄 아래에 추가:
```markdown
| 0026 | 비서 단계(`tier`) · 판 기록(`agent_history`, `save_agent`) · 능력(`capabilities`) · 양식(`agent_templates`) · `messages.agent_version` |
```

검증 장치 표에 추가:
```markdown
| `npm run db:test-agents` | `save_agent` 저장·되돌리기·동시 수정·양식 상한·옛 칸 맞춤 (트랜잭션 + ROLLBACK) | 예 |
```

`### 비서 카탈로그 — 표시와 권한을 섞지 말 것` 절 위에 새 절을 추가:
```markdown
### 비서 단계와 판 (0026, S1)

권한의 근거는 `agents.tier`(`personal`·`department`·`official`)와 `visibility`다.
판정은 `src/lib/agent-permissions.ts` 한 곳에서만 한다 — 비서를 바꾸는 라우트는
전부 이 모듈을 거치고 `tests/agent-route-permissions.test.ts`가 원본으로 확인한다.

설정 저장은 **반드시 `saveAgentSettings`(`save_agent` RPC)로** 한다. 판 번호를
올리고 판 사본을 `agent_history`에 남긴다. `agents`를 직접 update하면 판이
남지 않아 되돌리기와 감사 대응이 조용히 깨진다. 직접 update해도 되는 것은
운영 값(`is_published`·`display_order`·`visibility`·`is_active`·`agent_type`·`link_url`)뿐이다.

비서 **지우기는 숨김**(`deleted_at`)이다. 대화와 판 기록이 비서를 가리키기 때문이다.
목록 쿼리에 `.is('deleted_at', null)`을 빠뜨리지 말 것.

`is_personal`·`enabled_connectors`는 0027에서 사라진다. 그때까지 트리거가 새 칸과 맞춘다.
새 코드는 이 두 칸을 읽거나 쓰지 않는다.
```

- [ ] **Step 6: Commit · 배포 요청**

```bash
git add CLAUDE.md
git commit -m "docs: S1-a 비서 단계·판 기록 반영

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

사용자에게 푸시·배포를 요청한다(0026이 먼저 적용돼 있어야 한다).
