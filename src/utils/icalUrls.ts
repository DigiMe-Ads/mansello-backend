// Property.airbnbIcalImportUrls is meant to hold one URL per element, but an
// older admin form split its textarea on newlines only — two links pasted on
// one line (or separated by a space/comma) were saved as ONE string, and
// fetching that string fails. Split defensively on any whitespace or comma,
// both when saving and again before fetching, so a row saved that way still
// syncs. Order-preserving, de-duplicated.
export function splitIcalUrls(values: readonly string[]): string[] {
  const urls = values.flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
  return Array.from(new Set(urls));
}

// For logs — the URL itself carries the channel's secret export token.
export function icalUrlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid url)";
  }
}
