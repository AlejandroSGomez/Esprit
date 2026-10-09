'use client';

import type { ReactNode } from 'react';

type EntryKind = 'directory' | 'file' | 'symlink' | 'other';
export type FileVisualType = 'archive' | 'code' | 'config' | 'data' | 'document' | 'folder' | 'image' | 'link' | 'markdown' | 'notebook' | 'pdf' | 'protected' | 'tex' | 'text' | 'web';

/** Order used when the explorer sorts by type: writing first, then code, data and media. */
export const FILE_TYPE_ORDER: FileVisualType[] = ['folder', 'pdf', 'tex', 'markdown', 'web', 'notebook', 'code', 'data', 'config', 'image', 'document', 'text', 'archive', 'link', 'protected'];

// Names without a dot have no extension; a leading dot marks a dotfile, not an extension.
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase('en') : '';
};

const CODE_NAMES = new Set(['makefile', 'dockerfile', 'justfile', 'cmakelists.txt']);
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'copying', 'authors', 'changelog']);

const EXTENSIONS: Array<[FileVisualType, string[]]> = [
  ['pdf', ['pdf']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'tif', 'tiff', 'heic', 'bmp', 'eps']],
  ['markdown', ['md', 'markdown', 'mdx', 'rmd', 'qmd']],
  ['tex', ['tex', 'ltx', 'bib', 'sty', 'cls', 'bst', 'bbl']],
  ['web', ['html', 'htm', 'css', 'xhtml']],
  ['notebook', ['ipynb']],
  ['code', ['py', 'jl', 'rs', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'sh', 'zsh', 'bash', 'c', 'h', 'cc', 'cpp', 'hpp', 'f', 'f90', 'f95', 'java', 'go', 'rb', 'r', 'm', 'swift', 'nb', 'wl', 'slurm', 'sbatch', 'lua', 'pyx']],
  ['config', ['toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'env', 'lock', 'xml', 'plist']],
  ['data', ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'ods', 'parquet', 'h5', 'hdf5', 'jld2', 'npy', 'npz', 'mat', 'pkl', 'pickle', 'feather', 'arrow', 'nc', 'dat', 'bin']],
  ['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']],
  ['text', ['txt', 'log', 'out', 'err', 'rst']],
  ['document', ['doc', 'docx', 'odt', 'rtf', 'pages', 'ppt', 'pptx', 'key', 'odp', 'numbers', 'epub', 'djvu']],
];
const EXTENSION_TYPES = new Map(EXTENSIONS.flatMap(([type, extensions]) => extensions.map((extension) => [extension, type] as const)));

export const fileVisualType = (kind: EntryKind, name: string, sensitive = false): FileVisualType => {
  if (sensitive) return 'protected';
  if (kind === 'directory') return 'folder';
  if (kind === 'symlink') return 'link';
  if (kind !== 'file') return 'document';
  const lower = name.toLocaleLowerCase('en');
  if (CODE_NAMES.has(lower)) return 'code';
  if (TEXT_NAMES.has(lower)) return 'text';
  if (lower.startsWith('.') && lower.indexOf('.', 1) < 0) return 'config';
  return EXTENSION_TYPES.get(extensionOf(name)) ?? 'document';
};

const LABEL_ALIASES: Record<string, string> = { markdown: 'MD', jpeg: 'JPG', tiff: 'TIF', hdf5: 'H5', ipynb: 'NB', jsonl: 'JSON', pickle: 'PKL', sbatch: 'SH', slurm: 'SH', bash: 'SH', zsh: 'SH', xhtml: 'HTML', f90: 'F90', f95: 'F95' };

/** Short badge text: the extension, or a type fallback for extensionless names. */
export const fileTypeLabel = (kind: EntryKind, name: string, sensitive = false): string => {
  const type = fileVisualType(kind, name, sensitive);
  if (type === 'folder' || type === 'link' || type === 'protected') return '';
  const extension = extensionOf(name);
  if (!extension) return type === 'code' ? 'MAKE' : type === 'config' ? 'CFG' : 'TXT';
  return (LABEL_ALIASES[extension] ?? extension.toLocaleUpperCase('en')).slice(0, 4);
};

