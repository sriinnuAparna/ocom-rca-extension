'use strict';
const urlInput   = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const errEl      = document.getElementById('err');
const tokenDot   = document.getElementById('token-dot');
const tokenLabel = document.getElementById('token-label');

// ── On open: check token + pre-fill URL ──────────────────────────────────────
chrome.storage.local.get(['githubToken', 'lastRunUrl'], ({ githubToken, lastRunUrl }) => {
  if (githubToken) {
    tokenDot.className  = 'dot dot-ok';
    tokenLabel.textContent = 'Token saved ✓';
  } else {
    tokenDot.className  = 'dot dot-none';
    tokenLabel.textContent = 'No token — set one in Settings';
  }
  if (lastRunUrl) urlInput.value = lastRunUrl;
});

// Pre-fill from active tab if it's a GH Actions run page
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.url && /github\.com\/.+\/actions\/runs\/\d+/.test(tab.url)) {
    urlInput.value = tab.url;
  }
});

// ── Settings link → open options page ────────────────────────────────────────
document.getElementById('settings-link').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

// ── Analyze ───────────────────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', go);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

function go() {
  const runUrl = urlInput.value.trim();
  errEl.style.display = 'none';

  if (!runUrl) { showErr('Enter a GitHub Actions run URL'); return; }
  if (!/github\.com\/.+\/actions\/runs\/\d+/.test(runUrl)) {
    showErr('Invalid URL — must be a github.com Actions run link'); return;
  }

  chrome.storage.local.set({ lastRunUrl: runUrl });

  const params = new URLSearchParams({ url: runUrl });
  chrome.tabs.create({ url: chrome.runtime.getURL(`results.html?${params}`) });
  window.close();
}

function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

function reloadExt() {
  chrome.runtime.reload();
}

// Wire buttons — MV3 CSP blocks inline onclick; use addEventListener instead
document.getElementById('reload-btn').addEventListener('click', reloadExt);
