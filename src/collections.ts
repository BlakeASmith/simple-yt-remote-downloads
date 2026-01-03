import { existsSync, mkdirSync } from "fs";
import { Database } from "bun:sqlite";

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
   * Delete a collection
   */
  deleteCollection(id: string): boolean {
    const existing = this.getCollection(id);
    if (!existing) {
      return false;
    }

    this.deleteStmt.run(id);
    
    console.log(`[${new Date().toISOString()}] Deleted collection: ${id}`);
    return true;
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
