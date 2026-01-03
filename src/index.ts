import { serve, file } from "bun";
import { startDownload, getPlaylistName } from "./downloader";
import { join } from "path";

const DOWNLOADS_ROOT = "/downloads";
const PORT = parseInt(process.env.PORT || "80", 10);

interface DownloadRequest {
  url: string;
  path?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
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

    // For playlists, use playlist name as default if no path provided
    let relativePath = body.path || "";
    
    // Detect playlist from URL or isPlaylist flag
    const isPlaylistRequest = body.isPlaylist || body.url.includes('list=') || body.url.includes('/playlist');
    
    if (isPlaylistRequest && !relativePath) {
      // Extract playlist ID from URL as immediate fallback
      const playlistIdMatch = body.url.match(/[?&]list=([^&]+)/);
      if (playlistIdMatch && playlistIdMatch[1]) {
        relativePath = `playlist-${playlistIdMatch[1]}`;
      } else {
        // If we can't extract playlist ID, return error
        return Response.json(
          { success: false, message: "Could not determine playlist ID. Please specify a folder name." },
          { status: 400 }
        );
      }
      
      // Try to get the actual playlist name (async, with timeout)
      // This will override the ID if successful
      try {
        const playlistName = await Promise.race([
          getPlaylistName(body.url),
          new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 3000)) // 3 second timeout
        ]);
        
        if (playlistName) {
          relativePath = playlistName;
        }
      } catch (error) {
        // If getting playlist name fails, use the ID fallback we already set
        // relativePath is already set to playlist ID, so we're good
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
