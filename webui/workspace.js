(() => {
  const $ = id => document.getElementById(id);
  const form = $('setup-form');
  let step = 0, snapshot, busy = false, editing = false, loaded = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  async function api(path, data) {
    const response = await fetch(path, data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Unable to complete the request.');
    return result;
  }
  function error(message) { $('setup-error').textContent = message; $('setup-error').classList.toggle('hide', !message); }
  function navigate(view) {
    const pipeline = view === 'pipeline';
    $('home').classList.toggle('hide', pipeline); $('legacy-dashboard').classList.toggle('hide', !pipeline);
    document.querySelectorAll('.nav-link').forEach(b => b.classList.toggle('active', b.id === 'nav-' + view));
    if (view === 'profile') { editing = true; $('setup-card').classList.remove('hide'); $('automation-card').classList.add('hide'); showStep(0); }
    else if (!pipeline && snapshot?.settings.configured) { editing = false; $('setup-card').classList.add('hide'); $('automation-card').classList.remove('hide'); }
    window.scrollTo({ top:0, behavior:'instant' });
  }
  ['home','pipeline','profile'].forEach(v => $('nav-' + v).onclick = () => navigate(v));
  $('edit-profile').onclick = () => navigate('profile');
  function showStep(value) {
    step = value; error('');
    document.querySelectorAll('.setup-panel').forEach(p => p.classList.toggle('hide', Number(p.dataset.step) !== step));
    document.querySelectorAll('.setup-steps li').forEach((li, i) => { li.classList.toggle('current', i === step); li.classList.toggle('complete', i < step); if (i === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    $('step-count').textContent = `Step ${step + 1} of 3`; $('setup-back').classList.toggle('hide', step === 0);
    $('setup-next').innerHTML = step === 2 ? 'Save & launch search <span>↗</span>' : 'Continue <span>→</span>';
    $('setup-help').textContent = ['A few details. A more focused search.', 'Your story, in your own words.', 'Ready for your next chapter.'][step];
    $('setup-summary').innerHTML = ['fullName','roles','workMode'].map(key => `<span>${escape(form.elements[key].value)}</span>`).join('');
  }
  $('setup-back').onclick = () => showStep(Math.max(0, step - 1));
  form.noValidate = true;
  form.onsubmit = async e => {
    e.preventDefault(); if (busy) return;
    if (step === 0) {
      for (const input of form.querySelectorAll('[data-step="0"] input')) { if (!input.reportValidity()) return; }
      showStep(1); return;
    }
    if (step === 1) {
      if (!$('reuse-cv').checked && $('cv-text').value.trim().length < 100) return error('Upload or paste a CV with at least 100 characters, or use your saved CV.');
      showStep(2); return;
    }
    busy = true; $('setup-next').disabled = true; $('setup-back').disabled = true; $('setup-next').textContent = 'Saving your workspace…'; error('');
    try {
      const input = Object.fromEntries(new FormData(form));
      input.cvText = $('reuse-cv').checked ? '' : $('cv-text').value;
      await api('/api/onboarding', input);
      await api('/api/automation/start', {});
      editing = false; await refresh(); navigate('home');
      toast('Your search has started. Follow its progress below.');
    } catch (e) { error(e.message); }
    finally { busy = false; $('setup-next').disabled = false; $('setup-back').disabled = false; if (!$('setup-card').classList.contains('hide')) $('setup-next').textContent = 'Save & launch search ↗'; }
  };
  $('reuse-cv').onchange = () => { $('cv-text').disabled = $('reuse-cv').checked; };
  $('cv-text').oninput = () => { $('cv-count').textContent = `${$('cv-text').value.length.toLocaleString()} characters · Review your extracted CV before continuing.`; };
  async function upload(file) {
    if (!file) return;
    if (file.size > 5_000_000) return error('Please choose a CV smaller than 5 MB.');
    if (!/\.(pdf|md|txt)$/i.test(file.name)) return error('Choose a PDF, Markdown, or text file.');
    error(''); busy = true; $('setup-next').disabled = true; $('upload-label').textContent = 'Reading your CV…';
    try {
      const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read this file.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      const result = await api('/api/cv/extract', { name:file.name, content });
      $('cv-text').value = result.text; $('cv-text').disabled = false; $('reuse-cv').checked = false; $('cv-text').oninput(); $('upload-label').textContent = file.name + ' · Ready to review';
    } catch (e) { error(e.message); $('upload-label').textContent = 'Try another file, or paste your CV below'; }
    finally { busy = false; $('setup-next').disabled = false; }
  }
  $('cv-upload').onchange = e => upload(e.target.files[0]);
  ['dragenter','dragover'].forEach(type => $('drop-zone').addEventListener(type, e => { e.preventDefault(); $('drop-zone').classList.add('dragover'); }));
  ['dragleave','drop'].forEach(type => $('drop-zone').addEventListener(type, e => { e.preventDefault(); $('drop-zone').classList.remove('dragover'); if (type === 'drop') upload(e.dataTransfer.files[0]); }));
  function render() {
    const { settings:s, workflow:w } = snapshot;
    if (!loaded) {
      const defaults = { ...s.defaults, ...s };
      for (const [name, value] of Object.entries(defaults)) if (form.elements[name] && typeof value !== 'object') form.elements[name].value = value;
      form.elements.timezone.value = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      $('reuse-wrap').classList.toggle('hide', !s.cvPresent); $('reuse-cv').checked = s.cvPresent; $('cv-text').disabled = s.cvPresent;
      loaded = true;
    }
    const name = s.fullName || s.defaults.fullName;
    $('side-name').textContent = name || 'Your workspace'; $('side-avatar').textContent = name ? name.split(/\s+/).slice(0,2).map(n => n[0]).join('').toUpperCase() : 'CO';
    if (!editing) { $('setup-card').classList.toggle('hide', Boolean(s.configured)); $('automation-card').classList.toggle('hide', !s.configured); }
    $('workflow-heading').textContent = ({ running:'Your search is working.', complete:'Your latest search is ready.', failed:'This run needs attention.', paused:'Your search is paused.', interrupted:'Let’s pick up where you left off.', stopping:'Pausing your search…' })[w.status] || 'Ready when you are';
    $('workflow-detail').textContent = w.stage;
    $('run-auto').disabled = w.running; $('edit-profile').disabled = w.running;
    $('run-auto').textContent = w.running ? 'Running…' : 'Run now ↗'; $('pause-auto').disabled = !w.running && !w.enabled;
    $('nav-profile').disabled = w.running;
    document.querySelector('.workflow-track').classList.toggle('running', w.running);
    $('run-meta').textContent = (w.lastRun ? 'Last completed: ' + new Date(w.lastRun).toLocaleString() + ' · ' : '') + (w.nextRun ? 'Next scan: ' + new Date(w.nextRun).toLocaleString() : w.running ? 'Scanning in the background. You can use the pipeline while this runs.' : 'Scheduled scans run while this local server is open.');
    $('workflow-log').innerHTML = (w.log || []).slice(-10).reverse().map(l => `<p>${escape(new Date(l.time).toLocaleTimeString())} &nbsp; ${escape(l.message)}</p>`).join('');
    $('scan-output').textContent = w.scanTail || 'Scan output will appear here.';
    $('discoveries').classList.toggle('hide', !s.configured); $('match-count').textContent = w.matches.length;
    $('match-list').innerHTML = w.matches.length ? w.matches.map(m => {
      const url = /^https?:\/\//.test(m.url) ? m.url : '#';
      const packet = /^output\/[\w.-]+\.md$/.test(m.packet || '') ? m.packet : '';
      return `<article class="match-card"><div><span><span class="company-avatar">${escape(m.company.slice(0,2).toUpperCase())}</span>${escape(m.company)}</span><span>${escape(m.fit)}% title match</span></div><h3>${escape(m.title)}</h3><p>${escape(m.location)} · Posting checked during scan</p><div class="qacts"><a class="qbtn" href="${escape(url)}" target="_blank" rel="noopener noreferrer">View posting ↗</a>${packet ? `<a class="qbtn" href="/${escape(packet)}" target="_blank" rel="noopener noreferrer">Review packet →</a>` : ''}</div></article>`;
    }).join('') : `<div class="empty-matches">${w.running ? 'Looking for new opportunities. Verified discoveries will appear here when the scan finishes.' : 'No new discoveries yet. Run a scan or adjust your target roles and company portals.'}</div>`;
  }
  async function refresh() {
    try { snapshot = await api('/api/automation'); render(); }
    catch (e) { if (!loaded) error('Could not connect to the local server. Refresh to try again.'); else $('workflow-detail').textContent = 'Connection lost. Retrying…'; }
  }
  $('run-auto').onclick = async () => { $('run-auto').disabled = true; try { await api('/api/automation/start', {}); } catch (e) { toast(e.message); } await refresh(); };
  $('pause-auto').onclick = async () => { $('pause-auto').disabled = true; try { await api('/api/automation/stop', {}); } catch (e) { toast(e.message); } await refresh(); };
  refresh(); setInterval(refresh, 3000);
})();
