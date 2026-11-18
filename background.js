// Clicking the toolbar icon opens/closes the Clip Finder panel on the current YouTube video.
function flash(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#ff283c' });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
    // Not on YouTube: open YouTube so the icon click always does something
    chrome.tabs.create({ url: 'https://www.youtube.com/' });
    return;
  }
  const target = { tabId: tab.id };
  const toggle = () =>
    chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: () => (typeof window.__ycfToggle === 'function' ? window.__ycfToggle() : null),
    });
  try {
    let [{ result }] = await toggle();
    if (result === null) {
      // Tab was opened before the extension was installed: inject it now
      await chrome.scripting.insertCSS({ target, files: ['styles.css'] });
      await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['content.js'] });
      [{ result }] = await toggle();
    }
    if (result === false) flash(tab.id, 'VID'); // on YouTube but not on a video page
  } catch (e) {
    flash(tab.id, 'ERR');
    console.error('Clip Finder:', e);
  }
});
