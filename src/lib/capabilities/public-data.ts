// src/lib/capabilities/public-data.ts
import { availableConnectors, toolsForConnectors, executeTool } from '@/lib/connectors';
import type { Capability } from './types';

/** 공공데이터 조회 — 커넥터를 감싼다. 커넥터 코드는 그대로 둔다. */
export const publicData: Capability = {
  id: 'public_data',
  label: '공공데이터 조회',
  description: '법령·통계·입찰·공시를 실시간으로 조회합니다.',
  isAvailable: () => availableConnectors().length > 0,
  tools(ctx) {
    return toolsForConnectors(ctx.capabilities.public_data?.connectors).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  },
  async execute(tool, input) {
    // executeTool은 예외를 던지지 않고 isError로 돌려준다
    const result = await executeTool(tool, input);
    return { ok: !result.isError, text: result.content, sources: { links: result.sources } };
  },
};
