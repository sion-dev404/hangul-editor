// 자동 복구 보관소: 저장하지 못하고 닫힌 문서를 브라우저 안(IndexedDB)에 잠시 보관한다.
// localStorage보다 훨씬 많이(그림이 든 큰 문서도) 넣을 수 있다.
const DB = 'hangul-editor-recovery';
const STORE = 'docs';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// 실패해도 화면 동작을 막지 않는다 (개인정보 보호 모드 등에서는 보관소가 없을 수 있다)
export async function putRecovery(key, value) {
  try { await run('readwrite', (s) => s.put(value, key)); return true; } catch { return false; }
}
export async function getRecovery(key) {
  try { return (await run('readonly', (s) => s.get(key))) || null; } catch { return null; }
}
export async function delRecovery(key) {
  try { await run('readwrite', (s) => s.delete(key)); } catch { /* 무시 */ }
}

export const clock = () => new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
