import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const SCHEDULES_FILE = "/downloads/.schedules.json";

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
 * Load schedules from disk
 */
export function loadSchedules(): Schedule[] {
  try {
    if (existsSync(SCHEDULES_FILE)) {
      const data = readFileSync(SCHEDULES_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error loading schedules:`, error);
  }
  return [];
}

/**
 * Save schedules to disk
 */
export function saveSchedules(schedules: Schedule[]): void {
  try {
    // Ensure downloads directory exists
    const downloadsDir = SCHEDULES_FILE.substring(0, SCHEDULES_FILE.lastIndexOf("/"));
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true });
    }
    writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf-8");
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving schedules:`, error);
  }
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
  private schedules: Schedule[] = [];

  constructor() {
    this.schedules = loadSchedules();
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

    this.schedules.push(schedule);
    saveSchedules(this.schedules);
    
    console.log(`[${new Date().toISOString()}] Created schedule: ${schedule.id}`);
    return schedule;
  }

  /**
   * Get all schedules (reloads from disk to ensure freshness)
   */
  getAllSchedules(): Schedule[] {
    this.schedules = loadSchedules();
    return [...this.schedules];
  }

  /**
   * Get a schedule by ID (reloads from disk to ensure freshness)
   */
  getSchedule(id: string): Schedule | undefined {
    this.schedules = loadSchedules();
    return this.schedules.find(s => s.id === id);
  }

  /**
   * Update a schedule
   */
  updateSchedule(id: string, updates: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
    // Reload from disk first
    this.schedules = loadSchedules();
    const index = this.schedules.findIndex(s => s.id === id);
    if (index === -1) {
      return null;
    }

    const schedule = this.schedules[index];
    
    // If interval changed, recalculate next run
    if (updates.intervalMinutes !== undefined && updates.intervalMinutes !== schedule.intervalMinutes) {
      updates.nextRun = calculateNextRun(updates.intervalMinutes);
    }

    this.schedules[index] = { ...schedule, ...updates };
    saveSchedules(this.schedules);
    
    console.log(`[${new Date().toISOString()}] Updated schedule: ${id}`);
    return this.schedules[index];
  }

  /**
   * Delete a schedule
   */
  deleteSchedule(id: string): boolean {
    // Reload from disk first
    this.schedules = loadSchedules();
    const index = this.schedules.findIndex(s => s.id === id);
    if (index === -1) {
      return false;
    }

    this.schedules.splice(index, 1);
    saveSchedules(this.schedules);
    
    console.log(`[${new Date().toISOString()}] Deleted schedule: ${id}`);
    return true;
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
