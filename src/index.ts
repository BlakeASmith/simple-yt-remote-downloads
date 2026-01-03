import { serve, file } from "bun";
import { startDownload, getPlaylistName, getChannelName } from "./downloader";
import { getScheduler } from "./scheduler";
import { getTracker } from "./tracker";
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
  
  // Fallback: extract identifier from URL
  const channelIdMatch = url.match(/(?:channel\/|@)([^\/\?]+)/);
  if (channelIdMatch?.[1]) {
    return `channel-${channelIdMatch[1]}`;
  }
  
  return `channel-${Date.now()}`;
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
    
    return playlistName || `playlist-${playlistId}`;
  } catch (error) {
    return `playlist-${playlistId}`;
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
        const { url, path, collectionId, audioOnly, resolution, isPlaylist, isChannel, maxVideos, intervalMinutes, includeThumbnail, includeTranscript, excludeShorts, useArchiveFile } = body;

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

        if (!name || !rootPath) {
          const response = Response.json(
            { success: false, message: "Missing required fields: name and rootPath" },
            { status: 400 }
          );
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }

        const collectionsManager = getCollectionsManager();
        const collection = collectionsManager.createCollection({
          name,
          rootPath: resolve(rootPath), // Resolve to absolute path
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
