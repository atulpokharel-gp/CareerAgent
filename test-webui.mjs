import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const root = await mkdtemp(join(tmpdir(), 'career-ui-'));
const port = 14319;
let browser, server;
try {
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/profile.yml'), 'candidate: {}\n');
  await writeFile(join(root, 'portals.yml'), 'tracked_companies: []\n');
  server = spawn(process.execPath, ['server.mjs'], { cwd:process.cwd(), env:{ ...process.env, CAREER_OPS_ROOT:root, PORT:String(port) }, windowsHide:true });
  let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
  const base = `http://127.0.0.1:${port}`;
  let connected = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/automation')).ok) { connected = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(connected, logs);
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('[name=fullName]').fill('Alex Morgan');
  await page.locator('[name=email]').fill('alex@example.com');
  await page.locator('[name=location]').fill('New York, United States');
  await page.locator('[name=roles]').fill('Software Engineer, AI Engineer');
  await page.locator('[name=salary]').fill('$140,000–180,000 USD');
  await page.locator('[name=timezone]').fill('America/New_York');
  await page.screenshot({ path:'output/ui-desktop.png', fullPage:true });
  await page.locator('#setup-next').click();
  assert.equal(await page.locator('#step-count').textContent(), 'Step 2 of 3');
  await page.locator('#setup-next').click();
  assert.match(await page.locator('#setup-error').textContent(), /Upload or paste/);
  const cv = '# Alex Morgan\n\n## Experience\nSoftware engineer building Python services and React applications. Led delivery, testing, and production operations for a product team.\n';
  await page.locator('#cv-upload').setInputFiles({ name:'cv.md', mimeType:'text/markdown', buffer:Buffer.from(cv) });
  await page.waitForFunction(() => document.getElementById('cv-text').value.includes('Alex Morgan'));
  assert.equal(await page.locator('#cv-text').inputValue(), cv);
  const pdfPage = await browser.newPage();
  await pdfPage.setContent('<h1>Alex Morgan</h1><h2>Experience</h2><p>Software engineer building Python services and React applications. Led delivery, testing, and production operations for a product team.</p>');
  const pdf = await pdfPage.pdf(); await pdfPage.close();
  await page.locator('#cv-upload').setInputFiles({ name:'cv.pdf', mimeType:'application/pdf', buffer:pdf });
  await page.waitForFunction(() => document.getElementById('upload-label').textContent.includes('cv.pdf · Ready'));
  assert.match(await page.locator('#cv-text').inputValue(), /Python services/);
  await page.locator('#setup-next').click();
  assert.equal(await page.locator('#step-count').textContent(), 'Step 3 of 3');
  let started = false;
  // Test the actual save endpoint; isolate external discovery from browser tests.
  await page.route('**/api/automation/start', route => { started = true; return route.fulfill({ json:{ ok:true } }); });
  await page.locator('#setup-next').click();
  await page.locator('#automation-card').waitFor({ state:'visible' });
  assert.ok(started);
  assert.match(await readFile(join(root, 'cv.md'), 'utf8'), /Alex Morgan/);
  assert.match(await readFile(join(root, 'config/profile.yml'), 'utf8'), /Software Engineer/);
  await page.reload(); await page.locator('#automation-card').waitFor({ state:'visible' });
  await page.locator('#nav-pipeline').click(); await page.locator('#legacy-dashboard').waitFor({ state:'visible' });
  await page.locator('#nav-profile').click(); await page.locator('#setup-card').waitFor({ state:'visible' });
  assert.equal(await page.locator('[name=fullName]').inputValue(), 'Alex Morgan');
  await page.setViewportSize({ width:390, height:844 });
  await page.screenshot({ path:'output/ui-mobile.png', fullPage:true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout must not overflow');
  assert.equal((await fetch(base + '/api/onboarding', { method:'POST', headers:{ 'Content-Type':'application/json', Origin:'https://untrusted.example' }, body:'{}' })).status, 403);
  assert.equal((await fetch(base + '/api/onboarding')).status, 405);
  assert.deepEqual(errors, []);
  console.log('Passed: setup steps, validation, text/PDF uploads, real profile persistence, launch handoff, reload, navigation, mobile layout, origin checks; no browser errors.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  await rm(root, { recursive:true, force:true });
}
