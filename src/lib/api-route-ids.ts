// src/lib/api-route-ids.ts
// API 주소의 id 자리가 uuid 꼴인지 미들웨어가 먼저 본다 — 아무것도 import하지 않는다(잎 파일, Edge에서도 돈다).
//
// 2026-11-23: 읽기 실패를 '없음'(404) 대신 '지금 못 읽음'(503)으로 답하게 고쳐 오면서, 주소에 엉뚱한 id가 오면
// (`/api/agents/abc`) DB가 'uuid 꼴이 아님'(22P02)으로 거절한 것도 503 '잠시 뒤 다시'가 되었다 — 라우트 65파일이
// id 꼴을 보지 않았다. 없는 주소는 404여야 한다. 라우트마다 고치는 대신 미들웨어가 한 곳에서 가른다.
//
// - API_ROUTES는 src/app/api의 route.ts 전부(앞 '/api/' 뗀 꼴). `tests/batch-0270.test.ts`가 실제 폴더와 맞댄다 —
//   **라우트를 더하거나 옮기면 이 목록도 고친다**(시험이 빠지거나 남은 줄을 알려 준다).
// - 주소를 Next.js처럼 맞춘다: 같은 자리면 고정 이름(`agents/personal`)이 `[id]`보다 먼저.
// - `[token]`(공유 링크 열쇠)·`[...x]`(NextAuth)는 uuid가 아니라 보지 않는다. 그 밖의 동적 자리는 모두 uuid
//   표의 id다(2026-11-23 시험 DB에서 확인 — 바뀌면 NON_UUID_SEGMENTS에 더한다).

export const API_ROUTES: readonly string[] = [
  'access-denied',
  'admin/adoption-report',
  'admin/adoption-report/departments',
  'admin/agent-categories',
  'admin/agent-categories/[id]',
  'admin/agents/[id]/approve',
  'admin/agents/[id]/reject',
  'admin/agents/approvals',
  'admin/api-keys',
  'admin/api-keys/[id]',
  'admin/app-automations',
  'admin/app-automations/batch-limit',
  'admin/app-automations/batches/[id]',
  'admin/app-automations/schedule-switch',
  'admin/app-automations/schedules/[id]',
  'admin/app-automations/webhook-switch',
  'admin/app-automations/webhooks/[id]',
  'admin/app-overview',
  'admin/audit-logs',
  'admin/budget',
  'admin/bulk-register',
  'admin/common-documents',
  'admin/common-documents/[id]/cited-by',
  'admin/common-documents/[id]/compare',
  'admin/feedback-summary',
  'admin/invite',
  'admin/invite/[id]',
  'admin/organization',
  'admin/organization/dormant-lock',
  'admin/outbound-endpoints',
  'admin/outbound-endpoints/[id]',
  'admin/preset-agents',
  'admin/sso',
  'admin/rag-eval',
  'admin/rag-eval/sets',
  'admin/shared-conversations',
  'admin/shared-conversations/[id]',
  'admin/shared-conversations/switch',
  'admin/usage-summary',
  'admin/work-installations',
  'admin/work-overview',
  'admin/work-templates',
  'admin/work-templates/[id]',
  'agents',
  'agents/[id]',
  'agents/[id]/app-draft',
  'agents/[id]/document-tags',
  'agents/[id]/history',
  'agents/[id]/promote',
  'agents/[id]/revert',
  'agents/[id]/templates',
  'agents/[id]/templates/[templateId]',
  'agents/favorite',
  'agents/personal',
  'agents/personal/[id]',
  'agents/personal/[id]/request-approval',
  'apps/batches',
  'apps/batches/[id]',
  'apps/batches/[id]/export',
  'apps/export',
  'apps/favorites',
  'apps/history',
  'apps/library',
  'apps/outbound-approvals',
  'apps/outbound-approvals/[id]',
  'apps/outbound-deliveries',
  'apps/outbound-deliveries/[id]',
  'apps/outbound-endpoints',
  'apps/schedules',
  'apps/schedules/[id]',
  'apps/webhook',
  'apps/webhook/batches/[id]',
  'apps/webhooks',
  'apps/webhooks/[id]',
  'attachments',
  'attachments/[id]',
  'attachments/[id]/original',
  'attachments/mine',
  'attachments/reusable',
  'attachments/reuse',
  'attachments/upload-url',
  'auth/[...nextauth]',
  'branding',
  'branding/logo',
  'chat',
  'common-documents/[id]/original',
  'common-documents/[id]/text',
  'connectors',
  'conversations',
  'conversations/[id]',
  'conversations/[id]/share',
  'cron/app-schedules',
  'cron/budget-alerts',
  'cron/noda-events',
  'departments',
  'departments/[id]',
  'documents',
  'documents/[id]',
  'documents/[id]/compare',
  'documents/[id]/original',
  'documents/[id]/read',
  'documents/[id]/references',
  'documents/[id]/tag-suggest',
  'documents/[id]/text',
  'documents/assign',
  'documents/confirm',
  'documents/references/build',
  'documents/tag-vocabulary',
  'documents/upload-url',
  'enhance-prompt',
  'files',
  'files/[id]',
  'forbidden-words',
  'forbidden-words/[id]',
  'messages/[id]/feedback',
  'messages/[id]/revise',
  'models',
  'my-library',
  'my-library/[id]',
  'my-library/[id]/original',
  'my/password',
  'my/sign-ins',
  'my/stats',
  'noda/webhook',
  'notices',
  'notices/[id]/read',
  'password-reset',
  'password-reset/confirm',
  'rag-test',
  'register',
  'register/validate-token',
  'security-logs',
  'shared/[token]',
  'signup',
  'signup/invite-info',
  'sso/[slug]/start',
  'sso/callback',
  'stats',
  'stats/usage',
  'super/accounts/me/password',
  'super/accounts/super-admins',
  'super/accounts/super-admins/[id]',
  'super/accounts/users',
  'super/accounts/users/[id]',
  'super/accounts/users/[id]/password-reset',
  'super/accounts/users/[id]/sign-in-lock',
  'super/api-keys/organizations',
  'super/api-keys/system',
  'super/api-keys/verify',
  'super/auth/login',
  'super/auth/logout',
  'super/auth/setup',
  'super/common-documents',
  'super/common-documents/[id]',
  'super/common-documents/[id]/cited-by',
  'super/common-documents/[id]/compare',
  'super/common-documents/[id]/read',
  'super/common-documents/upload-url',
  'super/contracts',
  'super/contracts/[id]',
  'super/contracts/expiring',
  'super/contracts/revenue',
  'super/dashboard',
  'super/impersonate/end',
  'super/logs/access',
  'super/logs/admin',
  'super/logs/impersonation',
  'super/logs/system',
  'super/notices',
  'super/notices/[id]',
  'super/organizations',
  'super/organizations/[id]',
  'super/organizations/[id]/api-keys',
  'super/organizations/[id]/impersonate',
  'super/organizations/[id]/invitations',
  'super/organizations/[id]/usage',
  'super/organizations/[id]/users',
  'super/organizations/[id]/verify-key',
  'super/settings',
  'super/sign-in-ip-lock',
  'super/usage',
  'super/usage/alerts',
  'super/usage/realtime',
  'super/work-settings',
  'system/maintenance',
  'templates',
  'users',
  'users/[id]',
  'users/[id]/active',
  'users/[id]/password-reset',
  'users/[id]/sign-in-lock',
  'v1/adoption-report',
  'v1/adoption-report/departments',
  'v1/app-runs',
  'v1/budget',
  'v1/chat',
  'v1/chat/attachments',
  'v1/chat/attachments/upload-url',
  'v1/documents',
  'v1/documents/[id]',
  'v1/documents/upload-url',
  'v1/feedback-summary',
  'v1/usage-summary',
  'work/artifacts/[id]/download',
  'work/files',
  'work/legacy-files',
  'work/tasks',
  'work/tasks/[id]',
  'work/tasks/[id]/currentize',
  'work/tasks/[id]/document',
  'work/tasks/[id]/evidence/[documentId]/open',
  'work/tasks/[id]/review',
  'work/tasks/[id]/revision-proposals',
  'work/tasks/[id]/revision-proposals/[proposalId]',
  'work/tasks/[id]/revision-proposals/[proposalId]/apply',
  'work/tasks/[id]/runs',
  'work/tasks/[id]/runs/[runId]',
  'work/tasks/[id]/runs/[runId]/cancel',
  'work/tasks/[id]/runs/[runId]/execute',
  'work/tasks/[id]/sources/confirm',
  'work/tasks/[id]/sources/import',
  'work/tasks/[id]/sources/import-legacy',
  'work/tasks/[id]/sources/upload-url',
  'work/tasks/[id]/versions',
  'work/tasks/[id]/versions/[versionId]/restore',
  'work/templates',
  'work/worker',
  'workflows',
];

