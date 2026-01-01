import { spawn } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const ARCHIVE_FILE = "/downloads/.archive";

export interface DownloadOptions {
  url: string;
  outputPath: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
}

export interface DownloadResult {
  success: boolean;
  message: string;
}

/**
 * Build yt-dlp arguments based on download options
 */
function buildYtDlpArgs(options: DownloadOptions): string[] {
  const { url, outputPath, audioOnly, resolution } = options;

  const args: string[] = [
    url,
    "--output",
    join(outputPath, "%(title)s [%(id)s].%(ext)s"),
    "--download-archive",
    ARCHIVE_FILE,
    "--write-thumbnail",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--embed-thumbnail",
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
  const outputPath = options.outputPath || "/downloads";
  
  // Ensure output directory exists
  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  const args = buildYtDlpArgs({ ...options, outputPath });

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
