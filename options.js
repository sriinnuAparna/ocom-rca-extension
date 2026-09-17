'use strict';
const input      = document.getElementById('token-input');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const saveStatus = document.getElementById('save-status');

// Load existing token on page open
chrome.storage.local.get('githubToken', ({ githubToken }) => {
  if (githubToken) {
    input.value = githubToken;
    setTokenStatus(true);
  }
});

function setTokenStatus(hasToken) {
  statusDot.className  = hasToken ? 'dot dot-ok' : 'dot dot-none';
  statusText.textContent = hasToken ? 'Token saved ✓ — used automatically every analysis' : 'No token saved yet';
}

function saveToken() {
  const token = input.value.trim();
  if (!token) { showMsg('Enter a token first', false); return; }
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_') && token.length < 20) {
    showMsg('Token looks invalid — check it starts with ghp_…', false); return;
  }
  chrome.storage.local.set({ githubToken: token }, () => {
    setTokenStatus(true);
    showMsg('Saved ✓', true);
    setTimeout(() => { saveStatus.style.display = 'none'; }, 3000);
  });
}

function clearToken() {
  chrome.storage.local.remove('githubToken', () => {
    input.value = '';
    setTokenStatus(false);
    showMsg('Cleared', true);
    setTimeout(() => { saveStatus.style.display = 'none'; }, 2000);
  });
}

function showMsg(msg, ok) {
  saveStatus.textContent = msg;
  saveStatus.className   = `status ${ok ? 'ok' : 'err'}`;
  saveStatus.style.display = 'inline';
}

function toggleVisibility() {
  input.type = input.type === 'password' ? 'text' : 'password';
}

// Save on Enter
input.addEventListener('keydown', e => { if (e.key === 'Enter') saveToken(); });

function reloadExt() {
  const el = document.getElementById('reload-status');
  if (el) { el.textContent = 'Reloading…'; el.className = 'status ok'; el.style.display = 'inline'; }
  setTimeout(() => chrome.runtime.reload(), 300);
}

// Wire all buttons via addEventListener (MV3 CSP blocks inline onclick handlers)
document.getElementById('btn-save').addEventListener('click', saveToken);
document.getElementById('btn-clear').addEventListener('click', clearToken);
document.getElementById('btn-toggle').addEventListener('click', toggleVisibility);
document.getElementById('btn-reload-ext').addEventListener('click', reloadExt);
