import { appendEntryToDishes, createActiveOrder, createEntry, createId } from "./model.js";
import { isEmbeddedPhoto } from "./photoStorage.js";

export const STORAGE_KEYS = {
  dishes: "photo-menu-dishes-v1",
  orders: "photo-menu-orders-v1",
  legacyRecipes: "photo-menu-recipes",
};

function readArray(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function migrateLegacyRecipes(records = []) {
  const dishes = [];

  for (const record of records) {
    const dishName = String(record?.dishName || record?.recipe?.["菜名"] || "").trim();
    if (!dishName) continue;
    const recipe = record.recipe || null;
    const visibleIngredients = (recipe?.["食材清单"] || []).filter(
      (item) => item?.["来源"] === "图片可见",
    );
    const entry = createEntry({
      entryId: record.entryId || record.id || createId("entry"),
      createdAt: record.createdAt,
      photo: record.photo,
      visibleIngredients,
      note: record.note,
      referenceRecipe: recipe,
    });
    const existing = dishes.find((dish) => dish.dishName === dishName);
    if (existing) {
      existing.entries.push(entry);
    } else {
      dishes.push({
        dishId: record.dishId || createId("dish"),
        dishName,
        category: record.category || "炒菜",
        createdAt: entry.createdAt,
        entries: [entry],
      });
    }
  }

  return dishes;
}

export function saveDishes(storage, dishes) {
  storage.setItem(STORAGE_KEYS.dishes, JSON.stringify(dishes));
  return dishes;
}

export function saveOrders(storage, orders) {
  storage.setItem(STORAGE_KEYS.orders, JSON.stringify(orders));
  return orders;
}

export function loadAppData(storage = globalThis.localStorage) {
  let dishes = readArray(storage, STORAGE_KEYS.dishes);
  let orders = readArray(storage, STORAGE_KEYS.orders);
  let migrated = false;

  if (dishes === null) {
    const legacyRecipes = readArray(storage, STORAGE_KEYS.legacyRecipes) || [];
    dishes = migrateLegacyRecipes(legacyRecipes);
    // Photos are stored as data URLs and can be large. Keeping both the legacy
    // records and migrated dishes during the write can exceed localStorage quota.
    storage.removeItem(STORAGE_KEYS.legacyRecipes);
    try {
      saveDishes(storage, dishes);
    } catch (error) {
      if (error?.name !== "QuotaExceededError") throw error;
      dishes = [];
      saveDishes(storage, dishes);
    }
    migrated = true;
  }
  if (orders === null) {
    orders = [];
    saveOrders(storage, orders);
  }

  console.info("[local-storage] app data ready", JSON.stringify({
    dishesKeyWritten: storage.getItem(STORAGE_KEYS.dishes) !== null,
    ordersKeyWritten: storage.getItem(STORAGE_KEYS.orders) !== null,
    legacyKeyRemoved: storage.getItem(STORAGE_KEYS.legacyRecipes) === null,
    dishCount: dishes.length,
    orderCount: orders.length,
    migrated,
  }));

  return { dishes, orders, migrated };
}

export function addDishEntry(storage, dishes, input) {
  return saveDishes(storage, appendEntryToDishes(dishes, input));
}

export function placeOrder(storage, orders, dishIds) {
  return saveOrders(storage, createActiveOrder(orders, dishIds));
}

export function dishesToRecipeRecords(dishes) {
  return dishes
    .flatMap((dish) =>
      dish.entries.map((entry) => ({
        id: entry.entryId,
        dishId: dish.dishId,
        createdAt: entry.createdAt,
        photo: entry.photo,
        dishName: dish.dishName,
        category: dish.category,
        visibleIngredients: entry.visibleIngredients,
        note: entry.note,
        recipe: entry.referenceRecipe
          ? { 菜名: dish.dishName, ...entry.referenceRecipe }
          : null,
      })),
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function migrateDishPhotos(storage, dishes, photoStore, logger = console) {
  let migratedCount = 0;
  let failedCount = 0;
  const nextDishes = [];

  for (const dish of dishes) {
    const entries = [];
    for (const entry of dish.entries || []) {
      if (!isEmbeddedPhoto(entry.photo)) {
        entries.push(entry);
        continue;
      }

      const photoId = createId("photo");
      try {
        await photoStore.savePhoto(photoId, entry.photo);
        entries.push({ ...entry, photo: photoId });
        migratedCount += 1;
      } catch (error) {
        failedCount += 1;
        entries.push({ ...entry, photo: "" });
        logger.warn("[photo-migration] skipped failed photo", { entryId: entry.entryId, error });
      }
    }
    nextDishes.push({ ...dish, entries });
  }

  if (migratedCount > 0 || failedCount > 0) saveDishes(storage, nextDishes);
  return { dishes: nextDishes, migratedCount, failedCount };
}
