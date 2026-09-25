/* eslint-disable @typescript-eslint/no-require-imports */
// Mock-only tests for resources/apple_mail_bridge.js. No Mail app, Apple
// Event or external service is invoked; every account and address is fictional.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../resources/apple_mail_bridge.js'), 'utf8');
const UNI = 'ana.perez@ejemplo.org';
const HOME = 'ana@correo.ejemplo.org';
const ACCOUNTS = [
  { key: 'm0', label: 'Universidad', mail_account: 'Universidad', address: UNI },
  { key: 'm1', label: 'Personal', mail_account: 'Casa', address: HOME },
];
const DAY = 86400000;
// Values built inside the vm realm have foreign prototypes; compare plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- JXA element-collection mock -------------------------------------------

function matches(item, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '_and') return expected.every((part) => matches(item, part));
    const actual = item[key]();
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('_greaterThan' in expected) return actual instanceof Date && actual.getTime() > expected._greaterThan.getTime();
      if ('_contains' in expected) return String(actual).toLowerCase().includes(String(expected._contains).toLowerCase());
      throw new Error(`unsupported filter ${JSON.stringify(expected)}`);
    }
    return actual === expected;
  });
}

function resolvePath(item, keys) {
  let value = item;
  for (const key of keys) value = Array.isArray(value) ? value.map((entry) => entry[key]()) : value[key]();
  return value;
}

function bulkProperty(items, keys, counters) {
  const read = () => {
    counters.bulk += 1;
    counters.inBulk = true;
    try { return items.map((item) => resolvePath(item, keys)); } finally { counters.inBulk = false; }
  };
  return new Proxy(read, {
    get(target, key) { return typeof key === 'symbol' ? target[key] : bulkProperty(items, [...keys, key], counters); },
    apply() { return read(); },
  });
}

function elements(items, counters = { bulk: 0, whose: [] }) {
  const target = function () { return items; };
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'symbol') return t[key];
      if (key === 'length') return items.length;
      if (/^\d+$/.test(key)) return items[Number(key)];
      if (key === 'whose') return (filter) => { counters.whose.push(filter); return elements(items.filter((item) => matches(item, filter)), counters); };
      if (key === 'byId') return (id) => items.find((item) => item.id() === id);
      if (key === 'push') return (item) => items.push(item);
      return bulkProperty(items, [key], counters);
    },
    apply() { return items; },
  });
}

function message(values, counters) {
  const item = {};
  const read = (key, value) => () => { if (!counters.inBulk) counters.single[key] = (counters.single[key] || 0) + 1; return value; };
  item.id = () => values.id;
  item.dateReceived = read('dateReceived', values.date);
  item.dateSent = read('dateSent', values.date);
  item.subject = read('subject', values.subject || 'Asunto');
  item.sender = read('sender', values.sender || 'Luis Gómez <luis@ejemplo.org>');
  item.messageId = read('messageId', values.messageId || `msg-${values.id}@ejemplo.org`);
  item.readStatus = read('readStatus', values.read !== false);
  item.toRecipients = () => (values.to || [UNI]).map((address) => ({ address: () => address }));
  item.content = () => { counters.content += 1; return values.content || `Cuerpo del mensaje ${values.id}`; };
  item.mailAttachments = elements(values.attachments || []);
  return item;
}

function mailboxFor(account, name, list, counters) {
  const mailbox = { name: () => name, account: () => account, unreadCount: () => list.filter((m) => m.read === false).length };
  mailbox.messages = elements(list.map((values) => message(values, counters)), counters);
  mailbox.mailboxes = elements([]);
  return mailbox;
}

