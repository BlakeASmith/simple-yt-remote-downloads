import { spawn } from "bun";
import { existsSync, mkdirSync, statSync } from "fs";
import { join, relative } from "path";
import { getTracker } from "./tracker";
import { getDownloadStatusTracker } from "./download-status";

const ARCHIVE_FILE = "/downloads/.archive";
const DOWNLOADS_ROOT = "/downloads";

export interface DownloadOptions {
  url: string;
  outputPath: string;
  audioOnly?: boolean;
  resolution?: "1080" | "720";
  isPlaylist?: boolean;
  isChannel?: boolean;
  maxVideos?: number;
  includeThumbnail?: boolean;
  includeTranscript?: boolean;
  excludeShorts?: boolean;
  collectionId?: string;
  useArchiveFile?: boolean; // If false, download without archive file (allows multiple versions)
}

export interface DownloadResult {
  success: boolean;
  message: string;
}

/**
 * Extract channel ID from various YouTube channel URL formats
 * Returns channel ID if found, or null if not a channel format
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
    const pathname = url.pathname;
    
    // Format: youtube.com/channel/UCxxxxx
    const channelMatch = pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (channelMatch?.[1]) {
      return channelMatch[1];
    }
    
    // Format: youtube.com/c/ChannelName or youtube.com/@ChannelName
    // Return full URL for yt-dlp to resolve
    if (pathname.match(/^\/(c|user|@)\//)) {
      return input;
    }
  } catch {
    // Not a valid URL, might be a handle
    if (input.startsWith('@')) {
      return `https://www.youtube.com/${input}`;
    }
  }
  
  return null;
}

/**
 * Build channel URL from various input formats
 */
function buildChannelUrl(input: string): string {
  // Already a full URL
  if (input.startsWith('http')) {
    return input;
  }
  
  // Channel ID (UCxxxxx)
  if (input.startsWith('UC') && input.length === 24) {
    return `https://www.youtube.com/channel/${input}`;
  }
  
  // Handle format (@channelname)
  if (input.startsWith('@')) {
    return `https://www.youtube.com/${input}`;
  }
  
  // Assume it's a handle without @
  return `https://www.youtube.com/@${input}`;
}

/**
 * Check if URL is a video URL (not a channel or playlist URL)
 */
function isVideoUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Video URLs contain /watch, /live, /shorts, or /embed
    return /^\/(watch|live|shorts|embed)\//.test(pathname) || 
           pathname === '/watch' || 
           pathname.startsWith('/live/') ||
           pathname.startsWith('/shorts/');
  } catch {
    return false;
  }
}

/**
 * Get channel name from URL or channel ID using yt-dlp
 * Works with both channel URLs and video URLs
 */
