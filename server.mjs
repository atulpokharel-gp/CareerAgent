#!/usr/bin/env node
/**
 * server.mjs — Career-Ops local web app.
 * Serves a live dashboard (reads your real project data) + a small API:
 *   GET  /                 -> the dashboard UI
 *   GET  /api/state        -> {roles, apps, needs, scanLog, ts}
 *   POST /api/scan         -> runs scan.mjs, returns {added, tail}
 *   POST /api/answer       -> {id, answer} saved to data/answers.md + ticks needs-input.md
 *   GET  /api/report?file= -> a report's markdown (reports/ only)
 *
 * Run:  node server.mjs    then open http://localhost:4317
 * Automation boundary: this never submits an application. It prepares and queues; you submit.
 */
import { createServer } from 'http';
import { readFile, writeFile, appendFile } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createAutomation } from './automation.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4317;
const DATA_ROOT = getCareerOpsRoot();
const automation = createAutomation(DATA_ROOT, { codeRoot:ROOT });
const read = async (p, d = '') => { try { return await readFile(join(p.startsWith('webui/') ? ROOT : DATA_ROOT, p), 'utf8'); } catch { return d; } };

// In-flight CV generation jobs, keyed by role number: {status:'generating'|'ready'|'failed', msg?}
const cvJobs = {};
// Append a task to the agent queue that THIS Claude Code session drains (no autonomous worker).
async function enqueue(task) {
  let q = []; try { q = JSON.parse(await read('data/agent-queue.json', '[]')); } catch {}
  q.push({ id: 'q' + Date.now() + Math.floor(Math.random() * 1000), status: 'pending', ts: new Date().toISOString(), ...task });
  await writeFile(join(ROOT, 'data/agent-queue.json'), JSON.stringify(q, null, 2));
}
async function logActivity(ic, t, d) {
  let a = { events: [] }; try { a = JSON.parse(await read('data/activity.json', '{"events":[]}')); } catch {}
  a.events.push({ ts: new Date().toISOString().slice(0, 19), ic, t, d });
  await writeFile(join(ROOT, 'data/activity.json'), JSON.stringify(a, null, 2));
}
const slugify = s => String(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const today = () => new Date().toISOString().slice(0, 10);

// --- Minimal, dependency-free Markdown -> HTML (headings, tables, lists, bold, code, links) ---
const mdEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function mdInline(s) {
  s = mdEsc(s);
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}
function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = []; let i = 0;
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isSep = l => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    let l = lines[i];
    if (/^```/.test(l)) { // fenced code
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(mdEsc(lines[i])); i++; }
      i++; out.push(`<pre><code>${buf.join('\n')}</code></pre>`); continue;
    }
    if (isTableRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map(h => `<th>${mdInline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(mdInline(lines[i].replace(/^\s*[-*]\s+/, ''))); i++; }
      out.push('<ul>' + items.map(x => `<li>${x}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(mdInline(lines[i].replace(/^\s*\d+\.\s+/, ''))); i++; }
      out.push('<ol>' + items.map(x => `<li>${x}</li>`).join('') + '</ol>'); continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !isTableRow(lines[i]) && !/^```/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${mdInline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
function reportPage(title, md) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${mdEsc(title)}</title><style>
:root{color-scheme:light dark}
body{font:15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;background:#f6f7f9;margin:0;padding:32px 16px}
.wrap{max-width:860px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:32px 40px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
h1{font-size:1.7rem;margin:.2em 0 .5em;line-height:1.2}h2{font-size:1.3rem;margin:1.4em 0 .5em;padding-bottom:.25em;border-bottom:2px solid #eef0f3;color:#0e7490}
h3{font-size:1.08rem;margin:1.2em 0 .4em}h4{font-size:1rem;margin:1em 0 .3em;color:#444}
p{margin:.6em 0}ul,ol{margin:.5em 0;padding-left:1.4em}li{margin:.25em 0}
a{color:#0e7490}code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:#f0f2f5;padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
hr{border:0;border-top:1px solid #e3e6ea;margin:1.5em 0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92rem}
th,td{border:1px solid #e3e6ea;padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f0f9fb;font-weight:600}tr:nth-child(even) td{background:#fafbfc}
.back{display:inline-block;margin-bottom:14px;color:#0e7490;text-decoration:none;font-size:.9rem}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}.wrap{background:#161a20;border-color:#2a2f37}
h2{border-color:#2a2f37;color:#38bdf8}h4{color:#aab}code,pre{background:#222832}th{background:#1b2735}td,th{border-color:#2a2f37}tr:nth-child(even) td{background:#1a1f27}a,.back{color:#38bdf8}}
</style></head><body><div class="wrap"><a class="back" href="javascript:history.back()">&larr; back</a>
${mdToHtml(md)}
</div></body></html>`;
}

function parseApplications(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split('|').map(s => s.trim());
    if (c.length >= 9 && /^\d+$/.test(c[1]))
      rows.push({ num: c[1], date: c[2], company: c[3], role: c[4], score: c[5], status: c[6], pdf: c[7], report: c[8], notes: c[9] || '' });
  }
  return rows;
}
function parseNeeds(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ xX])\]\s*\*\*([A-Z]\d+)\s*[—-]\s*(.+?)\*\*\s*(.*)$/);
    if (m) items.push({ done: m[1].toLowerCase() === 'x', id: m[2], q: m[3].trim(), impact: m[4].replace(/^→\s*/, '').trim() });
  }
  return items;
}
const body = req => new Promise((resolve, reject) => { let d = '', size = 0; req.on('data', c => { size += c.length; if (size > 8_000_000) { reject(new Error('Request exceeds 8 MB.')); return; } d += c; }); req.on('end', () => resolve(d)); req.on('error', reject); });
const json = (r, o, code = 200) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) return json(res, { error: 'Host not allowed' }, 403);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && req.headers.origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin)) return json(res, { error: 'Origin not allowed' }, 403);
    if (url.pathname === '/api/automation' && req.method === 'GET') return json(res, await automation.snapshot());
    if (['/api/onboarding', '/api/cv/extract', '/api/automation/start', '/api/automation/stop'].includes(url.pathname)) {
      if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);
      try {
        const input = JSON.parse(await body(req) || '{}');
        const action = { '/api/onboarding': 'configure', '/api/cv/extract': 'extract', '/api/automation/start': 'run', '/api/automation/stop': 'stop' }[url.pathname];
        return json(res, await automation[action](input));
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (['/workspace.css', '/workspace.js'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      return res.end(await read('webui' + url.pathname));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await read('webui/index.html', '<h1>UI missing</h1>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (url.pathname === '/api/state') {
      const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
      const activity = JSON.parse(await read('data/activity.json', '{"events":[]}'));
      const libRaw = await read('data/answer-library.json', '{"fields":{}}');
      // Merge persisted CV requests (so status survives a server restart).
      try {
        const q = JSON.parse(await read('data/cv-requests.json', '[]'));
        for (const r of q) if (!cvJobs[r.num] || cvJobs[r.num].status === 'requested') {
          const role = (board.roles || []).find(x => String(x.num) === String(r.num));
          if (!(role && role.cv)) cvJobs[r.num] = { status: 'requested' };
        }
      } catch {}
      return json(res, {
        roles: board.roles || [],
        events: activity.events || [],
        apps: parseApplications(await read('data/applications.md')),
        needs: parseNeeds(await read('data/needs-input.md')),
        scanLog: (await read('data/scan-log.txt')).split('\n').slice(-25).join('\n'),
        cvReady: Object.fromEntries((board.roles || []).filter(r => r.cv).map(r => [r.num, 1])), submitted: {}, cvJobs,
        queue: JSON.parse(await read('data/agent-queue.json', '[]')),
        chat: JSON.parse(await read('data/agent-chat.json', '[]')),
        applyStatus: JSON.parse(await read('data/apply-status.json', '{}')),
        blanks: (() => { try { const f = JSON.parse(libRaw).fields || {}; return Object.keys(f).filter(k => String(f[k]).startsWith('UNKNOWN')); } catch { return []; } })(),
        ts: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const out = await new Promise(resolve => {
        const p = spawn(process.execPath, ['scan.mjs'], { cwd: ROOT });
        let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
        p.on('close', () => resolve(o)); p.on('error', e => resolve('ERROR: ' + e.message));
      });
      const added = (out.match(/^\s*\+ /gm) || []).length;
      return json(res, { added, tail: out.split('\n').slice(-20).join('\n') });
    }
    if (url.pathname === '/api/make-cv' && req.method === 'POST') {
      const { num } = JSON.parse(await body(req) || '{}');
      const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
      const role = (board.roles || []).find(r => String(r.num) === String(num));
      if (!role) return json(res, { ok: false, error: 'role not found' }, 404);
      if (role.cv) return json(res, { ok: true, status: 'ready', cv: role.cv });
      // Queue the request for the live Claude Code session to build (no autonomous worker).
      let q = [];
      try { q = JSON.parse(await read('data/cv-requests.json', '[]')); } catch {}
      if (!q.find(x => String(x.num) === String(num)))
        q.push({ num: role.num, co: role.co, role: role.role, report: role.report || role.ref || '', ts: new Date().toISOString() });
      await writeFile(join(ROOT, 'data/cv-requests.json'), JSON.stringify(q, null, 2));
      cvJobs[num] = { status: 'requested' };
      return json(res, { ok: true, status: 'requested' });
    }
    if (url.pathname === '/api/answer' && req.method === 'POST') {
      const { id, answer } = JSON.parse(await body(req) || '{}');
      if (!id || !answer) return json(res, { ok: false, error: 'id and answer required' }, 400);
      await appendFile(join(ROOT, 'data/answers.md'), `\n### ${id} — ${new Date().toISOString()}\n${answer}\n`);
      // tick the checkbox in needs-input.md
      let md = await read('data/needs-input.md');
      md = md.replace(new RegExp(`^- \\[ \\](\\s*\\*\\*${id}\\b)`, 'm'), '- [x]$1');
      await writeFile(join(ROOT, 'data/needs-input.md'), md);
      // Queue a re-score so the board reflects this answer, and log it.
      await enqueue({ type: 'answer', ref: id, answer });
      await logActivity('✅', `Answered ${id}`, 'Saved to profile; queued a board re-score for Claude.');
      return json(res, { ok: true, queued: true });
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const { text } = JSON.parse(await body(req) || '{}');
      if (!text || !text.trim()) return json(res, { ok: false, error: 'empty' }, 400);
      let chat = []; try { chat = JSON.parse(await read('data/agent-chat.json', '[]')); } catch {}
      chat.push({ role: 'user', text: text.trim(), ts: new Date().toISOString() });
      await writeFile(join(ROOT, 'data/agent-chat.json'), JSON.stringify(chat, null, 2));
      await enqueue({ type: 'chat', text: text.trim() });
      await logActivity('💬', 'You asked Claude', text.trim().slice(0, 80));
      return json(res, { ok: true, queued: true });
    }
    if (url.pathname === '/api/apply' && req.method === 'POST') {
      const { num } = JSON.parse(await body(req) || '{}');
      const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
      const role = (board.roles || []).find(r => String(r.num) === String(num));
      if (!role) return json(res, { ok: false, error: 'role not found' }, 404);
      let st = {}; try { st = JSON.parse(await read('data/apply-status.json', '{}')); } catch {}
      if (st[num] && st[num].status === 'submitted') return json(res, { ok: true, status: 'submitted' });
      st[num] = { status: 'filling', ts: new Date().toISOString() };
      await writeFile(join(ROOT, 'data/apply-status.json'), JSON.stringify(st, null, 2));
      // Launch the deterministic Playwright filler (opens a visible window, stops at Submit).
      const p = spawn(process.execPath, ['apply-fill.mjs', String(num)], { cwd: ROOT, detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
      await logActivity('🖊️', `Apply started: ${role.co}`, 'Auto-filling form (fields + CV + essays). A window opens; it stops at Submit.');
      return json(res, { ok: true, status: 'filling' });
    }
    if (url.pathname === '/api/apply-batch' && req.method === 'POST') {
      const bodyObj = JSON.parse(await body(req) || '{}');
      const count = Math.min(Math.max(parseInt(bodyObj.count, 10) || 3, 1), 6);
      const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
      let st = {}; try { st = JSON.parse(await read('data/apply-status.json', '{}')); } catch {}
      // eligible = apply-worthy, has a CV, not already filling/submitted
      const eligible = (board.roles || [])
        .filter(r => r.rec === 'apply' && r.cv && !(st[r.num] && (st[r.num].status === 'submitted' || st[r.num].status === 'filling' || st[r.num].status === 'awaiting_submit')))
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
      // Stagger launches: firing 3-6 headed Chromium at the same instant on
      // Windows contends for memory/GPU and crashes the pages before they fill
      // (the "windows open but nothing goes through" bug). Launch them STAGGER_MS apart.
      const STAGGER_MS = 10000;
      eligible.forEach((r, i) => {
        st[r.num] = { status: 'filling', ts: new Date().toISOString() };
        setTimeout(() => {
          const p = spawn(process.execPath, ['apply-fill.mjs', String(r.num)], { cwd: ROOT, detached: true, stdio: 'ignore' });
          p.on('error', () => {}); p.unref();
        }, i * STAGGER_MS);
      });
      await writeFile(join(ROOT, 'data/apply-status.json'), JSON.stringify(st, null, 2));
      await logActivity('🖊️', `Batch apply: ${eligible.length} roles`, eligible.map(r => r.co).join(', ') + ' — each opens a filled window; you Submit.');
      return json(res, { ok: true, started: eligible.map(r => ({ num: r.num, co: r.co })) });
    }
    if (url.pathname === '/api/submitted' && req.method === 'POST') {
      const { num } = JSON.parse(await body(req) || '{}');
      let st = {}; try { st = JSON.parse(await read('data/apply-status.json', '{}')); } catch {}
      st[num] = { status: 'submitted', ts: new Date().toISOString() };
      await writeFile(join(ROOT, 'data/apply-status.json'), JSON.stringify(st, null, 2));
      // flip the runbook if present
      const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
      const role = (board.roles || []).find(r => String(r.num) === String(num));
      await enqueue({ type: 'mark-submitted', num, co: role ? role.co : '', role: role ? role.role : '' });
      await logActivity('✅', `Submitted: ${role ? role.co : 'role #' + num}`, 'You confirmed submission — marked done, tracker → Applied. Next role is up.');
      return json(res, { ok: true, status: 'submitted' });
    }
    if (url.pathname === '/api/email-digest' && req.method === 'POST') {
      await enqueue({ type: 'email-digest' });
      await logActivity('📧', 'Digest email requested', 'Queued for Claude to compose and send to your Gmail.');
      return json(res, { ok: true, queued: true });
    }
    if (url.pathname === '/api/library') {
      return json(res, JSON.parse(await read('data/answer-library.json', '{"fields":{}}')));
    }
    if (url.pathname === '/api/recipes') {
      return json(res, JSON.parse(await read('data/ats-recipes.json', '{"recipes":{}}')));
    }
    if (url.pathname === '/api/report') {
      const f = basename(url.searchParams.get('file') || '');
      if (!/^[\w.-]+\.md$/.test(f)) return json(res, { error: 'bad file' }, 400);
      return json(res, { text: await read('reports/' + f, '(report not found)') });
    }
    // Read-only static serving for tailored CVs and report files (path-restricted).
    const staticMatch = url.pathname.match(/^\/(output|reports)\/([\w.-]+)$/);
    if (staticMatch && req.method === 'GET') {
      const [, dir, f] = staticMatch;
      const TYPES = { pdf: 'application/pdf', html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8' };
      const ext = f.split('.').pop().toLowerCase();
      if (!TYPES[ext]) return json(res, { error: 'type not allowed' }, 400);
      try {
        if (ext === 'md') { // render markdown reports as a styled web page
          const text = await readFile(join(DATA_ROOT, dir, f), 'utf8');
          const titleMatch = text.match(/^#\s+(.*)$/m);
          const html = reportPage(titleMatch ? titleMatch[1] : f, text);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
        }
        const buf = await readFile(join(DATA_ROOT, dir, f));
        res.writeHead(200, { 'Content-Type': TYPES[ext] }); return res.end(buf);
      } catch { res.writeHead(404); return res.end('file not found'); }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { json(res, { error: String(e) }, 500); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Career-Ops UI running at http://localhost:${PORT}`));
