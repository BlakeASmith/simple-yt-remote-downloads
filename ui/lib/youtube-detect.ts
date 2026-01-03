export function isPlaylistInput(input: string): boolean {
  if (!input) return false;
  const v = input.trim();
  if (v.includes("list=")) return true;
  try {
    const u = new URL(v);
    return u.pathname.includes("/playlist");
  } catch {
    return false;
  }
}

export function isChannelInput(input: string): boolean {
  if (!input) return false;
  const v = input.trim();
  if (v.startsWith("@")) return true;
  if (/^UC[\w-]{22}$/.test(v)) return true;
  try {
    const u = new URL(v);
    const p = u.pathname.toLowerCase();
    return p.startsWith("/channel/") || p.startsWith("/c/") || p.startsWith("/user/") || p.startsWith("/@");
  } catch {
    return v.startsWith("@") || /^UC[\w-]{22}$/.test(v);
  }
}

