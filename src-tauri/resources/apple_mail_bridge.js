// Puente JXA de Esprit sobre Mail.app.
//
// mail_bridge.py lo ejecuta con `osascript -l JavaScript` y le pasa por stdin
// un sobre JSON {accounts: [{key, label, mail_account, address}], request}.
// Las cuentas salen de la configuración de Esprit; este script no guarda
// credenciales ni cachés y solo lee Entrada y Enviados de esas cuentas.
ObjC.import("Foundation");

const Mail = Application("Mail");
const MAX_BODY_CHARS = 80000;
const MAX_SNIPPET_CHARS = 600;
const DAY_MS = 86400000;
const LIMITS = {
  windowDays: 30,
  inbox: 60,
  sent: 30,
  snippetsPerAccount: 40,
  snippetBudgetMs: 8000,
  thread: 25,
  threadWindowDays: 365,
  threadBudgetMs: 15000,
};
// Solo se usan si Mail no expone el buzón unificado («Entrada», «Enviados»).
const INBOX_NAMES = ["inbox", "bandeja de entrada", "entrada", "recibidos"];
const SENT_NAMES = [
  "sent", "sent items", "sent messages", "sent mail", "enviados",
  "elementos enviados", "mensajes enviados", "correo enviado",
];
const SUBJECT_PREFIX = /^\s*(?:(?:re|fw|fwd|rv|aw)\s*:\s*)+/i;
var ACCOUNTS = [];

function safe(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function text(value) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function lower(value) {
  return text(value).trim().toLowerCase();
}

function errorMessage(error) {
  return error && error.message ? error.message : text(error);
}

function readStandardInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (!data || Number(data.length) === 0) return {};
  const source = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  return source ? JSON.parse(source) : {};
}

function configure(envelope) {
  const accounts = envelope && Array.isArray(envelope.accounts) ? envelope.accounts : null;
  if (!accounts || accounts.length === 0 || accounts.length > 4) {
    throw new Error("La lista de cuentas de Mail no es válida");
  }
  ACCOUNTS = accounts.map((value, index) => {
    const key = text(value && value.key);
    const label = text(value && value.label);
    const mailAccount = text(value && value.mail_account);
    const address = text(value && value.address).trim();
    if (key !== `m${index}` || !label || label.length > 32 || !mailAccount || mailAccount.length > 80
        || !/^[^@\s]+@[^@\s]+$/.test(address)) {
      throw new Error("La lista de cuentas de Mail no es válida");
    }
    return { key, label, mailAccount, address };
  });
  return ACCOUNTS;
}

// One Apple Event for a whole element collection. Any failure or misaligned
// answer returns null so callers fall back to per-message reads.
function bulk(read, expectedLength) {
  try {
    const value = read();
    if (!Array.isArray(value)) return null;
    if (expectedLength !== undefined && value.length !== expectedLength) return null;
    return value;
  } catch {
    return null;
  }
}

function boundedItems(collection, limit) {
  const count = Math.min(Number(safe(() => collection.length, 0)) || 0, limit);
  const items = [];
  for (let index = 0; index < count; index += 1) items.push(collection[index]);
  return items;
}

function timeOf(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : 0;
}

function isoDate(value) {
  return timeOf(value) ? value.toISOString() : "";
}

function collapse(value) {
  return text(value).replace(/\s+/g, " ").trim();
}

