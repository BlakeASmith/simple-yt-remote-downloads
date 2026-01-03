import { existsSync, mkdirSync } from "fs";
import { Database } from "bun:sqlite";

export const SCHEDULES_DB = "/downloads/.schedules.db";

export interface Schedule {
  id: string;
  url: string;
  path?: string;
  collectionId?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
  intervalMinutes: number;
  lastRun?: number; // timestamp
  nextRun: number; // timestamp
  enabled: boolean;
  createdAt: number;
  includeThumbnail?: boolean;
  includeTranscript?: boolean;
  excludeShorts?: boolean;
  useArchiveFile?: boolean;
  concurrentFragments?: number;
}

/**
 * Initialize the schedules database
 */
function initSchedulesDatabase(): Database {
  // Ensure downloads directory exists
  const downloadsDir = SCHEDULES_DB.substring(0, SCHEDULES_DB.lastIndexOf("/"));
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }

  const db = new Database(SCHEDULES_DB);
  
  // Create schedules table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      path TEXT,
      collectionId TEXT,
      audioOnly INTEGER DEFAULT 0,
      resolution TEXT,
      isPlaylist INTEGER DEFAULT 0,
      isChannel INTEGER DEFAULT 0,
      maxVideos INTEGER,
      intervalMinutes INTEGER NOT NULL,
      lastRun INTEGER,
      nextRun INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      includeThumbnail INTEGER DEFAULT 0,
      includeTranscript INTEGER DEFAULT 0,
      excludeShorts INTEGER DEFAULT 0,
      useArchiveFile INTEGER DEFAULT 0,
      concurrentFragments INTEGER
    )
  `);

  // Create index for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
    CREATE INDEX IF NOT EXISTS idx_schedules_nextRun ON schedules(nextRun);
  `);

  return db;
}

/**
 * Generate a unique ID for a schedule
 */
