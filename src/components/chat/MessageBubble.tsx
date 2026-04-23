'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import SourceCitation from './SourceCitation';
import type { RetrievedChunk } from '@/lib/db';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  sources?: RetrievedChunk[];
  error?: string;
}

export default function MessageBubble({ role, content, sources, error }: MessageBubbleProps) {
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
        <div
          className={`px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-[#003087] text-white rounded-2xl rounded-tr-sm shadow-sm'
              : error
              ? 'bg-red-50 text-red-800 border border-red-200 rounded-2xl rounded-tl-sm'
              : 'bg-white text-slate-900 border border-slate-200 rounded-2xl rounded-tl-sm shadow-sm'
          }`}
        >
          {error ? (
            <div>
              <span className="font-semibold">오류: </span>{error}
            </div>
          ) : (
            <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : ''}`}>
              <ReactMarkdown
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
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* RAG 출처 */}
        {sources && sources.length > 0 && (
          <div className="mt-2 w-full">
            <SourceCitation sources={sources} />
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
