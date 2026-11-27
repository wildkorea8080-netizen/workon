import PublicAskPanel from '@/components/admin/PublicAskPanel';

/** 관리자 '시민 상담'(2026-11-27, 0136) — 시민용 민원 상담 창 설정·시민 전용 비서·붙일 코드·최근 질문 */
export default function AdminPublicAskPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-slate-900">시민 상담</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">시민이 로그인 없이 기관에 묻는 AI 상담 창입니다. 기관 전체 관리자만 설정합니다.</p>
      <PublicAskPanel />
    </div>
  );
}
