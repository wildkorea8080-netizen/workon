'use client';

import { useEffect, useState } from 'react';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api } from '@/lib/work/client';
import type { TemplatesDto } from '@/components/work/types';

/**
 * 양식 — WORKON 표준 양식과 기관 양식. 검증 등급을 그대로 보인다:
 * '한글 검증 완료'(사람의 시각 검토까지) · '한글 자동 검증 통과 · 시각 검토 전' · '검증 전'.
 */
export default function TemplatesPage() {
  const [data, setData] = useState<TemplatesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<TemplatesDto>('/api/work/templates').then((r) => (r.ok ? setData(r.data) : setError(r.error.message)));
  }, []);
  const tone = (s: string) => (s === 'verified' ? 'ok' : s === 'mapped' ? 'warn' : 'bad');
  return (
    <WorkShell>
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
        <PageTitle title="양식" subtitle="작업을 만들 때 고를 수 있는 양식입니다. 지원 범위: 양식의 표시 자리·표 칸에 글 넣기(새 표 행·그림 넣기는 아직 지원하지 않음)." />
        <ErrorNote message={error} />
        <h2 className="mb-3 text-[18px] font-semibold">WORKON 표준 양식</h2>
        <div className="grid gap-3 md:grid-cols-3 mb-8">
          {data?.builtin.map((t) => (
            <Card key={t.ref}>
              <div className="font-semibold">{t.name}</div>
              <div className="mt-2">
                <StatusBadge label={t.label} tone={tone(t.status)} />
              </div>
              {t.reason && <p className="mt-2 text-[13px] text-red-700">{t.reason}</p>}
            </Card>
          ))}
        </div>
        <h2 className="mb-3 text-[18px] font-semibold">우리 기관 양식</h2>
        {data && data.organization.length === 0 ? (
          <Card>
            <p className="text-[15px] text-slate-600">등록된 기관 양식이 없습니다. 기관 양식 등록·대응·시험 생성은 관리자 화면에서 제공될 예정입니다(준비 중). 그전까지는 표준 양식으로 만듭니다.</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {data?.organization.map((t) => (
              <Card key={t.id}>
                <div className="font-semibold">{t.name}</div>
                <div className="mt-1 text-[13px] text-slate-500">
                  {t.format.toUpperCase()} · 채울 자리 {t.fieldCount}곳
                </div>
                <div className="mt-2">
                  <StatusBadge label={t.label} tone={tone(t.status)} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </WorkShell>
  );
}
