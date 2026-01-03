import { serve, file } from "bun";
import { mkdirSync, existsSync, rmSync } from "fs";
import { startDownload, getPlaylistName, getChannelName, sanitizeFolderName } from "./downloader";
import { getScheduler } from "./scheduler";
import { getTracker, loadTrackerData, saveTrackerData } from "./tracker";
import { getCollectionsManager } from "./collections";
import { getDownloadStatusTracker } from "./download-status";
import { join, resolve } from "path";

const DOWNLOADS_ROOT = "/downloads";
const PORT = parseInt(process.env.PORT || "80", 10);

interface DownloadRequest {
  url: string;
  path?: string;
  collectionId?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
  includeThumbnail?: boolean;
  includeTranscript?: boolean;
  excludeShorts?: boolean;
  useArchiveFile?: boolean;
  concurrentFragments?: number;
}

/**
 * Get channel folder name with fallback
 */
async function resolveChannelPath(url: string): Promise<string> {
  try {
    const channelName = await Promise.race([
      getChannelName(url),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5000))
    ]);
    
    if (channelName) {
      return channelName;
    }
  } catch (error) {
    // Fall through to fallback
  }
  
  // Fallback: extract identifier from URL and format it nicely
  const channelIdMatch = url.match(/(?:channel\/|@)([^\/\?]+)/);
  if (channelIdMatch?.[1]) {
    const identifier = channelIdMatch[1];
    // If it's a channel ID (starts with UC), format as "Channel-UCxxxxx"
    if (identifier.startsWith('UC') && identifier.length === 24) {
      return sanitizeFolderName(`Channel-${identifier}`);
    }
    // If it's a handle (starts with @ or is a handle), format as "Channel-handlename"
    const handle = identifier.replace(/^@/, ''); // Remove @ if present
    return sanitizeFolderName(`Channel-${handle}`);
  }
  
  return sanitizeFolderName(`Channel-Unknown-${Date.now()}`);
}

/**
 * Get playlist folder name with fallback
 */
async function resolvePlaylistPath(url: string): Promise<string> {
  // Extract playlist ID from URL as immediate fallback
  const playlistIdMatch = url.match(/[?&]list=([^&]+)/);
  if (!playlistIdMatch?.[1]) {
    throw new Error("Could not determine playlist ID");
  }
  
  const playlistId = playlistIdMatch[1];
  
  // Try to get the actual playlist name (async, with timeout)
  try {
    const playlistName = await Promise.race([
      getPlaylistName(url),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 3000))
    ]);
    
    return playlistName || sanitizeFolderName(`Playlist-${playlistId}`);
  } catch (error) {
    return sanitizeFolderName(`Playlist-${playlistId}`);
  }
}

/**
 * Determine if URL is a playlist
 */
function isPlaylistUrl(url: string, isPlaylistFlag: boolean): boolean {
  return isPlaylistFlag || url.includes('list=') || url.includes('/playlist');
}

