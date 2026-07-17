export function extractJsonObject(text) {
  if (!text || typeof text !== "string") {
    throw new Error("模型返回为空");
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("模型返回不是JSON");
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

export function normalizeRecognitionJson(result) {
  if (!result || typeof result !== "object") {
    throw new Error("识图JSON结构无效");
  }

  const dishCandidates = Array.isArray(result["候选菜名"])
    ? result["候选菜名"].map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const visibleIngredients = Array.isArray(result["可见食材"])
    ? result["可见食材"].map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (dishCandidates.length === 0) {
    dishCandidates.push("未识别");
  }

  return {
    候选菜名: dishCandidates.slice(0, 3),
    可见食材: visibleIngredients,
  };
}

export function normalizeRecipeJson(recipe, fallbackDishName = "", visibleIngredients = []) {
  if (!recipe || typeof recipe !== "object") {
    throw new Error("菜谱JSON结构无效");
  }

  const dishName = String(recipe["菜名"] || fallbackDishName || "").trim();
  const ingredients = Array.isArray(recipe["食材清单"]) ? recipe["食材清单"] : [];
  const steps = Array.isArray(recipe["步骤"]) ? recipe["步骤"] : [];

  if (!dishName || ingredients.length === 0 || steps.length === 0) {
    throw new Error("菜谱JSON缺少必要字段");
  }

  return {
    菜名: dishName,
    食材清单: ensureVisibleIngredients(
      ingredients.map((item) => ({
        名称: String(item?.["名称"] || "").trim(),
        用量: String(item?.["用量"] || "").trim(),
        来源: normalizeIngredientSource(item?.["来源"]),
      })),
      visibleIngredients,
    ),
    步骤: steps.map((step, index) => ({
      序号: Number(step?.["序号"] || index + 1),
      内容: String(step?.["内容"] || "").trim(),
      timerSeconds: Number.isFinite(step?.timerSeconds) ? Math.max(0, Math.round(step.timerSeconds)) : null,
    })),
  };
}

function normalizeIngredientSource(source) {
  const value = String(source || "").trim();
  if (value === "图片可见" || value === "补充") {
    return value;
  }
  return "";
}

function ensureVisibleIngredients(ingredients, visibleIngredients) {
  const normalizedVisibleIngredients = Array.isArray(visibleIngredients)
    ? visibleIngredients.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const nextIngredients = ingredients.filter((item) => item["名称"] || item["用量"]);

  for (const visibleIngredient of normalizedVisibleIngredients) {
    const exists = nextIngredients.some((item) => item["名称"] === visibleIngredient);
    if (!exists) {
      nextIngredients.push({
        名称: visibleIngredient,
        用量: "按实际照片用量",
        来源: "图片可见",
      });
      continue;
    }

    for (const item of nextIngredients) {
      if (item["名称"] === visibleIngredient) {
        item["来源"] = "图片可见";
      }
    }
  }

  return nextIngredients;
}
