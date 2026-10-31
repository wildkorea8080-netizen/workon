# 앱 라이브러리 1차 구현 기록

날짜: 2026-10-28 · WORKON `feat/s6-1-currentize`의 `457d215` 위 미커밋 변경.

## 구현한 동작

- 새 `/apps`에서 기관·부서·내 비서와 기존 업무 10종을 함께 찾는다.
- 이름·목적·분류·능력·출력 형식 검색, 사용 방식·제공 범위 필터를 제공한다.
- 기존 권한 API의 응답만 사용한다. 비서 단건 GET은 편집자 전용이므로 대화 실행 대상 조회에 쓰지 않는다.
- 일반 비서는 `/chat?agent=...`, 업무는 기존 `/tasks/new?workflow=...`, 링크형은 HTTP(S) 외부 주소로 연다.
- 비활성 비서·잘못된 외부 주소·기관에서 끈 업무에는 실행 링크를 제공하지 않는다.
- 기존 비서 생성 창을 재사용하며 생성 후 목록을 갱신한다.
- `/chat?agent=...`는 비서 선택만 한다. 대화 생성·메시지 전송·모델 호출은 하지 않는다. `?conv=`가 함께 있으면 기존 대화를 우선한다.
- 하나의 비서 목록 API가 실패해도 다른 정상 API에서 해당 비서를 확인하면 열 수 있다. 모두 정상인데 비서가 없는 경우와 일부 조회 실패로 확인할 수 없는 경우는 구분한다.
- 손상된 비서 능력 설정이 문자열·배열·숫자로 남아 있어도 목록이 깨지지 않는다.
- 업무 메뉴와 기존 대화 홈에서 새 앱 라이브러리로 이동할 수 있다.

## 바뀐 파일

새 파일:

- `src/app/apps/page.tsx`
- `src/components/apps/AppLibrary.tsx`
- `src/lib/apps/catalog.ts`
- `src/lib/apps/chat-launch.ts`
- `tests/apps-library.test.ts`

기존 파일 최소 변경:

- `src/components/chat/ChatHome.tsx`: 비서 딥링크와 업무 앱 안내 링크.
- `src/components/work/WorkShell.tsx`: 업무 앱 메뉴.

## 이 변경의 경계

앱을 찾는 입구를 통합한 것이다. 비서의 프롬프트·모델·도구 설정이 기존 업무 실행기에 자동 적용되지는 않는다. 경쟁사 앱 100개를 신규 설치·실행 지원한 것도 아니다. 설정형 앱 제작·실행 판 스냅샷·앱과 작업 연결은 [다음 단계](IMPLEMENTATION_ROADMAP.md)의 B 항목이다.

업무의 `available`은 기존 API의 구현 등록·기관 활성 상태 의미를 그대로 따른다. 모든 양식 파일의 존재·사람 검토·운영 품질을 보증하는 표시는 아니다. 최종 작업 생성과 파일 생성은 기존 서버 검사 경로를 따른다.

DB 마이그레이션·운영 데이터·모델·API 키·배포·외부 연동을 변경하지 않았다. `/assistants`와 기존 대화·작업 경로, 작업 소유권은 유지된다.

## 검증

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit --incremental false` | 통과 |
| 새 앱 목록·딥링크 집중 시험 | 10/10 통과 |
| 앱 목록 + 비서 카탈로그/권한 + 업무 클라이언트 + 요청 JSON + 공개 설정 경계 | **6개 파일, 54개 시험 통과** |
| `git diff --check` | 통과 |
| 공개 카탈로그/구현 대응표/상세 증거 파일 대조 | 100개 ID 일치, 상세 증거 100개 모두 HTTP 200 기록 |
| 로그인한 브라우저·실제 기관 DB·운영 배포 | 이번 변경에서는 미확인 |
| 전체 빌드·전체 테스트·DB 점검 | 이번 변경에서는 미실행 |

회귀 명령:

```powershell
npx vitest run tests/apps-library.test.ts tests/agent-catalog.test.ts tests/agent-permissions.test.ts tests/work-client.test.ts tests/request-json.test.ts tests/config-public-guard.test.ts --reporter=dot
node scripts/build-alli-benchmark-map.mjs
```

테스트 기본 샌드박스에서는 프로세스 생성 `EPERM`이 발생해 허용된 상승 실행으로 검증했다. 이전 전체 테스트의 Windows `find` 호환성 문제를 이 변경에서 수정한 것은 아니다.

