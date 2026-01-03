import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiSend,
  defaultsForFormat,
  normalizeScheduleUpdates,
  type Collection,
  type DownloadRequest,
  type DownloadStatus,
  type Schedule,
  type TrackerStats,
  type TrackedChannel,
  type TrackedPlaylist,
  type TrackedVideo,
} from "./lib/api";
import { formatBytes, formatDuration, formatInterval, formatTime, toMinutes, type IntervalUnit } from "./lib/format";
import { isChannelInput, isPlaylistInput } from "./lib/youtube-detect";
import { Badge, Button, Card, Checkbox, Input, Modal, Radio, Select, Toast, cx } from "./components/ui";

type Page = "downloads" | "tracking";
type TrackingTab = "videos" | "channels" | "playlists";

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
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-lg font-semibold text-white">{props.title}</div>
        {props.subtitle ? <div className="mt-1 text-sm text-white/60">{props.subtitle}</div> : null}
      </div>
      {props.right}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("downloads");
  const [toast, setToast] = useState<{ tone: "good" | "bad"; message: string } | null>(null);

  const showToast = (tone: "good" | "bad", message: string) => setToast({ tone, message });

  return (
    <div className="min-h-dvh bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
              <span className="text-sm font-bold">YT</span>
            </div>
            <div>
              <div className="text-base font-semibold leading-tight">YouTube Download Manager</div>
              <div className="text-xs text-white/55">Fast queueing + schedules + tracking</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant={page === "downloads" ? "primary" : "ghost"} onClick={() => setPage("downloads")}>
              Downloads
            </Button>
            <Button variant={page === "tracking" ? "primary" : "ghost"} onClick={() => setPage("tracking")}>
              Tracking
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-6">
          {page === "downloads" ? <DownloadsPage showToast={showToast} /> : <TrackingPage showToast={showToast} />}
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
      <SectionHeader
        title="Queue a download"
        subtitle="Paste a URL (video / playlist / channel). Defaults are optimized for speed."
        right={
          <Button variant="ghost" onClick={() => setCollectionsOpen(true)}>
            Manage collections
          </Button>
        }
      />

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
              <div className="text-sm font-semibold text-white/85">Collection</div>
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
                  <div className="flex items-start justify-between gap-3">
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
                    <div className="flex shrink-0 items-center gap-2">
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
                          const r = await apiSend<{ success: boolean; message?: string }>(`/api/schedules/${s.id}`, "DELETE");
                          if (!r.ok) return props.showToast("bad", r.message);
                          props.showToast("good", "Schedule deleted.");
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
  showToast: (tone: "good" | "bad", message: string) => void;
}) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);

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
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/3 px-4 py-3 ring-1 ring-white/8">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{c.name}</div>
                    <div className="truncate text-xs text-white/55">{c.rootPath}</div>
                  </div>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete collection "${c.name}"?`)) return;
                      const r = await apiSend<{ success: boolean; message?: string }>(`/api/collections/${c.id}`, "DELETE");
                      if (!r.ok) return props.showToast("bad", r.message);
                      props.showToast("good", "Collection deleted.");
                      await props.onChanged();
                    }}
                  >
                    Delete
                  </Button>
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
  const [tab, setTab] = useState<TrackingTab>("videos");
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);
  const [stats, setStats] = useState<TrackerStats | null>(null);
  const [videos, setVideos] = useState<TrackedVideo[]>([]);
  const [channels, setChannels] = useState<TrackedChannel[]>([]);
  const [playlists, setPlaylists] = useState<TrackedPlaylist[]>([]);
  const [q, setQ] = useState("");

  async function loadAll() {
    const res = await apiGet<{
      success: true;
      videos: TrackedVideo[];
      channels: TrackedChannel[];
      playlists: TrackedPlaylist[];
      stats: TrackerStats;
    }>("/api/tracker/all");
    if (!res.ok) return;
    if (res.data.success) {
      setVideos(res.data.videos || []);
      setChannels(res.data.channels || []);
      setPlaylists(res.data.playlists || []);
      setStats(res.data.stats || null);
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
      <SectionHeader
        title="Tracking"
        subtitle="Live download status + history from the tracker."
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => loadAll()}>
              Refresh
            </Button>
          </div>
        }
      />

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
                  <div className="mt-1 truncate text-xs text-white/55">{d.channel ? `Channel: ${d.channel}` : d.url}</div>
                  {typeof d.progress === "number" ? (
                    <div className="mt-2">
                      <div className="h-2 overflow-hidden rounded bg-white/5 ring-1 ring-white/10">
                        <div className="h-full bg-sky-400/70" style={{ width: `${Math.max(0, Math.min(100, d.progress))}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-white/55">{d.progress}%</div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="md:col-span-3 grid gap-4">
          <Card title="Stats">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Videos" value={stats?.totalVideos ?? 0} />
              <Stat label="Channels" value={stats?.totalChannels ?? 0} />
              <Stat label="Playlists" value={stats?.totalPlaylists ?? 0} />
              <Stat label="Total size" value={formatBytes(stats?.totalSize)} />
            </div>
          </Card>

          <Card
            title="Library"
            right={
              <div className="flex items-center gap-2">
                <Button variant={tab === "videos" ? "primary" : "ghost"} onClick={() => setTab("videos")}>
                  Videos
                </Button>
                <Button variant={tab === "channels" ? "primary" : "ghost"} onClick={() => setTab("channels")}>
                  Channels
                </Button>
                <Button variant={tab === "playlists" ? "primary" : "ghost"} onClick={() => setTab("playlists")}>
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
                    .map((v) => (
                      <div key={`${v.id}:${v.relativePath}`} className={cx("rounded-xl bg-white/3 p-4 ring-1 ring-white/8", v.deleted ? "opacity-60" : "")}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold">{v.title}</div>
                              <Badge tone="muted">{v.format === "audio" ? "Audio" : `Video ${v.resolution || ""}`.trim()}</Badge>
                              {v.deleted ? <Badge tone="bad">Deleted</Badge> : null}
                            </div>
                            <div className="mt-1 text-xs text-white/55">
                              {v.channel} · {v.relativePath}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                              <span>Size: {formatBytes(v.fileSize)}</span>
                              <span>Duration: {formatDuration(v.duration)}</span>
                              <span>Downloaded: {formatTime(v.downloadedAt)}</span>
                            </div>
                          </div>
                          <a className="shrink-0 text-sm font-semibold text-sky-300 hover:text-sky-200" href={v.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        </div>
                      </div>
                    ))}
                </div>
              ) : null}

              {tab === "channels" ? (
                <div className="grid gap-2">
                  {filtered.channels
                    .slice()
                    .sort((a, b) => (b.lastDownloadedAt || b.downloadedAt || 0) - (a.lastDownloadedAt || a.downloadedAt || 0))
                    .slice(0, 200)
                    .map((c) => (
                      <div key={c.id} className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold">{c.channelName}</div>
                              <Badge tone="muted">{c.videoCount} videos</Badge>
                              {c.maxVideos ? <Badge tone="muted">max {c.maxVideos}</Badge> : null}
                            </div>
                            <div className="mt-1 text-xs text-white/55">{c.relativePath}</div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                              <span>First: {formatTime(c.downloadedAt)}</span>
                              {c.lastDownloadedAt ? <span>Last: {formatTime(c.lastDownloadedAt)}</span> : null}
                            </div>
                          </div>
                          <a className="shrink-0 text-sm font-semibold text-sky-300 hover:text-sky-200" href={c.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
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
                      <div key={p.id} className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold">{p.playlistName}</div>
                              <Badge tone="muted">{p.videoCount} videos</Badge>
                            </div>
                            <div className="mt-1 text-xs text-white/55">{p.relativePath}</div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                              <span>First: {formatTime(p.downloadedAt)}</span>
                              {p.lastDownloadedAt ? <span>Last: {formatTime(p.lastDownloadedAt)}</span> : null}
                            </div>
                          </div>
                          <a className="shrink-0 text-sm font-semibold text-sky-300 hover:text-sky-200" href={p.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
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

function Stat(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white/3 p-4 ring-1 ring-white/8">
      <div className="text-xs font-semibold text-white/60">{props.label}</div>
      <div className="mt-1 text-lg font-bold text-white">{props.value}</div>
    </div>
  );
}

