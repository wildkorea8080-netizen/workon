import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { getEmbeddings } from '@/lib/embeddings';

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
    const pdfData = await pdf(fileBuffer);
    return pdfData.text;
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  }

  throw new Error('지원되지 않는 파일 형식입니다. PDF, DOCX, TXT만 업로드할 수 있습니다.');
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

  const embeddings = await getEmbeddings(chunkTexts);
  const chunks: DocumentChunk[] = chunkTexts.map((text, index) => ({
    index,
    text,
    embedding: embeddings[index]
  }));

  return {
    text: normalizedText,
    chunks,
    summary: normalizedText.slice(0, 250),
    averageEmbedding: averageEmbedding(embeddings)
  };
}
