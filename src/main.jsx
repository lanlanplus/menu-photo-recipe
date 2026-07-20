import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createId, DISH_CATEGORIES, inferDishCategory } from "./data/model.js";
import { deletePhoto, getPhoto, listPhotos, savePhoto } from "./data/photoStorage.js";
import { buildShoppingList, groupShoppingList } from "./data/shoppingList.js";
import { addDishEntry, dishesToRecipeRecords, loadAppData, migrateDishPhotos, placeOrder, saveDishes, saveOrders, updateEntryReferenceRecipe, updateEntryStepTimer, updateOrderCheckedIngredients } from "./data/storage.js";
import { createRunningTimer, formatTimer, remainingTimerSeconds } from "./data/timer.js";
import { createLocalBackup, getLocalBackup, importLocalBackup, listLocalBackups, restoreLocalBackup } from "./data/backupStorage.js";
import { createSyncPreview, downloadCloudPhoto, readCloudState, uploadCloudPhoto, writeCloudState } from "./data/sync.js";
import { isSupabaseConfigured, supabase } from "./data/supabaseClient.js";
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
  const backupFileInputRef = useRef(null);
  const [currentPage, setCurrentPage] = useState("dishes");
  const [photo, setPhoto] = useState("");
  const [dishName, setDishName] = useState("");
  const [dishCandidates, setDishCandidates] = useState([]);
  const [visibleIngredients, setVisibleIngredients] = useState([]);
  const [newVisibleIngredient, setNewVisibleIngredient] = useState("");
  const [recipe, setRecipe] = useState(null);
  const [note, setNote] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("炒菜");
  const [dishes, setDishes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [activeCategory, setActiveCategory] = useState("炒菜");
  const [selectedDishIds, setSelectedDishIds] = useState([]);
  const [isInitializing, setIsInitializing] = useState(true);
  const [photoUrls, setPhotoUrls] = useState({});
  const [activeRecipeId, setActiveRecipeId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [activeCookingEntryId, setActiveCookingEntryId] = useState(null);
  const [recipeGenerationStatus, setRecipeGenerationStatus] = useState({});
  const [timers, setTimers] = useState({});
  const [timerEditors, setTimerEditors] = useState({});
  const [session, setSession] = useState(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncPreview, setSyncPreview] = useState(null);
  const [backups, setBackups] = useState([]);
  const recipeGenerationAttemptedRef = useRef(new Set());
  const recipeGenerationInFlightRef = useRef(new Set());
  const timerAlertsRef = useRef(new Set());

  const isBusy = status === "recognizing" || status === "generating" || status === "saving";
  const savedRecipes = useMemo(() => dishesToRecipeRecords(dishes), [dishes]);
  const activeRecipe = useMemo(
    () => savedRecipes.find((item) => item.id === activeRecipeId) || null,
    [activeRecipeId, savedRecipes],
  );
  const activeOrder = useMemo(() => orders.find((order) => order.status === "active") || null, [orders]);
  const shoppingGroups = useMemo(
    () => groupShoppingList(buildShoppingList(dishes, activeOrder)),
    [activeOrder, dishes],
  );
  const cookingDishes = useMemo(() => {
    if (!activeOrder) return [];
    const selected = new Set(activeOrder.dishIds || []);
    return dishes.filter((dish) => selected.has(dish.dishId)).map((dish) => ({
      dish,
      entry: [...(dish.entries || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null,
    })).filter((item) => item.entry);
  }, [activeOrder, dishes]);
  const activeCookingDish = cookingDishes.find((item) => item.entry.entryId === activeCookingEntryId) || cookingDishes[0] || null;

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
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (currentPage !== "account") return;
    listLocalBackups().then(setBackups).catch((error) => setAccountMessage(error.message));
  }, [currentPage]);

  useEffect(() => {
    let cancelled = false;
    const photoIds = savedRecipes.map((record) => record.photo).filter(Boolean);
    Promise.all(photoIds.map(async (photoId) => [photoId, await getPhoto(photoId).catch(() => null)]))
      .then((pairs) => {
        if (!cancelled) setPhotoUrls(Object.fromEntries(pairs));
      });
    return () => { cancelled = true; };
  }, [savedRecipes]);

  useEffect(() => {
    if (cookingDishes.length === 0) {
      setActiveCookingEntryId(null);
      return;
    }
    if (!cookingDishes.some((item) => item.entry.entryId === activeCookingEntryId)) {
      setActiveCookingEntryId(cookingDishes[0].entry.entryId);
    }
  }, [activeCookingEntryId, cookingDishes]);

  useEffect(() => {
    if (!Object.values(timers).some((timer) => timer.status === "running")) return undefined;
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setTimers((current) => {
        let changed = false;
        const next = { ...current };
        Object.entries(current).forEach(([key, timer]) => {
          if (timer.status !== "running") return;
          const remaining = remainingTimerSeconds(timer.endAt, now);
          if (remaining === timer.remaining && remaining !== 0) return;
          changed = true;
          next[key] = { ...timer, remaining, status: remaining === 0 ? "done" : "running" };
          if (remaining === 0 && !timerAlertsRef.current.has(key)) {
            timerAlertsRef.current.add(key);
            window.setTimeout(() => window.alert(`${timer.label}计时结束`), 0);
          }
        });
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [timers]);

  useEffect(() => {
    if (currentPage !== "cooking") return;
    cookingDishes.forEach((item) => {
      if (!item.entry.referenceRecipe) generateReferenceRecipe(item);
    });
  }, [cookingDishes, currentPage]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setMessage("");
    setRecipe(null);
    setDishName("");
    setDishCandidates([]);
    setVisibleIngredients([]);
    setNewVisibleIngredient("");
    setNote("");
    setSelectedCategory("炒菜");
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
      const recognizedDishName = nextCandidates[0] && nextCandidates[0] !== "未识别" ? nextCandidates[0] : "";
      setDishName(recognizedDishName);
      setSelectedCategory(inferDishCategory(recognizedDishName));
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
        note,
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
    setSelectedCategory(inferDishCategory(candidate));
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
    if (!dishName.trim()) {
      setMessage("请先确认菜名。");
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
      note: note.trim(),
      referenceRecipe: recipe ? {
        ...recipe,
        食材清单: recipe["食材清单"]
          .map(normalizeIngredientForEdit)
          .filter((item) => item["名称"].trim() || item["用量"].trim()),
        步骤: recipe["步骤"]
          .filter((step) => step["内容"].trim())
          .map((step, index) => ({
            序号: index + 1,
            内容: step["内容"].trim(),
            timerSeconds: Number.isFinite(step.timerSeconds) ? Math.max(0, Math.round(step.timerSeconds)) : null,
          })),
      } : null,
    };

    try {
      const nextDishes = addDishEntry(localStorage, dishes, {
        dishName: dishName.trim(), category: selectedCategory, entry,
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
    setSelectedCategory(record.category || inferDishCategory(record.dishName));
    setNote(record.note || "");
    setDishCandidates([]);
    setVisibleIngredients((record.visibleIngredients || []).map((item) => item["名称"]).filter(Boolean));
    setNewVisibleIngredient("");
    setRecipe(record.recipe ? {
      ...record.recipe,
      食材清单: (record.recipe["食材清单"] || []).map(normalizeIngredientForEdit),
    } : null);
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

  function setCheckedIngredients(keys) {
    if (!activeOrder) return;
    const nextOrders = updateOrderCheckedIngredients(localStorage, orders, activeOrder.orderId, keys);
    setOrders(nextOrders);
  }

  function toggleIngredient(key) {
    const checked = activeOrder?.checkedIngredientKeys || [];
    setCheckedIngredients(checked.includes(key) ? checked.filter((item) => item !== key) : [...checked, key]);
  }

  async function generateReferenceRecipe(item, retry = false) {
    const entryId = item.entry.entryId;
    if (item.entry.referenceRecipe || recipeGenerationInFlightRef.current.has(entryId)) return;
    if (!retry && recipeGenerationAttemptedRef.current.has(entryId)) return;
    recipeGenerationAttemptedRef.current.add(entryId);
    recipeGenerationInFlightRef.current.add(entryId);
    setRecipeGenerationStatus((current) => ({ ...current, [entryId]: "loading" }));
    try {
      const result = await postJson("/api/generate-recipe", {
        dishName: item.dish.dishName,
        visibleIngredients: (item.entry.visibleIngredients || []).map((ingredient) => ingredient["名称"]).filter(Boolean),
        note: item.entry.note || "",
      });
      setDishes((current) => updateEntryReferenceRecipe(localStorage, current, entryId, result.recipe));
      setRecipeGenerationStatus((current) => ({ ...current, [entryId]: "done" }));
    } catch (error) {
      console.error("[cooking-recipe-generation] failed", { entryId, error });
      setRecipeGenerationStatus((current) => ({ ...current, [entryId]: "error" }));
    } finally {
      recipeGenerationInFlightRef.current.delete(entryId);
    }
  }

  function timerKey(entryId, stepIndex) {
    return `${entryId}:${stepIndex}`;
  }

  function startOrResumeTimer(entryId, stepIndex, totalSeconds, label) {
    const key = timerKey(entryId, stepIndex);
    timerAlertsRef.current.delete(key);
    setTimers((current) => {
      const existing = current[key];
      const remaining = existing?.status === "paused" && existing.remaining > 0
        ? existing.remaining
        : Math.max(0, Math.round(totalSeconds));
      return { ...current, [key]: createRunningTimer(totalSeconds, remaining, label) };
    });
  }

  function pauseTimer(entryId, stepIndex) {
    const key = timerKey(entryId, stepIndex);
    setTimers((current) => {
      const timer = current[key];
      if (!timer || timer.status !== "running") return current;
      const remaining = remainingTimerSeconds(timer.endAt);
      return { ...current, [key]: { ...timer, remaining, status: "paused", endAt: null } };
    });
  }

  function resetTimer(entryId, stepIndex, totalSeconds, label) {
    const key = timerKey(entryId, stepIndex);
    timerAlertsRef.current.delete(key);
    setTimers((current) => ({
      ...current,
      [key]: { total: totalSeconds, remaining: totalSeconds, status: "idle", endAt: null, label },
    }));
  }

  function saveManualTimer(entryId, stepIndex) {
    const key = timerKey(entryId, stepIndex);
    const minutes = Number(timerEditors[key]);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    setDishes((current) => updateEntryStepTimer(localStorage, current, entryId, stepIndex, minutes * 60));
    setTimerEditors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function refreshBackupList() {
    setBackups(await listLocalBackups());
  }

  async function handlePasswordLogin() {
    if (!supabase || !accountEmail.trim() || !accountPassword) return;
    setSyncStatus("auth");
    setAccountMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email: accountEmail.trim(),
      password: accountPassword,
    });
    setSyncStatus("idle");
    if (error) {
      setAccountMessage(`登录失败：${error.message}`);
    } else {
      setAccountPassword("");
      setAccountPasswordConfirm("");
      setAccountMessage("登录成功。不会自动同步，请先检查差异。");
    }
  }

  async function handlePasswordRegister() {
    if (!supabase || !accountEmail.trim() || accountPassword.length < 6) return;
    if (accountPassword !== accountPasswordConfirm) {
      setAccountMessage("两次输入的密码不一致。");
      return;
    }
    setSyncStatus("auth");
    setAccountMessage("");
    const { data, error } = await supabase.auth.signUp({
      email: accountEmail.trim(),
      password: accountPassword,
      options: { emailRedirectTo: window.location.origin },
    });
    setSyncStatus("idle");
    if (error) {
      setAccountMessage(`注册失败：${error.message}`);
    } else if (data.session) {
      setAccountPassword("");
      setAccountPasswordConfirm("");
      setAccountMessage("注册并登录成功。不会自动同步，请先检查差异。");
    } else {
      setAccountMessage("注册申请已提交。当前Supabase设置要求验证邮箱，请完成验证后再用账号密码登录。");
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSyncPreview(null);
    setAccountMessage("已退出登录，本地数据保持不变。");
  }

  async function buildLocalSyncState() {
    const photos = await listPhotos();
    return {
      state: { version: 1, dishes, orders, photoIds: photos.map((photo) => photo.photoId) },
      photos,
    };
  }

  async function handleCheckSync() {
    if (!supabase || !session?.user) return;
    try {
      setSyncStatus("checking");
      setAccountMessage("");
      const [local, remote] = await Promise.all([
        buildLocalSyncState(),
        readCloudState(supabase, session.user.id),
      ]);
      const preview = createSyncPreview(local.state, remote.state);
      setSyncPreview({
        ...preview,
        expectedRevision: remote.revision,
        localFingerprint: JSON.stringify(local.state),
      });
      setAccountMessage("差异检查完成。此操作尚未修改本地或云端数据。");
    } catch (error) {
      setAccountMessage(`检查同步失败：${error.message}`);
    } finally {
      setSyncStatus("idle");
    }
  }

  async function handleConfirmSync() {
    if (!supabase || !session?.user || !syncPreview) return;
    try {
      setSyncStatus("syncing");
      setAccountMessage("正在创建同步前完整备份…");
      const local = await buildLocalSyncState();
      if (JSON.stringify(local.state) !== syncPreview.localFingerprint) {
        throw new Error("本地数据在预览后发生变化，请重新检查同步");
      }
      const remote = await readCloudState(supabase, session.user.id);
      if (remote.revision !== syncPreview.expectedRevision) {
        throw new Error("云端数据在预览后发生变化，请重新检查同步");
      }
      await createLocalBackup({ dishes, orders, reason: "before-sync" });
      await refreshBackupList();

      const localPhotos = new Map(local.photos.map((photo) => [photo.photoId, photo.data]));
      for (const photoId of syncPreview.uploadPhotoIds) {
        const data = localPhotos.get(photoId);
        if (!data) throw new Error(`本地照片 ${photoId} 缺失，已停止同步`);
        await uploadCloudPhoto(supabase, session.user.id, photoId, data);
      }
      for (const photoId of syncPreview.downloadPhotoIds) {
        const data = await downloadCloudPhoto(supabase, session.user.id, photoId);
        await savePhoto(photoId, data);
      }

      await writeCloudState(supabase, session.user.id, syncPreview.merged, remote.revision);
      const nextDishes = syncPreview.merged.dishes || [];
      const nextOrders = syncPreview.merged.orders || [];
      saveDishes(localStorage, nextDishes);
      saveOrders(localStorage, nextOrders);
      setDishes(nextDishes);
      setOrders(nextOrders);
      setSyncPreview(null);
      setAccountMessage("同步完成。本地与云端已更新为非破坏合并结果。");
    } catch (error) {
      setAccountMessage(`同步已停止：${error.message}`);
    } finally {
      setSyncStatus("idle");
    }
  }

  async function handleRestoreBackup(backupId) {
    if (!window.confirm("恢复会替换当前本地数据；系统会先保存一份恢复前备份。确定继续吗？")) return;
    try {
      setSyncStatus("restoring");
      const snapshot = await getLocalBackup(backupId);
      if (!snapshot) throw new Error("备份不存在");
      await createLocalBackup({ dishes, orders, reason: "before-restore" });
      const restored = await restoreLocalBackup(snapshot);
      setDishes(restored.dishes);
      setOrders(restored.orders);
      setSyncPreview(null);
      await refreshBackupList();
      setAccountMessage("本地备份已恢复。云端未被修改，请检查后再决定是否同步。");
    } catch (error) {
      setAccountMessage(`恢复失败：${error.message}`);
    } finally {
      setSyncStatus("idle");
    }
  }

  async function handleCreateBackup() {
    try {
      setSyncStatus("backing-up");
      await createLocalBackup({ dishes, orders, reason: "manual" });
      await refreshBackupList();
      setAccountMessage("完整本地备份已创建。");
    } catch (error) {
      setAccountMessage(`备份失败：${error.message}`);
    } finally {
      setSyncStatus("idle");
    }
  }

  async function handleExportBackup(backupId) {
    const snapshot = await getLocalBackup(backupId);
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `photo-menu-backup-${snapshot.createdAt.replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const snapshot = JSON.parse(await file.text());
      await importLocalBackup(snapshot);
      await refreshBackupList();
      setAccountMessage("备份文件已导入到备份列表，尚未恢复或修改当前数据。");
    } catch (error) {
      setAccountMessage(`导入失败：${error.message}`);
    } finally {
      event.target.value = "";
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
    account: { eyebrow: "数据由你掌控", title: "同步与备份", description: "登录不会自动同步，先检查差异，再由你确认写入。", icon: "云" },
  };

  const navigation = [
    { id: "dishes", label: "菜品", icon: "菜" },
    { id: "list", label: "清单", icon: "单" },
    { id: "cooking", label: "制作", icon: "做" },
    { id: "upload", label: "上传", icon: "传" },
    { id: "account", label: "同步", icon: "云" },
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

            <div className="upload-meta-grid">
              <label>
                <span className="field-label compact-label">分类</span>
                <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
                  {DISH_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label>
                <span className="field-label compact-label">备注</span>
                <textarea value={note} rows={3} placeholder="例如：少辣、下次多放葱" onChange={(event) => setNote(event.target.value)} />
              </label>
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
            <p className="optional-recipe-hint">参考菜谱为可选项，不生成也可以直接保存这条记录。</p>

            {message && <p className="notice">{message}</p>}
          </section>

          <section className="panel recipe-panel">
            <div className="panel-title-row">
              <h2>参考菜谱（可选）</h2>
              <button className="primary-button compact" disabled={isBusy || !photo || !dishName.trim()} onClick={saveCurrentRecipe}>
                保存记录
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
              <div className="empty-recipe">需要参考做法时可以生成菜谱；也可以保留照片、可见食材和备注后直接保存。</div>
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
            <p>{activeRecipe.recipe
              ? `${activeRecipe.recipe["食材清单"].length} 项食材，${activeRecipe.recipe["步骤"].length} 个步骤`
              : "尚未生成参考菜谱"}</p>
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
      ) : currentPage === "list" ? (
        <main className="shopping-page" aria-labelledby="list-title">
          <header className="page-header shopping-header">
            <div>
              <p className="eyebrow">{currentMeta.eyebrow}</p>
              <h1 id="list-title">{currentMeta.title}</h1>
              <p className="page-description">{currentMeta.description}</p>
            </div>
          </header>

          {!activeOrder ? (
            <section className="shopping-empty">
              <span className="placeholder-icon" aria-hidden="true">单</span>
              <h2>还没有进行中的点单</h2>
              <p>先去“菜品”选择今天想吃的菜，点单后会自动生成采购清单。</p>
            </section>
          ) : shoppingGroups.length === 0 ? (
            <section className="shopping-empty"><h2>暂时没有可汇总的食材</h2><p>所选菜品的最新记录里还没有食材信息。</p></section>
          ) : (
            <div className="shopping-layout">
              <section className="shopping-summary">
                <span>本次点单</span>
                <strong>{activeOrder.dishIds.length} 道菜</strong>
                <small>{shoppingGroups.reduce((count, group) => count + group.items.length, 0)} 项食材</small>
              </section>
              <div className="shopping-groups">
                {shoppingGroups.map((group) => (
                  <section className="shopping-group" key={group.category}>
                    <header><h2>{group.category}</h2><span>{group.items.length}</span></header>
                    <div className="shopping-items">
                      {group.items.map((item) => {
                        const checked = (activeOrder.checkedIngredientKeys || []).includes(item.key);
                        return (
                          <label className={`shopping-item ${checked ? "checked" : ""}`} key={item.key}>
                            <input type="checkbox" checked={checked} onChange={() => toggleIngredient(item.key)} />
                            <span className="custom-checkbox" aria-hidden="true">{checked ? "✓" : ""}</span>
                            <strong>{item.name}</strong>
                            <span className="amount-list">
                              <small>{item.amounts.length > 0 ? item.amounts.map((amount) => amount || "适量").join("、") : "适量"}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
          {activeOrder && (activeOrder.checkedIngredientKeys || []).length > 0 && (
            <button type="button" className="reset-checks-action" onClick={() => setCheckedIngredients([])}>
              <strong>重置勾选</strong>
              <small>重新核对家里已有的食材</small>
            </button>
          )}
        </main>
      ) : currentPage === "cooking" ? (
        <main className="cooking-page" aria-labelledby="cooking-title">
          <header className="page-header cooking-header">
            <p className="eyebrow">{currentMeta.eyebrow}</p>
            <h1 id="cooking-title">{currentMeta.title}</h1>
            <p className="page-description">{currentMeta.description}</p>
          </header>

          {cookingDishes.length === 0 ? (
            <section className="cooking-empty">
              <span className="placeholder-icon" aria-hidden="true">做</span>
              <h2>还没有进行中的点单</h2>
              <p>先从“菜品”页点单，制作步骤会集中显示在这里。</p>
            </section>
          ) : (
            <section className="cooking-workspace">
              <div className="cooking-tabs" role="tablist" aria-label="点单菜品">
                {cookingDishes.map((item) => (
                  <button
                    key={item.entry.entryId}
                    type="button"
                    role="tab"
                    aria-selected={activeCookingDish?.entry.entryId === item.entry.entryId}
                    className={activeCookingDish?.entry.entryId === item.entry.entryId ? "active" : ""}
                    onClick={() => setActiveCookingEntryId(item.entry.entryId)}
                  >
                    {item.dish.dishName}
                    {recipeGenerationStatus[item.entry.entryId] === "loading" && <small>生成中</small>}
                  </button>
                ))}
              </div>

              {activeCookingDish && (
                <div className="cooking-recipe" role="tabpanel">
                  <header>
                    <div><span>正在制作</span><h2>{activeCookingDish.dish.dishName}</h2></div>
                    <small>{activeCookingDish.entry.referenceRecipe?.步骤?.length || 0} 个步骤</small>
                  </header>
                  {!activeCookingDish.entry.referenceRecipe ? (
                    <div className="recipe-generation-state">
                      {recipeGenerationStatus[activeCookingDish.entry.entryId] === "error" ? (
                        <>
                          <p>参考菜谱生成失败，本次不会自动重复请求。</p>
                          <button type="button" className="secondary-button" onClick={() => generateReferenceRecipe(activeCookingDish, true)}>手动重试</button>
                        </>
                      ) : (
                        <><div className="spinner dark" /><p>正在根据可见食材和备注生成参考菜谱…</p></>
                      )}
                    </div>
                  ) : (
                    <ol className="cooking-steps">
                      {(activeCookingDish.entry.referenceRecipe.步骤 || []).map((step, index) => {
                        const hasTimer = Number.isFinite(step.timerSeconds);
                        const totalSeconds = hasTimer ? Math.max(0, step.timerSeconds) : 0;
                        const key = timerKey(activeCookingDish.entry.entryId, index);
                        const timer = timers[key] || { total: totalSeconds, remaining: totalSeconds, status: "idle" };
                        const timerLabel = `${activeCookingDish.dish.dishName}第${index + 1}步`;
                        const editingTimer = timerEditors[key] !== undefined;
                        const timerMinutes = Number(timerEditors[key]);
                        return (
                          <li key={key} className="cooking-step">
                            <span className="step-number">{index + 1}</span>
                            <div className="step-content">
                              <p>{step["内容"]}</p>
                              {hasTimer ? (
                                <div className={`step-timer ${timer.status}`}>
                                  <strong>{formatTimer(timer.remaining)}</strong>
                                  <div>
                                    {(timer.status === "idle" || timer.status === "done") && <button type="button" onClick={() => startOrResumeTimer(activeCookingDish.entry.entryId, index, totalSeconds, timerLabel)}>开始计时</button>}
                                    {timer.status === "running" && <button type="button" onClick={() => pauseTimer(activeCookingDish.entry.entryId, index)}>暂停</button>}
                                    {timer.status === "paused" && <button type="button" onClick={() => startOrResumeTimer(activeCookingDish.entry.entryId, index, totalSeconds, timerLabel)}>继续</button>}
                                    <button type="button" className="timer-reset" onClick={() => resetTimer(activeCookingDish.entry.entryId, index, totalSeconds, timerLabel)}>重置</button>
                                  </div>
                                </div>
                              ) : editingTimer ? (
                                <div className="step-timer-setup">
                                  <label>
                                    <span>计时时长</span>
                                    <input
                                      type="number"
                                      min="0.1"
                                      step="0.5"
                                      inputMode="decimal"
                                      value={timerEditors[key]}
                                      aria-label={`${timerLabel}计时分钟数`}
                                      onChange={(event) => setTimerEditors((current) => ({ ...current, [key]: event.target.value }))}
                                    />
                                    <span>分钟</span>
                                  </label>
                                  <div>
                                    <button type="button" disabled={!Number.isFinite(timerMinutes) || timerMinutes <= 0} onClick={() => saveManualTimer(activeCookingDish.entry.entryId, index)}>保存计时</button>
                                    <button type="button" className="timer-setup-cancel" onClick={() => setTimerEditors((current) => {
                                      const next = { ...current };
                                      delete next[key];
                                      return next;
                                    })}>取消</button>
                                  </div>
                                </div>
                              ) : (
                                <button type="button" className="add-step-timer" onClick={() => setTimerEditors((current) => ({ ...current, [key]: "" }))}>
                                  这一步没有设置计时，点击添加
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              )}
            </section>
          )}
        </main>
      ) : currentPage === "account" ? (
        <main className="account-page" aria-labelledby="account-title">
          <header className="page-header account-header">
            <p className="eyebrow">{currentMeta.eyebrow}</p>
            <h1 id="account-title">{currentMeta.title}</h1>
            <p className="page-description">{currentMeta.description}</p>
          </header>

          <div className="account-grid">
            <section className="account-card">
              <div className="account-card-title"><h2>账户</h2><span>{session ? "已登录" : "未登录"}</span></div>
              {!isSupabaseConfigured ? (
                <p className="account-muted">尚未配置 Supabase 环境变量。</p>
              ) : session ? (
                <div className="signed-in-block">
                  <strong>{session.user.email}</strong>
                  <p>登录不会自动上传、下载或合并数据。</p>
                  <button type="button" className="text-button" onClick={handleSignOut}>退出登录</button>
                </div>
              ) : (
                <div className="login-form">
                  <label><span>邮箱账号</span><input type="email" autoComplete="email" value={accountEmail} placeholder="name@example.com" onChange={(event) => setAccountEmail(event.target.value)} /></label>
                  <label><span>密码</span><input type="password" autoComplete="current-password" value={accountPassword} placeholder="至少6位" onChange={(event) => setAccountPassword(event.target.value)} /></label>
                  <label><span>确认密码（注册时填写）</span><input type="password" autoComplete="new-password" value={accountPasswordConfirm} placeholder="再次输入密码" onChange={(event) => setAccountPasswordConfirm(event.target.value)} /></label>
                  <div className="password-auth-actions">
                    <button type="button" className="primary-button" disabled={!accountEmail.trim() || !accountPassword || syncStatus !== "idle"} onClick={handlePasswordLogin}>登录</button>
                    <button type="button" className="secondary-button" disabled={!accountEmail.trim() || accountPassword.length < 6 || accountPassword !== accountPasswordConfirm || syncStatus !== "idle"} onClick={handlePasswordRegister}>注册新账号</button>
                  </div>
                  <small>密码直接提交给Supabase Auth，本应用不会把密码写入菜品数据或备份。</small>
                </div>
              )}
            </section>

            <section className="account-card sync-card">
              <div className="account-card-title"><h2>手动云同步</h2><span>不会自动执行</span></div>
              <p className="account-muted">先只读检查本地与云端差异；确认预览后才会创建备份并写入。</p>
              <button type="button" className="primary-button" disabled={!session || syncStatus !== "idle"} onClick={handleCheckSync}>检查同步</button>
              {syncPreview && (
                <div className="sync-preview">
                  <h3>合并预览</h3>
                  <dl>
                    <div><dt>上传记录</dt><dd>{syncPreview.uploadEntryCount}</dd></div>
                    <div><dt>下载记录</dt><dd>{syncPreview.downloadEntryCount}</dd></div>
                    <div><dt>上传照片</dt><dd>{syncPreview.uploadPhotoIds.length}</dd></div>
                    <div><dt>下载照片</dt><dd>{syncPreview.downloadPhotoIds.length}</dd></div>
                    <div><dt>冲突副本</dt><dd>{syncPreview.conflicts.length}</dd></div>
                  </dl>
                  <p>确认后先创建完整本地备份，再执行非破坏合并。</p>
                  <button type="button" className="sync-confirm-button" disabled={syncStatus !== "idle"} onClick={handleConfirmSync}>确认同步</button>
                </div>
              )}
            </section>

            <section className="account-card backups-card">
              <div className="account-card-title">
                <h2>本地备份</h2>
                <div className="backup-actions">
                  <button type="button" onClick={handleCreateBackup} disabled={syncStatus !== "idle"}>立即备份</button>
                  <button type="button" onClick={() => backupFileInputRef.current?.click()}>导入文件</button>
                  <input ref={backupFileInputRef} className="hidden-input" type="file" accept="application/json,.json" onChange={handleImportBackup} />
                </div>
              </div>
              <p className="account-muted">恢复只修改本地数据；恢复后不会自动同步云端。</p>
              <div className="backup-list">
                {backups.length === 0 ? <p className="account-muted">还没有本地备份。</p> : backups.map((backup) => (
                  <article key={backup.backupId}>
                    <div>
                      <strong>{new Date(backup.createdAt).toLocaleString("zh-CN")}</strong>
                      <small>{backup.dishes.length} 道菜 · {backup.orders.length} 个订单 · {backup.photos.length} 张照片 · {backup.reason}</small>
                    </div>
                    <div>
                      <button type="button" onClick={() => handleExportBackup(backup.backupId)}>导出</button>
                      <button type="button" className="restore-button" disabled={syncStatus !== "idle"} onClick={() => handleRestoreBackup(backup.backupId)}>恢复</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
          {accountMessage && <p className="account-message" role="status">{accountMessage}</p>}
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
