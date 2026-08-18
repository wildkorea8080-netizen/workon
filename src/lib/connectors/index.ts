/**
 * 커넥터 레지스트리.
 *
 * 설정된 커넥터의 툴만 모아 모델에게 노출하고, 툴 이름으로 실행을 라우팅합니다.
 * 새 커넥터를 추가하려면 CONNECTORS 배열에 넣기만 하면 됩니다.
 */

import { lawConnector } from './law';
import { toolError, type Connector, type ToolDefinition, type ToolResult } from './types';

export * from './types';

const CONNECTORS: Connector[] = [lawConnector];

/** 환경변수가 갖춰진 커넥터만 */
export function availableConnectors(): Connector[] {
  return CONNECTORS.filter((connector) => connector.isConfigured());
}

/** 모델에게 넘길 툴 정의 전체 (MCP 형식) */
export function availableTools(): ToolDefinition[] {
  return availableConnectors().flatMap((connector) => connector.tools);
}

/**
 * 지정한 커넥터의 툴만 추린다.
 *
 * 에이전트마다 쓸 커넥터가 다르다. 빈 배열이면 도구를 쓰지 않는다는 뜻이므로
 * 빈 배열을 돌려준다 (전체 노출로 폴백하지 않는다).
 */
export function toolsForConnectors(connectorIds: string[] | null | undefined): ToolDefinition[] {
  if (!connectorIds?.length) return [];
  const allowed = new Set(connectorIds);
  return availableConnectors()
    .filter((connector) => allowed.has(connector.id))
    .flatMap((connector) => connector.tools);
}

/** 관리 화면에 보여줄 커넥터 목록 */
export function connectorCatalog(): { id: string; label: string; toolNames: string[] }[] {
  return availableConnectors().map((connector) => ({
    id: connector.id,
    label: connector.label,
    toolNames: connector.tools.map((tool) => tool.name),
  }));
}

/** 툴 이름으로 담당 커넥터를 찾는다 */
function findConnector(toolName: string): Connector | undefined {
  return availableConnectors().find((connector) =>
    connector.tools.some((tool) => tool.name === toolName)
  );
}

/**
 * 툴을 실행한다.
 *
 * 어떤 경우에도 예외를 던지지 않는다 — 툴 실행 실패는 모델이 읽고 대처해야 할
 * 정보이지 요청 전체를 죽일 사유가 아니다.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const connector = findConnector(toolName);
  if (!connector) {
    return toolError(`사용할 수 없는 도구입니다: ${toolName}`);
  }

  try {
    return await connector.execute(toolName, input);
  } catch (err: any) {
    console.error(`[connectors] ${toolName} 실행 오류:`, err?.message);
    return toolError(`도구 실행 중 오류가 발생했습니다: ${err?.message ?? '알 수 없는 오류'}`);
  }
}
