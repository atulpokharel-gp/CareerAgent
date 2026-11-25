import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomation } from './automation.mjs';

const cv = '# Candidate\n\n## Experience\nBuilt Python services and React applications for a product team. Led delivery and maintained production software.\n';
async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), 'career-automation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/profile.yml'), 'candidate:\n  phone: preserved\nnarrative:\n  headline: Preserved headline\n');
  await writeFile(join(root, 'cv.md'), cv);
  await writeFile(join(root, 'portals.yml'), 'tracked_companies: []\n');
  await writeFile(join(root, 'scan.mjs'), script);
  return { root, app:createAutomation(root, { verify:async offers => offers.map(o => ({ ...o, verification:'active' })) }) };
}
const input = { fullName:'Test Candidate', email:'test@example.com', location:'New York', roles:'Software Engineer', workMode:'Remote', timezone:'America/New_York', intervalHours:0, cvText:cv };
async function finished(app) {
  for (let i = 0; i < 100; i++) {
    const { workflow } = await app.snapshot();
    if (!workflow.running) return workflow;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Workflow did not settle');
}
test('setup validates inputs and preserves unrelated personal settings', async t => {
  const { app, root } = await fixture(t, '');
  await assert.rejects(app.configure({ ...input, email:'invalid' }), /valid email/);
  await assert.rejects(app.configure({ ...input, cvText:'short' }), /readable CV/);
  await app.configure(input);
  assert.match(await readFile(join(root, 'config/profile.yml'), 'utf8'), /phone: preserved/);
  assert.match(await readFile(join(root, 'config/profile.yml'), 'utf8'), /Preserved headline/);
  assert.equal((await app.snapshot()).settings.configured, true);
  assert.equal((await app.extract({ name:'cv.txt', content:Buffer.from(cv).toString('base64') })).text, cv);
  await assert.rejects(app.extract({ name:'cv.exe', content:'' }), /Upload a PDF/);
});
test('one launch scans verified roles, deduplicates discoveries, and creates actual packets', async t => {
  const { app, root } = await fixture(t, `if (!process.argv.includes('--json')) process.exit(2); console.log(JSON.stringify({version:'careerops.scan.receipt@1',added_urls:['https://example.com/jobs/1'],errors:[]}));`);
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/pipeline.md'), '- [ ] https://example.com/jobs/1 | Example | Software Engineer | Remote\n');
  await app.configure(input);
  await app.run();
  const first = await finished(app);
  assert.equal(first.status, 'complete');
  assert.equal(first.matches.length, 1);
  assert.equal(first.matches[0].fit, 100);
  assert.match(await readFile(join(root, first.matches[0].packet), 'utf8'), /not a full fit evaluation/);
  assert.equal(first.enabled, false);
  await app.run(); await finished(app);
  assert.equal((await app.snapshot()).workflow.matches.length, 1);
});
test('scan failures surface as failures instead of successful empty results', async t => {
  const { app } = await fixture(t, 'console.error("Source unavailable"); process.exit(1);');
  await app.configure(input); await app.run();
  const state = await finished(app);
  assert.equal(state.status, 'failed');
  assert.match(state.scanTail, /Source unavailable/);
});
test('pause cancels an in-flight scan, blocks duplicate runs, and clears schedule', async t => {
  const { app } = await fixture(t, 'setTimeout(()=>{},30000);');
  await app.configure({ ...input, intervalHours:6 }); await app.run();
  assert.equal((await app.run()).ok, false);
  await assert.rejects(app.configure(input), /current operation/);
  await app.stop();
  const state = await finished(app);
  assert.equal(state.status, 'paused'); assert.equal(state.enabled, false); assert.equal(state.nextRun, null);
});
test('recurring runs persist their next scan and can be paused', async t => {
  const { app, root } = await fixture(t, `console.log(JSON.stringify({version:'careerops.scan.receipt@1',added_urls:[],errors:[]}));`);
  await app.configure({ ...input, intervalHours:6 }); await app.run();
  const state = await finished(app);
  assert.equal(state.enabled, true); assert.ok(Date.parse(state.nextRun) > Date.now());
  assert.equal(JSON.parse(await readFile(join(root, 'data/automation.json'), 'utf8')).nextRun, state.nextRun);
  await app.stop(); assert.equal((await app.snapshot()).workflow.nextRun, null);
});
test('integrates with the installed scanner receipt without live portal requests', async t => {
  const { root } = await fixture(t, '');
  const app = createAutomation(root, { codeRoot:process.cwd() });
  await app.configure(input); await app.run();
  const state = await finished(app);
  assert.equal(state.status, 'complete', state.stage + '\n' + state.scanTail);
  assert.equal(state.matches.length, 0);
});
