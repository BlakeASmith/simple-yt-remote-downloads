import React, { useEffect } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const { className, variant = "primary", ...rest } = props;
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";
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
        "w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/40",
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
        "w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/40",
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
  return <input type="checkbox" className={cx("h-4 w-4 accent-sky-400", className)} {...rest} />;
}

export function Radio(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input type="radio" className={cx("h-4 w-4 accent-sky-400", className)} {...rest} />;
}

export function Card(props: React.HTMLAttributes<HTMLDivElement> & { title?: string; right?: React.ReactNode }) {
  const { className, title, right, children, ...rest } = props;
  return (
    <div className={cx("rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur", className)} {...rest}>
      {(title || right) && (
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          {title ? <div className="text-sm font-semibold text-white">{title}</div> : <div />}
          {right}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-zinc-950 ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="text-sm font-semibold text-white">{title}</div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
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
        "fixed bottom-4 right-4 z-50 max-w-[min(420px,calc(100vw-2rem))] rounded-xl px-4 py-3 text-sm ring-1 backdrop-blur",
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