export async function getChannelName(channelInput: string): Promise<string | null> {
  try {
    console.log(`[${new Date().toISOString()}] Attempting to get channel name from: ${channelInput}`);
    
    const channelUrl = buildChannelUrl(channelInput);
    const isVideo = isVideoUrl(channelUrl);
    
    // Build yt-dlp command - use --no-playlist for videos, --flat-playlist for channels
    const cmd = ["yt-dlp", channelUrl, "--print", "%(channel)s", "--no-warnings"];
    if (isVideo) {
      cmd.push("--no-playlist");
    } else {
      cmd.push("--flat-playlist", "--playlist-end", "1");
    }
    
    // Use yt-dlp to extract channel name
    const proc = Bun.spawn({
      cmd,
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
 * Extract video ID from YouTube URL
 */
function extractVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const videoId = urlObj.searchParams.get("v") || urlObj.pathname.split("/").pop();
    if (videoId && videoId.length === 11) {
      return videoId;
    }
  } catch {
    // Try regex fallback
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract playlist ID from URL
 */
function extractPlaylistId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get("list");
  } catch {
    const match = url.match(/[?&]list=([^&]+)/);
    return match?.[1] || null;
  }
}

/**
 * Extract video metadata using yt-dlp JSON output
 */
async function extractVideoMetadata(url: string): Promise<{
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  duration?: number;
  playlistId?: string;
  playlistTitle?: string;
} | null> {
  try {
    const proc = Bun.spawn({
      cmd: [
        "yt-dlp",
        url,
        "--dump-json",
        "--no-warnings",
        "--no-playlist", // Get info for single video
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return null;
    }

    const data = JSON.parse(output.trim());
    return {
      id: data.id || "",
      title: data.title || "",
      channel: data.channel || data.uploader || "",
      channelId: data.channel_id || data.channel_url?.split("/").pop(),
      duration: data.duration || undefined,
      playlistId: data.playlist_id || undefined,
      playlistTitle: data.playlist_title || data.playlist || undefined,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error extracting video metadata:`, error);
    return null;
  }
}

/**
 * Get playlist/channel video IDs using flat playlist
 */
async function getPlaylistVideoIds(url: string, maxVideos?: number): Promise<string[]> {
  try {
    const cmd = [
      "yt-dlp",
      url,
      "--flat-playlist",
      "--print", "%(id)s",
      "--no-warnings",
    ];
    
    if (maxVideos) {
      cmd.push("--playlist-end", maxVideos.toString());
    }

    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return [];
    }

    return output.trim().split("\n").filter(id => id.trim().length === 11);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error getting playlist video IDs:`, error);
    return [];
  }
}

/**
 * Generate archive file path based on collection and format
 * Returns null if archive file should not be used
 */
function getArchiveFilePath(options: DownloadOptions): string | null {
  // If useArchiveFile is explicitly false, don't use archive file
  // Default to true if not specified (backward compatibility)
  if (options.useArchiveFile === false) {
    return null;
  }

  // Determine format suffix: audio or video
  const formatSuffix = options.audioOnly ? "audio" : "video";

  // If collection ID is provided, use collection-specific archive file
  if (options.collectionId) {
    return `/downloads/.archive-${options.collectionId}-${formatSuffix}`;
  }

  // Default archive file (for non-collection downloads)
  return `/downloads/.archive-${formatSuffix}`;
}

/**
 * Build yt-dlp arguments based on download options
 */
function buildYtDlpArgs(options: DownloadOptions): string[] {
  const { url, outputPath, audioOnly, resolution, isPlaylist, isChannel, maxVideos, includeThumbnail, includeTranscript, excludeShorts } = options;

  // Set defaults: video includes thumbnail and transcript, audio only does not
  const shouldIncludeThumbnail = includeThumbnail !== undefined 
    ? includeThumbnail 
    : !audioOnly;
  const shouldIncludeTranscript = includeTranscript !== undefined 
    ? includeTranscript 
    : !audioOnly;

  // Ensure output path is normalized (no trailing slash)
  // For playlists and channels, all videos go directly to this folder without subdirectories
  const normalizedPath = outputPath.replace(/\/$/, "");
  const outputTemplate = join(normalizedPath, "%(title)s [%(id)s].%(ext)s");

  // Build channel URL if needed
  const finalUrl = isChannel ? buildChannelUrl(url) : url;

  const args: string[] = [
    finalUrl,
    "--output",
    outputTemplate,
    "--restrict-filenames",
  ];

  // Add archive file if enabled
  const archiveFile = getArchiveFilePath(options);
  if (archiveFile) {
    args.push("--download-archive", archiveFile);
  }

  // Add thumbnail options if requested
  if (shouldIncludeThumbnail) {
    args.push("--write-thumbnail");
    if (!audioOnly) {
      args.push("--embed-thumbnail");
    }
  }

  // Add transcript/subtitle options if requested
  if (shouldIncludeTranscript) {
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en");
  }

  // For channels, limit the number of videos
  if (isChannel && maxVideos && maxVideos > 0) {
    args.push("--playlist-end", maxVideos.toString());
  }

  // Exclude YouTube Shorts if requested
  if (excludeShorts && (isChannel || isPlaylist)) {
    // Match filter: exclude videos where the webpage URL contains '/shorts/'
    // Using contains operator (*) to check if '/shorts/' is in the URL
    args.push("--match-filter", "!webpage_url * '/shorts/'");
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
      "--merge-output-format",
      "mkv"
    );
    // Embed subs only if transcript is requested and we're downloading video
    if (shouldIncludeTranscript) {
      args.push("--embed-subs");
    }
  }

  return args;
}

/**
 * Process downloaded video and track it
 */
async function processDownloadedVideo(
  videoId: string,
  videoUrl: string,
  options: DownloadOptions,
  metadata: { title: string; channel: string; channelId?: string; duration?: number; playlistId?: string; playlistTitle?: string }
): Promise<void> {
  const tracker = getTracker();
  
  // Calculate relative path safely
  let relativePath: string;
  try {
    relativePath = relative(DOWNLOADS_ROOT, options.outputPath);
    // If relative path starts with .., it's outside downloads root, use absolute path as relative
    if (relativePath.startsWith("..")) {
      relativePath = options.outputPath;
    }
  } catch {
    relativePath = options.outputPath;
  }
  
  // Find the downloaded file
  const normalizedPath = options.outputPath.replace(/\/$/, "");
  let filePath: string | undefined;
  let fileSize: number | undefined;
  
  // Try to find the file (yt-dlp output format: "%(title)s [%(id)s].%(ext)s")
  try {
    // Wait a bit for file to be written, then check
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // List files in the directory and find the one matching the video ID
    if (existsSync(normalizedPath)) {
      const glob = new Bun.Glob(`*[${videoId}]*`);
      for await (const file of glob.scan(normalizedPath)) {
        const fullPath = join(normalizedPath, file);
        if (existsSync(fullPath)) {
          const stats = statSync(fullPath);
          if (stats.isFile()) {
            filePath = fullPath;
            fileSize = stats.size;
            break;
          }
        }
      }
    }
  } catch (error) {
    // File might not exist yet or path issue
    console.log(`[${new Date().toISOString()}] Could not find file for video ${videoId}:`, error);
  }

  // Track the video
  tracker.trackVideo({
    id: videoId,
    title: metadata.title,
    channel: metadata.channel,
    channelId: metadata.channelId,
    url: videoUrl,
    relativePath,
    fullPath: filePath || join(normalizedPath, `${metadata.title} [${videoId}]`),
    format: options.audioOnly ? "audio" : "video",
    resolution: options.audioOnly ? undefined : options.resolution,
    fileSize,
    duration: metadata.duration,
  });

  // Track channel if applicable
  if (options.isChannel || metadata.channel) {
    tracker.trackChannel({
      channelName: metadata.channel,
      channelId: metadata.channelId,
      url: options.url,
      relativePath,
      videoId,
      maxVideos: options.maxVideos,
    });
  }

  // Track playlist if applicable
  if (options.isPlaylist || metadata.playlistId) {
    const playlistName = metadata.playlistTitle || `playlist-${metadata.playlistId}`;
    tracker.trackPlaylist({
      playlistName,
      playlistId: metadata.playlistId,
      url: options.url,
      relativePath,
      videoId,
    });
  }
}

/**
 * Start a download in the background and track it
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

  // Generate download ID
  const downloadId = `download-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  // Register download status
  const statusTracker = getDownloadStatusTracker();
  statusTracker.registerDownload({
    id: downloadId,
    url: options.url,
    outputPath: options.outputPath,
    format: options.audioOnly ? "audio" : "video",
    resolution: options.audioOnly ? undefined : options.resolution,
  });

  // Track downloads asynchronously
  (async () => {
    try {
      if (options.isPlaylist || options.isChannel) {
        // For playlists/channels, get video IDs first, then track each
        const videoIds = await getPlaylistVideoIds(options.url, options.maxVideos);
        console.log(`[${new Date().toISOString()}] Found ${videoIds.length} videos to track`);
        
        // Update status with video count
        statusTracker.updateStatus(downloadId, {
          progress: 0,
          status: "downloading",
        });
        
        // Track each video (metadata will be fetched as download progresses)
        let completedCount = 0;
        for (const videoId of videoIds) {
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          extractVideoMetadata(videoUrl)
            .then(metadata => {
              if (metadata) {
                // Update status with video info
                if (completedCount === 0) {
                  statusTracker.updateStatus(downloadId, {
                    title: metadata.title,
                    channel: metadata.channel,
                  });
                }
                
                // Delay tracking to allow download to complete
                setTimeout(() => {
                  processDownloadedVideo(metadata.id, videoUrl, options, metadata)
                    .then(() => {
                      completedCount++;
                      const progress = Math.floor((completedCount / videoIds.length) * 100);
                      statusTracker.updateStatus(downloadId, { progress });
                      
                      if (completedCount >= videoIds.length) {
                        statusTracker.updateStatus(downloadId, {
                          status: "completed",
                          progress: 100,
                        });
                      }
                    })
                    .catch(err => {
                      console.error(`[${new Date().toISOString()}] Error tracking video ${videoId}:`, err);
                      completedCount++;
                      if (completedCount >= videoIds.length) {
                        statusTracker.updateStatus(downloadId, {
                          status: "completed",
                          progress: 100,
                        });
                      }
                    });
                }, 5000); // Wait 5 seconds for download to start
              }
            })
            .catch(err => {
              console.error(`[${new Date().toISOString()}] Error extracting metadata for ${videoId}:`, err);
            });
        }
      } else {
        // For single videos, extract metadata and track immediately
        const metadata = await extractVideoMetadata(options.url);
        if (metadata) {
          const videoUrl = `https://www.youtube.com/watch?v=${metadata.id}`;
          
          // Update status with video info
          statusTracker.updateStatus(downloadId, {
            title: metadata.title,
            channel: metadata.channel,
            progress: 0,
          });
          
          // Delay tracking to allow download to start
          setTimeout(() => {
            processDownloadedVideo(metadata.id, videoUrl, options, metadata)
              .then(() => {
                statusTracker.updateStatus(downloadId, {
                  status: "completed",
                  progress: 100,
                });
              })
              .catch(err => {
                console.error(`[${new Date().toISOString()}] Error tracking video:`, err);
                statusTracker.updateStatus(downloadId, {
                  status: "completed",
                  progress: 100,
                });
              });
          }, 2000);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error setting up tracking:`, error);
      statusTracker.updateStatus(downloadId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  // Spawn yt-dlp process (fire and forget)
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
