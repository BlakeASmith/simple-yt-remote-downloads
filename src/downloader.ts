import { spawn } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const ARCHIVE_FILE = "/downloads/.archive";

export interface DownloadOptions {
  url: string;
  outputPath: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
}

export interface DownloadResult {
  success: boolean;
  message: string;
}

/**
 * Get playlist name from URL using yt-dlp
 */
export async function getPlaylistName(url: string): Promise<string | null> {
  try {
    console.log(`[${new Date().toISOString()}] Attempting to get playlist name from: ${url}`);
    // Use yt-dlp to extract playlist title
    const proc = Bun.spawn({
      cmd: ["yt-dlp", url, "--print", "%(playlist_title)s", "--flat-playlist", "--no-warnings"],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout as text
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    
    const playlistName = output.trim();
    
    if (exitCode !== 0) {
      console.error(`[${new Date().toISOString()}] yt-dlp exited with code ${exitCode} when getting playlist name`);
      const stderr = await new Response(proc.stderr).text();
      console.error(`[${new Date().toISOString()}] stderr: ${stderr}`);
      return null;
    }

    if (playlistName && playlistName.length > 0 && !playlistName.includes("NA") && playlistName !== "N/A" && !playlistName.includes("ERROR")) {
      // Sanitize the playlist name for filesystem use
      const sanitized = sanitizeFolderName(playlistName);
      console.log(`[${new Date().toISOString()}] Extracted playlist name: "${playlistName}" -> "${sanitized}"`);
      return sanitized;
    }
    
    console.log(`[${new Date().toISOString()}] Could not extract playlist name from output: "${playlistName}"`);
    return null;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error getting playlist name:`, error);
    return null;
  }
}

/**
 * Sanitize a string to be safe for use as a folder name
 */
function sanitizeFolderName(name: string): string {
  // Remove or replace invalid filesystem characters
  return name
    .replace(/[<>:"/\\|?*]/g, "") // Remove invalid chars
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .substring(0, 200); // Limit length
}

/**
 * Build yt-dlp arguments based on download options
 */
function buildYtDlpArgs(options: DownloadOptions): string[] {
  const { url, outputPath, audioOnly, resolution, isPlaylist } = options;

  // Ensure output path is normalized (no trailing slash)
  // For playlists, all videos go directly to this folder without subdirectories
  const normalizedPath = outputPath.replace(/\/$/, "");
  const outputTemplate = join(normalizedPath, "%(title)s [%(id)s].%(ext)s");

  const args: string[] = [
    url,
    "--output",
    outputTemplate,
    "--download-archive",
    ARCHIVE_FILE,
    "--write-thumbnail",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--embed-thumbnail",
    "--restrict-filenames",
  ];

  // Use --yes-playlist for playlists, --no-playlist for single videos
  if (isPlaylist) {
    args.push("--yes-playlist");
    // Ensure all playlist videos go directly to outputPath without creating subdirectories
    // The output template already specifies the exact path, so videos should go there directly
  } else {
    args.push("--no-playlist");
  }

  if (audioOnly) {
    args.push(
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0"
    );
  } else {
    const formatStr =
      resolution === "720"
        ? "bestvideo[height<=720]+bestaudio/best[height<=720]"
        : "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
    args.push(
      "--format",
      formatStr,
      "--embed-subs",
      "--merge-output-format",
      "mkv"
    );
  }

  return args;
}

/**
 * Start a download in the background (fire and forget)
 */
export function startDownload(options: DownloadOptions): DownloadResult {
  console.log(`[${new Date().toISOString()}] startDownload called with outputPath: "${options.outputPath}"`);
  
  // Ensure output directory exists
  if (!existsSync(options.outputPath)) {
    mkdirSync(options.outputPath, { recursive: true });
  }

  const args = buildYtDlpArgs(options);

  console.log(`[${new Date().toISOString()}] Starting download: ${options.url}`);
  console.log(`[${new Date().toISOString()}] Command: yt-dlp ${args.join(" ")}`);

  // Fire and forget - spawn process without awaiting
  spawn({
    cmd: ["yt-dlp", ...args],
    stdout: "inherit",
    stderr: "inherit",
  });

  return {
    success: true,
    message: "Download started",
  };
}
