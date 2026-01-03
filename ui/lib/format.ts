export function formatTime(ts?: number): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  return d.toLocaleString();
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "Unknown";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const v = bytes / Math.pow(k, i);
  return `${Math.round(v * 100) / 100} ${sizes[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "Unknown";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export type IntervalUnit = "hours" | "days" | "weeks" | "months";

export function toMinutes(value: number, unit: IntervalUnit): number {
  const v = Math.max(1, Math.floor(value || 1));
  switch (unit) {
    case "hours":
      return v * 60;
    case "days":
      return v * 60 * 24;
    case "weeks":
      return v * 60 * 24 * 7;
    case "months":
      return v * 60 * 24 * 30;
  }
}

export function fromMinutes(minutes: number): { value: number; unit: IntervalUnit } {
  if (minutes < 1440) return { value: Math.max(1, Math.floor(minutes / 60)), unit: "hours" };
  if (minutes < 10080) return { value: Math.max(1, Math.floor(minutes / 1440)), unit: "days" };
  if (minutes < 43200) return { value: Math.max(1, Math.floor(minutes / 10080)), unit: "weeks" };
  return { value: Math.max(1, Math.floor(minutes / 43200)), unit: "months" };
}

export function formatInterval(minutes: number): string {
  const { value, unit } = fromMinutes(minutes);
  const label = unit.slice(0, -1); // hour/day/week/month
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

