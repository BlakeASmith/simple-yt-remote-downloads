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
    const existing = this.getCollection(id);
    if (!existing) {
      return null;
    }

    const finalName = newName ?? existing.name;
    const finalRootPath = newRootPath ? resolve(newRootPath) : existing.rootPath;

    // If rootPath is changing, move files on disk
    if (finalRootPath !== existing.rootPath) {
      try {
        // Ensure target directory exists
        if (!existsSync(finalRootPath)) {
          mkdirSync(finalRootPath, { recursive: true });
        }

        // Move directory contents if source exists
        if (existsSync(existing.rootPath)) {
          // Use cpSync then rmSync for cross-filesystem compatibility
          cpSync(existing.rootPath, finalRootPath, { recursive: true });
          rmSync(existing.rootPath, { recursive: true, force: true });
        }

        // Update tracker (video paths)
        if (updateTrackerCallback) {
          const result = updateTrackerCallback(existing.rootPath, finalRootPath);
          console.log(`[${new Date().toISOString()}] Updated ${result.updatedVideos} video paths in tracker`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error moving collection files:`, error);
        throw new Error(`Failed to move collection files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Update collection database entry
    const updatedAt = Date.now();
    this.updateStmt.run(
      finalName !== existing.name ? finalName : null,
      finalRootPath !== existing.rootPath ? finalRootPath : null,
      updatedAt,
      id
    );

    console.log(`[${new Date().toISOString()}] Moved collection: ${id} (name: ${existing.name} -> ${finalName}, path: ${existing.rootPath} -> ${finalRootPath})`);
    
    return this.getCollection(id)!;
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
    const source = this.getCollection(sourceId);
    const target = this.getCollection(targetId);

    if (!source || !target) {
      return null;
    }

    if (sourceId === targetId) {
      throw new Error("Cannot merge a collection into itself");
    }

    // Move files from source to target
    if (existsSync(source.rootPath)) {
      try {
        // Ensure target directory exists
        if (!existsSync(target.rootPath)) {
          mkdirSync(target.rootPath, { recursive: true });
        }

        // Move all contents from source to target
        // Use cpSync then rmSync for cross-filesystem compatibility
        cpSync(source.rootPath, target.rootPath, { recursive: true });
        rmSync(source.rootPath, { recursive: true, force: true });

        // Update tracker (video paths)
        if (updateTrackerCallback) {
          const result = updateTrackerCallback(source.rootPath, target.rootPath);
          console.log(`[${new Date().toISOString()}] Updated ${result.updatedVideos} video paths in tracker`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error merging collection files:`, error);
        throw new Error(`Failed to merge collection files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Update schedules to point to target collection
    if (updateSchedulesCallback) {
      updateSchedulesCallback(sourceId, targetId);
    }

    // Delete source collection (without deleting videos since they're moved)
    this.deleteStmt.run(sourceId);
    
    console.log(`[${new Date().toISOString()}] Merged collection ${sourceId} into ${targetId}`);
    
    return this.getCollection(targetId)!;
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
