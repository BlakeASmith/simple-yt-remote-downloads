import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const COLLECTIONS_FILE = "/downloads/.collections.json";

export interface Collection {
  id: string;
  name: string;
  rootPath: string; // Absolute path to collection root directory
  createdAt: number;
  updatedAt: number;
}

export interface CollectionsData {
  collections: Collection[];
  lastUpdated: number;
}

/**
 * Load collections from disk
 */
export function loadCollections(): Collection[] {
  try {
    if (existsSync(COLLECTIONS_FILE)) {
      const data = readFileSync(COLLECTIONS_FILE, "utf-8");
      const parsed = JSON.parse(data);
      // Handle both old format (array) and new format (object)
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return parsed.collections || [];
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error loading collections:`, error);
  }
  return [];
}

/**
 * Save collections to disk
 */
export function saveCollections(collections: Collection[]): void {
  try {
    // Ensure downloads directory exists
    const downloadsDir = COLLECTIONS_FILE.substring(0, COLLECTIONS_FILE.lastIndexOf("/"));
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true });
    }
    const data: CollectionsData = {
      collections,
      lastUpdated: Date.now(),
    };
    writeFileSync(COLLECTIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving collections:`, error);
  }
}

/**
 * Generate a unique ID for a collection
 */
export function generateCollectionId(): string {
  return `collection-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class CollectionsManager {
  private collections: Collection[] = [];

  constructor() {
    this.collections = loadCollections();
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

    this.collections.push(collection);
    saveCollections(this.collections);
    
    console.log(`[${new Date().toISOString()}] Created collection: ${collection.id}`);
    return collection;
  }

  /**
   * Get all collections (reloads from disk to ensure freshness)
   */
  getAllCollections(): Collection[] {
    this.collections = loadCollections();
    return [...this.collections];
  }

  /**
   * Get a collection by ID (reloads from disk to ensure freshness)
   */
  getCollection(id: string): Collection | undefined {
    this.collections = loadCollections();
    return this.collections.find(c => c.id === id);
  }

  /**
   * Update a collection
   */
  updateCollection(id: string, updates: Partial<Omit<Collection, "id" | "createdAt">>): Collection | null {
    // Reload from disk first
    this.collections = loadCollections();
    const index = this.collections.findIndex(c => c.id === id);
    if (index === -1) {
      return null;
    }

    const collection = this.collections[index];
    this.collections[index] = { 
      ...collection, 
      ...updates,
      updatedAt: Date.now(),
    };
    saveCollections(this.collections);
    
    console.log(`[${new Date().toISOString()}] Updated collection: ${id}`);
    return this.collections[index];
  }

  /**
   * Delete a collection
   */
  deleteCollection(id: string): boolean {
    // Reload from disk first
    this.collections = loadCollections();
    const index = this.collections.findIndex(c => c.id === id);
    if (index === -1) {
      return false;
    }

    this.collections.splice(index, 1);
    saveCollections(this.collections);
    
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
