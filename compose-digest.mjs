#!/usr/bin/env node
/**
 * compose-digest.mjs — builds the daily job-search digest from current project data.
 * Prints JSON { to, subject, text, html } to stdout. The live Claude Code session
 * (or a scheduled routine) reads this and sends it via the Gmail connector.
 * It never sends mail itself and never submits anything.
 */
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = async (p, d = '') => { try { return await readFile(join(ROOT, p), 'utf8'); } catch { return d; } };

const board = JSON.parse(await read('data/board.json', '{"roles":[]}'));
const roles = board.roles || [];
const lib = JSON.parse(await read('data/answer-library.json', '{"fields":{}}'));
const TO = lib.fields?.email || 'atulpokharel12@gmail.com';

// Parse the Needs You checklist (open items only).
function parseNeeds(md) {
  const open = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ xX])\]\s*\*\*([A-Z]\d+)\s*[—-]\s*(.+?)\*\*\s*(.*)$/);
    if (m && m[1] === ' ') open.push({ id: m[2], q: m[3].trim(), impact: m[4].replace(/^→\s*/, '').trim() });
  }
  return open;
}
const needs = parseNeeds(await read('data/needs-input.md'));

const apply = roles.filter(r => r.rec === 'apply').sort((a, b) => b.score - a.score);
const ready = apply.filter(r => r.cv);         // CV prepared → ready for you to submit
const unknowns = Object.entries(lib.fields || {}).filter(([, v]) => String(v).startsWith('UNKNOWN'));

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

const subject = `Job search — ${ready.length} ready to submit, ${needs.length} questions for you (${new Date().toISOString().slice(0, 10)})`;

const text = [
  `Career-Ops daily digest — ${dateStr}`,
  ``,
  `READY TO SUBMIT (CV tailored, form prepped — you review + click Submit): ${ready.length}`,
  ...ready.map(r => `  • ${r.co} — ${r.role}  [${(+r.score).toFixed(1)}/5]  ${r.url || ''}`),
  ``,
  `QUESTIONS CLAUDE NEEDS FROM YOU: ${needs.length}`,
  ...needs.map(n => `  • ${n.id}: ${n.q}${n.impact ? '  (' + n.impact + ')' : ''}`),
  ``,
  unknowns.length ? `PROFILE BLANKS (reused on every app once you fill them): ${unknowns.map(([k]) => k).join(', ')}` : ``,
  ``,
  `Open the dashboard: http://localhost:4317  → Apply queue (open posting, CV, report) · Needs You (answer) · Ask Claude.`,
  `Nothing is ever submitted for you. You click Submit.`,
].filter(x => x !== null).join('\n');

const row = r => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${esc(r.co)}</b><br><span style="color:#555">${esc(r.role)}</span></td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${(+r.score).toFixed(1)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${r.url ? `<a href="${esc(r.url)}">open posting</a>` : ''}</td></tr>`;

const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
<h2 style="margin:0 0 4px">Career-Ops daily digest</h2>
<div style="color:#777;margin-bottom:16px">${esc(dateStr)}</div>
<h3 style="color:#0e7490;border-bottom:2px solid #eef0f3;padding-bottom:4px">Ready to submit — ${ready.length}</h3>
<p style="color:#555;margin:.3em 0">CV tailored, form prepped. You review and click Submit.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">${ready.map(row).join('') || '<tr><td style="padding:8px;color:#777">None yet.</td></tr>'}</table>
<h3 style="color:#0e7490;border-bottom:2px solid #eef0f3;padding-bottom:4px;margin-top:24px">Questions for you — ${needs.length}</h3>
<ul style="font-size:14px;line-height:1.6">${needs.map(n => `<li><b>${esc(n.id)}:</b> ${esc(n.q)}${n.impact ? ` <span style="color:#777">(${esc(n.impact)})</span>` : ''}</li>`).join('') || '<li style="color:#777">None right now.</li>'}</ul>
${unknowns.length ? `<p style="font-size:13px;color:#777"><b>Profile blanks</b> (fill once, reused on every application): ${unknowns.map(([k]) => esc(k)).join(', ')}</p>` : ''}
<div style="margin-top:24px;padding:14px;background:#f0f9fb;border-radius:10px;font-size:14px">
<a href="http://localhost:4317" style="color:#0e7490;font-weight:600">Open your dashboard →</a><br>
<span style="color:#555">Apply queue · Needs You · Ask Claude. Nothing is submitted for you — you click Submit.</span></div>
</div>`;

process.stdout.write(JSON.stringify({ to: TO, subject, text, html }));
