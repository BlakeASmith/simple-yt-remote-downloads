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
  const handlerStartTime = performance.now();
  let result: Record<string, any>;
  
  try {
    switch (job.type) {
      case "delete_video":
        result = await handleDeleteVideo(job);
        break;
      case "delete_channel":
        result = await handleDeleteChannel(job);
        break;
      case "delete_playlist":
        result = await handleDeletePlaylist(job);
        break;
      case "delete_collection":
        result = await handleDeleteCollection(job);
        break;
      case "move_collection":
        result = await handleMoveCollection(job);
        break;
      case "merge_collection":
        result = await handleMergeCollection(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
    
    const handlerDuration = performance.now() - handlerStartTime;
    console.log(`[${new Date().toISOString()}] [PERF] executeJobHandler(${job.type}) completed in ${handlerDuration.toFixed(2)}ms`);
    return result;
  } catch (error) {
    const handlerDuration = performance.now() - handlerStartTime;
    console.error(`[${new Date().toISOString()}] [PERF] executeJobHandler(${job.type}) failed after ${handlerDuration.toFixed(2)}ms:`, error);
    throw error;
  }
}

/**
 * Handle delete video job
 */
async function handleDeleteVideo(job: Job): Promise<Record<string, any>> {
  const startTime = performance.now();
  const { videoId, relativePath } = job.data;
  
  const trackerStartTime = performance.now();
  const tracker = getTracker();
  const trackerGetDuration = performance.now() - trackerStartTime;
  
  const deleteStartTime = performance.now();
  // Delete from database (file deletion happens asynchronously in tracker)
  const deleted = tracker.deleteVideo(videoId, relativePath);
  const deleteDuration = performance.now() - deleteStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleDeleteVideo(${videoId}) - GetTracker: ${trackerGetDuration.toFixed(2)}ms, Delete: ${deleteDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
  
  if (!deleted) {
    return { success: false, message: "Video not found or failed to delete" };
  }

  return { success: true, deletedVideos: 1 };
}

/**
 * Handle delete channel job
 */
async function handleDeleteChannel(job: Job): Promise<Record<string, any>> {
  const startTime = performance.now();
  const { channelId } = job.data;
  
  const trackerStartTime = performance.now();
  const tracker = getTracker();
  const trackerGetDuration = performance.now() - trackerStartTime;
  
  const deleteStartTime = performance.now();
  const deleted = tracker.deleteChannel(channelId);
  const deleteDuration = performance.now() - deleteStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleDeleteChannel(${channelId}) - GetTracker: ${trackerGetDuration.toFixed(2)}ms, Delete: ${deleteDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
  
  if (!deleted) {
    return { success: false, message: "Channel not found" };
  }

  return { success: true };
}

/**
 * Handle delete playlist job
 */
async function handleDeletePlaylist(job: Job): Promise<Record<string, any>> {
  const startTime = performance.now();
  const { playlistId } = job.data;
  
  const trackerStartTime = performance.now();
  const tracker = getTracker();
  const trackerGetDuration = performance.now() - trackerStartTime;
  
  const deleteStartTime = performance.now();
  const deleted = tracker.deletePlaylist(playlistId);
  const deleteDuration = performance.now() - deleteStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleDeletePlaylist(${playlistId}) - GetTracker: ${trackerGetDuration.toFixed(2)}ms, Delete: ${deleteDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
  
  if (!deleted) {
    return { success: false, message: "Playlist not found" };
  }

  return { success: true };
}

/**
 * Handle delete collection job
 */
async function handleDeleteCollection(job: Job): Promise<Record<string, any>> {
  const startTime = performance.now();
  const { collectionId } = job.data;
  
  const managerStartTime = performance.now();
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  const managerGetDuration = performance.now() - managerStartTime;
  
  const getCollectionStartTime = performance.now();
  const collection = collectionsManager.getCollection(collectionId);
  const getCollectionDuration = performance.now() - getCollectionStartTime;
  
  if (!collection) {
    return { success: false, message: "Collection not found" };
  }

  // Delete all videos in the collection (async file deletion)
  const deleteVideosStartTime = performance.now();
  const videoResult = tracker.deleteVideosByCollectionPath(collection.rootPath);
  const deleteVideosDuration = performance.now() - deleteVideosStartTime;
  
  // Delete collection directory asynchronously (non-blocking)
  const collectionPath = collection.rootPath;
  const fileCheckStartTime = performance.now();
  const pathExists = existsSync(collectionPath);
  const fileCheckDuration = performance.now() - fileCheckStartTime;
  
  if (pathExists) {
    const rmStartTime = performance.now();
    rm(collectionPath, { recursive: true, force: true }).catch((error) => {
      console.error(`[${new Date().toISOString()}] [PERF] Error deleting collection directory:`, error);
    });
    const rmDuration = performance.now() - rmStartTime;
    console.log(`[${new Date().toISOString()}] [PERF] Queued async deletion of collection directory (${rmDuration.toFixed(2)}ms to queue)`);
  }

  // Delete collection entry
  const deleteCollectionStartTime = performance.now();
  const deleted = collectionsManager.deleteCollection(collectionId, () => videoResult);
  const deleteCollectionDuration = performance.now() - deleteCollectionStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleDeleteCollection(${collectionId}) - GetManagers: ${managerGetDuration.toFixed(2)}ms, GetCollection: ${getCollectionDuration.toFixed(2)}ms, DeleteVideos: ${deleteVideosDuration.toFixed(2)}ms, FileCheck: ${fileCheckDuration.toFixed(2)}ms, DeleteCollection: ${deleteCollectionDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
  
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
  const startTime = performance.now();
  const { collectionId, name, rootPath } = job.data;
  
  const managerStartTime = performance.now();
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  const scheduler = getScheduler();
  const managerGetDuration = performance.now() - managerStartTime;
  
  const getCollectionStartTime = performance.now();
  const collection = collectionsManager.getCollection(collectionId);
  const getCollectionDuration = performance.now() - getCollectionStartTime;
  
  if (!collection) {
    return { success: false, message: "Collection not found" };
  }

  const resolvedRootPath = rootPath ? resolve(rootPath) : undefined;

  // Ensure target directory exists if path is changing
  let mkdirDuration = 0;
  if (resolvedRootPath && resolvedRootPath !== collection.rootPath) {
    try {
      const mkdirStartTime = performance.now();
      mkdirSync(resolvedRootPath, { recursive: true });
      mkdirDuration = performance.now() - mkdirStartTime;
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] [PERF] Failed to create target directory:`, error);
    }
  }

  // Move collection (file operations happen synchronously but in background)
  // We'll make this async in a future iteration
  const moveStartTime = performance.now();
  const updated = collectionsManager.moveCollection(
    collectionId,
    name,
    resolvedRootPath,
    (oldPath, newPath) => {
      const callbackStartTime = performance.now();
      const result = tracker.updateVideoPathsForCollectionMove(oldPath, newPath, DOWNLOADS_ROOT);
      const callbackDuration = performance.now() - callbackStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] updateVideoPathsForCollectionMove callback took ${callbackDuration.toFixed(2)}ms`);
      return result;
    },
    (oldId, newId) => {
      const callbackStartTime = performance.now();
      scheduler.updateSchedulesCollectionId(oldId, newId);
      const callbackDuration = performance.now() - callbackStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] updateSchedulesCollectionId callback took ${callbackDuration.toFixed(2)}ms`);
    }
  );
  const moveDuration = performance.now() - moveStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleMoveCollection(${collectionId}) - GetManagers: ${managerGetDuration.toFixed(2)}ms, GetCollection: ${getCollectionDuration.toFixed(2)}ms, Mkdir: ${mkdirDuration.toFixed(2)}ms, Move: ${moveDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);

  if (!updated) {
    return { success: false, message: "Failed to move collection" };
  }

  return { success: true, collection: updated };
}

/**
 * Handle merge collection job
 */
async function handleMergeCollection(job: Job): Promise<Record<string, any>> {
  const startTime = performance.now();
  const { sourceId, targetId } = job.data;
  
  const managerStartTime = performance.now();
  const collectionsManager = getCollectionsManager();
  const tracker = getTracker();
  const scheduler = getScheduler();
  const managerGetDuration = performance.now() - managerStartTime;
  
  const getCollectionsStartTime = performance.now();
  const source = collectionsManager.getCollection(sourceId);
  const target = collectionsManager.getCollection(targetId);
  const getCollectionsDuration = performance.now() - getCollectionsStartTime;
  
  if (!source) {
    return { success: false, message: "Source collection not found" };
  }

  if (!target) {
    return { success: false, message: "Target collection not found" };
  }

  // Ensure target directory exists
  let mkdirDuration = 0;
  try {
    const mkdirStartTime = performance.now();
    mkdirSync(target.rootPath, { recursive: true });
    mkdirDuration = performance.now() - mkdirStartTime;
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] [PERF] Failed to create target directory:`, error);
  }

  // Merge collections (file operations happen synchronously but in background)
  const mergeStartTime = performance.now();
  const merged = collectionsManager.mergeCollection(
    sourceId,
    targetId,
    (sourcePath, targetPath) => {
      const callbackStartTime = performance.now();
      const result = tracker.updateVideoPathsForCollectionMove(sourcePath, targetPath, DOWNLOADS_ROOT);
      const callbackDuration = performance.now() - callbackStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] updateVideoPathsForCollectionMove callback took ${callbackDuration.toFixed(2)}ms`);
      return result;
    },
    (oldId, newId) => {
      const callbackStartTime = performance.now();
      scheduler.updateSchedulesCollectionId(oldId, newId);
      const callbackDuration = performance.now() - callbackStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] updateSchedulesCollectionId callback took ${callbackDuration.toFixed(2)}ms`);
    }
  );
  const mergeDuration = performance.now() - mergeStartTime;
  
  const totalDuration = performance.now() - startTime;
  console.log(`[${new Date().toISOString()}] [PERF] handleMergeCollection(${sourceId} -> ${targetId}) - GetManagers: ${managerGetDuration.toFixed(2)}ms, GetCollections: ${getCollectionsDuration.toFixed(2)}ms, Mkdir: ${mkdirDuration.toFixed(2)}ms, Merge: ${mergeDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);

  if (!merged) {
    return { success: false, message: "Failed to merge collection" };
  }

  return { success: true, collection: merged };
}
