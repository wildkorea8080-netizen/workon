'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
// GFM 표 지원. 없으면 표가 문단으로 취급돼 파이프 문자가 그대로 보이고,
// HTML이 줄바꿈을 공백으로 접어 한 줄로 뭉개진다. HWP 표를 마크다운으로
// 복원해 인덱싱하므로(hwp.ts) RAG로 가져온 표도 같은 증상을 겪는다.
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import SourceCitation from './SourceCitation';
import type { RetrievedChunk } from '@/lib/db';
import { formatFileSize } from '@/lib/file-size';
import { NUMBER_CHECK_NOTE } from '@/lib/assistant/number-check';

interface ToolLink {
  title: string;
  url: string;
}

interface GeneratedFile {
  id: string;
  file_name: string;
  size_bytes: number;
}

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  /** 사용자가 첨부한 이미지 미리보기 (blob URL) */
  imagePreviews?: string[];
  /** 사용자가 이 질문에 붙인 파일 - 이름 칩으로만 보인다 */
  attachments?: { id: string; file_name: string }[];
  sources?: RetrievedChunk[];
  /** 외부 도구(국가법령정보 등)가 돌려준 출처 링크 */
  links?: ToolLink[];
  /** 비서가 만든 파일 — 내려받기 카드 */
  files?: GeneratedFile[];
  /** 숫자 확인 — 원본·계산 결과에서 확인되지 않은 숫자(답변 글은 그대로 둔다) */
  numberCheck?: string[];
  /** 참고 문서 없이 일반 답변으로 받은 응답 — 말풍선 위에 작게 알린다 */
  documentsSkipped?: boolean;
  /** 참고 문서를 불러오지 못해 거절된 안내 — 오류가 아니라 안내로 그리고 단추를 붙인다 */
  refusal?: boolean;
  /** 응답을 기다리는 동안 단추를 막는다 */
  refusalDisabled?: boolean;
  onRetry?: () => void;
  onSkipDocuments?: () => void;
  error?: string;
}

