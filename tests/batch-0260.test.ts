import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0260 — 0259(관리자 비서 화면)에 이어 사용자 관리·부서·기관 정보 화면의 조작 실패 글도 actionErrorText로.
// 예전엔 서버가 안내 글 없이 실패하면 빈 오류가 되어 아무것도 안 보였고(초대·한도·사용 중지·비밀번호 재발급·잠금 풀기·
// 부서 이동·권한 바꾸기, 부서 만들기·고치기·삭제, 기관 정보 저장·로고 올리기·지우기), 몸이 JSON이 아니면 영어 구문 오류 글이 보였다.

const FILES: Record<string, number> = {
  'src/components/admin/UsersManager.tsx': 7,
  'src/components/admin/DepartmentsManager.tsx': 3,
  'src/components/admin/OrganizationManager.tsx': 3,
};

describe('관리자 화면의 조작 실패 글', () => {
  for (const [file, count] of Object.entries(FILES)) {
    it(file, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/instanceof Error \? \w+\.message/);
      expect((src.match(/actionErrorText\(err, '/g) ?? []).length).toBe(count);
      expect(src).toMatch(/import \{[^}]*actionErrorText[^}]*\} from '@\/lib\/ok-json';/);
    });
  }
});