/** uuid가 아닌 동적 자리 — 보지 않는다 */
// [slug] — 기관 로그인 경로(기관 SSO 시작, 0107)
export const NON_UUID_SEGMENTS: ReadonlySet<string> = new Set(['[token]', '[slug]']);

export const BAD_ROUTE_ID_MESSAGE = '찾을 수 없습니다.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Node = { fixed: Map<string, Node>; dynamic: { name: string; node: Node } | null; catchAll: boolean; route: boolean };
const newNode = (): Node => ({ fixed: new Map(), dynamic: null, catchAll: false, route: false });

function build(routes: readonly string[]): Node {
  const root = newNode();
  for (const r of routes) {
    let cur = root;
    let done = false;
    for (const seg of r.split('/')) {
      if (seg.startsWith('[...')) { cur.catchAll = true; done = true; break; }
      if (seg.startsWith('[')) {
        if (!cur.dynamic) cur.dynamic = { name: seg, node: newNode() };
        cur = cur.dynamic.node;
      } else {
        let next = cur.fixed.get(seg);
        if (!next) { next = newNode(); cur.fixed.set(seg, next); }
        cur = next;
      }
    }
    if (!done) cur.route = true;
  }
  return root;
}

const TREE = build(API_ROUTES);

function decodeSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 맞는 라우트를 찾으면 그 길에서 지난 동적 자리(이름·값), 못 찾으면 null — 고정 이름을 먼저 본다 */
function resolve(n: Node, segs: string[], i: number, seen: Array<[string, string]>): Array<[string, string]> | null {
  if (i === segs.length) return n.route ? seen : null;
  const fixed = n.fixed.get(segs[i]);
  if (fixed) {
    const hit = resolve(fixed, segs, i + 1, seen);
    if (hit) return hit;
  }
  if (n.dynamic) {
    const hit = resolve(n.dynamic.node, segs, i + 1, [...seen, [n.dynamic.name, decodeSeg(segs[i])]]);
    if (hit) return hit;
  }
  if (n.catchAll) return seen;
  return null;
}

/** `/api/…` 주소가 어떤 라우트에 맞는데 그 id 자리가 uuid 꼴이 아니면 참 — 미들웨어가 404로 답한다 */
export function badRouteId(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  const segs = pathname.slice('/api/'.length).replace(/\/+$/, '').split('/');
  if (segs.some((s) => s === '')) return false;
  const hit = resolve(TREE, segs, 0, []);
  if (!hit) return false;
  return hit.some(([name, value]) => !NON_UUID_SEGMENTS.has(name) && !UUID.test(value));
}
