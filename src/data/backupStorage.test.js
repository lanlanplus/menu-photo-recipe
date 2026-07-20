import assert from "node:assert/strict";
import test from "node:test";
import { validateBackupSnapshot } from "./backupStorage.js";

test("完整备份必须同时包含菜品、订单和照片", () => {
  const snapshot = { dishes: [], orders: [], photos: [] };
  assert.equal(validateBackupSnapshot(snapshot), snapshot);
  assert.throws(() => validateBackupSnapshot({ dishes: [], orders: [] }), /缺少必要数据/);
});
