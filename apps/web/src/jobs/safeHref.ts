// Only http(s) links are ever rendered as hrefs; anything else (javascript:, data:, junk) is dropped.
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
