/**
 * 어떤 마이그레이션을 적용할지 고르는 순수 계산. db-migrate.mjs가 쓴다.
 * DB에 접속하지 않으므로 시험할 수 있다(tests/migrate-select.test.ts).
 */

/**
 * 번호 없이 돌릴 때 자동으로 적용하지 않는 마이그레이션.
 * 일반화하지 않고 목록으로 둔다: 하나가 더 생기면 그때 이유와 함께 적는다.
 * - 0028: 옛 칸을 지운다 — 새 코드가 배포되기 전에 적용하면 옛 코드가 깨진다(코드 배포 확인 뒤).
 * - 0032: 문서 임베딩 칸을 비운다 — 되돌릴 수 없다(noda:migrate -- --dry-run이 0을 보고한 뒤).
 */
export const MANUAL_ONLY = ['0028', '0032'];

const MANUAL_REASON = {
  '0028': '코드 배포를 확인한 뒤',
  '0032': '`npm run noda:migrate -- --dry-run`이 0건을 보고한 뒤(되돌릴 수 없습니다)',
};

/**
 * @param {string[]} files 정렬된 마이그레이션 파일명
 * @param {Set<string>} appliedSet 적용된 버전 번호
 * @param {string | undefined} only 번호로 지정한 경우 그 번호
 * @returns {{ pending: string[], skippedManual: string[] }}
 */
export function selectPending(files, appliedSet, only) {
  if (only) {
    return { pending: files.filter((f) => f.slice(0, 4) === only), skippedManual: [] };
  }
  const unapplied = files.filter((f) => !appliedSet.has(f.slice(0, 4)));
  return {
    pending: unapplied.filter((f) => !MANUAL_ONLY.includes(f.slice(0, 4))),
    skippedManual: unapplied.filter((f) => MANUAL_ONLY.includes(f.slice(0, 4))),
  };
}

export function manualOnlyNotice(skippedManual) {
  return skippedManual
    .map((f) => {
      const v = f.slice(0, 4);
      const when = MANUAL_REASON[v] ?? '확인한 뒤';
      return `${v}은 ${when} \`npm run db:migrate -- ${v}\`로 따로 적용합니다 (건너뜀: ${f})`;
    })
    .join('\n');
}
