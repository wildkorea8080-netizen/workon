// src/lib/capabilities/document.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { access } from 'fs/promises';
import path from 'path';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { readTemplate, fillTemplate } from '@/lib/doc-fill';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_DIR, findBuiltinTemplate, loadBuiltinTemplate, type BuiltinTemplate } from '@/lib/builtin-templates';
import { saveGeneratedFile, safeFileName, type SaveGeneratedFileInput } from '@/lib/generated-files';
import { writeUsageLog } from '@/lib/assistant/persist';
import type { Capability, GeneratedFileRef, ToolOutcome, TurnContext } from './types';

/**
 * 문서 만들기 — 양식을 채우거나 표준 서식(기본 양식)으로 한글 파일을 만든다(설계 3절).
 *
 * 도구 입력에는 기관·대화·비서 id가 없다. 양식은 이 비서의 것과 기본 양식만,
 * 파일은 서버 문맥(ctx)의 대화·사용자에 묶는다. 입력에 다른 값이 와도 쓰지 않는다.
 */

export interface AgentTemplateRow {
  id: string;
  name: string;
  file_name: string;
  storage_path: string;
}

export interface DocumentDeps {
  listAgentTemplates(agentId: string): Promise<AgentTemplateRow[]>;
  downloadAgentTemplate(storagePath: string): Promise<Buffer>;
  loadBuiltin(t: BuiltinTemplate): Promise<Buffer | null>;
  /** 기본 양식 파일이 있는가. 목록마다 파일을 읽지 않게 있는지만 본다 */
  builtinReady(t: BuiltinTemplate): Promise<boolean>;
  saveFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef>;
  logGenerated(row: { departmentId: string; userId: string; conversationId: string; details: Record<string, unknown> }): Promise<void>;
}

export const DOCUMENT_ADDENDUM = `[문서 만들기]
이 비서는 양식을 채우거나 표준 서식으로 한글(HWPX) 파일을 만들 수 있습니다.
1. 공문·보고서·회의록 같은 문서를 만들어 달라고 하면 list_templates로 쓸 양식을 고릅니다. 사용자가 양식을 말하지 않았고 후보가 여럿이면 어느 양식으로 할지 묻습니다.
2. read_template으로 채울 항목을 읽어 목차로 보여 주고 이대로 쓸지 확인을 받습니다. 확인 전에는 파일을 만들지 않습니다.
3. 확인되면 항목별 초안을 대화에 쓰고 끝에 "이대로 한글 파일로 만들까요?"라고 묻습니다.
4. 만들어 달라고 하면 대화에 쓴 초안 그대로 fill_template을 부릅니다. 고쳐 달라는 말이 있었으면 고친 내용으로 부릅니다. 사용자가 처음부터 바로 파일로 달라고 했으면 3의 질문 없이 만들고(2의 목차 확인은 그대로 거칩니다), 대화에는 짧은 요약만 씁니다.
5. 일시·장소·참석자·문서번호·수신처처럼 받은 자료에 없는 사실은 지어내지 않습니다. 묻거나 빈칸으로 두고, 빈칸으로 둔 항목을 알려 줍니다.
6. 도구가 실패하면 그 이유를 그대로 알리고, 대화에 초안을 썼다면 그 글을 복사해 쓸 수 있다고, 쓰지 않았다면 초안을 대화에 써 드릴 수 있다고 덧붙입니다.
7. 앞 응답의 도구 결과는 다음 응답에 남지 않습니다. 파일을 만들 때는 list_templates·read_template으로 ref와 자리 번호를 다시 확인한 뒤 fill_template을 부릅니다. 자리 번호를 추측하지 않습니다.`;

const NOT_ALLOWED = '이 비서에서 쓸 수 없는 양식입니다. list_templates로 쓸 수 있는 양식을 다시 확인해 주세요.';

interface Resolved {
  ref: string;
  name: string;
  fileName: string;
  load(): Promise<Buffer | null>;
}

function formatOf(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ['hwpx', 'docx', 'hwp'].includes(ext) ? ext : 'unknown';
}

function readRef(input: Record<string, unknown>): string | null {
  return typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : null;
}

