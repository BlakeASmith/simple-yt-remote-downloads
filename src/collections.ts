import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from "fs";
import { Database } from "bun:sqlite";
import { join, resolve, relative, dirname } from "path";

export const COLLECTIONS_DB = "/downloads/.collections.db";

export interface Collection {
  id: string;
  name: string;
  rootPath: string; // Absolute path to collection root directory
  createdAt: number;
  updatedAt: number;
}

/**
 * Initialize the collections database
 */
function initDatabase(): Database {
  // Ensure downloads directory exists
  const downloadsDir = COLLECTIONS_DB.substring(0, COLLECTIONS_DB.lastIndexOf("/"));
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }

  const db = new Database(COLLECTIONS_DB);
  
  // Create collections table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rootPath TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  return db;
}

/**
 * Generate a unique ID for a collection
 */
export function generateCollectionId(): string {
  return `collection-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class CollectionsManager {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private getAllStmt: ReturnType<Database["prepare"]>;
  private getByIdStmt: ReturnType<Database["prepare"]>;
  private updateStmt: ReturnType<Database["prepare"]>;
  private deleteStmt: ReturnType<Database["prepare"]>;

  constructor() {
    this.db = initDatabase();
    
    // Prepare statements for better performance
    this.insertStmt = this.db.prepare(`
      INSERT INTO collections (id, name, rootPath, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    this.getAllStmt = this.db.prepare(`
      SELECT id, name, rootPath, createdAt, updatedAt
      FROM collections
      ORDER BY createdAt DESC
    `);
    
    this.getByIdStmt = this.db.prepare(`
      SELECT id, name, rootPath, createdAt, updatedAt
      FROM collections
      WHERE id = ?
    `);
    
    this.updateStmt = this.db.prepare(`
      UPDATE collections
      SET name = COALESCE(?, name),
          rootPath = COALESCE(?, rootPath),
          updatedAt = ?
      WHERE id = ?
    `);
    
    this.deleteStmt = this.db.prepare(`
      DELETE FROM collections WHERE id = ?
    `);
  }

  /**
   * Create a new collection
   */
  createCollection(collectionData: Omit<Collection, "id" | "createdAt" | "updatedAt">): Collection {
    const collection: Collection = {
      ...collectionData,
      id: generateCollectionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.insertStmt.run(
      collection.id,
      collection.name,
      collection.rootPath,
      collection.createdAt,
      collection.updatedAt
    );
    
    console.log(`[${new Date().toISOString()}] Created collection: ${collection.id}`);
    return collection;
  }

  /**
   * Get all collections
   */
  getAllCollections(): Collection[] {
    const rows = this.getAllStmt.all() as Array<{
      id: string;
      name: string;
      rootPath: string;
      createdAt: number;
      updatedAt: number;
    }>;
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      rootPath: row.rootPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Get a collection by ID
   */
  getCollection(id: string): Collection | undefined {
    const row = this.getByIdStmt.get(id) as {
      id: string;
      name: string;
      rootPath: string;
      createdAt: number;
      updatedAt: number;
    } | undefined;
    
    if (!row) return undefined;
    
    return {
      id: row.id,
      name: row.name,
      rootPath: row.rootPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Update a collection
   */
  updateCollection(id: string, updates: Partial<Omit<Collection, "id" | "createdAt">>): Collection | null {
    const existing = this.getCollection(id);
    if (!existing) {
      return null;
    }

    const updatedAt = Date.now();
    this.updateStmt.run(
      updates.name ?? null,
      updates.rootPath ?? null,
      updatedAt,
      id
    );
    
    console.log(`[${new Date().toISOString()}] Updated collection: ${id}`);
    
    // Return updated collection
    return this.getCollection(id)!;
  }

  /**
   * Delete a collection and all its videos with associated files
   */
  deleteCollection(id: string, deleteVideosCallback?: (rootPath: string) => { deletedVideos: number; deletedFiles: number }): boolean {
    const existing = this.getCollection(id);
    if (!existing) {
      return false;
    }

    // Delete all videos in the collection if callback provided
    let deletedVideos = 0;
    if (deleteVideosCallback) {
      const result = deleteVideosCallback(existing.rootPath);
      deletedVideos = result.deletedVideos;
    }

    // Delete collection entry
    this.deleteStmt.run(id);
    
    console.log(`[${new Date().toISOString()}] Deleted collection: ${id} (${deletedVideos} videos removed)`);
    return true;
  }

  /**
   * Move/rename a collection (change name and/or rootPath)
   * Updates tracker, schedules, and moves files on disk
   */
  moveCollection(
    id: string,
    newName?: string,
    newRootPath?: string,
    updateTrackerCallback?: (oldRootPath: string, newRootPath: string) => { updatedVideos: number },
    updateSchedulesCallback?: (oldCollectionId: string, newCollectionId: string) => void
  ): Collection | null {
    const startTime = performance.now();
    const getCollectionStartTime = performance.now();
    const existing = this.getCollection(id);
    const getCollectionDuration = performance.now() - getCollectionStartTime;
    
    if (!existing) {
      return null;
    }

    const finalName = newName ?? existing.name;
    const finalRootPath = newRootPath ? resolve(newRootPath) : existing.rootPath;

    // If rootPath is changing, move files on disk
    let fileOpsDuration = 0;
    let trackerUpdateDuration = 0;
    if (finalRootPath !== existing.rootPath) {
      try {
        const fileOpsStartTime = performance.now();
        // Ensure target directory exists
        const mkdirStartTime = performance.now();
        if (!existsSync(finalRootPath)) {
          mkdirSync(finalRootPath, { recursive: true });
        }
        const mkdirDuration = performance.now() - mkdirStartTime;

        // Move directory contents if source exists
        if (existsSync(existing.rootPath)) {
          // Use cpSync then rmSync for cross-filesystem compatibility
          const cpStartTime = performance.now();
          cpSync(existing.rootPath, finalRootPath, { recursive: true });
          const cpDuration = performance.now() - cpStartTime;
          
          const rmStartTime = performance.now();
          rmSync(existing.rootPath, { recursive: true, force: true });
          const rmDuration = performance.now() - rmStartTime;
          
          fileOpsDuration = performance.now() - fileOpsStartTime;
          console.log(`[${new Date().toISOString()}] [PERF] moveCollection file operations - Mkdir: ${mkdirDuration.toFixed(2)}ms, Copy: ${cpDuration.toFixed(2)}ms, Remove: ${rmDuration.toFixed(2)}ms, Total: ${fileOpsDuration.toFixed(2)}ms`);
        }
        fileOpsDuration = performance.now() - fileOpsStartTime;

        // Update tracker (video paths)
        if (updateTrackerCallback) {
          const trackerStartTime = performance.now();
          const result = updateTrackerCallback(existing.rootPath, finalRootPath);
          trackerUpdateDuration = performance.now() - trackerStartTime;
          console.log(`[${new Date().toISOString()}] [PERF] Updated ${result.updatedVideos} video paths in tracker (${trackerUpdateDuration.toFixed(2)}ms)`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [PERF] Error moving collection files:`, error);
        throw new Error(`Failed to move collection files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Update collection database entry
    const dbUpdateStartTime = performance.now();
    const updatedAt = Date.now();
    this.updateStmt.run(
      finalName !== existing.name ? finalName : null,
      finalRootPath !== existing.rootPath ? finalRootPath : null,
      updatedAt,
      id
    );
    const dbUpdateDuration = performance.now() - dbUpdateStartTime;

    const getUpdatedStartTime = performance.now();
    const updated = this.getCollection(id)!;
    const getUpdatedDuration = performance.now() - getUpdatedStartTime;
    
    const totalDuration = performance.now() - startTime;
    console.log(`[${new Date().toISOString()}] [PERF] moveCollection(${id}) - GetCollection: ${getCollectionDuration.toFixed(2)}ms, FileOps: ${fileOpsDuration.toFixed(2)}ms, TrackerUpdate: ${trackerUpdateDuration.toFixed(2)}ms, DBUpdate: ${dbUpdateDuration.toFixed(2)}ms, GetUpdated: ${getUpdatedDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
    
    return updated;
  }

  /**
   * Merge one collection into another
   * Moves all videos/files from source to target, updates tracker and schedules, then deletes source
   */
  mergeCollection(
    sourceId: string,
    targetId: string,
    updateTrackerCallback?: (sourceRootPath: string, targetRootPath: string) => { updatedVideos: number },
    updateSchedulesCallback?: (oldCollectionId: string, newCollectionId: string) => void,
    deleteVideosCallback?: (rootPath: string) => { deletedVideos: number; deletedFiles: number }
  ): Collection | null {
    const startTime = performance.now();
    
    const getCollectionsStartTime = performance.now();
    const source = this.getCollection(sourceId);
    const target = this.getCollection(targetId);
    const getCollectionsDuration = performance.now() - getCollectionsStartTime;

    if (!source || !target) {
      return null;
    }

    if (sourceId === targetId) {
      throw new Error("Cannot merge a collection into itself");
    }

    // Move files from source to target
    let fileOpsDuration = 0;
    let trackerUpdateDuration = 0;
    if (existsSync(source.rootPath)) {
      try {
        const fileOpsStartTime = performance.now();
        // Ensure target directory exists
        const mkdirStartTime = performance.now();
        if (!existsSync(target.rootPath)) {
          mkdirSync(target.rootPath, { recursive: true });
        }
        const mkdirDuration = performance.now() - mkdirStartTime;

        // Move all contents from source to target
        // Use cpSync then rmSync for cross-filesystem compatibility
        const cpStartTime = performance.now();
        cpSync(source.rootPath, target.rootPath, { recursive: true });
        const cpDuration = performance.now() - cpStartTime;
        
        const rmStartTime = performance.now();
        rmSync(source.rootPath, { recursive: true, force: true });
        const rmDuration = performance.now() - rmStartTime;
        
        fileOpsDuration = performance.now() - fileOpsStartTime;
        console.log(`[${new Date().toISOString()}] [PERF] mergeCollection file operations - Mkdir: ${mkdirDuration.toFixed(2)}ms, Copy: ${cpDuration.toFixed(2)}ms, Remove: ${rmDuration.toFixed(2)}ms, Total: ${fileOpsDuration.toFixed(2)}ms`);

        // Update tracker (video paths)
        if (updateTrackerCallback) {
          const trackerStartTime = performance.now();
          const result = updateTrackerCallback(source.rootPath, target.rootPath);
          trackerUpdateDuration = performance.now() - trackerStartTime;
          console.log(`[${new Date().toISOString()}] [PERF] Updated ${result.updatedVideos} video paths in tracker (${trackerUpdateDuration.toFixed(2)}ms)`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [PERF] Error merging collection files:`, error);
        throw new Error(`Failed to merge collection files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Update schedules to point to target collection
    let schedulesUpdateDuration = 0;
    if (updateSchedulesCallback) {
      const schedulesStartTime = performance.now();
      updateSchedulesCallback(sourceId, targetId);
      schedulesUpdateDuration = performance.now() - schedulesStartTime;
    }

    // Delete source collection (without deleting videos since they're moved)
    const deleteStartTime = performance.now();
    this.deleteStmt.run(sourceId);
    const deleteDuration = performance.now() - deleteStartTime;
    
    const getResultStartTime = performance.now();
    const result = this.getCollection(targetId)!;
    const getResultDuration = performance.now() - getResultStartTime;
    
    const totalDuration = performance.now() - startTime;
    console.log(`[${new Date().toISOString()}] [PERF] mergeCollection(${sourceId} -> ${targetId}) - GetCollections: ${getCollectionsDuration.toFixed(2)}ms, FileOps: ${fileOpsDuration.toFixed(2)}ms, TrackerUpdate: ${trackerUpdateDuration.toFixed(2)}ms, SchedulesUpdate: ${schedulesUpdateDuration.toFixed(2)}ms, Delete: ${deleteDuration.toFixed(2)}ms, GetResult: ${getResultDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
    
    return result;
  }
}

// Singleton instance
let collectionsInstance: CollectionsManager | null = null;

/**
 * Get the collections manager instance
 */
export function getCollectionsManager(): CollectionsManager {
  if (!collectionsInstance) {
    collectionsInstance = new CollectionsManager();
  }
  return collectionsInstance;
}
