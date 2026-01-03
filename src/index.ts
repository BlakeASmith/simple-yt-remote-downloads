import { serve, file } from "bun";
import { startDownload, getPlaylistName, getChannelName } from "./downloader";
import { join } from "path";

const DOWNLOADS_ROOT = "/downloads";
const PORT = parseInt(process.env.PORT || "80", 10);

interface DownloadRequest {
  url: string;
  path?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
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
      }
    }

    // Resolve output path relative to downloads root
    const outputPath = join(DOWNLOADS_ROOT, relativePath);

    // Validate path doesn't escape downloads root
    if (!outputPath.startsWith(DOWNLOADS_ROOT)) {
      return Response.json(
        { success: false, message: "Invalid path: must be within downloads root" },
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

console.log(`YouTube Download Server running on port ${server.port}`);
console.log(`Downloads root: ${DOWNLOADS_ROOT}`);
