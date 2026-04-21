import type { RetrievedChunk } from '@/lib/db';

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
                    {source.documentTitle || '제목 없는 문서'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 ml-4">
                  청크 {source.chunkIndex + 1} • 유사도: {(source.similarity * 100).toFixed(1)}%
                </div>
                {source.text && (
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