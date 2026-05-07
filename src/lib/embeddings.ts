import { VOYAGE_API_KEY } from '@/lib/config';

const VOYAGE_EMBEDDING_MODEL = 'voyage-3';

/**
 * Voyage AI를 사용하여 텍스트를 벡터 임베딩으로 변환합니다.
 * 문서 검색 및 유사도 계산에 사용됩니다.
 */
export async function getEmbeddings(inputs: string[]): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY가 구성되지 않았습니다.');
  }

  // Voyage AI API로 임베딩 요청
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: VOYAGE_EMBEDDING_MODEL,
      input: inputs
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? 'Voyage embeddings 요청 중 오류가 발생했습니다.');
  }

  if (!Array.isArray(body.data)) {
    throw new Error('Voyage embeddings 응답 형식이 올바르지 않습니다.');
  }

  // 임베딩 벡터 배열 반환
  return body.data.map((item: any) => item.embedding as number[]);
}
