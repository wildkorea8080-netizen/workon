# WORKON 미리보기 배포 완료

## 최신: 업무 앱 중심 첫 화면

- [최신 미리보기 첫 화면](https://workon-q4ctse21o-wildkorea8080-netizens-projects.vercel.app)
- [최신 배포 기록](https://vercel.com/wildkorea8080-netizens-projects/workon-ai/9rQnMzPsrX4QWhmUkZgoHmnExZFJ)
- CLI 배포 완료, 종료 코드 0. 원격 빌드·타입 검사 통과.

Preview에 NEXT_PUBLIC_WORKSPACE_HOME=apps를 등록하고 재배포했다. 기관에 소속된 로그인 사용자의 첫 화면에 문서 요약·교정·번역·회의 안건·FAQ 바로가기와 업무 앱 목록을 표시한다. 기존 대화 링크는 /chat으로 연결하고 앱 실행 권한 검사는 유지한다. 기관 미소속 사용자는 기존 흐름을 유지한다.

관련 테스트 3개 파일 38개와 로컬 타입 검사를 통과했다. 로그인한 브라우저 화면 검증은 아직 완료하지 않았다. 아래 이전 미리보기와 운영 주소는 이 변경을 포함하지 않는다. 운영 승격은 수행하지 않았다.

## 이전 배포 기록

기존 Vercel 계정과 workon-ai 프로젝트를 확인하고 로컬 작업 트리의 코드를 Preview로 배포했다.

- 프로젝트: wildkorea8080-netizens-projects/workon-ai
- 배포 ID: dpl_4NbeBVydNKamhGiYmgsgHotD9q24
- 상태: Ready (Vercel CLI inspect로 확인)
- [미리보기 주소](https://workon-2n4ffidr4-wildkorea8080-netizens-projects.vercel.app)
- [Vercel 배포 기록](https://vercel.com/wildkorea8080-netizens-projects/workon-ai/4NbeBVydNKamhGiYmgsgHotD9q24)

원격 컴파일·타입 검사·페이지 생성·서버 함수 배포를 통과했다. 업무 카탈로그 15종의 코드가 포함됐다. 로컬 Git 변경을 아직 커밋·푸시한 것은 아니므로 배포물을 Git 원격 최신 커밋과 동일하다고 보지 않는다.

## 환경과 업로드 범위

사용자가 명시적으로 승인한 뒤 .env.local의 NODA_API_URL·NODA_API_KEY를 기존 프로젝트의 Preview 환경에만 등록했다. 키는 sensitive 환경변수로 저장했고 값은 기록에 남기지 않았다. 최초 자동 승인 검토 거절 후 사용자 승인을 받아 정상 경로로 등록했다.

.vercelignore를 추가해 환경 파일·로컬 도구 상태·개발 문서·시험 자료·스크립트·SQL을 배포 소스에서 제외했다. 실행 코드·필수 설정·표준 양식 자산은 포함됨을 확인했다. CLI 프로젝트 연결 파일은 .gitignore에 .vercel로 제외됐다.

## 접근 확인

비인증 HTTP 요청에서 /login, /apps, /api/workflows가 모두 Vercel SSO로 302 이동했다. 이는 Preview 배포 보호 동작이며 애플리케이션 내부 화면 검증을 완료했다는 뜻은 아니다. 보호 설정은 변경하지 않았다.

Edge에서 미리보기 주소를 열고 Vercel 접근 인증을 거친 뒤 WORKON 시험 계정으로 로그인해야 한다. 기존 workon-ai.vercel.app 로그인 세션이 새 Preview 호스트에 그대로 적용된다고 가정하지 않는다.

운영 도메인 workon-ai.vercel.app으로 승격하지 않았다. 정식 계정으로 대표 업무 3개·근거/원문·수정·다운로드를 시험한 뒤 운영 반영 여부를 결정해야 한다.
