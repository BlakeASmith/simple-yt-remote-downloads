import { rm } from "fs/promises";
import { cpSync, rmSync, existsSync, mkdirSync } from "fs";
import { resolve, relative, join } from "path";
import { getTracker } from "./tracker";
import { getCollectionsManager } from "./collections";
import { getScheduler } from "./scheduler";
import type { Job } from "./job-queue";

const DOWNLOADS_ROOT = "/downloads";

/**
 * Execute a job handler based on job type
 */
export async function executeJobHandler(job: Job): Promise<Record<string, any>> {
  switch (job.type) {
    case "delete_video":
      return await handleDeleteVideo(job);
    case "delete_channel":
      return await handleDeleteChannel(job);
    case "delete_playlist":
      return await handleDeletePlaylist(job);
    case "delete_collection":
      return await handleDeleteCollection(job);
    case "move_collection":
      return await handleMoveCollection(job);
    case "merge_collection":
      return await handleMergeCollection(job);
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

/**
 * Handle delete video job
 */
async function handleDeleteVideo(job: Job): Promise<Record<string, any>> {
  const { videoId, relativePath } = job.data;
  const tracker = getTracker();

  // Delete from database (file deletion happens asynchronously in tracker)
  const deleted = tracker.deleteVideo(videoId, relativePath);
  
  if (!deleted) {
    return { success: false, message: "Video not found or failed to delete" };
  }

  return { success: true, deletedVideos: 1 };
}

/**
 * Handle delete channel job
 */
async function handleDeleteChannel(job: Job): Promise<Record<string, any>> {
  const { channelId } = job.data;
  const tracker = getTracker();
  
  const deleted = tracker.deleteChannel(channelId);
  
  if (!deleted) {
    return { success: false, message: "Channel not found" };
  }

  return { success: true };
}

/**
 * Handle delete playlist job
 */
async function handleDeletePlaylist(job: Job): Promise<Record<string, any>> {
  const { playlistId } = job.data;
  const tracker = getTracker();
  
  const deleted = tracker.deletePlaylist(playlistId);
  
  if (!deleted) {
    return { success: false, message: "Playlist not found" };
  }

  return { success: true };
}

/**
 * Handle delete collection job
 */
async function handleDeleteCollection(job: Job): Promise<Record<string, any>> {
  const { collectionId } = job.data;
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  
  const collection = collectionsManager.getCollection(collectionId);
  if (!collection) {
    return { success: false, message: "Collection not found" };
  }

  // Delete all videos in the collection (async file deletion)
  const videoResult = tracker.deleteVideosByCollectionPath(collection.rootPath);
  
  // Delete collection directory asynchronously (non-blocking)
  const collectionPath = collection.rootPath;
  if (existsSync(collectionPath)) {
    rm(collectionPath, { recursive: true, force: true }).catch((error) => {
      console.error(`[${new Date().toISOString()}] Error deleting collection directory:`, error);
    });
  }

  // Delete collection entry
  const deleted = collectionsManager.deleteCollection(collectionId, () => videoResult);
  
  if (!deleted) {
    return { success: false, message: "Failed to delete collection" };
  }

  return {
    success: true,
    deletedVideos: videoResult.deletedVideos,
    message: `Collection deleted: ${videoResult.deletedVideos} videos removed`,
  };
}

/**
 * Handle move collection job
 */
async function handleMoveCollection(job: Job): Promise<Record<string, any>> {
  const { collectionId, name, rootPath } = job.data;
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  const scheduler = getScheduler();
  
  const collection = collectionsManager.getCollection(collectionId);
  if (!collection) {
    return { success: false, message: "Collection not found" };
  }

  const resolvedRootPath = rootPath ? resolve(rootPath) : undefined;

  // Ensure target directory exists if path is changing
  if (resolvedRootPath && resolvedRootPath !== collection.rootPath) {
    try {
      mkdirSync(resolvedRootPath, { recursive: true });
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Failed to create target directory:`, error);
    }
  }

  // Move collection (file operations happen synchronously but in background)
  // We'll make this async in a future iteration
  const updated = collectionsManager.moveCollection(
    collectionId,
    name,
    resolvedRootPath,
    (oldPath, newPath) => tracker.updateVideoPathsForCollectionMove(oldPath, newPath, DOWNLOADS_ROOT),
    (oldId, newId) => scheduler.updateSchedulesCollectionId(oldId, newId)
  );

  if (!updated) {
    return { success: false, message: "Failed to move collection" };
  }

  return { success: true, collection: updated };
}

/**
 * Handle merge collection job
 */
async function handleMergeCollection(job: Job): Promise<Record<string, any>> {
  const { sourceId, targetId } = job.data;
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  const scheduler = getScheduler();
  
  const source = collectionsManager.getCollection(sourceId);
  const target = collectionsManager.getCollection(targetId);
  
  if (!source) {
    return { success: false, message: "Source collection not found" };
  }

  if (!target) {
    return { success: false, message: "Target collection not found" };
  }

  // Ensure target directory exists
  try {
    mkdirSync(target.rootPath, { recursive: true });
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] Failed to create target directory:`, error);
  }

  // Merge collections (file operations happen synchronously but in background)
  const merged = collectionsManager.mergeCollection(
    sourceId,
    targetId,
    (sourcePath, targetPath) => tracker.updateVideoPathsForCollectionMove(sourcePath, targetPath, DOWNLOADS_ROOT),
    (oldId, newId) => scheduler.updateSchedulesCollectionId(oldId, newId)
  );

  if (!merged) {
    return { success: false, message: "Failed to merge collection" };
  }

  return { success: true, collection: merged };
}
