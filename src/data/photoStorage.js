import { createId } from "./model.js";

export const PHOTO_DB_NAME = "photo-menu-db";
export const PHOTO_STORE_NAME = "photos";
const PHOTO_DB_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
  });
}

function openPhotoDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  const request = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(PHOTO_STORE_NAME)) {
      database.createObjectStore(PHOTO_STORE_NAME, { keyPath: "photoId" });
    }
  };
  return requestResult(request);
}

async function runTransaction(mode, action, indexedDB) {
  const database = await openPhotoDatabase(indexedDB);
  try {
    const transaction = database.transaction(PHOTO_STORE_NAME, mode);
    const result = await action(transaction.objectStore(PHOTO_STORE_NAME));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("照片存储事务失败"));
      transaction.onabort = () => reject(transaction.error || new Error("照片存储事务已取消"));
    });
    return result;
  } finally {
    database.close();
  }
}

export async function savePhoto(photoId, base64Data, indexedDB = globalThis.indexedDB) {
  const id = photoId || createId("photo");
  if (!base64Data || typeof base64Data !== "string") throw new Error("照片数据为空");
  await runTransaction(
    "readwrite",
    (store) => requestResult(store.put({ photoId: id, data: base64Data, createdAt: new Date().toISOString() })),
    indexedDB,
  );
  return id;
}

export async function getPhoto(photoId, indexedDB = globalThis.indexedDB) {
  if (!photoId) return null;
  const record = await runTransaction("readonly", (store) => requestResult(store.get(photoId)), indexedDB);
  return record?.data || null;
}

export async function deletePhoto(photoId, indexedDB = globalThis.indexedDB) {
  if (!photoId) return;
  await runTransaction("readwrite", (store) => requestResult(store.delete(photoId)), indexedDB);
}

export function isEmbeddedPhoto(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}
