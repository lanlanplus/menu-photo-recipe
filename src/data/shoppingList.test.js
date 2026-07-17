import assert from "node:assert/strict";
import test from "node:test";
import { buildShoppingList, classifyIngredient, groupShoppingList, normalizeIngredientName, parseAmount } from "./shoppingList.js";

const dishes = [{
  dishId: "dish-a",
  entries: [
    { createdAt: "2026-01-01", visibleIngredients: [{ 名称: "旧食材", 用量: "1个" }] },
    { createdAt: "2026-02-01", visibleIngredients: [{ 名称: "鳄梨", 用量: "1个" }, { 名称: "鸡蛋", 用量: "2个" }], referenceRecipe: { 食材清单: [{ 名称: "牛油果", 用量: "2个" }, { 名称: "鸡蛋", 用量: "少许" }, { 名称: "鸡蛋", 用量: "100克" }] } },
  ],
}];

test("归一化常见别名并解析严格的数值单位", () => {
  assert.equal(normalizeIngredientName(" 鳄梨 "), "牛油果");
  assert.equal(normalizeIngredientName("鳄梨片"), "牛油果");
  assert.equal(normalizeIngredientName("牛油果丁"), "牛油果");
  assert.equal(normalizeIngredientName("胡萝卜丝"), "胡萝卜");
  assert.equal(normalizeIngredientName("粉丝"), "粉丝");
  assert.equal(normalizeIngredientName("豆瓣"), "豆瓣");
  assert.deepEqual(parseAmount("1.5 克"), { value: 1.5, unit: "克" });
  assert.equal(parseAmount("少许"), null);
});

test("切法后缀只参与同类判断，无法统一解析的用量在同一条目并列", () => {
  const suffixDishes = [{
    dishId: "dish-avocado",
    entries: [{
      createdAt: "2026-07-17",
      visibleIngredients: [{ 名称: "牛油果片", 用量: "按实际照片用量" }],
      referenceRecipe: { 食材清单: [{ 名称: "牛油果", 用量: "2个" }] },
    }],
  }];
  const list = buildShoppingList(suffixDishes, { dishIds: ["dish-avocado"] });
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "牛油果");
  assert.equal(list[0].name, "牛油果");
  assert.deepEqual(list[0].amounts, ["2个", "按实际照片用量"]);
});

test("去除切法后缀后，同单位数值仍按原规则相加", () => {
  const amountDishes = [{
    dishId: "dish-carrot",
    entries: [{
      createdAt: "2026-07-17",
      visibleIngredients: [{ 名称: "胡萝卜丝", 用量: "50克" }],
      referenceRecipe: { 食材清单: [{ 名称: "胡萝卜", 用量: "100克" }] },
    }],
  }];
  const list = buildShoppingList(amountDishes, { dishIds: ["dish-carrot"] });
  assert.deepEqual(list.map(({ name, amounts }) => ({ name, amounts })), [{ name: "胡萝卜", amounts: ["150克"] }]);
});

test("只读取点单菜品最新 entry，且仅合并同单位数值", () => {
  const list = buildShoppingList(dishes, { dishIds: ["dish-a"] });
  assert.equal(list.some((item) => item.name === "旧食材"), false);
  assert.deepEqual(list.find((item) => item.name === "牛油果").amounts, ["3个"]);
  assert.deepEqual(list.find((item) => item.name === "鸡蛋").amounts, ["2个", "100克", "少许"]);
});

test("按超市分类规则分组", () => {
  const groups = groupShoppingList(buildShoppingList(dishes, { dishIds: ["dish-a"] }));
  assert.deepEqual(groups.map((group) => group.category), ["肉类", "蔬菜类"]);
});

test("含肉类或海鲜字样的明确调味品优先归入调味料", () => {
  ["蚝油", "鱼露", "鸡精", "鸡粉", "牛肉酱", "海鲜酱"].forEach((name) => {
    assert.equal(classifyIngredient(name), "调味料", `${name} 应归入调味料`);
  });
  assert.equal(classifyIngredient("生蚝"), "海鲜类");
  assert.equal(classifyIngredient("金枪鱼"), "海鲜类");
  assert.equal(classifyIngredient("牛肉"), "肉类");
});

test("加工食品优先于肉类和海鲜类归入半成品食材", () => {
  [
    "金枪鱼罐头",
    "午餐肉罐装",
    "速冻水饺",
    "冻虾仁",
    "牛肉丸",
    "鱼丸",
    "火腿肠",
    "豆豉鲮鱼罐头",
    "培根",
    "蟹籽",
  ].forEach((name) => {
    assert.equal(classifyIngredient(name), "半成品食材", `${name} 应归入半成品食材`);
  });
  assert.equal(classifyIngredient("金枪鱼"), "海鲜类");
  assert.equal(classifyIngredient("鲜牛肉"), "肉类");
});

test("半成品食材分组位于肉类和海鲜类之后、蔬菜类之前", () => {
  const categoryDishes = [{
    dishId: "dish-categories",
    entries: [{
      createdAt: "2026-07-17",
      visibleIngredients: [
        { 名称: "鲜牛肉" },
        { 名称: "鲜虾" },
        { 名称: "金枪鱼罐头" },
        { 名称: "胡萝卜" },
      ],
    }],
  }];
  const groups = groupShoppingList(buildShoppingList(categoryDishes, { dishIds: ["dish-categories"] }));
  assert.deepEqual(groups.map((group) => group.category), ["肉类", "海鲜类", "半成品食材", "蔬菜类"]);
  assert.deepEqual(groups.find((group) => group.category === "半成品食材").items.map((item) => item.name), ["金枪鱼罐头"]);
});