function harness({ uni = {}, home = {}, tamper = '', missing = '', identity = UNI } = {}) {
  const counters = { bulk: 0, whose: [], single: {}, content: 0 };
  const sent = [], drafts = [], replies = [];
  const accounts = [];
  const unifiedInbox = [], unifiedSent = [];
  function account(name, address, config) {
    const value = { name: () => name, emailAddresses: () => [address] };
    // Deliberately unusual folder names: discovery must not depend on them.
    const inbox = mailboxFor(value, config.inboxName || 'Bandeja rara', config.inbox || [], counters);
    const sentBox = mailboxFor(value, config.sentName || 'Elementos enviados', config.sent || [], counters);
    value.mailboxes = elements([inbox, sentBox]);
    value.inbox = inbox;
    value.sentBox = sentBox;
    accounts.push(value);
    if (!config.noUnified) { unifiedInbox.push(inbox); unifiedSent.push(sentBox); }
    return value;
  }
  if (missing !== 'Universidad') account('Universidad', identity, uni);
  if (missing !== 'Casa') account('Casa', HOME, home);
  account('Otra', 'otra@ejemplo.org', { inbox: [{ id: 999, date: new Date(), subject: 'No debe leerse' }] });

  function draft(initial = {}, isReply = false) {
    const output = {};
    const property = (key, initialValue, transform = (value) => value) => {
      let value = initialValue;
      Object.defineProperty(output, key, { get: () => () => value, set: (next) => { value = transform(next); } });
    };
    property('sender', initial.sender || UNI, (value) => (tamper === 'sender' ? HOME : value));
    property('subject', 'Asunto automático', (value) => (tamper === 'subject' ? 'Asunto cambiado' : value));
    property('content', 'Firma y cita automáticas', (value) => (tamper === 'body' ? `${value}\nFirma no revisada` : value));
    for (const kind of ['toRecipients', 'ccRecipients', 'bccRecipients']) {
      // Replies inherit automatic recipients that the bridge must remove.
      const list = isReply ? [{ address: () => `auto-${kind}@ejemplo.net` }] : [];
      list.forEach((recipient) => { recipient.owner = list; });
      output[kind] = new Proxy(function () { return list; }, {
        get(target, key) {
          if (key === 'length') return list.length;
          if (typeof key === 'string' && /^\d+$/.test(key)) return list[Number(key)];
          if (key === 'push') {
            return (recipient) => {
              const stored = tamper === 'to' && kind === 'toRecipients' ? { address: () => 'cambiado@ejemplo.net' } : recipient;
              stored.owner = list;
              return list.push(stored);
            };
          }
          return target[key];
        },
        apply() { return list; },
      });
    }
    drafts.push(output);
    return output;
  }
  const Mail = {
    accounts: () => accounts,
    inbox: { mailboxes: elements(unifiedInbox) },
    sentMailbox: { mailboxes: elements(unifiedSent) },
    outgoingMessages: elements([]),
    OutgoingMessage: (properties) => draft(properties),
    ToRecipient: ({ address }) => ({ address: () => address }),
    reply(original) { replies.push(original); return draft({}, true); },
    delete(recipient) { assert.ok(recipient.owner, 'solo se borran destinatarios del borrador'); recipient.owner.splice(recipient.owner.indexOf(recipient), 1); },
    send(outgoing) {
      sent.push({ to: outgoing.toRecipients().map((r) => r.address()), cc: outgoing.ccRecipients().map((r) => r.address()), bcc: outgoing.bccRecipients().map((r) => r.address()), sender: outgoing.sender(), subject: outgoing.subject(), body: outgoing.content() });
      return true;
    },
  };
  let stdin = '';
  const $ = {
    NSFileHandle: { fileHandleWithStandardInput: { get readDataToEndOfFile() { return { length: stdin.length, text: stdin }; } } },
    NSString: { alloc: { initWithDataEncoding: (data) => ({ js: data.text }) } },
    NSUTF8StringEncoding: 4,
  };
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => Mail, $, Date });
  vm.runInContext(source, context);
  context.configure({ accounts: ACCOUNTS });
  return {
    context, counters, sent, drafts, replies, accounts,
    run(argv, envelope) { stdin = JSON.stringify(envelope); return JSON.parse(context.run(argv)); },
  };
}

const now = Date.now();
const ago = (days) => new Date(now - days * DAY);

// --- configure -------------------------------------------------------------
{
  const h = harness();
  for (const bad of [
    { accounts: [] },
    { accounts: [{ ...ACCOUNTS[0], key: 'm1' }] },
    { accounts: [{ ...ACCOUNTS[0], address: 'sin-arroba' }] },
    { accounts: Array.from({ length: 5 }, (_, i) => ({ ...ACCOUNTS[0], key: `m${i}` })) },
    {},
  ]) assert.throws(() => h.context.configure(bad), /cuentas de Mail/);
}
console.log('configure: claves m0…m3 en orden y cuentas validadas.');

