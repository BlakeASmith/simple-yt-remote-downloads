import React, { useEffect } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const { className, variant = "primary", ...rest } = props;
  const base =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition touch-manipulation select-none disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-white/10 hover:bg-white/15 ring-1 ring-white/15"
      : variant === "danger"
        ? "bg-red-500/15 hover:bg-red-500/20 text-red-200 ring-1 ring-red-400/25"
        : "bg-transparent hover:bg-white/10 ring-1 ring-white/10";
  return <button className={cx(base, styles, className)} {...rest} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return (
    <input
      className={cx(
        "min-h-11 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/40",
        className
      )}
      {...rest}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select
      className={cx(
        "min-h-11 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/40",
        className
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Checkbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input type="checkbox" className={cx("h-5 w-5 accent-sky-400", className)} {...rest} />;
}

export function Radio(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input type="radio" className={cx("h-5 w-5 accent-sky-400", className)} {...rest} />;
}

export function Card(props: React.HTMLAttributes<HTMLDivElement> & { title?: string; right?: React.ReactNode }) {
  const { className, title, right, children, ...rest } = props;
  return (
    <div className={cx("rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur", className)} {...rest}>
      {(title || right) && (
        <div className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          {title ? <div className="text-sm font-semibold text-white">{title}</div> : <div />}
          {right ? <div className="flex w-full justify-end sm:w-auto">{right}</div> : null}
        </div>
      )}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </div>
  );
}

export function Badge(props: { children: React.ReactNode; tone?: "good" | "muted" | "warn" | "bad" }) {
  const { children, tone = "muted" } = props;
  const cls =
    tone === "good"
      ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/25"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/25"
        : tone === "bad"
          ? "bg-red-500/15 text-red-200 ring-1 ring-red-400/25"
          : "bg-white/5 text-white/75 ring-1 ring-white/10";
  return <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", cls)}>{children}</span>;
}

export function Modal(props: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const { open, title, onClose, children } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)] sm:items-center sm:p-6">
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-hidden rounded-2xl bg-zinc-950 ring-1 ring-white/10 sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
          <div className="text-sm font-semibold text-white">{title}</div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto px-4 py-4 sm:max-h-[calc(100dvh-10rem)] sm:px-5">{children}</div>
      </div>
    </div>
  );
}

export function Toast(props: { tone: "good" | "bad"; message: string; onClose: () => void }) {
  const { tone, message, onClose } = props;
  useEffect(() => {
    const t = setTimeout(onClose, 4500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      className={cx(
        "fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-4 right-4 z-50 rounded-xl px-4 py-3 text-sm ring-1 backdrop-blur sm:left-auto sm:right-[calc(env(safe-area-inset-right)+1rem)] sm:max-w-[min(420px,calc(100vw-2rem))]",
        tone === "good"
          ? "bg-emerald-500/15 text-emerald-100 ring-emerald-400/25"
          : "bg-red-500/15 text-red-100 ring-red-400/25"
      )}
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="leading-snug">{message}</div>
        <button className="text-white/70 hover:text-white" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}

