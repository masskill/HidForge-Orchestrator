// Usage/rate limit recognition in failed agent output, and the reset time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLimit, resetTime } from '../src/limits.ts';

const now = new Date('2026-11-17T10:00:00');
const mins = (iso: string | undefined) => Math.round((new Date(iso!).getTime() - now.getTime()) / 60_000);

test('limits: typical CLI / API limit messages are recognised, ordinary failures are not', () => {
  for (const msg of [
    "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.",
    'Claude AI usage limit reached|1794920400',
    "You've hit your limit · resets 3pm (Europe/Kyiv)",
    'Error: 429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
    '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}',
    'Your credit balance is too low to access the Anthropic API.',
    'stream error: rate_limit_exceeded, retry after 20 seconds',
    'HTTP 429 Too Many Requests',
  ]) assert.ok(detectLimit(`some output\n${msg}\nmore`, now), msg);
  for (const msg of ['agent exited with code 1', 'npm test failed: 2 tests', 'TypeError: cannot read properties of undefined', 'implemented the rate limiter middleware but tests fail', 'added rate limiting to the API'])
    assert.equal(detectLimit(msg, now), null, msg);
});

test('limits: reset time from duration, epoch or clock time; defaults and bounds', () => {
  assert.equal(mins(detectLimit('usage limit; try again in 2 hours 13 minutes', now)?.until), 133);
  assert.equal(new Date(detectLimit('usage limit reached|1794920400', now)!.until).getTime(), 1794920400 * 1000, 'epoch after "|"');
  assert.equal(mins(detectLimit("You've hit your limit · resets 3pm", now)?.until), 300, '15:00 today');
  assert.equal(mins(detectLimit('usage limit, try again at 9:30 AM', now)?.until), 23 * 60 + 30, 'tomorrow 09:30');
  assert.equal(mins(detectLimit('You have reached your usage limit.', now)?.until), 60, 'quota default');
  assert.equal(mins(detectLimit('HTTP 429 Too Many Requests', now)?.until), 5, 'rate default');
  assert.equal(mins(detectLimit('rate limit, retry after 5 seconds', now)?.until), 1, 'at least a minute');
  assert.equal(resetTime('nothing here', now), null);
  assert.equal(detectLimit('Quota exceeded', now)?.kind, 'quota');
  assert.equal(detectLimit('Too many requests', now)?.kind, 'rate');
});
