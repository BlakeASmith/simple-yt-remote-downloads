import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const TRACKER_FILE = "/downloads/.tracker.json";

export type TrackedFileKind = "media" | "thumbnail" | "subtitle" | "intermediate" | "other";

export interface TrackedFile {
  /** Absolute filesystem path */
  path: string;
  /** Best-effort classification for future media management */
  kind: TrackedFileKind;
  /** True for temporary / intermediate artifacts (fragments, .part, format-specific files, etc.) */
  intermediate: boolean;
  /** Whether the file currently exists on disk (best-effort) */
  exists: boolean;
  /** When we first observed this file (timestamp) */
  firstSeenAt: number;
  /** When we observed it being deleted (timestamp) */
  deletedAt?: number;
}

export interface TrackedVideo {
  id: string; // YouTube video ID
  title: string;
  channel: string;
  channelId?: string;
  url: string;
  relativePath: string; // Relative to downloads root
  fullPath: string; // Full filesystem path
  downloadedAt: number; // timestamp
  format: "video" | "audio";
  resolution?: "1080" | "720";
  fileSize?: number; // bytes
  duration?: number; // seconds
  /**
   * All associated files for this video (media, thumbnails, subtitles, intermediates, etc.).
   * This drives future media management features.
   */
  files: TrackedFile[];
  /** @deprecated Prefer `files` */
  thumbnailPath?: string;
  deleted?: boolean; // Track if file was deleted
  deletedAt?: number; // timestamp when deleted
}

export interface TrackedChannel {
  id: string; // Unique tracking ID
  channelName: string;
  channelId?: string; // YouTube channel ID
  url: string;
  relativePath: string;
  downloadedAt: number; // timestamp of first download
  lastDownloadedAt?: number; // timestamp of most recent download
  videoCount: number; // Number of videos downloaded from this channel
  videoIds: string[]; // List of video IDs downloaded
  maxVideos?: number; // Max videos setting if applicable
}

export interface TrackedPlaylist {
  id: string; // Unique tracking ID
  playlistName: string;
  playlistId?: string; // YouTube playlist ID
  url: string;
  relativePath: string;
  downloadedAt: number; // timestamp of first download
  lastDownloadedAt?: number; // timestamp of most recent download
  videoCount: number; // Number of videos downloaded from this playlist
  videoIds: string[]; // List of video IDs downloaded
}

export interface TrackerData {
  videos: TrackedVideo[];
  channels: TrackedChannel[];
  playlists: TrackedPlaylist[];
  lastUpdated: number;
}

/**
 * Load tracker data from disk
 */
