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
  isChannel?: boolean;
  maxVideos?: number;
}

export interface DownloadResult {
  success: boolean;
  message: string;
}

/**
 * Extract channel ID from various YouTube channel URL formats
 */
export function extractChannelId(input: string): string | null {
  if (!input) return null;
  
  // If it's already a channel ID (starts with UC)
  if (/^UC[\w-]{22}$/.test(input)) {
    return input;
  }
  
  // Try to extract from URL
  try {
    const url = new URL(input);
    
    // Format: youtube.com/channel/UCxxxxx
    const channelMatch = url.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (channelMatch) {
      return channelMatch[1];
    }
    
    // Format: youtube.com/c/ChannelName or youtube.com/@ChannelName
    // For these, we'll need to resolve them via yt-dlp
    if (url.pathname.match(/^\/(c|user|@)\//)) {
      return input; // Return the full URL for yt-dlp to resolve
    }
  } catch {
    // Not a valid URL, might be a channel ID or handle
    if (input.startsWith('@')) {
      return `https://www.youtube.com/${input}`;
    }
    // Try as channel ID
    if (/^UC[\w-]{22}$/.test(input)) {
      return input;
    }
  }
  
  return null;
}

/**
 * Get channel name from URL or channel ID using yt-dlp
 */
export async function getChannelName(channelInput: string): Promise<string | null> {
  try {
    console.log(`[${new Date().toISOString()}] Attempting to get channel name from: ${channelInput}`);
    
    // Build channel URL if we have a channel ID
    let channelUrl = channelInput;
    if (channelInput.startsWith('UC') && !channelInput.includes('youtube.com')) {
      channelUrl = `https://www.youtube.com/channel/${channelInput}`;
    } else if (!channelInput.startsWith('http')) {
      // Assume it's a handle or channel name
      if (channelInput.startsWith('@')) {
        channelUrl = `https://www.youtube.com/${channelInput}`;
      } else {
        channelUrl = `https://www.youtube.com/@${channelInput}`;
      }
    }
    
    // Use yt-dlp to extract channel name
    const proc = Bun.spawn({
      cmd: ["yt-dlp", channelUrl, "--print", "%(channel)s", "--flat-playlist", "--no-warnings", "--playlist-end", "1"],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout as text
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    
    const channelName = output.trim();
    
    if (exitCode !== 0) {
      console.error(`[${new Date().toISOString()}] yt-dlp exited with code ${exitCode} when getting channel name`);
      const stderr = await new Response(proc.stderr).text();
      console.error(`[${new Date().toISOString()}] stderr: ${stderr}`);
      return null;
    }

    if (channelName && channelName.length > 0 && !channelName.includes("NA") && channelName !== "N/A" && !channelName.includes("ERROR")) {
      // Sanitize the channel name for filesystem use
      const sanitized = sanitizeFolderName(channelName);
      console.log(`[${new Date().toISOString()}] Extracted channel name: "${channelName}" -> "${sanitized}"`);
      return sanitized;
    }
    
    console.log(`[${new Date().toISOString()}] Could not extract channel name from output: "${channelName}"`);
    return null;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error getting channel name:`, error);
    return null;
  }
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
  const { url, outputPath, audioOnly, resolution, isPlaylist, isChannel, maxVideos } = options;

  // Ensure output path is normalized (no trailing slash)
  // For playlists and channels, all videos go directly to this folder without subdirectories
  const normalizedPath = outputPath.replace(/\/$/, "");
  const outputTemplate = join(normalizedPath, "%(title)s [%(id)s].%(ext)s");

  // Build channel URL if needed
  let finalUrl = url;
  if (isChannel) {
    // If already a full URL, use it as-is
    if (url.startsWith('http')) {
      finalUrl = url;
    } else {
      // Extract channel ID or handle
      const channelId = extractChannelId(url);
      if (channelId) {
        // If extractChannelId returned a full URL, use it
        if (channelId.startsWith('http')) {
          finalUrl = channelId;
        } else if (channelId.startsWith('UC')) {
          // It's a channel ID
          finalUrl = `https://www.youtube.com/channel/${channelId}`;
        } else {
          // It's a handle or something else, use original logic
          if (url.startsWith('@')) {
            finalUrl = `https://www.youtube.com/${url}`;
          } else {
            finalUrl = `https://www.youtube.com/@${url}`;
          }
        }
      } else {
        // Fallback: assume it's a handle
        if (url.startsWith('@')) {
          finalUrl = `https://www.youtube.com/${url}`;
        } else {
          finalUrl = `https://www.youtube.com/@${url}`;
        }
      }
    }
  }

  const args: string[] = [
    finalUrl,
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

  // For channels, limit the number of videos
  if (isChannel && maxVideos && maxVideos > 0) {
    args.push("--playlist-end", maxVideos.toString());
  }

  // Use --yes-playlist for playlists and channels, --no-playlist for single videos
  if (isPlaylist || isChannel) {
    args.push("--yes-playlist");
    // Ensure all videos go directly to outputPath without creating subdirectories
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
