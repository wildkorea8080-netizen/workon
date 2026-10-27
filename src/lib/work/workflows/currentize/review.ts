// src/lib/work/workflows/currentize/review.ts
import { computeReviewItems } from '../../review';
import type { NewReviewItem } from '../../store/types';
import type { CurrentizeContent } from './plan';

/**
 * 현행화 판의 확인 사항. 판에 저장된 변경 목록만 본다(순수) — 판이 바뀌면 다시 계산한다.
 *  - NEEDS_CHECK(warning): 사람이 봐야 하는 변경(본문 수치·바뀐 인용·단위 모름·빈 칸 등). 파일에는 넣지 않았다
 *  - PROPOSED(warning): 근거가 모자라 넣지 않은 모델 제안
 *  - INCOMPLETE(blocking): 원가 상한·조각 상한으로 멈춰 일부만 현행화한 판 — 반쯤 바뀐 파일이 '완료'처럼 보이지 않게 검토 완료를 막는다
 *  - NEEDS_CHECK_MORE(warning): 위 둘이 종류마다 20개를 넘을 때 요약 한 줄
 *  - TEST_MODE(info): 시험 모드(모델 없이)로 만든 판
 */
/** 확인 필요·제안 확인 사항을 종류마다 몇 개까지 싣나 */
export const MAX_ITEMS_PER_KIND = 20;

export function currentizeReviewItems(content: CurrentizeContent): NewReviewItem[] {
  const items: NewReviewItem[] = [];
  if (content.costStopped) {
    items.push({ severity: 'blocking', code: 'INCOMPLETE', message: '원가 상한에 걸려 일부 문장을 현행화하지 못했습니다. 남은 문장을 직접 확인해야 검토를 마칠 수 있습니다.', field_ids: [] });
  }
  if (content.truncated) {
    items.push({ severity: 'blocking', code: 'INCOMPLETE', message: '작년 파일이 길어 앞부분만 현행화했습니다. 뒷부분은 직접 확인해야 검토를 마칠 수 있습니다.', field_ids: [] });
  }
  // 변경이 수백 개인 문서에서 확인 사항이 넘치지 않게 — 종류마다 앞 20개만, 넘으면 요약 한 줄(전체는 변경 내역표)
  const needs = content.changes.filter((c) => c.status === 'needs_check');
  const proposed = content.changes.filter((c) => c.status === 'proposed');
  for (const c of needs.slice(0, MAX_ITEMS_PER_KIND)) {
    items.push({ severity: 'warning', code: 'NEEDS_CHECK', message: c.note ?? '확인이 필요한 변경입니다', field_ids: [] });
  }
  for (const c of proposed.slice(0, MAX_ITEMS_PER_KIND)) {
    items.push({ severity: 'warning', code: 'PROPOSED', message: `AI 제안 — 근거가 모자라 파일에 넣지 않았습니다${c.note ? ` (${c.note})` : ''}`, field_ids: [] });
  }
  if (needs.length > MAX_ITEMS_PER_KIND || proposed.length > MAX_ITEMS_PER_KIND) {
    items.push({ severity: 'warning', code: 'NEEDS_CHECK_MORE', message: `확인 필요 ${needs.length + proposed.length}건 — 변경 내역표에서 전체를 보세요`, field_ids: [] });
  }
  if (content.mode === 'mock') items.push(...computeReviewItems({ fields: [], missing: [], knownText: '', testMode: true }));
  return items;
}
