# 연결된 시험 DB — 0036~0041 적용 완료

2026-10-29 18:52 KST. 사용자가 현재 연결 DB를 시험용으로 확인하고 직접 실행을 요청하여 적용했다.

API 프로젝트와 직접 DB 연결 대상이 일치하는지 확인한 뒤 0036~0041만 한 트랜잭션으로 실행하고 적용 이력을 기록했다. 다른 마이그레이션은 실행하지 않았다.

확인 결과:

- 여섯 마이그레이션 적용·커밋 완료.
- work_tasks.app_snapshot의 JSONB 타입 확인.
- work_tasks·workflow_installations 제약에서 카탈로그 15종 모두 허용됨 확인.
- 적용 전후 기존 작업 수 동일.
- PostgREST 스키마 새로고침 요청 후 REST 조회의 모든 스키마 점검 통과.

[직접 DB 적용 결과](CONNECTED_DB_MIGRATION_RESULT.json) · [REST 확인 결과](CONNECTED_DB_READINESS.json)

DB 적용과 사이트 코드 배포는 별개다. 이번 작업은 Vercel 배포·기관 스위치 변경·계정 변경·실제 업무 실행을 포함하지 않는다. 기존 문서의 미적용 설명은 작성 당시 상태이며 이 문서가 연결된 시험 DB의 최신 적용 상태다.
