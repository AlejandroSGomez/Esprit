import { get as unicodeEmoji } from 'node-emoji';
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent } from 'react';
/* Custom Mattermost emoji are authenticated local data URLs. */
/* eslint-disable @next/next/no-img-element */
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

type RichTextProps = {
  content: string;
  className?: string;
  customEmojis?: Record<string, string>;
  /**
   * Abre un enlace fuera de Esprit. Sin este callback los anclajes quedan
   * inertes dentro del WebView, así que cada superficie que muestre Markdown
   * con enlaces debe pasarlo. Mail y Mattermost ya interceptan en su propio
   * contenedor y no deben pasarlo también, o el enlace se abriría dos veces.
   */
  onOpenLink?: (url: string) => void;
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
      return unicodeEmoji(key) ?? token;
    })
  )).join('')
);

export default function RichText({ content, className = '', customEmojis = {}, onOpenLink }: RichTextProps) {
  const interceptLink = onOpenLink
    ? (event: ReactMouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest('a');
      const href = anchor?.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenLink(href);
    }
    : undefined;
  const prepared = replaceEmojiShortcodes(normalizeMathDelimiters(content), customEmojis);
  return (
    <div className={`rich-text${className ? ` ${className}` : ''}`} onClick={interceptLink}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        urlTransform={(url) => url.startsWith('esprit-emoji:') ? url : defaultUrlTransform(url)}
        components={{
          a: (props: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
            const { node, ...anchorProps } = props;
            void node;
            return <a {...anchorProps} target="_blank" rel="noreferrer noopener" />;
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