async function handleDownloadRequest(req: Request): Promise<Response> {
  try {
    const body: DownloadRequest = await req.json();

    if (!body.url) {
      return Response.json(
        { success: false, message: "Missing required field: url" },
        { status: 400 }
      );
    }

    // Get collection if specified
    let collectionRoot: string | null = null;
    if (body.collectionId) {
      const collectionsManager = getCollectionsManager();
      const collection = collectionsManager.getCollection(body.collectionId);
      if (!collection) {
        return Response.json(
          { success: false, message: "Collection not found" },
          { status: 400 }
        );
      }
      collectionRoot = collection.rootPath;
    }

    // Resolve download path
    let relativePath = body.path || "";
    
    if (!relativePath) {
      if (body.isChannel) {
        relativePath = await resolveChannelPath(body.url);
      } else if (isPlaylistUrl(body.url, body.isPlaylist || false)) {
        try {
          relativePath = await resolvePlaylistPath(body.url);
        } catch (error) {
          return Response.json(
            { success: false, message: "Could not determine playlist ID. Please specify a folder name." },
            { status: 400 }
          );
        }
      } else {
        // For single videos, group by channel name
        relativePath = await resolveChannelPath(body.url);
      }
    }

    // Resolve output path relative to collection root or downloads root
    const basePath = collectionRoot || DOWNLOADS_ROOT;
    const outputPath = join(basePath, relativePath);

    // Validate path doesn't escape base path
    const resolvedBasePath = resolve(basePath);
    const resolvedOutputPath = resolve(outputPath);
    if (!resolvedOutputPath.startsWith(resolvedBasePath)) {
      return Response.json(
        { success: false, message: "Invalid path: must be within base directory" },
        { status: 400 }
      );
    }

    const result = startDownload({
      url: body.url,
      outputPath,
      audioOnly: body.audioOnly || false,
      resolution: body.resolution || "1080",
      isPlaylist: body.isPlaylist || false,
      isChannel: body.isChannel || false,
      maxVideos: body.maxVideos,
      includeThumbnail: body.includeThumbnail,
      includeTranscript: body.includeTranscript,
      excludeShorts: body.excludeShorts,
      collectionId: body.collectionId,
      useArchiveFile: body.useArchiveFile,
      concurrentFragments: body.concurrentFragments,
    });

    return Response.json(result, { status: 202 });
  } catch (err) {
    console.error("Error handling download request:", err);
    return Response.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }
}

