import { describe, expect, test } from 'bun:test';
import {
  buildUsageSnapshotFromSummary,
  computeKeyStatsFromSummary,
  normalizeSummaryResponse,
  filterSummaryBucketsByWindow,
  summaryBucketStartMs,
  summaryGroupKey,
  summaryLatency,
  summaryTtft,
  weightedAverage,
  type UsageSummaryBucket,
} from '@/utils/usage/summary';

const bucket = (overrides: Partial<UsageSummaryBucket> = {}): UsageSummaryBucket => ({
  bucket: '2026-05-02',
  api_key: 'key-1',
  provider: 'anthropic',
  model: 'claude-opus-5',
  source: 'claude-code',
  auth_index: 'auth-1',
  requests: 10,
  failures: 2,
  tokens: {
    input_tokens: 100,
    output_tokens: 200,
    reasoning_tokens: 10,
    cached_tokens: 5,
    cache_read_tokens: 3,
    cache_creation_tokens: 2,
    total_tokens: 310,
  },
  avg_latency_ms: 1000,
  max_latency_ms: 2000,
  latency_samples: 10,
  avg_ttft_ms: 300,
  max_ttft_ms: 600,
  ttft_samples: 8,
  ...overrides,
});

describe('summaryGroupKey', () => {
  test('mirrors the plugin fallback chain api_key -> provider -> unknown', () => {
    expect(summaryGroupKey({ api_key: 'key-1', provider: 'anthropic' })).toBe('key-1');
    expect(summaryGroupKey({ api_key: '   ', provider: 'anthropic' })).toBe('anthropic');
    expect(summaryGroupKey({ api_key: '', provider: '' })).toBe('unknown');
  });
});

describe('buildUsageSnapshotFromSummary', () => {
  test('sums totals and splits successes from failures', () => {
    const snapshot = buildUsageSnapshotFromSummary([
      bucket({ requests: 10, failures: 2 }),
      bucket({ bucket: '2026-05-03', requests: 5, failures: 0 }),
    ]);

    expect(snapshot.total_requests).toBe(15);
    expect(snapshot.failure_count).toBe(2);
    expect(snapshot.success_count).toBe(13);
    expect(snapshot.total_tokens).toBe(620);
  });

  test('nests totals under api key then model', () => {
    const snapshot = buildUsageSnapshotFromSummary([
      bucket({ api_key: 'key-1', model: 'model-a', requests: 4, failures: 1 }),
      bucket({ api_key: 'key-1', model: 'model-b', requests: 6, failures: 0 }),
      bucket({ api_key: 'key-2', model: 'model-a', requests: 2, failures: 2 }),
    ]);

    expect(snapshot.apis['key-1'].total_requests).toBe(10);
    expect(snapshot.apis['key-1'].failure_count).toBe(1);
    expect(Object.keys(snapshot.apis['key-1'].models).sort()).toEqual(['model-a', 'model-b']);
    expect(snapshot.apis['key-1'].models['model-a'].total_requests).toBe(4);
    expect(snapshot.apis['key-2'].success_count).toBe(0);
  });

  test('merges rows that differ only by credential into one api/model total', () => {
    // source/auth_index expand the bucket count, but the api/model rollup must not
    // double count because of it.
    const snapshot = buildUsageSnapshotFromSummary([
      bucket({ auth_index: 'auth-1', requests: 3, failures: 0 }),
      bucket({ auth_index: 'auth-2', requests: 7, failures: 1 }),
    ]);

    expect(snapshot.total_requests).toBe(10);
    expect(snapshot.apis['key-1'].models['claude-opus-5'].total_requests).toBe(10);
  });

  test('fills the hourly series only when buckets carry an hour', () => {
    const hourly = buildUsageSnapshotFromSummary([
      bucket({ bucket: '2026-05-02T10', requests: 3 }),
      bucket({ bucket: '2026-05-02T11', requests: 4 }),
    ]);
    expect(hourly.requests_by_hour).toEqual({ '2026-05-02T10': 3, '2026-05-02T11': 4 });
    // Hour buckets still roll up into the day series.
    expect(hourly.requests_by_day).toEqual({ '2026-05-02': 7 });

    // A day bucket cannot be split back into hours; faking it would draw a wrong curve.
    const daily = buildUsageSnapshotFromSummary([bucket({ bucket: '2026-05-02', requests: 9 })]);
    expect(daily.requests_by_hour).toEqual({});
    expect(daily.requests_by_day).toEqual({ '2026-05-02': 9 });
  });

  test('carries no per-request details', () => {
    const snapshot = buildUsageSnapshotFromSummary([bucket()]);
    expect(snapshot.apis['key-1'].models['claude-opus-5'].details).toEqual([]);
  });

  test('never reports negative successes when failures exceed requests', () => {
    const snapshot = buildUsageSnapshotFromSummary([bucket({ requests: 1, failures: 5 })]);
    expect(snapshot.success_count).toBe(0);
  });
});

