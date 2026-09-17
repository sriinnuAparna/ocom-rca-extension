'use strict';
// GitHub API client with in-memory cache
const _cache = new Map();

function clearCacheForModule(moduleName) {
  // Evict all cache entries that contain the repo name for this module
  const hint = (moduleName || '').replace('ocom-', '');
  for (const key of _cache.keys()) {
    if (key.includes(hint)) _cache.delete(key);
  }
}

function clearActuatorCache() {
  // Actuator responses aren't in _cache (they use fetch directly), nothing to do here
}

async function ghFetch(path, token, params = {}) {
  const url = new URL(GH_API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const key = url.toString();
  if (_cache.has(key)) return _cache.get(key);

  const headers = { 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    // Read GitHub's error body for a useful message
    let ghMsg = '';
    try { const body = await resp.json(); ghMsg = body.message || ''; } catch {}

    if (resp.status === 401) throw new Error(`TOKEN_INVALID: ${ghMsg || 'Bad credentials'}`);
    if (resp.status === 403) throw new Error(`TOKEN_NO_ACCESS: ${ghMsg || 'Forbidden — check token scopes or SSO authorization'}`);
    if (resp.status === 404) throw new Error(`NOT_FOUND_404: ${ghMsg || 'Resource not found — repo may be private, token may lack access, or SSO not authorized'}`);
    throw new Error(`GitHub API ${resp.status}: ${ghMsg || path}`);
  }

  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('json') ? await resp.json() : await resp.text();
  _cache.set(key, data);
  return data;
}

// Validates token + checks org access. Returns { ok, user, error }
async function verifyToken(token) {
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  try {
    const user = await ghFetch('/user', token);
    return { ok: true, user: user.login };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ghFetchBytes(path, token) {
  const url = GH_API + path;
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getWorkflowRun(owner, repo, runId, token) {
  return ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}`, token);
}

async function getWorkflowJobs(owner, repo, runId, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, token, { per_page: 100, filter: 'all' });
  return data.jobs || [];
}

// Max bytes to read from a log — failures appear at the tail
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Streams a response body to a string.
// Uses separate bytesReceived (always increases) for accurate speed/ETA.
// Keeps a rolling window of the last 2×LOG_MAX_BYTES so memory stays bounded.
async function _streamLog(resp, totalExpectedBytes, label, startTime, progressCb) {
  const totalMB = totalExpectedBytes > 0 ? (totalExpectedBytes / 1024 / 1024).toFixed(0) : '?';
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks  = [];
  let bufferSize    = 0; // current bytes held in chunks[] (decreases when old chunks drop)
  let bytesReceived = 0; // absolute total received — never decreases
  let lastTickTime  = Date.now();
  let lastTickBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bufferSize    += value.byteLength;
    bytesReceived += value.byteLength;

    const now = Date.now();
    if (now - lastTickTime >= 2000) {
      const elapsed  = (now - startTime) / 1000;
      const speedKB  = ((bytesReceived - lastTickBytes) / (now - lastTickTime) * 1000 / 1024).toFixed(0);
      const recvMB   = (bytesReceived / 1024 / 1024).toFixed(1);
      const etaPart  = (totalExpectedBytes > 0 && bytesReceived < totalExpectedBytes && elapsed > 2)
        ? `  •  ETA ~${Math.ceil((totalExpectedBytes - bytesReceived) / (bytesReceived / elapsed) / 60)}min`
        : '';
      progressCb?.(`${label}: ${recvMB} / ${totalMB} MB  •  ${speedKB} KB/s  •  ${elapsed.toFixed(0)}s${etaPart}`);
      lastTickTime  = now;
      lastTickBytes = bytesReceived;
    }

    // Rolling window — keep only last 2×LOG_MAX_BYTES in memory
    while (bufferSize > LOG_MAX_BYTES * 2 && chunks.length > 1) {
      bufferSize -= chunks.shift().byteLength;
    }
  }
  return chunks.map(c => decoder.decode(c, { stream: true })).join('');
}

async function getJobLogs(owner, repo, jobId, token, progressCb) {
  const path = `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  const url  = GH_API + path;
  const authHeaders = { 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) authHeaders['Authorization'] = `Bearer ${token}`;
  const t0 = Date.now();

  // ── Attempt 1: include Range in the very first GitHub request ────────────────
  // GitHub's redirect passes it to the CDN; some CDNs only honor it this way.
  try {
    progressCb?.('Connecting — trying Range request…');
    const r1 = await fetch(url, { headers: { ...authHeaders, 'Range': `bytes=-${LOG_MAX_BYTES}` } });

    const cl1 = Number.parseInt(r1.headers.get('content-length') || '0', 10);
    const cr1 = r1.headers.get('content-range') || '';
    const totalBytes = Number.parseInt((cr1.match(/\/(\d+)$/) || [])[1] || '0', 10);
    const totalMB = (totalBytes || cl1) > 0 ? ((totalBytes || cl1) / 1024 / 1024).toFixed(0) : '?';

    if (r1.status === 206) {
      // Range honored on first try — only 10 MB to download
      progressCb?.(`Log ${totalMB} MB total — Range accepted, downloading last 10 MB…`);
      const text = await _streamLog(r1, cl1, 'Downloading tail', t0, progressCb);
      progressCb?.(`Done — last 10 MB of ${totalMB} MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);
      return `\n[... log truncated — showing last 10 MB of ${totalMB} MB ...]\n` + text;
    }

    if (r1.ok && cl1 <= LOG_MAX_BYTES) {
      // Small log — download fully
      progressCb?.(`Log size: ${totalMB} MB — downloading…`);
      const text = await _streamLog(r1, cl1, 'Downloading', t0, progressCb);
      progressCb?.(`Done — ${(text.length/1024).toFixed(0)} KB in ${((Date.now()-t0)/1000).toFixed(1)}s`);
      return text;
    }

    // ── Attempt 2: Range directly to CDN URL (r1.url is the redirected CDN URL) ─
    const cdnUrl = r1.url;
    progressCb?.(`Log ${totalMB} MB — Range via redirect not honored, trying CDN URL directly…`);
    try { r1.body?.cancel(); } catch {}

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45_000);
    let r2 = null;
    try {
      r2 = await fetch(cdnUrl, { headers: { 'Range': `bytes=-${LOG_MAX_BYTES}` }, signal: ac.signal });
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      progressCb?.(`CDN Range failed (${e.name === 'AbortError' ? 'timeout 45s' : (e.message||'').substring(0,40)}) — streaming full log…`);
    }

    if (r2 && r2.status === 206) {
      const cl2 = Number.parseInt(r2.headers.get('content-length') || '0', 10);
      progressCb?.(`CDN Range accepted — downloading last 10 MB of ${totalMB} MB…`);
      const text = await _streamLog(r2, cl2, 'Downloading tail', t0, progressCb);
      progressCb?.(`Done — last 10 MB of ${totalMB} MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);
      return `\n[... log truncated — showing last 10 MB of ${totalMB} MB ...]\n` + text;
    }

    // Range not supported anywhere — stream full file with rolling window + ETA
    const fullSizeMB = totalMB;
    progressCb?.(`⚠ Range not supported by CDN — must stream full ${fullSizeMB} MB. Progress shown every 2s.`);
    const streamResp = r2 ?? await fetch(url, { headers: authHeaders });
    if (!streamResp.ok) return '';
    const clStream = Number.parseInt(streamResp.headers.get('content-length') || cl1 || '0', 10);
    const full = await _streamLog(streamResp, clStream, 'Streaming', t0, progressCb);
    const trimmed = full.length > LOG_MAX_BYTES
      ? `\n[... log truncated — showing last 10 MB of ${fullSizeMB} MB ...]\n` + full.slice(-LOG_MAX_BYTES)
      : full;
    progressCb?.(`Stream done — ${fullSizeMB} MB in ${((Date.now()-t0)/1000).toFixed(0)}s`);
    return trimmed;

  } catch (e) {
    progressCb?.(`Log error: ${(e.message || '').substring(0, 80)}`);
    return '';
  }
}

// Returns check-run annotations for a job (failure annotations = test failures).
// This is orders of magnitude faster than parsing raw logs — JSON API, no download.
async function getJobAnnotations(owner, repo, job, token) {
  const checkRunUrl = job.check_run_url || '';
  const checkRunId  = checkRunUrl.split('/').pop();
  if (!checkRunId || !/^\d+$/.test(checkRunId)) return [];
  try {
    const pages = [];
    for (let page = 1; page <= 5; page++) {
      const data = await ghFetch(
        `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
        token, { per_page: 100, page }
      );
      if (!Array.isArray(data) || data.length === 0) break;
      pages.push(...data);
      if (data.length < 100) break;
    }
    return pages;
  } catch { return []; }
}

async function getArtifacts(owner, repo, runId, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, token, { per_page: 100 });
  return data.artifacts || [];
}

async function downloadArtifactZip(owner, repo, artifactId, token) {
  return ghFetchBytes(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, token);
}

async function getFileContent(owner, repo, path, ref, token) {
  try {
    const data = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, token, { ref });
    if (data && data.content) {
      return atob(data.content.replace(/\s/g, ''));
    }
  } catch {}
  return '';
}

async function getDirListing(owner, repo, path, ref, token) {
  try {
    const data = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, token, { ref });
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function getRecentCommits(owner, repo, branch, count, token) {
  try { return await ghFetch(`/repos/${owner}/${repo}/commits`, token, { sha: branch, per_page: count }); }
  catch { return []; }
}
