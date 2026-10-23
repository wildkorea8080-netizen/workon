import type { RetrievedChunk } from '@/lib/db';
import { sourceLocationLabel, stripNodaPrefixes, sourceNumber } from './source-label';

interface SourceCitationProps {
  sources: RetrievedChunk[];
  /** 칩을 누르면 오른쪽 근거 창을 연다 */
  onOpen?: (source: RetrievedChunk) => void;
}

/**
 * 참고 자료 — 답변 아래 한 줄짜리 칩(`[1] 문서 · p.43`). 누르면 오른쪽 근거 창(SourcePanel)이 열린다(2026-10-23).
 * 예전에는 근거마다 큰 카드를 쌓아 답변이 화면 위로 밀려났다.
 */
export default function SourceCitation({ sources, onOpen }: SourceCitationProps) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center flex-wrap gap-1.5">
      <span className="text-xs font-medium text-slate-500 mr-0.5">참고 자료</span>
      {sources.map((source, index) => {
        const title = (source.documentTitle && stripNodaPrefixes(source.documentTitle)) || '제목 없는 문서';
        const location = sourceLocationLabel(source);
        return (
          <button
            key={index}
            type="button"
            onClick={() => onOpen?.(source)}
            title={`${title} · ${location}`}
            className="inline-flex items-center gap-1.5 max-w-[280px] bg-white border border-slate-200 hover:border-[#003087]/40 hover:bg-[#003087]/5 rounded-md px-2 py-1 text-xs text-slate-700 transition-colors"
          >
            <span className="font-semibold text-[#003087]">[{sourceNumber(source)}]</span>
            <span className="truncate">{title}</span>
            {typeof source.page === 'number' && <span className="text-slate-400 flex-shrink-0">p.{source.page}</span>}
            {source.ocr && (
              <span className="flex-shrink-0 bg-amber-50 border border-amber-200 text-amber-800 rounded px-1 text-[10px]">스캔</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
