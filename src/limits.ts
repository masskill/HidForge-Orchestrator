// Recognises "the agent ran out of its usage / rate limit" in a failed run's output, and when the limit resets.
// The patterns follow wording CLIs and provider APIs are known to use (usage limit, quota, RESOURCE_EXHAUSTED, 429 …).
// They are a heuristic, checked only on runs that already failed: unknown wording simply stays an ordinary failure.

export interface LimitHit { until: string; reason: string; kind: 'quota' | 'rate' }

const QUOTA = [
  /usage limit/i, /hit your (?:usage |weekly |daily |monthly )?limit/i, /(?:usage|session|weekly|daily|monthly|opus|plan) limit (?:has been |was )?(?:reached|exceeded|hit)/i,
  /limit (?:has been |was )?reached/i, /quota (?:exceeded|exhausted|reached)/i, /exceeded (?:your |the )?(?:current )?quota/i, /insufficient[_ ]quota/i,
  /resource[_ ]exhausted/i, /credit balance is too low/i, /out of (?:credits|tokens|quota)/i, /no (?:remaining |more )?credits/i, /billing hard limit/i,
];
const RATE = [/\brate[ _-]?limit(?!er|ing)/i, /too many requests/i, /\b(?:http|status|code|error)\W{0,3}429\b/i, /\b429\b.{0,30}(?:too many|rate)/i, /overloaded/i];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MIN_MS = 60_000;
const MAX_MS = 8 * 24 * 3600_000;

/** When does the limit reset? Explicit duration ("try again in 2 hours 13 minutes"), epoch ("…|1731870000"), or clock time ("resets 3pm"). */
export function resetTime(text: string, now: Date): Date | null {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const rel = /(?:try again|retry|resets?|available(?: again)?|wait|reset)\s+(?:in|after)\s+([^.\n]{1,60})/i.exec(text);
  if (rel) {
    const part = rel[1]!;
    const num = (re: RegExp) => Number(re.exec(part)?.[1] ?? 0);
    const ms = num(/(\d+)\s*(?:days?|d)\b/i) * 86_400_000 + num(/(\d+)\s*(?:hours?|hrs?|h)\b/i) * 3_600_000
      + num(/(\d+)\s*(?:minutes?|mins?|m)\b/i) * 60_000 + num(/(\d+)\s*(?:seconds?|secs?|s)\b/i) * 1000;
    if (ms > 0) return new Date(now.getTime() + ms);
  }
  // a calendar date, as Codex writes it: "try again at Nov 23rd, 2026 12:49 PM" (local time)
  const dm = /(?:try again|retry|resets?|available|until)\D{0,12}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(text);
  if (dm) {
    let h = Number(dm[4] ?? 0);
    const ap = dm[6]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const month = MONTHS.indexOf(dm[1]!.toLowerCase());
    const d = new Date(Number(dm[3] ?? now.getFullYear()), month, Number(dm[2]), h, Number(dm[5] ?? 0), 0, 0);
    if (!dm[3] && d <= now) d.setFullYear(d.getFullYear() + 1);
    if (!Number.isNaN(d.getTime()) && h <= 23) return d;
  }
  const at = /(?:try again at|resets?(?: at)?|reset at|available at|until)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (at && (at[2] || at[3])) {
    let h = Number(at[1]);
    const m = Number(at[2] ?? 0);
    const ap = at[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

/** null = not a limit failure. Defaults when no reset time is given: quota 60 min, rate limit 5 min. */
export function detectLimit(text: string, now = new Date()): LimitHit | null {
  const lines = text.split(/\r?\n/);
  const find = (res: RegExp[]) => lines.find((l) => res.some((r) => r.test(l)));
  const quotaLine = find(QUOTA);
  const line = quotaLine ?? find(RATE);
  if (!line) return null;
  const kind = quotaLine ? 'quota' : 'rate';
  const at = resetTime(text, now);
  const fallback = kind === 'quota' ? 60 * MIN_MS : 5 * MIN_MS;
  const ms = Math.min(MAX_MS, Math.max(MIN_MS, at ? at.getTime() - now.getTime() : fallback));
  return { until: new Date(now.getTime() + ms).toISOString(), reason: line.trim().slice(0, 240), kind };
}