export function generateScheduleId(): string {
  return `schedule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Calculate next run time based on interval
 */
export function calculateNextRun(intervalMinutes: number): number {
  return Date.now() + intervalMinutes * 60 * 1000;
}

class Scheduler {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private getAllStmt: ReturnType<Database["prepare"]>;
  private getByIdStmt: ReturnType<Database["prepare"]>;
  private updateStmt: ReturnType<Database["prepare"]>;
  private deleteStmt: ReturnType<Database["prepare"]>;

  constructor() {
    this.db = initSchedulesDatabase();
    
    // Prepare statements for better performance
    this.insertStmt = this.db.prepare(`
      INSERT INTO schedules (
        id, url, path, collectionId, audioOnly, resolution, isPlaylist, isChannel,
        maxVideos, intervalMinutes, lastRun, nextRun, enabled, createdAt,
        includeThumbnail, includeTranscript, excludeShorts, useArchiveFile, concurrentFragments
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.getAllStmt = this.db.prepare(`
      SELECT * FROM schedules ORDER BY createdAt DESC
    `);
    
    this.getByIdStmt = this.db.prepare(`
      SELECT * FROM schedules WHERE id = ?
    `);
    
    // Note: We'll build dynamic UPDATE statements for partial updates
    // For now, prepare a full update statement
    this.updateStmt = this.db.prepare(`
      UPDATE schedules
      SET url = ?,
          path = ?,
          collectionId = ?,
          audioOnly = ?,
          resolution = ?,
          isPlaylist = ?,
          isChannel = ?,
          maxVideos = ?,
          intervalMinutes = ?,
          lastRun = ?,
          nextRun = ?,
          enabled = ?,
          includeThumbnail = ?,
          includeTranscript = ?,
          excludeShorts = ?,
          useArchiveFile = ?,
          concurrentFragments = ?
      WHERE id = ?
    `);
    
    this.deleteStmt = this.db.prepare(`
      DELETE FROM schedules WHERE id = ?
    `);
  }

  /**
   * Create a new schedule
   */
  createSchedule(scheduleData: Omit<Schedule, "id" | "nextRun" | "createdAt">): Schedule {
    const schedule: Schedule = {
      ...scheduleData,
      id: generateScheduleId(),
      nextRun: calculateNextRun(scheduleData.intervalMinutes),
      createdAt: Date.now(),
    };

    this.insertStmt.run(
      schedule.id,
      schedule.url,
      schedule.path ?? null,
      schedule.collectionId ?? null,
      schedule.audioOnly ? 1 : 0,
      schedule.resolution ?? null,
      schedule.isPlaylist ? 1 : 0,
      schedule.isChannel ? 1 : 0,
      schedule.maxVideos ?? null,
      schedule.intervalMinutes,
      schedule.lastRun ?? null,
      schedule.nextRun,
      schedule.enabled ? 1 : 0,
      schedule.createdAt,
      schedule.includeThumbnail ? 1 : 0,
      schedule.includeTranscript ? 1 : 0,
      schedule.excludeShorts ? 1 : 0,
      schedule.useArchiveFile ? 1 : 0,
      schedule.concurrentFragments ?? null
    );
    
    console.log(`[${new Date().toISOString()}] Created schedule: ${schedule.id}`);
    return schedule;
  }

  /**
   * Get all schedules
   */
  getAllSchedules(): Schedule[] {
    const rows = this.getAllStmt.all() as Array<any>;
    return rows.map(row => this.rowToSchedule(row));
  }

  /**
   * Get a schedule by ID
   */
  getSchedule(id: string): Schedule | undefined {
    const row = this.getByIdStmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToSchedule(row);
  }

  /**
   * Update a schedule
   */
  updateSchedule(id: string, updates: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
    const existing = this.getSchedule(id);
    if (!existing) {
      return null;
    }

    // Merge updates with existing values
    const merged: Schedule = {
      ...existing,
      ...updates,
    };

    // If interval changed, recalculate next run
    if (updates.intervalMinutes !== undefined && updates.intervalMinutes !== existing.intervalMinutes) {
      merged.nextRun = calculateNextRun(updates.intervalMinutes);
    }

    this.updateStmt.run(
      merged.url,
      merged.path ?? null,
      merged.collectionId ?? null,
      merged.audioOnly ? 1 : 0,
      merged.resolution ?? null,
      merged.isPlaylist ? 1 : 0,
      merged.isChannel ? 1 : 0,
      merged.maxVideos ?? null,
      merged.intervalMinutes,
      merged.lastRun ?? null,
      merged.nextRun,
      merged.enabled ? 1 : 0,
      merged.includeThumbnail ? 1 : 0,
      merged.includeTranscript ? 1 : 0,
      merged.excludeShorts ? 1 : 0,
      merged.useArchiveFile ? 1 : 0,
      merged.concurrentFragments ?? null,
      id
    );
    
    console.log(`[${new Date().toISOString()}] Updated schedule: ${id}`);
    return this.getSchedule(id)!;
  }

  /**
   * Delete a schedule
   */
  deleteSchedule(id: string): boolean {
    const existing = this.getSchedule(id);
    if (!existing) {
      return false;
    }

    this.deleteStmt.run(id);
    
    console.log(`[${new Date().toISOString()}] Deleted schedule: ${id}`);
    return true;
  }

  /**
   * Update collectionId for all schedules referencing a specific collection
   */
  updateSchedulesCollectionId(oldCollectionId: string, newCollectionId: string): number {
    const updateStmt = this.db.prepare(`
      UPDATE schedules
      SET collectionId = ?
      WHERE collectionId = ?
    `);
    
    const result = updateStmt.run(newCollectionId, oldCollectionId);
    
    console.log(`[${new Date().toISOString()}] Updated ${result.changes} schedules from collection ${oldCollectionId} to ${newCollectionId}`);
    return result.changes;
  }

  /**
   * Convert a database row to Schedule
   */
  private rowToSchedule(row: any): Schedule {
    return {
      id: row.id,
      url: row.url,
      path: row.path ?? undefined,
      collectionId: row.collectionId ?? undefined,
      audioOnly: !!row.audioOnly,
      resolution: row.resolution as "1080" | "720" | undefined,
      isPlaylist: !!row.isPlaylist,
      isChannel: !!row.isChannel,
      maxVideos: row.maxVideos ?? undefined,
      intervalMinutes: row.intervalMinutes,
      lastRun: row.lastRun ?? undefined,
      nextRun: row.nextRun,
      enabled: !!row.enabled,
      createdAt: row.createdAt,
      includeThumbnail: row.includeThumbnail ? true : undefined,
      includeTranscript: row.includeTranscript ? true : undefined,
      excludeShorts: row.excludeShorts ? true : undefined,
      useArchiveFile: row.useArchiveFile ? true : undefined,
      concurrentFragments: row.concurrentFragments ?? undefined,
    };
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

/**
 * Get the scheduler instance
 */
export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}
