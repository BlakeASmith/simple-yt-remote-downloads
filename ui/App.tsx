import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiSend,
  defaultsForFormat,
  normalizeScheduleUpdates,
  type Collection,
  type DownloadRequest,
  type DownloadLogResponse,
  type DownloadStatus,
  type Schedule,
  type TrackedChannel,
  type TrackedPlaylist,
  type TrackedVideo,
} from "./lib/api";
import { formatBytes, formatDuration, formatInterval, formatTime, toMinutes, type IntervalUnit } from "./lib/format";
import { isChannelInput, isPlaylistInput } from "./lib/youtube-detect";
import { Badge, Button, Card, Checkbox, Input, Modal, Radio, Select, Toast, cx } from "./components/ui";

type Page = "downloads" | "tracking" | "developer";
type TrackingTab = "videos" | "channels" | "playlists";

function getPageFromHash(): Page | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  const base = raw.split("/")[0];
  if (base === "tracking") return "tracking";
  if (base === "downloads") return "downloads";
  if (base === "developer") return "developer";
  return null;
}

function getTrackingTabFromHash(): TrackingTab | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  const [base, maybeTab] = raw.split("/");
  if (base !== "tracking") return null;
  if (maybeTab === "videos" || maybeTab === "channels" || maybeTab === "playlists") return maybeTab;
  return null;
}

function getTrackingHashFromStorage(): string {
  try {
    const t = window.localStorage.getItem("yt_tracking_tab");
    if (t === "channels" || t === "playlists") return `#tracking/${t}`;
  } catch {
    // ignore
  }
  return "#tracking";
}

