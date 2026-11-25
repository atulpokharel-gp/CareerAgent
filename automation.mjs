import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';

const exec = promisify(execFile);
async function verifyPostings(offers, isStopped) {
  if (!offers.length) return [];
  const [{ chromium }, { newLivenessPage, checkUrlLiveness }] = await Promise.all([import('playwright'), import('./liveness-browser.mjs')]);
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await newLivenessPage(browser);
    const results = [];
    for (const offer of offers) {
      if (isStopped()) break;
      const verdict = await checkUrlLiveness(page, offer.url);
      results.push({ ...offer, verification: verdict.result, verificationReason: verdict.reason });
    }
    return results;
  } finally { await browser.close(); }
}
export function createAutomation(root = getCareerOpsRoot(), { verify = verifyPostings, codeRoot = root } = {}) {
  const file = p => join(root, p);
  const read = async (p, fallback = '') => { try { return await readFile(file(p), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
  const json = async (p, fallback) => JSON.parse(await read(p, JSON.stringify(fallback)));
  let writes = Promise.resolve();
  const save = (p, value) => {
    const text = JSON.stringify(value, null, 2);
    const next = writes.catch(() => {}).then(async () => { await mkdir(join(root, 'data'), { recursive: true }); await writeFile(file(p + '.tmp'), text); await rename(file(p + '.tmp'), file(p)); });
    writes = next; return next;
  };
  let running = false, timer, child, stopping = false, saving = false;
  const state = { status: 'idle', stage: 'Ready to start', log: [], matches: [], enabled: false };
  const ready = (async () => {
    Object.assign(state, await json('data/automation.json', {}));
    if (['running', 'stopping'].includes(state.status)) { state.status = 'interrupted'; state.stage = 'Previous run interrupted. Start again to resume.'; }
  })();
  const persist = () => save('data/automation.json', state);
  async function event(stage) {
    state.stage = stage; state.log = [...state.log.slice(-39), { time: new Date().toISOString(), message: stage }];
    await persist();
  }
  async function settings() {
    const profile = yaml.load(await read('config/profile.yml')) || {};
    return { ...(await json('data/automation-profile.json', {})), defaults: {
      fullName: profile.candidate?.full_name || '', email: profile.candidate?.email || '',
      location: profile.candidate?.location || '', timezone: profile.location?.timezone || 'America/New_York',
      roles: (profile.target_roles?.primary || []).join(', '), salary: profile.compensation?.target_range || '',
    }, cvPresent: Boolean((await read('cv.md')).trim()) };
  }
  async function configure(input) {
    await ready;
    if (running || saving) throw new Error('Wait for the current operation to finish before editing your profile.');
    const clean = {};
    for (const key of ['fullName', 'email', 'location', 'timezone', 'roles', 'salary', 'workMode', 'skills', 'dealbreakers']) clean[key] = String(input[key] || '').trim().slice(0, 2000);
    if (!clean.fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email) || !clean.location || !clean.roles) throw new Error('Name, a valid email, location, and target roles are required.');
    clean.intervalHours = Number(input.intervalHours);
    if (![0, 6, 12, 24, 72].includes(clean.intervalHours)) throw new Error('Choose a supported scan frequency.');
    const cv = String(input.cvText || await read('cv.md')).trim();
    if (cv.length < 100 || cv.length > 300000) throw new Error('Provide a readable CV between 100 and 300,000 characters.');
    const profile = yaml.load(await read('config/profile.yml')) || {};
    profile.candidate = { ...profile.candidate, full_name: clean.fullName, email: clean.email, location: clean.location };
    profile.target_roles = { ...profile.target_roles, primary: clean.roles.split(',').map(s => s.trim()).filter(Boolean) };
    profile.location = { ...profile.location, timezone: clean.timezone };
    profile.compensation = { ...profile.compensation, target_range: clean.salary, location_flexibility: clean.workMode };
    profile.narrative = { ...profile.narrative, search_preferences: clean.dealbreakers, search_skills: clean.skills };
    saving = true;
    try {
      // Preserve previous canonical inputs before an explicit setup save.
      const stamp = Date.now();
      await mkdir(file('data/onboarding-backups'), { recursive: true });
      await writeFile(file(`data/onboarding-backups/${stamp}-profile.yml`), await read('config/profile.yml'));
      await writeFile(file(`data/onboarding-backups/${stamp}-cv.md`), await read('cv.md'));
      await mkdir(file('config'), { recursive: true });
      await writeFile(file('config/profile.yml'), yaml.dump(profile, { lineWidth: -1 }));
      await writeFile(file('cv.md'), cv + '\n');
      await save('data/automation-profile.json', { ...clean, configured: true, updatedAt: new Date().toISOString() });
      return { ok: true };
    } finally { saving = false; }
  }
  async function extract({ name, content }) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (!['pdf', 'md', 'txt'].includes(ext)) throw new Error('Upload a PDF, Markdown, or text CV.');
    if (typeof content !== 'string' || content.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Use a CV smaller than 5 MB.');
    const buffer = Buffer.from(content, 'base64');
    if (ext !== 'pdf') return { text: buffer.toString('utf8').replace(/^\uFEFF/, '') };
    if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('This file is not a valid PDF.');
    await mkdir(file('data/uploads'), { recursive: true });
    const path = file(`data/uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    await writeFile(path, buffer);
    try {
      let text;
      try { text = (await exec('pdftotext', ['-layout', path, '-'], { timeout: 20000, maxBuffer: 2_000_000, windowsHide: true })).stdout; }
      catch { text = (await exec('python', ['-c', 'from pypdf import PdfReader; import sys; print("\\n".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages))', path], { timeout: 20000, maxBuffer: 2_000_000, windowsHide: true })).stdout; }
      if (text.trim().length < 100) throw new Error('This PDF has too little readable text. Paste your CV text instead.');
      return { text };
    } catch (e) { throw new Error(e.message.startsWith('This PDF') ? e.message : 'PDF text extraction is unavailable. Install pdftotext or Python pypdf, or paste your CV text.'); }
    finally { const { unlink } = await import('node:fs/promises'); await unlink(path).catch(() => {}); }
  }
  async function run() {
    await ready;
    if (running || saving) return { ok: false, error: 'An operation is already running.' };
    const config = await settings();
    if (!config.configured) throw new Error('Complete your profile and CV first.');
    running = true; stopping = false; clearTimeout(timer); state.enabled = true; state.status = 'running'; state.startedAt = new Date().toISOString(); state.nextRun = null;
    await event('Scanning company career pages');
    void execute(config).finally(() => { running = false; });
    return { ok: true };
  }
  async function execute(config) {
    try {
      const portals = yaml.load(await read('portals.yml')) || {};
      portals.title_filter = { ...portals.title_filter, positive: config.roles.split(',').map(s => s.trim()).filter(Boolean) };
      if (config.workMode === 'Remote') portals.location_filter = { allow: ['remote'], block: [] };
      await writeFile(file('data/automation-portals.yml'), yaml.dump(portals));
      if (stopping) return;
      let output = '', receiptText = '';
      await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [join(codeRoot, 'scan.mjs'), '--json'], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT:root, CAREER_OPS_PORTALS: file('data/automation-portals.yml') }, windowsHide: true });
        const timeout = setTimeout(() => { child?.kill(); reject(new Error('Scan timed out after 20 minutes. Retry or reduce your company list.')); }, 1200000);
        const collect = d => { output = (output + d).slice(-500000); state.scanTail = output.slice(-6000); };
        child.stdout.on('data', d => { receiptText += d; collect(d); }); child.stderr.on('data', collect);
        child.on('error', e => { clearTimeout(timeout); reject(e); });
        child.on('close', code => { clearTimeout(timeout); child = null; code === 0 || code === 2 && receiptText.includes('careerops.scan.receipt@1') || stopping ? resolve() : reject(new Error('Scanner failed. See scan details for the error.')); });
      });
      if (stopping) return;
      const receipt = JSON.parse(receiptText);
      if (receipt.version !== 'careerops.scan.receipt@1' || !Array.isArray(receipt.added_urls)) throw new Error('Scanner returned an unsupported receipt.');
      const urls = new Set(receipt.added_urls);
      const discovered = (await read('data/pipeline.md')).split('\n').map(line => {
        const row = line.match(/^- \[ \] (https?:\/\/\S+)\s*\|\s*(.*)$/);
        if (!row || !urls.has(row[1])) return null;
        const [company, title, location = 'Not specified'] = row[2].split('|').map(s => s.trim());
        return { url:row[1], company, title, location };
      }).filter(Boolean);
      const pending = [...(state.pendingChecks || []), ...discovered];
      state.pendingChecks = [...new Map(pending.map(o => [o.url, o])).values()];
      await event(`Checking ${state.pendingChecks.length} discovered posting(s) with Playwright`);
      const checked = await verify(state.pendingChecks, () => stopping);
      state.pendingChecks = state.pendingChecks.filter(o => !checked.some(c => c.url === o.url && c.verification !== 'uncertain'));
      if (stopping) return;
      await event('Matching discovered roles to your targets');
      const roles = checked.filter(o => o.verification === 'active');
      const targets = config.roles.toLowerCase().split(',').map(s => s.trim());
      const matches = roles.map(({ company, title, location, url }) => {
        const tokens = [...new Set(targets.flatMap(t => t.split(/\W+/)).filter(t => t.length > 1))];
        const matched = tokens.filter(t => title.toLowerCase().split(/\W+/).includes(t));
        const fit = Math.round(matched.length / Math.max(tokens.length, 1) * 100);
        return { company, title, location, url, fit, matched, verification: 'Playwright checked during scan', needsReview: ['Full job requirements', 'Salary range', 'Location and work authorization', 'Deal-breakers and skills'] };
      }).sort((a, b) => b.fit - a.fit);
      await event('Preparing shortlist and review packets');
      if (stopping) return;
      await mkdir(file('output'), { recursive: true });
      const cv = await read('cv.md');
      for (const [i, match] of matches.slice(0, 12).entries()) {
        const name = `review-${Date.now()}-${i}.md`;
        const safe = s => String(s).replace(/[\r\n]/g, ' ');
        await writeFile(file('output/' + name), `# Application review: ${safe(match.company)}\n\n**Role:** ${safe(match.title)}\n\n**URL:** ${match.url}\n\n**Verification:** ${match.verification}\n\n## Preliminary title match\n\n${match.fit}% keyword overlap with your target titles. This is not a full fit evaluation or an application recommendation.\n\nMatched terms: ${match.matched.join(', ') || 'None'}\n\n## Review before applying\n\n- Check full requirements, salary, location and work authorization.\n- Confirm deal-breakers: ${safe(config.dealbreakers || 'None provided')}\n- Select relevant evidence from your CV; confirm every claim.\n- Generate a tailored CV after a full evaluation.\n\n## Source CV\n\n${cv}\n`);
        match.packet = 'output/' + name;
      }
      state.matches = [...matches, ...state.matches.filter(old => !matches.some(m => m.url === old.url))].slice(0, 100);
      state.lastRun = new Date().toISOString(); state.status = 'complete';
      state.summary = `${matches.length} new role${matches.length === 1 ? '' : 's'} discovered. ${Math.min(matches.length, 12)} review packets prepared.`;
      if (receipt.errors?.length) state.summary += ` ${receipt.errors.length} company sources reported errors; see scan details.`;
      if (state.pendingChecks.length) state.summary += ` ${state.pendingChecks.length} posting(s) remain unconfirmed and will be retried.`;
      await event(state.summary);
    } catch (e) { state.status = 'failed'; await event(e.message); }
    finally {
      child = null;
      if (stopping) { state.status = 'paused'; state.enabled = false; await event('Automation paused'); }
      if (state.enabled && config.intervalHours) {
        state.nextRun = new Date(Date.now() + config.intervalHours * 3600000).toISOString();
        timer = setTimeout(() => run().catch(async e => { state.status = 'failed'; await event(e.message); }), config.intervalHours * 3600000); timer.unref();
      } else { state.enabled = false; state.nextRun = null; }
      await persist();
    }
  }
  async function stop() {
    await ready; clearTimeout(timer); state.enabled = false; state.nextRun = null; stopping = true;
    if (running) { state.status = 'stopping'; child?.kill(); } else { state.status = 'paused'; }
    await event(running ? 'Pausing after the current operation' : 'Automation paused'); return { ok: true };
  }
  async function snapshot() { await ready; return { settings: await settings(), workflow: { ...state, running } }; }
  // Restore an opted-in recurring schedule when the local server restarts.
  ready.then(async () => {
    if (state.enabled && state.nextRun) {
      const wait = Math.max(1000, new Date(state.nextRun).getTime() - Date.now());
      timer = setTimeout(() => run().catch(async e => { state.status = 'failed'; await event(e.message); }), Math.min(wait, 2147483647)); timer.unref();
    }
  });
  return { settings, configure, extract, run, stop, snapshot };
}
