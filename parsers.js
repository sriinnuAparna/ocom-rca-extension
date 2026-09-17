'use strict';
// ── URL parser ────────────────────────────────────────────────────────────────
function parseRunUrl(url) {
  const m = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
  if (!m) throw new Error('Invalid GitHub Actions URL');
  return { owner: m[1], repo: m[2], runId: parseInt(m[3], 10) };
}

// ── Environment detector ──────────────────────────────────────────────────────
function detectEnvironment(runData, jobs, jobLogs) {
  // 1. workflow inputs
  const inputs = runData.inputs || {};
  const fromInput = inputs.environment || inputs.env || '';
  if (fromInput) return normalizeEnv(fromInput);

  // 2. run display_title e.g. "acceptance - @regression"
  const title = (runData.display_title || runData.name || '').toLowerCase();
  for (const name of ['acceptance','qa2','qa1','qa','dev','stage','prod','perf1','perf']) {
    if (title.includes(name)) return normalizeEnv(name);
  }

  // 3. job names
  for (const job of jobs) {
    const jn = (job.name || '').toLowerCase();
    for (const name of ['acceptance','qa2','qa1','qa','dev','stage','prod','perf1','perf']) {
      if (jn.includes(name)) return normalizeEnv(name);
    }
  }

  // 4. logs — search for -DenvTarget= or AKS host pattern
  for (const log of Object.values(jobLogs)) {
    const m1 = log.match(/-DenvTarget[=\s]+(\w+)/i);
    if (m1) return normalizeEnv(m1[1]);
    const m2 = log.match(/ocom\.(\w+)\.westus\.aks\.az\.albertsons\.com/);
    if (m2) return normalizeEnv(m2[1]);
  }
  return 'UNKNOWN';
}

function normalizeEnv(raw) {
  if (!raw) return null;
  raw = raw.trim().toLowerCase();
  if (ENV_TO_AKS[raw]) return raw;
  for (const k of Object.keys(ENV_TO_AKS)) { if (raw.includes(k)) return k; }
  return raw;
}

// ── Module mapper ─────────────────────────────────────────────────────────────
function identifyModule(failure) {
  // 1. from endpoint path (longest match wins)
  if (failure.endpoint) {
    let best = '', bestModule = '';
    for (const [pathKey, mod] of API_PATH_TO_MODULE) {
      if (failure.endpoint.toLowerCase().includes(pathKey.toLowerCase()) && pathKey.length > best.length) {
        best = pathKey; bestModule = mod;
      }
    }
    if (bestModule) return bestModule;
  }
  // 2. from Cucumber tags
  for (const tag of (failure.tags || [])) {
    if (TAG_TO_MODULE[tag]) return TAG_TO_MODULE[tag];
  }
  // 3. from feature file path
  const feat = failure.featureFile || '';
  for (const [seg, mod] of FEATURE_PATH_TO_MODULE) {
    if (feat.includes(seg)) return mod;
  }
  // 4. scenario name keywords
  const name = (failure.scenarioName || '').toLowerCase();
  if (name.includes('customer group')) return 'ocom-customer-groups';
  if (name.includes('product group'))  return 'ocom-product-groups';
  if (name.includes('store group'))    return 'ocom-store-groups';
  if (name.includes('offer'))          return 'ocom-offer-services';
  if (name.includes('uj-api'))         return 'ocom-uj-api';
  return 'UNKNOWN';
}

