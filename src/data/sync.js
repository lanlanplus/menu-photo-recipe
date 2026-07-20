export const CLOUD_STATE_TABLE = "mpr_user_app_states";
export const CLOUD_PHOTO_BUCKET = "mpr-photos";

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of stableString(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function sameRecord(left, right) {
  return stableString(left) === stableString(right);
}

function normalizeDishKey(name) {
  return String(name || "").trim().replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function mergeEntries(localEntries = [], cloudEntries = [], conflicts) {
  const merged = localEntries.map((entry) => structuredClone(entry));
  const byId = new Map(merged.map((entry) => [entry.entryId, entry]));
  for (const cloudEntry of cloudEntries) {
    const localEntry = byId.get(cloudEntry.entryId);
    if (!localEntry) {
      const copy = structuredClone(cloudEntry);
      merged.push(copy);
      byId.set(copy.entryId, copy);
    } else if (!sameRecord(localEntry, cloudEntry)) {
      const conflictId = `${cloudEntry.entryId}-cloud-conflict-${shortHash(cloudEntry)}`;
      if (!byId.has(conflictId)) {
        const copy = { ...structuredClone(cloudEntry), entryId: conflictId };
        merged.push(copy);
        byId.set(conflictId, copy);
        conflicts.push({ type: "entry", id: cloudEntry.entryId, preservedAs: conflictId });
      }
    }
  }
  return merged;
}

function mergeDishes(localDishes = [], cloudDishes = [], conflicts) {
  const merged = localDishes.map((dish) => structuredClone(dish));
  const byName = new Map(merged.map((dish) => [normalizeDishKey(dish.dishName), dish]));
  const cloudDishIdMap = new Map();
  for (const cloudDish of cloudDishes) {
    const key = normalizeDishKey(cloudDish.dishName);
    const localDish = byName.get(key);
    if (!localDish) {
      const copy = structuredClone(cloudDish);
      merged.push(copy);
      byName.set(key, copy);
      cloudDishIdMap.set(cloudDish.dishId, copy.dishId);
    } else {
      cloudDishIdMap.set(cloudDish.dishId, localDish.dishId);
      localDish.entries = mergeEntries(localDish.entries, cloudDish.entries, conflicts);
    }
  }
  return { dishes: merged, cloudDishIdMap };
}

function mergeOrders(localOrders = [], cloudOrders = [], conflicts) {
  const merged = localOrders.map((order) => structuredClone(order));
  const byId = new Map(merged.map((order) => [order.orderId, order]));
  for (const cloudOrder of cloudOrders) {
    const localOrder = byId.get(cloudOrder.orderId);
    if (!localOrder) {
      const copy = structuredClone(cloudOrder);
      merged.push(copy);
      byId.set(copy.orderId, copy);
    } else if (!sameRecord(localOrder, cloudOrder)) {
      const conflictId = `${cloudOrder.orderId}-cloud-conflict-${shortHash(cloudOrder)}`;
      if (!byId.has(conflictId)) {
        merged.push({ ...structuredClone(cloudOrder), orderId: conflictId });
        conflicts.push({ type: "order", id: cloudOrder.orderId, preservedAs: conflictId });
      }
    }
  }
  const activeOrders = merged.filter((order) => order.status === "active")
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const activeId = activeOrders[0]?.orderId;
  return merged.map((order) => order.status === "active" && order.orderId !== activeId
    ? { ...order, status: "done" }
    : order);
}

export function mergeAppStates(localState, cloudState) {
  const conflicts = [];
  const local = localState || {};
  const cloud = cloudState || {};
  const dishMerge = mergeDishes(local.dishes, cloud.dishes, conflicts);
  const remappedCloudOrders = (cloud.orders || []).map((order) => ({
    ...order,
    dishIds: (order.dishIds || []).map((dishId) => dishMerge.cloudDishIdMap.get(dishId) || dishId),
  }));
  const merged = {
    version: 1,
    dishes: dishMerge.dishes,
    orders: mergeOrders(local.orders, remappedCloudOrders, conflicts),
    photoIds: [...new Set([...(local.photoIds || []), ...(cloud.photoIds || [])])],
  };
  return { merged, conflicts };
}

function collectEntryIds(state) {
  return new Set((state?.dishes || []).flatMap((dish) => (dish.entries || []).map((entry) => entry.entryId)));
}

export function createSyncPreview(localState, cloudState) {
  const { merged, conflicts } = mergeAppStates(localState, cloudState);
  const localEntries = collectEntryIds(localState);
  const cloudEntries = collectEntryIds(cloudState);
  const localPhotos = new Set(localState?.photoIds || []);
  const cloudPhotos = new Set(cloudState?.photoIds || []);
  return {
    merged,
    conflicts,
    uploadEntryCount: [...localEntries].filter((id) => !cloudEntries.has(id)).length,
    downloadEntryCount: [...cloudEntries].filter((id) => !localEntries.has(id)).length,
    uploadPhotoIds: [...localPhotos].filter((id) => !cloudPhotos.has(id)),
    downloadPhotoIds: [...cloudPhotos].filter((id) => !localPhotos.has(id)),
  };
}

export async function readCloudState(client, userId) {
  const { data, error } = await client.from(CLOUD_STATE_TABLE)
    .select("app_state, revision, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { state: data.app_state, revision: data.revision, updatedAt: data.updated_at }
    : { state: { version: 1, dishes: [], orders: [], photoIds: [] }, revision: 0, updatedAt: null };
}

export async function writeCloudState(client, userId, state, expectedRevision) {
  if (expectedRevision === 0) {
    const { error } = await client.from(CLOUD_STATE_TABLE).insert({ user_id: userId, app_state: state, revision: 1 });
    if (error) throw error;
    return 1;
  }
  const { data, error } = await client.from(CLOUD_STATE_TABLE)
    .update({ app_state: state, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("revision", expectedRevision)
    .select("revision")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("云端数据已在其他设备变化，请重新检查同步");
  return data.revision;
}

export async function uploadCloudPhoto(client, userId, photoId, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const { error } = await client.storage.from(CLOUD_PHOTO_BUCKET)
    .upload(`${userId}/${photoId}`, blob, { upsert: false, contentType: blob.type || "image/jpeg" });
  if (error && !String(error.message || "").toLowerCase().includes("already exists")) throw error;
}

export async function downloadCloudPhoto(client, userId, photoId) {
  const { data, error } = await client.storage.from(CLOUD_PHOTO_BUCKET).download(`${userId}/${photoId}`);
  if (error) throw error;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("云端照片读取失败"));
    reader.readAsDataURL(data);
  });
}
