import assert from "node:assert/strict";
import test from "node:test";
import { migrateDishPhotos, STORAGE_KEYS } from "./storage.js";

function memoryPhotoStore() {
  const photos = new Map();
  return {
    photos,
    async savePhoto(photoId, data) {
      photos.set(photoId, data);
      return photoId;
    },
    async getPhoto(photoId) {
      return photos.get(photoId) || null;
    },
    async deletePhoto(photoId) {
      photos.delete(photoId);
    },
  };
}

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("照片存储适配器支持保存、读取和删除", async () => {
  const store = memoryPhotoStore();
  await store.savePhoto("photo-1", "data:image/jpeg;base64,abc");
  assert.equal(await store.getPhoto("photo-1"), "data:image/jpeg;base64,abc");
  await store.deletePhoto("photo-1");
  assert.equal(await store.getPhoto("photo-1"), null);
});

test("历史 base64 照片迁移到照片存储并将 dishes 写回短 photoId", async () => {
  const storage = memoryStorage();
  const store = memoryPhotoStore();
  const dishes = [{ dishId: "dish-1", dishName: "菜", entries: [{ entryId: "entry-1", photo: "data:image/jpeg;base64,abc" }] }];
  const result = await migrateDishPhotos(storage, dishes, store);
  const photoId = result.dishes[0].entries[0].photo;
  assert.match(photoId, /^photo-/);
  assert.equal(await store.getPhoto(photoId), "data:image/jpeg;base64,abc");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.dishes))[0].entries[0].photo, photoId);
});

test("单条历史照片失败时清空其引用并继续迁移其他照片", async () => {
  const storage = memoryStorage();
  const saved = new Map();
  const store = {
    async savePhoto(photoId, data) {
      if (data.endsWith("bad")) throw new Error("failed");
      saved.set(photoId, data);
    },
  };
  const warnings = [];
  const dishes = [{ entries: [
    { entryId: "bad", photo: "data:image/jpeg;base64,bad" },
    { entryId: "good", photo: "data:image/jpeg;base64,good" },
    { entryId: "done", photo: "photo-existing" },
  ] }];
  const result = await migrateDishPhotos(storage, dishes, store, { warn: (...args) => warnings.push(args) });
  assert.equal(result.failedCount, 1);
  assert.equal(result.migratedCount, 1);
  assert.equal(result.dishes[0].entries[0].photo, "");
  assert.match(result.dishes[0].entries[1].photo, /^photo-/);
  assert.equal(result.dishes[0].entries[2].photo, "photo-existing");
  assert.equal(warnings.length, 1);
});
