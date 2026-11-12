import { emojiGlyph } from './emojiHelpers';
import { invoke } from '@tauri-apps/api/core';
import { memo, type ComponentPropsWithoutRef, type MouseEvent as ReactMouseEvent } from 'react';
import { createHeadingSlugger, resolveDocumentLink } from './documentLinks';
import { rehypeMattermostMentions } from './mattermostMentions';
import './RichText.css';
/* Custom Mattermost emoji are authenticated local data URLs. */
/* eslint-disable @next/next/no-img-element */
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export type RichTextProps = {
  content: string;
  className?: string;
  customEmojis?: Record<string, string>;
  /**
   * Handler for a surface with its own navigation. Otherwise public web links
   * use the validated native bridge. Section links stay in this document.
   */
  onOpenLink?: (url: string) => void;
  mentions?: { own?: string };
};

type MarkdownNode = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };

const rehypeHeadingAnchors = () => (tree: MarkdownNode) => {
  const nextSlug = createHeadingSlugger();
  const text = (node: MarkdownNode): string => node.value ?? node.children?.map(text).join('') ?? '';
  const visit = (node: MarkdownNode) => {
    if (/^h[1-6]$/.test(node.tagName ?? '')) node.properties = { ...node.properties, dataDocumentHeading: nextSlug(text(node)), tabIndex: -1 };
    node.children?.forEach(visit);
  };
  visit(tree);
};

const openWebLink = (href: string) => {
  const link = resolveDocumentLink(href, '');
  if (link.kind !== 'web') return;
  void invoke<string>('document_open_link', { url: link.url }).catch((reason) => console.warn(String(reason)));
};

type Fence = {
  character: '`' | '~';
  length: number;
};

const normalizeProseMath = (value: string) => value
  .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
  .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression}$`);

/**
 * remark-math understands dollar delimiters. Codex often writes LaTeX using
 * \(...\) and \[...\], so translate only prose segments and leave fenced
 * source code byte-for-byte untouched.
 */
const normalizeMathDelimiters = (content: string) => {
  let activeFence: Fence | null = null;
  let prose = '';
  let normalized = '';
  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];

  const flushProse = () => {
    normalized += normalizeProseMath(prose);
    prose = '';
  };

  lines.forEach((line) => {
    if (!line) return;
    const fenceRun = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];

    if (!activeFence && fenceRun) {
      flushProse();
      normalized += line;
      activeFence = {
        character: fenceRun[0] as Fence['character'],
        length: fenceRun.length,
      };
      return;
    }

    if (activeFence) {
      normalized += line;
      if (
        fenceRun
        && fenceRun[0] === activeFence.character
        && fenceRun.length >= activeFence.length
        && line.trim().slice(fenceRun.length).trim() === ''
      ) {
        activeFence = null;
      }
      return;
    }

    prose += line;
  });

  flushProse();
  return normalized;
};

/**
 * Resuelve los atajos `:nombre:`. Los emoji propios del equipo tienen
 * prioridad sobre los estándar, porque un mismo nombre puede existir en ambos
 * y el del equipo es el que la gente espera ver. Un nombre desconocido se deja
 * tal cual, que es mejor que perder el texto.
 *
 * Las divisiones impares del `split` son código literal (vallas y spans), y se
 * dejan intactas byte a byte.
 */
const replaceEmojiShortcodes = (content: string, emojis: Record<string, string>) => (
  content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part, index) => (
    index % 2 ? part : part.replace(/:([A-Za-z0-9_+-]{1,64}):/g, (token, name: string) => {
      const key = name.toLocaleLowerCase('en');
      if (emojis[key]) return `![${token}](esprit-emoji:${key})`;
      return emojiGlyph(key) ?? token;
    })
  )).join('')
);

function RichText({ content, className = '', customEmojis = {}, onOpenLink = openWebLink, mentions }: RichTextProps) {
  const interceptLink = (event: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href');
    if (href == null) return;
    event.preventDefault();
    event.stopPropagation();
    if (href.startsWith('#')) {
      let slug: string;
      try { slug = decodeURIComponent(href.slice(1)).toLocaleLowerCase('es'); } catch { return; }
      const heading = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-document-heading]')].find((node) => node.dataset.documentHeading === slug);
      heading?.scrollIntoView({ block: 'start' });
      heading?.focus({ preventScroll: true });
    } else if (href) onOpenLink(href);
  };
  const prepared = replaceEmojiShortcodes(normalizeMathDelimiters(content), customEmojis);
  return (
    <div className={`rich-text${className ? ` ${className}` : ''}`} onClick={interceptLink}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={mentions ? [rehypeHeadingAnchors, rehypeMattermostMentions(mentions.own ?? ''), rehypeKatex] : [rehypeHeadingAnchors, rehypeKatex]}
        skipHtml
        urlTransform={(url) => url.startsWith('esprit-emoji:') ? url : defaultUrlTransform(url)}
        components={{
          a: (props: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
            const { node, ...anchorProps } = props;
            void node;
            return <a {...anchorProps} target={anchorProps.href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener" />;
          },
          table: (props: ComponentPropsWithoutRef<'table'> & { node?: unknown }) => {
            const { node, ...tableProps } = props;
            void node;
            return <div className="rich-text-table-scroll" tabIndex={0} role="region" aria-label="Tabla"><table {...tableProps} /></div>;
          },
          img: (props: ComponentPropsWithoutRef<'img'> & { node?: unknown }) => {
            const { node, alt, src } = props;
            void node;
            if (typeof src === 'string' && src.startsWith('esprit-emoji:')) {
              const name = src.slice('esprit-emoji:'.length).toLocaleLowerCase('en');
              const source = customEmojis[name];
              if (source) return <img className="rich-custom-emoji" src={source} alt={alt ?? `:${name}:`} loading="lazy" />;
            }
            return <span className="rich-text-image-placeholder">{alt ? `[Imagen: ${alt}]` : '[Imagen externa omitida]'}</span>;
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

export default memo(RichText);