function splitSender(sender) {
  const source = text(sender).trim();
  const match = source.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
  const address = match ? match[1] : "";
  const name = address ? source.replace(match[0], "").replace(/[<>"]/g, "").trim() : source;
  return { address, name: name || address || source || "Remitente" };
}

function addressesIn(value) {
  return (text(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(lower);
}

function baseSubject(value) {
  let subject = collapse(value);
  for (let index = 0; index < 12; index += 1) {
    const reduced = subject.replace(SUBJECT_PREFIX, "").trim();
    if (reduced === subject) break;
    subject = reduced;
  }
  return subject;
}

function canonicalSubject(value) {
  return baseSubject(value).normalize("NFKC").toLowerCase();
}

// --- Cuentas y buzones ---------------------------------------------------

function findAccount(config) {
  const accounts = safe(() => Mail.accounts(), []);
  if (!Array.isArray(accounts)) return null;
  const names = bulk(() => Mail.accounts.name(), accounts.length);
  for (let index = 0; index < accounts.length; index += 1) {
    const name = names ? names[index] : safe(() => accounts[index].name(), "");
    if (text(name) === config.mailAccount) return accounts[index];
  }
  return null;
}

function requireAccount(config) {
  const account = findAccount(config);
  if (!account) throw new Error(`No se encontró la cuenta «${config.mailAccount}» en Mail`);
  return account;
}

function accountAddresses(account) {
  const values = safe(() => account.emailAddresses(), []);
  return Array.isArray(values) ? values.map(lower).filter(Boolean) : [];
}

function ownAddresses(account, config) {
  return new Set([lower(config.address), ...accountAddresses(account)]);
}

// Mail's unified «Entrada» and «Enviados» contain one mailbox per account,
// whatever the localized or server-side name of that folder is.
function unifiedMailbox(container, config) {
  const children = safe(() => container.mailboxes(), []);
  if (!Array.isArray(children)) return null;
  const owners = bulk(() => container.mailboxes.account.name(), children.length);
  for (let index = 0; index < children.length; index += 1) {
    const owner = owners ? owners[index] : safe(() => children[index].account().name(), "");
    if (text(owner) === config.mailAccount) return children[index];
  }
  return null;
}

function mailboxByName(account, acceptedNames) {
  const accepted = new Set(acceptedNames);
  const queue = boundedItems(safe(() => account.mailboxes, []), 60).map((mailbox) => ({ mailbox, depth: 0 }));
  let inspected = 0;
  while (queue.length && inspected < 80) {
    const { mailbox, depth } = queue.shift();
    inspected += 1;
    if (accepted.has(lower(safe(() => mailbox.name(), "")))) return mailbox;
    if (depth < 1) {
      boundedItems(safe(() => mailbox.mailboxes, []), 20).forEach((child) => queue.push({ mailbox: child, depth: depth + 1 }));
    }
  }
  return null;
}

function findInbox(account, config) {
  return unifiedMailbox(safe(() => Mail.inbox, null), config) || mailboxByName(account, INBOX_NAMES);
}

function findSent(account, config) {
  return unifiedMailbox(safe(() => Mail.sentMailbox, null), config) || mailboxByName(account, SENT_NAMES);
}

function accountFolders(account, config) {
  return [
    { folder: "inbox", mailbox: findInbox(account, config), dateProperty: "dateReceived" },
    { folder: "sent", mailbox: findSent(account, config), dateProperty: "dateSent" },
  ].filter((value) => value.mailbox);
}

function messageRef(mailbox, numericId) {
  const direct = safe(() => mailbox.messages.byId(numericId), null);
  if (direct) return direct;
  const found = boundedItems(safe(() => mailbox.messages.whose({ id: numericId }), []), 2);
  return found.length === 1 ? found[0] : null;
}

// --- Lectura -------------------------------------------------------------

// Reads the headers of a filtered message collection with one Apple Event per
// property. Missing values are completed per message only for selected rows.
function headerRows(mailbox, collection, dateProperty, limit, withReadStatus) {
  const ids = bulk(() => collection.id());
  if (!ids) throw new Error("Mail no devolvió la lista de mensajes");
  const count = ids.length;
  const dates = bulk(() => collection[dateProperty](), count);
  const subjects = bulk(() => collection.subject(), count);
  const senders = bulk(() => collection.sender(), count);
  const messageIds = bulk(() => collection.messageId(), count);
  const readFlags = withReadStatus ? bulk(() => collection.readStatus(), count) : null;
  const recipients = bulk(() => collection.toRecipients.address(), count);
  let indices = [];
  for (let index = 0; index < count; index += 1) {
    if (Number.isSafeInteger(Number(ids[index])) && Number(ids[index]) > 0) indices.push(index);
  }
  let dateValues = dates;
  if (!dateValues) {
    // Rare fallback: date bulk read failed. Bound the per-message reads.
    indices = indices.slice(0, 300);
    dateValues = [];
    indices.forEach((index) => {
      const ref = messageRef(mailbox, Number(ids[index]));
      dateValues[index] = ref ? safe(() => ref[dateProperty](), null) : null;
    });
  }
  indices.sort((left, right) => timeOf(dateValues[right]) - timeOf(dateValues[left]));
  const selected = indices.slice(0, limit);
  const rows = selected.map((index) => {
    const numericId = Number(ids[index]);
    let ref = null;
    const lazy = () => (ref = ref || messageRef(mailbox, numericId));
    const field = (values, read, fallback) => values ? values[index] : safe(() => read(lazy()), fallback);
    const rawRecipients = field(recipients, (message) => message.toRecipients.address(), []);
    return {
      numericId,
      date: dateValues[index] || null,
      subject: text(field(subjects, (message) => message.subject(), "")),
      sender: text(field(senders, (message) => message.sender(), "")),
      messageId: text(field(messageIds, (message) => message.messageId(), "")),
      read: withReadStatus ? Boolean(field(readFlags, (message) => message.readStatus(), true)) : true,
      to: Array.isArray(rawRecipients) ? rawRecipients.map(text).filter(Boolean) : [],
    };
  });
  return { total: count, truncated: indices.length > limit, rows };
}

function recentRows(mailbox, dateProperty, cutoff, limit, withReadStatus) {
  const filtered = mailbox.messages.whose({ [dateProperty]: { _greaterThan: cutoff } });
  return headerRows(mailbox, filtered, dateProperty, limit, withReadStatus);
}

function messageRecord(config, folder, row, own) {
  const parsed = splitSender(row.sender);
  const isOwn = folder === "sent" || own.has(lower(parsed.address));
  const unread = folder === "sent" ? false : !row.read;
  const id = `apple_${config.key}_${row.numericId}`;
  return {
    id,
    thread_id: id,
    provider: "apple_mail",
    internet_message_id: row.messageId,
    from: row.sender,
    from_name: parsed.name,
    from_address: parsed.address,
    to: row.to.join(", "),
    mailbox: config.key,
    mailbox_label: config.label,
    mailbox_address: config.address,
    subject: row.subject || "(Sin asunto)",
    snippet: "",
    body: "",
    labels: folder === "sent" ? ["SENT"] : unread ? ["UNREAD"] : [],
    unread,
    folder,
    is_own: isOwn,
    has_attachment: false,
    date: isoDate(row.date),
    display_url: "",
  };
}

// Snippets need one content read per message: newest first across accounts,
// under a global time budget so large or remote mailboxes stay responsive.
function readSnippets(pending) {
  pending.sort((left, right) => timeOf(right.date) - timeOf(left.date));
  const deadline = Date.now() + LIMITS.snippetBudgetMs;
  const perAccount = {};
  let skipped = 0;
  for (const item of pending) {
    const used = perAccount[item.record.mailbox] || 0;
    if (used >= LIMITS.snippetsPerAccount || Date.now() >= deadline) {
      skipped += 1;
      continue;
    }
    perAccount[item.record.mailbox] = used + 1;
    const ref = messageRef(item.mailbox, item.numericId);
    const content = ref ? text(safe(() => ref.content(), "")) : "";
    item.record.snippet = collapse(content.slice(0, MAX_SNIPPET_CHARS * 4)).slice(0, MAX_SNIPPET_CHARS);
  }
  return skipped;
}

function overview() {
  const cutoff = new Date(Date.now() - LIMITS.windowDays * DAY_MS);
  const accounts = [];
  const sentAccounts = [];
  const emails = [];
  const warnings = [];
  const pending = [];
  let inboxTruncated = false;
  let sentTruncated = false;
  let sentInWindow = 0;
  for (const config of ACCOUNTS) {
    const status = {
      key: config.key, label: config.label, address: config.address, provider: "apple_mail",
      connected: false, unread_count: 0, error: "",
    };
    const sentStatus = { key: config.key, connected: false, error: "", returned_count: 0 };
    accounts.push(status);
    sentAccounts.push(sentStatus);
    let account;
    let own;
    try {
      account = requireAccount(config);
      own = ownAddresses(account, config);
      if (!accountAddresses(account).includes(lower(config.address))) {
        warnings.push(`${config.label}: la dirección configurada no figura entre las de la cuenta de Mail`);
      }
      const inbox = findInbox(account, config);
      if (!inbox) throw new Error(`No se encontró la bandeja de entrada de «${config.mailAccount}»`);
      const result = recentRows(inbox, "dateReceived", cutoff, LIMITS.inbox, true);
      inboxTruncated = inboxTruncated || result.truncated;
      for (const row of result.rows) {
        const record = messageRecord(config, "inbox", row, own);
        emails.push(record);
        pending.push({ record, mailbox: inbox, numericId: row.numericId, date: row.date });
      }
      status.connected = true;
      status.unread_count = Number(safe(() => inbox.unreadCount(), 0)) || 0;
    } catch (error) {
      status.error = errorMessage(error) || "Mail no pudo leer la cuenta";
      warnings.push(`${config.label}: ${status.error}`);
    }
    if (!account) {
      sentStatus.error = status.error;
      continue;
    }
    try {
      const sent = findSent(account, config);
      if (!sent) throw new Error(`No se encontró la carpeta de enviados de «${config.mailAccount}»`);
      const result = recentRows(sent, "dateSent", cutoff, LIMITS.sent, false);
      sentTruncated = sentTruncated || result.truncated;
      sentInWindow += result.total;
      for (const row of result.rows) {
        const record = messageRecord(config, "sent", row, own);
        emails.push(record);
        pending.push({ record, mailbox: sent, numericId: row.numericId, date: row.date });
      }
      sentStatus.connected = true;
      sentStatus.returned_count = result.rows.length;
    } catch (error) {
      sentStatus.error = errorMessage(error) || "Mail no pudo leer Enviados";
      warnings.push(`${config.label} · Enviados: ${sentStatus.error}`);
    }
  }
  const snippetsSkipped = readSnippets(pending);
  emails.sort((left, right) => Date.parse(right.date || "0") - Date.parse(left.date || "0"));
  return {
    connected: accounts.some((value) => value.connected),
    accounts,
    emails,
    unread_count: accounts.reduce((total, value) => total + value.unread_count, 0),
    warnings,
    sent_accounts: sentAccounts,
    sent_source_count: sentInWindow,
    sent_truncated: sentTruncated,
    inbox_truncated: inboxTruncated,
    snippets_skipped: snippetsSkipped,
    window_days: LIMITS.windowDays,
  };
}

function parseIdentifier(identifier) {
  const match = /^apple_(m[0-3])_([1-9][0-9]{0,15})$/.exec(text(identifier));
  if (!match) throw new Error("El mensaje de Mail solicitado no es válido");
  const config = ACCOUNTS.find((value) => value.key === match[1]);
  if (!config) throw new Error("La cuenta de Mail del mensaje no está configurada");
  const numericId = Number(match[2]);
  if (!Number.isSafeInteger(numericId)) throw new Error("El identificador de Mail es demasiado grande");
  return { config, numericId };
}

// Native equality filter on the account's own Inbox and Sent mailboxes only.
function locateMessage(config, numericId) {
  const account = requireAccount(config);
  const folders = accountFolders(account, config);
  for (const entry of folders) {
    const found = boundedItems(entry.mailbox.messages.whose({ id: numericId }), 2);
    if (found.length === 1) return { account, folders, entry, message: found[0] };
  }
  throw new Error("El mensaje ya no está en Entrada ni en Enviados de esta cuenta de Mail");
}

function fullRecord(config, folder, message, own, withBody) {
  const date = folder === "sent"
    ? safe(() => message.dateSent(), null)
    : safe(() => message.dateReceived(), null) || safe(() => message.dateSent(), null);
  const recipients = safe(() => message.toRecipients.address(), null)
    || safe(() => message.toRecipients().map((recipient) => recipient.address()), []);
  const row = {
    numericId: Number(safe(() => message.id(), 0)),
    date,
    subject: text(safe(() => message.subject(), "")),
    sender: text(safe(() => message.sender(), "")),
    messageId: text(safe(() => message.messageId(), "")),
    read: Boolean(safe(() => message.readStatus(), true)),
    to: Array.isArray(recipients) ? recipients.map(text).filter(Boolean) : [],
  };
  const record = messageRecord(config, folder, row, own);
  if (withBody) {
    const content = text(safe(() => message.content(), "")).slice(0, MAX_BODY_CHARS);
    // Counting attachments never opens or saves their contents.
    const attachments = Number(safe(() => message.mailAttachments.length, 0));
    record.body = content;
    record.snippet = collapse(content.slice(0, MAX_SNIPPET_CHARS * 4)).slice(0, MAX_SNIPPET_CHARS);
    record.has_attachment = Number.isFinite(attachments) && attachments > 0;
  }
  return record;
}

function externalParticipants(record, own) {
  return new Set([...addressesIn(record.from), ...addressesIn(record.from_address), ...addressesIn(record.to)]
    .filter((address) => !own.has(address)));
}

// Rebuilds one conversation from the same account's Inbox and Sent: same
// canonical subject and at least one shared external participant. Bounded
// by count, age and time; never reads other accounts.
function readThread(identifier) {
  const parsed = parseIdentifier(identifier);
  const located = locateMessage(parsed.config, parsed.numericId);
  const own = ownAddresses(located.account, parsed.config);
  const original = fullRecord(parsed.config, located.entry.folder, located.message, own, true);
  const canonical = canonicalSubject(original.subject);
  const needle = baseSubject(original.subject).slice(0, 120);
  const participants = externalParticipants(original, own);
  const related = [];
  const contributing = new Set([located.entry.folder]);
  let truncated = false;
  if (canonical.length >= 3 && needle && participants.size) {
    const cutoff = new Date(Date.now() - LIMITS.threadWindowDays * DAY_MS);
    const seen = new Set([parsed.numericId]);
    for (const entry of located.folders) {
      try {
        const filtered = entry.mailbox.messages.whose({
          _and: [{ subject: { _contains: needle } }, { [entry.dateProperty]: { _greaterThan: cutoff } }],
        });
        const result = headerRows(entry.mailbox, filtered, entry.dateProperty, 200, entry.folder === "inbox");
        truncated = truncated || result.truncated;
        for (const row of result.rows) {
          if (seen.has(row.numericId) || canonicalSubject(row.subject) !== canonical) continue;
          const record = messageRecord(parsed.config, entry.folder, row, own);
          if (![...externalParticipants(record, own)].some((address) => participants.has(address))) continue;
          seen.add(row.numericId);
          related.push({ entry, row });
        }
      } catch {
        truncated = true;
      }
    }
    related.sort((left, right) => timeOf(right.row.date) - timeOf(left.row.date));
    if (related.length > LIMITS.thread - 1) {
      truncated = true;
      related.length = LIMITS.thread - 1;
    }
  }
  const deadline = Date.now() + LIMITS.threadBudgetMs;
  const messages = related.map(({ entry, row }) => {
    contributing.add(entry.folder);
    const ref = Date.now() < deadline ? messageRef(entry.mailbox, row.numericId) : null;
    if (!ref) {
      truncated = true;
      return messageRecord(parsed.config, entry.folder, row, own);
    }
    return fullRecord(parsed.config, entry.folder, ref, own, true);
  });
  messages.push(original);
  messages.sort((left, right) => Date.parse(left.date || "0") - Date.parse(right.date || "0"));
  return {
    thread_id: identifier,
    messages,
    message_count: messages.length,
    truncated,
    reconstructed: messages.length > 1,
    source_thread_count: contributing.size,
  };
}

// --- Envío ---------------------------------------------------------------

function outgoingRecipients(outgoing, kind) {
  return boundedItems(outgoing[kind], 101);
}

function applyReviewedMessage(outgoing, config, request, addresses) {
  // Set sender before content: Mail can insert that identity's signature when
  // sender changes. Replace auto-quotation/signature with exactly the preview.
  outgoing.sender = config.address;
  outgoing.subject = text(request.subject);
  outgoing.content = text(request.body);
  for (const kind of ["toRecipients", "ccRecipients", "bccRecipients"]) {
    const recipients = outgoingRecipients(outgoing, kind);
    if (recipients.length > 100) throw new Error("Mail añadió demasiados destinatarios; no se envió nada");
    // These are recipients of the newly created outgoing draft, never inbox
    // messages. Remove in reverse to avoid live collection index shifts.
    recipients.reverse().forEach((recipient) => Mail.delete(recipient));
  }
  addresses.forEach((address) => outgoing.toRecipients.push(Mail.ToRecipient({ address })));

  const actual = outgoingRecipients(outgoing, "toRecipients").map((recipient) => lower(recipient.address())).sort();
  const expected = addresses.map(lower).sort();
  const content = (value) => text(value).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (JSON.stringify(actual) !== JSON.stringify(expected)
      || outgoingRecipients(outgoing, "ccRecipients").length
      || outgoingRecipients(outgoing, "bccRecipients").length
      || lower(splitSender(outgoing.sender()).address) !== lower(config.address)
      || text(outgoing.subject()) !== text(request.subject)
      || content(outgoing.content()) !== content(request.body)) {
    throw new Error("Mail cambió destinatario, identidad, asunto o contenido. No se envió nada; revisa el borrador en Mail");
  }
}

function sendMessage(request) {
  const config = ACCOUNTS.find((value) => value.key === text(request && request.from_account));
  if (!config) throw new Error("La cuenta de envío no está configurada");
  const addresses = request.to_addresses;
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 30
      || addresses.some((address) => typeof address !== "string" || !/^[^@<>\s,;\x00-\x1f\x7f]+@[^@<>\s,;\x00-\x1f\x7f]+$/.test(address))) {
    throw new Error("Los destinatarios de Mail no son válidos");
  }
  if (!text(request.subject).trim() || text(request.subject).length > 500
      || /[\r\n\x00]/.test(text(request.subject))
      || !text(request.body).trim() || text(request.body).length > MAX_BODY_CHARS) {
    throw new Error("El asunto o cuerpo de Mail no son válidos");
  }
  const replyIdentifier = text(request.reply_message_id);
  let replyTarget = null;
  if (replyIdentifier) {
    replyTarget = parseIdentifier(replyIdentifier);
    if (replyTarget.config.key !== config.key) {
      throw new Error("La respuesta debe salir desde la cuenta que recibió el mensaje");
    }
  }
  const account = requireAccount(config);
  if (!accountAddresses(account).includes(lower(config.address))) {
    throw new Error("La dirección configurada ya no pertenece a la cuenta de Mail; no se envió nada");
  }
  const original = replyTarget ? locateMessage(config, replyTarget.numericId).message : null;
  let outgoing;
  if (original) {
    outgoing = Mail.reply(original, { openingWindow: false, replyToAll: false });
  } else {
    outgoing = Mail.OutgoingMessage({ sender: config.address, visible: false });
    Mail.outgoingMessages.push(outgoing);
  }
  applyReviewedMessage(outgoing, config, request, addresses);
  const sent = Boolean(Mail.send(outgoing));
  if (!sent) throw new Error("Mail no confirmó el envío. Comprueba Enviados y Salida antes de reintentar");
  return { sent: true, message_id: "", thread_id: replyIdentifier || "" };
}

// `osascript` calls this global entrypoint.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run(argv) {
  const command = argv.length ? text(argv[0]) : "";
  try {
    const envelope = readStandardInput();
    configure(envelope);
    if (command === "overview") return JSON.stringify(overview());
    if (command === "thread") return JSON.stringify(readThread(argv[1]));
    if (command === "send") return JSON.stringify(sendMessage(envelope.request || {}));
    throw new Error("Operación de Mail no reconocida");
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) || "Mail devolvió un error inesperado" });
  }
}
