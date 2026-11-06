import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import DocumentsManager from '@/components/admin/DocumentsManager';
import RAGSearchTester from '@/components/admin/RAGSearchTester';
import RagEvalPanel from '@/components/admin/RagEvalPanel';
import CommonLibraryPanel from '@/components/admin/CommonLibraryPanel';

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
        <p className="text-slate-600 mt-2">비서가 근거로 쓸 문서를 올리고 관리합니다. 올린 문서는 문서 읽기 서비스(NODA)가 읽어 대화에서 찾을 수 있게 합니다.</p>
      </div>

      <DocumentsManager />

      <CommonLibraryPanel />

      <RAGSearchTester />

      <RagEvalPanel />
    </section>
  );
}
