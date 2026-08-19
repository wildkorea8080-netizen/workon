/**
 * 커넥터 이름 — **여기 한 곳에만** 둡니다.
 *
 * 커넥터 정의(`src/lib/connectors/*.ts`)는 `config.ts`를 거쳐 환경변수를 읽어
 * 클라이언트에서 import 할 수 없습니다. 그래서 화면이 이름을 쓰려면 목록을
 * 따로 들고 있게 되는데, 그러면 이름을 바꿨을 때 한쪽만 바뀝니다 —
 * 업로드 파일 형식에서 실제로 두 번 겪은 일입니다.
 *
 * 커넥터 쪽이 이 파일을 가져다 쓰고, 화면은 이 파일만 봅니다.
 */

export const CONNECTOR_LABELS: Record<string, string> = {
  law: '국가법령정보 (법제처)',
  kosis: '국가통계포털 KOSIS (통계청)',
  g2b: '나라장터 입찰공고 (조달청)',
  dart: '전자공시 DART (금융감독원)',
};

/** 화면 안내에 쓰는 짧은 이름. 괄호 안 소관 부처는 뺀다. */
export const CONNECTOR_SHORT_LABELS: Record<string, string> = {
  law: '국가법령정보',
  kosis: '국가통계포털',
  g2b: '나라장터',
  dart: '전자공시 DART',
};

export function connectorShortLabel(id: string): string {
  return CONNECTOR_SHORT_LABELS[id] ?? CONNECTOR_LABELS[id] ?? id;
}