// ── Log parser ────────────────────────────────────────────────────────────────
function parseJobLogs(logText, jobName = '') {
  if (!logText) return [];
  const failures = [];
  // Strip timestamps and ANSI codes
  const lines = logText.split('\n')
    .map(l => l.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, ''));

  let currentFeature = '', currentScenario = '';
  let currentFailure = null, stackLines = [], errorLines = [];
  let inStack = false;

  const finalize = () => {
    if (currentFailure && (currentFailure.exceptionType || currentFailure.scenarioName)) {
      currentFailure.stackTrace = stackLines.slice(0, 50).join('\n');
      currentFailure.rawError   = errorLines.slice(0, 80).join('\n');
      failures.push(currentFailure);
    }
    currentFailure = null; stackLines = []; errorLines = []; inStack = false;
  };

  for (const line of lines) {
    const s = line.trim();

    // Feature
    const fm = s.match(/^Feature:\s*(.+)/i);
    if (fm) { currentFeature = fm[1].trim(); continue; }

    // Scenario
    const sm = s.match(/^(?:Scenario(?:\s+Outline)?)\s*:\s*(.+?)(?:\s+#.+)?$/i);
    if (sm) {
      finalize();
      currentScenario = sm[1].trim();
      continue;
    }

    // Exception line
    const em = s.match(/([A-Za-z]+(?:Exception|Error|Fault|Failure)(?:\$[A-Za-z]+)?)\s*:\s*(.+)/);
    if (em && currentScenario) {
      if (!currentFailure) currentFailure = newFailure(currentFeature, currentScenario);
      if (!currentFailure.exceptionType) {
        currentFailure.exceptionType = em[1];
        currentFailure.exceptionMessage = em[2].trim();
      }
      inStack = true; stackLines.push(line); errorLines.push(line);
      continue;
    }

    // Stack frame
    if (inStack && /^\s+at\s+[\w.$<>]+\([\w.]+:\d+\)/.test(line)) {
      stackLines.push(line); errorLines.push(line); continue;
    } else if (inStack && s && !s.startsWith('at ')) { inStack = false; }

    // HTTP info
    if (currentFailure) {
      const hm = s.match(/\b(GET|POST|PUT|DELETE|PATCH)\b\s+([/\w\-.{}%?=&:]+)/i);
      if (hm && !currentFailure.httpMethod) {
        currentFailure.httpMethod = hm[1].toUpperCase();
        currentFailure.endpoint   = hm[2];
      }
      const sc = s.match(/\b(?:status|HTTP|response code|statusCode)[:\s]+(\d{3})\b/i);
      if (sc && !currentFailure.httpStatus) currentFailure.httpStatus = parseInt(sc[1], 10);
      errorLines.push(line);
    }

    // Step fail marker
    if (currentScenario && /FAILED|AssertionError|failed step/i.test(s)) {
      if (!currentFailure) currentFailure = newFailure(currentFeature, currentScenario);
      const stepM = line.match(/\s*(Given|When|Then|And|But)\s+(.+)/i);
      if (stepM && !currentFailure.failedStep) currentFailure.failedStep = stepM[0].trim();
    }

    // Tags
    if (s.startsWith('@') && currentScenario) {
      if (!currentFailure) currentFailure = newFailure(currentFeature, currentScenario);
      const tags = s.match(/@[\w-]+/g) || [];
      (currentFailure.tags = currentFailure.tags || []).push(...tags);
    }
  }
  finalize();

  // Fallback: feature file references from rerun paths
  if (!failures.length) {
    const seen = new Set();
    for (const m of logText.matchAll(/src\/test\/resources\/features\/([^\s:]+\.feature)/g)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        failures.push({ ...newFailure('', m[1].split('/').pop().replace('.feature','')), featureFile: m[0] });
      }
    }
  }
  return failures;
}

function newFailure(featureName, scenarioName) {
  return { featureName, scenarioName, featureFile: '', failedStep: '',
           httpMethod: '', endpoint: '', httpStatus: null,
           exceptionType: '', exceptionMessage: '', stackTrace: '',
           rawError: '', tags: [] };
}

function extractMavenSummary(logText) {
  let total = 0, failures = 0, errors = 0, skipped = 0;
  for (const m of logText.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g)) {
    total += +m[1]; failures += +m[2]; errors += +m[3]; skipped += +m[4];
  }
  return { total, failures, errors, skipped, passed: total - failures - errors };
}

// ── GitHub Check-Run Annotations parser ──────────────────────────────────────
// Annotations are instant JSON from the API — no log download needed.
// Each annotation looks like: { annotation_level, title, message, raw_details, path }
function parseAnnotations(annotations) {
  const failures = [];
  for (const ann of annotations) {
    if (ann.annotation_level !== 'failure' && ann.annotation_level !== 'warning') continue;

    const title   = ann.title   || '';
    const message = ann.message || '';
    const details = ann.raw_details || '';
    const path    = ann.path || '';

    // Title is usually "FeatureName > ScenarioName" or "ClassName.methodName"
    let featureName = '', scenarioName = '';
    const titleParts = title.split(/\s*[>:»|]\s*/);
    if (titleParts.length >= 2) {
      featureName  = titleParts[0].trim();
      scenarioName = titleParts.slice(1).join(' > ').trim();
    } else {
      scenarioName = title.trim();
    }

    const f = newFailure(featureName, scenarioName || title);
    f.featureFile = path;

    // Exception type from message or raw_details
    const excM = (message + '\n' + details).match(/([A-Za-z]+(?:Exception|Error|Fault|Failure))\s*[:\s]/);
    if (excM) f.exceptionType = excM[1];
    f.exceptionMessage = message.split('\n')[0].substring(0, 200);

    // HTTP info from details
    const hm = details.match(/\b(GET|POST|PUT|DELETE|PATCH)\b\s+([/\w\-.{}%?=&:]+)/i);
    if (hm) { f.httpMethod = hm[1].toUpperCase(); f.endpoint = hm[2]; }
    const sc = details.match(/\b(?:status|HTTP|response code|statusCode)[:\s]+(\d{3})\b/i);
    if (sc) f.httpStatus = Number.parseInt(sc[1], 10);

    f.rawError   = (message + '\n' + details).substring(0, 2000);
    f.stackTrace = details.substring(0, 2000);
    if (f.scenarioName) failures.push(f);
  }
  return failures;
}

