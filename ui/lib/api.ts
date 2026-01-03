import type { IntervalUnit } from "./format";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; status?: number };

async function readJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: "GET" });
  const json = await readJsonSafe(res);
  if (!res.ok) return { ok: false, message: json?.message || json?.error || "Request failed", status: res.status };
  return { ok: true, data: json as T };
}

export async function apiSend<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: any): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await readJsonSafe(res);
  if (!res.ok) return { ok: false, message: json?.message || json?.error || "Request failed", status: res.status };
  return { ok: true, data: json as T };
}

export interface Collection {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Schedule {
  id: string;
  url: string;
  path?: string;
  collectionId?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
  intervalMinutes: number;
  lastRun?: number;
  nextRun: number;
  enabled: boolean;
  createdAt: number;
  includeThumbnail?: boolean;
  includeTranscript?: boolean;
  excludeShorts?: boolean;
  useArchiveFile?: boolean;
}

export interface DownloadStatus {
  id: string;
  url: string;
  title?: string;
  channel?: string;
  status: "downloading" | "processing" | "completed" | "failed";
  progress?: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  outputPath: string;
  currentFile?: string;
  currentPath?: string;
  finalFile?: string;
  finalPath?: string;
  logAvailable?: boolean;
  format: "video" | "audio";
  resolution?: "1080" | "720";
}

export interface DownloadLogResponse {
  success: boolean;
  log?: string;
  message?: string;
}

export interface TrackerStats {
  totalVideos: number;
  totalChannels: number;
  totalPlaylists: number;
  totalSize: number;
  deletedVideos: number;
}

export interface TrackedVideo {
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  url: string;
  relativePath: string;
  fullPath: string;
  downloadedAt: number;
  format: "video" | "audio";
  resolution?: "1080" | "720";
  fileSize?: number;
  duration?: number;
  ytdlpCommand?: string;
  files?: Array<{
    path: string;
    kind: "media" | "thumbnail" | "subtitle" | "intermediate" | "other";
    intermediate: boolean;
    exists: boolean;
    hidden: boolean;
    firstSeenAt: number;
    deletedAt?: number;
  }>;
  deleted?: boolean;
  deletedAt?: number;
}

export interface TrackedChannel {
  id: string;
  channelName: string;
  channelId?: string;
  url: string;
  relativePath: string;
  downloadedAt: number;
  lastDownloadedAt?: number;
  videoCount: number;
  videoIds: string[];
  maxVideos?: number;
}

export interface TrackedPlaylist {
  id: string;
  playlistName: string;
  playlistId?: string;
  url: string;
  relativePath: string;
  downloadedAt: number;
  lastDownloadedAt?: number;
  videoCount: number;
  videoIds: string[];
}

export interface DownloadRequest {
  url: string;
  path?: string;
  collectionId?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
  includeThumbnail?: boolean;
  includeTranscript?: boolean;
  excludeShorts?: boolean;
  useArchiveFile?: boolean;
}

export interface ScheduleCreateRequest extends DownloadRequest {
  intervalMinutes: number;
}

export function defaultsForFormat(audioOnly: boolean): Pick<
  DownloadRequest,
  "includeThumbnail" | "includeTranscript" | "excludeShorts" | "useArchiveFile"
> {
  return {
    includeThumbnail: !audioOnly,
    includeTranscript: !audioOnly,
    excludeShorts: true,
    useArchiveFile: true,
  };
}

export function normalizeScheduleUpdates(updates: Partial<Schedule>): Partial<Schedule> {
  // Server accepts partial update; keep payload minimal.
  const out: Partial<Schedule> = {};
  if (typeof updates.enabled === "boolean") out.enabled = updates.enabled;
  if (typeof updates.intervalMinutes === "number") out.intervalMinutes = updates.intervalMinutes;
  if (typeof updates.audioOnly === "boolean") out.audioOnly = updates.audioOnly;
  if (updates.resolution) out.resolution = updates.resolution;
  if (typeof updates.maxVideos === "number") out.maxVideos = updates.maxVideos;
  if (typeof updates.includeThumbnail === "boolean") out.includeThumbnail = updates.includeThumbnail;
  if (typeof updates.includeTranscript === "boolean") out.includeTranscript = updates.includeTranscript;
  if (typeof updates.excludeShorts === "boolean") out.excludeShorts = updates.excludeShorts;
  if (typeof updates.useArchiveFile === "boolean") out.useArchiveFile = updates.useArchiveFile;
  if (typeof updates.collectionId === "string") out.collectionId = updates.collectionId;
  if (updates.collectionId === undefined) {
    // omit to avoid clearing accidentally
  }
  return out;
}

