'use client';
import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { formatMailMoment, linkify, mailPreview, parseMail, recipientSummary, type MailParagraph } from '../mailText';
export type MailAttachment = { id: string; name: string; mime: string; size: number; supported: boolean };
export type MailMessage = {
  id: string; from: string; from_name: string; from_address: string; to: string; subject: string;
  snippet: string; body: string; date: string; unread: boolean; is_own?: boolean; has_attachment: boolean;
  attachments?: MailAttachment[];
};
const hue = (value: string) => [...value].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 360, 17);
const initials = (name: string) => name.replace(/["']/g, '').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
function Paragraphs({ paragraphs }: { paragraphs: MailParagraph[] }) {
  return <>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph.map((line, lineIndex) => <span key={lineIndex}>{lineIndex ? <br /> : null}{line.map((part, partIndex) => part.kind === 'link' ? <a key={partIndex} href={part.href} title={part.href}>{part.value}</a> : part.value)}</span>)}</p>)}</>;
}

function QuotedText({ text }: { text: string }) {
  return <>{text.split('\n').map((line, index) => <span key={index}>{index ? <br /> : null}{linkify(line).map((part, partIndex) => part.kind === 'link' ? <a key={partIndex} href={part.href} title={part.href}>{part.value}</a> : part.value)}</span>)}</>;
}

function MessageCard({ message, role, expanded, onToggle, onLink, attachments }: { message: MailMessage; role: 'root' | 'reply'; expanded: boolean; onToggle: () => void; onLink: (event: MouseEvent<HTMLDivElement>) => void; attachments: ReactNode }) {
  const [showQuote, setShowQuote] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const parsed = useMemo(() => parseMail(message.body || message.snippet || ''), [message.body, message.snippet]);
  const name = message.is_own ? 'Tú' : message.from_name || message.from_address || 'Remitente';
  const avatar = <span className="mail-avatar" style={{ '--avatar-hue': hue(message.from_address || name) } as CSSProperties} aria-hidden="true">{initials(message.from_name || message.from_address)}</span>;
  if (!expanded) {
    return <button type="button" className={`mail-msg collapsed ${role}${message.is_own ? ' own' : ''}${message.unread ? ' unread' : ''}`} onClick={onToggle} aria-expanded="false">
      {avatar}<strong>{name}</strong><span className="mail-msg-preview">{mailPreview(message.body || message.snippet || '') || 'Sin texto'}</span>{message.has_attachment ? <i className="mail-msg-clip" aria-label="Con adjuntos">▣</i> : null}<time>{formatMailMoment(message.date)}</time>
    </button>;
  }
  return <article className={`mail-msg ${role}${message.is_own ? ' own' : ''}`}>
    <header onClick={onToggle} role="button" tabIndex={0} aria-expanded="true" onKeyDown={(event) => { if (event.key === 'Enter') onToggle(); }}>
      {avatar}
      <div className="mail-msg-who">
        <strong>{name}{role === 'reply' ? <em>respuesta</em> : null}</strong>
        <span title={message.from}>{message.from_address}</span>
        {message.to ? <button type="button" className="mail-msg-to" onClick={(event) => { event.stopPropagation(); setShowRecipients((value) => !value); }} aria-expanded={showRecipients}>para {showRecipients ? message.to : recipientSummary(message.to)}</button> : null}
      </div>
      <time>{formatMailMoment(message.date)}</time>
    </header>
    <div className="mail-msg-body" onClick={onLink}>
      {parsed.paragraphs.length ? <Paragraphs paragraphs={parsed.paragraphs} /> : <p className="mail-msg-empty">Este mensaje no incluye texto.</p>}
      {parsed.signature.length ? <details className="mail-signature"><summary>Firma</summary><p>{parsed.signature.map((line, index) => <span key={index}>{index ? <br /> : null}{linkify(line).map((part, partIndex) => part.kind === 'link' ? <a key={partIndex} href={part.href}>{part.value}</a> : part.value)}</span>)}</p></details> : null}
      {parsed.quote ? <div className="mail-quote">
        <button type="button" onClick={() => setShowQuote((value) => !value)} aria-expanded={showQuote}><span aria-hidden="true">•••</span>{showQuote ? 'Ocultar el mensaje citado' : `Mostrar el mensaje citado · ${parsed.quote.header.slice(0, 90)}`}</button>
        {showQuote ? <blockquote><QuotedText text={parsed.quote.body} /></blockquote> : null}
      </div> : null}
    </div>
    {attachments}
  </article>;
}

export default function MailThreadView({ messages, onLink }: { messages: MailMessage[]; onLink: (event: MouseEvent<HTMLDivElement>) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(messages.filter((message, index) => index === messages.length - 1 || message.unread).map(message => message.id)));
  const [showMiddle, setShowMiddle] = useState(false);
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const hidden = !showMiddle && messages.length > 5 ? messages.slice(1, -3).filter(message => !open.has(message.id)) : [];
  const hiddenIds = new Set(hidden.map(message => message.id));
  return <div className="mail-conversation">{messages.map((message, index) => {
    if (hiddenIds.has(message.id)) return message.id === hidden[0]?.id ? <button type="button" className="mail-msg-more" key="more" onClick={() => setShowMiddle(true)}>{hidden.length} mensajes más</button> : null;
    return <MessageCard key={message.id || `${message.date}-${index}`} message={message} role={index === 0 ? 'root' : 'reply'} expanded={open.has(message.id)} onToggle={() => toggle(message.id)} onLink={onLink}
      attachments={message.has_attachment ? <p className="mail-attachments-missing">Incluye adjuntos · disponibles en la aplicación de correo</p> : null} />;
  })}</div>;
}
