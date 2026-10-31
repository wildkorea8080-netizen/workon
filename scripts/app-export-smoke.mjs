/** Synthetic storage roundtrip. Only the newly created conversation/files are removed. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); }
const { supabaseAdmin: db } = await import('../src/lib/supabaseAdmin.ts');
const { SUPABASE_DOCUMENTS_BUCKET } = await import('../src/lib/config.ts');
const { saveGeneratedFile, findOwnedFile, signedDownloadUrl, deleteConversationFiles } = await import('../src/lib/generated-files.ts');
const { loadBuiltinTemplate, findBuiltinTemplate } = await import('../src/lib/builtin-templates.ts');
const { buildAppResultHwpx } = await import('../src/lib/apps/export.ts');
const { checkPackage } = await import('../src/lib/work/documents/package-check.ts');
const user = await db.from('users').select('id,department_id').not('department_id','is',null).limit(1).single(); assert(!user.error && user.data);
const dept = await db.from('departments').select('organization_id').eq('id',user.data.department_id).single(); assert(!dept.error && dept.data?.organization_id);
const agent = await db.from('agents').select('id').eq('organization_id',dept.data.organization_id).is('deleted_at',null).limit(1).single(); assert(!agent.error && agent.data);
let conversationId; let storagePath;
try {
  const created = await db.from('conversations').insert({ user_id: user.data.id, department_id: user.data.department_id, agent_id: agent.data.id, title: 'WORKON 가상 파일 점검' }).select('id').single(); assert(!created.error && created.data); conversationId = created.data.id;
  const template = await loadBuiltinTemplate(findBuiltinTemplate('builtin:report'));
  const bytes = await buildAppResultHwpx(template, { name: '가상 안내문 앱', version: 1, content: '가상 행사 참석자는 30명입니다.\n장소는 새빛회의실이며 개최일은 미정입니다.', references: { chunks: [{ n: 1, documentTitle: '가상 행사 자료', page: 1 }] }, createdAt: '가상 시험 시각' });
  const input = { organizationId: dept.data.organization_id, departmentId: user.data.department_id, userId: user.data.id, agentId: agent.data.id, conversationId, templateRef: `app-result:${randomUUID()}:smoke`, templateName: '앱 실행 결과 점검', fileName: '가상 앱 결과.hwpx', extension: 'hwpx', mimeType: 'application/hwp+zip', bytes };
  const file = await saveGeneratedFile(input); const owned = await findOwnedFile(file.id, user.data.id); assert(owned); storagePath = owned.storage_path;
  assert.equal(await findOwnedFile(file.id, randomUUID()), null);
  const url = await signedDownloadUrl(owned.storage_path, owned.file_name); assert(url);
  const response = await fetch(url); assert(response.ok);
  const downloaded = Buffer.from(await response.arrayBuffer()); assert.equal(createHash('sha256').update(downloaded).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert((await checkPackage(downloaded, { format: 'hwpx', values: ['30명', '새빛회의실'] })).valid);
  let duplicateRejected = false; try { await saveGeneratedFile(input); } catch { duplicateRejected = true; } assert(duplicateRejected);
  const count = await db.from('generated_files').select('id', { count: 'exact', head: true }).eq('conversation_id',conversationId); assert.equal(count.count,1);
  mkdirSync('docs/benchmarks/allganize/evidence', { recursive: true }); writeFileSync('docs/benchmarks/allganize/evidence/app-result-export.hwpx',downloaded);
  console.log('PASS real HWPX storage/download/hash; owner-only lookup; duplicate rejection');
} finally {
  if (conversationId) {
    await deleteConversationFiles(conversationId);
    const removed = await db.from('conversations').delete().eq('id',conversationId).eq('user_id',user.data.id); assert(!removed.error);
    if (storagePath) { const remaining = await db.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(storagePath); assert(remaining.error, 'Synthetic storage file was not removed'); }
    const count = await db.from('generated_files').select('id', { count: 'exact', head: true }).eq('conversation_id',conversationId); assert.equal(count.count,0);
    console.log('CLEANUP verified: only synthetic conversation/files removed');
  }
}
