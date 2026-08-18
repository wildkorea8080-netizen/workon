import { ANTHROPIC_API_KEY } from '@/lib/config';
import { CLAUDE_MODEL, type ClaudeUsage } from '@/lib/claude';

/**
 * 스캔 PDF 텍스트 추출.
 *
 * 공공기관 문서는 옛 공문·결재문서·붙임 서류가 스캔본인 경우가 많다.
 * 텍스트 레이어가 없으면 pdf-parse가 빈 문자열을 돌려주고, 그 문서는
 * 업로드 자체가 거부돼 아예 쓸 수 없었다.
 *
 * **PDF를 이미지로 렌더링하지 않는다.** Anthropic API가 PDF를 document
 * 블록으로 직접 받아 각 페이지를 시각적으로 읽는다. 렌더링 방식을 택하면
 * pdfium/poppler 같은 바이너리가 필요한데 Vercel serverless에서 부담이 크다.
 *
 * 새 외부 업체를 붙이지 않는다는 점도 중요하다. Anthropic은 이미 필수
 * 의존이라 별도 OCR 업체나 멀티모달 임베딩 업체를 늘리지 않고 해결된다.
 * 공공기관 보안성 검토에서 문서 본문이 나가는 곳이 하나 늘고 마는 차이가 크다.
 */

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

/** Anthropic document 블록의 상한. 넘으면 요청 자체가 거부된다. */
export const MAX_OCR_PAGES = 100;
export const MAX_OCR_BYTES = 30 * 1024 * 1024;

/** 페이지당 이 글자 수에 못 미치면 텍스트 레이어가 없다고 본다. */
const MIN_CHARS_PER_PAGE = 50;

/**
 * 추출된 텍스트가 너무 적으면 스캔본으로 판단한다.
 *
 * 페이지 수로 나눠 보는 이유: 표지만 텍스트고 본문이 스캔인 문서가 흔하다.
 * 전체 길이만 보면 그런 문서를 놓친다.
 */
export function isLikelyScanned(text: string, pageCount: number): boolean {
  if (pageCount <= 0) return false;
  const density = text.replace(/\s/g, '').length / pageCount;
  return density < MIN_CHARS_PER_PAGE;
}

const EXTRACTION_PROMPT = `이 PDF의 모든 페이지에서 텍스트를 그대로 옮겨 적으세요.

지킬 것
- 본문에 있는 내용만 옮깁니다. 요약하거나 설명을 덧붙이지 마세요
- 표는 마크다운 표로 복원하세요. 셀을 순서대로 이어붙이면 열 머리글과 값의
  대응이 끊겨 나중에 엉뚱한 값을 답하게 됩니다
- 숫자·날짜·금액·기관명은 보이는 그대로 옮깁니다. 형식을 바꾸지 마세요
- 글자가 뭉개져 확실하지 않으면 추측하지 말고 [판독불가]로 표시하세요.
  공문서에서 잘못 읽은 숫자는 안 읽은 것보다 위험합니다
- 도장·서명·로고는 [직인], [서명]으로 표시하고 내용을 지어내지 마세요
- 페이지가 바뀌면 --- 로 구분하세요

머리말 없이 추출한 텍스트만 출력하세요.`;

export interface OcrResult {
  text: string;
  usage: ClaudeUsage;
  pageCount: number;
}

/**
 * 스캔 PDF를 Claude에 넘겨 텍스트를 받는다.
 *
 * 토큰을 소비하므로 호출하는 쪽에서 `usage`를 usage_logs에 기록해야 한다
 * (CLAUDE.md의 과금 규약). 페이지당 대략 1,500~3,000 토큰이 든다.
 */
export async function extractTextFromScannedPdf(
  fileBuffer: Buffer,
  pageCount: number
): Promise<OcrResult> {
  if (pageCount > MAX_OCR_PAGES) {
    throw new Error(
      `스캔 문서는 ${MAX_OCR_PAGES}쪽까지 처리할 수 있습니다. (이 문서 ${pageCount}쪽) ` +
        '파일을 나눠 올려주세요.'
    );
  }
  if (fileBuffer.length > MAX_OCR_BYTES) {
    throw new Error(
      `스캔 문서는 ${Math.floor(MAX_OCR_BYTES / 1024 / 1024)}MB까지 처리할 수 있습니다.`
    );
  }

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      // 페이지가 많으면 출력도 길어진다. 부족하면 뒷부분이 잘린다.
      max_tokens: 16000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: fileBuffer.toString('base64'),
              },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(
      `스캔 문서 판독에 실패했습니다: ${response.status} ${
        (detail as any)?.error?.message ?? ''
      }`.trim()
    );
  }

  const data = await response.json();
  const text = (data.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('스캔 문서에서 글자를 찾지 못했습니다. 스캔 품질을 확인해주세요.');
  }

  return {
    text,
    pageCount,
    usage: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      model: data.model ?? CLAUDE_MODEL,
    },
  };
}
