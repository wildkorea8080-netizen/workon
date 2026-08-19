import mammoth from 'mammoth';
// pdf-parse를 직접 lib 파일로 import — 기본 import 시 테스트 파일 실행 오류 방지
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
import { getEmbeddings } from '@/lib/embeddings';
import { extractTextFromHwp, isHwpFile } from '@/lib/hwp';
import { extractTextFromScannedPdf, isLikelyScanned } from '@/lib/pdf-ocr';
import { extractTextFromSpreadsheet, isSpreadsheetFile } from '@/lib/spreadsheet';
import { extractTextFromPptx, isPptxFile } from '@/lib/pptx';
import { UPLOAD_FORMATS_LABEL } from '@/lib/file-types';
import type { ClaudeUsage } from '@/lib/claude';

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

/** 추출 결과. 스캔 PDF는 Claude를 거치므로 토큰을 쓴다. */
interface ExtractedText {
  text: string;
  /** 스캔 판독을 거쳤으면 그 사용량. 호출하는 쪽이 usage_logs에 기록해야 한다. */
  ocrUsage?: ClaudeUsage;
  ocrPages?: number;
}

async function extractTextFromFile(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<ExtractedText> {
  const lowerName = fileName.toLowerCase();

  if (mimeType === 'text/plain' || lowerName.endsWith('.txt')) {
    return { text: new TextDecoder('utf-8').decode(fileBuffer) };
  }

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const pdfData = await pdfParse(fileBuffer);
    const pageCount = pdfData.numpages ?? 0;

    // 텍스트 레이어가 없으면 pdf-parse는 오류가 아니라 빈 문자열을 준다.
    // 그대로 두면 "텍스트를 추출할 수 없습니다"로 거부되고 끝이라,
    // 공공기관 스캔 공문이 통째로 쓸 수 없는 자료가 된다.
    if (isLikelyScanned(pdfData.text ?? '', pageCount)) {
      const ocr = await extractTextFromScannedPdf(fileBuffer, pageCount);
      return { text: ocr.text, ocrUsage: ocr.usage, ocrPages: ocr.pageCount };
    }

    return { text: pdfData.text };
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return { text: result.value };
  }

  if (isHwpFile(lowerName, mimeType)) {
    return { text: await extractTextFromHwp(fileBuffer, fileName) };
  }

  // 표 문서는 셀을 이어붙이지 않고 마크다운 표로 복원한다.
  // 이어붙이면 열 머리글과 값의 대응이 끊긴다.
  if (isSpreadsheetFile(lowerName, mimeType)) {
    return { text: await extractTextFromSpreadsheet(fileBuffer, fileName) };
  }

  // 발표자료. 슬라이드 경계와 표를 살려 마크다운으로 복원한다.
  if (isPptxFile(lowerName, mimeType)) {
    return { text: await extractTextFromPptx(fileBuffer) };
  }

  // 목록을 여기 적지 않는다. 예전에 HWP를 추가했을 때 이 문구만 옛 목록으로
  // 남아 사용자가 올릴 수 있는 파일을 못 올린다고 읽었다.
  throw new Error(
    `지원되지 않는 파일 형식입니다. ${UPLOAD_FORMATS_LABEL}만 업로드할 수 있습니다.`
  );
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
  const extracted = await extractTextFromFile(fileBuffer, mimeType, fileName);
  const normalizedText = normalizeText(extracted.text);
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
    // 스캔 판독을 거쳤으면 토큰을 썼다. 업로드 라우트가 usage_logs에 남긴다.
    ocrUsage: extracted.ocrUsage,
    ocrPages: extracted.ocrPages,
  };
}
