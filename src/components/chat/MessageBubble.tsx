import React from 'react';
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
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] px-4 py-3 rounded-lg ${
          isUser
            ? 'bg-slate-900 text-white'
            : error
            ? 'bg-red-50 text-red-900 border border-red-200'
            : 'bg-slate-100 text-slate-900'
        }`}
      >
        {error ? (
          <div className="text-sm">
            <div className="font-medium mb-1">메시지 전송 실패</div>
            <div>{error}</div>
          </div>
        ) : (
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  // className에 language- 접두어가 있으면 펜스드 코드 블록
                  return match ? (
                    <SyntaxHighlighter
                      style={oneDark as Record<string, React.CSSProperties>}
                      language={match[1]}
                      PreTag="div"
                      className="rounded-md text-sm"
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  ) : (
                    <code
                      className="bg-slate-200 text-slate-800 px-1 py-0.5 rounded text-sm font-mono"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                p({ children }) {
                  return <p className="mb-2 last:mb-0">{children}</p>;
                },
                ul({ children }) {
                  return <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>;
                },
                ol({ children }) {
                  return <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>;
                },
                li({ children }) {
                  return <li className="leading-relaxed">{children}</li>;
                },
                h1({ children }) {
                  return <h1 className="text-lg font-semibold mb-2">{children}</h1>;
                },
                h2({ children }) {
                  return <h2 className="text-base font-semibold mb-2">{children}</h2>;
                },
                h3({ children }) {
                  return <h3 className="text-sm font-semibold mb-1">{children}</h3>;
                },
                blockquote({ children }) {
                  return (
                    <blockquote className="border-l-4 border-slate-300 pl-4 italic text-slate-700 my-2">
                      {children}
                    </blockquote>
                  );
                },
                strong({ children }) {
                  return <strong className="font-semibold">{children}</strong>;
                },
                em({ children }) {
                  return <em className="italic">{children}</em>;
                },
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
        {sources && sources.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-200">
            <SourceCitation sources={sources} />
          </div>
        )}
      </div>
    </div>
  );
}