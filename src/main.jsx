import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createId, DISH_CATEGORIES, inferDishCategory } from "./data/model.js";
import { deletePhoto, getPhoto, savePhoto } from "./data/photoStorage.js";
import { addDishEntry, dishesToRecipeRecords, loadAppData, migrateDishPhotos, placeOrder } from "./data/storage.js";
import "./styles.css";

function emptyRecipe(dishName = "") {
  return {
    菜名: dishName,
    食材清单: [{ 名称: "", 用量: "", 来源: "" }],
    步骤: [{ 序号: 1, 内容: "" }],
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择照片。"));
    reader.readAsDataURL(file);
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败，请稍后再试。");
  }
  return data;
}

function normalizeIngredientForEdit(item) {
  return {
    名称: String(item?.["名称"] || "").trim(),
    用量: String(item?.["用量"] || "").trim(),
    来源: String(item?.["来源"] || "").trim(),
  };
}

function App() {
  const fileInputRef = useRef(null);
  const [currentPage, setCurrentPage] = useState("dishes");
  const [photo, setPhoto] = useState("");
  const [dishName, setDishName] = useState("");
  const [dishCandidates, setDishCandidates] = useState([]);
  const [visibleIngredients, setVisibleIngredients] = useState([]);
  const [newVisibleIngredient, setNewVisibleIngredient] = useState("");
  const [recipe, setRecipe] = useState(null);
  const [dishes, setDishes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [activeCategory, setActiveCategory] = useState("炒菜");
  const [selectedDishIds, setSelectedDishIds] = useState([]);
  const [isInitializing, setIsInitializing] = useState(true);
  const [photoUrls, setPhotoUrls] = useState({});
  const [activeRecipeId, setActiveRecipeId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  const isBusy = status === "recognizing" || status === "generating" || status === "saving";
  const savedRecipes = useMemo(() => dishesToRecipeRecords(dishes), [dishes]);
  const activeRecipe = useMemo(
    () => savedRecipes.find((item) => item.id === activeRecipeId) || null,
    [activeRecipeId, savedRecipes],
  );

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      const startedAt = performance.now();
      const appData = loadAppData();
      const result = await migrateDishPhotos(localStorage, appData.dishes, { savePhoto });
      if (cancelled) return;
      setDishes(result.dishes);
      setOrders(appData.orders);
      setIsInitializing(false);
      console.info("[photo-migration] complete", JSON.stringify({
        migratedCount: result.migratedCount,
        failedCount: result.failedCount,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    }
    initialize().catch((error) => {
      console.error("[photo-migration] initialization failed", error);
      if (!cancelled) {
        const fallbackData = loadAppData();
        setDishes(fallbackData.dishes);
        setOrders(fallbackData.orders);
        setIsInitializing(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const photoIds = savedRecipes.map((record) => record.photo).filter(Boolean);
    Promise.all(photoIds.map(async (photoId) => [photoId, await getPhoto(photoId).catch(() => null)]))
      .then((pairs) => {
        if (!cancelled) setPhotoUrls(Object.fromEntries(pairs));
      });
    return () => { cancelled = true; };
  }, [savedRecipes]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setMessage("");
    setRecipe(null);
    setDishName("");
    setDishCandidates([]);
    setVisibleIngredients([]);
    setNewVisibleIngredient("");
    setActiveRecipeId(null);

    try {
      setStatus("recognizing");
      const image = await fileToDataUrl(file);
      setPhoto(image);
      const recognizeResult = await postJson("/api/recognize-dish", { image });
      const nextCandidates = Array.isArray(recognizeResult.dishCandidates)
        ? recognizeResult.dishCandidates.filter(Boolean)
        : [];
      const nextVisibleIngredients = Array.isArray(recognizeResult.visibleIngredients)
        ? recognizeResult.visibleIngredients.filter(Boolean)
        : [];

      setDishCandidates(nextCandidates);
      setDishName(nextCandidates[0] && nextCandidates[0] !== "未识别" ? nextCandidates[0] : "");
      setVisibleIngredients(nextVisibleIngredients);
      setStatus("idle");

      if (nextCandidates.length === 0 || nextCandidates[0] === "未识别") {
        setMessage("没有识别出明确菜名，你可以手动输入菜名并整理可见食材。");
      }
    } catch (error) {
      setStatus("idle");
      setMessage(error.message || "识别失败，请重新拍摄更清晰的照片。");
    } finally {
      event.target.value = "";
    }
  }

  async function generateRecipe(name = dishName) {
    const nextDishName = name.trim();
    if (!nextDishName) {
      setMessage("请先选择或输入菜名，再生成菜谱。");
      return;
    }

    try {
      setStatus("generating");
      setMessage("");
      const result = await postJson("/api/generate-recipe", {
        dishName: nextDishName,
        visibleIngredients: visibleIngredients.map((item) => item.trim()).filter(Boolean),
      });
      setRecipe({
        ...result.recipe,
        食材清单: result.recipe["食材清单"].map(normalizeIngredientForEdit),
      });
      setDishName(result.recipe["菜名"] || nextDishName);
      setStatus("idle");
    } catch (error) {
      setStatus("idle");
      setRecipe((current) => current || emptyRecipe(nextDishName));
      setMessage(error.message || "菜谱生成失败，请稍后重试。");
    }
  }

  function selectCandidate(candidate) {
    setDishName(candidate);
    setRecipe(null);
    setMessage("");
  }

  function updateVisibleIngredient(index, value) {
    setVisibleIngredients((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)));
    setRecipe(null);
  }

  function removeVisibleIngredient(index) {
    setVisibleIngredients((current) => current.filter((_item, itemIndex) => itemIndex !== index));
    setRecipe(null);
  }

  function addVisibleIngredient() {
    const value = newVisibleIngredient.trim();
    if (!value) return;
    setVisibleIngredients((current) => [...current, value]);
    setNewVisibleIngredient("");
    setRecipe(null);
  }

  function updateIngredient(index, field, value) {
    setRecipe((current) => ({
      ...current,
      食材清单: current["食材清单"].map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    }));
  }

  function updateStep(index, value) {
    setRecipe((current) => ({
      ...current,
      步骤: current["步骤"].map((step, stepIndex) =>
        stepIndex === index ? { ...step, 内容: value } : step,
      ),
    }));
  }

  function addIngredient() {
    setRecipe((current) => ({
      ...current,
      食材清单: [...current["食材清单"], { 名称: "", 用量: "", 来源: "" }],
    }));
  }

  function addStep() {
    setRecipe((current) => ({
      ...current,
      步骤: [...current["步骤"], { 序号: current["步骤"].length + 1, 内容: "" }],
    }));
  }

  async function saveCurrentRecipe() {
    if (!photo) {
      setMessage("请先上传一张菜品照片。");
      return;
    }
    if (!dishName.trim() || !recipe) {
      setMessage("请先生成或填写菜谱内容。");
      return;
    }

    const photoId = createId("photo");
    try {
      setStatus("saving");
      setMessage("");
      await savePhoto(photoId, photo);
    } catch (error) {
      setStatus("idle");
      setMessage(error.message || "照片保存失败，本次记录没有保存，请重试。");
      return;
    }

    const entry = {
      createdAt: new Date().toISOString(),
      photo: photoId,
      visibleIngredients: visibleIngredients.map((item) => ({ 名称: item.trim(), 用量: "", 来源: "图片可见" })),
      note: "",
      referenceRecipe: {
        ...recipe,
        食材清单: recipe["食材清单"]
          .map(normalizeIngredientForEdit)
          .filter((item) => item["名称"].trim() || item["用量"].trim()),
        步骤: recipe["步骤"]
          .filter((step) => step["内容"].trim())
          .map((step, index) => ({ 序号: index + 1, 内容: step["内容"].trim(), timerSeconds: null })),
      },
    };

    try {
      const nextDishes = addDishEntry(localStorage, dishes, {
        dishName: dishName.trim(), category: inferDishCategory(dishName), entry,
      });
      setDishes(nextDishes);
      setPhotoUrls((current) => ({ ...current, [photoId]: photo }));
      const savedDish = nextDishes.find((dish) => dish.dishName === dishName.trim());
      setActiveRecipeId(savedDish.entries.at(-1).entryId);
      setStatus("idle");
      setMessage("已保存到菜单库。");
    } catch (error) {
      await deletePhoto(photoId).catch(() => {});
      setStatus("idle");
      setMessage(error.message || "记录保存失败，本次照片和菜品均未保存，请重试。");
    }
  }

  async function loadRecipe(record) {
    setPhoto("");
    const resolvedPhoto = photoUrls[record.photo] || await getPhoto(record.photo).catch(() => null);
    setPhoto(resolvedPhoto || "");
    setDishName(record.dishName);
    setDishCandidates([]);
    setVisibleIngredients([]);
    setNewVisibleIngredient("");
    setRecipe({
      ...record.recipe,
      食材清单: (record.recipe?.["食材清单"] || []).map(normalizeIngredientForEdit),
    });
    setActiveRecipeId(record.id);
    setMessage("");
  }

  function toggleDishSelection(dishId) {
    setSelectedDishIds((current) =>
      current.includes(dishId) ? current.filter((id) => id !== dishId) : [...current, dishId],
    );
  }

  function handlePlaceOrder() {
    if (selectedDishIds.length === 0) return;
    try {
      const nextOrders = placeOrder(localStorage, orders, selectedDishIds);
      setOrders(nextOrders);
      setSelectedDishIds([]);
      setCurrentPage("list");
    } catch (error) {
      console.error("[place-order] failed", error);
    }
  }

  if (isInitializing) {
    return <main className="initializing-screen"><div className="spinner dark" /><p>正在整理本地照片…</p></main>;
  }

  const pageMeta = {
    dishes: { eyebrow: "今天想吃什么？", title: "菜品", description: "从菜单库挑选菜品并发起一次点单。", icon: "菜" },
    list: { eyebrow: "带着清单去采买", title: "清单", description: "点单后，这里会自动汇总需要购买的食材。", icon: "单" },
    cooking: { eyebrow: "跟着步骤开始做", title: "制作", description: "点单中的菜谱步骤和计时器会集中显示在这里。", icon: "做" },
    upload: { eyebrow: "记录一道新菜", title: "上传", description: "拍照识菜，确认食材并保存你的做法。", icon: "传" },
  };

  const navigation = [
    { id: "dishes", label: "菜品", icon: "菜" },
    { id: "list", label: "清单", icon: "单" },
    { id: "cooking", label: "制作", icon: "做" },
    { id: "upload", label: "上传", icon: "传" },
  ];

  const currentMeta = pageMeta[currentPage];

  return (
    <div className="page-shell">
      {currentPage === "upload" ? (
      <main className="app-shell upload-page">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{currentMeta.eyebrow}</p>
            <h1>{currentMeta.title}</h1>
            <p className="page-description">{currentMeta.description}</p>
          </div>
          <button className="primary-button" disabled={isBusy} onClick={() => fileInputRef.current?.click()}>
            拍照/上传照片
          </button>
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
          />
        </header>

        <div className="content-grid">
          <section className="panel upload-panel">
            <div className="photo-frame">
              {photo ? (
                <img src={photo} alt="上传的菜品" />
              ) : (
                <div className="empty-photo">
                  <span>选择一张成品照或过程照</span>
                </div>
              )}
              {status !== "idle" && (
                <div className="loading-mask">
                  <div className="spinner" />
                  <span>{status === "recognizing" ? "识别中..." : "生成菜谱中..."}</span>
                </div>
              )}
            </div>

            <div className="confirm-block">
              <label className="field-label" htmlFor="dish-name">
                确认菜名
              </label>
              {dishCandidates.length > 0 && (
                <div className="candidate-list" aria-label="候选菜名">
                  {dishCandidates.map((candidate) => (
                    <button
                      className={`candidate-chip ${dishName === candidate ? "selected" : ""}`}
                      key={candidate}
                      type="button"
                      onClick={() => selectCandidate(candidate)}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              )}
              <input
                id="dish-name"
                value={dishName}
                placeholder="选择候选菜名，或手动输入"
                onChange={(event) => {
                  setDishName(event.target.value);
                  setRecipe(null);
                }}
              />
            </div>

            <div className="confirm-block">
              <div className="panel-title-row">
                <label className="field-label compact-label">确认可见食材</label>
                <span className="hint-text">{visibleIngredients.length} 项</span>
              </div>
              <div className="visible-ingredient-list">
                {visibleIngredients.length === 0 ? (
                  <p className="muted">识别后会列出图片中能看到的主菜食材。</p>
                ) : (
                  visibleIngredients.map((item, index) => (
                    <div className="visible-ingredient-row" key={`visible-${index}`}>
                      <input value={item} onChange={(event) => updateVisibleIngredient(index, event.target.value)} />
                      <button type="button" className="icon-button" onClick={() => removeVisibleIngredient(index)}>
                        删除
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="add-visible-row">
                <input
                  value={newVisibleIngredient}
                  placeholder="补充一个可见食材"
                  onChange={(event) => setNewVisibleIngredient(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addVisibleIngredient();
                    }
                  }}
                />
                <button type="button" className="secondary-button" onClick={addVisibleIngredient}>
                  添加
                </button>
              </div>
            </div>

            <button
              className="primary-button generate-button"
              disabled={isBusy || !dishName.trim()}
              onClick={() => generateRecipe()}
            >
              生成菜谱
            </button>

            {message && <p className="notice">{message}</p>}
          </section>

          <section className="panel recipe-panel">
            <div className="panel-title-row">
              <h2>备菜清单与制作步骤</h2>
              <button className="primary-button compact" disabled={isBusy || !recipe} onClick={saveCurrentRecipe}>
                保存
              </button>
            </div>

            {recipe ? (
              <div className="recipe-editor">
                <h3>食材清单</h3>
                <div className="ingredient-list">
                  {recipe["食材清单"].map((item, index) => (
                    <div className="ingredient-row" key={`ingredient-${index}`}>
                      <input
                        value={item["名称"]}
                        placeholder="食材"
                        onChange={(event) => updateIngredient(index, "名称", event.target.value)}
                      />
                      <input
                        value={item["用量"]}
                        placeholder="用量"
                        onChange={(event) => updateIngredient(index, "用量", event.target.value)}
                      />
                      <select
                        value={item["来源"] || ""}
                        onChange={(event) => updateIngredient(index, "来源", event.target.value)}
                        aria-label="食材来源"
                      >
                        <option value="">不标注</option>
                        <option value="图片可见">图片可见</option>
                        <option value="补充">补充</option>
                      </select>
                    </div>
                  ))}
                </div>
                <button className="text-button" onClick={addIngredient}>
                  添加食材
                </button>

                <h3>制作步骤</h3>
                <div className="step-list">
                  {recipe["步骤"].map((step, index) => (
                    <label className="step-row" key={`step-${index}`}>
                      <span>{index + 1}</span>
                      <textarea
                        value={step["内容"]}
                        rows={2}
                        placeholder="步骤内容"
                        onChange={(event) => updateStep(index, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <button className="text-button" onClick={addStep}>
                  添加步骤
                </button>
              </div>
            ) : (
              <div className="empty-recipe">上传照片并确认菜名、食材后，点击生成菜谱。</div>
            )}
          </section>
        </div>
      </section>

      <aside className="library">
        <div className="library-header">
          <h2>菜单库</h2>
          <span>{savedRecipes.length} 道</span>
        </div>
        <div className="library-list">
          {savedRecipes.length === 0 ? (
            <p className="library-empty">保存后的菜会在这里，方便下次复习。</p>
          ) : (
            savedRecipes.map((record) => (
              <button
                className={`recipe-card ${activeRecipeId === record.id ? "active" : ""}`}
                key={record.id}
                onClick={() => loadRecipe(record)}
              >
                {photoUrls[record.photo] ? (
                  <img src={photoUrls[record.photo]} alt={record.dishName} />
                ) : (
                  <span className="photo-loading">照片加载中</span>
                )}
                <div>
                  <strong>{record.dishName}</strong>
                  <span>{new Date(record.createdAt).toLocaleString("zh-CN")}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {activeRecipe && (
          <section className="library-detail">
            <h3>{activeRecipe.dishName}</h3>
            <p>
              {activeRecipe.recipe["食材清单"].length} 项食材，{activeRecipe.recipe["步骤"].length} 个步骤
            </p>
          </section>
        )}
      </aside>
      </main>
      ) : currentPage === "dishes" ? (
        <main className="dishes-page" aria-labelledby="dishes-title">
          <header className="page-header dishes-header">
            <div>
              <p className="eyebrow">{currentMeta.eyebrow}</p>
              <h1 id="dishes-title">{currentMeta.title}</h1>
              <p className="page-description">{currentMeta.description}</p>
            </div>
            <div className="selection-summary">
              <strong>{selectedDishIds.length}</strong>
              <span>道已选</span>
            </div>
          </header>

          <section className="dish-browser">
            <aside className="category-sidebar" aria-label="菜品分类">
              {DISH_CATEGORIES.map((category) => {
                const count = dishes.filter((dish) => dish.category === category).length;
                return (
                  <button
                    key={category}
                    type="button"
                    className={activeCategory === category ? "active" : ""}
                    aria-pressed={activeCategory === category}
                    onClick={() => setActiveCategory(category)}
                  >
                    <span>{category}</span><small>{count}</small>
                  </button>
                );
              })}
            </aside>

            <div className="dish-grid" aria-label={`${activeCategory}菜品`}>
              {dishes.filter((dish) => dish.category === activeCategory).length === 0 ? (
                <div className="empty-category">
                  <span>暂无菜品</span>
                  <p>去“上传”页面记录一道{activeCategory}吧。</p>
                </div>
              ) : (
                dishes.filter((dish) => dish.category === activeCategory).map((dish) => {
                  const latestEntry = [...(dish.entries || [])].sort(
                    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
                  )[0];
                  const selected = selectedDishIds.includes(dish.dishId);
                  return (
                    <button
                      type="button"
                      className={`dish-card ${selected ? "selected" : ""}`}
                      key={dish.dishId}
                      aria-pressed={selected}
                      onClick={() => toggleDishSelection(dish.dishId)}
                    >
                      <span className="dish-card-photo">
                        {photoUrls[latestEntry?.photo] ? (
                          <img src={photoUrls[latestEntry.photo]} alt="" />
                        ) : (
                          <span className="dish-photo-placeholder">照片加载中</span>
                        )}
                        <span className="dish-check" aria-hidden="true">{selected ? "✓" : "+"}</span>
                      </span>
                      <span className="dish-card-info">
                        <strong>{dish.dishName}</strong>
                        <small>{dish.entries?.length || 0} 次记录</small>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <button
            type="button"
            className="order-button"
            disabled={selectedDishIds.length === 0}
            onClick={handlePlaceOrder}
          >
            点单{selectedDishIds.length > 0 ? ` · ${selectedDishIds.length} 道` : ""}
          </button>
        </main>
      ) : (
        <main className="placeholder-page" aria-labelledby={`${currentPage}-title`}>
          <header className="page-header">
            <p className="eyebrow">{currentMeta.eyebrow}</p>
            <h1 id={`${currentPage}-title`}>{currentMeta.title}</h1>
            <p className="page-description">{currentMeta.description}</p>
          </header>
          <section className="placeholder-card">
            <span className="placeholder-icon" aria-hidden="true">{currentMeta.icon}</span>
            <h2>{currentMeta.title}页面</h2>
            <p>页面骨架已就位，具体功能将在后续批次实现。</p>
          </section>
        </main>
      )}

      <nav className="bottom-navigation" aria-label="主要页面">
        {navigation.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${currentPage === item.id ? "active" : ""}`}
            aria-current={currentPage === item.id ? "page" : undefined}
            onClick={() => setCurrentPage(item.id)}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
