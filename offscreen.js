// Request persistent storage in a document context.
// Sends { type: 'PERSISTENCE_RESULT', granted: boolean } back to the SW.

(async () => {
  try {
    if (!('storage' in navigator)) {
      chrome.runtime.sendMessage({ type: 'PERSISTENCE_RESULT', granted: false, reason: 'no-storage' });
      return;
    }

    const already = await navigator.storage.persisted?.();
    const granted = already || (await navigator.storage.persist?.());

    chrome.runtime.sendMessage({ type: 'PERSISTENCE_RESULT', granted: !!granted });
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'PERSISTENCE_RESULT', granted: false, error: String(err) });
  } finally {
    // Offscreen doc can be closed; keeping it around is fine too.
    if (chrome.offscreen?.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) await chrome.offscreen.closeDocument();
    }
  }
})();
