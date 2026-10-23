import type { RetrievedChunk } from '@/lib/db';
import { sourceLocationLabel, stripNodaPrefixes } from './source-label';

interface SourceCitationProps {
  sources: RetrievedChunk[];
}

export default function SourceCitation({ sources }: SourceCitationProps) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center space-x-2">
        <div className="w-1 h-4 bg-slate-400 rounded-full"></div>
        <div className="text-xs font-medium text-slate-600">참고 자료</div>
        <div className="text-xs text-slate-500">({sources.length}개)</div>
      </div>
      <div className="space-y-2">
        {sources.map((source, index) => (
          <div key={index} className="bg-slate-50 border border-slate-200 rounded-md p-3">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center space-x-2 mb-1">
                  <div className="w-2 h-2 bg-slate-600 rounded-full"></div>
                  <span className="text-sm font-medium text-slate-900">
                    {(source.documentTitle && stripNodaPrefixes(source.documentTitle)) || '제목 없는 문서'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 ml-4 flex items-center flex-wrap gap-1.5">
                  <span>{sourceLocationLabel(source)}</span>
                  {/* 글자 인식으로 읽은 조각 — 원문과 다르게 읽혔을 수 있어 숫자는 원문으로 확인해야 한다 */}
                  {source.ocr && (
                    <span
                      title="원문을 글자 인식으로 읽어 숫자·글자가 다를 수 있습니다"
                      className="inline-block bg-amber-50 border border-amber-200 text-amber-800 rounded px-1.5 py-px text-[10px] font-medium"
                    >
                      스캔 판독
                    </span>
                  )}
                </div>
                {/* NODA 근거는 조각 글이 비어 있다 — 빈 미리보기 칸은 그리지 않는다 */}
                {source.text && source.text.trim() && (
                  <div className="mt-2 text-xs text-slate-700 bg-white p-2 rounded border-l-2 border-slate-300 ml-4">
                    {source.text.length > 100
                      ? `${source.text.substring(0, 100)}...`
                      : source.text}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
