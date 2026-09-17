// Inject "⚙ Analyze RCA" button on GitHub Actions run pages
(function () {
  if (!location.href.match(/github\.com\/.+\/actions\/runs\/\d+/)) return;

  function createBtn() {
    const btn = document.createElement('button');
    btn.id = 'ocom-rca-btn';
    btn.textContent = '⚙ Analyze RCA';
    btn.title = 'Open OCOM RCA Analyzer for this run';
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_ANALYSIS', runUrl: location.href });
    });
    return btn;
  }

  function injectInPage() {
    if (document.getElementById('ocom-rca-btn')) return true;

    // Try multiple GitHub UI selectors — GitHub changes these occasionally
    const target =
      document.querySelector('[data-testid="workflow-run-header"] .d-flex') ||
      document.querySelector('[data-testid="workflow-run-header"]') ||
      document.querySelector('.PageHeader-actions') ||
      document.querySelector('.PageHeader') ||
      document.querySelector('[aria-label="Re-run jobs"]')?.closest('.d-flex') ||
      document.querySelector('.gh-header-actions') ||
      document.querySelector('.subnav') ||
      document.querySelector('.js-check-run-actions') ||
      document.querySelector('.container-xl.px-3.px-md-4.px-lg-5 .d-flex.flex-wrap');

    if (!target) return false;

    const btn = createBtn();
    btn.style.cssText = `
      background:#58a6ff;color:#000;border:none;border-radius:6px;
      padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;
      margin-left:8px;vertical-align:middle;white-space:nowrap;
    `;
    target.appendChild(btn);
    return true;
  }

  function injectFloating() {
    if (document.getElementById('ocom-rca-btn')) return;
    if (document.getElementById('ocom-rca-float')) return;

    // Floating fallback — always visible in top-right corner
    const wrap = document.createElement('div');
    wrap.id = 'ocom-rca-float';
    wrap.style.cssText = `
      position:fixed;top:64px;right:16px;z-index:99999;
      display:flex;flex-direction:column;align-items:flex-end;gap:4px;
    `;

    const btn = createBtn();
    btn.style.cssText = `
      background:#58a6ff;color:#000;border:none;border-radius:8px;
      padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;
      box-shadow:0 4px 12px rgba(0,0,0,.4);white-space:nowrap;
    `;

    const label = document.createElement('div');
    label.textContent = 'Run: …' + location.href.split('/').pop();
    label.style.cssText = `
      font-size:10px;color:#8b949e;background:#161b22;border:1px solid #30363d;
      border-radius:4px;padding:2px 6px;font-family:monospace;max-width:200px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    `;

    wrap.appendChild(btn);
    wrap.appendChild(label);
    document.body.appendChild(wrap);
  }

  function tryInject() {
    const inPage = injectInPage();
    if (!inPage) {
      // GitHub's structure didn't match — use floating button so it's always reachable
      injectFloating();
    }
  }

  // Run immediately, after short delay, and watch for GitHub's SPA navigation
  tryInject();
  setTimeout(tryInject, 1500);
  setTimeout(tryInject, 4000);

  const obs = new MutationObserver(() => {
    if (!document.getElementById('ocom-rca-btn') && !document.getElementById('ocom-rca-float')) {
      tryInject();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