// --- overview ----------------------------------------------------------------
{
  const inbox = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, date: ago(i * 0.2), read: i % 3 !== 0, subject: `Aviso ${i + 1}` }));
  inbox.push({ id: 500, date: ago(45), subject: 'Demasiado antiguo' });
  const h = harness({
    uni: { inbox, sent: [{ id: 800, date: ago(2), sender: `Ana Pérez <${UNI}>`, to: ['luis@ejemplo.org'], subject: 'Re: Aviso 3' }] },
    home: { inbox: [{ id: 900, date: ago(1), read: false, sender: 'Tienda <hola@tienda.ejemplo.net>', to: [HOME] }], noUnified: true, inboxName: 'INBOX', sentName: 'Sent Messages' },
  });
  const result = plain(h.context.overview());
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts.map((a) => [a.key, a.label, a.address, a.provider, a.connected]), [
    ['m0', 'Universidad', UNI, 'apple_mail', true],
    ['m1', 'Personal', HOME, 'apple_mail', true],
  ]);
  const uniInbox = result.emails.filter((e) => e.mailbox === 'm0' && e.folder === 'inbox');
  assert.equal(uniInbox.length, 60, 'capped per account');
  assert.equal(result.inbox_truncated, true);
  assert.ok(!result.emails.some((e) => e.subject === 'Demasiado antiguo'), 'outside the 30-day window');
  assert.ok(!result.emails.some((e) => e.subject === 'No debe leerse'), 'unconfigured accounts are never read');
  assert.equal(uniInbox[0].id, 'apple_m0_1', 'newest first');
  assert.equal(result.accounts[0].unread_count, inbox.filter((m) => m.read === false).length);
  const sentItem = result.emails.find((e) => e.id === 'apple_m0_800');
  assert.equal(sentItem.folder, 'sent');
  assert.equal(sentItem.is_own, true);
  assert.equal(sentItem.unread, false);
  assert.deepEqual(sentItem.labels, ['SENT']);
  assert.equal(sentItem.to, 'luis@ejemplo.org');
  const homeItem = result.emails.find((e) => e.id === 'apple_m1_900');
  assert.equal(homeItem.mailbox_label, 'Personal');
  assert.equal(homeItem.from_address, 'hola@tienda.ejemplo.net');
  assert.equal(homeItem.unread, true);
  assert.deepEqual(result.sent_accounts.map((a) => [a.key, a.connected, a.returned_count]), [['m0', true, 1], ['m1', true, 0]]);
  assert.equal(result.sent_source_count, 1);
  assert.equal(result.window_days, 30);
  assert.equal(result.warnings.length, 0);
  // Headers come from bulk reads; per-message header reads stay at zero.
  assert.equal(h.counters.single.subject || 0, 0);
  assert.equal(h.counters.single.sender || 0, 0);
  assert.ok(h.counters.content <= 80, `bounded snippet reads: ${h.counters.content}`);
  assert.ok(uniInbox[0].snippet.startsWith('Cuerpo del mensaje'));
  assert.ok(result.emails.every((e) => e.body === '' && e.snippet.length <= 600));
}
{
  const h = harness({ missing: 'Casa', uni: { inbox: [{ id: 1, date: ago(1) }] } });
  const result = plain(h.context.overview());
  assert.equal(result.connected, true);
  assert.equal(result.accounts[1].connected, false);
  assert.match(result.accounts[1].error, /No se encontró la cuenta «Casa»/);
  assert.equal(result.sent_accounts[1].connected, false);
  assert.equal(result.warnings.length, 1);
}
{
  const h = harness({ identity: 'otra.direccion@ejemplo.org', uni: { inbox: [{ id: 1, date: ago(1) }] } });
  const result = plain(h.context.overview());
  assert.equal(result.accounts[0].connected, true);
  assert.ok(result.warnings.some((w) => /dirección configurada/.test(w)));
}
console.log('overview: buzones sin depender del nombre, ventana de 30 días, límites y lecturas en bloque.');

