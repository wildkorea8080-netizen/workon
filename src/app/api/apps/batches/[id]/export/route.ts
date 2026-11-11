import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { validateAppDefinition } from '@/lib/apps/definition';
import { batchWorkbook, getBatch, loadBatchDeliveries, loadBatchResults } from '@/lib/apps/batches';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 일괄 실행 결과 엑셀(0077) — 만든 사람만. 줄마다 입력·상태·결과 글(그 실행의 답변)·오류·대화 주소 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const out = await getBatch(session.user.id, params.id);
  if (!out) return fail('일괄 실행을 찾을 수 없습니다.', 404);
  const results = await loadBatchResults(session.user.id, params.id);
  if (!results) return fail('결과를 불러오지 못했습니다.', 503);
  // 외부로 보낸 상태·접수 번호(0076·0080) — 못 읽어도 엑셀은 만든다(열 없이)
  const deliveries = await loadBatchDeliveries(session.user.id, params.id).catch(() => null);
  // 열 이름은 지금 앱의 입력 항목 — 앱이 바뀌어 없는 항목은 키로
  const { data: agent } = await supabaseAdmin.from('agents').select('app_definition').eq('id', out.batch.agentId).maybeSingle();
  const def = validateAppDefinition((agent as { app_definition?: unknown } | null)?.app_definition ?? null);
  const labels = new Map((def.ok && def.value ? def.value.fields : []).map((f) => [f.key, f.label]));
  const keys = [...new Set(out.items.flatMap((it) => Object.keys(it.inputs)))];
  const buffer = await batchWorkbook({
    name: out.batch.name, origin: APP_URL.replace(/\/$/, ''),
    fields: keys.map((key) => ({ key, label: labels.get(key) ?? key })),
    items: out.items.map((it) => ({ ...it, result: results.get(it.position) ?? null, delivery: deliveries?.get(it.position) ?? null })),
  });
  const filename = `${out.batch.name.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60)} 결과.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="batch-result.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}
