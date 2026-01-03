import { startDownload, DownloadOptions } from "./downloader";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SCHEDULES_FILE = "/downloads/.schedules.json";
const DOWNLOADS_ROOT = "/downloads";

export interface Schedule {
  id: string;
  url: string;
  path?: string;
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
}

/**
 * Load schedules from disk
 */
function loadSchedules(): Schedule[] {
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
function saveSchedules(schedules: Schedule[]): void {
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
function generateScheduleId(): string {
  return `schedule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Calculate next run time based on interval
 */
function calculateNextRun(intervalMinutes: number): number {
  return Date.now() + intervalMinutes * 60 * 1000;
}

class Scheduler {
  private schedules: Schedule[] = [];
  private checkInterval: Timer | null = null;
  private checkIntervalMs = 60000; // Check every minute

  constructor() {
    this.schedules = loadSchedules();
    this.start();
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.checkInterval) {
      return; // Already running
    }

    console.log(`[${new Date().toISOString()}] Starting scheduler with ${this.schedules.length} schedule(s)`);
    
    this.checkInterval = setInterval(() => {
      this.checkAndRunSchedules();
    }, this.checkIntervalMs);

    // Run immediately on start
    this.checkAndRunSchedules();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log(`[${new Date().toISOString()}] Scheduler stopped`);
    }
  }

  /**
   * Check schedules and run any that are due
   */
  private checkAndRunSchedules(): void {
    const now = Date.now();
    let updated = false;

    for (const schedule of this.schedules) {
      if (!schedule.enabled) {
        continue;
      }

      if (now >= schedule.nextRun) {
        console.log(`[${new Date().toISOString()}] Running scheduled download: ${schedule.id}`);
        
        // Prepare download options
        const outputPath = schedule.path 
          ? join(DOWNLOADS_ROOT, schedule.path)
          : join(DOWNLOADS_ROOT, `schedule-${schedule.id}`);

        const downloadOptions: DownloadOptions = {
          url: schedule.url,
          outputPath,
          audioOnly: schedule.audioOnly || false,
          resolution: schedule.resolution || "1080",
          isPlaylist: schedule.isPlaylist || false,
          isChannel: schedule.isChannel || false,
          maxVideos: schedule.maxVideos,
        };

        // Start the download
        startDownload(downloadOptions);

        // Update schedule
        schedule.lastRun = now;
        schedule.nextRun = calculateNextRun(schedule.intervalMinutes);
        updated = true;
      }
    }

    if (updated) {
      saveSchedules(this.schedules);
    }
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
   * Get all schedules
   */
  getAllSchedules(): Schedule[] {
    return [...this.schedules];
  }

  /**
   * Get a schedule by ID
   */
  getSchedule(id: string): Schedule | undefined {
    return this.schedules.find(s => s.id === id);
  }

  /**
   * Update a schedule
   */
  updateSchedule(id: string, updates: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
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
