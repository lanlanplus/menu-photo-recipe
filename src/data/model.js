export const DISH_CATEGORIES = ["炒菜", "炖盅", "粉面", "主食"];

export function inferDishCategory(dishName, currentCategory = "") {
  const name = String(dishName || "").trim();
  if (/[饭粥饼馒头包子饺子]/.test(name)) return "主食";
  if (/[粉面]/.test(name)) return "粉面";
  if (/[炖汤盅羹]/.test(name)) return "炖盅";
  return DISH_CATEGORIES.includes(currentCategory) ? currentCategory : "炒菜";
}

export function createId(prefix = "id") {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

export function normalizeIngredient(item, fallbackSource = "") {
  if (typeof item === "string") {
    return { 名称: item.trim(), 用量: "", 来源: fallbackSource };
  }

  return {
    名称: String(item?.["名称"] || "").trim(),
    用量: String(item?.["用量"] || "").trim(),
    来源: String(item?.["来源"] || fallbackSource).trim(),
  };
}

export function normalizeReferenceRecipe(recipe) {
  if (!recipe || typeof recipe !== "object") return null;

  return {
    食材清单: (Array.isArray(recipe["食材清单"]) ? recipe["食材清单"] : [])
      .map((item) => normalizeIngredient(item))
      .filter((item) => item["名称"] || item["用量"]),
    步骤: (Array.isArray(recipe["步骤"]) ? recipe["步骤"] : [])
      .map((step, index) => ({
        序号: Number(step?.["序号"] || index + 1),
        内容: String(step?.["内容"] || "").trim(),
        timerSeconds: Number.isFinite(step?.timerSeconds) ? Math.max(0, step.timerSeconds) : null,
      }))
      .filter((step) => step["内容"]),
  };
}

export function createEntry(input = {}) {
  return {
    entryId: input.entryId || createId("entry"),
    createdAt: input.createdAt || new Date().toISOString(),
    photo: String(input.photo || ""),
    visibleIngredients: (Array.isArray(input.visibleIngredients) ? input.visibleIngredients : [])
      .map((item) => normalizeIngredient(item, "图片可见"))
      .filter((item) => item["名称"] || item["用量"]),
    note: String(input.note || ""),
    referenceRecipe: normalizeReferenceRecipe(input.referenceRecipe),
  };
}

export function appendEntryToDishes(dishes, input) {
  const dishName = String(input.dishName || "").trim();
  if (!dishName) throw new Error("菜名不能为空");

  const entry = createEntry(input.entry);
  const existingIndex = dishes.findIndex((dish) => dish.dishName.trim() === dishName);
  if (existingIndex >= 0) {
    return dishes.map((dish, index) =>
      index === existingIndex ? { ...dish, entries: [...dish.entries, entry] } : dish,
    );
  }

  return [
    ...dishes,
    {
      dishId: input.dishId || createId("dish"),
      dishName,
      category: DISH_CATEGORIES.includes(input.category) ? input.category : "炒菜",
      createdAt: entry.createdAt,
      entries: [entry],
    },
  ];
}

export function createActiveOrder(orders, dishIds, now = new Date().toISOString()) {
  const uniqueDishIds = [...new Set(dishIds.filter(Boolean))];
  if (uniqueDishIds.length === 0) throw new Error("点单至少需要一道菜");

  return [
    ...orders.map((order) => (order.status === "active" ? { ...order, status: "done" } : order)),
    {
      orderId: createId("order"),
      createdAt: now,
      dishIds: uniqueDishIds,
      status: "active",
      checkedIngredientKeys: [],
    },
  ];
}
