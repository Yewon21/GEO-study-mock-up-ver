/* ----------------------------------------------------------------
   저장소 (데이터 보존이 최우선)

   우선순위:
   1) window.storage  — Claude 아티팩트 안에서 실행될 때만 존재
   2) IndexedDB       — 일반 배포(Vercel 등)의 기본 저장소. 용량 수백 MB 이상
   3) localStorage    — IndexedDB를 못 쓰는 환경의 최후 수단 (약 5MB)

   기존에 localStorage에 저장돼 있던 데이터는 첫 실행 때 IndexedDB로 자동 이사시킨다.
   이사 후에도 localStorage 원본은 지우지 않는다 (혹시 모를 사고 대비 백업).
----------------------------------------------------------------- */

const DB_NAME = "geomemo-db";
const STORE = "kv";
const DB_VERSION = 1;
const LS_PREFIX = "geomemo:";
const MIGRATED_FLAG = "geomemo:__migrated_to_idb__";

/* ---------- 호스트 저장소 (Claude 아티팩트) ---------- */
const hasHostStorage = () =>
  typeof window !== "undefined" &&
  window.storage &&
  typeof window.storage.get === "function";

/* ---------- IndexedDB ---------- */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB 미지원"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 열기 실패"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  // 실패했으면 다음 호출 때 다시 시도할 수 있게 캐시를 비운다
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function idbRun(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let out;
        const req = fn(store);
        if (req) req.onsuccess = () => (out = req.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("트랜잭션 중단"));
      })
  );
}

const idbGet = (key) => idbRun("readonly", (s) => s.get(key));
const idbSet = (key, value) =>
  idbRun("readwrite", (s) => s.put(value, key)).then(() => true);
const idbDelete = (key) => idbRun("readwrite", (s) => s.delete(key));
const idbKeys = () => idbRun("readonly", (s) => s.getAllKeys());

/* ---------- localStorage ---------- */
function lsGet(key) {
  try {
    return window.localStorage.getItem(LS_PREFIX + key);
  } catch (e) {
    return null;
  }
}
function lsSet(key, value) {
  try {
    window.localStorage.setItem(LS_PREFIX + key, value);
    return true;
  } catch (e) {
    // 용량 초과 등
    return false;
  }
}
function lsDelete(key) {
  try {
    window.localStorage.removeItem(LS_PREFIX + key);
  } catch (e) {}
}

/* ---------- 백엔드 선택 (한 번만 결정) ---------- */
let backendPromise = null;

function pickBackend() {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if (hasHostStorage()) return "host";
    try {
      await openDB();
      await migrateFromLocalStorage();
      return "idb";
    } catch (e) {
      console.warn("[storage] IndexedDB 사용 불가, localStorage로 대체합니다.", e);
      return "ls";
    }
  })();
  return backendPromise;
}

/* localStorage → IndexedDB 이사 (최초 1회) */
async function migrateFromLocalStorage() {
  let already = null;
  try {
    already = window.localStorage.getItem(MIGRATED_FLAG);
  } catch (e) {
    return;
  }
  if (already) return;

  const pairs = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const fullKey = window.localStorage.key(i);
      if (!fullKey || !fullKey.startsWith(LS_PREFIX)) continue;
      if (fullKey === MIGRATED_FLAG) continue;
      pairs.push([
        fullKey.slice(LS_PREFIX.length),
        window.localStorage.getItem(fullKey),
      ]);
    }
  } catch (e) {
    return;
  }

  for (const [key, value] of pairs) {
    if (value == null) continue;
    try {
      const existing = await idbGet(key);
      if (existing == null) await idbSet(key, value);
    } catch (e) {
      console.warn("[storage] 이사 실패:", key, e);
    }
  }

  try {
    window.localStorage.setItem(MIGRATED_FLAG, new Date().toISOString());
  } catch (e) {}
  if (pairs.length) {
    console.info(`[storage] 기존 데이터 ${pairs.length}개를 IndexedDB로 옮겼습니다.`);
  }
}

/* ---------- 공개 API (기존 코드와 동일한 시그니처) ---------- */
export async function safeGet(key) {
  const backend = await pickBackend();
  if (backend === "host") {
    try {
      const res = await window.storage.get(key, false);
      if (res) return res.value;
    } catch (e) {}
    return lsGet(key);
  }
  if (backend === "idb") {
    try {
      const v = await idbGet(key);
      if (v != null) return v;
    } catch (e) {
      console.warn("[storage] 읽기 실패:", key, e);
    }
    // IndexedDB에 없으면 예전 localStorage 값이라도 살려본다
    return lsGet(key);
  }
  return lsGet(key);
}

export async function safeSet(key, value) {
  const backend = await pickBackend();
  if (backend === "host") {
    try {
      await window.storage.set(key, value, false);
    } catch (e) {}
    return lsSet(key, value);
  }
  if (backend === "idb") {
    try {
      await idbSet(key, value);
      return true;
    } catch (e) {
      console.error("[storage] 저장 실패, localStorage로 재시도:", key, e);
      return lsSet(key, value);
    }
  }
  return lsSet(key, value);
}

export async function safeDelete(key) {
  const backend = await pickBackend();
  if (backend === "host") {
    try {
      await window.storage.delete(key, false);
    } catch (e) {}
    lsDelete(key);
    return;
  }
  if (backend === "idb") {
    try {
      await idbDelete(key);
    } catch (e) {
      console.warn("[storage] 삭제 실패:", key, e);
    }
  }
  lsDelete(key);
}

/* ---------- 진단용 ---------- */
export async function storageInfo() {
  const backend = await pickBackend();
  let keys = [];
  if (backend === "idb") {
    try {
      keys = await idbKeys();
    } catch (e) {}
  }
  let quota = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      quota = await navigator.storage.estimate();
    }
  } catch (e) {}
  return { backend, keyCount: keys.length, keys, quota };
}

/* 브라우저가 저장 공간을 함부로 비우지 못하게 요청한다.
   (사용자가 앱을 자주 쓰면 대체로 승인됨. 실패해도 앱 동작엔 지장 없음) */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (e) {}
  return false;
}

if (typeof window !== "undefined") {
  // 콘솔에서 geoStorageInfo() 쳐보면 현재 저장 상태를 볼 수 있다
  window.geoStorageInfo = storageInfo;
}
