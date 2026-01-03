import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";

export interface DownloadStatus {
  id: string;
  url: string;
  title?: string;
  channel?: string;
  status: "downloading" | "processing" | "completed" | "failed";
  progress?: number; // 0-100
  startedAt: number;
  completedAt?: number;
  error?: string;
  outputPath: string;
  /**
   * Best-effort file details inferred from yt-dlp output.
   * For playlist/channel downloads this may refer to the currently processed item.
   */
  currentFile?: string; // e.g. "My Video [abcd1234xyz].f137.mp4"
  currentPath?: string; // full path if yt-dlp printed it
  finalFile?: string; // e.g. "My Video [abcd1234xyz].mkv" or ".mp3"
  finalPath?: string; // full path if yt-dlp printed it
  logAvailable?: boolean; // indicates a log file exists for this download id
  format: "video" | "audio";
  resolution?: "1080" | "720";
}

const DOWNLOAD_LOGS_DIR = "/downloads/.ytdlp-logs";

class DownloadStatusTracker {
  private activeDownloads: Map<string, DownloadStatus> = new Map();

  /**
   * Register a new download
   */
  registerDownload(options: {
    id: string;
    url: string;
    outputPath: string;
    format: "video" | "audio";
    resolution?: "1080" | "720";
    title?: string;
    channel?: string;
  }): void {
    const status: DownloadStatus = {
      id: options.id,
      url: options.url,
      title: options.title,
      channel: options.channel,
      status: "downloading",
      startedAt: Date.now(),
      outputPath: options.outputPath,
      logAvailable: false,
      format: options.format,
      resolution: options.resolution,
    };
    this.activeDownloads.set(options.id, status);
  }

  /**
   * Update download status
   */
  updateStatus(
    id: string,
    updates: Partial<
      Pick<
        DownloadStatus,
        "status" | "progress" | "title" | "channel" | "error" | "currentFile" | "currentPath" | "finalFile" | "finalPath" | "logAvailable"
      >
    >
  ): void {
    const status = this.activeDownloads.get(id);
    if (status) {
      Object.assign(status, updates);
      if (updates.status === "completed" || updates.status === "failed") {
        status.completedAt = Date.now();
        // Auto-remove after 10 minutes (gives time to inspect logs/details in the UI).
        setTimeout(() => {
          this.activeDownloads.delete(id);
        }, 10 * 60 * 1000);
      }
    }
  }

  private ensureLogsDir(): void {
    try {
      if (!existsSync(DOWNLOAD_LOGS_DIR)) {
        mkdirSync(DOWNLOAD_LOGS_DIR, { recursive: true });
      }
    } catch {
      // best-effort
    }
  }

  private logPathFor(id: string): string {
    return `${DOWNLOAD_LOGS_DIR}/${id}.log`;
  }

  /**
   * Append a single yt-dlp output line to the per-download log file.
   * This is best-effort and should never throw.
   */
  appendLog(id: string, line: string): void {
    if (!line) return;
    const status = this.activeDownloads.get(id);
    if (!status) return;

    try {
      this.ensureLogsDir();
      const path = this.logPathFor(id);
      // Bun supports node:fs sync apis; keep it simple and robust.
      // Add newline for readability and stable rendering in the UI.
      appendFileSync(path, `${line}\n`, "utf-8");
      if (!status.logAvailable) status.logAvailable = true;
    } catch {
      // ignore
    }
  }

  /**
   * Read the full yt-dlp log for a download id.
   */
  readLog(id: string): { ok: true; log: string } | { ok: false; message: string } {
    try {
      this.ensureLogsDir();
      const path = this.logPathFor(id);
      if (!existsSync(path)) return { ok: false, message: "Log not found" };
      const log = readFileSync(path, "utf-8");
      return { ok: true, log };
    } catch {
      return { ok: false, message: "Failed to read log" };
    }
  }

  /**
   * Get all active downloads
   */
  getActiveDownloads(): DownloadStatus[] {
    // Clean up old completed/failed downloads (older than 5 minutes)
    const now = Date.now();
    for (const [id, status] of this.activeDownloads.entries()) {
      if (
        (status.status === "completed" || status.status === "failed") &&
        status.completedAt &&
        now - status.completedAt > 5 * 60 * 1000
      ) {
        this.activeDownloads.delete(id);
      }
    }
    return Array.from(this.activeDownloads.values());
  }

  /**
   * Get a specific download status
   */
  getStatus(id: string): DownloadStatus | undefined {
    return this.activeDownloads.get(id);
  }

  /**
   * Remove a download from tracking
   */
  removeDownload(id: string): void {
    this.activeDownloads.delete(id);
  }

  /**
   * Find log files that contain a specific video ID
   * Returns array of download IDs whose logs contain the video ID
   */
  findLogsByVideoId(videoId: string): string[] {
    try {
      this.ensureLogsDir();
      const logFiles = readdirSync(DOWNLOAD_LOGS_DIR);
      const matchingIds: string[] = [];

      for (const file of logFiles) {
        if (!file.endsWith(".log")) continue;
        const downloadId = file.slice(0, -4); // Remove .log extension
        const logPath = this.logPathFor(downloadId);
        
        try {
          const logContent = readFileSync(logPath, "utf-8");
          // Check if log contains the video ID (format: [videoId] or just videoId)
          if (logContent.includes(`[${videoId}]`) || logContent.includes(videoId)) {
            matchingIds.push(downloadId);
          }
        } catch {
          // Skip files that can't be read
          continue;
        }
      }

      return matchingIds;
    } catch {
      return [];
    }
  }
}

// Singleton instance
let trackerInstance: DownloadStatusTracker | null = null;

/**
 * Get the download status tracker instance
 */
export function getDownloadStatusTracker(): DownloadStatusTracker {
  if (!trackerInstance) {
    trackerInstance = new DownloadStatusTracker();
  }
  return trackerInstance;
}
