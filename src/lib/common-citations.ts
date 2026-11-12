// src/lib/common-citations.ts
// 슈퍼관리자 공통 자료실 '인용 기관'(2026-11-12)의 한 줄 요약 — 화면이 읽는 잎 파일(아무것도 import하지 않는다).
// 기관마다 문서 수만 다룬다(문서 이름은 기관 밖으로 내지 않는다 — document-references-db.ts `commonCitationCounts`).

export interface CitedOrgCounts {
  orgCount: number;
  truncated: boolean;
  organizations: Array<{ organizationId: string; name: string; exact: number; similar: number }>;
}

export function citedOrgSummary(data: Pick<CitedOrgCounts, 'orgCount' | 'organizations'>): string {
  if (!data.orgCount) return '이 유형의 기관이 없습니다.';
  if (!data.organizations.length) return `이 유형 기관 ${data.orgCount}곳 중 이 기준을 「」로 인용한 문서가 있는 기관이 없습니다(색인한 문서 안에서).`;
  const docs = data.organizations.reduce((n, o) => n + o.exact + o.similar, 0);
  return `이 유형 기관 ${data.orgCount}곳 중 ${data.organizations.length}곳의 문서 ${docs}개가 이 기준을 인용합니다(색인한 문서 안에서).`;
}
