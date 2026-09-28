// Service worker — opens options page when requested by content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});
