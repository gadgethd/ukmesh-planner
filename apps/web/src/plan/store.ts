/**
 * Local plan persistence (Stage 6): plans live in the browser's IndexedDB —
 * no account, no server round-trip. Sharing is a separate, explicit opt-in
 * (see the share client); nothing leaves the device unless the visitor asks.
 */
import type { Mode } from './planState.js';
import type { RfSettings } from '@ukmesh-planner/contracts';

export interface SerializedPlan {
  version: 1;
  mode: Mode;
  site: { lat: number; lon: number; antennaHeightAglM: number } | null;
  rf: RfSettings;
}

export interface StoredPlan {
  id: string;
  name: string;
  savedAt: string;
  plan: SerializedPlan;
}

export interface PlanSummary {
  id: string;
  name: string;
  savedAt: string;
}

const DB_NAME = 'ukmesh-planner';
const DB_VERSION = 2;
const STORE = 'plans';
const SHARES = 'share-meta';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      // v2: local metadata for plans this browser has shared (id + revoke
      // token). The share itself lives on the server; this is only how the
      // creator can later revoke or reference it.
      if (!db.objectStoreNames.contains(SHARES)) {
        db.createObjectStore(SHARES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb-open-failed'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb-request-failed'));
  });
}

export async function savePlan(name: string, plan: SerializedPlan): Promise<string> {
  const db = await openDb();
  try {
    const record: StoredPlan = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled plan',
      savedAt: new Date().toISOString(),
      plan,
    };
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
    return record.id;
  } finally {
    db.close();
  }
}

export async function listPlans(): Promise<PlanSummary[]> {
  const db = await openDb();
  try {
    const all = await requestToPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredPlan[]>,
    );
    return all
      .map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } finally {
    db.close();
  }
}

export async function loadPlan(id: string): Promise<StoredPlan | null> {
  const db = await openDb();
  try {
    const rec = await requestToPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(id) as IDBRequest<StoredPlan | undefined>,
    );
    return rec ?? null;
  } finally {
    db.close();
  }
}

export async function deletePlan(id: string): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

export interface ShareMeta {
  id: string;
  revokeToken: string;
  createdAt: string;
  expiresAt: string;
  name: string;
}

export async function saveShareMeta(meta: ShareMeta): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(SHARES, 'readwrite').objectStore(SHARES).put(meta));
  } finally {
    db.close();
  }
}

export async function listShareMetas(): Promise<ShareMeta[]> {
  const db = await openDb();
  try {
    const all = await requestToPromise(
      db.transaction(SHARES, 'readonly').objectStore(SHARES).getAll() as IDBRequest<ShareMeta[]>,
    );
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } finally {
    db.close();
  }
}

export async function deleteShareMeta(id: string): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(SHARES, 'readwrite').objectStore(SHARES).delete(id));
  } finally {
    db.close();
  }
}
