#!/usr/bin/env node
/**
 * apply-fill.mjs <num> — fully-automated, DETERMINISTIC application filler.
 * Launches a visible browser, opens the role's posting, detects the ATS,
 * fills every field it has an answer for (answer-library + ats-recipes),
 * uploads the tailored CV, drafts essays (data/essays.json or templates),
 * records the runbook, and LEAVES THE WINDOW OPEN at the Submit step.
 *
 * It NEVER clicks Submit. The user reviews, finishes personal questions, and submits.
 * No LLM runs here — it is a plain Playwright script, like scan.mjs / generate-pdf.mjs.
 *
 *   node apply-fill.mjs 3
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = async (p, d = '') => { try { return await readFile(join(ROOT, p), 'utf8'); } catch { return d; } };
const jread = async (p, d) => { try { return JSON.parse(await read(p, JSON.stringify(d))); } catch { return d; } };

const num = String(process.argv[2] || '').trim();
if (!num) { console.error('usage: node apply-fill.mjs <num>'); process.exit(1); }

const board = await jread('data/board.json', { roles: [] });
const role = (board.roles || []).find(r => String(r.num) === num);
if (!role) { console.error('role not found: ' + num); process.exit(1); }
if (!role.url) { console.error('role has no application url'); process.exit(1); }

const lib = await jread('data/answer-library.json', { fields: {} });
const F = lib.fields || {};
const recipes = (await jread('data/ats-recipes.json', { recipes: {} })).recipes || {};
const essaysByNum = await jread('data/essays.json', {});
const roleEssays = essaysByNum[num] || {};
// Self-healing KB: answers the user has typed in past applications, reused by question label.
const LEARNED_PATH = 'data/learned-answers.json';
const learned = await jread(LEARNED_PATH, {});
const normLabel = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
const learnedFor = label => {
  const n = normLabel(label); if (!n) return null;
  if (learned[n]?.answer) return learned[n].answer;
  for (const k of Object.keys(learned)) if (k.length > 6 && (n.includes(k) || k.includes(n)) && learned[k]?.answer) return learned[k].answer;
  return null;
};

const host = (() => { try { return new URL(role.url).host; } catch { return ''; } })();
const atsName = Object.keys(recipes).find(k => host.includes(recipes[k].detect_host?.replace(/^[^.]*\./, '') || k)) ||
  (host.includes('greenhouse') ? 'greenhouse' : host.includes('ashby') ? 'ashby' : host.includes('lever') ? 'lever' : host.includes('coreweave') ? 'coreweave' : '');
const recipe = recipes[atsName] || recipes.greenhouse;

// Essay templates (used when data/essays.json has no per-role text).
const CO = role.co.replace(/\s*\(.*\)/, '').trim();
const ESSAY_RULES = [
  { re: /why .*(join|work|company)|why now|why (are you )?interested|why do you want/, text:
    `I build what this team ships — production LLM apps, MCP and agent execution layers, and real-time voice agents — end to end, as a founder and senior engineer. ${CO}'s work maps directly onto mine: Smart365Guide (an MCP execution layer, 48.4% lower token use vs baseline in a controlled benchmark), production LLM and voice systems at PROCIT, and the REFUN evaluation harness. I want forward-deployed, customer-facing delivery, and this is that role.` },
  { re: /impactful|proud|notable|best.*(built|project|work)|most.*(built|shipped)/, text:
    `Smart365Guide: an SDK and MCP execution layer that lets software owners expose workflows, permissions, and verification rules to AI agents. I built the core execution layer end to end — role-based access, action validation, human-approval checkpoints, audit logs, and completion checks. A controlled Codex benchmark measured 48.4% lower token consumption versus baseline on the same tasks.` },
  { re: /how did you know|success|measure|worked|metrics|impact.*look/, text:
    `I define success as a measurable, repeatable result, not a demo. For Smart365Guide I ran the same task set through a baseline and the guided execution layer, measuring token use, completion, and whether guardrails caught invalid actions — the 48.4% reduction held across runs. My research held the same bar: REFUN set exact-match, token-F1, and failure analysis up front over a 9,116-example evaluation set.` },
  { re: /why (you|should we)|what makes you|unique|superpower|strength/, text:
    `Founder-engineer who ships 0-to-1 and measures it. MCP/agent execution layer with a real benchmark, production LLM and voice delivery at PROCIT, and an evaluation harness from my research. Strong Python and TypeScript, and I deliver directly with customer engineers.` },
];
// Questions I must NOT auto-answer (personal / factual about the specific company).
const PERSONAL = /have you (used|tried)|used .*\b(our|us|this)\b|side project.*(our|us)|personal.*project.*(our|us)|are you (a )?(current )?user/;

// Match "Why {Company}?" phrasings too (company token from the role).
const coToken = CO.toLowerCase().split(/[\s&]+/)[0];
if (coToken && coToken.length > 2) ESSAY_RULES.unshift({ re: new RegExp('why\\b.{0,30}' + coToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), text: ESSAY_RULES[0].text });
function essayFor(label) {
  const taught = learnedFor(label); if (taught) return taught;   // reuse what you taught us before
  const L = label.toLowerCase();
  if (PERSONAL.test(L)) return null;              // never auto-answer personal/factual (unless learned above)
  for (const k of Object.keys(roleEssays)) if (L.includes(k.toLowerCase())) return roleEssays[k];
  for (const r of ESSAY_RULES) if (r.re.test(L)) return r.text;
  return null;
}

const steps = [];
const rec = (action, field, value, status) => { steps.push({ ts: new Date().toISOString(), action, field: field.slice(0, 60), value: String(value).slice(0, 60), status }); console.log(`  [${status}] ${action} ${field.slice(0, 40)}`); };

async function setStatus(status) {
  const p = 'data/apply-status.json';
  const st = await jread(p, {});
  st[num] = { status, ts: new Date().toISOString() };
  await writeFile(join(ROOT, p), JSON.stringify(st, null, 2));
}

console.log(`Applying: #${num} ${role.co} — ${role.role}\nATS: ${atsName || 'unknown'}\nURL: ${role.url}`);
await setStatus('filling');

// Stability flags: on Windows the renderer can crash ("Page crashed") under
// memory/GPU pressure, especially with several windows open. These reduce that.
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext();
const page = await context.newPage();
let awaitingSubmit = false;
try {
  await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Reveal the form (Ashby hides it behind an Apply button; Lever has an Apply link).
  for (const sel of ['button:has-text("Apply for this Job")', 'a:has-text("Apply for this Job")', 'a:has-text("Apply")']) {
    const b = page.locator(sel).first();
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); await page.waitForTimeout(1500); break; }
  }
  await page.waitForTimeout(1200);

  // Tag every visible field with its best label.
  const fields = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labelFor = el => {
      let t = '';
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) t = l.innerText; }
      if (!t && el.getAttribute('aria-label')) t = el.getAttribute('aria-label');
      if (!t) { const l = el.closest('label'); if (l) t = l.innerText; }
      if (!t) { let p = el.parentElement, h = 0; while (p && h < 4 && !t) { const c = p.querySelector('label,legend,.ashby-application-form-field-entry-label'); if (c && !c.contains(el)) t = c.innerText; p = p.parentElement; h++; } }
      if (!t && el.placeholder) t = el.placeholder;
      return (t || '').replace(/\*/g, '').trim().slice(0, 90);
    };
    const out = [];
    [...document.querySelectorAll('input, textarea, select')].forEach((el, i) => {
      if (['hidden', 'submit', 'button'].includes(el.type)) return;
      if (el.type !== 'file' && !vis(el)) return;
      el.setAttribute('data-af', String(i));
      out.push({ af: i, label: labelFor(el), tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), accept: el.accept || '' });
    });
    return out;
  });
  console.log(`Found ${fields.length} fields.`);

  const loc = af => page.locator(`[data-af="${af}"]`);
  const matched = new Set();

  // 1) Resume upload — pick the RESUME file input, attach, and VERIFY it stuck.
  const cvAbs = role.cv ? resolve(ROOT, role.cv) : '';
  const filesOn = af => page.evaluate(a => { const el = document.querySelector(`[data-af="${a}"]`); return el && el.files ? el.files.length : 0; }, af);
  const pickResume = () => fields.find(f => f.type === 'file' && /resume|cv/i.test(f.label)) ||
    fields.find(f => f.type === 'file' && /pdf/i.test(f.accept)) || fields.find(f => f.type === 'file');
  const cvBase = cvAbs ? cvAbs.split(/[\\/]/).pop() : '';
  const cvStem = cvBase.replace(/\.[a-z0-9]+$/i, '').slice(0, 16); // many ATS truncate; match a stem
  const attachOk = async af => {
    if (af != null && (await filesOn(af)) > 0) return true;            // input still holds the file
    try { return await page.evaluate(s => document.body.innerText.includes(s), cvStem); } catch { return false; } // or the filename now shows (input was replaced)
  };
  if (!cvAbs) {
    rec('upload_resume', 'resume', role.cv || '(none)', 'failed: role has no CV — run Make CV first');
  } else {
    let field = pickResume();
    let ok = false;
    if (field) { try { await loc(field.af).setInputFiles(cvAbs); await page.waitForTimeout(900); ok = await attachOk(field.af); if (ok) matched.add(field.af); } catch {} }
    if (!ok) {
      for (const sel of ['button:has-text("Attach")', 'button:has-text("Resume")', 'button:has-text("Upload")', 'label:has-text("Resume")']) {
        const b = page.locator(sel).first();
        if (await b.count().catch(() => 0)) { await b.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(600); break; }
      }
      const af2 = await page.evaluate(() => { const el = [...document.querySelectorAll('input[type=file]')].find(e => /resume|cv/i.test(e.id + ' ' + (e.name || ''))) || document.querySelector('input[type=file]'); if (!el) return null; el.setAttribute('data-af', 'rez'); return 'rez'; });
      if (af2) { try { await loc(af2).setInputFiles(cvAbs); await page.waitForTimeout(900); ok = await attachOk(af2); } catch {} }
    }
    rec('upload_resume', (field && field.label) || 'Resume', cvBase, ok ? 'done — verified attached' : 'FAILED — attach the CV manually in the window');
  }

  // 2) Recipe-mapped text fields.
  for (const spec of (recipe.fields || [])) {
    if (spec.action && spec.action !== 'upload_resume') continue; // uploads handled above; skip/optional actions ignored
    if (spec.action === 'upload_resume') continue;
    const re = new RegExp(spec.match, 'i');
    const field = fields.find(f => !matched.has(f.af) && (f.tag === 'input' || f.tag === 'textarea') && f.type !== 'file' && re.test(f.label));
    if (!field) continue;
    let val = F[spec.key];
    if (!val || String(val).startsWith('UNKNOWN')) val = learnedFor(field.label);  // self-heal from past answers
    if (!val || String(val).startsWith('UNKNOWN')) continue;
    try {
      await loc(field.af).fill(String(val), { timeout: 5000 });
      matched.add(field.af);
      rec('fill', field.label, val, 'done');
      // Ashby-style typeahead (location/country): confirm the first option.
      if (/location|country|where.*based/i.test(field.label)) {
        await page.waitForTimeout(700);
        await loc(field.af).press('ArrowDown').catch(() => {});
        await loc(field.af).press('Enter').catch(() => {});
      }
    } catch (e) { rec('fill', field.label, val, 'failed:' + e.message.slice(0, 30)); }
  }

  // 3) "How did you hear" → Job board.
  try {
    const jb = page.getByText(/^job board$/i).first();
    if (await jb.count().catch(() => 0)) { await jb.click({ timeout: 3000 }).catch(() => {}); rec('select', 'How did you hear', 'Job board', 'done'); }
  } catch {}

  // 4) Essays (textareas).
  for (const f of fields) {
    if (matched.has(f.af) || f.tag !== 'textarea') continue;
    const text = essayFor(f.label);
    if (text === null) { rec('fill', f.label || 'essay', '', 'needs_user — personal/factual'); continue; }
    try { await loc(f.af).fill(text, { timeout: 5000 }); matched.add(f.af); rec('fill', f.label || 'essay', '(' + text.length + ' chars)', 'done'); }
    catch (e) { rec('fill', f.label || 'essay', '', 'failed:' + e.message.slice(0, 30)); }
  }

  // Reuse learned answers for any field the recipe/essays did not cover.
  for (const f of fields) {
    if (matched.has(f.af) || f.type === 'file' || f.type === 'radio' || !f.label) continue;
    const taught = learnedFor(f.label);
    if (!taught) continue;
    try {
      if (f.tag === 'select') {
        await loc(f.af).selectOption({ label: taught }).catch(async () => { await loc(f.af).selectOption(taught); });
      } else if (f.type === 'checkbox') {
        if (/^(yes|true|checked|on)$/i.test(taught)) await loc(f.af).check({ timeout: 4000 });
      } else {
        await loc(f.af).fill(taught, { timeout: 4000 });
      }
      matched.add(f.af); rec('fill', f.label, '(reused learned)', 'done');
    } catch {}
  }
  // Reuse learned radio-group answers (question -> chosen option): click the matching radio.
  await page.evaluate((arr) => {
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const groups = [...document.querySelectorAll('fieldset, [role=radiogroup]')];
    for (const { q, a } of arr) {
      const nq = norm(q), na = norm(a); if (!nq || !na) continue;
      const grp = groups.find(g => { const lg = g.querySelector('legend,label,.ashby-application-form-field-entry-label'); const t = lg ? norm(lg.innerText) : ''; return t && (t.includes(nq) || nq.includes(t)); });
      if (!grp) continue;
      for (const r of grp.querySelectorAll('input[type=radio]')) {
        const lbl = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText) || r.closest('label')?.innerText || r.value || '';
        if (norm(lbl) === na || (na.length > 2 && norm(lbl).includes(na))) { if (!r.checked) r.click(); break; }
      }
    }
  }, Object.values(learned).filter(e => e.answer && e.answer.length < 40).map(e => ({ q: e.label, a: e.answer }))).catch(() => {});

  awaitingSubmit = true;
  await setStatus('awaiting_submit');
  const rb = { num: +num, company: role.co, role: role.role, url: role.url, ats: atsName, cv: role.cv || '', submitted: false, steps: [...steps, { ts: new Date().toISOString(), action: 'handoff', field: 'Submit', value: 'window left open for user to finish + submit', status: 'awaiting_user_submit' }] };
  await writeFile(join(ROOT, `data/runbooks/${String(num).padStart(3, '0')}-${(atsName || 'ats')}.json`), JSON.stringify(rb, null, 2));
  console.log('\nFILLED. The window is open for you to review, finish any personal questions, and click Submit. I did NOT submit.');

  // --- Self-healing capture: learn any answer the USER types in a field we left blank ---
  const filledLabels = new Set(fields.filter(f => matched.has(f.af)).map(f => normLabel(f.label)));
  const readFields = () => page.evaluate(() => {
    const clean = s => (s || '').replace(/\*/g, '').trim().slice(0, 90);
    const lab = el => {
      let t = '';
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) t = l.innerText; }
      if (!t && el.getAttribute('aria-label')) t = el.getAttribute('aria-label');
      if (!t) { const l = el.closest('label'); if (l) t = l.innerText; }
      if (!t) { let p = el.parentElement, h = 0; while (p && h < 4 && !t) { const c = p.querySelector('label,legend'); if (c && !c.contains(el)) t = c.innerText; p = p.parentElement; h++; } }
      return clean(t);
    };
    const legend = el => { // the group question for a radio
      let p = el.parentElement, h = 0, t = '';
      while (p && h < 6 && !t) { const c = p.querySelector('legend,.ashby-application-form-field-entry-label'); if (c && !c.contains(el)) t = c.innerText; p = p.parentElement; h++; }
      return clean(t) || lab(el);
    };
    const out = [];
    // text inputs + textareas
    [...document.querySelectorAll('input, textarea')]
      .filter(e => !['hidden', 'file', 'submit', 'button', 'checkbox', 'radio', 'password'].includes(e.type))
      .forEach(e => { const v = (e.value || '').trim(); if (v.length > 1) out.push({ label: lab(e), value: v }); });
    // native dropdowns — store the selected option's visible text
    [...document.querySelectorAll('select')].forEach(e => {
      const o = e.options[e.selectedIndex]; const v = o ? o.text.trim() : '';
      if (v && !/^(select|choose|--|please|pick)\b/i.test(v)) out.push({ label: lab(e), value: v });
    });
    // chosen radio — key is the group question, value is the picked option
    [...document.querySelectorAll('input[type=radio]:checked')].forEach(e => {
      const opt = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText) || e.closest('label')?.innerText || e.value || '';
      const v = opt.trim().slice(0, 60); if (v) out.push({ label: legend(e), value: v });
    });
    return out.filter(x => x.label && x.value);
  }).catch(() => null);
  let learnedCount = 0, last = JSON.stringify(learned);
  while (!page.isClosed()) {
    try { await page.waitForTimeout(6000); } catch { break; } // page crashed/closed — stop quietly
    if (page.isClosed()) break;
    const snap = await readFields();
    if (!snap) break;
    for (const f of snap) {
      const n = normLabel(f.label);
      if (!n || filledLabels.has(n)) continue;        // only learn fields WE left for the user
      if (learned[n]?.answer === f.value) continue;
      learned[n] = { answer: f.value, label: f.label.slice(0, 90), source: 'user', role: role.co, num: +num, ts: new Date().toISOString() };
      learnedCount++;
    }
    const cur = JSON.stringify(learned);
    if (cur !== last) { await writeFile(join(ROOT, LEARNED_PATH), JSON.stringify(learned, null, 2)).catch(() => {}); last = cur; console.log(`  [learned] stored ${learnedCount} new answer(s) to the knowledge base`); }
  }
  await writeFile(join(ROOT, LEARNED_PATH), JSON.stringify(learned, null, 2)).catch(() => {});
} catch (e) {
  console.error('apply-fill error:', e.message);
  if (!awaitingSubmit) await setStatus('ready').catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
