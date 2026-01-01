import { serve, file } from "bun";
import { startDownload, getActiveDownloads } from "./downloader";
import { join } from "path";

const DOWNLOADS_ROOT = "/downloads";
const PORT = parseInt(process.env.PORT || "80", 10);

interface DownloadRequest {
  url: string;
  path?: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
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

    // Resolve output path relative to downloads root
    const relativePath = body.path || "";
    const outputPath = join(DOWNLOADS_ROOT, relativePath);

    // Validate path doesn't escape downloads root
    if (!outputPath.startsWith(DOWNLOADS_ROOT)) {
      return Response.json(
        { success: false, message: "Invalid path: must be within downloads root" },
        { status: 400 }
      );
    }

    const result = await startDownload({
      url: body.url,
      outputPath,
      audioOnly: body.audioOnly || false,
      resolution: body.resolution || "1080",
    });

    return Response.json(result, {
      status: result.success ? 202 : 409,
    });
  } catch (err) {
    console.error("Error handling download request:", err);
    return Response.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }
}

async function handleStatusRequest(): Promise<Response> {
  const activeDownloads = getActiveDownloads();
  return Response.json({
    status: "ok",
    activeDownloads,
    downloadsRoot: DOWNLOADS_ROOT,
  });
}

async function serveStaticFile(pathname: string): Promise<Response | null> {
  // Map routes to files
  let filePath: string;

  if (pathname === "/" || pathname === "/index.html") {
    filePath = join(import.meta.dir, "../public/index.html");
  } else if (pathname.startsWith("/public/")) {
    filePath = join(import.meta.dir, "..", pathname);
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

    if (pathname === "/api/status" && req.method === "GET") {
      const response = await handleStatusRequest();
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
