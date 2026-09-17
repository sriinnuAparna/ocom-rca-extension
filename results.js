'use strict';
let analysisResult = null;
let _token = '';

// ── Pause / Resume state ──────────────────────────────────────────────────────
let _paused = false;
let _pauseResolve = null;
let _analysisRunning = false;

function togglePause() {
  _paused = !_paused;
  const btn = document.getElementById('btn-pause-resume');
  const counter = document.getElementById('progress-scenario-count');
  if (_paused) {
    btn.textContent = '▶ Resume';
    btn.classList.add('paused');
    if (counter) counter.textContent = '⏸ Paused';
    log('Analysis paused — click Resume to continue', 'warn');
  } else {
    btn.textContent = '⏸ Pause';
    btn.classList.remove('paused');
    log('Analysis resumed', 'ok');
    if (_pauseResolve) { _pauseResolve(); _pauseResolve = null; }
  }
}

async function checkPause() {
  if (_paused) await new Promise(r => { _pauseResolve = r; });
}

// ── Live log ──────────────────────────────────────────────────────────────────
let _logCount = 0;
let _logCollapsed = false;

function log(msg, level = 'info') {
  const body = document.getElementById('log-body');
  if (!body) return;
  // Remove placeholder text on first entry
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();

  _logCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const row = document.createElement('div');
  row.className = 'log-row';
  const msgSpan = document.createElement('span');
  msgSpan.className = `log-msg ${level}`;
  msgSpan.textContent = msg;
  const tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = ts;
  row.appendChild(tsSpan);
  row.appendChild(msgSpan);
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;

  const countEl = document.getElementById('log-count');
  if (countEl) countEl.textContent = `${_logCount} events`;
}

function logSep() {
  const body = document.getElementById('log-body');
  if (!body) return;
  const sep = document.createElement('div');
  sep.className = 'log-sep';
  body.appendChild(sep);
}

// ── Checkpoint save / load ────────────────────────────────────────────────────
function cpKey(runId) { return `rca_cp_${runId}`; }

async function saveCheckpoint(runId, data) {
  try {
    await chrome.storage.local.set({ [cpKey(runId)]: { ...data, savedAt: Date.now() } });
  } catch {}
}

async function loadCheckpoint(runId) {
  try {
    const r = await chrome.storage.local.get(cpKey(runId));
    return r[cpKey(runId)] || null;
  } catch { return null; }
}

async function clearCheckpoint(runId) {
  try { await chrome.storage.local.remove(cpKey(runId)); } catch {}
}

const STAGE_DEFS = [
  ['workflow',    '⚙',  'Workflow run'],
  ['jobs',        '📋', 'Jobs collected'],
  ['logs',        '📄', 'Logs fetched'],
  ['artifacts',   '📦', 'Artifacts'],
  ['scenarios',   '🧪', 'Scenarios extracted'],
  ['environment', '🌍', 'Environment detected'],
  ['actuator',    '🔍', 'Actuator queried'],
  ['app_code',    '💻', 'App code inspected'],
  ['auto_code',   '🤖', 'Automation inspected'],
  ['commits',     '📝', 'Commits analyzed'],
  ['rca',         '🎯', 'RCA generated'],
];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  // Wire static buttons
  document.getElementById('btn-export-json')?.addEventListener('click', () => exportAs('json'));
  document.getElementById('btn-export-md')?.addEventListener('click',   () => exportAs('markdown'));
  document.getElementById('btn-export-html')?.addEventListener('click', () => exportAs('html'));
  document.getElementById('btn-back')?.addEventListener('click', closeDetail);
  document.getElementById('btn-pause-resume')?.addEventListener('click', togglePause);
  document.getElementById('btn-toggle-log')?.addEventListener('click', () => {
    _logCollapsed = !_logCollapsed;
    const body = document.getElementById('log-body');
    const btn  = document.getElementById('btn-toggle-log');
    body.classList.toggle('collapsed', _logCollapsed);
    btn.textContent = _logCollapsed ? 'Show' : 'Hide';
  });
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    const body = document.getElementById('log-body');
    body.innerHTML = '';
    _logCount = 0;
    document.getElementById('log-count').textContent = '0 events';
  });

  // Event delegation for reanalyze buttons inside detail view
  document.getElementById('detail-body').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="reanalyze"]');
    if (btn) reanalyzeScenario(parseInt(btn.dataset.idx, 10));
  });

  const params = new URLSearchParams(location.search);
  const runUrl = params.get('url');
  if (!runUrl) { showStageError('No run URL provided'); return; }

  const runId = runUrl.split('/').pop();
  document.title = 'RCA — ' + runId;
  document.getElementById('run-link').innerHTML =
    `<a href="${esc(runUrl)}" target="_blank" class="run-url-link">${esc(runUrl)}</a>`;

  buildProgressGrid();

  const { githubToken } = await chrome.storage.local.get('githubToken');
  _token = githubToken || '';

  if (!_token) {
    showStageError('No GitHub token found. <a href="#" id="err-sl" style="color:#58a6ff">Open ⚙ Settings</a> and save your token first.');
    document.getElementById('err-sl')?.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    return;
  }

  log(`Token found. Verifying with GitHub API…`, 'dim');
  const tokenCheck = await verifyToken(_token);
  if (!tokenCheck.ok) {
    const err = tokenCheck.error || '';
    if (err.startsWith('TOKEN_INVALID')) {
      showStageError('GitHub token is invalid or expired. <a href="#" id="err-sl" style="color:#58a6ff">Open ⚙ Settings</a> to update it.');
      document.getElementById('err-sl')?.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
      return;
    }
    log(`Token verification warning: ${err} — proceeding anyway`, 'warn');
  } else {
    log(`Token OK — authenticated as ${tokenCheck.user}`, 'ok');
    document.getElementById('run-link').innerHTML +=
      `<span style="font-size:11px;color:var(--muted);margin-left:12px">👤 ${esc(tokenCheck.user)}</span>`;
  }

  // ── Check for saved checkpoint ────────────────────────────────────────────────
  const cp = await loadCheckpoint(runId);
  if (cp && cp.analyzed && cp.analyzed.length > 0) {
    const savedAgo = Math.round((Date.now() - cp.savedAt) / 60000);
    const banner = document.getElementById('resume-banner');
    document.getElementById('resume-desc').textContent =
      `${cp.analyzed.length} of ${cp.totalScenarios || '?'} scenarios done — saved ${savedAgo < 60 ? savedAgo + 'm ago' : Math.round(savedAgo/60) + 'h ago'}`;
    banner.classList.remove('hidden');

    document.getElementById('btn-resume-saved').addEventListener('click', async () => {
      banner.classList.add('hidden');
      log(`Restoring checkpoint: ${cp.analyzed.length} scenarios already done`, 'ok');
      await startAnalysis(runUrl, _token, cp);
    });
    document.getElementById('btn-restart-fresh').addEventListener('click', async () => {
      banner.classList.add('hidden');
      await clearCheckpoint(runId);
      log('Starting fresh (checkpoint cleared)', 'warn');
      await startAnalysis(runUrl, _token, null);
    });
  } else {
    await startAnalysis(runUrl, _token, null);
  }
});

