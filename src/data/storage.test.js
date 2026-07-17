import assert from "node:assert/strict";
import test from "node:test";
import { createActiveOrder } from "./model.js";
import {
  STORAGE_KEYS,
  addDishEntry,
  loadAppData,
  migrateLegacyRecipes,
  placeOrder,
  repairDishCategories,
  updateOrderCheckedIngredients,
  updateEntryReferenceRecipe,
} from "./storage.js";

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const legacyRecord = {
  id: "old-entry-1",
  createdAt: "2026-07-01T08:00:00.000Z",
  photo: "data:image/jpeg;base64,example",
  dishName: "麻婆豆腐",
  recipe: {
    菜名: "麻婆豆腐",
    食材清单: [
      { 名称: "豆腐", 用量: "1盒", 来源: "图片可见" },
      { 名称: "豆瓣酱", 用量: "1勺", 来源: "补充" },
    ],
    步骤: [{ 序号: 1, 内容: "小火烧至入味" }],
  },
};

test("旧扁平记录迁移为 dish/entries，并补齐新增字段", () => {
  const dishes = migrateLegacyRecipes([legacyRecord, { ...legacyRecord, id: "old-entry-2" }]);
  assert.equal(dishes.length, 1);
  assert.equal(dishes[0].entries.length, 2);
  assert.equal(dishes[0].category, "炒菜");
  assert.deepEqual(dishes[0].entries[0].visibleIngredients, [
    { 名称: "豆腐", 用量: "1盒", 来源: "图片可见" },
  ]);
  assert.equal(dishes[0].entries[0].note, "");
  assert.equal(dishes[0].entries[0].referenceRecipe.步骤[0].timerSeconds, null);
});

test("首次读取会迁移并持久化 dishes/orders，后续读取不重复迁移", () => {
  const storage = memoryStorage({ [STORAGE_KEYS.legacyRecipes]: JSON.stringify([legacyRecord]) });
  const first = loadAppData(storage);
  const second = loadAppData(storage);
  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.dishes[0].dishName, "麻婆豆腐");
  assert.deepEqual(second.orders, []);
  assert.equal(storage.getItem(STORAGE_KEYS.legacyRecipes), null);
});

test("迁移前删除含照片的旧 key，避免新旧数据同时占满配额", () => {
  let legacyExists = true;
  const values = new Map([[STORAGE_KEYS.legacyRecipes, JSON.stringify([legacyRecord])]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
      if (key === STORAGE_KEYS.legacyRecipes) legacyExists = false;
    },
    setItem: (key, value) => {
      if (key === STORAGE_KEYS.dishes && legacyExists) {
        const error = new Error("quota full");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, String(value));
    },
  };

  const result = loadAppData(storage);
  assert.equal(result.dishes[0].dishName, "麻婆豆腐");
  assert.notEqual(storage.getItem(STORAGE_KEYS.dishes), null);
  assert.notEqual(storage.getItem(STORAGE_KEYS.orders), null);
});

test("新增同名记录写入原 dish，并可从存储再次读出", () => {
  const storage = memoryStorage();
  const initial = loadAppData(storage);
  const dishes = addDishEntry(storage, initial.dishes, {
    dishName: "番茄炒蛋",
    category: "炒菜",
    entry: { photo: "photo-a", visibleIngredients: ["番茄", "鸡蛋"], note: "少糖" },
  });
  const updated = addDishEntry(storage, dishes, {
    dishName: "番茄炒蛋",
    entry: { photo: "photo-b" },
  });
  assert.equal(loadAppData(storage).dishes[0].entries.length, 2);
  assert.equal(updated.length, 1);
});

test("创建点单时只保留一个 active，并保存采购勾选字段", () => {
  const previous = createActiveOrder([], ["dish-a"]);
  const next = createActiveOrder(previous, ["dish-b", "dish-b"]);
  assert.equal(next.filter((order) => order.status === "active").length, 1);
  assert.equal(next[0].status, "done");
  assert.deepEqual(next[1].dishIds, ["dish-b"]);
  assert.deepEqual(next[1].checkedIngredientKeys, []);

  const storage = memoryStorage();
  loadAppData(storage);
  placeOrder(storage, [], ["dish-a"]);
  assert.equal(loadAppData(storage).orders[0].status, "active");
});

test("采购勾选写回指定 order，并去重保存", () => {
  const storage = memoryStorage();
  const orders = [{ orderId: "order-a", status: "active", checkedIngredientKeys: [] }];
  const updated = updateOrderCheckedIngredients(storage, orders, "order-a", ["姜", "姜", "盐"]);
  assert.deepEqual(updated[0].checkedIngredientKeys, ["姜", "盐"]);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.orders))[0].checkedIngredientKeys, ["姜", "盐"]);
});

test("生成的参考菜谱写回原 entry，并补齐计时兼容字段", () => {
  const storage = memoryStorage();
  const dishes = [{ dishId: "dish-a", entries: [{ entryId: "entry-a", referenceRecipe: null }] }];
  const updated = updateEntryReferenceRecipe(storage, dishes, "entry-a", {
    食材清单: [{ 名称: "鸡蛋", 用量: "2个" }],
    步骤: [{ 序号: 1, 内容: "炒熟即可" }],
  });
  assert.equal(updated[0].entries[0].referenceRecipe.步骤[0].timerSeconds, null);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.dishes))[0].entries[0].referenceRecipe.食材清单[0].名称, "鸡蛋");
});

test("修复历史默认分类，同时保留没有明显关键词的有效分类", () => {
  const repaired = repairDishCategories([
    { dishName: "金枪鱼牛油果拌饭", category: "炒菜" },
    { dishName: "韭黄炒鸡蛋", category: "炒菜" },
    { dishName: "牛肉面", category: "炒菜" },
    { dishName: "虫草花炖鸡汤", category: "炒菜" },
    { dishName: "红烧肉", category: "主食" },
  ]);
  assert.deepEqual(repaired.map((dish) => dish.category), ["主食", "炒菜", "粉面", "炖盅", "主食"]);
});
