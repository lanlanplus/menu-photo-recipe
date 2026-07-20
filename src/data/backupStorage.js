import { createId } from "./model.js";
import { listPhotos, replaceAllPhotos } from "./photoStorage.js";
import { saveDishes, saveOrders } from "./storage.js";

export const BACKUP_DB_NAME = "photo-menu-backups-v1";
const BACKUP_STORE_NAME = "snapshots";
const BACKUP_DB_VERSION = 1;
const MAX_BACKUPS = 10;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("备份存储操作失败"));
  });
}

function openBackupDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(BACKUP_STORE_NAME)) {
      database.createObjectStore(BACKUP_STORE_NAME, { keyPath: "backupId" });
    }
  };
  return requestResult(request);
}

async function withBackupStore(mode, action, indexedDB) {
  const database = await openBackupDatabase(indexedDB);
  try {
    const transaction = database.transaction(BACKUP_STORE_NAME, mode);
    const result = await action(transaction.objectStore(BACKUP_STORE_NAME));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("备份事务失败"));
      transaction.onabort = () => reject(transaction.error || new Error("备份事务已取消"));
    });
    return result;
  } finally {
    database.close();
  }
}

export function validateBackupSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("备份文件格式无效");
  if (!Array.isArray(snapshot.dishes) || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.photos)) {
    throw new Error("备份文件缺少必要数据");
  }
  return snapshot;
}

export async function createLocalBackup({ dishes, orders, reason = "manual" }, dependencies = {}) {
  const indexedDB = dependencies.indexedDB || globalThis.indexedDB;
  const photoRecords = dependencies.listPhotos
    ? await dependencies.listPhotos()
    : await listPhotos(indexedDB);
  const snapshot = {
    format: "photo-menu-backup",
    version: 1,
    backupId: createId("backup"),
    createdAt: new Date().toISOString(),
    reason,
    dishes: structuredClone(dishes || []),
    orders: structuredClone(orders || []),
    photos: structuredClone(photoRecords || []),
  };
  validateBackupSnapshot(snapshot);
  await withBackupStore("readwrite", (store) => requestResult(store.put(snapshot)), indexedDB);

  const backups = await listLocalBackups(indexedDB);
  for (const oldBackup of backups.slice(MAX_BACKUPS)) {
    await withBackupStore("readwrite", (store) => requestResult(store.delete(oldBackup.backupId)), indexedDB);
  }
  return snapshot;
}

export async function listLocalBackups(indexedDB = globalThis.indexedDB) {
  const records = await withBackupStore("readonly", (store) => requestResult(store.getAll()), indexedDB);
  return records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getLocalBackup(backupId, indexedDB = globalThis.indexedDB) {
  const snapshot = await withBackupStore("readonly", (store) => requestResult(store.get(backupId)), indexedDB);
  return snapshot ? validateBackupSnapshot(snapshot) : null;
}

export async function importLocalBackup(snapshot, indexedDB = globalThis.indexedDB) {
  const valid = validateBackupSnapshot(snapshot);
  const imported = { ...structuredClone(valid), backupId: createId("backup"), createdAt: new Date().toISOString(), reason: "import" };
  await withBackupStore("readwrite", (store) => requestResult(store.put(imported)), indexedDB);
  return imported;
}

export async function restoreLocalBackup(snapshot, { storage = globalThis.localStorage, indexedDB = globalThis.indexedDB } = {}) {
  const valid = validateBackupSnapshot(snapshot);
  await replaceAllPhotos(valid.photos, indexedDB);
  saveDishes(storage, valid.dishes);
  saveOrders(storage, valid.orders);
  return { dishes: valid.dishes, orders: valid.orders };
}
