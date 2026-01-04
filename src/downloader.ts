import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { basename, join, relative, dirname } from "path";
import { getTracker } from "./tracker";
import { getDownloadStatusTracker } from "./download-status";
import { getCollectionsManager } from "./collections";
import type { TrackedFile, TrackedFileKind } from "./tracker";

const ARCHIVE_FILE = "/downloads/.archive";
const DOWNLOADS_ROOT = "/downloads";

/**
 * Get JavaScript runtime flag for yt-dlp
 * Configures yt-dlp to use Node.js as the JS runtime
 */
function getJsRuntimeFlag(): string[] {
  return ["--js-runtimes", "node"];
}

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
  concurrentFragments?: number; // Number of fragments to download in parallel (yt-dlp --concurrent-fragments)
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
    const cmd = ["yt-dlp", ...getJsRuntimeFlag(), channelUrl, "--print", "%(channel)s", "--no-warnings"];
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
      cmd: ["yt-dlp", ...getJsRuntimeFlag(), url, "--print", "%(playlist_title)s", "--flat-playlist", "--no-warnings"],
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
 * Makes folder names more readable by cleaning up formatting
 */
export function sanitizeFolderName(name: string): string {
  return name
    // Replace underscores with spaces for readability
    .replace(/_/g, " ")
    // Remove invalid filesystem characters
    .replace(/[<>:"/\\|?*]/g, "")
    // Replace multiple spaces/hyphens with single space
    .replace(/[\s-]+/g, " ")
    // Trim whitespace
    .trim()
    // Limit length
    .substring(0, 200);
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
 * Extract full video metadata using yt-dlp JSON output
 * Returns the complete JSON metadata object
 */
async function extractFullVideoMetadata(url: string): Promise<Record<string, any> | null> {
  try {
    const proc = Bun.spawn({
      cmd: [
        "yt-dlp",
        ...getJsRuntimeFlag(),
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
      const stderr = await new Response(proc.stderr).text();
      console.error(`[${new Date().toISOString()}] yt-dlp metadata extraction failed: ${stderr}`);
      return null;
    }

    const data = JSON.parse(output.trim());
    return data;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error extracting video metadata:`, error);
    return null;
  }
}

/**
 * Extract video metadata using yt-dlp JSON output
 * Returns a subset of metadata for backward compatibility
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
  const fullMetadata = await extractFullVideoMetadata(url);
  if (!fullMetadata) {
    return null;
  }

  return {
    id: fullMetadata.id || "",
    title: fullMetadata.title || "",
    channel: fullMetadata.channel || fullMetadata.uploader || "",
    channelId: fullMetadata.channel_id || fullMetadata.channel_url?.split("/").pop(),
    duration: fullMetadata.duration || undefined,
    playlistId: fullMetadata.playlist_id || undefined,
    playlistTitle: fullMetadata.playlist_title || fullMetadata.playlist || undefined,
  };
}


/**
 * Extract metadata for videos in a playlist/channel that will actually be downloaded
 */
async function extractLimitedPlaylistMetadata(url: string, options: DownloadOptions): Promise<Array<{
  id: string;
  title: string;
  channel: string;
  channelId?: string;
  duration?: number;
  playlistId?: string;
  playlistTitle?: string;
  fullMetadata: Record<string, any>;
}> | null> {
  try {
    console.log(`[${new Date().toISOString()}] Extracting limited playlist/channel metadata for: ${url}`);

    // Build yt-dlp args similar to download but for metadata only
    const args = [
      "yt-dlp",
      ...getJsRuntimeFlag(),
      url,
      "--dump-json",
      "--no-warnings",
      "--yes-playlist",
      "--skip-download", // Don't download files
    ];

    // Apply the same limits as the actual download
    if (options.maxVideos && options.maxVideos > 0) {
      if (options.isChannel) {
        // For channels, limit to most recent videos
        args.push("--playlist-end", options.maxVideos.toString());
      } else {
        // For playlists, limit to first N videos
        args.push("--playlist-items", `1-${options.maxVideos}`);
      }
    }

    const proc = Bun.spawn({
      cmd: args,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[${new Date().toISOString()}] yt-dlp limited playlist metadata extraction failed: ${stderr}`);
      return null;
    }

    // Split output by newlines and parse each JSON line
    const lines = output.trim().split('\n').filter(line => line.trim());
    const videos: Array<{
      id: string;
      title: string;
      channel: string;
      channelId?: string;
      duration?: number;
      playlistId?: string;
      playlistTitle?: string;
      fullMetadata: Record<string, any>;
    }> = [];

    for (const line of lines) {
      try {
        const data = JSON.parse(line.trim());
        if (data && data.id && data.title) {
          videos.push({
            id: data.id,
            title: data.title,
            channel: data.channel || data.uploader || "",
            channelId: data.channel_id || data.channel_url?.split("/").pop(),
            duration: data.duration || undefined,
            playlistId: data.playlist_id || undefined,
            playlistTitle: data.playlist_title || data.playlist || undefined,
            fullMetadata: data,
          });
        }
      } catch (parseError) {
        console.error(`[${new Date().toISOString()}] Error parsing metadata line:`, parseError);
      }
    }

    console.log(`[${new Date().toISOString()}] Extracted metadata for ${videos.length} videos (limited to actual download count)`);
    return videos;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error extracting limited playlist metadata:`, error);
    return null;
  }
}

/**
 * Save metadata to a hidden file next to the video files
 * @param metadata Full video metadata JSON
 * @param outputPath Directory path where videos are stored (or a file path)
 * @param videoId YouTube video ID
 */
function saveMetadataToFile(metadata: Record<string, any>, outputPath: string, videoId: string): string | null {
  try {
    // Determine if outputPath is a directory or file
    let dir: string;
    try {
      const stats = statSync(outputPath);
      dir = stats.isDirectory() ? outputPath : dirname(outputPath);
    } catch {
      // Path doesn't exist yet, assume it's a directory
      dir = outputPath;
    }
    
    // Ensure output directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Create hidden metadata file: .metadata-[videoId].json
    const metadataFilePath = join(dir, `.metadata-${videoId}.json`);
    
    // Write metadata as formatted JSON
    writeFileSync(metadataFilePath, JSON.stringify(metadata, null, 2), "utf-8");
    
    console.log(`[${new Date().toISOString()}] Saved metadata to ${metadataFilePath}`);
    return metadataFilePath;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving metadata file:`, error);
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
      ...getJsRuntimeFlag(),
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

  // If collection ID is provided, place archive file in collection root directory
  if (options.collectionId) {
    const collectionsManager = getCollectionsManager();
    const collection = collectionsManager.getCollection(options.collectionId);
    if (collection) {
      // Archive file co-located with collection files in the collection folder
      return join(collection.rootPath, `.archive-${formatSuffix}`);
    }
    // Fallback if collection not found (shouldn't happen, but be safe)
    return `/downloads/.archive-${options.collectionId}-${formatSuffix}`;
  }

  // Default archive file (for non-collection downloads)
  return `/downloads/.archive-${formatSuffix}`;
}

/**
 * Build yt-dlp arguments based on download options
 */
function buildYtDlpArgs(options: DownloadOptions): string[] {
  const { url, outputPath, audioOnly, resolution, isPlaylist, isChannel, maxVideos, includeThumbnail, includeTranscript, excludeShorts, concurrentFragments } = options;

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
    ...getJsRuntimeFlag(),
    finalUrl,
    "--output",
    outputTemplate,
    "--restrict-filenames",
    // Make progress machine-readable (one update per line)
    "--newline",
  ];

  // Add parallel chunk download support (concurrent fragments)
  // Default to 4 fragments if not specified (reasonable balance between speed and resource usage)
  // This enables parallel chunk downloads by default for faster downloads
  const fragments = concurrentFragments !== undefined ? concurrentFragments : 4;
  args.push("--concurrent-fragments", fragments.toString());

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
    // Using Python-style 'in' operator to check if '/shorts/' is in the URL
    args.push("--match-filter", "!'/shorts/' in webpage_url");
  }

  // Use --yes-playlist for playlists and channels, --no-playlist for single videos
  if (isPlaylist || isChannel) {
    args.push("--yes-playlist");
    // No need for --dump-json since we extract metadata upfront
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

function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseHumanSizeToBytes(n: string, unit: string): number | null {
  const value = Number.parseFloat(n);
  if (!Number.isFinite(value)) return null;
  const u = unit.toLowerCase();
  const pow = (base: number, exp: number) => Math.pow(base, exp);

  // Support both SI and IEC-ish suffixes as yt-dlp prints them (KiB/MiB/GiB and KB/MB/GB).
  if (u === "b") return value;
  if (u === "kib") return value * pow(1024, 1);
  if (u === "mib") return value * pow(1024, 2);
  if (u === "gib") return value * pow(1024, 3);
  if (u === "tib") return value * pow(1024, 4);
  if (u === "kb") return value * pow(1000, 1);
  if (u === "mb") return value * pow(1000, 2);
  if (u === "gb") return value * pow(1000, 3);
  if (u === "tb") return value * pow(1000, 4);
  return null;
}

async function streamTextLines(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.length) onLine(line);
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) onLine(tail);
}

async function waitForFileStable(path: string, opts?: { timeoutMs?: number; stableMs?: number }): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const stableMs = opts?.stableMs ?? 1_500;
  const started = Date.now();
  let lastSize: number | null = null;
  let lastChange = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (!existsSync(path)) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    try {
      const size = statSync(path).size;
      if (lastSize === null || size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= stableMs) {
        return true;
      }
    } catch {
      // transient
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Process downloaded video and track it
 */
async function processDownloadedVideo(
  videoId: string,
  videoUrl: string,
  options: DownloadOptions,
  metadata: { title: string; channel: string; channelId?: string; duration?: number; playlistId?: string; playlistTitle?: string },
  fullMetadata: Record<string, any> | null,
  ctx: { downloadId: string; ytdlpCommand: string },
  requireFileExists: boolean = true,
  downloadStatus: "pending" | "downloading" | "completed" | "failed" = "completed"
): Promise<void> {
  const tracker = getTracker();
  const statusTracker = getDownloadStatusTracker();
  
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
  
  // Find the downloaded file (optional for early tracking)
  const normalizedPath = options.outputPath.replace(/\/$/, "");
  let filePath: string | undefined;
  let fileSize: number | undefined;

  if (requireFileExists) {
    // Try to find the file (yt-dlp output format: "%(title)s [%(id)s].%(ext)s")
    try {
      // Wait a bit for file to be written, then check
      await new Promise(resolve => setTimeout(resolve, 3000));
    
    // List files in the directory and find the one matching the video ID
    // Skip intermediate files (fragment files, .part files) - prefer final merged files
    if (existsSync(normalizedPath)) {
      const glob = new Bun.Glob(`*[${videoId}]*`);
      let bestFile: { path: string; size: number; isFragment: boolean } | null = null;
      for await (const file of glob.scan(normalizedPath)) {
        const fullPath = join(normalizedPath, file);
        if (!existsSync(fullPath)) continue;
        const stats = statSync(fullPath);
        if (!stats.isFile()) continue;
        
        // Skip intermediate files
        if (fullPath.endsWith(".part") || fullPath.endsWith(".ytdl") || fullPath.endsWith(".temp")) continue;
        const isFragmentFile = /\.f\d{1,4}\./i.test(fullPath);
        
        // Prefer non-fragment files, but keep fragment files as fallback
        if (!bestFile || (!isFragmentFile && bestFile.isFragment)) {
          bestFile = { path: fullPath, size: stats.size, isFragment: isFragmentFile };
        }
      }
      if (bestFile) {
        filePath = bestFile.path;
        fileSize = bestFile.size;
      }
    }
    } catch (error) {
      // File might not exist yet or path issue
      console.log(`[${new Date().toISOString()}] Could not find file for video ${videoId}:`, error);
    }
  }

  function classifyPath(p: string): { kind: TrackedFileKind; intermediate: boolean } {
    const lower = p.toLowerCase();
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
    const isPart = lower.endsWith(".part") || lower.endsWith(".ytdl") || lower.endsWith(".temp");
    const hasFormatTag = /\.f\d{1,4}\./i.test(lower);
    const intermediate = isPart || hasFormatTag;

    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return { kind: "thumbnail", intermediate };
    if ([".vtt", ".srt", ".ass", ".ssa", ".lrc"].includes(ext)) return { kind: "subtitle", intermediate };
    if ([".mkv", ".mp4", ".webm", ".mp3", ".m4a", ".opus", ".wav", ".flac"].includes(ext)) return { kind: "media", intermediate };
    return { kind: intermediate ? "intermediate" : "other", intermediate };
  }

  function toTrackedFile(p: string, firstSeenAt: number, deletedAt?: number): TrackedFile {
    const { kind, intermediate } = classifyPath(p);
    const exists = existsSync(p);
    const hidden = intermediate && !exists;
    return { path: p, kind, intermediate, exists, hidden, firstSeenAt, deletedAt };
  }

  function extractPathsFromLog(log: string): string[] {
    const out: string[] = [];
    const lines = log.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // Destination: /path/to/file
      const dest = line.match(/Destination:\s+(.*)$/);
      if (dest?.[1]) out.push(dest[1].replace(/^"+|"+$/g, ""));
      // Merging formats into "/path/to/file"
      const merge = line.match(/Merging formats into\s+"([^"]+)"/);
      if (merge?.[1]) out.push(merge[1]);
      // Extracting audio to "/path/to/file"
      const ex1 = line.match(/Extracting audio to\s+"([^"]+)"/);
      if (ex1?.[1]) out.push(ex1[1]);
      // Writing ... to: /path/to/file
      const write = line.match(/Writing .* to:\s+(.*)$/i);
      if (write?.[1]) out.push(write[1].replace(/^"+|"+$/g, ""));
      // Writing video subtitles to: /path/to/file
      const subs = line.match(/Writing video subtitles to:\s+(.*)$/i);
      if (subs?.[1]) out.push(subs[1].replace(/^"+|"+$/g, ""));
      const autosubs = line.match(/Writing automatic subtitles to:\s+(.*)$/i);
      if (autosubs?.[1]) out.push(autosubs[1].replace(/^"+|"+$/g, ""));
      // Writing thumbnail to: ...
      const thumb = line.match(/Writing thumbnail to:\s+(.*)$/i);
      if (thumb?.[1]) out.push(thumb[1].replace(/^"+|"+$/g, ""));
      // Writing video thumbnail to: ...
      const vthumb = line.match(/Writing video thumbnail to:\s+(.*)$/i);
      if (vthumb?.[1]) out.push(vthumb[1].replace(/^"+|"+$/g, ""));
    }
    // de-dupe, keep order
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const p of out) {
      if (!p) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      uniq.push(p);
    }
    return uniq;
  }

  // Build full associated file set (media + thumbnails + subtitles + intermediates).
  const now = Date.now();
  const filesByPath = new Map<string, TrackedFile>();

  // 1) Scan directory for anything containing the video id (captures thumbnails/subs).
  try {
    if (existsSync(normalizedPath)) {
      const glob = new Bun.Glob(`*[${videoId}]*`);
      for await (const file of glob.scan(normalizedPath)) {
        const full = join(normalizedPath, file);
        if (!existsSync(full)) continue;
        const st = statSync(full);
        if (!st.isFile()) continue;
        filesByPath.set(full, toTrackedFile(full, now));
      }
    }
  } catch {
    // ignore
  }

  // 2) Parse yt-dlp log for paths (captures intermediates that may have been deleted).
  try {
    const lr = statusTracker.readLog(ctx.downloadId);
    if (lr.ok) {
      for (const p of extractPathsFromLog(lr.log)) {
        // Only associate paths that clearly belong to this video id.
        if (!p.includes(`[${videoId}]`)) continue;
        // If the file no longer exists, mark deletedAt so UI can hide it.
        const exists = existsSync(p);
        const deletedAt = exists ? undefined : now;
        filesByPath.set(p, toTrackedFile(p, now, deletedAt));
      }
    }
  } catch {
    // ignore
  }

  // Ensure the main media path is present even if scan missed it.
  const bestFullPath = filePath || join(normalizedPath, `${metadata.title} [${videoId}]`);
  if (bestFullPath) {
    filesByPath.set(bestFullPath, toTrackedFile(bestFullPath, now));
  }

  // Save metadata to hidden file if we have full metadata
  let metadataFilePath: string | null = null;
  if (fullMetadata) {
    metadataFilePath = saveMetadataToFile(fullMetadata, bestFullPath, videoId);
    if (metadataFilePath) {
      // Track the metadata file as well
      filesByPath.set(metadataFilePath, {
        path: metadataFilePath,
        kind: "other",
        intermediate: false,
        exists: true,
        hidden: true, // Hidden file
        firstSeenAt: now,
      });
    }
  }

  // Track the video
  tracker.trackVideo({
    id: videoId,
    title: metadata.title,
    channel: metadata.channel,
    channelId: metadata.channelId,
    url: videoUrl,
    relativePath,
    fullPath: bestFullPath,
    format: options.audioOnly ? "audio" : "video",
    resolution: options.audioOnly ? undefined : options.resolution,
    fileSize,
    duration: metadata.duration,
    ytdlpCommand: ctx.ytdlpCommand,
    metadata: fullMetadata || undefined,
    files: Array.from(filesByPath.values()),
    downloadStatus,
  }, downloadStatus);

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
export async function startDownload(options: DownloadOptions): Promise<DownloadResult> {
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



  // Spawn yt-dlp process and actively track its stdout/stderr + filesystem state.
  (async () => {
    let currentDestination: string | null = null; // file being downloaded (may be .part)
    let finalOutputFile: string | null = null; // merged/extracted final output file
    let inferredTotalBytes: number | null = null;
    const recentErrors: string[] = [];
    const processedVideoIds = new Set<string>(); // Track which videos yt-dlp actually processed

    const proc = Bun.spawn({
      cmd: ["yt-dlp", ...args],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Extract metadata in background (non-blocking)
    (async () => {
      try {
        console.log(`[${new Date().toISOString()}] Extracting metadata for: ${options.url}`);
        statusTracker.updateStatus(downloadId, { status: "downloading" });

        if (options.isPlaylist || options.isChannel) {
          // For playlists/channels, get only the metadata for videos that will actually be downloaded
          const playlistVideos = await extractLimitedPlaylistMetadata(options.url, options);
          if (playlistVideos && playlistVideos.length > 0) {
            console.log(`[${new Date().toISOString()}] Found ${playlistVideos.length} videos to download from playlist/channel`);

            // Track all videos immediately in the library with pending status
            const tracker = getTracker();
            for (const video of playlistVideos) {
              const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
              try {
                await processDownloadedVideo(video.id, videoUrl, options, video, video.fullMetadata, {
                  downloadId: `${downloadId}-${video.id}`,
                  ytdlpCommand: `yt-dlp ${args.join(" ")}`,
                }, false, "pending"); // Don't require file to exist yet, status is pending
                console.log(`[${new Date().toISOString()}] Pre-tracked video: ${video.title}`);
              } catch (err) {
                console.error(`[${new Date().toISOString()}] Error pre-tracking video ${video.id}:`, err);
              }
            }
          }
        } else {
          // Download metadata for single video
          const fullVideoMetadata = await extractFullVideoMetadata(options.url);
          if (fullVideoMetadata) {
            const singleVideoMetadata = {
              id: fullVideoMetadata.id || "",
              title: fullVideoMetadata.title || "",
              channel: fullVideoMetadata.channel || fullVideoMetadata.uploader || "",
              channelId: fullVideoMetadata.channel_id || fullVideoMetadata.channel_url?.split("/").pop(),
              duration: fullVideoMetadata.duration || undefined,
              playlistId: fullVideoMetadata.playlist_id || undefined,
              playlistTitle: fullVideoMetadata.playlist_title || fullVideoMetadata.playlist || undefined,
            };

            // Update status with metadata
            statusTracker.updateStatus(downloadId, {
              title: singleVideoMetadata.title,
              channel: singleVideoMetadata.channel,
            });

            // Save metadata to file
            if (singleVideoMetadata.id) {
              const normalizedPath = options.outputPath.replace(/\/$/, "");
              saveMetadataToFile(fullVideoMetadata, normalizedPath, singleVideoMetadata.id);
            }

            console.log(`[${new Date().toISOString()}] Metadata downloaded: ${singleVideoMetadata.title}`);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error downloading metadata:`, error);
        // Continue with download even if metadata fails
      }
    })();

    const onLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;

      // Persist full yt-dlp output for UI debugging.
      statusTracker.appendLog(downloadId, raw);

      // Update video status to downloading when yt-dlp starts processing them
      if ((options.isPlaylist || options.isChannel) && (line.startsWith('{') || line.startsWith('['))) {
        try {
          const metadata = JSON.parse(line);
          if (metadata && metadata.id && metadata.title) {
            processedVideoIds.add(metadata.id); // Track that this video was processed by yt-dlp

            // Calculate relative path for this download
            let checkRelativePath: string;
            try {
              checkRelativePath = relative(DOWNLOADS_ROOT, options.outputPath);
              if (checkRelativePath.startsWith("..")) {
                checkRelativePath = options.outputPath;
              }
            } catch {
              checkRelativePath = options.outputPath;
            }

            // Update status to downloading when yt-dlp starts processing it
            const tracker = getTracker();
            if (tracker.updateVideoDownloadStatus(metadata.id, checkRelativePath, "downloading")) {
              console.log(`[${new Date().toISOString()}] Updated video status to downloading: ${metadata.title}`);
            }
          }
          return;
        } catch (jsonError) {
          // Not JSON, continue with normal processing
        }
      }

      // Keep a short tail of stderr-ish lines for debugging on failure.
      if (line.toLowerCase().includes("error") || line.toLowerCase().includes("traceback")) {
        recentErrors.push(line);
        if (recentErrors.length > 15) recentErrors.shift();
      }

      // Destination files (often for fragments or intermediate formats).
      // Example: [download] Destination: /downloads/foo/Title [id].f137.mp4
      const destMatch = line.match(/Destination:\s+(.*)$/);
      if (destMatch?.[1]) {
        currentDestination = destMatch[1].replace(/^"+|"+$/g, "");
        statusTracker.updateStatus(downloadId, {
          currentPath: currentDestination,
          currentFile: basename(currentDestination),
        });
        return;
      }

      // Final merged output (video+audio).
      // Example: [Merger] Merging formats into "/downloads/foo/Title [id].mkv"
      const mergeMatch = line.match(/Merging formats into\s+"([^"]+)"/);
      if (mergeMatch?.[1]) {
        finalOutputFile = mergeMatch[1];
        statusTracker.updateStatus(downloadId, { status: "processing" });
        statusTracker.updateStatus(downloadId, {
          finalPath: finalOutputFile,
          finalFile: basename(finalOutputFile),
        });
        return;
      }

      // Final extracted audio.
      // Example: [ExtractAudio] Destination: /downloads/foo/Title [id].mp3
      const extractMatch = line.match(/Extracting audio to\s+"([^"]+)"/) || line.match(/\[ExtractAudio\]\s+Destination:\s+(.*)$/);
      if (extractMatch?.[1]) {
        finalOutputFile = extractMatch[1].replace(/^"+|"+$/g, "");
        statusTracker.updateStatus(downloadId, { status: "processing" });
        statusTracker.updateStatus(downloadId, {
          finalPath: finalOutputFile,
          finalFile: basename(finalOutputFile),
        });
        return;
      }

      // Generic post-processing hints.
      if (line.includes("[Merger]") || line.includes("[ExtractAudio]") || line.includes("[Fixup") || line.includes("Post-process")) {
        statusTracker.updateStatus(downloadId, { status: "processing" });
      }

      // Progress lines.
      // Example: [download]  12.3% of 123.45MiB at 3.45MiB/s ETA 00:12
      const pMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (pMatch?.[1]) {
        const parsedPercent = Number.parseFloat(pMatch[1]);

        // Try to infer total bytes from the same line.
        const totalMatch = line.match(/\sof\s+~?\s*([\d.]+)\s*([KMGT]i?B|B)\b/i);
        if (totalMatch?.[1] && totalMatch?.[2]) {
          const tb = parseHumanSizeToBytes(totalMatch[1], totalMatch[2]);
          if (tb && tb > 0) inferredTotalBytes = tb;
        }

        // Use filesystem as the source of truth when we can.
        // However, with concurrent fragments, multiple fragment files are downloaded in parallel,
        // so we should rely on yt-dlp's aggregated progress percentage rather than checking
        // individual fragment file sizes.
        let effectivePercent = parsedPercent;
        if (currentDestination && inferredTotalBytes && inferredTotalBytes > 0) {
          // Skip filesystem check if this is a fragment file (format tag like .f137)
          // With concurrent fragments, checking a single fragment file size would be inaccurate
          const isFragmentFile = /\.f\d{1,4}\./i.test(currentDestination);
          
          if (!isFragmentFile) {
            // Only do filesystem check for non-fragment files (final merged files or single-file downloads)
            const partPath = `${currentDestination}.part`;
            const fileToStat = existsSync(partPath) ? partPath : currentDestination;
            try {
              const sz = statSync(fileToStat).size;
              const fsPercent = (sz / inferredTotalBytes) * 100;
              // Prefer FS-derived percent if it looks sane.
              if (Number.isFinite(fsPercent) && fsPercent >= 0 && fsPercent <= 100) {
                effectivePercent = Math.max(effectivePercent, fsPercent);
              }
            } catch {
              // ignore
            }
          }
          // With concurrent fragments, trust yt-dlp's aggregated progress percentage
        }

        // Don't report "completed" just because we hit 100% download; merging may still be running.
        if (effectivePercent >= 100) {
          statusTracker.updateStatus(downloadId, { progress: 99, status: "processing" });
        } else {
          statusTracker.updateStatus(downloadId, { progress: clampProgress(effectivePercent), status: "downloading" });
        }
        return;
      }
    };

    const stdoutP = streamTextLines(proc.stdout, onLine);
    const stderrP = streamTextLines(proc.stderr, onLine);

    const exitCode = await proc.exited;
    await Promise.allSettled([stdoutP, stderrP]);

    if (exitCode !== 0) {
      statusTracker.updateStatus(downloadId, {
        status: "failed",
        error: recentErrors.slice(-5).join(" | ") || `yt-dlp exited with code ${exitCode}`,
      });

      // For playlist/channel downloads, mark videos that were in progress as failed
      if (options.isPlaylist || options.isChannel) {
        try {
          const tracker = getTracker();
          let checkRelativePath: string;
          try {
            checkRelativePath = relative(DOWNLOADS_ROOT, options.outputPath);
            if (checkRelativePath.startsWith("..")) {
              checkRelativePath = options.outputPath;
            }
          } catch {
            checkRelativePath = options.outputPath;
          }

          // Get all videos in this path that are "pending" or "downloading"
          const allVideos = tracker.getAllVideos();
          const inProgressVideos = allVideos.filter(v =>
            v.relativePath === checkRelativePath &&
            (v.downloadStatus === "pending" || v.downloadStatus === "downloading")
          );

          // Mark failed videos as failed
          for (const video of inProgressVideos) {
            if (tracker.updateVideoDownloadStatus(video.id, video.relativePath, "failed")) {
              console.log(`[${new Date().toISOString()}] Marked failed video: ${video.title}`);
            }
          }
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error updating failed video statuses:`, error);
        }
      } else {
        // For single video downloads, mark as failed if it was being tracked
        try {
          const videoId = extractVideoId(options.url);
          if (videoId) {
            const tracker = getTracker();
            let checkRelativePath: string;
            try {
              checkRelativePath = relative(DOWNLOADS_ROOT, options.outputPath);
              if (checkRelativePath.startsWith("..")) {
                checkRelativePath = options.outputPath;
              }
            } catch {
              checkRelativePath = options.outputPath;
            }

            if (tracker.updateVideoDownloadStatus(videoId, checkRelativePath, "failed")) {
              console.log(`[${new Date().toISOString()}] Marked single failed video: ${videoId}`);
            }
          }
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error updating failed single video status:`, error);
        }
      }

      return;
    }

    // Confirm final file exists and is stable before marking completed.
    // Prefer the explicit merge/extract destination; fallback to the last destination (non-.part),
    // and finally metadata-based scan for single videos.
    // With concurrent fragments, skip fragment files (format tags like .f137) as they're intermediate.
    let finalPath = finalOutputFile;
    if (!finalPath && currentDestination && existsSync(currentDestination) && !existsSync(`${currentDestination}.part`)) {
      // Skip fragment files - they're intermediate files that get merged
      const isFragmentFile = /\.f\d{1,4}\./i.test(currentDestination);
      if (!isFragmentFile) {
        finalPath = currentDestination;
      }
    }

    if (finalPath) {
      const ok = await waitForFileStable(finalPath, { timeoutMs: 60_000, stableMs: 1_500 });
      if (!ok) {
        statusTracker.updateStatus(downloadId, { status: "failed", error: "Final output file did not stabilize in time" });
        return;
      }
    }

    statusTracker.updateStatus(downloadId, { status: "completed", progress: 100 });

    // Update video status in tracker database to completed
    if (exitCode === 0) {
      try {
        const tracker = getTracker();
        let checkRelativePath: string;
        try {
          checkRelativePath = relative(DOWNLOADS_ROOT, options.outputPath);
          if (checkRelativePath.startsWith("..")) {
            checkRelativePath = options.outputPath;
          }
        } catch {
          checkRelativePath = options.outputPath;
        }

        if (options.isPlaylist || options.isChannel) {
          // For playlist/channel downloads, mark processed videos as completed
          const allVideos = tracker.getAllVideos();
          const processedVideos = allVideos.filter(v =>
            v.relativePath === checkRelativePath &&
            processedVideoIds.has(v.id)
          );

          for (const video of processedVideos) {
            if (tracker.updateVideoDownloadStatus(video.id, video.relativePath, "completed")) {
              console.log(`[${new Date().toISOString()}] Marked processed video as completed: ${video.title}`);
            }
          }

          // Mark skipped videos as completed (those that were pending but not processed)
          const pendingVideos = allVideos.filter(v =>
            v.relativePath === checkRelativePath &&
            v.downloadStatus === "pending" &&
            !processedVideoIds.has(v.id)
          );

          for (const video of pendingVideos) {
            if (tracker.updateVideoDownloadStatus(video.id, video.relativePath, "completed")) {
              console.log(`[${new Date().toISOString()}] Marked skipped video as completed: ${video.title}`);
            }
          }
        } else {
          // For single video downloads, mark the video as completed
          // Extract video ID from URL
          const videoId = extractVideoId(options.url);
          if (videoId) {
            // Get metadata for the completed video
            const fullMetadata = await extractFullVideoMetadata(options.url);
            if (fullMetadata) {
              const videoMetadata = {
                id: fullMetadata.id || videoId,
                title: fullMetadata.title || "",
                channel: fullMetadata.channel || fullMetadata.uploader || "",
                channelId: fullMetadata.channel_id || fullMetadata.channel_url?.split("/").pop(),
                duration: fullMetadata.duration || undefined,
                playlistId: fullMetadata.playlist_id || undefined,
                playlistTitle: fullMetadata.playlist_title || fullMetadata.playlist || undefined,
              };

              // Mark the video as completed in the tracker
              await processDownloadedVideo(
                videoId,
                options.url,
                options,
                videoMetadata,
                fullMetadata,
                {
                  downloadId,
                  ytdlpCommand: `yt-dlp ${args.join(" ")}`,
                },
                true, // Require file to exist
                "completed"
              );
              console.log(`[${new Date().toISOString()}] Marked single video as completed: ${videoMetadata.title}`);
            }
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error updating completed video statuses:`, error);
      }
    }

    // Video tracking is handled by the metadata extraction background task
  })();

  return {
    success: true,
    message: "Download started",
  };
}
