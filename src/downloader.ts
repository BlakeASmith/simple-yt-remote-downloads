import { spawn } from "bun";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

export interface DownloadOptions {
  url: string;
  outputPath: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
}

export interface DownloadResult {
  success: boolean;
  videoId: string;
  message: string;
}

// Track active downloads to prevent duplicates
const activeDownloads = new Set<string>();

/**
 * Extract video ID from various YouTube URL formats
 */
export function extractVideoId(input: string): string | null {
  // Already a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  // Various YouTube URL patterns
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Check if a video has already been downloaded by looking for existing files
 */
function isAlreadyDownloaded(outputPath: string, videoId: string): boolean {
  if (!existsSync(outputPath)) {
    return false;
  }

  const files = readdirSync(outputPath);
  // Check if any file contains the video ID in its name
  return files.some((file) => file.includes(videoId));
}

/**
 * Build yt-dlp arguments based on download options
 */
function buildYtDlpArgs(options: DownloadOptions, videoId: string): string[] {
  const { url, outputPath, audioOnly, resolution } = options;

  const args: string[] = [
    url,
    "--output",
    join(outputPath, "%(title)s [%(id)s].%(ext)s"),
    "--write-thumbnail",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--embed-subs",
    "--embed-thumbnail",
    "--merge-output-format",
    "mkv",
    "--no-playlist",
    "--restrict-filenames",
  ];

  if (audioOnly) {
    args.push(
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0"
    );
    // Remove embed-subs and merge-output-format for audio
    const embedSubsIdx = args.indexOf("--embed-subs");
    if (embedSubsIdx !== -1) args.splice(embedSubsIdx, 1);
    const mergeIdx = args.indexOf("--merge-output-format");
    if (mergeIdx !== -1) args.splice(mergeIdx, 2);
  } else {
    // Video format selection based on resolution
    const formatStr =
      resolution === "720"
        ? "bestvideo[height<=720]+bestaudio/best[height<=720]"
        : "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
    args.push("--format", formatStr);
  }

  return args;
}

/**
 * Start a download in the background (fire and forget)
 */
export async function startDownload(
  options: DownloadOptions
): Promise<DownloadResult> {
  const videoId = extractVideoId(options.url);

  if (!videoId) {
    return {
      success: false,
      videoId: "",
      message: "Invalid YouTube URL or video ID",
    };
  }

  // Check if already downloading
  if (activeDownloads.has(videoId)) {
    return {
      success: false,
      videoId,
      message: "Download already in progress for this video",
    };
  }

  // Ensure output directory exists
  const outputPath = options.outputPath || "/downloads";
  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  // Check if already downloaded
  if (isAlreadyDownloaded(outputPath, videoId)) {
    return {
      success: false,
      videoId,
      message: "Video has already been downloaded",
    };
  }

  // Mark as active
  activeDownloads.add(videoId);

  const args = buildYtDlpArgs({ ...options, outputPath }, videoId);

  console.log(`[${new Date().toISOString()}] Starting download: ${videoId}`);
  console.log(`[${new Date().toISOString()}] Command: yt-dlp ${args.join(" ")}`);

  // Fire and forget - spawn process without awaiting
  const proc = spawn({
    cmd: ["yt-dlp", ...args],
    stdout: "inherit",
    stderr: "inherit",
  });

  // Handle completion in background
  proc.exited
    .then((exitCode) => {
      activeDownloads.delete(videoId);
      if (exitCode === 0) {
        console.log(
          `[${new Date().toISOString()}] Download completed: ${videoId}`
        );
      } else {
        console.error(
          `[${new Date().toISOString()}] Download failed: ${videoId} (exit code: ${exitCode})`
        );
      }
    })
    .catch((err) => {
      activeDownloads.delete(videoId);
      console.error(
        `[${new Date().toISOString()}] Download error: ${videoId}`,
        err
      );
    });

  return {
    success: true,
    videoId,
    message: "Download started",
  };
}

/**
 * Get list of currently active downloads
 */
export function getActiveDownloads(): string[] {
  return Array.from(activeDownloads);
}
