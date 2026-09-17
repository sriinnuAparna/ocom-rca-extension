'use strict';
// Persistent log cache backed by IndexedDB.
// Keyed by runId + jobId. TTL = 30 days. Non-fatal on any error.
const LogCache = (() => {
  const DB_NAME  = 'ocom_rca_log_cache';
  const STORE    = 'logs';
  const TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('expiresAt', 'expiresAt');
        }
      };
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
    });
  }

  // Returns cached log text, or null if not found / expired
  async function get(runId, jobId) {
    try {
      const db  = await openDB();
      const key = `${runId}_${jobId}`;
      return new Promise(resolve => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = e => {
          const rec = e.target.result;
          if (!rec)                       return resolve(null);
          if (Date.now() > rec.expiresAt) { _del(db, key); return resolve(null); }
          resolve(rec.text);
        };
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }

  // Stores log text with 30-day TTL
  async function set(runId, jobId, text) {
    try {
      const db  = await openDB();
      const key = `${runId}_${jobId}`;
      return new Promise(resolve => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          key,
          runId:     String(runId),
          jobId:     String(jobId),
          text,
          savedAt:   Date.now(),
          expiresAt: Date.now() + TTL_MS,
          sizeMB:    (text.length / 1024 / 1024).toFixed(1),
        });
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
      });
    } catch { /* non-fatal */ }
  }

  function _del(db, key) {
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); } catch {}
  }

  // Deletes all entries older than TTL — call once at startup
  async function cleanup() {
    try {
      const db = await openDB();
      return new Promise(resolve => {
        const tx    = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req   = store.openCursor();
        let deleted = 0;
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor) return;
          if (Date.now() > cursor.value.expiresAt) { cursor.delete(); deleted++; }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(deleted);
        tx.onerror    = () => resolve(0);
      });
    } catch { return 0; }
  }

  // Returns metadata for all cached entries (no text — lightweight)
  async function list() {
    try {
      const db = await openDB();
      return new Promise(resolve => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = e => resolve((e.target.result || []).map(r => ({
          key: r.key, runId: r.runId, jobId: r.jobId,
          sizeMB: r.sizeMB, savedAt: r.savedAt, expiresAt: r.expiresAt,
        })));
        req.onerror = () => resolve([]);
      });
    } catch { return []; }
  }

  return { get, set, cleanup, list };
})();