function readValues(input: Record<string, unknown>): { slot_id: string; text: string }[] | null {
  if (!Array.isArray(input.values)) return null;
  const out: { slot_id: string; text: string }[] = [];
  for (const v of input.values) {
    if (!v || typeof v !== 'object') return null;
    const { slot_id, text } = v as Record<string, unknown>;
    if (typeof slot_id !== 'string' || typeof text !== 'string') return null;
    out.push({ slot_id, text });
  }
  return out;
}

export function createDocument(deps: DocumentDeps): Capability {
  async function resolve(ref: string, ctx: TurnContext): Promise<Resolved | null> {
    const builtin = findBuiltinTemplate(ref);
    if (builtin) return { ref, name: builtin.name, fileName: builtin.file, load: () => deps.loadBuiltin(builtin) };
    const row = (await deps.listAgentTemplates(ctx.agentId)).find((r) => r.id === ref);
    if (!row) return null;
    return { ref, name: row.name, fileName: row.file_name, load: () => deps.downloadAgentTemplate(row.storage_path) };
  }

  async function loadOrFail(ref: string | null, ctx: TurnContext): Promise<{ t: Resolved; bytes: Buffer } | ToolOutcome> {
    if (!ref) return { ok: false, text: 'ref가 필요합니다. list_templates가 돌려준 ref를 넣어 주세요.' };
    const t = await resolve(ref, ctx);
    if (!t) return { ok: false, text: NOT_ALLOWED };
    const bytes = await t.load();
    if (!bytes) return { ok: false, text: `기본 양식(${t.name}) 파일이 아직 준비되지 않았습니다. 관리자에게 알려 주세요.` };
    return { t, bytes };
  }

  return {
    id: 'document',
    label: '문서 만들기',
    description: '양식을 채우거나 표준 서식으로 한글 파일을 만듭니다.',
    isAvailable: () => true,

    async prepare() {
      return { systemAddendum: DOCUMENT_ADDENDUM };
    },

    tools() {
      return [
        {
          name: 'list_templates',
          description: '이 비서가 쓸 수 있는 양식 목록(기관이 올린 양식 + 표준 서식). 문서를 만들기 전에 먼저 부른다.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_template',
          description: '양식 하나의 채울 항목(목차)을 읽는다. 사용자에게 목차를 보여 주고 확인받을 때 쓴다.',
          inputSchema: {
            type: 'object',
            properties: { ref: { type: 'string', description: 'list_templates가 돌려준 ref' } },
            required: ['ref'],
          },
        },
        {
          name: 'fill_template',
          description: '확인받은 초안을 양식에 채워 한글 파일을 만든다. 대화에 내려받기 링크가 붙는다.',
          inputSchema: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'list_templates가 돌려준 ref' },
              title: { type: 'string', description: '파일 이름으로 쓸 문서 제목' },
              values: {
                type: 'array',
                description: 'read_template이 돌려준 자리 번호별 글',
                items: {
                  type: 'object',
                  properties: {
                    slot_id: { type: 'string' },
                    text: { type: 'string', description: '넣을 글. 줄바꿈 하나가 문단 하나' },
                  },
                  required: ['slot_id', 'text'],
                },
              },
            },
            required: ['ref', 'title', 'values'],
          },
        },
      ];
    },

    async execute(tool, input, ctx): Promise<ToolOutcome> {
      if (tool === 'list_templates') {
        const agentTemplates = await deps.listAgentTemplates(ctx.agentId);
        // 파일이 없는 기본 양식을 목록에 두면 모델이 골랐다가 막힌다
        const ready = await Promise.all(BUILTIN_TEMPLATES.map((t) => deps.builtinReady(t)));
        const list = [
          ...BUILTIN_TEMPLATES.filter((_, i) => ready[i]).map((t) => ({ ref: t.ref, name: t.name, kind: 'builtin', format: 'hwpx' })),
          ...agentTemplates.map((t) => ({ ref: t.id, name: t.name, kind: 'agent', format: formatOf(t.file_name) })),
        ];
        return { ok: true, text: JSON.stringify(list) };
      }

      if (tool === 'read_template') {
        const loaded = await loadOrFail(readRef(input), ctx);
        if ('ok' in loaded) return loaded;
        const read = await readTemplate(loaded.bytes, loaded.t.fileName);
        if (!read.ok) return { ok: false, text: read.reason };
        return { ok: true, text: JSON.stringify({ ref: loaded.t.ref, name: loaded.t.name, slots: read.slots }) };
      }

      if (tool === 'fill_template') {
        const values = readValues(input);
        if (!values) return { ok: false, text: 'values는 [{ slot_id, text }] 목록이어야 합니다.' };
        const loaded = await loadOrFail(readRef(input), ctx);
        if ('ok' in loaded) return loaded;

        const filled = await fillTemplate(loaded.bytes, loaded.t.fileName, values);
        if (!filled.ok) return { ok: false, text: filled.reason };

        const title = typeof input.title === 'string' && input.title.trim() ? input.title : loaded.t.name;
        const fileName = safeFileName(title, filled.extension);

        let saved: GeneratedFileRef;
        try {
          saved = await deps.saveFile({
            organizationId: ctx.organizationId,
            departmentId: ctx.departmentId,
            userId: ctx.userId,
            agentId: ctx.agentId,
            conversationId: ctx.conversationId,
            templateRef: loaded.t.ref,
            templateName: loaded.t.name,
            fileName,
            extension: filled.extension,
            mimeType: filled.mimeType,
            bytes: filled.bytes,
          });
        } catch (error) {
          // 파일이 실패해도 초안 글은 대화에 남는다(서비스 정의서 7.5)
          return {
            ok: false,
            text: `파일을 저장하지 못했습니다(이유: ${error instanceof Error ? error.message : '알 수 없는 오류'}). 대화에 초안을 썼다면 그 글을 복사해 쓸 수 있다고, 쓰지 않았다면 초안을 대화에 써 드릴 수 있다고 알려 주세요.`,
          };
        }

        await deps.logGenerated({
          departmentId: ctx.departmentId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          details: {
            agent_id: ctx.agentId,
            template_ref: loaded.t.ref,
            template_name: loaded.t.name,
            file_name: saved.file_name,
            size_bytes: saved.size_bytes,
            filled: filled.filled.length,
            unfilled: filled.unfilled.length,
          },
        });

        const unfilledNote = filled.unfilled.length
          ? ` 채우지 않은 항목 ${filled.unfilled.length}개: ${filled.unfilled.join(', ')} — 사용자에게 알려 주세요.`
          : '';
        return {
          ok: true,
          text: `한글 파일을 만들었습니다: ${saved.file_name} (채운 항목 ${filled.filled.length}개).${unfilledNote} 대화 아래에 내려받기 링크가 붙습니다.`,
          files: [saved],
        };
      }

      return { ok: false, text: `알 수 없는 도구입니다: ${tool}` };
    },
  };
}

