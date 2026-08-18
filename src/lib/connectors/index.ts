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