describe('computeKeyStatsFromSummary', () => {
  test('groups by source and auth index independently', () => {
    const stats = computeKeyStatsFromSummary([
      bucket({ source: 'claude-code', auth_index: 'auth-1', requests: 10, failures: 2 }),
      bucket({ source: 'claude-code', auth_index: 'auth-2', requests: 5, failures: 0 }),
      bucket({ source: 'opencode', auth_index: 'auth-1', requests: 3, failures: 3 }),
    ]);

    expect(stats.bySource['claude-code']).toEqual({ success: 13, failure: 2 });
    expect(stats.bySource['opencode']).toEqual({ success: 0, failure: 3 });
    expect(stats.byAuthIndex['auth-1']).toEqual({ success: 8, failure: 5 });
    expect(stats.byAuthIndex['auth-2']).toEqual({ success: 5, failure: 0 });
  });

  test('skips blank dimensions instead of creating an empty-string bucket', () => {
    const stats = computeKeyStatsFromSummary([bucket({ source: '', auth_index: '   ' })]);
    expect(stats.bySource).toEqual({});
    expect(stats.byAuthIndex).toEqual({});
  });
});

describe('weightedAverage', () => {
  test('weights by sample count, not by bucket count', () => {
    const buckets = [
      bucket({ avg_latency_ms: 100, latency_samples: 1 }),
      bucket({ avg_latency_ms: 200, latency_samples: 99 }),
    ];
    // A naive mean of the two averages would be 150 and badly misrepresent the data.
    expect(weightedAverage(buckets, summaryLatency).average).toBeCloseTo(199, 5);
    expect(weightedAverage(buckets, summaryLatency).samples).toBe(100);
  });

  test('ignores buckets with no samples rather than counting them as zero', () => {
    const buckets = [
      bucket({ avg_ttft_ms: 400, ttft_samples: 2 }),
      bucket({ avg_ttft_ms: 0, ttft_samples: 0 }),
    ];
    expect(weightedAverage(buckets, summaryTtft).average).toBe(400);
    expect(weightedAverage(buckets, summaryTtft).samples).toBe(2);
  });

  test('returns null when nothing reported the metric', () => {
    const result = weightedAverage([bucket({ ttft_samples: 0 })], summaryTtft);
    expect(result.average).toBeNull();
    expect(result.samples).toBe(0);
  });
});

