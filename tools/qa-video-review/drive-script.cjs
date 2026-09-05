/**
 * Drives one already-open tab through a scripted list of steps, so a video
 * review sees a real person's path rather than a sequence of raw navigations.
 *
 * Steps are JSON, read from --steps FILE or --steps-json '[...]':
 *   {"nav": "url"}                  navigate and wait for load
 *   {"click": "visible text"}       real mouse press/release at the element's
 *                                   centre, so hover and active states show
 *   {"type": "text"}                Input.insertText into whatever has focus
 *   {"focus": "css selector"}       click the first match by coordinates
 *   {"wait": 2000}                  dwell, in ms
 *   {"eval": "js"}                  last resort; returns its value in the log
 *
 * Every step logs what it did and whether it found its target, because a click
 * that silently hit nothing produces a video of a page where nothing happened
 * and a reviewer who blames the app.
 *
 * usage: node drive-script.cjs --port 9333 --steps steps.json [--stop-file X]
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
const filter = opt('--url-filter', null);

const steps = opt('--steps', null)
  ? JSON.parse(fs.readFileSync(opt('--steps'), 'utf8'))
  : JSON.parse(opt('--steps-json', '[]'));

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

// Finds a clickable element by its visible text and returns its centre. Text
// match is on trimmed textContent so "Start building" finds the button whether
// or not the markup wraps it.
const CENTRE_OF = (needle) => `(() => {
  const wanted = ${JSON.stringify(needle)}.toLowerCase();
  const all = [...document.querySelectorAll('button, a, [role=button], input, textarea, summary')];
  const hit = all.find((el) => (el.textContent || el.placeholder || '').trim().toLowerCase().includes(wanted));
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  hit.scrollIntoView({block: 'center'});
  const r2 = hit.getBoundingClientRect();
  return {x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, tag: hit.tagName, text: (hit.textContent || '').trim().slice(0, 60)};
})()`;

const CENTRE_OF_SELECTOR = (sel) => `(() => {
  const hit = document.querySelector(${JSON.stringify(sel)});
  if (!hit) return null;
  hit.scrollIntoView({block: 'center'});
  const r = hit.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2, tag: hit.tagName, text: ''};
})()`;

(async () => {
  // Was the worst of the three: with no --url-filter it took targets[0] outright,
  // then pressed and released a real mouse on it. resolveTarget refuses to choose
  // between tabs it cannot tell apart.
  const picked = await cdpTarget.resolveTarget({
    port: port, target: opt('--target', null), newTab: opt('--new-tab', null),
    urlFilter: filter, allowAnyTab: args.indexOf('--allow-any-tab') !== -1
  });
  console.error('[drive] target: ' + picked.how + (picked.url ? ' — ' + picked.url : ''));
  const page = { webSocketDebuggerUrl: picked.ws };
  if (!page) throw new Error('no page target on ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === mine) {
        ws.off('message', onMsg);
        if (m.error) rej(new Error(method + ': ' + m.error.message)); else res(m.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.value;
  };
  const clickAt = async (p) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: p.x, y: p.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
      });
      await sleep(60);
    }
  };

  await send('Page.enable', {});
  await send('Runtime.enable', {});
  const log = [];
  for (const step of steps) {
    if ('nav' in step) {
      await send('Page.navigate', { url: step.nav });
      await sleep(step.after || 1500);
      log.push({ nav: step.nav, ok: true });
    } else if ('click' in step) {
      const p = await evaluate(CENTRE_OF(step.click));
      if (!p) { log.push({ click: step.click, ok: false, why: 'no element with that text' }); continue; }
      await clickAt(p);
      await sleep(step.after || 800);
      log.push({ click: step.click, ok: true, hit: p.tag + ' ' + p.text });
    } else if ('focus' in step) {
      const p = await evaluate(CENTRE_OF_SELECTOR(step.focus));
      if (!p) { log.push({ focus: step.focus, ok: false, why: 'no match' }); continue; }
      await clickAt(p);
      log.push({ focus: step.focus, ok: true });
    } else if ('type' in step) {
      await send('Input.insertText', { text: step.type });
      await sleep(step.after || 400);
      log.push({ type: step.type.slice(0, 40), ok: true });
    } else if ('wait' in step) {
      await sleep(step.wait);
      log.push({ wait: step.wait });
    } else if ('eval' in step) {
      const v = await evaluate(step.eval);
      log.push({ eval: step.eval.slice(0, 60), value: v });
    }
  }
  ws.close();
  if (stopFile) fs.writeFileSync(stopFile, 'x');
  const missed = log.filter((l) => l.ok === false);
  console.log(JSON.stringify({ ok: missed.length === 0, missed, log }, null, 1));
  process.exit(missed.length === 0 ? 0 : 1);
})().catch((e) => { console.error(String(e)); process.exit(1); });