// --- thread reconstruction ---------------------------------------------------
{
  const h = harness({
    uni: {
      inbox: [
        { id: 10, date: ago(3), subject: 'Borrador del capítulo', sender: 'Luis Gómez <luis@ejemplo.org>', content: 'Primer mensaje' },
        { id: 12, date: ago(1), subject: 'RE: Borrador del capítulo', sender: 'Luis Gómez <luis@ejemplo.org>', content: 'Última respuesta', attachments: [{}] },
        { id: 13, date: ago(1), subject: 'Borrador del capítulo', sender: 'Otra Persona <otra@ejemplo.org>', content: 'Otro hilo' },
      ],
      sent: [{ id: 11, date: ago(2), subject: 'Re: Borrador del capítulo', sender: `Ana Pérez <${UNI}>`, to: ['luis@ejemplo.org'], content: 'Mi respuesta' }],
    },
    home: { inbox: [{ id: 14, date: ago(1), subject: 'Re: Borrador del capítulo', sender: 'Luis Gómez <luis@ejemplo.org>', to: [HOME] }] },
  });
  const thread = plain(h.context.readThread('apple_m0_12'));
  assert.deepEqual(thread.messages.map((m) => m.id), ['apple_m0_10', 'apple_m0_11', 'apple_m0_12']);
  assert.equal(thread.reconstructed, true);
  assert.equal(thread.source_thread_count, 2);
  assert.equal(thread.messages[2].body, 'Última respuesta');
  assert.equal(thread.messages[2].has_attachment, true);
  assert.equal(thread.messages[1].is_own, true);
  assert.equal(thread.messages[1].folder, 'sent');
  const single = plain(h.context.readThread('apple_m0_13'));
  assert.deepEqual(single.messages.map((m) => m.id), ['apple_m0_13']);
  assert.equal(single.reconstructed, false);
  for (const bad of ['apple_m2_1', 'apple_m0_0', 'apple_staff_1', 'apple_m0_99999999999999999']) {
    assert.throws(() => h.context.readThread(bad));
  }
  assert.throws(() => h.context.readThread('apple_m0_14'), /ya no está/);
}
console.log('hilos: conversación reunida desde Entrada y Enviados de la misma cuenta, acotada.');

// --- send ----------------------------------------------------------------------
const request = { from_account: 'm0', to: 'Revisado <revisado@ejemplo.net>, segundo@ejemplo.net', to_addresses: ['revisado@ejemplo.net', 'segundo@ejemplo.net'], subject: 'Re: Asunto revisado', body: 'Cuerpo revisado\nsegunda línea', reply_message_id: 'apple_m0_42' };
{
  const h = harness({ uni: { inbox: [{ id: 42, date: ago(1) }] } });
  h.context.sendMessage(request);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].id(), 42);
  assert.deepEqual(h.sent[0], { to: request.to_addresses, cc: [], bcc: [], sender: UNI, subject: request.subject, body: request.body });
}
{
  const h = harness();
  const value = h.context.sendMessage({ ...request, reply_message_id: '' });
  assert.equal(value.sent, true);
  assert.equal(h.replies.length, 0);
  assert.equal(h.sent.length, 1);
}
for (const extra of [
  { from_account: 'm2' },
  { from_account: 'staff' },
  { reply_message_id: 'apple_m1_42' },
  { reply_message_id: 'gmail-42' },
  { reply_message_id: 'apple_m0_9999999999999999999' },
  { to_addresses: ['sin-arroba'] },
  { to_addresses: [] },
  { subject: 'Asunto\r\nBcc: oculto@ejemplo.net' },
  { body: ' ' },
]) {
  const h = harness({ uni: { inbox: [{ id: 42, date: ago(1) }] } });
  assert.throws(() => h.context.sendMessage({ ...request, ...extra }));
  assert.equal(h.drafts.length, 0);
  assert.equal(h.sent.length, 0);
}
{
  const h = harness({ identity: 'otra.direccion@ejemplo.org' });
  assert.throws(() => h.context.sendMessage({ ...request, reply_message_id: '' }), /ya no pertenece/);
  assert.equal(h.drafts.length, 0);
}
{
  const h = harness({ uni: { inbox: [] } });
  assert.throws(() => h.context.sendMessage(request), /ya no está/);
  assert.equal(h.drafts.length, 0);
}
for (const tamper of ['subject', 'body', 'to', 'sender']) {
  const h = harness({ tamper });
  assert.throws(() => h.context.sendMessage({ ...request, reply_message_id: '' }), /Mail cambió/);
  assert.equal(h.sent.length, 0);
}
console.log('envío: solo desde cuentas configuradas, respuesta en la misma cuenta y verificación final.');

// --- run() entrypoint ------------------------------------------------------------
{
  const h = harness({ uni: { inbox: [{ id: 7, date: ago(1) }] } });
  const thread = h.run(['thread', 'apple_m0_7'], { accounts: ACCOUNTS });
  assert.equal(thread.messages[0].id, 'apple_m0_7');
  assert.match(h.run(['overview'], { accounts: [] }).error, /cuentas de Mail/);
  assert.match(h.run(['borrar'], { accounts: ACCOUNTS }).error, /no reconocida/);
  const sentValue = h.run(['send'], { accounts: ACCOUNTS, request: { ...request, reply_message_id: '' } });
  assert.equal(sentValue.sent, true);
}
console.log('run: sobre JSON por stdin y errores en español.');
