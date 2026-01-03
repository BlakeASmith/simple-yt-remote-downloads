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
  format: "video" | "audio";
  resolution?: "1080" | "720";
}

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
    updates: Partial<Pick<DownloadStatus, "status" | "progress" | "title" | "channel" | "error">>
  ): void {
    const status = this.activeDownloads.get(id);
    if (status) {
      Object.assign(status, updates);
      if (updates.status === "completed" || updates.status === "failed") {
        status.completedAt = Date.now();
        // Auto-remove after 30 seconds
        setTimeout(() => {
          this.activeDownloads.delete(id);
        }, 30000);
      }
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