export default function MessageBubble({
  role, content, imagePreviews, attachments, sources, links, files, numberCheck,
  documentsSkipped, refusal, refusalDisabled, onRetry, onSkipDocuments, error,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = role === 'user';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className={`flex gap-3 mb-5 group ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* 아바타 */}
      {!isUser && (
        <div className="w-7 h-7 rounded-lg bg-[#1C2B4A] flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg className="w-3.5 h-3.5 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
      )}

      <div className={`flex flex-col max-w-[72%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* 참고 문서 없이 답함 — 근거 자료 없이 일반 지식으로 답한 응답임을 알린다 */}
        {!isUser && !error && documentsSkipped && (
          <span className="mb-1 text-[11px] text-slate-500">참고 문서 없이 답함</span>
        )}
        <div
          className={`px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-[#003087] text-white rounded-2xl rounded-tr-sm shadow-sm'
              : refusal
              ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-2xl rounded-tl-sm'
              : error
              ? 'bg-red-50 text-red-800 border border-red-200 rounded-2xl rounded-tl-sm'
              : 'bg-white text-slate-900 border border-slate-200 rounded-2xl rounded-tl-sm shadow-sm'
          }`}
        >
          {imagePreviews && imagePreviews.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {imagePreviews.map((src, index) => (
                // next/image는 blob URL을 다루지 않는다
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={src}
                  src={src}
                  alt={`첨부 이미지 ${index + 1}`}
                  className="w-20 h-20 object-cover rounded-lg border border-white/30"
                />
              ))}
            </div>
          )}
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  title={a.file_name}
                  className="inline-flex items-center gap-1 max-w-full bg-white/15 border border-white/25 rounded-lg px-2 py-1 text-xs"
                >
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <span className="truncate">{a.file_name}</span>
                </span>
              ))}
            </div>
          )}
          {refusal ? (
            <div>
              <p>{error}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={refusalDisabled}
                  className="text-xs font-semibold text-white bg-[#003087] hover:bg-[#002070] disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 transition-colors"
                >
                  다시 묻기
                </button>
                <button
                  type="button"
                  onClick={onSkipDocuments}
                  disabled={refusalDisabled}
                  className="text-xs font-semibold text-[#003087] bg-white border border-[#003087]/30 hover:bg-[#003087]/5 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 transition-colors"
                >
                  문서 없이 일반 답변 받기
                </button>
              </div>
            </div>
          ) : error ? (
            <div>
              <span className="font-semibold">오류: </span>{error}
            </div>
          ) : (
            <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : ''}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children }) {
                    const match = /language-(\w+)/.exec(className || '');
                    return match ? (
                      <SyntaxHighlighter
                        style={oneDark as Record<string, React.CSSProperties>}
                        language={match[1]}
                        PreTag="div"
                        className="rounded-lg text-xs my-2"
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    ) : (
                      <code className={`px-1.5 py-0.5 rounded text-xs font-mono ${isUser ? 'bg-white/20' : 'bg-slate-200 text-slate-800'}`}>
                        {children}
                      </code>
                    );
                  },
                  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  h1: ({ children }) => <h1 className="text-base font-bold mb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold mb-1.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-slate-300 pl-3 italic text-slate-600 my-2">{children}</blockquote>
                  ),
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,

                  // 표 — 공공기관 문서의 핵심이라 좁은 화면에서도 읽혀야 한다.
                  // 넘칠 때 페이지 전체가 가로로 밀리지 않도록 표만 스크롤시킨다.
                  table: ({ children }) => (
                    <div className="my-3 overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full text-xs border-collapse">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
                  th: ({ children }) => (
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-slate-200 whitespace-nowrap">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="px-3 py-2 align-top border-b border-slate-100 text-slate-700">{children}</td>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer"
                      className="text-[#003087] underline underline-offset-2 hover:text-[#002070]">
                      {children}
                    </a>
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* 숫자 확인 — '틀렸다'가 아니라 '확인되지 않았다'. 직원이 원본과 맞춰 볼 숫자를 알려 준다 */}
        {!isUser && !error && numberCheck && numberCheck.length > 0 && (
          <div
            role="note"
            className="mt-2 w-full flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs leading-relaxed"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="break-words">{NUMBER_CHECK_NOTE(numberCheck)}</span>
          </div>
        )}

        {/* RAG 출처 */}
        {sources && sources.length > 0 && (
          <div className="mt-2 w-full">
            <SourceCitation sources={sources} />
          </div>
        )}

        {/* 비서가 만든 파일 — 주인만 내려받는다(/api/files가 확인) */}
        {files && files.length > 0 && (
          <div className="mt-2 w-full space-y-1.5">
            {files.map((file) => (
              <a
                key={file.id}
                href={`/api/files/${file.id}`}
                className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 hover:bg-slate-50 transition-colors"
              >
                <span className="w-9 h-9 rounded-lg bg-[#003087]/10 text-[#003087] text-[11px] font-bold flex items-center justify-center flex-shrink-0">
                  {file.file_name.toLowerCase().endsWith('.xlsx')
                    ? 'XLS'
                    : file.file_name.toLowerCase().endsWith('.docx')
                      ? 'DOC'
                      : 'HWP'}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-800 truncate">{file.file_name}</span>
                  <span className="block text-[11px] text-slate-400">{formatFileSize(file.size_bytes)} · 내려받기</span>
                </span>
              </a>
            ))}
          </div>
        )}

        {/* 외부 도구 출처 — 공공 데이터는 원문 링크를 함께 제시한다 */}
        {links && links.length > 0 && (
          <div className="mt-2 w-full space-y-2">
            <div className="flex items-center space-x-2">
              <div className="w-1 h-4 bg-[#003087] rounded-full" />
              <div className="text-xs font-medium text-slate-600">출처</div>
              <div className="text-xs text-slate-500">({links.length}개)</div>
            </div>
            <div className="space-y-1.5">
              {links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-md p-2.5 hover:bg-slate-100 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-[#003087] flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span className="text-xs text-slate-700 break-all">{link.title}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* 복사 버튼 (AI 응답만) */}
        {!isUser && !error && content && (
          <button
            onClick={handleCopy}
            className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-500">복사됨</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                복사
              </>
            )}
          </button>
        )}
      </div>

      {/* 사용자 아바타 */}
      {isUser && (
        <div className="w-7 h-7 rounded-lg bg-[#003087] flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      )}
    </div>
  );
}
