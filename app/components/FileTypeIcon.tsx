'use client';

import type { ReactNode } from 'react';

type EntryKind = 'directory' | 'file' | 'symlink' | 'other';
type VisualType = 'archive' | 'code' | 'data' | 'document' | 'folder' | 'image' | 'link' | 'markdown' | 'pdf' | 'protected' | 'tex' | 'text';

const extensionOf = (name: string) => name.split('.').pop()?.toLocaleLowerCase('en') ?? '';

const visualType = (kind: EntryKind, name: string, sensitive: boolean): VisualType => {
  if (sensitive) return 'protected';
  if (kind === 'directory') return 'folder';
  if (kind === 'symlink') return 'link';
  if (kind !== 'file') return 'document';
  const extension = extensionOf(name);
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'tif', 'tiff', 'heic'].includes(extension)) return 'image';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (['tex', 'bib', 'sty', 'cls', 'bst'].includes(extension)) return 'tex';
  if (['py', 'jl', 'rs', 'js', 'jsx', 'ts', 'tsx', 'sh', 'zsh', 'bash', 'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'go', 'rb', 'r', 'm', 'swift', 'toml', 'yaml', 'yml'].includes(extension)) return 'code';
  if (['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'ods', 'parquet', 'h5', 'hdf5', 'ipynb'].includes(extension)) return 'data';
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].includes(extension)) return 'archive';
  if (['txt', 'log', 'out', 'dat', 'ini', 'cfg', 'conf'].includes(extension)) return 'text';
  return 'document';
};

const DocumentShell = ({ children }: { children: ReactNode }) => (
  <>
    <path className="file-icon-soft" d="M8.5 3.5h10l5 5v20h-15z" />
    <path d="M18.5 3.5v5h5M8.5 3.5h10l5 5v20h-15z" />
    {children}
  </>
);

export default function FileTypeIcon({ kind, name, sensitive = false }: { kind: EntryKind; name: string; sensitive?: boolean }) {
  const type = visualType(kind, name, sensitive);
  return (
    <span className={`file-type-icon type-${type}`} data-file-type={type} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
        {type === 'folder' ? <><path className="file-icon-soft" d="M3.5 8.5h9l2.5 3h13.5v15H3.5z" /><path d="M3.5 8.5h9l2.5 3h13.5v15H3.5zM3.5 12h25" /></> : null}
        {type === 'link' ? <><path d="M12.2 20.2 9.4 23a4 4 0 0 1-5.7-5.7l4.5-4.5a4 4 0 0 1 5.7 0" /><path d="m19.8 11.8 2.8-2.8a4 4 0 0 1 5.7 5.7l-4.5 4.5a4 4 0 0 1-5.7 0M11.5 20.5l9-9" /></> : null}
        {type === 'protected' ? <><path className="file-icon-soft" d="M7 14h18v14H7z" /><path d="M7 14h18v14H7zM11 14v-3a5 5 0 0 1 10 0v3M16 20v3" /><circle cx="16" cy="19.5" r="1.2" /></> : null}
        {type === 'pdf' ? <DocumentShell><path className="file-icon-accent" d="M11.5 22.5c4-5.5 6-8.5 6.7-6.5.8 2.3-3 6.9-5.6 6.6-2.4-.2-1.1-2.4 2.8-1.9 2.6.3 4.4 1.4 5.1 2.1" /></DocumentShell> : null}
        {type === 'image' ? <DocumentShell><circle cx="14" cy="14" r="1.8" /><path className="file-icon-accent" d="m11.5 24 4.2-5 2.7 2.7 2.2-3 2.9 3.6" /></DocumentShell> : null}
        {type === 'markdown' ? <DocumentShell><path d="M11.5 15.5v7M11.5 15.5l3 3 3-3v7M20.5 16v6M18.5 20l2 2 2-2" /></DocumentShell> : null}
        {type === 'tex' ? <DocumentShell><path className="file-icon-accent" d="M20.5 14h-7l5.5 4.2-5.5 4.3h7" /></DocumentShell> : null}
        {type === 'code' ? <DocumentShell><path className="file-icon-accent" d="m15 15-3.5 3.5L15 22M19 15l3.5 3.5L19 22" /></DocumentShell> : null}
        {type === 'data' ? <DocumentShell><path d="M11.5 14.5h9v9h-9zM11.5 18h9M15 14.5v9" /></DocumentShell> : null}
        {type === 'archive' ? <DocumentShell><path d="M15 10h3M15 13h3M15 16h3M15 19h3M15 22h3M14 25h5" /></DocumentShell> : null}
        {type === 'text' ? <DocumentShell><path d="M12 14h8M12 18h8M12 22h6" /></DocumentShell> : null}
        {type === 'document' ? <DocumentShell><path d="M12 14h8M12 18h8M12 22h5" /></DocumentShell> : null}
      </svg>
    </span>
  );
}