// ── Cucumber JSON parser ──────────────────────────────────────────────────────
function parseCucumberJson(data) {
  const results = [];
  if (!Array.isArray(data)) return results;
  const HTTP_RE = /(GET|POST|PUT|DELETE|PATCH)\s+([/\w\-.{}%?=&:]+)/i;
  const EXC_RE  = /([A-Za-z]+(?:Exception|Error|Fault|Failure))\s*:\s*(.+)/;

  for (const feature of data) {
    for (const element of (feature.elements || [])) {
      let isFailure = false, failedStep = '', httpMethod = '', endpoint = '',
          httpStatus = null, excType = '', excMsg = '', stack = '';

      for (const step of (element.steps || [])) {
        const stepName = step.name || '';
        const hm = stepName.match(HTTP_RE);
        if (hm && !httpMethod) { httpMethod = hm[1].toUpperCase(); endpoint = hm[2]; }

        if ((step.result || {}).status === 'failed') {
          isFailure = true;
          const kw = (step.keyword || '').trim();
          failedStep = `${kw} ${stepName}`.trim();
          const err = step.result.error_message || '';
          const hm2 = err.match(HTTP_RE);
          if (hm2) { httpMethod = hm2[1].toUpperCase(); endpoint = hm2[2]; }
          const sm = err.match(/\b(\d{3})\b/);
          if (sm) httpStatus = parseInt(sm[1], 10);
          const em = err.match(EXC_RE);
          if (em) { excType = em[1]; excMsg = em[2].trim(); }
          stack = err.substring(0, 2000);
          break;
        }
      }

      if (isFailure) {
        results.push({
          featureName: feature.name || '',
          featureFile: feature.uri || '',
          scenarioName: element.name || '',
          tags: (element.tags || []).map(t => t.name),
          failedStep, httpMethod, endpoint, httpStatus,
          exceptionType: excType, exceptionMessage: excMsg, stackTrace: stack,
        });
      }
    }
  }
  return results;
}

// ── Actuator client ───────────────────────────────────────────────────────────
async function queryActuator(moduleName, automationEnv) {
  const basePath = MODULE_ACTUATOR_PATH[moduleName] || moduleName.replace('ocom-', '');
  const env      = ENV_TO_AKS[automationEnv] || automationEnv;

  // Try primary path, then with trailing 's' as fallback (e.g. offer-service → offer-services)
  const pathsToTry = [basePath];
  if (!basePath.endsWith('s')) pathsToTry.push(basePath + 's');
  else pathsToTry.push(basePath.slice(0, -1));

  const info = { url: '', aksEnv: env, module: moduleName, actuatorPath: basePath,
                 branch: '', commitId: '', commitAbbrev: '', commitMessage: '',
                 commitTime: '', version: '', buildTime: '', status: '', error: '' };

  for (const path of pathsToTry) {
    const url = ACTUATOR_URL_TEMPLATE.replace('{env}', env).replace('{path}', path);
    info.url = url;
    info.actuatorPath = path;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const data = await resp.json();
        info.status = 'ok';
        extractGitInfo(data, info);
        return info;
      }
      // HTTP error — note it but still try fallback path
      info.error = `HTTP ${resp.status} at ${path}`;
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'Timeout (10s)' : (e.message || String(e)).substring(0, 100);
      // "Failed to fetch" almost always means VPN not connected or host unreachable
      info.error = msg.includes('fetch') || msg.includes('network') || msg.includes('connect')
        ? `Cannot reach ${url} — check VPN connection`
        : msg;
    }
  }

  info.status = 'ACTUATOR_UNAVAILABLE';
  return info;
}

function extractGitInfo(data, info) {
  const git = data.git || data.build?.git || {};
  info.branch = git.branch || '';
  const commit = git.commit || {};
  const cid = commit.id;
  if (cid && typeof cid === 'object') {
    info.commitId = cid.full || cid.abbrev || '';
    info.commitAbbrev = cid.abbrev || '';
  } else {
    info.commitId = cid || '';
    info.commitAbbrev = (cid || '').substring(0, 8);
  }
  const msg = commit.message;
  info.commitMessage = (msg && typeof msg === 'object') ? (msg.full || '') : (msg || '');
  info.commitTime = commit.time || '';
  const build = data.build || {};
  info.version = build.version || data.version || '';
  info.buildTime = build.time || '';
}
