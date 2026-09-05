/**
 * Drives one already-open tab through a list of URLs, dwelling on each, then
 * writes a stop file. Runs from this directory so require('ws') resolves the
 * same copy the recorder uses.
 *
 * usage: node drive-routes.cjs --port 9333 --stop-file X --dwell 3000 URL...
 */
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const cdpTarget = require('./cdp-target.cjs');
const instances = require('./chrome-instances.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; };
// --instance resolves the port from the shared registry, so a caller never has
// to remember which port their own browser landed on.
const instanceName = opt('--instance', null);
const port = instanceName
    ? (instances.readEntry(instanceName) || (() => { throw new Error('no browser instance named "' + instanceName + '"'); })()).port
    : Number(opt('--port', 9333));
const stopFile = opt('--stop-file', null);
const dwell = Number(opt('--dwell', 3000));
const filter = opt('--url-filter', 'localhost');
const urls = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

// JSON.parse HAS to be inside the try. A throw in an 'end' handler is not caught by
// the Promise executor — that frame is long gone — so it surfaces as an
// uncaughtException and takes the whole recorder down. The trigger is mundane: the
// debug port answering with an HTML error page instead of JSON. Found in code review
// of e7743ae4.
const get = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, (r) => {
    let b = ''; r.on('data', (d) => b += d);
    r.on('end', () => {
      try { res(JSON.parse(b)); }
      catch (e) {
        rej(new Error('CDP ' + path + ' returned non-JSON (HTTP ' + r.statusCode + '): ' +
          b.slice(0, 120)));
      }
    });
  }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // No `|| targets[0]`. This script NAVIGATES the tab it picks and clicks into it,
  // so grabbing another agent's tab does not just mislead a reviewer — it drives
  // their application. resolveTarget throws rather than guessing.
  const picked = await cdpTarget.resolveTarget({
    port: port, target: opt('--target', null), newTab: opt('--new-tab', null),
    urlFilter: filter, allowAnyTab: args.indexOf('--allow-any-tab') !== -1
  });
  console.error('[drive] target: ' + picked.how + (picked.url ? ' — ' + picked.url : ''));
  const page = { webSocketDebuggerUrl: picked.ws };
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === mine) { ws.off('message', onMsg); res(m.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  await send('Page.enable', {});
  for (const url of urls) {
    process.stderr.write('nav ' + url + '\n');
    await send('Page.navigate', { url });
    await sleep(dwell);
  }
  ws.close();
  if (stopFile) fs.writeFileSync(stopFile, 'x');
  console.log(JSON.stringify({ ok: true, visited: urls }));
})().catch((e) => { console.error(String(e)); process.exit(1); });