async function startAnalysis(runUrl, token, checkpoint) {
  const runId = runUrl.split('/').pop();
  document.getElementById('btn-pause-resume').classList.remove('hidden');
  _analysisRunning = true;

  try {
    await runAnalysis(runUrl, token, checkpoint);
  } catch (e) {
    _analysisRunning = false;
    const msg = e.message || String(e);
    log(`Analysis error: ${msg}`, 'err');
    if (msg.startsWith('NOT_FOUND_404')) {
      showStageError(
        '404 — Run not found. Possible causes:<br>' +
        '1. <strong>SSO not authorized</strong> — go to ' +
        '<a href="https://github.com/settings/tokens" target="_blank" style="color:#58a6ff">github.com/settings/tokens</a>' +
        ' → Configure SSO → Authorize <strong>Albertsons</strong>.<br>' +
        '2. Token lacks <strong>repo</strong> scope.<br>' +
        '3. Run ID <strong>' + esc(runId) + '</strong> does not exist or was deleted.'
      );
    } else if (msg.startsWith('TOKEN_INVALID') || msg.startsWith('TOKEN_NO_ACCESS')) {
      showStageError(
        'GitHub access denied. Authorize your token for SSO: ' +
        '<a href="https://github.com/settings/tokens" target="_blank" style="color:#58a6ff">github.com/settings/tokens</a>' +
        ' → Configure SSO → Authorize <strong>Albertsons</strong>.'
      );
    } else {
      showStageError(`Analysis failed: ${msg}`);
    }
  }
}

function buildProgressGrid() {
  document.getElementById('progress-grid').innerHTML = STAGE_DEFS.map(([key, icon, label]) =>
    `<div class="stage-item stage-pending" id="st-${key}">
       <span class="st-icon">◌</span>
       <span>${icon} ${label}</span>
       <span class="st-val" id="stv-${key}"></span>
     </div>`
  ).join('');
}

function setStage(key, status, val = '') {
  const el = document.getElementById(`st-${key}`);
  if (!el) return;
  el.className = `stage-item stage-${status}`;
  el.querySelector('.st-icon').textContent = status === 'ok' ? '✓' : status === 'error' ? '✗' : '⋯';
  const v = document.getElementById(`stv-${key}`);
  if (v) v.textContent = val;
}

