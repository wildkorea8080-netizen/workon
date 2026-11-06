import type { CSSProperties } from 'react';

const paths: Record<string, string> = {
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  apps: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  assistant: 'M8 4h8l4 5v10H4V9z M9 12h.01 M15 12h.01 M9 16h6 M12 4V1',
  tasks: 'M9 4h6v4H9z M9 6H5v15h14V6h-4 M8 12h8 M8 16h6',
  files: 'M14 2H5v20h14V7z M14 2v6h5 M8 13h8 M8 17h6',
  template: 'M4 3h16v18H4z M4 8h16 M10 8v13',
  chat: 'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0Z M8 11h8',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  panel: 'M3 4h18v16H3z M9 4v16',
  stats: 'M4 20V11 M10 20V5 M16 20v-6 M21 20H3',
  admin: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  translate: 'M3 5h12 M9 2v3 M5 5c0 6 7 10 7 10 M13 5c-1 5-5 9-10 11 M14 21l4-10 4 10 M16 17h4',
  edit: 'm14 4 6 6 M3 21l5-1L21 7l-6-6L2 14z M3 21h18',
  meeting: 'M4 5h16v15H4z M8 2v6 M16 2v6 M4 10h16 M8 14h3 M8 17h7',
  faq: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};

export default function WorkspaceIcon({ name, className = '', style }: { name: string; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={`h-5 w-5 ${className}`} style={style}><path d={paths[name] ?? paths.files} /></svg>;
}

export function workflowIcon(id: string) {
  if (id.includes('translation')) return 'translate';
  if (id.includes('rewrite')) return 'edit';
  if (id.includes('meeting')) return 'meeting';
  if (id.includes('faq')) return 'faq';
  return 'files';
}