async function serveStaticFile(pathname: string): Promise<Response | null> {
  // Map routes to files
  // Use process.cwd() for compiled binaries - public folder is at /app/public/ in container
  const publicDir = join(process.cwd(), "public");
  let filePath: string;

  if (pathname === "/" || pathname === "/index.html") {
    filePath = join(publicDir, "index.html");
  } else if (pathname.startsWith("/public/")) {
    // Remove /public prefix and resolve relative to public directory
    const relativePath = pathname.slice("/public/".length);
    filePath = join(publicDir, relativePath);
  } else {
    return null;
  }

  try {
    const f = file(filePath);
    if (await f.exists()) {
      return new Response(f);
    }
  } catch {
    // File not found
  }

  return null;
}

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API routes
    if (pathname === "/api/download" && req.method === "POST") {
      const response = await handleDownloadRequest(req);
      // Add CORS headers to response
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Schedule management routes
    if (pathname === "/api/schedules" && req.method === "GET") {
      const scheduler = getScheduler();
      const schedules = scheduler.getAllSchedules();
      const response = Response.json({ success: true, schedules });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/schedules" && req.method === "POST") {
      try {
        const body = await req.json();
        const { url, path, collectionId, audioOnly, resolution, isPlaylist, isChannel, maxVideos, intervalMinutes, includeThumbnail, includeTranscript, excludeShorts, useArchiveFile, concurrentFragments } = body;

        if (!url || !intervalMinutes || intervalMinutes < 1) {
          const response = Response.json(
            { success: false, message: "Missing required fields: url and intervalMinutes (must be >= 1)" },
            { status: 400 }
          );
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }

        // Validate collection if specified
        if (collectionId) {
          const collectionsManager = getCollectionsManager();
          const collection = collectionsManager.getCollection(collectionId);
          if (!collection) {
            const response = Response.json(
              { success: false, message: "Collection not found" },
              { status: 400 }
            );
            Object.entries(corsHeaders).forEach(([key, value]) => {
              response.headers.set(key, value);
            });
            return response;
          }
        }

        // Resolve path if not provided
        let relativePath = path || "";
        if (!relativePath) {
          if (isChannel) {
            relativePath = await resolveChannelPath(url);
          } else if (isPlaylistUrl(url, isPlaylist || false)) {
            try {
              relativePath = await resolvePlaylistPath(url);
            } catch (error) {
              const response = Response.json(
                { success: false, message: "Could not determine playlist ID. Please specify a folder name." },
                { status: 400 }
              );
              Object.entries(corsHeaders).forEach(([key, value]) => {
                response.headers.set(key, value);
              });
              return response;
            }
          } else {
            // For single videos, group by channel name
            relativePath = await resolveChannelPath(url);
          }
        }

        const scheduler = getScheduler();
        const schedule = scheduler.createSchedule({
          url,
          path: relativePath,
          collectionId,
          audioOnly: audioOnly || false,
          resolution: resolution || "1080",
          isPlaylist: isPlaylist || false,
          isChannel: isChannel || false,
          maxVideos,
          intervalMinutes,
          enabled: true,
          includeThumbnail,
          includeTranscript,
          excludeShorts,
          useArchiveFile,
          concurrentFragments,
        });

        const response = Response.json({ success: true, schedule });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err) {
        console.error("Error creating schedule:", err);
        const response = Response.json(
          { success: false, message: "Invalid request body" },
          { status: 400 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Update schedule: PUT /api/schedules/:id
    const scheduleUpdateMatch = pathname.match(/^\/api\/schedules\/([^\/]+)$/);
    if (scheduleUpdateMatch && req.method === "PUT") {
      try {
        const scheduleId = scheduleUpdateMatch[1];
        const body = await req.json();
        const scheduler = getScheduler();
        const updated = scheduler.updateSchedule(scheduleId, body);

        if (!updated) {
          const response = Response.json(
            { success: false, message: "Schedule not found" },
            { status: 404 }
          );
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }

        const response = Response.json({ success: true, schedule: updated });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err) {
        console.error("Error updating schedule:", err);
        const response = Response.json(
          { success: false, message: "Invalid request body" },
          { status: 400 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Delete schedule: DELETE /api/schedules/:id
    const scheduleDeleteMatch = pathname.match(/^\/api\/schedules\/([^\/]+)$/);
    if (scheduleDeleteMatch && req.method === "DELETE") {
      const scheduleId = scheduleDeleteMatch[1];
      const scheduler = getScheduler();
      const deleted = scheduler.deleteSchedule(scheduleId);

      if (!deleted) {
        const response = Response.json(
          { success: false, message: "Schedule not found" },
          { status: 404 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      const response = Response.json({ success: true, message: "Schedule deleted" });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Tracker API routes
    if (pathname === "/api/tracker/videos" && req.method === "GET") {
      const tracker = getTracker();
      const videos = tracker.getAllVideos();
      const response = Response.json({ success: true, videos });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/tracker/channels" && req.method === "GET") {
      const tracker = getTracker();
      const channels = tracker.getAllChannels();
      const response = Response.json({ success: true, channels });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/tracker/playlists" && req.method === "GET") {
      const tracker = getTracker();
      const playlists = tracker.getAllPlaylists();
      const response = Response.json({ success: true, playlists });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/tracker/stats" && req.method === "GET") {
      const tracker = getTracker();
      const stats = tracker.getStats();
      const response = Response.json({ success: true, stats });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/tracker/all" && req.method === "GET") {
      const tracker = getTracker();
      const videos = tracker.getAllVideos();
      const channels = tracker.getAllChannels();
      const playlists = tracker.getAllPlaylists();
      const stats = tracker.getStats();
      const response = Response.json({
        success: true,
        videos,
        channels,
        playlists,
        stats,
      });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Download status API route
    if (pathname === "/api/downloads/status" && req.method === "GET") {
      const statusTracker = getDownloadStatusTracker();
      const activeDownloads = statusTracker.getActiveDownloads();
      const response = Response.json({
        success: true,
        downloads: activeDownloads,
      });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Download logs API route: GET /api/downloads/logs/:id
    const downloadLogsMatch = pathname.match(/^\/api\/downloads\/logs\/([^\/]+)$/);
    if (downloadLogsMatch && req.method === "GET") {
      const id = downloadLogsMatch[1];
      const statusTracker = getDownloadStatusTracker();
      const r = statusTracker.readLog(id);
      const response = r.ok
        ? Response.json({ success: true, log: r.log })
        : Response.json({ success: false, message: r.message }, { status: 404 });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Find logs by video ID: GET /api/downloads/logs/by-video/:videoId
    const logsByVideoMatch = pathname.match(/^\/api\/downloads\/logs\/by-video\/([^\/]+)$/);
    if (logsByVideoMatch && req.method === "GET") {
      const videoId = logsByVideoMatch[1];
      const statusTracker = getDownloadStatusTracker();
      const matchingIds = statusTracker.findLogsByVideoId(videoId);
      const response = Response.json({ success: true, downloadIds: matchingIds });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Collections API routes
    if (pathname === "/api/collections" && req.method === "GET") {
      const collectionsManager = getCollectionsManager();
      const collections = collectionsManager.getAllCollections();
      const response = Response.json({ success: true, collections });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (pathname === "/api/collections" && req.method === "POST") {
      try {
        const body = await req.json();
        const { name, rootPath } = body;

        if (!name) {
          const response = Response.json(
            { success: false, message: "Missing required field: name" },
            { status: 400 }
          );
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }

        const collectionsManager = getCollectionsManager();
        const resolvedRootPath = resolve(
          rootPath && String(rootPath).trim()
            ? String(rootPath).trim()
            : join(DOWNLOADS_ROOT, sanitizeFolderName(String(name)))
        );

        // Ensure collection directory exists (best-effort)
        try {
          mkdirSync(resolvedRootPath, { recursive: true });
        } catch (error) {
          console.warn(`[${new Date().toISOString()}] Failed to create collection directory:`, error);
        }

        const collection = collectionsManager.createCollection({
          name,
          rootPath: resolvedRootPath,
        });

        const response = Response.json({ success: true, collection });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err) {
        console.error("Error creating collection:", err);
        const response = Response.json(
          { success: false, message: "Invalid request body" },
          { status: 400 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Update collection: PUT /api/collections/:id
    const collectionUpdateMatch = pathname.match(/^\/api\/collections\/([^\/]+)$/);
    if (collectionUpdateMatch && req.method === "PUT") {
      try {
        const collectionId = collectionUpdateMatch[1];
        const body = await req.json();
        const collectionsManager = getCollectionsManager();
        
        // Resolve rootPath if provided
        if (body.rootPath) {
          body.rootPath = resolve(body.rootPath);
        }
        
        const updated = collectionsManager.updateCollection(collectionId, body);

        if (!updated) {
          const response = Response.json(
            { success: false, message: "Collection not found" },
            { status: 404 }
          );
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }

        const response = Response.json({ success: true, collection: updated });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err) {
        console.error("Error updating collection:", err);
        const response = Response.json(
          { success: false, message: "Invalid request body" },
          { status: 400 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Delete collection: DELETE /api/collections/:id
    const collectionDeleteMatch = pathname.match(/^\/api\/collections\/([^\/]+)$/);
    if (collectionDeleteMatch && req.method === "DELETE") {
      const collectionId = collectionDeleteMatch[1];
      const collectionsManager = getCollectionsManager();
      const deleted = collectionsManager.deleteCollection(collectionId);

      if (!deleted) {
        const response = Response.json(
          { success: false, message: "Collection not found" },
          { status: 404 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      const response = Response.json({ success: true, message: "Collection deleted" });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Developer test API routes
    if (pathname === "/api/dev/test" && req.method === "POST") {
      try {
        const body = await req.json();
        const { concurrentFragments, resolution } = body;
        
        const collectionsManager = getCollectionsManager();
        const tracker = getTracker();
        
        // Create test collection
        const testCollectionName = "dev-test-collection";
        const testCollectionRootPath = join(DOWNLOADS_ROOT, testCollectionName);
        
        // Check if test collection already exists
        const existingCollections = collectionsManager.getAllCollections();
        let testCollection = existingCollections.find(c => c.name === testCollectionName);
        
        if (!testCollection) {
          testCollection = collectionsManager.createCollection({
            name: testCollectionName,
            rootPath: testCollectionRootPath,
          });
        }
        
        // Test videos: short, reliable YouTube videos
        const testVideos = [
          "jNQXAC9IVRw", // "Me at the zoo" - very short, reliable
          "dQw4w9WgXcQ", // Rick Roll - well-known, reliable
        ];
        
        const downloadResults: Array<{ videoId: string; url: string; success: boolean; message?: string }> = [];
        
        // Download each test video
        for (const videoId of testVideos) {
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          try {
            const result = startDownload({
              url: videoUrl,
              outputPath: testCollectionRootPath,
              audioOnly: false,
              resolution: resolution || "720", // Use provided resolution or default to 720p
              isPlaylist: false,
              isChannel: false,
              includeThumbnail: true,
              includeTranscript: false, // Skip transcript for faster downloads
              excludeShorts: false,
              useArchiveFile: false, // Allow re-downloads for testing
              concurrentFragments: concurrentFragments || 4, // Use provided concurrent fragments or default to 4
            });
            
            downloadResults.push({
              videoId,
              url: videoUrl,
              success: result.success,
              message: result.message,
            });
          } catch (error: any) {
            downloadResults.push({
              videoId,
              url: videoUrl,
              success: false,
              message: error?.message || "Unknown error",
            });
          }
        }
        
        const response = Response.json({
          success: true,
          collection: testCollection,
          downloads: downloadResults,
          message: `Test collection created and ${downloadResults.filter(r => r.success).length} downloads started`,
        });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err: any) {
        console.error("Error running dev test:", err);
        const response = Response.json(
          { success: false, message: err?.message || "Failed to run test" },
          { status: 500 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    if (pathname === "/api/dev/cleanup" && req.method === "POST") {
      try {
        const collectionsManager = getCollectionsManager();
        const tracker = getTracker();
        
        const testCollectionName = "dev-test-collection";
        const testCollectionRootPath = join(DOWNLOADS_ROOT, testCollectionName);
        
        // Find test collection
        const existingCollections = collectionsManager.getAllCollections();
        const testCollection = existingCollections.find(c => c.name === testCollectionName);
        
        let deletedCollection = false;
        let deletedFiles = 0;
        let deletedTrackedVideos = 0;
        
        if (testCollection) {
          // Delete tracked videos from this collection
          const allVideos = tracker.getAllVideos();
          const testVideos = allVideos.filter(v => v.relativePath.includes(testCollectionName) || v.fullPath.startsWith(testCollectionRootPath));
          
          for (const video of testVideos) {
            // Remove from tracker data
            const trackerData = loadTrackerData();
            const videoIndex = trackerData.videos.findIndex(
              v => v.id === video.id && (v.relativePath === video.relativePath || v.fullPath === video.fullPath)
            );
            if (videoIndex >= 0) {
              trackerData.videos.splice(videoIndex, 1);
              deletedTrackedVideos++;
            }
            
            // Delete associated files
            if (video.files) {
              for (const file of video.files) {
                try {
                  if (existsSync(file.path)) {
                    rmSync(file.path, { force: true });
                    deletedFiles++;
                  }
                } catch (error) {
                  // Ignore errors deleting individual files
                }
              }
            }
          }
          
          // Save updated tracker data
          if (deletedTrackedVideos > 0) {
            saveTrackerData(trackerData);
          }
          
          // Delete collection directory and all contents
          try {
            if (existsSync(testCollectionRootPath)) {
              rmSync(testCollectionRootPath, { recursive: true, force: true });
              deletedFiles += 10; // Approximate count
            }
          } catch (error) {
            console.error("Error deleting collection directory:", error);
          }
          
          // Delete collection from collections manager
          collectionsManager.deleteCollection(testCollection.id);
          deletedCollection = true;
        }
        
        const response = Response.json({
          success: true,
          message: `Cleanup completed: ${deletedCollection ? "collection deleted" : "no collection found"}, ${deletedFiles} files removed, ${deletedTrackedVideos} tracked videos removed`,
          deletedCollection,
          deletedFiles,
          deletedTrackedVideos,
        });
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      } catch (err: any) {
        console.error("Error running dev cleanup:", err);
        const response = Response.json(
          { success: false, message: err?.message || "Failed to cleanup" },
          { status: 500 }
        );
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Static files
    const staticResponse = await serveStaticFile(pathname);
    if (staticResponse) {
      return staticResponse;
    }

    // 404 for unknown routes
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
});

// Initialize scheduler (loads schedules from disk)
getScheduler();

console.log(`YouTube Download Server running on port ${server.port}`);
console.log(`Downloads root: ${DOWNLOADS_ROOT}`);
