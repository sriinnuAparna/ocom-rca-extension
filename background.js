// Service worker: opens the analysis results tab and relays messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_ANALYSIS') {
    const params = new URLSearchParams({ url: msg.runUrl });
    chrome.tabs.create({ url: chrome.runtime.getURL(`results.html?${params}`) });
  }
});
