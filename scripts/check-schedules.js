#!/usr/bin/env bun

/**
 * Script to check schedules and trigger downloads via API
 * This script is run by cron
 */

import { existsSync } from "fs";
import { SCHEDULES_FILE, loadSchedules, saveSchedules, calculateNextRun } from "./src/scheduler.ts";

const API_URL = "http://localhost:80/api/download";

async function checkAndTriggerSchedules() {
  // Check if schedules file exists
  if (!existsSync(SCHEDULES_FILE)) {
    return;
  }

  try {
    const schedules = loadSchedules();
    const now = Date.now();
    let updated = false;

    for (const schedule of schedules) {
      // Skip disabled schedules
      if (!schedule.enabled) {
        continue;
      }

      // Check if schedule is due to run
      if (schedule.nextRun <= now) {
        console.log(`[${new Date().toISOString()}] Triggering download for schedule: ${schedule.id}`);

        // Build payload
        const payload: any = {
          url: schedule.url,
          audioOnly: schedule.audioOnly || false,
          resolution: schedule.resolution || "1080",
          isPlaylist: schedule.isPlaylist || false,
          isChannel: schedule.isChannel || false,
        };

        if (schedule.path) {
          payload.path = schedule.path;
        }

        if (schedule.collectionId) {
          payload.collectionId = schedule.collectionId;
        }

        if (schedule.maxVideos) {
          payload.maxVideos = schedule.maxVideos;
        }

        if (schedule.includeThumbnail !== undefined) {
          payload.includeThumbnail = schedule.includeThumbnail;
        }

        if (schedule.includeTranscript !== undefined) {
          payload.includeTranscript = schedule.includeTranscript;
        }

        if (schedule.excludeShorts !== undefined) {
          payload.excludeShorts = schedule.excludeShorts;
        }

        if (schedule.useArchiveFile !== undefined) {
          payload.useArchiveFile = schedule.useArchiveFile;
        }

        // Trigger download via API
        try {
          const response = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          const result = await response.json();

          if (result.success) {
            console.log(`[${new Date().toISOString()}] Download triggered successfully for schedule: ${schedule.id}`);

            // Update schedule timestamps
            schedule.lastRun = now;
            schedule.nextRun = calculateNextRun(schedule.intervalMinutes);
            updated = true;
          } else {
            console.error(`[${new Date().toISOString()}] Failed to trigger download for schedule ${schedule.id}: ${result.message || "Unknown error"}`);
          }
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error triggering download for schedule ${schedule.id}:`, error);
        }
      }
    }

    // Save updated schedules if any were modified
    if (updated) {
      saveSchedules(schedules);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error checking schedules:`, error);
    process.exit(1);
  }
}

// Run the check
checkAndTriggerSchedules().catch((error) => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, error);
  process.exit(1);
});
