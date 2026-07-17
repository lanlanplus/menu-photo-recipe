export function formatTimer(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function remainingTimerSeconds(endAt, now = Date.now()) {
  return Math.max(0, Math.ceil((endAt - now) / 1000));
}

export function createRunningTimer(totalSeconds, remainingSeconds, label, now = Date.now()) {
  const total = Math.max(0, Math.round(totalSeconds));
  const remaining = Math.max(0, Math.round(remainingSeconds ?? total));
  return { total, remaining, status: "running", endAt: now + remaining * 1000, label };
}
