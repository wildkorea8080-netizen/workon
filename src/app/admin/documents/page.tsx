import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import DocumentsManager from '@/components/admin/DocumentsManager';
import RAGSearchTester from '@/components/admin/RAGSearchTester';

export default async function AdminDocumentsPage() {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <div className="text-center py-8">
        <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
        <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">📚 문서 관리</h1>
        <p className="text-slate-600 mt-2">문서를 업로드하고 관리합니다. 업로드 시 자동으로 텍스트 추출, 청킹, 임베딩이 처리됩니다.</p>
      </div>

      <DocumentsManager />

      <RAGSearchTester />
    </section>
  );
}
