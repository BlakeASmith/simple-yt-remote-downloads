import { existsSync, mkdirSync, rmSync } from "fs";
import { Database } from "bun:sqlite";
import { resolve, relative, join, dirname } from "path";

export const TRACKER_DB = "/downloads/.tracker.db";

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
  /** Suggested UI state: hide deleted intermediates by default */
  hidden: boolean;
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
  /** Full yt-dlp command used for this download (for reproducibility/auditing). */
  ytdlpCommand?: string;
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

/**
 * Initialize the tracker database
 */
function initTrackerDatabase(): Database {
  // Ensure downloads directory exists
  const downloadsDir = TRACKER_DB.substring(0, TRACKER_DB.lastIndexOf("/"));
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }

  const db = new Database(TRACKER_DB);
  
  // Enable foreign keys
  db.exec("PRAGMA foreign_keys = ON");
  
  // Create videos table
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL,
      channelId TEXT,
      url TEXT NOT NULL,
      fullPath TEXT NOT NULL,
      downloadedAt INTEGER NOT NULL,
      format TEXT NOT NULL,
      resolution TEXT,
      fileSize INTEGER,
      duration REAL,
      ytdlpCommand TEXT,
      deleted INTEGER DEFAULT 0,
      deletedAt INTEGER,
      PRIMARY KEY (id, relativePath)
    )
  `);

  // Create tracked_files table (one-to-many with videos)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      videoRelativePath TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      intermediate INTEGER DEFAULT 0,
      "exists" INTEGER DEFAULT 1,
      hidden INTEGER DEFAULT 0,
      firstSeenAt INTEGER NOT NULL,
      deletedAt INTEGER,
      FOREIGN KEY (videoId, videoRelativePath) REFERENCES videos(id, relativePath) ON DELETE CASCADE
    )
  `);

  // Create channels table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      channelName TEXT NOT NULL,
      channelId TEXT,
      url TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      downloadedAt INTEGER NOT NULL,
      lastDownloadedAt INTEGER,
      videoCount INTEGER DEFAULT 0,
      maxVideos INTEGER
    )
  `);

  // Create channel_videos junction table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_videos (
      channelId TEXT NOT NULL,
      videoId TEXT NOT NULL,
      videoRelativePath TEXT NOT NULL,
      PRIMARY KEY (channelId, videoId, videoRelativePath),
      FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (videoId, videoRelativePath) REFERENCES videos(id, relativePath) ON DELETE CASCADE
    )
  `);

  // Create playlists table
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      playlistName TEXT NOT NULL,
      playlistId TEXT,
      url TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      downloadedAt INTEGER NOT NULL,
      lastDownloadedAt INTEGER,
      videoCount INTEGER DEFAULT 0
    )
  `);

  // Create playlist_videos junction table
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist_videos (
      playlistId TEXT NOT NULL,
      videoId TEXT NOT NULL,
      videoRelativePath TEXT NOT NULL,
      PRIMARY KEY (playlistId, videoId, videoRelativePath),
      FOREIGN KEY (playlistId) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (videoId, videoRelativePath) REFERENCES videos(id, relativePath) ON DELETE CASCADE
    )
  `);

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channelId);
    CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted);
    CREATE INDEX IF NOT EXISTS idx_tracked_files_video ON tracked_files(videoId, videoRelativePath);
    CREATE INDEX IF NOT EXISTS idx_channel_videos_channel ON channel_videos(channelId);
    CREATE INDEX IF NOT EXISTS idx_playlist_videos_playlist ON playlist_videos(playlistId);
  `);

  return db;
}

/**
 * Generate a unique ID for tracking
 */
function generateTrackingId(): string {
  return `track-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class Tracker {
  private db: Database;
  private insertVideoStmt: ReturnType<Database["prepare"]>;
  private updateVideoStmt: ReturnType<Database["prepare"]>;
  private getVideoStmt: ReturnType<Database["prepare"]>;
  private getAllVideosStmt: ReturnType<Database["prepare"]>;
  private getVideosByChannelStmt: ReturnType<Database["prepare"]>;
  private markVideoDeletedStmt: ReturnType<Database["prepare"]>;
  private insertFileStmt: ReturnType<Database["prepare"]>;
  private deleteVideoFilesStmt: ReturnType<Database["prepare"]>;
  private getVideoFilesStmt: ReturnType<Database["prepare"]>;
  private upsertChannelStmt: ReturnType<Database["prepare"]>;
  private getAllChannelsStmt: ReturnType<Database["prepare"]>;
  private getChannelStmt: ReturnType<Database["prepare"]>;
  private insertChannelVideoStmt: ReturnType<Database["prepare"]>;
  private getChannelVideosStmt: ReturnType<Database["prepare"]>;
  private upsertPlaylistStmt: ReturnType<Database["prepare"]>;
  private getAllPlaylistsStmt: ReturnType<Database["prepare"]>;
  private getPlaylistStmt: ReturnType<Database["prepare"]>;
  private insertPlaylistVideoStmt: ReturnType<Database["prepare"]>;
  private getPlaylistVideosStmt: ReturnType<Database["prepare"]>;
  private getStatsStmt: ReturnType<Database["prepare"]>;

  constructor() {
    this.db = initTrackerDatabase();
    
    // Prepare statements for videos
    this.insertVideoStmt = this.db.prepare(`
      INSERT OR REPLACE INTO videos 
      (id, relativePath, title, channel, channelId, url, fullPath, downloadedAt, format, resolution, fileSize, duration, ytdlpCommand, deleted, deletedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.updateVideoStmt = this.db.prepare(`
      UPDATE videos
      SET deleted = ?, deletedAt = ?
      WHERE id = ? AND relativePath = ?
    `);
    
    this.getVideoStmt = this.db.prepare(`
      SELECT * FROM videos WHERE id = ? AND relativePath = ?
    `);
    
    this.getAllVideosStmt = this.db.prepare(`
      SELECT * FROM videos ORDER BY downloadedAt DESC
    `);
    
    this.getVideosByChannelStmt = this.db.prepare(`
      SELECT v.* FROM videos v
      WHERE v.channelId = ? OR v.channel = ?
      ORDER BY v.downloadedAt DESC
    `);
    
    this.markVideoDeletedStmt = this.db.prepare(`
      UPDATE videos SET deleted = 1, deletedAt = ? WHERE id = ? AND relativePath = ?
    `);
    
    // Prepare statements for tracked_files
    this.insertFileStmt = this.db.prepare(`
      INSERT OR REPLACE INTO tracked_files
      (videoId, videoRelativePath, path, kind, intermediate, "exists", hidden, firstSeenAt, deletedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.deleteVideoFilesStmt = this.db.prepare(`
      DELETE FROM tracked_files WHERE videoId = ? AND videoRelativePath = ?
    `);
    
    this.getVideoFilesStmt = this.db.prepare(`
      SELECT * FROM tracked_files WHERE videoId = ? AND videoRelativePath = ?
    `);
    
    // Prepare statements for channels
    this.upsertChannelStmt = this.db.prepare(`
      INSERT INTO channels (id, channelName, channelId, url, relativePath, downloadedAt, lastDownloadedAt, videoCount, maxVideos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channelName = excluded.channelName,
        channelId = COALESCE(excluded.channelId, channelId),
        lastDownloadedAt = excluded.lastDownloadedAt,
        videoCount = excluded.videoCount,
        maxVideos = COALESCE(excluded.maxVideos, maxVideos)
    `);
    
    this.getAllChannelsStmt = this.db.prepare(`
      SELECT * FROM channels ORDER BY downloadedAt DESC
    `);
    
    this.getChannelStmt = this.db.prepare(`
      SELECT * FROM channels WHERE url = ? OR relativePath = ?
    `);
    
    this.insertChannelVideoStmt = this.db.prepare(`
      INSERT OR IGNORE INTO channel_videos (channelId, videoId, videoRelativePath)
      VALUES (?, ?, ?)
    `);
    
    this.getChannelVideosStmt = this.db.prepare(`
      SELECT videoId, videoRelativePath FROM channel_videos WHERE channelId = ?
    `);
    
    // Prepare statements for playlists
    this.upsertPlaylistStmt = this.db.prepare(`
      INSERT INTO playlists (id, playlistName, playlistId, url, relativePath, downloadedAt, lastDownloadedAt, videoCount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        playlistName = excluded.playlistName,
        playlistId = COALESCE(excluded.playlistId, playlistId),
        lastDownloadedAt = excluded.lastDownloadedAt,
        videoCount = excluded.videoCount
    `);
    
    this.getAllPlaylistsStmt = this.db.prepare(`
      SELECT * FROM playlists ORDER BY downloadedAt DESC
    `);
    
    this.getPlaylistStmt = this.db.prepare(`
      SELECT * FROM playlists WHERE url = ? OR relativePath = ?
    `);
    
    this.insertPlaylistVideoStmt = this.db.prepare(`
      INSERT OR IGNORE INTO playlist_videos (playlistId, videoId, videoRelativePath)
      VALUES (?, ?, ?)
    `);
    
    this.getPlaylistVideosStmt = this.db.prepare(`
      SELECT videoId, videoRelativePath FROM playlist_videos WHERE playlistId = ?
    `);
    
    // Prepare statement for stats
    this.getStatsStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as totalVideos,
        SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) as deletedVideos
      FROM videos
    `);
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

    // Check if video already exists
    const existing = this.getVideoStmt.get(trackedVideo.id, trackedVideo.relativePath) as any;
    
    // Merge files by path to retain intermediates + deletion state
    const mergedFilesByPath = new Map<string, TrackedFile>();
    
    if (existing) {
      // Load existing files
      const existingFiles = this.getVideoFilesStmt.all(trackedVideo.id, trackedVideo.relativePath) as Array<{
        path: string;
        kind: string;
        intermediate: number;
        exists: number;
        hidden: number;
        firstSeenAt: number;
        deletedAt: number | null;
      }>;
      
      for (const f of existingFiles) {
        mergedFilesByPath.set(f.path, {
          path: f.path,
          kind: f.kind as TrackedFileKind,
          intermediate: !!f.intermediate,
          exists: !!f.exists,
          hidden: !!f.hidden,
          firstSeenAt: f.firstSeenAt,
          deletedAt: f.deletedAt ?? undefined,
        });
      }
    }
    
    // Merge with new files
    for (const f of (trackedVideo.files || [])) {
      const prev = mergedFilesByPath.get(f.path);
      if (!prev) {
        mergedFilesByPath.set(f.path, f);
        continue;
      }
      mergedFilesByPath.set(f.path, {
        ...prev,
        ...f,
        // Preserve firstSeenAt if we had it
        firstSeenAt: prev.firstSeenAt || f.firstSeenAt,
        // If we ever saw a deletion timestamp, keep the earliest deletion time
        deletedAt: prev.deletedAt ?? f.deletedAt,
        // Preserve classification if new one is "other" but previous was more specific
        kind: f.kind === "other" && prev.kind !== "other" ? prev.kind : f.kind,
        intermediate: prev.intermediate || f.intermediate,
        hidden: typeof f.hidden === "boolean" ? f.hidden : (prev.hidden || (prev.intermediate || f.intermediate) && !(f.exists ?? prev.exists)),
      });
    }

    // Insert or update video
    this.insertVideoStmt.run(
      trackedVideo.id,
      trackedVideo.relativePath,
      trackedVideo.title,
      trackedVideo.channel,
      trackedVideo.channelId ?? null,
      trackedVideo.url,
      trackedVideo.fullPath,
      trackedVideo.downloadedAt,
      trackedVideo.format,
      trackedVideo.resolution ?? null,
      trackedVideo.fileSize ?? null,
      trackedVideo.duration ?? null,
      trackedVideo.ytdlpCommand ?? null,
      existing?.deleted ?? 0,
      existing?.deletedAt ?? null
    );

    // Delete old files and insert merged files
    this.deleteVideoFilesStmt.run(trackedVideo.id, trackedVideo.relativePath);
    for (const file of mergedFilesByPath.values()) {
      this.insertFileStmt.run(
        trackedVideo.id,
        trackedVideo.relativePath,
        file.path,
        file.kind,
        file.intermediate ? 1 : 0,
        file.exists ? 1 : 0,
        file.hidden ? 1 : 0,
        file.firstSeenAt,
        file.deletedAt ?? null
      );
    }

    return {
      ...trackedVideo,
      files: Array.from(mergedFilesByPath.values()),
      deleted: existing?.deleted ?? false,
      deletedAt: existing?.deletedAt ?? undefined,
    };
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
    const existing = this.getChannelStmt.get(channel.url, channel.relativePath) as any;

    let channelId: string;
    let videoIds: string[];
    let videoCount: number;
    let downloadedAt: number;

    if (existing) {
      channelId = existing.id;
      // Get existing video IDs
      const existingVideoIds = this.getChannelVideosStmt.all(channelId) as Array<{ videoId: string; videoRelativePath: string }>;
      videoIds = existingVideoIds.map(v => v.videoId);
      
      // Add new video ID if not present
      if (!videoIds.includes(channel.videoId)) {
        videoIds.push(channel.videoId);
      }
      videoCount = videoIds.length;
      downloadedAt = existing.downloadedAt;
    } else {
      channelId = generateTrackingId();
      videoIds = [channel.videoId];
      videoCount = 1;
      downloadedAt = Date.now();
    }

    // Upsert channel
    this.upsertChannelStmt.run(
      channelId,
      channel.channelName,
      channel.channelId ?? null,
      channel.url,
      channel.relativePath,
      downloadedAt,
      Date.now(),
      videoCount,
      channel.maxVideos ?? null
    );

    // Add video to channel (use channel's relativePath as videoRelativePath)
    // Videos downloaded for a channel are stored in the channel's folder
    this.insertChannelVideoStmt.run(channelId, channel.videoId, channel.relativePath);

    return {
      id: channelId,
      channelName: channel.channelName,
      channelId: channel.channelId,
      url: channel.url,
      relativePath: channel.relativePath,
      downloadedAt,
      lastDownloadedAt: Date.now(),
      videoCount,
      videoIds,
      maxVideos: channel.maxVideos,
    };
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
    const existing = this.getPlaylistStmt.get(playlist.url, playlist.relativePath) as any;

    let playlistId: string;
    let videoIds: string[];
    let videoCount: number;
    let downloadedAt: number;

    if (existing) {
      playlistId = existing.id;
      // Get existing video IDs
      const existingVideoIds = this.getPlaylistVideosStmt.all(playlistId) as Array<{ videoId: string; videoRelativePath: string }>;
      videoIds = existingVideoIds.map(v => v.videoId);
      
      // Add new video ID if not present
      if (!videoIds.includes(playlist.videoId)) {
        videoIds.push(playlist.videoId);
      }
      videoCount = videoIds.length;
      downloadedAt = existing.downloadedAt;
    } else {
      playlistId = generateTrackingId();
      videoIds = [playlist.videoId];
      videoCount = 1;
      downloadedAt = Date.now();
    }

    // Upsert playlist
    this.upsertPlaylistStmt.run(
      playlistId,
      playlist.playlistName,
      playlist.playlistId ?? null,
      playlist.url,
      playlist.relativePath,
      downloadedAt,
      Date.now(),
      videoCount
    );

    // Add video to playlist (use playlist's relativePath as videoRelativePath)
    // Videos downloaded for a playlist are stored in the playlist's folder
    this.insertPlaylistVideoStmt.run(playlistId, playlist.videoId, playlist.relativePath);

    return {
      id: playlistId,
      playlistName: playlist.playlistName,
      playlistId: playlist.playlistId,
      url: playlist.url,
      relativePath: playlist.relativePath,
      downloadedAt,
      lastDownloadedAt: Date.now(),
      videoCount,
      videoIds,
    };
  }

  /**
   * Mark a video as deleted
   */
  markVideoDeleted(videoId: string, relativePath: string): boolean {
    const result = this.markVideoDeletedStmt.run(Date.now(), videoId, relativePath);
    return result.changes > 0;
  }

  /**
   * Delete a video from tracking and remove all associated files from disk
   */
  deleteVideo(videoId: string, relativePath: string): boolean {
    // Get video info and associated files before deletion
    const video = this.getVideoStmt.get(videoId, relativePath) as any;
    if (!video) {
      return false;
    }

    // Get all associated files
    const files = this.getVideoFilesStmt.all(videoId, relativePath) as Array<{
      path: string;
      kind: string;
      intermediate: number;
      exists: number;
    }>;

    // Delete all associated files from disk
    let deletedFiles = 0;
    for (const file of files) {
      try {
        if (file.exists && existsSync(file.path)) {
          rmSync(file.path, { force: true });
          deletedFiles++;
        }
      } catch (error) {
        // Log but continue - don't fail deletion if a file can't be deleted
        console.error(`[${new Date().toISOString()}] Failed to delete file ${file.path}:`, error);
      }
    }

    // Delete video from database (cascades to tracked_files via foreign key)
    const deleteVideoStmt = this.db.prepare(`
      DELETE FROM videos WHERE id = ? AND relativePath = ?
    `);
    const result = deleteVideoStmt.run(videoId, relativePath);
    
    console.log(`[${new Date().toISOString()}] Deleted video ${videoId} (${relativePath}): ${deletedFiles} files removed`);
    
    return result.changes > 0;
  }

  /**
   * Delete a channel and all its videos with associated files
   */
  deleteChannel(channelId: string): boolean {
    // Check if channel exists
    const getChannelByIdStmt = this.db.prepare(`SELECT * FROM channels WHERE id = ?`);
    const channelData = getChannelByIdStmt.get(channelId) as any;
    
    if (!channelData) {
      return false;
    }

    // Get all videos associated with this channel
    const channelVideos = this.getChannelVideosStmt.all(channelId) as Array<{ videoId: string; videoRelativePath: string }>;
    
    let deletedVideos = 0;
    
    // Delete each video (which will delete files and database entries)
    for (const { videoId, videoRelativePath } of channelVideos) {
      if (this.deleteVideo(videoId, videoRelativePath)) {
        deletedVideos++;
      }
    }

    // Delete channel entry (cascades to channel_videos via foreign key)
    const deleteChannelStmt = this.db.prepare(`
      DELETE FROM channels WHERE id = ?
    `);
    const result = deleteChannelStmt.run(channelId);
    
    console.log(`[${new Date().toISOString()}] Deleted channel ${channelId}: ${deletedVideos} videos removed`);
    
    return result.changes > 0;
  }

  /**
   * Delete a playlist and all its videos with associated files
   */
  deletePlaylist(playlistId: string): boolean {
    // Check if playlist exists
    const getPlaylistByIdStmt = this.db.prepare(`SELECT * FROM playlists WHERE id = ?`);
    const playlistData = getPlaylistByIdStmt.get(playlistId) as any;
    
    if (!playlistData) {
      return false;
    }

    // Get all videos associated with this playlist
    const playlistVideos = this.getPlaylistVideosStmt.all(playlistId) as Array<{ videoId: string; videoRelativePath: string }>;
    
    let deletedVideos = 0;
    
    // Delete each video (which will delete files and database entries)
    for (const { videoId, videoRelativePath } of playlistVideos) {
      if (this.deleteVideo(videoId, videoRelativePath)) {
        deletedVideos++;
      }
    }

    // Delete playlist entry (cascades to playlist_videos via foreign key)
    const deletePlaylistStmt = this.db.prepare(`
      DELETE FROM playlists WHERE id = ?
    `);
    const result = deletePlaylistStmt.run(playlistId);
    
    console.log(`[${new Date().toISOString()}] Deleted playlist ${playlistId}: ${deletedVideos} videos removed`);
    
    return result.changes > 0;
  }

  /**
   * Delete all videos within a collection path and their files
   */
  deleteVideosByCollectionPath(collectionRootPath: string): { deletedVideos: number; deletedFiles: number } {
    // Get all videos and filter by those whose fullPath starts with collectionRootPath
    const allVideos = this.getAllVideos();
    const collectionVideos = allVideos.filter(v => v.fullPath.startsWith(collectionRootPath));
    
    let deletedVideos = 0;
    
    // Delete each video (which will delete files and database entries)
    for (const video of collectionVideos) {
      if (this.deleteVideo(video.id, video.relativePath)) {
        deletedVideos++;
      }
    }
    
    console.log(`[${new Date().toISOString()}] Deleted ${deletedVideos} videos from collection path ${collectionRootPath}`);
    
    // Note: deletedFiles count is not tracked here since deleteVideo handles file deletion internally
    return { deletedVideos, deletedFiles: 0 };
  }

  /**
   * Update video paths when a collection is moved or merged
   * Updates fullPath and relativePath for all videos in the old collection path
   */
  updateVideoPathsForCollectionMove(oldRootPath: string, newRootPath: string, downloadsRoot: string = "/downloads"): { updatedVideos: number } {
    const resolvedOldPath = resolve(oldRootPath);
    const resolvedNewPath = resolve(newRootPath);
    const resolvedDownloadsRoot = resolve(downloadsRoot);

    // Get all videos whose fullPath starts with oldRootPath
    const allVideos = this.getAllVideos();
    const videosToUpdate = allVideos.filter(v => {
      try {
        return resolve(v.fullPath).startsWith(resolvedOldPath);
      } catch {
        return false;
      }
    });

    let updatedCount = 0;

    for (const video of videosToUpdate) {
      try {
        const oldFullPath = resolve(video.fullPath);
        // Calculate relative path from old collection root to the video file
        const relativeFromOldRoot = relative(resolvedOldPath, oldFullPath);
        const newFullPath = join(resolvedNewPath, relativeFromOldRoot);
        
        // Calculate new relativePath from downloads root
        const newRelativePath = relative(resolvedDownloadsRoot, newFullPath);

        // Update video in database
        const updateVideoPathStmt = this.db.prepare(`
          UPDATE videos
          SET fullPath = ?, relativePath = ?
          WHERE id = ? AND relativePath = ?
        `);
        
        const result = updateVideoPathStmt.run(newFullPath, newRelativePath, video.id, video.relativePath);
        
        if (result.changes > 0) {
          // Get files before updating (using old relativePath)
          const files = this.getVideoFilesStmt.all(video.id, video.relativePath) as Array<{
            path: string;
            kind: string;
            intermediate: number;
            exists: number;
            hidden: number;
            firstSeenAt: number;
            deletedAt: number | null;
          }>;

          // Update tracked_files paths and videoRelativePath
          for (const file of files) {
            const oldFilePath = resolve(file.path);
            if (oldFilePath.startsWith(resolvedOldPath)) {
              const fileRelativeFromOldRoot = relative(resolvedOldPath, oldFilePath);
              const newFilePath = join(resolvedNewPath, fileRelativeFromOldRoot);

              // Update file path and videoRelativePath
              const updateFilePathStmt = this.db.prepare(`
                UPDATE tracked_files
                SET path = ?, videoRelativePath = ?
                WHERE videoId = ? AND videoRelativePath = ? AND path = ?
              `);
              updateFilePathStmt.run(newFilePath, newRelativePath, video.id, video.relativePath, file.path);
            }
          }

          // Update videoRelativePath in channel_videos and playlist_videos
          const updateChannelVideosStmt = this.db.prepare(`
            UPDATE channel_videos
            SET videoRelativePath = ?
            WHERE videoId = ? AND videoRelativePath = ?
          `);
          updateChannelVideosStmt.run(newRelativePath, video.id, video.relativePath);

          const updatePlaylistVideosStmt = this.db.prepare(`
            UPDATE playlist_videos
            SET videoRelativePath = ?
            WHERE videoId = ? AND videoRelativePath = ?
          `);
          updatePlaylistVideosStmt.run(newRelativePath, video.id, video.relativePath);

          updatedCount++;
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error updating video path for ${video.id}:`, error);
      }
    }

    console.log(`[${new Date().toISOString()}] Updated ${updatedCount} video paths from ${resolvedOldPath} to ${resolvedNewPath}`);
    return { updatedVideos: updatedCount };
  }

  /**
   * Get all tracked videos
   */
  getAllVideos(): TrackedVideo[] {
    const rows = this.getAllVideosStmt.all() as Array<any>;
    return rows.map(row => this.videoRowToTrackedVideo(row));
  }

  /**
   * Get all tracked channels
   */
  getAllChannels(): TrackedChannel[] {
    const rows = this.getAllChannelsStmt.all() as Array<any>;
    return rows.map(row => {
      const videoIds = this.getChannelVideosStmt.all(row.id) as Array<{ videoId: string; videoRelativePath: string }>;
      return {
        id: row.id,
        channelName: row.channelName,
        channelId: row.channelId ?? undefined,
        url: row.url,
        relativePath: row.relativePath,
        downloadedAt: row.downloadedAt,
        lastDownloadedAt: row.lastDownloadedAt ?? undefined,
        videoCount: row.videoCount,
        videoIds: videoIds.map(v => v.videoId),
        maxVideos: row.maxVideos ?? undefined,
      };
    });
  }

  /**
   * Get all tracked playlists
   */
  getAllPlaylists(): TrackedPlaylist[] {
    const rows = this.getAllPlaylistsStmt.all() as Array<any>;
    return rows.map(row => {
      const videoIds = this.getPlaylistVideosStmt.all(row.id) as Array<{ videoId: string; videoRelativePath: string }>;
      return {
        id: row.id,
        playlistName: row.playlistName,
        playlistId: row.playlistId ?? undefined,
        url: row.url,
        relativePath: row.relativePath,
        downloadedAt: row.downloadedAt,
        lastDownloadedAt: row.lastDownloadedAt ?? undefined,
        videoCount: row.videoCount,
        videoIds: videoIds.map(v => v.videoId),
      };
    });
  }

  /**
   * Get videos by channel
   */
  getVideosByChannel(channelId: string): TrackedVideo[] {
    const rows = this.getVideosByChannelStmt.all(channelId, channelId) as Array<any>;
    return rows.map(row => this.videoRowToTrackedVideo(row));
  }

  /**
   * Get videos by playlist
   */
  getVideosByPlaylist(playlistId: string): TrackedVideo[] {
    const playlist = this.db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(playlistId) as any;
    if (!playlist) return [];
    
    const videoIds = this.getPlaylistVideosStmt.all(playlistId) as Array<{ videoId: string; videoRelativePath: string }>;
    const videos: TrackedVideo[] = [];
    
    for (const { videoId, videoRelativePath } of videoIds) {
      const video = this.getVideoStmt.get(videoId, videoRelativePath) as any;
      if (video) {
        videos.push(this.videoRowToTrackedVideo(video));
      }
    }
    
    return videos;
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    totalVideos: number;
    totalChannels: number;
    totalPlaylists: number;
    deletedVideos: number;
  } {
    const stats = this.getStatsStmt.get() as { totalVideos: number; deletedVideos: number };
    const channels = this.getAllChannelsStmt.all() as Array<any>;
    const playlists = this.getAllPlaylistsStmt.all() as Array<any>;

    return {
      totalVideos: stats.totalVideos,
      totalChannels: channels.length,
      totalPlaylists: playlists.length,
      deletedVideos: stats.deletedVideos,
    };
  }

  /**
   * Convert a database row to TrackedVideo
   */
  private videoRowToTrackedVideo(row: any): TrackedVideo {
    const files = this.getVideoFilesStmt.all(row.id, row.relativePath) as Array<{
      path: string;
      kind: string;
      intermediate: number;
      exists: number;
      hidden: number;
      firstSeenAt: number;
      deletedAt: number | null;
    }>;

    return {
      id: row.id,
      title: row.title,
      channel: row.channel,
      channelId: row.channelId ?? undefined,
      url: row.url,
      relativePath: row.relativePath,
      fullPath: row.fullPath,
      downloadedAt: row.downloadedAt,
      format: row.format as "video" | "audio",
      resolution: row.resolution as "1080" | "720" | undefined,
      fileSize: row.fileSize ?? undefined,
      duration: row.duration ?? undefined,
      ytdlpCommand: row.ytdlpCommand ?? undefined,
      files: files.map(f => ({
        path: f.path,
        kind: f.kind as TrackedFileKind,
        intermediate: !!f.intermediate,
        exists: !!f.exists,
        hidden: !!f.hidden,
        firstSeenAt: f.firstSeenAt,
        deletedAt: f.deletedAt ?? undefined,
      })),
      deleted: !!row.deleted,
      deletedAt: row.deletedAt ?? undefined,
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
