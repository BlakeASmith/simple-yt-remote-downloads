import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

export const JOBS_DB = "/downloads/.jobs.db";

export type JobStatus = "pending" | "running" | "completed" | "failed";
export type JobType = "delete_video" | "delete_channel" | "delete_playlist" | "delete_collection" | "move_collection" | "merge_collection";

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  data: Record<string, any>;
  result?: Record<string, any>;
}

/**
 * Initialize the jobs database
 */
function initJobsDatabase(): Database {
  const downloadsDir = JOBS_DB.substring(0, JOBS_DB.lastIndexOf("/"));
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }

  const db = new Database(JOBS_DB);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      startedAt INTEGER,
      completedAt INTEGER,
      error TEXT,
      data TEXT NOT NULL,
      result TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_createdAt ON jobs(createdAt DESC);
  `);

  return db;
}

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class JobQueue {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private getByIdStmt: ReturnType<Database["prepare"]>;
  private updateStatusStmt: ReturnType<Database["prepare"]>;
  private getPendingStmt: ReturnType<Database["prepare"]>;
  private isProcessing: boolean = false;

  constructor() {
    this.db = initJobsDatabase();
    
    this.insertStmt = this.db.prepare(`
      INSERT INTO jobs (id, type, status, createdAt, data)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    this.getByIdStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE id = ?
    `);
    
    this.updateStatusStmt = this.db.prepare(`
      UPDATE jobs
      SET status = ?,
          startedAt = COALESCE(?, startedAt),
          completedAt = COALESCE(?, completedAt),
          error = ?,
          result = ?
      WHERE id = ?
    `);
    
    this.getPendingStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1
    `);

    // Start processing jobs asynchronously
    setImmediate(() => this.processJobs());
  }

  /**
   * Create a new job
   */
  createJob(type: JobType, data: Record<string, any>): Job {
    const startTime = performance.now();
    const job: Job = {
      id: generateJobId(),
      type,
      status: "pending",
      createdAt: Date.now(),
      data,
    };

    const dbStartTime = performance.now();
    this.insertStmt.run(
      job.id,
      job.type,
      job.status,
      job.createdAt,
      JSON.stringify(job.data)
    );
    const dbDuration = performance.now() - dbStartTime;

    const totalDuration = performance.now() - startTime;
    console.log(`[${new Date().toISOString()}] [PERF] Created job: ${job.id} (type: ${type}) - DB: ${dbDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
    
    // Trigger processing if not already running
    if (!this.isProcessing) {
      setImmediate(() => this.processJobs());
    }

    return job;
  }

  /**
   * Get a job by ID
   */
  getJob(id: string): Job | null {
    const row = this.getByIdStmt.get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      type: row.type as JobType,
      status: row.status as JobStatus,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      error: row.error ?? undefined,
      data: JSON.parse(row.data),
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }

  /**
   * Update job status
   */
  private updateJobStatus(
    id: string,
    status: JobStatus,
    error?: string,
    result?: Record<string, any>
  ): void {
    const updateStartTime = performance.now();
    const getJobStartTime = performance.now();
    const job = this.getJob(id);
    const getJobDuration = performance.now() - getJobStartTime;
    
    if (!job) {
      console.warn(`[${new Date().toISOString()}] [PERF] updateJobStatus: Job ${id} not found (getJob took ${getJobDuration.toFixed(2)}ms)`);
      return;
    }

    const startedAt = status === "running" && !job.startedAt ? Date.now() : job.startedAt;
    const completedAt = (status === "completed" || status === "failed") ? Date.now() : job.completedAt;

    const dbStartTime = performance.now();
    this.updateStatusStmt.run(
      status,
      startedAt ?? null,
      completedAt ?? null,
      error ?? null,
      result ? JSON.stringify(result) : null,
      id
    );
    const dbDuration = performance.now() - dbStartTime;
    const totalDuration = performance.now() - updateStartTime;
    
    if (totalDuration > 10) {
      console.log(`[${new Date().toISOString()}] [PERF] updateJobStatus(${id}, ${status}) - GetJob: ${getJobDuration.toFixed(2)}ms, DB: ${dbDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
    }
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    if (this.isProcessing) {
      console.log(`[${new Date().toISOString()}] [PERF] processJobs() called but already processing, skipping`);
      return;
    }
    this.isProcessing = true;
    const processStartTime = performance.now();

    try {
      let jobCount = 0;
      while (true) {
        const queryStartTime = performance.now();
        const row = this.getPendingStmt.get() as any;
        const queryDuration = performance.now() - queryStartTime;
        
        if (!row) {
          if (jobCount > 0) {
            const totalDuration = performance.now() - processStartTime;
            console.log(`[${new Date().toISOString()}] [PERF] Finished processing ${jobCount} job(s) - Total: ${totalDuration.toFixed(2)}ms`);
          }
          break;
        }

        const job: Job = {
          id: row.id,
          type: row.type as JobType,
          status: row.status as JobStatus,
          createdAt: row.createdAt,
          data: JSON.parse(row.data),
        };

        const queueWaitTime = Date.now() - job.createdAt;
        console.log(`[${new Date().toISOString()}] [PERF] Processing job ${job.id} (type: ${job.type}) - Queue wait: ${queueWaitTime}ms, Query: ${queryDuration.toFixed(2)}ms`);
        jobCount++;

        await this.executeJob(job);
      }
    } finally {
      this.isProcessing = false;
      const totalDuration = performance.now() - processStartTime;
      if (totalDuration > 10) {
        console.log(`[${new Date().toISOString()}] [PERF] processJobs() completed - Duration: ${totalDuration.toFixed(2)}ms`);
      }
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    const executeStartTime = performance.now();
    console.log(`[${new Date().toISOString()}] [PERF] Executing job: ${job.id} (type: ${job.type})`);
    
    const statusUpdateStartTime = performance.now();
    this.updateJobStatus(job.id, "running");
    const statusUpdateDuration = performance.now() - statusUpdateStartTime;

    try {
      // Import handlers dynamically to avoid circular dependencies
      const importStartTime = performance.now();
      const { executeJobHandler } = await import("./job-handlers");
      const importDuration = performance.now() - importStartTime;
      
      const handlerStartTime = performance.now();
      const result = await executeJobHandler(job);
      const handlerDuration = performance.now() - handlerStartTime;
      
      const completeStatusStartTime = performance.now();
      this.updateJobStatus(job.id, "completed", undefined, result);
      const completeStatusDuration = performance.now() - completeStatusStartTime;
      
      const totalDuration = performance.now() - executeStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] Completed job: ${job.id} - Handler: ${handlerDuration.toFixed(2)}ms, Status updates: ${(statusUpdateDuration + completeStatusDuration).toFixed(2)}ms, Import: ${importDuration.toFixed(2)}ms, Total: ${totalDuration.toFixed(2)}ms`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const totalDuration = performance.now() - executeStartTime;
      console.error(`[${new Date().toISOString()}] [PERF] Job ${job.id} failed after ${totalDuration.toFixed(2)}ms:`, errorMessage);
      const failStatusStartTime = performance.now();
      this.updateJobStatus(job.id, "failed", errorMessage);
      const failStatusDuration = performance.now() - failStatusStartTime;
      console.log(`[${new Date().toISOString()}] [PERF] Failed status update took ${failStatusDuration.toFixed(2)}ms`);
    }

    // Process next job
    setImmediate(() => this.processJobs());
  }

  /**
   * Get all jobs (for status API)
   */
  getAllJobs(limit: number = 100): Job[] {
    const startTime = performance.now();
    const prepareStartTime = performance.now();
    const stmt = this.db.prepare(`
      SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?
    `);
    const prepareDuration = performance.now() - prepareStartTime;
    
    const queryStartTime = performance.now();
    const rows = stmt.all(limit) as Array<any>;
    const queryDuration = performance.now() - queryStartTime;
    
    const parseStartTime = performance.now();
    const result = rows.map(row => ({
      id: row.id,
      type: row.type as JobType,
      status: row.status as JobStatus,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      error: row.error ?? undefined,
      data: JSON.parse(row.data),
      result: row.result ? JSON.parse(row.result) : undefined,
    }));
    const parseDuration = performance.now() - parseStartTime;
    
    const totalDuration = performance.now() - startTime;
    if (totalDuration > 50 || rows.length > 10) {
      console.log(`[${new Date().toISOString()}] [PERF] getAllJobs(limit=${limit}) - Prepare: ${prepareDuration.toFixed(2)}ms, Query: ${queryDuration.toFixed(2)}ms, Parse: ${parseDuration.toFixed(2)}ms, Rows: ${rows.length}, Total: ${totalDuration.toFixed(2)}ms`);
    }
    
    return result;
  }
}

// Singleton instance
let jobQueueInstance: JobQueue | null = null;

/**
 * Get the job queue instance
 */
export function getJobQueue(): JobQueue {
  if (!jobQueueInstance) {
    jobQueueInstance = new JobQueue();
  }
  return jobQueueInstance;
}