describe('normalizeSummaryResponse', () => {
  test('coerces a well-formed payload', () => {
    const parsed = normalizeSummaryResponse({
      buckets: [{ bucket: '2026-05-02', requests: '12', tokens: { total_tokens: '99' } }],
      bucket_by: 'hour',
      truncated: true,
    });
    expect(parsed.bucket_by).toBe('hour');
    expect(parsed.truncated).toBe(true);
    expect(parsed.buckets[0].requests).toBe(12);
    expect(parsed.buckets[0].tokens.total_tokens).toBe(99);
    expect(parsed.buckets[0].api_key).toBe('');
  });

  test('falls back to an empty day summary for junk input', () => {
    for (const input of [null, undefined, 'nope', 42, {}]) {
      const parsed = normalizeSummaryResponse(input);
      expect(parsed.buckets).toEqual([]);
      expect(parsed.bucket_by).toBe('day');
      expect(parsed.truncated).toBe(false);
    }
  });

  test('rejects an unknown bucket size instead of trusting the server blindly', () => {
    expect(normalizeSummaryResponse({ buckets: [], bucket_by: 'fortnight' }).bucket_by).toBe('day');
    expect(normalizeSummaryResponse({ buckets: [], bucket_by: '15m' }).bucket_by).toBe('15m');
  });

  test('turns non-finite numbers into zero so charts never render NaN', () => {
    const parsed = normalizeSummaryResponse({
      buckets: [{ requests: 'abc', avg_latency_ms: null, tokens: { input_tokens: undefined } }],
    });
    expect(parsed.buckets[0].requests).toBe(0);
    expect(parsed.buckets[0].avg_latency_ms).toBe(0);
    expect(parsed.buckets[0].tokens.input_tokens).toBe(0);
  });
});

describe('summaryBucketStartMs', () => {
  test('parses every bucket granularity as UTC', () => {
    expect(summaryBucketStartMs('2026-05')).toBe(Date.parse('2026-05-01T00:00:00Z'));
    expect(summaryBucketStartMs('2026-05-02')).toBe(Date.parse('2026-05-02T00:00:00Z'));
    expect(summaryBucketStartMs('2026-05-02T10')).toBe(Date.parse('2026-05-02T10:00:00Z'));
    expect(summaryBucketStartMs('2026-05-02T10:30')).toBe(Date.parse('2026-05-02T10:30:00Z'));
  });

  test('returns NaN for anything it does not recognise', () => {
    expect(Number.isNaN(summaryBucketStartMs(''))).toBe(true);
    expect(Number.isNaN(summaryBucketStartMs('nonsense'))).toBe(true);
  });
});

describe('filterSummaryBucketsByWindow', () => {
  // Regression: the aggregate snapshot has no per-request details, so the old
  // detail-walking filter rebuilt every total as zero and blanked the dashboard.
  // Time filtering has to happen on the buckets, before the snapshot is built.
  const buckets = [
    bucket({ bucket: '2026-05-01T08', requests: 1 }),
    bucket({ bucket: '2026-05-02T08', requests: 2 }),
    bucket({ bucket: '2026-05-03T08', requests: 4 }),
  ];

  test('keeps only buckets inside the window', () => {
    const start = Date.parse('2026-05-02T00:00:00Z');
    const end = Date.parse('2026-05-03T23:59:59Z');
    const kept = filterSummaryBucketsByWindow(buckets, start, end);
    expect(kept.map((b) => b.bucket)).toEqual(['2026-05-02T08', '2026-05-03T08']);
  });

  test('a null start means no lower bound', () => {
    expect(filterSummaryBucketsByWindow(buckets, null, Date.now())).toHaveLength(3);
  });

  test('keeps unparseable buckets rather than silently dropping data', () => {
    const odd = [...buckets, bucket({ bucket: 'garbage', requests: 8 })];
    const kept = filterSummaryBucketsByWindow(odd, Date.parse('2099-01-01T00:00:00Z'), Date.now());
    expect(kept.map((b) => b.bucket)).toEqual(['garbage']);
  });

  test('filtered buckets rebuild into a correct snapshot', () => {
    const start = Date.parse('2026-05-02T00:00:00Z');
    const end = Date.parse('2026-05-03T23:59:59Z');
    const snapshot = buildUsageSnapshotFromSummary(
      filterSummaryBucketsByWindow(buckets, start, end)
    );
    // 2 + 4, not 1 + 2 + 4, and crucially not 0.
    expect(snapshot.total_requests).toBe(6);
  });
});