const defaultDeps: DocumentDeps = {
  async listAgentTemplates(agentId) {
    const { data, error } = await supabaseAdmin
      .from('agent_templates')
      .select('id, name, file_name, storage_path')
      .eq('agent_id', agentId)
      .is('retired_at', null)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`양식 목록을 읽지 못했습니다: ${error.message}`);
    return (data ?? []) as AgentTemplateRow[];
  },
  async downloadAgentTemplate(storagePath) {
    const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(storagePath);
    if (error || !data) throw new Error(`양식 파일을 받지 못했습니다: ${error?.message ?? '빈 응답'}`);
    return Buffer.from(await data.arrayBuffer());
  },
  loadBuiltin: (t) => loadBuiltinTemplate(t),
  async builtinReady(t) {
    try {
      await access(path.join(BUILTIN_TEMPLATE_DIR, t.file));
      return true;
    } catch {
      return false;
    }
  },
  saveFile: saveGeneratedFile,
  async logGenerated(row) {
    // 토큰을 쓰지 않는 기록이다 — 과금 규약(TOKEN_ACTIONS) 대상이 아니다(설계 5.5)
    await writeUsageLog({
      departmentId: row.departmentId,
      userId: row.userId,
      action: 'document_generated',
      resourceType: 'conversation',
      resourceId: row.conversationId,
      details: row.details,
    });
  },
};

// 전역 document(DOM)와 헷갈리지 않게 이름을 길게 둔다
export const documentCapability = createDocument(defaultDeps);
