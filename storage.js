/* ----------------------------------------------------------------
   저장소 (데이터 보존이 최우선)

   로그인한 사용자는 Supabase(클라우드 DB)에 저장돼서 기기를 바꿔도
   같은 데이터가 보인다. 계정마다 자기 데이터만 보이도록 서버 쪽
   Row Level Security로 강제한다 (supabase/schema.sql 참고).

   로그인 전이거나 Supabase 설정이 없을 때는 예전처럼 브라우저에만
   저장한다 (우선순위: host storage → IndexedDB → localStorage).
----------------------------------------------------------------- */

import { createClient } from "@supabase/supabase-js";

const DB_NAME = "geomemo-db";
const STORE = "kv";
const DB_VERSION = 1;
const LS_PREFIX = "geomemo:";
const MIGRATED_FLAG = "geomemo:__migrated_to_idb__";

/* ---------- Supabase ---------- */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let currentUserId = null;
let authListeners = [];
let resolveAuthReady;
export const authReady = new Promise((resolve) => {
  resolveAuthReady = resolve;
});

if (supabase) {
  supabase.auth
    .getSession()
    .then(({ data }) => {
      currentUserId = data.session?.user?.id || null;
    })
    .catch(() => {})
    .finally(() => resolveAuthReady());

  supabase.auth.onAuthStateChange((_event, session) => {
    currentUserId = session?.user?.id || null;
    authListeners.forEach((fn) => fn(session));
  });
} else {
  resolveAuthReady();
}

export function onAuthStateChange(fn) {
  authListeners.push(fn);
  return () => {
    authListeners = authListeners.filter((f) => f !== fn);
  };
}

export function getCurrentUserId() {
  return currentUserId;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error("Supabase가 설정되지 않았습니다.");
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
}

export async function signOutUser() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

async function kvGetRemote(key) {
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("user_id", currentUserId)
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.warn("[storage] 원격 읽기 실패:", key, error);
    return null;
  }
  return data ? data.value : null;
}

async function kvSetRemote(key, value) {
  const { error } = await supabase
    .from("kv_store")
    .upsert({ user_id: currentUserId, key, value, updated_at: new Date().toISOString() });
  if (error) {
    console.error("[storage] 원격 저장 실패:", key, error);
    return false;
  }
  return true;
}

async function kvDeleteRemote(key) {
  const { error } = await supabase.from("kv_store").delete().eq("user_id", currentUserId).eq("key", key);
  if (error) console.warn("[storage] 원격 삭제 실패:", key, error);
}

async function kvKeysRemote() {
  const { data, error } = await supabase.from("kv_store").select("key").eq("user_id", currentUserId);
  if (error) return [];
  return (data || []).map((r) => r.key);
}

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
  if (supabase && currentUserId) return kvGetRemote(key);

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
  if (supabase && currentUserId) {
    const ok = await kvSetRemote(key, value);
    if (ok) return true;
    // 네트워크 문제 등으로 실패하면 로컬에라도 남겨서 다음 로그인 때 안 잃도록 한다
    return lsSet(key, value);
  }

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
  if (supabase && currentUserId) {
    await kvDeleteRemote(key);
    lsDelete(key);
    return;
  }

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

/* 저장된 키 중 prefix로 시작하는 것들을 모두 나열한다.
   별도의 "인덱스" 키를 따로 관리하지 않고 실제 저장된 키를 직접 조회하므로,
   인덱스 갱신이 누락돼도(예: 과거 버그) 실제 데이터는 항상 찾아낼 수 있다. */
export async function listKeys(prefix = "") {
  if (supabase && currentUserId) {
    const keys = await kvKeysRemote();
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  const backend = await pickBackend();
  if (backend === "idb") {
    try {
      const keys = await idbKeys();
      if (keys && keys.length) {
        return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      }
    } catch (e) {}
  }

  // localStorage (host 백엔드의 미러 포함)에서 직접 스캔
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const fullKey = window.localStorage.key(i);
      if (!fullKey || !fullKey.startsWith(LS_PREFIX) || fullKey === MIGRATED_FLAG) continue;
      const key = fullKey.slice(LS_PREFIX.length);
      if (!prefix || key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch (e) {
    return [];
  }
}

/* ---------- 로컬 → 계정 1회 이전 ---------- */
async function collectLegacyLocalKeys() {
  const keys = new Set();
  try {
    const idbList = await idbKeys();
    (idbList || []).forEach((k) => keys.add(k));
  } catch (e) {}
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const fullKey = window.localStorage.key(i);
      if (fullKey && fullKey.startsWith(LS_PREFIX) && fullKey !== MIGRATED_FLAG) {
        keys.add(fullKey.slice(LS_PREFIX.length));
      }
    }
  } catch (e) {}
  return [...keys];
}

export async function hasLegacyLocalData() {
  const keys = await collectLegacyLocalKeys();
  return keys.length > 0;
}

/* 이 기기의 브라우저 저장소에 남아있는 데이터를 지금 로그인한 계정으로 옮긴다.
   이미 계정에 값이 있는 키는 덮어쓰지 않는다 (계정 데이터가 우선). */
export async function migrateLegacyLocalDataToAccount() {
  if (!supabase || !currentUserId) return { migrated: 0, skipped: 0 };
  const keys = await collectLegacyLocalKeys();
  let migrated = 0;
  let skipped = 0;
  for (const key of keys) {
    let value = null;
    try {
      value = await idbGet(key);
    } catch (e) {}
    if (value == null) value = lsGet(key);
    if (value == null) continue;

    const existing = await kvGetRemote(key);
    if (existing != null) {
      skipped++;
      continue;
    }
    const ok = await kvSetRemote(key, value);
    if (ok) migrated++;
  }
  return { migrated, skipped };
}

/* ---------- 진단용 ---------- */
export async function storageInfo() {
  if (supabase && currentUserId) {
    const keys = await kvKeysRemote();
    return { backend: "supabase", keyCount: keys.length, keys, quota: null };
  }

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
