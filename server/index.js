import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { createServer as createViteServer } from "vite";
import { extractJsonObject, normalizeRecognitionJson, normalizeRecipeJson } from "./recipeJson.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5174);

const app = express();
app.use(express.json({ limit: "12mb" }));

const dashscopeBaseUrl =
  process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const modelRequestTimeout = Number(process.env.MODEL_REQUEST_TIMEOUT_MS || 30000);

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY || "missing-dashscope-api-key",
  baseURL: dashscopeBaseUrl,
});

function requireApiKey() {
  if (!process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY.includes("填入")) {
    const error = new Error("缺少 DASHSCOPE_API_KEY，请在 .env 中配置阿里云百炼 API Key。");
    error.status = 500;
    throw error;
  }
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

app.post(
  "/api/recognize-dish",
  asyncRoute(async (req, res) => {
    requireApiKey();
    const { image } = req.body;

    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "请上传一张菜品照片。" });
    }

    const recognitionPrompt = `请识别这张图片中的菜品，完成以下两步：
1. 如果图中出现多道菜，只针对画面中央/占比最大的那道菜进行分析，忽略边缘出现的其他菜品。
2. 给出最可能的2-3个菜名候选（按可能性从高到低排列），判断菜名时请重点观察食材的形态特征（比如带骨头/带皮的部位、食材切割方式），而不仅仅是颜色和酱汁色泽。
3. 列出图片中肉眼可见的主要食材/配料（比如"米饭、生鱼肉块、牛油果、玉米粒、胡萝卜丁"），只列出能直接看到的、且属于步骤1锁定的那道主菜的食材，不要推测看不到的调料，也不要混入画面边缘其他菜品的食材。

请严格按以下JSON格式返回，不要输出其他内容：
{
  "候选菜名": ["", "", ""],
  "可见食材": ["", "", ""]
}`;

    const completion = await client.chat.completions.create(
      {
        model: "qwen3.7-plus",
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: recognitionPrompt,
              },
              {
                type: "image_url",
                image_url: { url: image },
              },
            ],
          },
        ],
      },
      { timeout: modelRequestTimeout },
    );

    const content = completion.choices?.[0]?.message?.content || "";
    const recognition = normalizeRecognitionJson(extractJsonObject(content));
    console.info("[recognize-dish]", {
      candidates: recognition["候选菜名"],
      visibleIngredients: recognition["可见食材"],
    });
    res.json({
      dishCandidates: recognition["候选菜名"],
      visibleIngredients: recognition["可见食材"],
    });
  }),
);

app.post(
  "/api/generate-recipe",
  asyncRoute(async (req, res) => {
    requireApiKey();
    const dishName = String(req.body?.dishName || "").trim();
    const visibleIngredients = Array.isArray(req.body?.visibleIngredients)
      ? req.body.visibleIngredients.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const note = String(req.body?.note || "").trim();

    if (!dishName) {
      return res.status(400).json({ error: "请输入菜名。" });
    }

    const visibleIngredientsText = visibleIngredients.length > 0 ? visibleIngredients.join("、") : "无";
    const userPrompt = `请为"${dishName}"这道菜生成完整的备菜清单和制作步骤。

已知这道菜图片中实际可见的食材包括：${visibleIngredientsText}
用户保存这条记录时的备注：${note || "无"}

要求：
1. 上述"实际可见的食材"必须原样保留在食材清单里，用量可以合理估算，但不能删减或替换
2. 除了已知食材外，可以补充这道菜通常需要的调料和配料（比如油、盐、酱料），用【补充】标注
3. 步骤要按实际制作顺序排列，简洁明确，适合边看边做
4. 如果某一步需要明确计时，请把秒数写入timerSeconds；不需要计时必须写null
5. 输出严格按照以下JSON格式，不要输出其他内容：

{
  "菜名": "",
  "食材清单": [
    {"名称": "", "用量": "", "来源": "图片可见/补充"}
  ],
  "步骤": [
    {"序号": 1, "内容": "", "timerSeconds": null}
  ]
}`;

    const completion = await client.chat.completions.create(
      {
        model: "qwen3.6-plus",
        messages: [
          {
            role: "system",
            content:
              "你是一位经验丰富的中国家常菜菜谱助手，擅长根据菜名给出清晰、实用的备菜清单和制作步骤。\n你的输出必须严格按照JSON格式，不要有任何JSON之外的文字、解释或Markdown标记。",
          },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      },
      { timeout: modelRequestTimeout },
    );

    const content = completion.choices?.[0]?.message?.content || "";
    const recipe = normalizeRecipeJson(extractJsonObject(content), dishName, visibleIngredients);
    console.info("[generate-recipe]", {
      dishName: recipe["菜名"],
      ingredientCount: recipe["食材清单"].length,
      stepCount: recipe["步骤"].length,
      visibleIngredients,
    });
    res.json({ recipe });
  }),
);

app.use((error, _req, res, _next) => {
  console.error("[api-error]", error);
  const isTimeout =
    error.name === "APIConnectionTimeoutError" ||
    error.code === "ETIMEDOUT" ||
    error.message?.toLowerCase().includes("timed out");

  res.status(error.status || 502).json({
    error: isTimeout
      ? "AI生成超时，请稍后重试或点击重新生成。"
      : error.message || "服务暂时不可用，请稍后再试。",
  });
});

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const vite = await createViteServer({
    root,
    server: {
      host: "127.0.0.1",
      hmr: { host: "127.0.0.1" },
      middlewareMode: true,
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, "127.0.0.1", () => {
  console.log(`菜单 App 已启动：http://127.0.0.1:${port}`);
});
