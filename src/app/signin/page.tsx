import Link from 'next/link';

export default function SignInPage() {
  return (
    <main className="min-h-screen px-6 py-16 mx-auto max-w-md">
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold">로그인</h1>
        <p className="text-slate-600">로그인 페이지는 이제 <strong>/login</strong>에 있습니다.</p>
        <Link href="/login" className="px-4 py-3 inline-block font-medium text-white bg-slate-900 rounded-lg">
          로그인 페이지로 이동
        </Link>
        <p className="text-sm text-slate-500">이전 경로를 사용하는 경우 자동으로 로그인 페이지로 이동할 수 있습니다.</p>
        <Link href="/" className="text-slate-900 underline">
          홈으로 돌아가기
        </Link>
      </div>
    </main>
  );
}
