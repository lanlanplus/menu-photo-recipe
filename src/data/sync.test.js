import assert from "node:assert/strict";
import test from "node:test";
import { createSyncPreview, mergeAppStates } from "./sync.js";

test("本地与云端独立记录做非破坏并集", () => {
  const local = { dishes: [{ dishId: "local-dish", dishName: "番茄炒蛋", entries: [{ entryId: "local-entry", note: "本地" }] }], orders: [], photoIds: ["local-photo"] };
  const cloud = { dishes: [{ dishId: "cloud-dish", dishName: "番茄炒蛋", entries: [{ entryId: "cloud-entry", note: "云端" }] }], orders: [{ orderId: "cloud-order", dishIds: ["cloud-dish"], status: "active" }], photoIds: ["cloud-photo"] };
  const { merged, conflicts } = mergeAppStates(local, cloud);
  assert.equal(merged.dishes.length, 1);
  assert.deepEqual(merged.dishes[0].entries.map((entry) => entry.entryId), ["local-entry", "cloud-entry"]);
  assert.deepEqual(new Set(merged.photoIds), new Set(["local-photo", "cloud-photo"]));
  assert.deepEqual(merged.orders[0].dishIds, ["local-dish"]);
  assert.deepEqual(conflicts, []);
});

test("同一entry发生分叉时保留本地并创建云端冲突副本", () => {
  const local = { dishes: [{ dishName: "菜", entries: [{ entryId: "entry-a", note: "本地版本" }] }], orders: [] };
  const cloud = { dishes: [{ dishName: "菜", entries: [{ entryId: "entry-a", note: "云端版本" }] }], orders: [] };
  const { merged, conflicts } = mergeAppStates(local, cloud);
  assert.equal(merged.dishes[0].entries.length, 2);
  assert.equal(merged.dishes[0].entries[0].note, "本地版本");
  assert.equal(merged.dishes[0].entries[1].note, "云端版本");
  assert.equal(conflicts.length, 1);
});

test("同步预览只计算差异，不修改输入状态", () => {
  const local = { dishes: [{ dishName: "菜A", entries: [{ entryId: "a" }] }], orders: [], photoIds: ["p-a"] };
  const cloud = { dishes: [{ dishName: "菜B", entries: [{ entryId: "b" }] }], orders: [], photoIds: ["p-b"] };
  const before = structuredClone(local);
  const preview = createSyncPreview(local, cloud);
  assert.equal(preview.uploadEntryCount, 1);
  assert.equal(preview.downloadEntryCount, 1);
  assert.deepEqual(preview.uploadPhotoIds, ["p-a"]);
  assert.deepEqual(preview.downloadPhotoIds, ["p-b"]);
  assert.deepEqual(local, before);
});
