export default function Page() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 bg-slate-700/50 rounded-lg animate-pulse" />
      <div className="h-4 w-80 bg-slate-800/50 rounded animate-pulse" />
      <div className="mt-8 p-8 bg-[#1E293B] border border-slate-700/50 rounded-2xl text-center">
        <p className="text-2xl mb-2">🚧</p>
        <p className="text-slate-400 text-sm font-medium">준비 중</p>
        <p className="text-slate-600 text-xs mt-1">다음 단계에서 구현됩니다.</p>
      </div>
    </div>
  );
}
