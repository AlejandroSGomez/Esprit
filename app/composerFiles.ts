/**
 * Files pasted, dropped or chosen in a composer (Mattermost and Mail). They
 * stay in memory until the reviewed send; nothing is uploaded before it.
 */
export type ComposerFile = { id: string; name: string; size: number; mime: string; data_base64: string };
export type ComposerLimits = { files: number; perFile: number; total: number };

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tex: 'text/x-tex', py: 'text/x-python', jl: 'text/plain', json: 'application/json',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
};
export const extensionOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? '';
export const mimeFor = (name: string, reported = '') => /^[a-z]+\/[a-z0-9.+-]+$/i.test(reported) && reported !== 'application/octet-stream' ? reported.toLowerCase() : MIME[extensionOf(name)] ?? 'application/octet-stream';
export const isImageFile = (file: Pick<ComposerFile, 'name' | 'mime'>) => /^image\/(png|jpeg|gif|webp|tiff|svg\+xml)$/.test(file.mime);
export const isPdfFile = (file: Pick<ComposerFile, 'name' | 'mime'>) => file.mime === 'application/pdf' || extensionOf(file.name) === 'pdf';
export const isTextFile = (file: Pick<ComposerFile, 'name' | 'mime'>) => file.mime.startsWith('text/') || file.mime === 'application/json';
export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

const pad = (value: number) => String(value).padStart(2, '0');
const GENERIC = /^(image|imagen|untitled|sin título|pasted)(\s*\d+)?\.[a-z0-9]{1,8}$/i;
/** Clipboard images arrive as "image.png": give them a readable, dated name. */
export function pastedName(name: string, mime: string, index: number, now: Date) {
  const clean = name.replace(/[/\\\u0000-\u001f]/g, '').trim();
  if (clean && !GENERIC.test(clean)) return clean.slice(0, 180);
  const extension = extensionOf(clean) || Object.entries(MIME).find(([, value]) => value === mime)?.[0] || 'bin';
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `Pegado ${stamp}${index ? ` (${index + 1})` : ''}.${extension === 'jpeg' ? 'jpg' : extension}`;
}

/** Why these files cannot join the pending ones, or null when they fit. */
export function limitProblem(pending: Array<Pick<ComposerFile, 'size'>>, incoming: Array<{ size: number; name: string }>, limits: ComposerLimits) {
  if (!incoming.length) return null;
  const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;
  const summary = `Máximo ${limits.files} archivos, ${mb(limits.perFile)} por archivo y ${mb(limits.total)} en total.`;
  const empty = incoming.find((file) => !file.size);
  if (empty) return `${empty.name || 'El archivo'} está vacío o es una carpeta.`;
  if (pending.length + incoming.length > limits.files) return summary;
  const big = incoming.find((file) => file.size > limits.perFile);
  if (big) return `${big.name} pesa ${formatBytes(big.size)}. ${summary}`;
  if ([...pending, ...incoming].reduce((total, file) => total + file.size, 0) > limits.total) return summary;
  return null;
}

/** True when the clipboard's text only names the copied files (Finder, a copied image URL). */
export function textOnlyNamesFiles(text: string, names: string[]) {
  const value = text.trim();
  if (!value) return true;
  if (/^(https?|file):\/\/\S+$/i.test(value)) return true;
  const lines = value.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => names.includes(line));
}

/** Whether a paste may carry files, decided synchronously so the default text paste still works. */
export function pasteMayCarryFiles(types: readonly string[], fileCount: number, uriList: string) {
  return fileCount > 0 || types.includes('Files') || /^file:/im.test(uriList);
}

export const insertText = (value: string, start: number, end: number, text: string) => ({ value: value.slice(0, start) + text + value.slice(end), cursor: start + text.length });

let counter = 0;
export const composerFileId = () => `f${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export function readBrowserFile(file: File, name: string): Promise<ComposerFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`No se pudo leer ${name}.`));
    reader.onload = () => resolve({ id: composerFileId(), name, size: file.size, mime: mimeFor(name, file.type), data_base64: String(reader.result).split(',')[1] ?? '' });
    reader.readAsDataURL(file);
  });
}
