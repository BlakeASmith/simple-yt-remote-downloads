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
    const job: Job = {
      id: generateJobId(),
      type,
      status: "pending",
      createdAt: Date.now(),
      data,
    };

    this.insertStmt.run(
      job.id,
      job.type,
      job.status,
      job.createdAt,
      JSON.stringify(job.data)
    );

    console.log(`[${new Date().toISOString()}] Created job: ${job.id} (type: ${type})`);
    
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
    const job = this.getJob(id);
    if (!job) return;

    const startedAt = status === "running" && !job.startedAt ? Date.now() : job.startedAt;
    const completedAt = (status === "completed" || status === "failed") ? Date.now() : job.completedAt;

    this.updateStatusStmt.run(
      status,
      startedAt ?? null,
      completedAt ?? null,
      error ?? null,
      result ? JSON.stringify(result) : null,
      id
    );
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        const row = this.getPendingStmt.get() as any;
        if (!row) break;

        const job: Job = {
          id: row.id,
          type: row.type as JobType,
          status: row.status as JobStatus,
          createdAt: row.createdAt,
          data: JSON.parse(row.data),
        };

        await this.executeJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    console.log(`[${new Date().toISOString()}] Executing job: ${job.id} (type: ${job.type})`);
    this.updateJobStatus(job.id, "running");

    try {
      // Import handlers dynamically to avoid circular dependencies
      const { executeJobHandler } = await import("./job-handlers");
      const result = await executeJobHandler(job);
      this.updateJobStatus(job.id, "completed", undefined, result);
      console.log(`[${new Date().toISOString()}] Completed job: ${job.id}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] Job ${job.id} failed:`, errorMessage);
      this.updateJobStatus(job.id, "failed", errorMessage);
    }

    // Process next job
    setImmediate(() => this.processJobs());
  }

  /**
   * Get all jobs (for status API)
   */
  getAllJobs(limit: number = 100): Job[] {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<any>;
    
    return rows.map(row => ({
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