export function loadTrackerData(): TrackerData {
  try {
    if (existsSync(TRACKER_FILE)) {
      const data = readFileSync(TRACKER_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error loading tracker data:`, error);
  }
  return {
    videos: [],
    channels: [],
    playlists: [],
    lastUpdated: Date.now(),
  };
}

/**
 * Save tracker data to disk
 */
export function saveTrackerData(data: TrackerData): void {
  try {
    // Ensure downloads directory exists
    const downloadsDir = TRACKER_FILE.substring(0, TRACKER_FILE.lastIndexOf("/"));
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true });
    }
    data.lastUpdated = Date.now();
    writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving tracker data:`, error);
  }
}

/**
 * Generate a unique ID for tracking
 */
function generateTrackingId(): string {
  return `track-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class Tracker {
  private data: TrackerData;

  constructor() {
    this.data = loadTrackerData();
  }

  /**
   * Track a downloaded video
   */
  trackVideo(video: Omit<TrackedVideo, "downloadedAt">): TrackedVideo {
    const trackedVideo: TrackedVideo = {
      ...video,
      id: video.id, // Use YouTube video ID as the ID
      downloadedAt: Date.now(),
    };

    // Check if video already exists (update if it does)
    const existingIndex = this.data.videos.findIndex(v => v.id === trackedVideo.id && v.relativePath === trackedVideo.relativePath);
    if (existingIndex >= 0) {
      // Update existing video, preserve deleted status if it was deleted
      const existing = this.data.videos[existingIndex];

      // Merge files by path to retain intermediates + deletion state.
      const mergedFilesByPath = new Map<string, TrackedFile>();
      for (const f of (existing.files || [])) mergedFilesByPath.set(f.path, f);
      for (const f of (trackedVideo.files || [])) {
        const prev = mergedFilesByPath.get(f.path);
        if (!prev) {
          mergedFilesByPath.set(f.path, f);
          continue;
        }
        mergedFilesByPath.set(f.path, {
          ...prev,
          ...f,
          // Preserve firstSeenAt if we had it.
          firstSeenAt: prev.firstSeenAt || f.firstSeenAt,
          // If we ever saw a deletion timestamp, keep the earliest deletion time.
          deletedAt: prev.deletedAt ?? f.deletedAt,
          // Preserve classification if new one is "other" but previous was more specific.
          kind: f.kind === "other" && prev.kind !== "other" ? prev.kind : f.kind,
          intermediate: prev.intermediate || f.intermediate,
        });
      }

      this.data.videos[existingIndex] = {
        ...trackedVideo,
        files: Array.from(mergedFilesByPath.values()),
        deleted: existing.deleted,
        deletedAt: existing.deletedAt,
      };
    } else {
      // Ensure new videos always have a files array.
      if (!trackedVideo.files) trackedVideo.files = [];
      this.data.videos.push(trackedVideo);
    }

    saveTrackerData(this.data);
    return trackedVideo;
  }

  /**
   * Track or update a channel
   */
  trackChannel(channel: {
    channelName: string;
    channelId?: string;
    url: string;
    relativePath: string;
    videoId: string; // Video ID that was just downloaded
    maxVideos?: number;
  }): TrackedChannel {
    // Find existing channel by URL or relative path
    let existing = this.data.channels.find(
      c => c.url === channel.url || c.relativePath === channel.relativePath
    );

    if (existing) {
      // Update existing channel
      if (!existing.videoIds.includes(channel.videoId)) {
        existing.videoIds.push(channel.videoId);
        existing.videoCount = existing.videoIds.length;
      }
      existing.lastDownloadedAt = Date.now();
      existing.channelName = channel.channelName; // Update name in case it changed
      if (channel.channelId) {
        existing.channelId = channel.channelId;
      }
      if (channel.maxVideos !== undefined) {
        existing.maxVideos = channel.maxVideos;
      }
    } else {
      // Create new channel entry
      existing = {
        id: generateTrackingId(),
        channelName: channel.channelName,
        channelId: channel.channelId,
        url: channel.url,
        relativePath: channel.relativePath,
        downloadedAt: Date.now(),
        lastDownloadedAt: Date.now(),
        videoCount: 1,
        videoIds: [channel.videoId],
        maxVideos: channel.maxVideos,
      };
      this.data.channels.push(existing);
    }

    saveTrackerData(this.data);
    return existing;
  }

  /**
   * Track or update a playlist
   */
  trackPlaylist(playlist: {
    playlistName: string;
    playlistId?: string;
    url: string;
    relativePath: string;
    videoId: string; // Video ID that was just downloaded
  }): TrackedPlaylist {
    // Find existing playlist by URL or relative path
    let existing = this.data.playlists.find(
      p => p.url === playlist.url || p.relativePath === playlist.relativePath
    );

    if (existing) {
      // Update existing playlist
      if (!existing.videoIds.includes(playlist.videoId)) {
        existing.videoIds.push(playlist.videoId);
        existing.videoCount = existing.videoIds.length;
      }
      existing.lastDownloadedAt = Date.now();
      existing.playlistName = playlist.playlistName; // Update name in case it changed
      if (playlist.playlistId) {
        existing.playlistId = playlist.playlistId;
      }
    } else {
      // Create new playlist entry
      existing = {
        id: generateTrackingId(),
        playlistName: playlist.playlistName,
        playlistId: playlist.playlistId,
        url: playlist.url,
        relativePath: playlist.relativePath,
        downloadedAt: Date.now(),
        lastDownloadedAt: Date.now(),
        videoCount: 1,
        videoIds: [playlist.videoId],
      };
      this.data.playlists.push(existing);
    }

    saveTrackerData(this.data);
    return existing;
  }

  /**
   * Mark a video as deleted
   */
  markVideoDeleted(videoId: string, relativePath: string): boolean {
    const video = this.data.videos.find(
      v => v.id === videoId && v.relativePath === relativePath
    );
    if (video) {
      video.deleted = true;
      video.deletedAt = Date.now();
      saveTrackerData(this.data);
      return true;
    }
    return false;
  }

  /**
   * Get all tracked videos
   */
  getAllVideos(): TrackedVideo[] {
    this.data = loadTrackerData();
    return [...this.data.videos];
  }

  /**
   * Get all tracked channels
   */
  getAllChannels(): TrackedChannel[] {
    this.data = loadTrackerData();
    return [...this.data.channels];
  }

  /**
   * Get all tracked playlists
   */
  getAllPlaylists(): TrackedPlaylist[] {
    this.data = loadTrackerData();
    return [...this.data.playlists];
  }

  /**
   * Get videos by channel
   */
  getVideosByChannel(channelId: string): TrackedVideo[] {
    this.data = loadTrackerData();
    return this.data.videos.filter(v => v.channelId === channelId || v.channel === channelId);
  }

  /**
   * Get videos by playlist
   */
  getVideosByPlaylist(playlistId: string): TrackedVideo[] {
    this.data = loadTrackerData();
    // Note: This requires playlist tracking to include video references
    // For now, we'll filter by relative path
    return this.data.videos.filter(v => {
      const playlist = this.data.playlists.find(p => p.id === playlistId);
      return playlist && v.relativePath === playlist.relativePath;
    });
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    totalVideos: number;
    totalChannels: number;
    totalPlaylists: number;
    totalSize: number;
    deletedVideos: number;
  } {
    this.data = loadTrackerData();
    const deletedVideos = this.data.videos.filter(v => v.deleted).length;
    const totalSize = this.data.videos
      .filter(v => !v.deleted && v.fileSize)
      .reduce((sum, v) => sum + (v.fileSize || 0), 0);

    return {
      totalVideos: this.data.videos.length,
      totalChannels: this.data.channels.length,
      totalPlaylists: this.data.playlists.length,
      totalSize,
      deletedVideos,
    };
  }
}

// Singleton instance
let trackerInstance: Tracker | null = null;

/**
 * Get the tracker instance
 */
export function getTracker(): Tracker {
  if (!trackerInstance) {
    trackerInstance = new Tracker();
  }
  return trackerInstance;
}