// ── Main analysis pipeline ────────────────────────────────────────────────────
async function runAnalysis(runUrl, token, checkpoint) {
  const { owner, repo, runId } = parseRunUrl(runUrl);
  const runIdStr = String(runId);
  logSep();
  log(`Starting analysis: ${owner}/${repo} run #${runId}`, 'info');

  await checkPause();
  setStage('workflow', 'pending');
  log(`Fetching workflow run details…`, 'dim');
  const runData = await getWorkflowRun(owner, repo, runId, token);
  setStage('workflow', 'ok', runData.display_title || runData.name || 'ok');
  log(`Workflow: "${runData.display_title || runData.name}" — ${runData.conclusion || runData.status} — branch: ${runData.head_branch}`, 'ok');

  await checkPause();
  setStage('jobs', 'pending');
  log(`Fetching jobs list…`, 'dim');
  const allJobs = await getWorkflowJobs(owner, repo, runId, token);
  setStage('jobs', 'ok', `${allJobs.length} jobs`);
  const failed = allJobs.filter(j => j.conclusion === 'failure');
  log(`Jobs: ${allJobs.length} total, ${failed.length} failed — ${allJobs.map(j => j.name).join(', ')}`, 'info');

  const targetJobs = pickTargetJobs(allJobs);
  log(`Target jobs for log parsing: ${targetJobs.map(j => j.name).join(', ')}`, 'dim');

  // ── CHECKPOINT FAST PATH: skip all downloads if scenario list already saved ───
  // On resume, logs are NOT re-downloaded — we use the saved scenario list directly.
  if (checkpoint?.scenarioList?.length > 0) {
    log(`Checkpoint has ${checkpoint.scenarioList.length} scenarios — skipping log/artifact download ✓`, 'ok');
    setStage('logs',      'ok', 'skipped (checkpoint)');
    setStage('artifacts', 'ok', 'skipped (checkpoint)');
    setStage('scenarios', 'ok', `${checkpoint.scenarioList.length} found`);
    setStage('environment', 'ok', checkpoint.environment || 'unknown');

    const unique = checkpoint.scenarioList;
    const env    = checkpoint.environment || detectEnvironment(runData, allJobs, {});
    log(`Environment (from checkpoint): ${env}`, 'ok');

    const groups    = groupScenarios(unique);
    const groupList = [...groups.entries()];
    logSep();
    log(`Grouped ${unique.length} scenario(s) into ${groupList.length} group(s)`, 'ok');

    const actuatorCache = {};
    const analyzed  = checkpoint.analyzed ? [...checkpoint.analyzed] : [];
    const doneKeys  = new Set(analyzed.map(a => a.groupKey).filter(Boolean));
    if (analyzed.length > 0) {
      log(`Checkpoint: ${doneKeys.size} groups done, ${analyzed.length} scenarios`, 'ok');
      for (const item of analyzed) {
        if (item.actuator?.status === 'ok') actuatorCache[item.module] = item.actuator;
      }
      document.getElementById('table-card').classList.remove('hidden');
      document.getElementById('fail-count').textContent = analyzed.length;
      renderTableBody(analyzed);
    }

    const pendingGroups = groupList.filter(([key]) => !doneKeys.has(key));
    logSep();
    log(`Analyzing ${pendingGroups.length} remaining group(s)…`, 'info');

    for (let gi = 0; gi < pendingGroups.length; gi++) {
      await checkPause();
      const [key, members] = pendingGroups[gi];
      const doneGroups = doneKeys.size + gi;
      const totalGroups = groupList.length;
      const counterEl = document.getElementById('progress-scenario-count');
      if (counterEl && !_paused)
        counterEl.textContent = `Group ${doneGroups + 1}/${totalGroups} — ${analyzed.length}/${unique.length} scenarios`;
      logSep();
      log(`[Group ${doneGroups + 1}/${totalGroups}] ${key} (${members.length} scenario${members.length > 1 ? 's' : ''})`, 'info');
      const representative = members[0];
      const item = await analyzeOneFailure(representative, env, actuatorCache, token);
      for (const member of members) {
        analyzed.push({ ...item, failure: member, groupKey: key, groupSize: members.length, isRepresentative: member === representative });
        updateTableRow(analyzed.length - 1, analyzed[analyzed.length - 1]);
      }
      if (members.length > 1)
        log(`  → Applied same RCA to ${members.length} scenarios (${members.length - 1} skipped — same group)`, 'ok');
      await saveCheckpoint(runIdStr, { analyzed, scenarioList: unique, totalScenarios: unique.length, environment: env, runUrl });
      log(`  ✓ Checkpoint saved (${analyzed.length}/${unique.length} scenarios, ${doneGroups + 1}/${totalGroups} groups)`, 'dim');
    }

    setStage('rca', 'ok', 'done');
    _analysisRunning = false;
    document.getElementById('btn-pause-resume').classList.add('hidden');
    document.getElementById('progress-scenario-count').textContent =
      `${analyzed.length} scenarios in ${groupList.length} groups`;
    const clsCounts = {};
    for (const a of analyzed) { const c = a.rca.classification; clsCounts[c] = (clsCounts[c] || 0) + 1; }
    analysisResult = { run: runData, environment: env, mvnSummary: {}, total: unique.length, groups: groupList.length, clsCounts, analyzed };
    renderSummary();
    renderTableBody(analyzed);
    document.getElementById('table-card').classList.remove('hidden');
    document.getElementById('fail-count').textContent = analyzed.length;
    logSep();
    log(`Analysis complete — ${analyzed.length} scenarios, ${groupList.length} groups`, 'ok');
    return;
  }

  // ── FAST PATH: Check-Run Annotations (JSON API — milliseconds, no download) ──
  let failuresFromAnnotations = [];
  try {
    log('Checking for test annotations (instant)…', 'dim');
    const annResults = await Promise.all(
      targetJobs.map(job => getJobAnnotations(owner, repo, job, token))
    );
    const allAnns = annResults.flat();
    const failAnns = allAnns.filter(a => a.annotation_level === 'failure');
    if (failAnns.length > 0) {
      failuresFromAnnotations = parseAnnotations(failAnns);
      log(`Annotations: ${failAnns.length} failure annotations → ${failuresFromAnnotations.length} scenarios`, 'ok');
    } else {
      log(`No annotations found — will extract scenarios from logs`, 'dim');
    }
  } catch (e) {
    log(`Annotation check skipped: ${e.message}`, 'dim');
  }

  // ── Artifacts + Logs fetched IN PARALLEL — total time = slowest of the two ────
  await checkPause();
  setStage('artifacts', 'pending');
  setStage('logs', 'pending');
  log('Fetching artifacts and job logs in parallel…', 'info');

  const [failuresFromArtifacts, jobLogs] = await Promise.all([

    // ── Artifacts (Cucumber JSON ZIP — fast, usually < 30s) ───────────────────
    getArtifacts(owner, repo, runId, token)
      .then(async artifacts => {
        setStage('artifacts', 'ok', `${artifacts.length} artifacts`);
        log(`Artifacts: ${artifacts.map(a => a.name).join(', ') || 'none'}`, artifacts.length ? 'info' : 'dim');
        const failures = [];
        for (const art of artifacts) {
          const n = (art.name || '').toLowerCase();
          if ((n.includes('cucumber') || n.includes('report') || n.includes('test')) && !art.expired) {
            log(`  Downloading artifact: ${art.name}…`, 'dim');
            const buf = await downloadArtifactZip(owner, repo, art.id, token);
            if (buf) {
              try {
                const parsed = await parseZipForCucumber(buf);
                failures.push(...parsed);
                log(`  → ${parsed.length} failures from Cucumber JSON`, parsed.length ? 'ok' : 'dim');
              } catch {}
            }
          }
        }
        return failures;
      })
      .catch(e => {
        setStage('artifacts', 'error', e.message?.substring(0, 40));
        log(`Artifacts error: ${e.message}`, 'err');
        return [];
      }),

    // ── Logs (all target jobs downloaded simultaneously) ──────────────────────
    Promise.all(
      targetJobs.map(job => {
        // Use the prefix before "/" to distinguish "ReRun" from "Run-Integration"
        // e.g. "ReRun-FailedIntegrationTests / maven-tests" → "ReRun"
        const prefix = job.name.includes('/')
          ? job.name.split('/')[0].trim()
              .replace(/FailedIntegrationTests?/i, '')
              .replace(/IntegrationTests?/i, '')
              .replace(/-+$/, '') || job.name.split('/')[0].trim()
          : job.name;
        const label = prefix.substring(0, 18);
        log(`  [${label}] Starting log fetch (id ${job.id})…`, 'dim');
        return getJobLogs(owner, repo, job.id, token,
          msg => log(`  [${label}] ${msg}`, 'dim'))
          .then(text => ({ id: job.id, name: job.name, label, text }));
      })
    ).then(results => {
      const logs = {};
      for (const { id, label, text } of results) {
        logs[id] = text;
        const sizeMb   = (text.length / 1024 / 1024).toFixed(1);
        const truncated = text.includes('[... log truncated');
        log(`  [${label}] ✓ ${sizeMb} MB ready${truncated ? ' (last 10 MB)' : ''}`,
            truncated ? 'warn' : text.length ? 'ok' : 'warn');
      }
      setStage('logs', 'ok', `${Object.values(logs).filter(Boolean).length} fetched`);
      return logs;
    }),

  ]);

  await checkPause();
  setStage('scenarios', 'pending');
  // Priority: annotations (instant) → artifacts (ZIP) → logs (raw text)
  let all = [...failuresFromAnnotations, ...failuresFromArtifacts];
  for (const job of targetJobs) {
    const fromLogs = parseJobLogs(jobLogs[job.id] || '', job.name);
    if (fromLogs.length) log(`  Job "${job.name}": ${fromLogs.length} scenarios from logs`, 'info');
    all.push(...fromLogs);
  }
  if (failuresFromAnnotations.length) log(`  + ${failuresFromAnnotations.length} scenarios from annotations`, 'ok');
  if (failuresFromArtifacts.length)   log(`  + ${failuresFromArtifacts.length} scenarios from artifacts`, 'ok');
  const seen = new Set();
  const unique = all.filter(f => {
    const k = f.scenarioName || f.featureFile;
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
  setStage('scenarios', 'ok', `${unique.length} found`);
  log(`Unique failed scenarios: ${unique.length}`, unique.length ? 'ok' : 'warn');

  await checkPause();
  setStage('environment', 'pending');
  log(`Detecting environment…`, 'dim');
  const env = detectEnvironment(runData, allJobs, jobLogs);
  setStage('environment', 'ok', env);
  log(`Environment detected: ${env}`, 'ok');

  // Save scenario list NOW so any future resume skips log download entirely
  await saveCheckpoint(runIdStr, { analyzed: [], scenarioList: unique, totalScenarios: unique.length, environment: env, runUrl });

  const mvnSummary = { total: 0, failures: 0, errors: 0, skipped: 0, passed: 0 };
  for (const logText of Object.values(jobLogs)) {
    const s = extractMavenSummary(logText);
    for (const k of Object.keys(mvnSummary)) mvnSummary[k] += s[k] || 0;
  }
  if (mvnSummary.total) log(`Maven summary: ${mvnSummary.passed} passed, ${mvnSummary.failures} failed of ${mvnSummary.total}`, 'info');

  // ── Group scenarios — analyze one representative per group ───────────────────
  const groups = groupScenarios(unique);
  const groupList = [...groups.entries()]; // [[key, members[]], ...]
  logSep();
  log(`Grouped ${unique.length} scenario(s) into ${groupList.length} unique group(s) by module + exception + endpoint`, 'ok');
  groupList.forEach(([key, members]) =>
    log(`  • ${key} — ${members.length} scenario(s)`, 'dim')
  );

  // ── Restore from checkpoint ───────────────────────────────────────────────────
  const actuatorCache = {};
  const analyzed = checkpoint?.analyzed ? [...checkpoint.analyzed] : [];
  const doneKeys = new Set(analyzed.map(a => a.groupKey).filter(Boolean));

  if (analyzed.length > 0) {
    log(`Checkpoint restored: ${doneKeys.size} groups already done (${analyzed.length} scenarios)`, 'ok');
    for (const item of analyzed) {
      if (item.actuator?.status === 'ok') actuatorCache[item.module] = item.actuator;
    }
    document.getElementById('table-card').classList.remove('hidden');
    document.getElementById('fail-count').textContent = analyzed.length;
    renderTableBody(analyzed);
  }

  // Only process groups not yet done
  const pendingGroups = groupList.filter(([key]) => !doneKeys.has(key));
  logSep();
  log(`Analyzing ${pendingGroups.length} remaining group(s)…`, 'info');

  for (let gi = 0; gi < pendingGroups.length; gi++) {
    await checkPause();
    const [key, members] = pendingGroups[gi];
    const doneGroups = doneKeys.size + gi;
    const totalGroups = groupList.length;

    const counterEl = document.getElementById('progress-scenario-count');
    if (counterEl && !_paused)
      counterEl.textContent = `Group ${doneGroups + 1}/${totalGroups} — ${analyzed.length}/${unique.length} scenarios`;

    logSep();
    log(`[Group ${doneGroups + 1}/${totalGroups}] ${key} (${members.length} scenario${members.length > 1 ? 's' : ''})`, 'info');

    // Full analysis on the representative (first member)
    const representative = members[0];
    const item = await analyzeOneFailure(representative, env, actuatorCache, token);

    // Stamp every member in this group with the shared RCA
    for (const member of members) {
      const entry = {
        ...item,
        failure: member,
        groupKey: key,
        groupSize: members.length,
        isRepresentative: member === representative,
      };
      analyzed.push(entry);
      updateTableRow(analyzed.length - 1, entry);
    }

    if (members.length > 1)
      log(`  → Applied same RCA to ${members.length} scenarios (${members.length - 1} skipped — same group)`, 'ok');

    // Checkpoint after every group — includes scenarioList so next resume skips log download
    await saveCheckpoint(runIdStr, { analyzed, scenarioList: unique, totalScenarios: unique.length, environment: env, runUrl });
    log(`  ✓ Checkpoint saved (${analyzed.length}/${unique.length} scenarios, ${doneGroups + 1}/${totalGroups} groups)`, 'dim');
  }

  setStage('rca', 'ok', 'done');
  _analysisRunning = false;
  document.getElementById('btn-pause-resume').classList.add('hidden');
  document.getElementById('progress-scenario-count').textContent =
    `${analyzed.length} scenarios in ${groupList.length} groups`;

  const clsCounts = {};
  for (const a of analyzed) {
    const c = a.rca.classification;
    clsCounts[c] = (clsCounts[c] || 0) + 1;
  }

  analysisResult = { run: runData, environment: env, mvnSummary, total: unique.length, groups: groupList.length, clsCounts, analyzed };

  await clearCheckpoint(runIdStr);
  logSep();
  log(`Analysis complete! ${analyzed.length} scenarios in ${groupList.length} groups. API calls made: ${groupList.length} (not ${unique.length}).`, 'ok');

  renderSummary();
  renderTable();
}

// ── Analyze a single failure (reusable for re-analysis) ───────────────────────
async function analyzeOneFailure(failure, env, actuatorCache, token) {
  const module = identifyModule(failure);
  log(`  Module: ${module} | API: ${failure.httpMethod || ''} ${failure.endpoint || '—'}`, 'dim');

  setStage('actuator', 'pending');
  if (!actuatorCache[module]) {
    actuatorCache[module] = await queryActuator(module, env);
  }
  const actuator = actuatorCache[module];
  if (actuator.status === 'ok') {
    setStage('actuator', 'ok', actuator.version || actuator.branch);
    log(`  Actuator OK → ${actuator.url}`, 'api');
    log(`  branch=${actuator.branch} commit=${actuator.commitAbbrev} version=${actuator.version}`, 'ok');
  } else {
    setStage('actuator', 'error', 'unavailable');
    log(`  Actuator → ${actuator.url}`, 'api');
    log(`  Actuator unavailable: ${actuator.error}`, 'warn');
    if ((actuator.error || '').includes('VPN')) {
      log(`  ⚠ Actuator needs VPN — connect to Albertsons VPN and re-analyze for deployed version info`, 'warn');
    }
  }

  const deployCommit = actuator.commitId || actuator.commitAbbrev || '';
  const deployBranch = actuator.branch || '';

  setStage('app_code', 'pending');
  let appTrace = null;
  if (deployCommit && module !== 'UNKNOWN') {
    log(`  Inspecting app code at commit ${deployCommit.substring(0,8)}…`, 'dim');
    try { appTrace = await inspectAppCode(module, deployCommit, failure.endpoint, token); setStage('app_code', 'ok'); log(`  App code: found controller/service/dao`, 'ok'); }
    catch (e) { setStage('app_code', 'error', e.message?.substring(0, 40)); log(`  App code error: ${e.message}`, 'warn'); }
  } else { setStage('app_code', 'ok', 'skipped'); log(`  App code: skipped (no commit or unknown module)`, 'dim'); }

  setStage('auto_code', 'pending');
  let autoTrace = null;
  log(`  Inspecting automation code: ${failure.featureFile || '—'}`, 'dim');
  try { autoTrace = await inspectAutomationCode(failure.featureFile, failure.scenarioName, token); setStage('auto_code', 'ok'); log(`  Automation code: fetched`, 'ok'); }
  catch (e) { setStage('auto_code', 'error', e.message?.substring(0, 40)); log(`  Automation code error: ${e.message}`, 'warn'); }

  setStage('commits', 'pending');
  let commits = null;
  if (module !== 'UNKNOWN') {
    log(`  Analyzing recent commits on branch: ${deployBranch || 'default'}`, 'dim');
    try { commits = await analyzeCommits(module, deployBranch, deployCommit, failure.endpoint, failure.exceptionType, token); setStage('commits', 'ok'); log(`  Commits: ${commits?.recent?.length || 0} fetched`, 'ok'); }
    catch (e) { setStage('commits', 'error', e.message?.substring(0, 40)); log(`  Commits error: ${e.message}`, 'warn'); }
  } else { setStage('commits', 'ok', 'skipped'); }

  setStage('rca', 'pending');
  const rca = generateRca(failure, module, env, actuator, appTrace, autoTrace, commits);
  setStage('rca', 'ok');
  log(`  RCA: ${rca.classification} (${rca.confidence}) — ${(rca.whyItFailed||'').substring(0,80)}`, rca.classification === 'UNKNOWN' ? 'warn' : 'ok');

  return { failure, module, environment: env, actuator, appTrace, autoTrace, commits, rca };
}

// ── Re-analyze a specific scenario ───────────────────────────────────────────
async function reanalyzeScenario(idx) {
  const item = analysisResult?.analyzed[idx];
  if (!item) return;

  const btn = document.getElementById(`reanalyze-btn-${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Re-analyzing…'; }

  logSep();
  log(`Re-analyzing scenario #${idx + 1}: ${item.failure.scenarioName || ''}`, 'info');

  try {
    clearCacheForModule(item.module);
    const fresh = await analyzeOneFailure(item.failure, item.environment, {}, _token);
    analysisResult.analyzed[idx] = fresh;
    updateTableRowEl(idx, fresh);
    openDetail(idx);
    log(`Re-analysis complete`, 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Re-analyze'; }
    log(`Re-analysis failed: ${e.message}`, 'err');
    alert(`Re-analysis failed: ${e.message || e}`);
  }
}

// ── Scenario grouping ─────────────────────────────────────────────────────────
function normalizeEndpoint(ep) {
  return (ep || '')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{uuid}')
    .replace(/\/\d{6,}/g, '/{id}')
    .replace(/\/\d+/g, '/{n}')
    .toLowerCase();
}

function getGroupKey(failure) {
  const module  = identifyModule(failure);
  const exc     = (failure.exceptionType || 'NONE').split('.').pop();
  const ep      = normalizeEndpoint(failure.endpoint);
  const status  = failure.httpStatus || '';
  return `${module}::${exc}::${ep}::${status}`;
}

function groupScenarios(scenarios) {
  const groups = new Map();
  for (const f of scenarios) {
    const key = getGroupKey(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

function pickTargetJobs(jobs) {
  const priority  = jobs.filter(j => /rerun/i.test(j.name));
  const secondary = jobs.filter(j => /Run-Integration|maven/i.test(j.name) && !/rerun/i.test(j.name));
  const picked = priority.length ? [...priority, ...secondary] : secondary.length ? secondary : jobs;
  // Deduplicate by job ID — a job can match both filters
  const seen = new Set();
  return picked.filter(j => seen.has(j.id) ? false : seen.add(j.id));
}

async function parseZipForCucumber(arrayBuffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arrayBuffer));
    const jsonStart = text.indexOf('[{"id"');
    if (jsonStart === -1) return [];
    const jsonStr = text.substring(jsonStart, text.lastIndexOf('}]') + 2);
    return parseCucumberJson(JSON.parse(jsonStr));
  } catch { return []; }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const { run, environment, mvnSummary, total, groups, clsCounts, analyzed } = analysisResult;
  document.getElementById('summary-card').classList.remove('hidden');

  const deployMap = {};
  for (const item of analyzed) {
    const m = item.module;
    if (!deployMap[m] || (item.actuator?.status === 'ok' && deployMap[m]?.status !== 'ok')) {
      deployMap[m] = item.actuator;
    }
  }
  const deployEntries = Object.entries(deployMap).filter(([, a]) => a);

  const deployHtml = deployEntries.length ? `
    <div class="deploy-versions">
      <div class="deploy-hdr">🚀 Deployed Versions</div>
      <table class="deploy-table">
        <thead><tr><th>Module</th><th>Environment</th><th>Branch</th><th>Commit</th><th>Version</th><th>Build Time</th></tr></thead>
        <tbody>${deployEntries.map(([mod, a]) => `
          <tr class="${a.status === 'ok' ? '' : 'deploy-err-row'}">
            <td class="mono">${esc(mod)}</td>
            <td>${esc(environment)}</td>
            <td class="mono">${a.status === 'ok' ? esc(a.branch || '—') : '<span class="err-text">Unavailable</span>'}</td>
            <td class="mono">${a.status === 'ok'
              ? `<a href="${esc(a.url)}" target="_blank" title="${esc(a.commitId)}">${esc(a.commitAbbrev || (a.commitId||'').substring(0,8) || '—')}</a>`
              : '—'}</td>
            <td>${a.status === 'ok' ? esc(a.version || '—') : '—'}</td>
            <td class="muted-sm">${a.status === 'ok' ? esc((a.buildTime||'').substring(0,19).replace('T',' ') || '—') : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  document.getElementById('run-meta').innerHTML = `
    <div class="run-bar">
      <a href="${esc(run.html_url)}" target="_blank"><strong>${esc(run.display_title || run.name || 'Workflow')}</strong></a>
      <span class="run-chip">Branch: <strong>${esc(run.head_branch || '')}</strong></span>
      <span class="run-chip">Env: <strong>${esc(environment)}</strong></span>
      <span class="run-chip">Actor: <strong>${esc(run.triggering_actor?.login || '')}</strong></span>
      <span class="run-chip conclusion-${run.conclusion}">${esc(run.conclusion || run.status || '')}</span>
    </div>
    ${deployHtml}`;

  document.getElementById('tiles').innerHTML = [
    ['tile-total', total, 'Scenarios'],
    ['tile-groups', groups || 1, 'Groups Analyzed'],
    ['tile-auto',  clsCounts['AUTOMATION_SCRIPT_ISSUE'] || 0, 'Automation'],
    ['tile-app',   clsCounts['APPLICATION_CODE_ISSUE']  || 0, 'Application'],
    ['tile-data',  clsCounts['DATA_ISSUE']              || 0, 'Data'],
    ['tile-env',   clsCounts['ENVIRONMENT_ISSUE']       || 0, 'Environment'],
    ['tile-dep',   clsCounts['DEPENDENCY_ISSUE']        || 0, 'Dependency'],
    ['tile-unk',   clsCounts['UNKNOWN']                 || 0, 'Unknown'],
    ...(mvnSummary.total ? [['tile-pass', mvnSummary.passed, 'Passed'], ['tile-run', mvnSummary.total, 'Total Run']] : []),
  ].map(([cls, val, label]) =>
    `<div class="tile ${cls}"><div class="tile-val">${val}</div><div class="tile-lbl">${label}</div></div>`
  ).join('');
}

function renderTable() {
  const { analyzed, environment } = analysisResult || { analyzed: [], environment: '' };
  document.getElementById('table-card').classList.remove('hidden');
  document.getElementById('fail-count').textContent = analyzed.length;
  renderTableBody(analyzed, environment);
}

function renderTableBody(analyzed, environment) {
  environment = environment || analysisResult?.environment || '';
  const tbody = document.getElementById('fail-tbody');
  tbody.innerHTML = '';
  analyzed.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.id = `tr-${i}`;
    if (item.groupSize > 1 && !item.isRepresentative) tr.classList.add('tr-grouped');
    tr.innerHTML = tableRowInner(i, item, environment);
    tr.addEventListener('click', () => openDetail(i));
    tbody.appendChild(tr);
  });
}

function tableRowInner(i, item, environment) {
  const f = item.failure, rca = item.rca;
  const api = f.httpMethod && f.endpoint ? `${f.httpMethod} ${f.endpoint}` : '—';
  const cls = rca.classification;
  const groupBadge = (item.groupSize > 1 && item.isRepresentative)
    ? `<span class="group-badge" title="Group of ${item.groupSize} scenarios with same root cause">×${item.groupSize}</span>`
    : (item.groupSize > 1 ? `<span class="group-badge group-member" title="Same group as above">↳</span>` : '');
  return `
    <td>${i + 1}</td>
    <td><span class="trunc" title="${esc(f.featureName)}">${esc(cut(f.featureName || f.featureFile, 30))}</span></td>
    <td>${groupBadge}<span class="trunc" title="${esc(f.scenarioName)}">${esc(cut(f.scenarioName, 45))}</span></td>
    <td><span class="mono trunc" title="${esc(api)}">${esc(cut(api, 35))}</span></td>
    <td>${esc(item.module || '—')}</td>
    <td>${esc(item.environment || environment || '—')}</td>
    <td><span class="badge cls-${cls}">${esc(clsLabel(cls))}</span></td>
    <td><span class="conf-${rca.confidence}">${esc(rca.confidence)}</span></td>`;
}

function updateTableRow(i, item) {
  const tr = document.getElementById(`tr-${i}`);
  if (tr) { tr.innerHTML = tableRowInner(i, item, analysisResult?.environment || ''); return; }
  // Table not rendered yet — make sure the table section is visible
  if (!document.getElementById('table-card').classList.contains('hidden')) return;
  document.getElementById('table-card').classList.remove('hidden');
  document.getElementById('fail-count').textContent = (analysisResult?.analyzed?.length || 0) + 1;
  const tbody = document.getElementById('fail-tbody');
  const newTr = document.createElement('tr');
  newTr.id = `tr-${i}`;
  newTr.innerHTML = tableRowInner(i, item, analysisResult?.environment || '');
  newTr.addEventListener('click', () => openDetail(i));
  tbody.appendChild(newTr);
}

function updateTableRowEl(i, item) {
  const tr = document.getElementById(`tr-${i}`);
  if (!tr) return;
  tr.innerHTML = tableRowInner(i, item, analysisResult?.environment || '');
  tr.addEventListener('click', () => openDetail(i));
}

// ── Detail view ───────────────────────────────────────────────────────────────
function openDetail(idx) {
  const item = analysisResult?.analyzed[idx];
  if (!item) return;

  document.getElementById('table-card').classList.add('hidden');
  document.getElementById('summary-card').classList.add('hidden');
  document.getElementById('detail-card').classList.remove('hidden');
  document.getElementById('detail-title').textContent = item.failure.scenarioName || 'Failure Detail';

  const f = item.failure, rca = item.rca, act = item.actuator;

  const groupInfo = (item.groupSize > 1)
    ? `<div class="group-info-bar">
        <span class="group-info-icon">${item.isRepresentative ? '🔬' : '↳'}</span>
        <span>${item.isRepresentative
          ? `This scenario was <strong>fully analyzed</strong> as representative of <strong>${item.groupSize} scenarios</strong> with the same module, exception, and endpoint.`
          : `This scenario shares its root cause with <strong>${item.groupSize} scenarios</strong> in the same group — RCA was computed once and applied to all.`}
        </span>
        <span class="group-key-chip" title="Group key">${esc(item.groupKey)}</span>
       </div>`
    : '';

  document.getElementById('detail-body').innerHTML = `
  ${groupInfo}
  <div class="reanalyze-bar">
    <div class="reanalyze-info">
      <span class="badge cls-${rca.classification}">${esc(clsLabel(rca.classification))}</span>
      <span class="conf-${rca.confidence} rca-conf-label">${esc(rca.confidence)} confidence</span>
      ${act?.status === 'ok' ? `<span class="deploy-chip">📦 ${esc(act.branch)} @ ${esc(act.commitAbbrev)}</span>` : `<span class="deploy-chip err-text">⚠ Actuator unavailable</span>`}
    </div>
    <button class="reanalyze-btn" id="reanalyze-btn-${idx}" data-action="reanalyze" data-idx="${idx}">🔄 Re-analyze</button>
  </div>

  <div class="detail-grid">
    <div class="db">
      <h3><span class="ico">🧪</span> Failure Summary</h3>
      <div class="kv">
        <span class="kk">Feature</span>    <span class="kv2">${esc(f.featureName || f.featureFile || '—')}</span>
        <span class="kk">Scenario</span>   <span class="kv2">${esc(f.scenarioName || '—')}</span>
        <span class="kk">Failed Step</span><span class="kv2">${esc(f.failedStep || '—')}</span>
        <span class="kk">API</span>        <span class="kv2 mono">${esc(f.httpMethod || '')} ${esc(f.endpoint || '—')}</span>
        <span class="kk">HTTP Status</span><span class="kv2">${f.httpStatus || '—'}</span>
        <span class="kk">Environment</span><span class="kv2">${esc(item.environment || '—')}</span>
        <span class="kk">Module</span>     <span class="kv2">${esc(item.module || '—')}</span>
        <span class="kk">Tags</span>       <span class="kv2">${(f.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</span>
      </div>
    </div>

    <div class="db">
      <h3><span class="ico">🎯</span> Root Cause Analysis</h3>
      <div class="rca-box">
        <div class="rca-cls">
          <span class="badge cls-${rca.classification}">${esc(clsLabel(rca.classification))}</span>
          &nbsp;<span class="conf-${rca.confidence}">${esc(rca.confidence)}</span>
        </div>
        <div class="rca-why">${esc(rca.whyItFailed || rca.rootCauseSummary || '—')}</div>
        ${rca.recommendedAction ? `<div class="rca-rec">${esc(rca.recommendedAction)}</div>` : ''}
      </div>
      ${(rca.contributing || []).length ? `
        <div style="margin-top:10px">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Contributing Factors</div>
          <ul class="ev-list">${rca.contributing.map(c => `<li class="ev-item"><span>${esc(c)}</span></li>`).join('')}</ul>
        </div>` : ''}
    </div>

    <div class="db">
      <h3><span class="ico">🤖</span> Automation Evidence</h3>
      <div class="kv">
        <span class="kk">Exception</span><span class="kv2 mono">${esc(f.exceptionType || '—')}</span>
        <span class="kk">Message</span>  <span class="kv2">${esc(cut(f.exceptionMessage, 200) || '—')}</span>
      </div>
      ${f.stackTrace ? `<pre class="code">${esc(f.stackTrace)}</pre>` : ''}
    </div>

    <div class="db">
      <h3><span class="ico">🔍</span> Actuator / Deployment</h3>
      ${act?.status === 'ok' ? `
      <div class="kv">
        <span class="kk">Status</span>     <span class="kv2 ok-text">✓ Available</span>
        <span class="kk">URL</span>        <span class="kv2 mono"><a href="${esc(act.url)}" target="_blank">${esc(act.url)}</a></span>
        <span class="kk">Branch</span>     <span class="kv2 mono">${esc(act.branch || '—')}</span>
        <span class="kk">Commit</span>     <span class="kv2 mono">${esc(act.commitId || act.commitAbbrev || '—')}</span>
        <span class="kk">Version</span>    <span class="kv2">${esc(act.version || '—')}</span>
        <span class="kk">Build Time</span><span class="kv2">${esc(act.buildTime || '—')}</span>
      </div>` : `
      <div class="kv">
        <span class="kk">Status</span><span class="kv2 err-text">✗ ${esc(act?.status || 'Unavailable')}</span>
        <span class="kk">URL</span>   <span class="kv2 mono">${esc(act?.url || '—')}</span>
        <span class="kk">Error</span> <span class="kv2 err-text">${esc(act?.error || '—')}</span>
      </div>`}
    </div>

    ${renderCodeTrace(item.appTrace, '💻 Application Code')}
    ${renderAutoTrace(item.autoTrace)}

    <div class="db">
      <h3><span class="ico">📋</span> Evidence</h3>
      <ul class="ev-list">
        ${(rca.evidence || []).map(e =>
          `<li class="ev-item"><span class="ev-src">${esc(e.source)}</span><span>${esc(e.detail)}</span></li>`
        ).join('') || '<li class="ev-item"><span>No evidence collected.</span></li>'}
      </ul>
    </div>

    ${renderCommits(item.commits)}
  </div>`;
}

function renderCodeTrace(trace, title) {
  if (!trace) return '';
  const snippets = [];
  if (trace.controller) snippets.push(['Controller', trace.controller]);
  if (trace.service)    snippets.push(['Service',    trace.service]);
  if (trace.dao)        snippets.push(['DAO',         trace.dao]);
  (trace.clients || []).forEach((c, i) => snippets.push([`Client ${i + 1}`, c]));
  if (!snippets.length) return '';
  return `<div class="db full"><h3>${esc(title)}</h3>
    ${snippets.map(([layer, s]) => `
      <div class="snippet-wrap">
        <div class="snippet-hdr">
          <span class="badge badge-accent">${esc(layer)}</span>
          <a href="${esc(s.githubUrl)}" target="_blank" class="mono fsize12">${esc(s.filePath)}</a>
          ${s.commitSha ? `<span class="mono fsize11 muted">${esc(s.commitSha.substring(0, 8))}</span>` : ''}
        </div>
        ${s.content ? `<pre class="code">${esc(s.content.substring(0, 2000))}</pre>` : ''}
      </div>`).join('')}
  </div>`;
}

function renderAutoTrace(trace) {
  if (!trace) return '';
  const blocks = [];
  if (trace.automationFeature)  blocks.push(['Feature File',    trace.automationFeature]);
  if (trace.automationStepDef)  blocks.push(['Step Definition', trace.automationStepDef]);
  if (trace.automationService)  blocks.push(['Service Class',   trace.automationService]);
  if (!blocks.length) return '';
  return `<div class="db full"><h3>🤖 Automation Code</h3>
    ${blocks.map(([layer, s]) => `
      <div class="snippet-wrap">
        <div class="snippet-hdr">
          <span class="badge badge-green">${esc(layer)}</span>
          <a href="${esc(s.githubUrl)}" target="_blank" class="mono fsize12">${esc(s.filePath)}</a>
        </div>
        ${s.content ? `<pre class="code">${esc(s.content.substring(0, 2000))}</pre>` : ''}
      </div>`).join('')}
  </div>`;
}

function renderCommits(com) {
  if (!com?.recent?.length) return '';
  return `<div class="db full">
    <h3>📝 Recent Commits — ${esc(com.module || '')} (branch: ${esc(com.deployedBranch || 'N/A')})</h3>
    <div class="commit-list">
      ${com.recent.slice(0, 15).map(c => `
        <div class="commit-item">
          <a href="${esc(c.htmlUrl)}" target="_blank" class="commit-sha">${esc(c.shortSha)}</a>
          <span class="commit-msg">${esc(c.message)}</span>
          <span class="muted fsize12"> — ${esc(c.author)} ${esc(c.date ? c.date.substring(0, 10) : '')}</span>
          ${c.relevance === 'potential_correlation' ? `<span class="badge cls-AUTOMATION_SCRIPT_ISSUE" style="margin-left:8px">⚠ ${esc(c.reason)}</span>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

function closeDetail() {
  document.getElementById('detail-card').classList.add('hidden');
  document.getElementById('summary-card').classList.remove('hidden');
  document.getElementById('table-card').classList.remove('hidden');
}

function showStageError(msg) {
  const el = document.getElementById('progress-error');
  el.innerHTML = msg;
  el.style.display = 'block';
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportAs(fmt) {
  if (!analysisResult) return;
  if (fmt === 'json')          dl('rca-report.json', JSON.stringify(analysisResult, null, 2), 'application/json');
  else if (fmt === 'markdown') dl('rca-report.md',   buildMd(),   'text/markdown');
  else                         dl('rca-report.html',  buildHtml(), 'text/html');
}

function buildMd() {
  const { run, environment, total, analyzed } = analysisResult;
  const lines = ['# OCOM API Automation RCA Report', '',
    `**Workflow:** ${run.html_url}`, `**Environment:** ${environment}`, `**Total Failures:** ${total}`, ''];
  for (const [i, item] of analyzed.entries()) {
    const f = item.failure, rca = item.rca, act = item.actuator;
    lines.push(`---\n## ${i + 1}. ${f.scenarioName || ''}`);
    lines.push(`- **Feature:** ${f.featureName || f.featureFile || ''}`);
    lines.push(`- **API:** ${f.httpMethod || ''} ${f.endpoint || ''}`);
    lines.push(`- **Module:** ${item.module || ''}`);
    lines.push(`- **Exception:** ${f.exceptionType || ''}: ${f.exceptionMessage || ''}`);
    lines.push(`- **Classification:** **${rca.classification}** (${rca.confidence})`);
    lines.push(`- **Branch:** ${act?.branch || 'N/A'} | **Commit:** ${act?.commitId || 'N/A'} | **Version:** ${act?.version || 'N/A'}`);
    lines.push('', `### Root Cause`, rca.whyItFailed || '', '');
    lines.push(`### Recommendation`, rca.recommendedAction || '', '');
    if (f.stackTrace) lines.push('### Stack Trace', '```', f.stackTrace, '```', '');
  }
  return lines.join('\n');
}

function buildHtml() {
  const { run, environment, total, clsCounts, mvnSummary, analyzed } = analysisResult;
  const ts = new Date().toLocaleString();
  const clsColor = {
    AUTOMATION_SCRIPT_ISSUE: '#cf222e', APPLICATION_CODE_ISSUE: '#bc4c00',
    DATA_ISSUE: '#9a6700', ENVIRONMENT_ISSUE: '#6e40c9',
    DEPENDENCY_ISSUE: '#0969da', UNKNOWN: '#57606a',
  };

  const failureHtml = analyzed.map((item, i) => {
    const f = item.failure, rca = item.rca, act = item.actuator;
    const app = item.appTrace, aut = item.autoTrace, com = item.commits;
    const cc = clsColor[rca.classification] || '#57606a';

    const codeSnippets = (trace) => {
      if (!trace) return '';
      return [['Controller', trace.controller], ['Service', trace.service], ['DAO', trace.dao],
        ...(trace.clients || []).map((c, j) => [`Client ${j+1}`, c]),
        ['Feature File', trace.automationFeature], ['Step Definition', trace.automationStepDef],
        ['Service Class', trace.automationService],
      ].filter(([,s]) => s).map(([layer, s]) =>
        `<h4>${layer} — <a href="${esc(s.githubUrl)}">${esc(s.filePath)}</a></h4>
         <pre style="background:#f6f8fa;padding:10px;border-radius:4px;overflow-x:auto;font-size:11px;max-height:300px;overflow-y:auto">${esc((s.content||'').substring(0,2000))}</pre>`
      ).join('');
    };

    const commitRows = (com?.recent || []).slice(0, 10).map(c =>
      `<tr style="${c.relevance === 'potential_correlation' ? 'background:#fff8c5' : ''}">
        <td><a href="${esc(c.htmlUrl)}">${esc(c.shortSha)}</a></td>
        <td>${esc(c.message)}</td><td>${esc(c.author)}</td>
        <td>${esc(c.date ? c.date.substring(0,10) : '')}</td>
        <td>${c.relevance === 'potential_correlation' ? `⚠ ${esc(c.reason)}` : ''}</td>
      </tr>`).join('');

    return `<div class="failure-block" id="f${i+1}">
      <div class="failure-header" style="border-left:4px solid ${cc}">
        <span class="fnum">#${i+1}</span>
        <div><div class="ftitle">${esc(f.scenarioName || '')}</div>
        <div class="fmeta">${esc(f.featureName||'')} | ${esc(item.module||'')} | ${esc(item.environment||'')}</div></div>
        <span class="cls-badge" style="background:${cc}22;color:${cc};border:1px solid ${cc}55">${esc(clsLabel(rca.classification))}</span>
        <span class="conf-badge">${esc(rca.confidence)}</span>
      </div>
      <div class="two-col">
        <div class="info-section"><h3>Failure Details</h3>
          <table class="kv-table">
            <tr><td class="kk">API</td><td><code>${esc(f.httpMethod||'')} ${esc(f.endpoint||'—')}</code></td></tr>
            <tr><td class="kk">HTTP Status</td><td>${f.httpStatus||'—'}</td></tr>
            <tr><td class="kk">Exception</td><td><code>${esc(f.exceptionType||'—')}</code></td></tr>
            <tr><td class="kk">Message</td><td>${esc((f.exceptionMessage||'').substring(0,200))}</td></tr>
          </table>
          ${f.stackTrace ? `<pre style="background:#f6f8fa;padding:8px;border-radius:4px;font-size:11px;max-height:180px;overflow:auto">${esc(f.stackTrace)}</pre>` : ''}
        </div>
        <div class="rca-section" style="border:2px solid ${cc}44;border-radius:6px;padding:14px">
          <h3 style="color:${cc}">🎯 ${esc(clsLabel(rca.classification))}</h3>
          <p style="margin:8px 0 12px;line-height:1.6">${esc(rca.whyItFailed||'')}</p>
          <div style="background:${cc}11;border:1px solid ${cc}33;border-radius:4px;padding:10px;font-size:13px">
            <strong>Recommendation:</strong> ${esc(rca.recommendedAction||'')}
          </div>
        </div>
      </div>
      <div class="info-section"><h3>Actuator / Deployment</h3>
        <table class="kv-table">
          <tr><td class="kk">Branch</td><td><code>${esc(act?.branch||'N/A')}</code></td></tr>
          <tr><td class="kk">Commit</td><td><code>${esc(act?.commitId||act?.commitAbbrev||'N/A')}</code></td></tr>
          <tr><td class="kk">Version</td><td>${esc(act?.version||'N/A')}</td></tr>
          <tr><td class="kk">Status</td><td style="color:${act?.status==='ok'?'#1a7f37':'#cf222e'}">${esc(act?.status||'unknown')}${act?.error ? ' — '+esc(act.error):''}  </td></tr>
        </table>
      </div>
      ${app||aut ? `<div class="info-section"><h3>Code Traces</h3>${codeSnippets(app)}${codeSnippets(aut)}</div>` : ''}
      ${commitRows ? `<div class="info-section"><h3>Recent Commits</h3>
        <table class="data-table"><thead><tr><th>SHA</th><th>Message</th><th>Author</th><th>Date</th><th>Correlation</th></tr></thead>
        <tbody>${commitRows}</tbody></table></div>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>OCOM RCA Report</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,sans-serif;font-size:13px;color:#24292f;margin:0;background:#f6f8fa}
.page{max-width:1100px;margin:0 auto;padding:24px}
.report-header{background:#0969da;color:#fff;border-radius:8px;padding:20px 24px;margin-bottom:20px}
.report-header h1{font-size:20px;margin-bottom:8px}.report-header a{color:#cae8ff;text-decoration:none}
.meta-grid{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:13px}
.meta-item{background:rgba(255,255,255,.15);border-radius:4px;padding:4px 10px}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}
.tile{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px 18px;text-align:center;min-width:100px}
.tile-val{font-size:24px;font-weight:700}.tile-lbl{font-size:11px;color:#57606a;text-transform:uppercase}
.toc{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:14px 18px;margin-bottom:20px}
.toc ol{padding-left:18px;line-height:1.8}.toc a{color:#0969da;text-decoration:none;font-size:13px}
.failure-block{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin-bottom:20px;overflow:hidden}
.failure-header{display:flex;align-items:center;gap:12px;padding:14px 18px;background:#f6f8fa;flex-wrap:wrap}
.fnum{font-size:18px;font-weight:700;color:#57606a;min-width:28px}
.ftitle{font-size:15px;font-weight:600}.fmeta{font-size:12px;color:#57606a;margin-top:2px}
.cls-badge{padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600}
.conf-badge{padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#f6f8fa;border:1px solid #d0d7de;color:#57606a}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 18px}
.info-section{padding:0 18px 16px}
h3{font-size:13px;font-weight:600;color:#24292f;margin:12px 0 8px;text-transform:uppercase;letter-spacing:.4px}
.kv-table{width:100%;border-collapse:collapse;font-size:12px}
.kv-table td{padding:5px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top}
.kk{color:#57606a;width:90px;font-weight:500}
.data-table{width:100%;border-collapse:collapse;font-size:12px}
.data-table th{background:#f6f8fa;padding:6px 10px;text-align:left;border-bottom:1px solid #d0d7de;font-weight:600;color:#57606a}
.data-table td{padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:12px}
a{color:#0969da}footer{text-align:center;color:#8c959f;font-size:12px;margin-top:24px;padding-bottom:24px}
</style></head><body><div class="page">
  <div class="report-header">
    <h1>⚙ OCOM RCA Report</h1>
    <div><a href="${esc(run.html_url)}">${esc(run.display_title || run.name || '')}</a></div>
    <div class="meta-grid">
      <span class="meta-item">🌍 ${esc(environment)}</span>
      <span class="meta-item">🌿 ${esc(run.head_branch||'N/A')}</span>
      <span class="meta-item">👤 ${esc(run.triggering_actor?.login||'N/A')}</span>
      <span class="meta-item">📅 ${esc(ts)}</span>
      <span class="meta-item">❌ ${total} failures</span>
    </div>
  </div>
  <div class="tiles">
    <div class="tile"><div class="tile-val">${total}</div><div class="tile-lbl">Total</div></div>
    <div class="tile"><div class="tile-val" style="color:#cf222e">${clsCounts['AUTOMATION_SCRIPT_ISSUE']||0}</div><div class="tile-lbl">Automation</div></div>
    <div class="tile"><div class="tile-val" style="color:#bc4c00">${clsCounts['APPLICATION_CODE_ISSUE']||0}</div><div class="tile-lbl">Application</div></div>
    <div class="tile"><div class="tile-val" style="color:#9a6700">${clsCounts['DATA_ISSUE']||0}</div><div class="tile-lbl">Data</div></div>
    <div class="tile"><div class="tile-val" style="color:#6e40c9">${clsCounts['ENVIRONMENT_ISSUE']||0}</div><div class="tile-lbl">Environment</div></div>
    <div class="tile"><div class="tile-val" style="color:#57606a">${clsCounts['UNKNOWN']||0}</div><div class="tile-lbl">Unknown</div></div>
  </div>
  <div class="toc"><h2>Failures</h2><ol>${analyzed.map((item, i) =>
    `<li><a href="#f${i+1}">${esc(item.failure.scenarioName || `Failure ${i+1}`)}</a> — <span style="color:${clsColor[item.rca.classification]||'#57606a'};font-size:11px">${esc(clsLabel(item.rca.classification))}</span></li>`
  ).join('')}</ol></div>
  ${failureHtml}
  <footer>Generated by OCOM RCA Analyzer • ${esc(ts)}</footer>
</div></body></html>`;
}

function dl(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function cut(s, n) { return s && s.length > n ? s.substring(0, n) + '…' : (s || ''); }
const CLS_LABELS = {
  AUTOMATION_SCRIPT_ISSUE:'Automation', APPLICATION_CODE_ISSUE:'Application',
  DATA_ISSUE:'Data', ENVIRONMENT_ISSUE:'Environment', DEPENDENCY_ISSUE:'Dependency', UNKNOWN:'Unknown',
};
function clsLabel(c) { return CLS_LABELS[c] || c || '—'; }