// Small glyph drawn on the upper half of the page, above the extension badge.
const GLYPHS: Partial<Record<FileVisualType, ReactNode>> = {
  pdf: <path d="M12 8.5h8M12 11.5h8M12 14.5h5" />,
  image: <><circle cx="13.6" cy="9.4" r="1.4" /><path d="m11 15.2 3.3-3.4 2.1 2 2-2.4 3.1 3.8" /></>,
  markdown: <path d="M11.5 15V9.2l2.4 2.6 2.4-2.6V15M19.6 9.4V15M17.9 13.3l1.7 1.7 1.7-1.7" />,
  tex: <path d="M20.4 8.6h-7.2l4.1 3.2-4.1 3.2h7.2" />,
  web: <><circle cx="16" cy="11.8" r="3.7" /><path d="M12.3 11.8h7.4M16 8.1c-1.5 2.1-1.5 5.3 0 7.4M16 8.1c1.5 2.1 1.5 5.3 0 7.4" /></>,
  notebook: <path d="M11.6 8.4h8.8v2.9h-8.8zM11.6 13.1h8.8v2.4h-8.8z" />,
  code: <path d="m13.8 8.6-2.6 3 2.6 3M18.2 8.6l2.6 3-2.6 3" />,
  data: <path d="M11.5 8.5h9v6.8h-9zM11.5 11.9h9M16 8.5v6.8" />,
  config: <><circle cx="16" cy="11.8" r="2.1" /><path d="M16 7.9v1.5M16 14.2v1.5M12.1 11.8h1.5M18.4 11.8h1.5M13.3 9.1l1 1M17.7 13.5l1 1M18.7 9.1l-1 1M14.3 13.5l-1 1" /></>,
  archive: <path d="M16 5.8v1.6M16 8.9v1.6M16 12v1.6M14.7 7.4h1.3M16 10.5h1.3M14.7 13.6h1.3" />,
  text: <path d="M12 8.5h8M12 11.5h8M12 14.5h5.5" />,
  document: <path d="M12 8.5h8M12 11.5h6M12 14.5h8" />,
};

export default function FileTypeIcon({ kind, name, sensitive = false }: { kind: EntryKind; name: string; sensitive?: boolean }) {
  const type = fileVisualType(kind, name, sensitive);
  const label = fileTypeLabel(kind, name, sensitive);
  return (
    <span className={`file-type-icon type-${type}`} data-file-type={type} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6">
        {type === 'folder' ? <>
          <path className="file-icon-folder-back" d="M3.5 8.2a2 2 0 0 1 2-2h6.1l2.6 2.8h12.3a2 2 0 0 1 2 2v14.5a2 2 0 0 1-2 2h-21a2 2 0 0 1-2-2z" />
          <path className="file-icon-folder-front" d="M3.5 12.8a2 2 0 0 1 2-2h21a2 2 0 0 1 2 2v12.7a2 2 0 0 1-2 2h-21a2 2 0 0 1-2-2z" />
        </> : null}
        {type === 'link' ? <><path d="M12.2 20.2 9.4 23a4 4 0 0 1-5.7-5.7l4.5-4.5a4 4 0 0 1 5.7 0" /><path d="m19.8 11.8 2.8-2.8a4 4 0 0 1 5.7 5.7l-4.5 4.5a4 4 0 0 1-5.7 0M11.5 20.5l9-9" /></> : null}
        {type === 'protected' ? <><path className="file-icon-soft" d="M7 14h18v14H7z" /><path d="M7 14h18v14H7zM11 14v-3a5 5 0 0 1 10 0v3M16 20v3" /><circle cx="16" cy="19.5" r="1.2" /></> : null}
        {label ? <>
          <path className="file-icon-page" d="M8.5 3.5h10l5 5v20h-15z" />
          <path d="M18.5 3.5v5h5M8.5 3.5h10l5 5v20h-15z" />
          {GLYPHS[type]}
          <rect className="file-icon-badge" x="3.6" y="17.6" width="22.8" height="8.8" rx="2" />
          <text className={`file-icon-label${label.length > 3 ? ' long' : ''}`} x="15" y="24.1" textAnchor="middle">{label}</text>
        </> : null}
      </svg>
    </span>
  );
}
