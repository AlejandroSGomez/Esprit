/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
require.extensions['.tsx'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
const { JSDOM } = require(path.join(process.env.ESPRIT_TEST_NODE_MODULES || path.resolve(__dirname, '../node_modules'), 'jsdom'));
const dom = new JSDOM('<div id="root"></div>', { url: 'https://esprit.test' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(global, name, { value: dom.window[name], configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { default: HtmlViewer, htmlPreviewDocument, isHtmlFile } = require('../app/components/HtmlViewer.tsx');
const root = createRoot(document.getElementById('root'));
(async () => {
  assert.ok(isHtmlFile('figure.HTML') && isHtmlFile('figure.htm'));
  assert.ok(!isHtmlFile('figure.html.txt'));
  const fixture = '<html><head><style>p{color:blue}</style></head><body><p>Figure</p></body></html>';
  const render = (active) => act(async () => root.render(React.createElement(HtmlViewer, { content: fixture, name: 'figure.html', active })));
  await render(true);
  let frame = document.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.ok(frame.srcdoc.indexOf('Content-Security-Policy') < frame.srcdoc.indexOf(fixture));
  assert.ok(frame.srcdoc.includes("connect-src 'none'"));
  assert.ok(!frame.srcdoc.includes('blob: https:'));
  await act(async () => document.querySelector('input').click());
  assert.ok(document.querySelector('iframe').srcdoc.includes('blob: https:'));
  await act(async () => document.querySelector('button').click());
  assert.notEqual(frame, document.querySelector('iframe'));
  frame = document.querySelector('iframe');
  await render(false);
  assert.equal(document.querySelector('iframe'), frame, 'Switching tabs preserves the HTML document and its interaction state');
  assert.ok(frame.hidden);
  await render(true);
  assert.equal(document.querySelector('iframe'), frame);
  assert.ok(!frame.hidden);
  await act(async () => root.unmount());
  dom.window.close();

  // Optional real WebKit harness. It uses copies, never edits the source HTML.
  if (process.env.ESPRIT_HTML_PROBE) {
    const probeScript = `<script>window.addEventListener('load', async () => {
      let isolated=false, storageBlocked=false;
      try { void parent.document.body; } catch { isolated=true; }
      try { void localStorage.length; } catch { storageBlocked=true; }
      const tabs=[...document.querySelectorAll('[role="tab"]')];
      if(tabs[1]) tabs[1].click();
      const interactive=tabs.length ? tabs[1]?.getAttribute('aria-selected')==='true' && !document.getElementById(tabs[1].getAttribute('aria-controls')).hidden : document.querySelector('#counter')?.textContent==='1';
      const images=[...document.images];
      const networkBlocked=await fetch('https://html-preview.invalid/blocked').then(()=>false,()=>true);
      parent.postMessage({isolated,storageBlocked,interactive,networkBlocked,images:images.length,imagesLoaded:images.every(i=>i.complete&&i.naturalWidth>0)},'*');
    });</script>`;
    const original = process.env.ESPRIT_HTML_SOURCE ? fs.readFileSync(process.env.ESPRIT_HTML_SOURCE, 'utf8') : '<p id="counter">0</p><script>document.getElementById("counter").textContent="1"</script>';
    const inner = htmlPreviewDocument(original + probeScript);
    const escape = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    fs.writeFileSync(process.env.ESPRIT_HTML_PROBE, `<html><body><script>window.addEventListener('message',e=>window.webkit.messageHandlers.result.postMessage(e.data));</script><iframe sandbox="allow-scripts" srcdoc="${escape(inner)}"></iframe></body></html>`);
  }
  console.log('PASS: HTML preview, source policy, reload, HTTPS opt-in and inactive document retention.');
})().catch(error => { console.error(error); process.exitCode = 1; dom.window.close(); });
