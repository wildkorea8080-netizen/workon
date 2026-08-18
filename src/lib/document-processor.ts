import mammoth from 'mammoth';
// pdf-parse를 직접 lib 파일로 import — 기본 import 시 테스트 파일 실행 오류 방지
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
import { getEmbeddings } from '@/lib/embeddings';
import { extractTextFromHwp, isHwpFile } from '@/lib/hwp';

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;

export type DocumentChunk = {
  index: number;
  text: string;
  embedding: number[];
};

function normalizeText(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

async function extractTextFromFile(fileBuffer: Buffer, mimeType: string, fileName: string) {
  const lowerName = fileName.toLowerCase();

  if (mimeType === 'text/plain' || lowerName.endsWith('.txt')) {
    return new TextDecoder('utf-8').decode(fileBuffer);
  }

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const pdfData = await pdfParse(fileBuffer);
    return pdfData.text;
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  }

  if (isHwpFile(lowerName, mimeType)) {
    return extractTextFromHwp(fileBuffer, fileName);
  }

  throw new Error('지원되지 않는 파일 형식입니다. PDF, DOCX, TXT, HWP, HWPX만 업로드할 수 있습니다.');
}

function chunkText(text: string) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    const chunk = words.slice(start, end).join(' ');
    chunks.push(chunk);

    if (end === words.length) {
      break;
    }

    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

function averageEmbedding(vectors: number[][]) {
  if (vectors.length === 0) {
    return [];
  }

  const dims = vectors[0].length;
  const result = new Array<number>(dims).fill(0);

  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) {
      result[i] += vector[i];
    }
  }

  for (let i = 0; i < dims; i += 1) {
    result[i] = result[i] / vectors.length;
  }

  return result;
}

export async function processDocumentFile(fileBuffer: Buffer, mimeType: string, fileName: string) {
  const rawText = await extractTextFromFile(fileBuffer, mimeType, fileName);
  const normalizedText = normalizeText(rawText);
  const chunkTexts = chunkText(normalizedText);

  if (chunkTexts.length === 0) {
    throw new Error('문서에서 텍스트를 추출할 수 없습니다.');
  }

  // Voyage AI 임베딩 (크레딧 부족 등 실패 시 빈 임베딩으로 저장)
  let embeddings: number[][] = [];
  let embeddingError = false;
  try {
    embeddings = await getEmbeddings(chunkTexts);
  } catch (err: any) {
    console.warn('[document-processor] 임베딩 실패, 텍스트만 저장:', err.message);
    embeddingError = true;
    embeddings = chunkTexts.map(() => []);
  }

  const chunks: DocumentChunk[] = chunkTexts.map((text, index) => ({
    index,
    text,
    embedding: embeddings[index] ?? []
  }));

  return {
    text: normalizedText,
    chunks,
    summary: normalizedText.slice(0, 250),
    averageEmbedding: embeddingError ? [] : averageEmbedding(embeddings),
    embeddingError,
  };
}
