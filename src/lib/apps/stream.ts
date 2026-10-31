/** Consume the existing assistant SSE contract without assuming chunk boundaries. */
export async function readAppStream(body: ReadableStream<Uint8Array>, receive: (event: string, data: Record<string, unknown>) => void): Promise<void> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let done = false;
  function consume() {
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      const json = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!event || !json) continue;
      const data = JSON.parse(json) as Record<string, unknown>;
      if (event === 'error') throw new Error(typeof data.message === 'string' ? data.message : '실행 중 오류가 발생했습니다.');
      if (event === 'done') done = true;
      receive(event, data);
    }
  }
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); consume(); }
    buffer += decoder.decode(); consume();
    if (!done) throw new Error('응답 수신이 중단됐습니다. 대화 기록에서 처리 결과를 확인해 주세요.');
  } finally { reader.releaseLock(); }
}
