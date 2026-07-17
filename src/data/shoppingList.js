export const SHOPPING_CATEGORIES = ["肉类", "海鲜类", "半成品食材", "蔬菜类", "菌菇豆制品类", "调味料", "其他"];

const INGREDIENT_ALIASES = new Map([
  ["鳄梨", "牛油果"],
  ["青葱", "葱"],
  ["小葱", "葱"],
  ["生姜", "姜"],
]);

const INGREDIENT_FORM_SUFFIXES = ["片", "丁", "丝", "块", "段", "末", "条", "粒", "瓣", "泥"];
const SUFFIX_EXCEPTIONS = new Set(["粉丝", "豆瓣"]);

// These condiment names contain protein/seafood keywords, so they must be
// resolved before the broader single-character category rules below.
const SPECIFIC_CATEGORY_RULES = [
  ["调味料", /蚝油|鱼露|鸡精|鸡粉|牛肉酱|海鲜酱/],
  ["半成品食材", /罐头|罐装|速冻|冻|丸|肠|鲮鱼|培根|蟹籽/],
];

const CATEGORY_RULES = [
  ["蔬菜类", /牛油果|鳄梨/],
  ["肉类", /猪|牛肉|牛腩|牛排|羊|鸡|鸭|鹅|排骨|^肉$|肉末|肉馅|火腿|腊肠|培根/],
  ["海鲜类", /鱼|虾|蟹|贝|蛤|蚝|鱿鱼|墨鱼|章鱼|海参|金枪鱼|三文鱼|海带|紫菜/],
  ["菌菇豆制品类", /菇|菌|木耳|豆腐|豆干|腐竹|豆皮|豆芽|千张/],
  ["调味料", /盐|糖|酱|醋|油|料酒|味精|鸡精|胡椒|花椒|八角|桂皮|香叶|孜然|辣椒粉|淀粉|蚝油|生抽|老抽/],
  ["蔬菜类", /菜|葱|姜|蒜|椒|番茄|西红柿|土豆|萝卜|黄瓜|冬瓜|南瓜|茄子|豆角|玉米|韭|芹|笋|藕|瓜|牛油果|鳄梨|洋葱|香菜|菠菜|生菜/],
];

export function normalizeIngredientName(name) {
  const compact = String(name || "").trim().replace(/\s+/g, "");
  const suffix = INGREDIENT_FORM_SUFFIXES.find((item) => compact.endsWith(item));
  const baseName = suffix && compact.length > suffix.length && !SUFFIX_EXCEPTIONS.has(compact)
    ? compact.slice(0, -suffix.length)
    : compact;
  return INGREDIENT_ALIASES.get(baseName) || baseName;
}

export function classifyIngredient(name) {
  return [...SPECIFIC_CATEGORY_RULES, ...CATEGORY_RULES]
    .find(([, pattern]) => pattern.test(name))?.[0] || "其他";
}

export function parseAmount(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*([\u4e00-\u9fa5a-zA-Z]+)$/);
  return match ? { value: Number(match[1]), unit: match[2] } : null;
}

function latestEntry(dish) {
  return [...(dish.entries || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

export function buildShoppingList(dishes, activeOrder) {
  if (!activeOrder) return [];
  const selected = new Set(activeOrder.dishIds || []);
  const rawItems = dishes.filter((dish) => selected.has(dish.dishId)).flatMap((dish) => {
    const entry = latestEntry(dish);
    if (!entry) return [];
    return [...(entry.visibleIngredients || []), ...(entry.referenceRecipe?.["食材清单"] || [])]
      .filter((item) => item?.["名称"])
      .map((item) => ({ name: normalizeIngredientName(item["名称"]), amount: String(item["用量"] || "").trim() }));
  });

  const merged = new Map();
  rawItems.forEach((item) => {
    const current = merged.get(item.name) || { key: item.name, name: item.name, numeric: new Map(), other: [] };
    const parsed = parseAmount(item.amount);
    if (parsed) current.numeric.set(parsed.unit, (current.numeric.get(parsed.unit) || 0) + parsed.value);
    else if (item.amount && !current.other.includes(item.amount)) current.other.push(item.amount);
    else if (!item.amount && current.numeric.size === 0 && current.other.length === 0) current.other.push("");
    merged.set(item.name, current);
  });

  return [...merged.values()].map((item) => ({
    key: item.key,
    name: item.name,
    category: classifyIngredient(item.name),
    amounts: [
      ...[...item.numeric].map(([unit, value]) => `${Number(value.toFixed(3))}${unit}`),
      ...item.other,
    ].filter((amount, index, values) => amount || values.length === 1),
  }));
}

export function groupShoppingList(items) {
  return SHOPPING_CATEGORIES.map((category) => ({
    category,
    items: items.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}
