import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, normalizeRecognitionJson, normalizeRecipeJson } from "./recipeJson.js";

test("extracts pure JSON", () => {
  const result = extractJsonObject('{"菜名":"番茄炒蛋","食材清单":[],"步骤":[]}');
  assert.equal(result["菜名"], "番茄炒蛋");
});

test("extracts JSON from extra model text", () => {
  const result = extractJsonObject('好的：\n{"菜名":"红烧肉","食材清单":[],"步骤":[]}\n完成');
  assert.equal(result["菜名"], "红烧肉");
});

test("normalizes recipe fields", () => {
  const result = normalizeRecipeJson({
    菜名: "青椒肉丝",
    食材清单: [{ 名称: "猪里脊", 用量: "200g", 来源: "图片可见" }],
    步骤: [{ 序号: 1, 内容: "切丝腌制。", timerSeconds: 300 }],
  });

  assert.equal(result["食材清单"][0]["名称"], "猪里脊");
  assert.equal(result["食材清单"][0]["来源"], "图片可见");
  assert.equal(result["步骤"][0]["序号"], 1);
  assert.equal(result["步骤"][0].timerSeconds, 300);
});

test("老菜谱缺少 timerSeconds 时兼容为 null", () => {
  const result = normalizeRecipeJson({
    菜名: "凉拌黄瓜",
    食材清单: [{ 名称: "黄瓜", 用量: "1根" }],
    步骤: [{ 序号: 1, 内容: "拍碎拌匀。" }],
  });
  assert.equal(result["步骤"][0].timerSeconds, null);
});

test("normalizes recognition candidates and visible ingredients", () => {
  const result = normalizeRecognitionJson({
    候选菜名: ["红烧猪蹄", "红烧肉", ""],
    可见食材: ["猪蹄", "葱花"],
  });

  assert.deepEqual(result["候选菜名"], ["红烧猪蹄", "红烧肉"]);
  assert.deepEqual(result["可见食材"], ["猪蹄", "葱花"]);
});

test("keeps visible ingredients when model omits them", () => {
  const result = normalizeRecipeJson(
    {
      菜名: "金枪鱼牛油果拌饭",
      食材清单: [{ 名称: "米饭", 用量: "200g", 来源: "图片可见" }],
      步骤: [{ 序号: 1, 内容: "拌匀即可。" }],
    },
    "金枪鱼牛油果拌饭",
    ["米饭", "玉米粒", "胡萝卜丁"],
  );

  assert.deepEqual(
    result["食材清单"].map((item) => item["名称"]),
    ["米饭", "玉米粒", "胡萝卜丁"],
  );
  assert.equal(result["食材清单"][1]["来源"], "图片可见");
});