function useInterval(fn: () => void, ms: number | null) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = window.setInterval(() => fnRef.current(), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

function SectionHeader(props: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="text-lg font-semibold text-white">{props.title}</div>
        {props.subtitle ? <div className="mt-1 text-sm text-white/60">{props.subtitle}</div> : null}
      </div>
      {props.right ? <div className="flex w-full justify-end sm:w-auto">{props.right}</div> : null}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>(() => getPageFromHash() || "downloads");
  const [toast, setToast] = useState<{ tone: "good" | "bad"; message: string } | null>(null);

  const showToast = (tone: "good" | "bad", message: string) => setToast({ tone, message });

  // Hash-based routing so refresh stays on the same page (e.g. "#tracking").
  useEffect(() => {
    const onHashChange = () => {
      const fromHash = getPageFromHash();
      if (fromHash) setPage(fromHash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Keep the URL in sync with the current page, without blowing away a tracking sub-tab hash.
  useEffect(() => {
    if (page === "tracking") {
      if (!window.location.hash.startsWith("#tracking")) {
        window.history.replaceState(null, "", getTrackingHashFromStorage());
      }
      return;
    }
    if (page === "developer") {
      if (window.location.hash !== "#developer") {
        window.history.replaceState(null, "", "#developer");
      }
      return;
    }
    if (window.location.hash !== "#downloads") {
      window.history.replaceState(null, "", "#downloads");
    }
  }, [page]);

  return (
    <div className="min-h-dvh bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
              <span className="text-sm font-bold">YT</span>
            </div>
            <div>
              <div className="text-base font-semibold leading-tight">YouTube Download Manager</div>
              <div className="text-xs text-white/55">Fast queueing + schedules + tracking</div>
            </div>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:grid-cols-none sm:auto-cols-max sm:grid-flow-col">
            <Button
              className="w-full"
              variant={page === "downloads" ? "primary" : "ghost"}
              onClick={() => {
                window.location.hash = "#downloads";
              }}
            >
              Downloads
            </Button>
            <Button
              className="w-full"
              variant={page === "tracking" ? "primary" : "ghost"}
              onClick={() => {
                window.location.hash = getTrackingHashFromStorage();
              }}
            >
              Tracking
            </Button>
            <Button
              className="w-full"
              variant={page === "developer" ? "primary" : "ghost"}
              onClick={() => {
                window.location.hash = "#developer";
              }}
            >
              Developer
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-6">
          {page === "downloads" ? (
            <DownloadsPage showToast={showToast} />
          ) : page === "tracking" ? (
            <TrackingPage showToast={showToast} />
          ) : (
            <DeveloperPage showToast={showToast} />
          )}
        </div>
      </div>

      {toast ? <Toast tone={toast.tone} message={toast.message} onClose={() => setToast(null)} /> : null}
    </div>
  );
}

function DownloadsPage(props: { showToast: (tone: "good" | "bad", message: string) => void }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);

  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [collectionId, setCollectionId] = useState<string>("");

  const [isChannel, setIsChannel] = useState(false);
  const [isPlaylist, setIsPlaylist] = useState(false);
  const [maxVideos, setMaxVideos] = useState<number>(10);

  const [audioOnly, setAudioOnly] = useState(false);
  const [resolution, setResolution] = useState<"1080" | "720">("1080");
  const [includeThumbnail, setIncludeThumbnail] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [excludeShorts, setExcludeShorts] = useState(true);
  const [useArchiveFile, setUseArchiveFile] = useState(true);
  const [concurrentFragments, setConcurrentFragments] = useState<number>(4);

  const [createSchedule, setCreateSchedule] = useState(false);
  const [intervalValue, setIntervalValue] = useState<number>(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("days");

  const [busy, setBusy] = useState(false);

  const detected = useMemo(() => {
    const u = url.trim();
    return {
      channel: isChannelInput(u),
      playlist: isPlaylistInput(u),
    };
  }, [url]);

  // Auto-detect (non-destructive): only suggest if user hasn’t explicitly set.
  useEffect(() => {
    if (!url.trim()) return;
    if (detected.channel) {
      setIsChannel(true);
      setIsPlaylist(false);
    } else if (detected.playlist) {
      setIsPlaylist(true);
      setIsChannel(false);
    }
  }, [detected.channel, detected.playlist, url]);

  // Format defaults when switching audio/video
  useEffect(() => {
    const d = defaultsForFormat(audioOnly);
    setIncludeThumbnail(d.includeThumbnail ?? !audioOnly);
    setIncludeTranscript(d.includeTranscript ?? !audioOnly);
    setExcludeShorts(d.excludeShorts ?? true);
    setUseArchiveFile(d.useArchiveFile ?? true);
  }, [audioOnly]);

  async function loadCollections() {
    const res = await apiGet<{ success: true; collections: Collection[] }>("/api/collections");
    if (res.ok && res.data.success) setCollections(res.data.collections || []);
  }

  async function loadSchedules() {
    const res = await apiGet<{ success: true; schedules: Schedule[] }>("/api/schedules");
    if (res.ok && res.data.success) setSchedules(res.data.schedules || []);
  }

  useEffect(() => {
    loadCollections();
    loadSchedules();
  }, []);

  useInterval(() => loadSchedules(), 30_000);

  async function start() {
    const u = url.trim();
    if (!u) return props.showToast("bad", "Please enter a URL, video ID, channel, or playlist.");
    if (isChannel && (!maxVideos || maxVideos < 1)) return props.showToast("bad", "Max videos must be at least 1.");
    if (createSchedule && !(isChannel || isPlaylist)) return props.showToast("bad", "Schedules are only for channels or playlists.");

    const req: DownloadRequest = {
      url: u,
      path: path.trim() || undefined,
      collectionId: collectionId || undefined,
      audioOnly,
      resolution,
      isChannel,
      isPlaylist,
      maxVideos: isChannel ? maxVideos : undefined,
      includeThumbnail,
      includeTranscript,
      excludeShorts,
      useArchiveFile,
      concurrentFragments,
    };

    const scheduleMinutes = createSchedule ? toMinutes(intervalValue, intervalUnit) : undefined;
    if (createSchedule && (!scheduleMinutes || scheduleMinutes < 1)) return props.showToast("bad", "Invalid schedule interval.");

    setBusy(true);
    try {
      const d1 = await apiSend<{ success: boolean; message: string }>("/api/download", "POST", req);
      if (!d1.ok) return props.showToast("bad", d1.message);
      if (!d1.data.success) return props.showToast("bad", d1.data.message || "Failed to start download.");

      if (createSchedule) {
        const d2 = await apiSend<{ success: boolean; message?: string; schedule?: Schedule }>(
          "/api/schedules",
          "POST",
          { ...req, intervalMinutes: scheduleMinutes }
        );
        if (!d2.ok || !d2.data.success) {
          props.showToast("bad", `Download started, but schedule failed: ${d2.ok ? d2.data.message : d2.message}`);
        } else {
          props.showToast("good", "Download started and schedule created.");
          loadSchedules();
        }
      } else {
        props.showToast("good", d1.data.message || "Download started.");
      }

      setUrl("");
      setPath("");
      setCreateSchedule(false);
    } finally {
      setBusy(false);
    }
  }

  const collectionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of collections) map.set(c.id, c.name);
    return map;
  }, [collections]);

  return (
    <div className="grid gap-6">
      <Card>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="text-sm font-semibold text-white/85">URL</div>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…  |  https://www.youtube.com/playlist?list=…  |  @channel"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
              {detected.channel ? <Badge tone="good">Channel detected</Badge> : null}
              {detected.playlist ? <Badge tone="good">Playlist detected</Badge> : null}
              {!detected.channel && !detected.playlist && url.trim() ? <Badge tone="muted">Treating as video</Badge> : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white/85">Collection</div>
                <Button variant="ghost" className="text-xs" onClick={() => setCollectionsOpen(true)}>
                  Manage
                </Button>
              </div>
              <Select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="">None (downloads root)</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="md:col-span-2 grid gap-2">
              <div className="text-sm font-semibold text-white/85">Subfolder (optional)</div>
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. movies/comedy (leave empty for auto folder name)" />
            </div>
          </div>

          <div className="grid gap-3 rounded-xl bg-white/3 p-4 ring-1 ring-white/8 md:grid-cols-3">
            <div className="grid gap-2">
              <div className="text-sm font-semibold text-white/85">Source</div>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={!isChannel && !isPlaylist} onChange={() => (setIsChannel(false), setIsPlaylist(false))} />
                Video
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={isPlaylist} onChange={() => (setIsPlaylist(true), setIsChannel(false))} />
                Playlist
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={isChannel} onChange={() => (setIsChannel(true), setIsPlaylist(false))} />
                Channel
              </label>
            </div>

            <div className="grid gap-2">
              <div className="text-sm font-semibold text-white/85">Format</div>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={!audioOnly} onChange={() => setAudioOnly(false)} />
                Video
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={audioOnly} onChange={() => setAudioOnly(true)} />
                Audio (MP3)
              </label>
              <div className={cx("mt-2 grid gap-2", audioOnly ? "opacity-50" : "")}>
                <div className="text-xs font-semibold text-white/70">Resolution</div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-white/75">
                    <Radio checked={resolution === "1080"} disabled={audioOnly} onChange={() => setResolution("1080")} />
                    1080p
                  </label>
                  <label className="flex items-center gap-2 text-sm text-white/75">
                    <Radio checked={resolution === "720"} disabled={audioOnly} onChange={() => setResolution("720")} />
                    720p
                  </label>
                </div>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="text-sm font-semibold text-white/85">Options</div>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={includeThumbnail} onChange={(e) => setIncludeThumbnail(e.target.checked)} />
                Thumbnail
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={includeTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} />
                Transcript
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={excludeShorts} onChange={(e) => setExcludeShorts(e.target.checked)} />
                Exclude Shorts
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={useArchiveFile} onChange={(e) => setUseArchiveFile(e.target.checked)} />
                Prevent duplicates (archive)
              </label>
              <div className="mt-2 grid gap-2">
                <div className="text-xs font-semibold text-white/70">Concurrent fragments</div>
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={String(concurrentFragments)}
                  onChange={(e) => setConcurrentFragments(Math.max(1, Math.min(16, parseInt(e.target.value || "4", 10))))}
                />
                <div className="text-xs text-white/55">Number of fragments to download in parallel (1-16, default: 4)</div>
              </div>
            </div>
          </div>

          {isChannel ? (
            <div className="grid gap-2">
              <div className="text-sm font-semibold text-white/85">Channel limit</div>
              <div className="grid gap-2 md:grid-cols-3">
                <Input
                  type="number"
                  min={1}
                  value={String(maxVideos)}
                  onChange={(e) => setMaxVideos(Math.max(1, parseInt(e.target.value || "10", 10)))}
                />
                <div className="md:col-span-2 text-sm text-white/55">Downloads the newest N videos (still respects archive if enabled).</div>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
            <label className="flex items-center gap-2 text-sm font-semibold text-white/85">
              <Checkbox checked={createSchedule} onChange={(e) => setCreateSchedule(e.target.checked)} />
              Create scheduled download
            </label>
            {createSchedule ? (
              <div className="grid gap-3 md:grid-cols-3">
                <div className="grid gap-2">
                  <div className="text-xs font-semibold text-white/70">Every</div>
                  <Input
                    type="number"
                    min={1}
                    value={String(intervalValue)}
                    onChange={(e) => setIntervalValue(Math.max(1, parseInt(e.target.value || "1", 10)))}
                  />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs font-semibold text-white/70">Unit</div>
                  <Select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                  </Select>
                </div>
                <div className="text-sm text-white/55 md:mt-6">Checks for new videos automatically. Best for playlists/channels.</div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button onClick={start} disabled={busy}>
              {busy ? "Starting…" : "Start download"}
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="Scheduled downloads"
        right={
          <Button variant="ghost" onClick={() => loadSchedules()}>
            Refresh
          </Button>
        }
      >
        {schedules.length === 0 ? (
          <div className="text-sm text-white/60">No schedules yet.</div>
        ) : (
          <div className="grid gap-3">
            {schedules
              .slice()
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
              .map((s) => (
                <div key={s.id} className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-white">{s.isChannel ? "Channel" : s.isPlaylist ? "Playlist" : "Video"}</div>
                        <Badge tone={s.enabled ? "good" : "muted"}>{s.enabled ? "Active" : "Paused"}</Badge>
                        <Badge tone="muted">{s.audioOnly ? "Audio" : `Video ${s.resolution || "1080"}p`}</Badge>
                        <Badge tone="muted">{formatInterval(s.intervalMinutes)}</Badge>
                      </div>
                      <div className="mt-1 truncate text-xs text-white/55">{s.url}</div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                        <span>Collection: {s.collectionId ? collectionNameById.get(s.collectionId) || "Unknown" : "None"}</span>
                        <span>Path: {s.path || "auto"}</span>
                        <span>Next: {formatTime(s.nextRun)}</span>
                        {s.lastRun ? <span>Last: {formatTime(s.lastRun)}</span> : null}
                      </div>
                    </div>
                    <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          const r = await apiSend<{ success: boolean; message?: string }>(`/api/schedules/${s.id}`, "PUT", {
                            enabled: !s.enabled,
                          });
                          if (!r.ok) return props.showToast("bad", r.message);
                          await loadSchedules();
                        }}
                      >
                        {s.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button variant="ghost" onClick={() => setEditSchedule(s)}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm("Delete this schedule?")) return;
                          const scheduleId = s.id;
                          // Optimistically update UI immediately
                          setSchedules(prev => prev.filter(sched => sched.id !== scheduleId));
                          props.showToast("good", "Schedule deleted.");
                          const r = await apiSend<{ success: boolean; message?: string }>(`/api/schedules/${scheduleId}`, "DELETE");
                          if (!r.ok) {
                            // Revert on error
                            await loadSchedules();
                            return props.showToast("bad", r.message);
                          }
                          // Refresh to ensure consistency
                          await loadSchedules();
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Card>

      <CollectionsModal
        open={collectionsOpen}
        collections={collections}
        onClose={() => setCollectionsOpen(false)}
        onChanged={async () => {
          await loadCollections();
        }}
        onCollectionsUpdate={(updater) => {
          setCollections(updater);
        }}
        showToast={props.showToast}
      />

      <EditScheduleModal
        open={!!editSchedule}
        schedule={editSchedule}
        collections={collections}
        onClose={() => setEditSchedule(null)}
        onSaved={async () => {
          setEditSchedule(null);
          await loadSchedules();
          props.showToast("good", "Schedule updated.");
        }}
        showToast={props.showToast}
      />
    </div>
  );
}

function CollectionsModal(props: {
  open: boolean;
  collections: Collection[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onCollectionsUpdate: (updater: (prev: Collection[]) => Collection[]) => void;
  showToast: (tone: "good" | "bad", message: string) => void;
}) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [moveCollection, setMoveCollection] = useState<Collection | null>(null);
  const [mergeSource, setMergeSource] = useState<Collection | null>(null);

  function suggestedRootPath(n: string) {
    const trimmed = n.trim();
    if (!trimmed) return "/downloads/<collection>";
    // Keep it simple: server will also sanitize, this is just a UX hint.
    const safe = trimmed
      .replace(/[\/\\]/g, "-")
      .replace(/[^a-zA-Z0-9 _.-]/g, "")
      .trim()
      .replace(/\s+/g, " ");
    return `/downloads/${safe || "collection"}`;
  }

  return (
    <Modal open={props.open} title="Collections" onClose={props.onClose}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          {props.collections.length === 0 ? (
            <div className="text-sm text-white/60">No collections yet.</div>
          ) : (
            props.collections
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <div key={c.id} className="flex flex-col gap-3 rounded-xl bg-white/3 px-4 py-3 ring-1 ring-white/8 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{c.name}</div>
                    <div className="truncate text-xs text-white/55">{c.rootPath}</div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2 sm:justify-start">
                    <Button
                      variant="ghost"
                      onClick={() => setMoveCollection(c)}
                    >
                      Move/Rename
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setMergeSource(c)}
                    >
                      Merge
                    </Button>
                    <Button
                      variant="danger"
                      onClick={async () => {
                        if (!window.confirm(`Delete collection "${c.name}"? This will remove all videos in this collection and their files. This cannot be undone.`)) return;
                        const collectionId = c.id;
                        const collectionName = c.name;
                        // Optimistically update UI immediately
                        props.onCollectionsUpdate(prev => prev.filter(col => col.id !== collectionId));
                        props.showToast("good", `Collection "${collectionName}" deleted.`);
                        const r = await apiSend<{ success: boolean; message?: string; deletedVideos?: number }>(`/api/collections/${collectionId}`, "DELETE");
                        if (!r.ok) {
                          // Revert on error
                          await props.onChanged();
                          return props.showToast("bad", r.message);
                        }
                        const videoCount = r.data.deletedVideos ?? 0;
                        if (videoCount > 0) {
                          props.showToast("good", `Collection deleted. ${videoCount} videos removed.`);
                        }
                        // Refresh to ensure consistency
                        await props.onChanged();
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
          <div className="text-sm font-semibold text-white">Create collection</div>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Name</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Movies" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-white/70">Root path (optional)</div>
                <button
                  type="button"
                  className="text-xs font-semibold text-sky-300 hover:text-sky-200"
                  onClick={() => setRootPath(suggestedRootPath(name))}
                >
                  Use suggested
                </button>
              </div>
              <Input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder={suggestedRootPath(name)} />
              <div className="text-xs text-white/55">If empty, defaults to {suggestedRootPath(name)}.</div>
            </div>
            <div className="flex items-center justify-end">
              <Button
                disabled={busy}
                onClick={async () => {
                  const n = name.trim();
                  const r = rootPath.trim();
                  if (!n) return props.showToast("bad", "Name is required.");
                  setBusy(true);
                  try {
                    const payload: { name: string; rootPath?: string } = { name: n };
                    if (r) payload.rootPath = r;
                    const res = await apiSend<{ success: boolean; message?: string }>("/api/collections", "POST", payload);
                    if (!res.ok) return props.showToast("bad", res.message);
                    props.showToast("good", "Collection created.");
                    setName("");
                    setRootPath("");
                    await props.onChanged();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      </div>

      <MoveCollectionModal
        open={!!moveCollection}
        collection={moveCollection}
        onClose={() => setMoveCollection(null)}
        onMoved={async () => {
          setMoveCollection(null);
          await props.onChanged();
        }}
        showToast={props.showToast}
      />

      <MergeCollectionModal
        open={!!mergeSource}
        sourceCollection={mergeSource}
        collections={props.collections.filter(c => c.id !== mergeSource?.id)}
        onClose={() => setMergeSource(null)}
        onMerged={async () => {
          setMergeSource(null);
          await props.onChanged();
        }}
        showToast={props.showToast}
      />
    </Modal>
  );
}

function MoveCollectionModal(props: {
  open: boolean;
  collection: Collection | null;
  onClose: () => void;
  onMoved: () => Promise<void>;
  showToast: (tone: "good" | "bad", message: string) => void;
}) {
  const c = props.collection;
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (c) {
      setName(c.name);
      setRootPath(c.rootPath);
    }
  }, [c]);

  function suggestedRootPath(n: string) {
    const trimmed = n.trim();
    if (!trimmed) return "/downloads/<collection>";
    const safe = trimmed
      .replace(/[\/\\]/g, "-")
      .replace(/[^a-zA-Z0-9 _.-]/g, "")
      .trim()
      .replace(/\s+/g, " ");
    return `/downloads/${safe || "collection"}`;
  }

  return (
    <Modal open={props.open} title={`Move/Rename: ${c?.name || ""}`} onClose={props.onClose}>
      {!c ? null : (
        <div className="grid gap-4">
          <div className="text-xs text-white/60">
            Change the collection name and/or path. All videos and files will be moved to the new location.
          </div>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Name</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-white/70">Root path</div>
                <button
                  type="button"
                  className="text-xs font-semibold text-sky-300 hover:text-sky-200"
                  onClick={() => setRootPath(suggestedRootPath(name))}
                >
                  Use suggested
                </button>
              </div>
              <Input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder={suggestedRootPath(name)} />
              <div className="text-xs text-white/55">Current: {c.rootPath}</div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const n = name.trim();
                const r = rootPath.trim();
                if (!n) return props.showToast("bad", "Name is required.");
                if (!r) return props.showToast("bad", "Root path is required.");
                setBusy(true);
                try {
                  const res = await apiSend<{ success: boolean; collection?: Collection; message?: string }>(
                    `/api/collections/${c.id}/move`,
                    "POST",
                    { name: n, rootPath: r }
                  );
                  if (!res.ok) return props.showToast("bad", res.message);
                  if (!res.data.success) return props.showToast("bad", res.data.message || "Failed to move collection");
                  props.showToast("good", "Collection moved successfully.");
                  await props.onMoved();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Move
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MergeCollectionModal(props: {
  open: boolean;
  sourceCollection: Collection | null;
  collections: Collection[];
  onClose: () => void;
  onMerged: () => Promise<void>;
  showToast: (tone: "good" | "bad", message: string) => void;
}) {
  const source = props.sourceCollection;
  const [targetId, setTargetId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.collections.length > 0 && !targetId) {
      setTargetId(props.collections[0].id);
    }
  }, [props.collections, targetId]);

  return (
    <Modal open={props.open} title={`Merge: ${source?.name || ""}`} onClose={props.onClose}>
      {!source ? null : (
        <div className="grid gap-4">
          <div className="text-xs text-white/60">
            Merge "{source.name}" into another collection. All videos and files will be moved to the target collection, and this collection will be deleted.
          </div>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Target collection</div>
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {props.collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.rootPath})
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy || !targetId}
              onClick={async () => {
                if (!targetId) return;
                if (!window.confirm(`Merge "${source.name}" into the selected collection? This will move all videos and delete "${source.name}". This cannot be undone.`)) return;
                setBusy(true);
                try {
                  const res = await apiSend<{ success: boolean; collection?: Collection; message?: string }>(
                    `/api/collections/${source.id}/merge`,
                    "POST",
                    { targetId }
                  );
                  if (!res.ok) return props.showToast("bad", res.message);
                  if (!res.data.success) return props.showToast("bad", res.data.message || "Failed to merge collection");
                  props.showToast("good", "Collection merged successfully.");
                  await props.onMerged();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Merge
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditScheduleModal(props: {
  open: boolean;
  schedule: Schedule | null;
  collections: Collection[];
  onClose: () => void;
  onSaved: () => void;
  showToast: (tone: "good" | "bad", message: string) => void;
}) {
  const s = props.schedule;
  const [collectionId, setCollectionId] = useState<string>("");
  const [intervalValue, setIntervalValue] = useState<number>(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("days");
  const [audioOnly, setAudioOnly] = useState(false);
  const [resolution, setResolution] = useState<"1080" | "720">("1080");
  const [maxVideos, setMaxVideos] = useState<number>(10);
  const [includeThumbnail, setIncludeThumbnail] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [excludeShorts, setExcludeShorts] = useState(true);
  const [useArchiveFile, setUseArchiveFile] = useState(true);
  const [concurrentFragments, setConcurrentFragments] = useState<number>(4);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!s) return;
    setCollectionId(s.collectionId || "");
    const conv = { ...{ value: 1, unit: "days" as IntervalUnit }, ...(() => {
      const mins = s.intervalMinutes || 1440;
      if (mins < 1440) return { value: Math.max(1, Math.floor(mins / 60)), unit: "hours" as IntervalUnit };
      if (mins < 10080) return { value: Math.max(1, Math.floor(mins / 1440)), unit: "days" as IntervalUnit };
      if (mins < 43200) return { value: Math.max(1, Math.floor(mins / 10080)), unit: "weeks" as IntervalUnit };
      return { value: Math.max(1, Math.floor(mins / 43200)), unit: "months" as IntervalUnit };
    })() };
    setIntervalValue(conv.value);
    setIntervalUnit(conv.unit);
    setAudioOnly(!!s.audioOnly);
    setResolution((s.resolution || "1080") as "1080" | "720");
    setMaxVideos(s.maxVideos || 10);
    setIncludeThumbnail(s.includeThumbnail ?? !s.audioOnly);
    setIncludeTranscript(s.includeTranscript ?? !s.audioOnly);
    setExcludeShorts(s.excludeShorts ?? true);
    setUseArchiveFile(s.useArchiveFile ?? true);
    setConcurrentFragments(s.concurrentFragments ?? 4);
  }, [s]);

  return (
    <Modal open={props.open} title="Edit schedule" onClose={props.onClose}>
      {!s ? null : (
        <div className="grid gap-4">
          <div className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
            <div className="text-xs font-semibold text-white/70">URL</div>
            <div className="mt-1 truncate text-sm text-white/85">{s.url}</div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Collection</div>
              <Select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="">None (downloads root)</option>
                {props.collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Interval</div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="number"
                  min={1}
                  value={String(intervalValue)}
                  onChange={(e) => setIntervalValue(Math.max(1, parseInt(e.target.value || "1", 10)))}
                />
                <Select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="weeks">Weeks</option>
                  <option value="months">Months</option>
                </Select>
              </div>
            </div>
          </div>

          {s.isChannel ? (
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Max videos</div>
              <Input type="number" min={1} value={String(maxVideos)} onChange={(e) => setMaxVideos(Math.max(1, parseInt(e.target.value || "10", 10)))} />
            </div>
          ) : null}

          <div className="grid gap-3 rounded-xl bg-white/3 p-4 ring-1 ring-white/8 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Format</div>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={!audioOnly} onChange={() => setAudioOnly(false)} />
                Video
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Radio checked={audioOnly} onChange={() => setAudioOnly(true)} />
                Audio (MP3)
              </label>
              <div className={cx("mt-2 grid gap-2", audioOnly ? "opacity-50" : "")}>
                <div className="text-xs font-semibold text-white/70">Resolution</div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-white/75">
                    <Radio checked={resolution === "1080"} disabled={audioOnly} onChange={() => setResolution("1080")} />
                    1080p
                  </label>
                  <label className="flex items-center gap-2 text-sm text-white/75">
                    <Radio checked={resolution === "720"} disabled={audioOnly} onChange={() => setResolution("720")} />
                    720p
                  </label>
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Options</div>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={includeThumbnail} onChange={(e) => setIncludeThumbnail(e.target.checked)} />
                Thumbnail
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={includeTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} />
                Transcript
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={excludeShorts} onChange={(e) => setExcludeShorts(e.target.checked)} />
                Exclude Shorts
              </label>
              <label className="flex items-center gap-2 text-sm text-white/75">
                <Checkbox checked={useArchiveFile} onChange={(e) => setUseArchiveFile(e.target.checked)} />
                Prevent duplicates (archive)
              </label>
              <div className="mt-2 grid gap-2">
                <div className="text-xs font-semibold text-white/70">Concurrent fragments</div>
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={String(concurrentFragments)}
                  onChange={(e) => setConcurrentFragments(Math.max(1, Math.min(16, parseInt(e.target.value || "4", 10))))}
                />
                <div className="text-xs text-white/55">Number of fragments to download in parallel (1-16, default: 4)</div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!s) return;
                setBusy(true);
                try {
                  const updates: Partial<Schedule> = {
                    intervalMinutes: toMinutes(intervalValue, intervalUnit),
                    audioOnly,
                    resolution: audioOnly ? undefined : resolution,
                    maxVideos: s.isChannel ? maxVideos : undefined,
                    includeThumbnail,
                    includeTranscript,
                    excludeShorts,
                    useArchiveFile,
                    concurrentFragments,
                    // Send empty string to intentionally clear.
                    collectionId,
                  };
                  const payload = normalizeScheduleUpdates(updates);
                  const r = await apiSend<{ success: boolean; message?: string }>(`/api/schedules/${s.id}`, "PUT", payload);
                  if (!r.ok) return props.showToast("bad", r.message);
                  props.onSaved();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TrackingPage(props: { showToast: (tone: "good" | "bad", message: string) => void }) {
  const [tab, setTab] = useState<TrackingTab>(() => getTrackingTabFromHash() || "videos");
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);
  const [videos, setVideos] = useState<TrackedVideo[]>([]);
  const [channels, setChannels] = useState<TrackedChannel[]>([]);
  const [playlists, setPlaylists] = useState<TrackedPlaylist[]>([]);
  const [q, setQ] = useState("");
  const [logsById, setLogsById] = useState<Record<string, { loading: boolean; log?: string; error?: string }>>({});
  const [videoLogIds, setVideoLogIds] = useState<Record<string, string[]>>({});
  const [expandedVideos, setExpandedVideos] = useState<Set<string>>(new Set());

  // Keep tracking tab in the hash so refresh/back keeps your place.
  useEffect(() => {
    if (!window.location.hash.startsWith("#tracking")) return;
    const desired = tab === "videos" ? "#tracking" : `#tracking/${tab}`;
    if (window.location.hash !== desired) window.history.replaceState(null, "", desired);
    try {
      window.localStorage.setItem("yt_tracking_tab", tab);
    } catch {
      // ignore
    }
  }, [tab]);

  // Respond to back/forward changes between tracking tabs.
  useEffect(() => {
    const onHashChange = () => {
      const fromHash = getTrackingTabFromHash();
      if (fromHash) setTab(fromHash);
      if (window.location.hash === "#tracking") setTab("videos");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function ensureLogs(id: string) {
    setLogsById((prev) => {
      const cur = prev[id];
      if (cur?.loading || typeof cur?.log === "string" || typeof cur?.error === "string") return prev;
      return { ...prev, [id]: { loading: true } };
    });

    const res = await apiGet<DownloadLogResponse>(`/api/downloads/logs/${id}`);
    if (res.ok && res.data.success) {
      setLogsById((prev) => ({ ...prev, [id]: { loading: false, log: res.data.log || "" } }));
      return;
    }
    setLogsById((prev) => ({
      ...prev,
      [id]: { loading: false, error: res.ok ? res.data.message || "Failed to load logs" : res.message },
    }));
  }

  async function findLogsForVideo(videoId: string) {
    if (videoLogIds[videoId]) return; // Already loaded
    const res = await apiGet<{ success: boolean; downloadIds?: string[]; message?: string }>(`/api/downloads/logs/by-video/${videoId}`);
    if (res.ok && res.data.success && res.data.downloadIds) {
      setVideoLogIds((prev) => ({ ...prev, [videoId]: res.data.downloadIds || [] }));
    }
  }

  async function loadAll() {
    const res = await apiGet<{
      success: true;
      videos: TrackedVideo[];
      channels: TrackedChannel[];
      playlists: TrackedPlaylist[];
    }>("/api/tracker/all");
    if (!res.ok) return;
    if (res.data.success) {
      setVideos(res.data.videos || []);
      setChannels(res.data.channels || []);
      setPlaylists(res.data.playlists || []);
    }
  }

  async function loadDownloads() {
    const res = await apiGet<{ success: true; downloads: DownloadStatus[] }>("/api/downloads/status");
    if (!res.ok) return;
    if (res.data.success) setDownloads(res.data.downloads || []);
  }

  useEffect(() => {
    loadAll();
    loadDownloads();
  }, []);

  useInterval(() => loadDownloads(), 2000);
  useInterval(() => loadAll(), 30_000);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return { videos, channels, playlists };
    return {
      videos: videos.filter((v) => `${v.title} ${v.channel} ${v.relativePath} ${v.id}`.toLowerCase().includes(query)),
      channels: channels.filter((c) => `${c.channelName} ${c.relativePath} ${c.url}`.toLowerCase().includes(query)),
      playlists: playlists.filter((p) => `${p.playlistName} ${p.relativePath} ${p.url}`.toLowerCase().includes(query)),
    };
  }, [q, videos, channels, playlists]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Active downloads">
          {downloads.length === 0 ? (
            <div className="text-sm text-white/60">No active downloads.</div>
          ) : (
            <div className="grid gap-3">
              {downloads.map((d) => (
                <div key={d.id} className="rounded-xl bg-white/3 p-3 ring-1 ring-white/8">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-semibold">{d.title || d.url}</div>
                    <Badge
                      tone={
                        d.status === "completed" ? "good" : d.status === "failed" ? "bad" : d.status === "processing" ? "warn" : "muted"
                      }
                    >
                      {d.status}
                    </Badge>
                  </div>
                  <div className="mt-1 grid gap-1 text-xs text-white/55">
                    <div className="truncate">{d.channel ? `Channel: ${d.channel}` : d.url}</div>
                    <div className="hidden truncate sm:block">Output: {d.outputPath}</div>
                    {d.finalFile || d.currentFile ? (
                      <div className="truncate">
                        File: {d.finalFile || d.currentFile}
                        {d.finalPath || d.currentPath ? ` (${d.finalPath || d.currentPath})` : ""}
                      </div>
                    ) : null}
                  </div>
                  {typeof d.progress === "number" ? (
                    <div className="mt-2">
                      <div className="h-2 overflow-hidden rounded bg-white/5 ring-1 ring-white/10">
                        <div className="h-full bg-sky-400/70" style={{ width: `${Math.max(0, Math.min(100, d.progress))}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-white/55">{d.progress}%</div>
                    </div>
                  ) : null}

                  <details
                    className="mt-3 rounded-lg bg-black/20 ring-1 ring-white/10"
                    onToggle={(e) => {
                      const el = e.currentTarget;
                      if (el.open) void ensureLogs(d.id);
                    }}
                  >
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-white/70 hover:text-white">
                      yt-dlp logs
                    </summary>
                    <div className="px-3 pb-3">
                      {logsById[d.id]?.loading ? <div className="text-xs text-white/60">Loading…</div> : null}
                      {logsById[d.id]?.error ? <div className="text-xs text-red-200">{logsById[d.id]?.error}</div> : null}
                      {typeof logsById[d.id]?.log === "string" ? (
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[11px] leading-relaxed text-white/80 ring-1 ring-white/10">
                          {logsById[d.id]?.log || "(empty)"}
                        </pre>
                      ) : null}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="md:col-span-3 grid gap-4">
          <Card
            title="Library"
            right={
              <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:grid-cols-none sm:auto-cols-max sm:grid-flow-col">
                <Button className="w-full" variant={tab === "videos" ? "primary" : "ghost"} onClick={() => setTab("videos")}>
                  Videos
                </Button>
                <Button className="w-full" variant={tab === "channels" ? "primary" : "ghost"} onClick={() => setTab("channels")}>
                  Channels
                </Button>
                <Button className="w-full" variant={tab === "playlists" ? "primary" : "ghost"} onClick={() => setTab("playlists")}>
                  Playlists
                </Button>
              </div>
            }
          >
            <div className="grid gap-3">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" />

              {tab === "videos" ? (
                <div className="grid gap-2">
                  {filtered.videos
                    .slice()
                    .sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0))
                    .slice(0, 200)
                    .map((v) => {
                      const videoKey = `${v.id}:${v.relativePath}`;
                      const isExpanded = expandedVideos.has(videoKey);
                      const logIds = videoLogIds[v.id] || [];
                      return (
                        <div key={videoKey} className={cx("rounded-xl bg-white/3 p-4 ring-1 ring-white/8 overflow-hidden", v.deleted ? "opacity-60" : "")}>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="truncate text-sm font-semibold">{v.title}</div>
                                <Badge tone="muted">{v.format === "audio" ? "Audio" : `Video ${v.resolution || ""}`.trim()}</Badge>
                                {v.deleted ? <Badge tone="bad">Deleted</Badge> : null}
                              </div>
                              <div className="mt-1 truncate text-xs text-white/55">
                                {v.channel} · {v.relativePath}
                              </div>
                              <div className="mt-1 text-xs text-white/55">
                                <span className="truncate block">File: {v.fullPath ? v.fullPath.split("/").pop() : "unknown"}</span>
                                <span className="hidden sm:inline">
                                  {" "}
                                  · <span className="break-all">{v.fullPath}</span>
                                </span>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                                <span>Size: {formatBytes(v.fileSize)}</span>
                                <span>Duration: {formatDuration(v.duration)}</span>
                                <span>Downloaded: {formatTime(v.downloadedAt)}</span>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <a className="text-sm font-semibold text-sky-300 hover:text-sky-200" href={v.url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  const newExpanded = new Set(expandedVideos);
                                  if (isExpanded) {
                                    newExpanded.delete(videoKey);
                                  } else {
                                    newExpanded.add(videoKey);
                                    void findLogsForVideo(v.id);
                                  }
                                  setExpandedVideos(newExpanded);
                                }}
                              >
                                {isExpanded ? "Hide details" : "Show details"}
                              </Button>
                              <Button
                                variant="danger"
                                onClick={async () => {
                                  if (!window.confirm(`Delete "${v.title}"? This will remove all associated files and cannot be undone.`)) return;
                                  const videoKey = `${v.id}:${v.relativePath}`;
                                  const videoId = v.id;
                                  const relativePath = v.relativePath;
                                  // Optimistically update UI immediately
                                  setVideos(prev => prev.filter(vid => `${vid.id}:${vid.relativePath}` !== videoKey));
                                  props.showToast("good", "Video deleted.");
                                  const r = await apiSend<{ success: boolean; message?: string }>(
                                    `/api/tracker/videos/${encodeURIComponent(videoId)}?relativePath=${encodeURIComponent(relativePath)}`,
                                    "DELETE"
                                  );
                                  if (!r.ok) {
                                    // Revert on error
                                    await loadAll();
                                    return props.showToast("bad", r.message);
                                  }
                                  // Refresh to ensure consistency
                                  await loadAll();
                                }}
                              >
                                Delete
                              </Button>
                            </div>
                          </div>

                          {isExpanded ? (
                            <div className="mt-4 grid gap-4 rounded-lg bg-black/20 p-4 ring-1 ring-white/10">
                              <div className="grid gap-3 text-xs">
                                <div className="grid gap-1">
                                  <div className="font-semibold text-white/85">Video Information</div>
                                  <div className="grid gap-1 pl-2 text-white/70">
                                    <div>Video ID: <span className="font-mono text-white/85">{v.id}</span></div>
                                    <div>Title: <span className="text-white/85">{v.title}</span></div>
                                    <div>Channel: <span className="text-white/85">{v.channel}</span></div>
                                    {v.channelId ? <div>Channel ID: <span className="font-mono text-white/85">{v.channelId}</span></div> : null}
                                    <div>URL: <a href={v.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200 break-all">{v.url}</a></div>
                                  </div>
                                </div>

                                <div className="grid gap-1">
                                  <div className="font-semibold text-white/85">Download Details</div>
                                  <div className="grid gap-1 pl-2 text-white/70">
                                    <div>Format: <span className="text-white/85">{v.format === "audio" ? "Audio (MP3)" : `Video (${v.resolution || "1080"}p)`}</span></div>
                                    <div>Downloaded: <span className="text-white/85">{formatTime(v.downloadedAt)}</span></div>
                                    {v.deleted ? (
                                      <>
                                        <div>Status: <span className="text-red-300">Deleted</span></div>
                                        {v.deletedAt ? <div>Deleted at: <span className="text-white/85">{formatTime(v.deletedAt)}</span></div> : null}
                                      </>
                                    ) : (
                                      <div>Status: <span className="text-green-300">Available</span></div>
                                    )}
                                  </div>
                                </div>

                                <div className="grid gap-1">
                                  <div className="font-semibold text-white/85">File Information</div>
                                  <div className="grid gap-1 pl-2 text-white/70">
                                    <div>Full Path: <span className="font-mono break-all text-white/85">{v.fullPath}</span></div>
                                    <div>Relative Path: <span className="font-mono text-white/85">{v.relativePath}</span></div>
                                    {v.fileSize ? <div>File Size: <span className="text-white/85">{formatBytes(v.fileSize)}</span></div> : null}
                                    {v.duration ? <div>Duration: <span className="text-white/85">{formatDuration(v.duration)}</span></div> : null}
                                  </div>
                                </div>

                                {v.files && v.files.length > 0 ? (
                                  <div className="grid gap-1">
                                    <div className="font-semibold text-white/85">Associated Files ({v.files.length})</div>
                                    <div className="grid gap-1 pl-2 max-h-48 overflow-auto">
                                      {v.files
                                        .filter((f) => !f.hidden)
                                        .map((f, idx) => (
                                          <div key={idx} className="text-white/70">
                                            <span className={cx("font-mono text-xs", f.exists ? "text-white/85" : "text-white/50 line-through")}>
                                              {f.path.split("/").pop()}
                                            </span>
                                            <span className="ml-2 text-white/50">
                                              ({f.kind}
                                              {f.intermediate ? ", intermediate" : ""}
                                              {!f.exists ? ", deleted" : ""})
                                            </span>
                                          </div>
                                        ))}
                                    </div>
                                  </div>
                                ) : null}

                                {v.ytdlpCommand ? (
                                  <div className="grid gap-1">
                                    <div className="font-semibold text-white/85">yt-dlp Command</div>
                                    <div className="pl-2">
                                      <pre className="overflow-x-auto rounded bg-black/30 p-2 text-[10px] font-mono text-white/80 ring-1 ring-white/10">
                                        {v.ytdlpCommand}
                                      </pre>
                                    </div>
                                  </div>
                                ) : null}

                                {logIds.length > 0 ? (
                                  <div className="grid gap-1">
                                    <div className="font-semibold text-white/85">Download Logs</div>
                                    <div className="grid gap-2 pl-2">
                                      {logIds.map((logId) => (
                                        <details
                                          key={logId}
                                          className="rounded-lg bg-black/20 ring-1 ring-white/10"
                                          onToggle={(e) => {
                                            if (e.currentTarget.open) void ensureLogs(logId);
                                          }}
                                        >
                                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-white/70 hover:text-white">
                                            Log: {logId}
                                          </summary>
                                          <div className="px-3 pb-3">
                                            {logsById[logId]?.loading ? <div className="text-xs text-white/60">Loading…</div> : null}
                                            {logsById[logId]?.error ? <div className="text-xs text-red-200">{logsById[logId]?.error}</div> : null}
                                            {typeof logsById[logId]?.log === "string" ? (
                                              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[11px] leading-relaxed text-white/80 ring-1 ring-white/10">
                                                {logsById[logId]?.log || "(empty)"}
                                              </pre>
                                            ) : null}
                                          </div>
                                        </details>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-xs text-white/50">No download logs found for this video</div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              ) : null}

              {tab === "channels" ? (
                <div className="grid gap-2">
                  {filtered.channels
                    .slice()
                    .sort((a, b) => (b.lastDownloadedAt || b.downloadedAt || 0) - (a.lastDownloadedAt || a.downloadedAt || 0))
                    .slice(0, 200)
                    .map((c) => (
                      <div key={c.id} className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8 overflow-hidden">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold">{c.channelName}</div>
                              <Badge tone="muted">{c.videoCount} videos</Badge>
                              {c.maxVideos ? <Badge tone="muted">max {c.maxVideos}</Badge> : null}
                            </div>
                            <div className="mt-1 truncate text-xs text-white/55">{c.relativePath}</div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                              <span>First: {formatTime(c.downloadedAt)}</span>
                              {c.lastDownloadedAt ? <span>Last: {formatTime(c.lastDownloadedAt)}</span> : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <a className="text-sm font-semibold text-sky-300 hover:text-sky-200" href={c.url} target="_blank" rel="noreferrer">
                              Open
                            </a>
                            <Button
                              variant="danger"
                              onClick={async () => {
                                if (!window.confirm(`Delete channel "${c.channelName}"? This will remove all ${c.videoCount} videos and their files. This cannot be undone.`)) return;
                                const channelId = c.id;
                                const channelName = c.channelName;
                                const channelIdForVideos = c.channelId;
                                // Optimistically update UI immediately
                                setChannels(prev => prev.filter(ch => ch.id !== channelId));
                                // Also remove videos from this channel from the videos list
                                setVideos(prev => prev.filter(v => v.channelId !== channelIdForVideos && v.channel !== channelName));
                                props.showToast("good", "Channel and all videos deleted.");
                                const r = await apiSend<{ success: boolean; message?: string }>(`/api/tracker/channels/${channelId}`, "DELETE");
                                if (!r.ok) {
                                  // Revert on error
                                  await loadAll();
                                  return props.showToast("bad", r.message);
                                }
                                // Refresh to ensure consistency
                                await loadAll();
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ) : null}

              {tab === "playlists" ? (
                <div className="grid gap-2">
                  {filtered.playlists
                    .slice()
                    .sort((a, b) => (b.lastDownloadedAt || b.downloadedAt || 0) - (a.lastDownloadedAt || a.downloadedAt || 0))
                    .slice(0, 200)
                    .map((p) => (
                      <div key={p.id} className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8 overflow-hidden">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold">{p.playlistName}</div>
                              <Badge tone="muted">{p.videoCount} videos</Badge>
                            </div>
                            <div className="mt-1 truncate text-xs text-white/55">{p.relativePath}</div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                              <span>First: {formatTime(p.downloadedAt)}</span>
                              {p.lastDownloadedAt ? <span>Last: {formatTime(p.lastDownloadedAt)}</span> : null}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <a className="text-sm font-semibold text-sky-300 hover:text-sky-200" href={p.url} target="_blank" rel="noreferrer">
                              Open
                            </a>
                            <Button
                              variant="danger"
                              onClick={async () => {
                                if (!window.confirm(`Delete playlist "${p.playlistName}"? This will remove all ${p.videoCount} videos and their files. This cannot be undone.`)) return;
                                const playlistId = p.id;
                                // Optimistically update UI immediately
                                setPlaylists(prev => prev.filter(pl => pl.id !== playlistId));
                                props.showToast("good", "Playlist and all videos deleted.");
                                const r = await apiSend<{ success: boolean; message?: string }>(`/api/tracker/playlists/${playlistId}`, "DELETE");
                                if (!r.ok) {
                                  // Revert on error
                                  await loadAll();
                                  return props.showToast("bad", r.message);
                                }
                                // Refresh to ensure consistency
                                await loadAll();
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DeveloperPage(props: { showToast: (tone: "good" | "bad", message: string) => void }) {
  const [testRunning, setTestRunning] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [concurrentFragments, setConcurrentFragments] = useState<number>(4);
  const [resolution, setResolution] = useState<"1080" | "720">("720");
  const [testResult, setTestResult] = useState<{
    collection?: Collection;
    downloads?: Array<{ videoId: string; url: string; success: boolean; message?: string }>;
    message?: string;
  } | null>(null);
  const [cleanupResult, setCleanupResult] = useState<{
    message?: string;
    deletedCollection?: boolean;
    deletedFiles?: number;
    deletedTrackedVideos?: number;
  } | null>(null);

  async function runTest() {
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await apiSend<{
        success: boolean;
        collection?: Collection;
        downloads?: Array<{ videoId: string; url: string; success: boolean; message?: string }>;
        message?: string;
      }>("/api/dev/test", "POST", {
        concurrentFragments,
        resolution,
      });
      
      if (res.ok && res.data.success) {
        setTestResult(res.data);
        props.showToast("good", res.data.message || "Test started successfully");
      } else {
        props.showToast("bad", res.ok ? res.data.message || "Test failed" : res.message);
      }
    } catch (error: any) {
      props.showToast("bad", error?.message || "Failed to run test");
    } finally {
      setTestRunning(false);
    }
  }

  async function runCleanup() {
    if (!window.confirm("Delete all test files and collection? This cannot be undone.")) {
      return;
    }
    
    setCleanupRunning(true);
    setCleanupResult(null);
    try {
      const res = await apiSend<{
        success: boolean;
        message?: string;
        deletedCollection?: boolean;
        deletedFiles?: number;
        deletedTrackedVideos?: number;
      }>("/api/dev/cleanup", "POST");
      
      if (res.ok && res.data.success) {
        setCleanupResult(res.data);
        props.showToast("good", res.data.message || "Cleanup completed");
      } else {
        props.showToast("bad", res.ok ? res.data.message || "Cleanup failed" : res.message);
      }
    } catch (error: any) {
      props.showToast("bad", error?.message || "Failed to cleanup");
    } finally {
      setCleanupRunning(false);
    }
  }

  return (
    <div className="grid gap-6">
      <SectionHeader
        title="Developer Tools"
        subtitle="Test collection creation and video downloads, then clean up test files"
      />

      <Card>
        <div className="grid gap-4">
          <div>
            <div className="text-sm font-semibold text-white/85">Test Functionality</div>
            <div className="mt-1 text-xs text-white/55">
              Creates a test collection and downloads a few short videos to verify the main functionality works correctly.
            </div>
          </div>

          <div className="grid gap-3 rounded-xl bg-white/3 p-4 ring-1 ring-white/8 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Quality Settings</div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-white/75">
                  <Radio checked={resolution === "1080"} onChange={() => setResolution("1080")} />
                  1080p
                </label>
                <label className="flex items-center gap-2 text-sm text-white/75">
                  <Radio checked={resolution === "720"} onChange={() => setResolution("720")} />
                  720p
                </label>
              </div>
            </div>
            <div className="grid gap-2">
              <div className="text-xs font-semibold text-white/70">Concurrent fragments</div>
              <Input
                type="number"
                min={1}
                max={16}
                value={String(concurrentFragments)}
                onChange={(e) => setConcurrentFragments(Math.max(1, Math.min(16, parseInt(e.target.value || "4", 10))))}
              />
              <div className="text-xs text-white/55">Number of fragments to download in parallel (1-16, default: 4)</div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button onClick={runTest} disabled={testRunning}>
              {testRunning ? "Running test…" : "Run Test"}
            </Button>
          </div>

          {testResult ? (
            <div className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
              <div className="text-sm font-semibold text-white/85 mb-2">Test Results</div>
              {testResult.collection ? (
                <div className="mb-3 text-xs text-white/70">
                  <div>Collection: <span className="text-white/85">{testResult.collection.name}</span></div>
                  <div>Path: <span className="text-white/85 font-mono">{testResult.collection.rootPath}</span></div>
                </div>
              ) : null}
              {testResult.downloads ? (
                <div className="text-xs text-white/70">
                  <div className="font-semibold mb-1">Downloads:</div>
                  {testResult.downloads.map((d, idx) => (
                    <div key={idx} className="ml-2 mb-1">
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
                        {d.videoId}
                      </a>
                      {" "}
                      <Badge tone={d.success ? "good" : "bad"}>
                        {d.success ? "Started" : "Failed"}
                      </Badge>
                      {d.message ? <span className="ml-2 text-white/55">({d.message})</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {testResult.message ? (
                <div className="mt-2 text-xs text-white/70">{testResult.message}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="grid gap-4">
          <div>
            <div className="text-sm font-semibold text-white/85">Cleanup Test Files</div>
            <div className="mt-1 text-xs text-white/55">
              Deletes the test collection, all downloaded test files, and removes tracked videos from the database.
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="danger" onClick={runCleanup} disabled={cleanupRunning}>
              {cleanupRunning ? "Cleaning up…" : "Delete Test Files"}
            </Button>
          </div>

          {cleanupResult ? (
            <div className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
              <div className="text-sm font-semibold text-white/85 mb-2">Cleanup Results</div>
              <div className="text-xs text-white/70">
                {cleanupResult.deletedCollection !== undefined ? (
                  <div>Collection deleted: <span className="text-white/85">{cleanupResult.deletedCollection ? "Yes" : "No"}</span></div>
                ) : null}
                {cleanupResult.deletedFiles !== undefined ? (
                  <div>Files removed: <span className="text-white/85">{cleanupResult.deletedFiles}</span></div>
                ) : null}
                {cleanupResult.deletedTrackedVideos !== undefined ? (
                  <div>Tracked videos removed: <span className="text-white/85">{cleanupResult.deletedTrackedVideos}</span></div>
                ) : null}
                {cleanupResult.message ? (
                  <div className="mt-2">{cleanupResult.message}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

