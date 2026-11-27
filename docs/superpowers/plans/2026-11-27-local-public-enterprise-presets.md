# 지방공기업 기본 앱 세트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 기관 유형 '지방공기업'에만 입력형 앱 5개를 더 깐다.
**Architecture:** `src/lib/agent-presets.ts`에 `LOCAL_PUBLIC_ENTERPRISE_PRESETS`를 두고 `presetsForOrganizationType`이 유형으로 가른다 — 설치·관리자 패널·스크립트는 이미 이 함수를 쓴다.
**Spec:** `docs/superpowers/specs/2026-11-27-local-public-enterprise-presets-design.md`

## Global Constraints
- 이름은 기존 기본 비서·앱과 겹치지 않는다(관리자 패널이 기관 전체 이름으로 '있음'을 본다).
- 범주 '지방공기업'을 `PRESET_CATEGORIES`에 더한다.
- 계약 방법 검토만 `connectors: ['law']`, 나머지는 능력 없음(입력만 쓰는 실행 — 이어 실행 대상).

## Review Focus
- 유형이 '지방공기업'이 아니면(null·'공공기관'·'지방자치단체') 5개가 들어가지 않는다.
- 필수 항목만 채운 입력으로 실행 글이 만들어진다(선택 항목이 비어도).
- 계약 방법 검토의 조회어가 입력 칸을 가리키고 저장 검사를 통과한다.

### Task 1: 앱 5개와 유형별 세트
**Files:** Modify `src/lib/agent-presets.ts`; Test `tests/batch-0343.test.ts`; 기존 `tests/agent-presets-apps.test.ts`는 그대로 통과해야 함.
- [ ] 시험: 이름 5개(순서대로 '경영평가 실적 문안'·'계약 방법 검토'·'위험성평가·안전점검 정리'·'시설 이용 민원 답변'·'이사회 안건 작성'), 범주 '지방공기업', `validateAppDefinition` 그대로 통과, 필수만 채운 입력으로 `renderAppInput` ok, `presetsForOrganizationType('지방공기업')`에 5개 더 있고 다른 유형엔 없음, 계약 방법 검토 `connectors`=['law']·`appLookupConnectors`에 law, 전체 이름 겹침 없음.
- [ ] 실패 확인 → 구현 → 통과 → tsc·전체 시험 → CLAUDE.md 한 줄.
