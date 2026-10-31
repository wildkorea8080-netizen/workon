# WORKON

WORKON은 기관·부서 기반 멀티테넌트 업무 AI 서비스입니다. 기관 문서를 검색해 근거 있는 답을 제공하고, 원자료와 기존 양식을 이용해 검토 가능한 HWPX/XLSX 결과물을 생성합니다.

현재 주요 영역은 다음과 같습니다.

- AI 대화와 기관/부서/개인 비서
- NODA(ReadLayer) 기반 문서 읽기·검색·근거 확인
- HWP/HWPX·DOCX·XLSX·PDF 등 파일 입력
- HWPX/DOCX 양식 채우기와 HWPX/XLSX 결과물 생성
- 업무 작업 15종과 판·검토·복구·다운로드
- 앱 라이브러리와 입력형 앱 빌더
- 기관 관리자와 슈퍼관리자 포털

## 개발 시작

```bash
npm install
npm run dev
```

환경변수 목록과 설명은 [.env.example](./.env.example)을 참고하세요. 실제 비밀값이 있는 `.env.local`은 커밋하지 않습니다.

기본 검증:

```bash
npx tsc --noEmit --incremental false
npm test
npm run build
```

DB, NODA, HWPX, 업무 작업 검증 명령은 [CLAUDE.md](./CLAUDE.md)의 `검증 장치` 절에 정리되어 있습니다.

## Claude Code로 이어서 작업하기

1. [현재 인수인계](./docs/CLAUDE_CODE_HANDOFF.md)를 먼저 읽습니다.
2. [Claude Code 시작 프롬프트](./docs/CLAUDE_CODE_PROMPTS.md)에서 목적에 맞는 프롬프트를 사용합니다.
3. 상세 구조와 코딩 규약은 [CLAUDE.md](./CLAUDE.md)를 따릅니다.
4. 최신 운영 배포 기록은 [PRODUCTION_DEPLOYMENT.md](./docs/benchmarks/allganize/PRODUCTION_DEPLOYMENT.md)를 확인합니다.

현재 작업 트리에는 대규모 미커밋 작업이 있을 수 있습니다. 시작 전에 반드시 `git status --short`와 `git diff --stat`을 확인하고 기존 변경을 보존하세요.

## 주요 문서

- [Claude Code 인수인계](./docs/CLAUDE_CODE_HANDOFF.md)
- [제품 방향 재검토](./docs/2026-10-28-product-benchmark-review.md)
- [현재 기능 차이와 다음 작업](./docs/benchmarks/allganize/CURRENT_GAPS_AND_NEXT.md)
- [운영 배포 기록](./docs/benchmarks/allganize/PRODUCTION_DEPLOYMENT.md)
- [업무 개편 출시 절차](./docs/workon-rebuild/RELEASE_RUNBOOK.md)
- [DB 마이그레이션](./supabase/migrations)
