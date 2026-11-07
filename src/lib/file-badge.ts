/** 파일 확장자 배지(2026-11-07) — 채팅 파일 카드와 같은 꼴(HWP·DOC·XLS). 아무것도 import하지 않는다(화면이 씀) */
export function fileBadge(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ext === 'hwpx' || ext === 'hwp' ? 'HWP' : ext === 'docx' ? 'DOC' : ext === 'xlsx' ? 'XLS' : ext.toUpperCase().slice(0, 4) || '파일';
}
