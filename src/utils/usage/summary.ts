/**
 * usage-statistics 插件聚合接口（/usage/summary）的类型与还原逻辑。
 *
 * 插件在 SQL 侧按「时间桶 × api_key × provider × model × source × auth_index」
 * 聚合，响应大小只取决于组合数而非请求量。本模块把这些桶还原成面板既有的
 * UsageStatsSnapshot / KeyStats 形状，因此图表与统计卡片无需改动。
 *
 * 唯一的差异：桶里没有单条记录，所以 model 快照的 details 恒为空数组。需要
 * 逐条数据的界面（请求明细表、单条删除、失败日志）改走 /usage/records 分页。
 */

import type { KeyStats, UsageApiSnapshot, UsageModelSnapshot, UsageStatsSnapshot } from '../usage';

/** 插件支持的聚合粒度。 */
export type UsageSummaryBucketSize = '15m' | 'hour' | 'day' | 'month';

export interface UsageSummaryTokens {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

export interface UsageSummaryBucket {
  bucket: string;
  api_key: string;
  provider: string;
  model: string;
  source: string;
  auth_index: string;
  requests: number;
  failures: number;
  tokens: UsageSummaryTokens;
  avg_latency_ms: number;
  max_latency_ms: number;
  latency_samples: number;
  avg_ttft_ms: number;
  max_ttft_ms: number;
  ttft_samples: number;
}

export interface UsageSummaryResponse {
  buckets: UsageSummaryBucket[];
  bucket_by: UsageSummaryBucketSize;
  truncated: boolean;
}

const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * 分组键必须与插件旧接口的 groupingKey 一致：优先 api_key，其次 provider，
 * 都为空则 unknown。否则同一份数据在新旧接口下会落到不同的 apis 键上。
 */
export const summaryGroupKey = (bucket: { api_key: string; provider: string }): string => {
  const apiKey = bucket.api_key.trim();
  if (apiKey) return apiKey;
  const provider = bucket.provider.trim();
  if (provider) return provider;
  return 'unknown';
};

const summaryModelKey = (bucket: { model: string }): string => bucket.model.trim() || 'unknown';

/** 桶键形如 2026-05-02T10（hour）或 2026-05-02（day），前 10 位即日期。 */
const bucketDay = (bucket: string): string => bucket.slice(0, 10);

/** 小时序列只在桶本身至少为小时粒度时才有意义。 */
const bucketHour = (bucket: string): string | null =>
  bucket.length >= 13 ? bucket.slice(0, 13) : null;

export const normalizeSummaryResponse = (payload: unknown): UsageSummaryResponse => {
  const empty: UsageSummaryResponse = { buckets: [], bucket_by: 'day', truncated: false };
  if (!payload || typeof payload !== 'object') return empty;

  const raw = payload as Record<string, unknown>;
  const rawBuckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  const buckets = rawBuckets.map((entry): UsageSummaryBucket => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const tokens = (item.tokens ?? {}) as Record<string, unknown>;
    return {
      bucket: toText(item.bucket),
      api_key: toText(item.api_key),
      provider: toText(item.provider),
      model: toText(item.model),
      source: toText(item.source),
      auth_index: toText(item.auth_index),
      requests: toNumber(item.requests),
      failures: toNumber(item.failures),
      tokens: {
        input_tokens: toNumber(tokens.input_tokens),
        output_tokens: toNumber(tokens.output_tokens),
        reasoning_tokens: toNumber(tokens.reasoning_tokens),
        cached_tokens: toNumber(tokens.cached_tokens),
        cache_read_tokens: toNumber(tokens.cache_read_tokens),
        cache_creation_tokens: toNumber(tokens.cache_creation_tokens),
        total_tokens: toNumber(tokens.total_tokens),
      },
      avg_latency_ms: toNumber(item.avg_latency_ms),
      max_latency_ms: toNumber(item.max_latency_ms),
      latency_samples: toNumber(item.latency_samples),
      avg_ttft_ms: toNumber(item.avg_ttft_ms),
      max_ttft_ms: toNumber(item.max_ttft_ms),
      ttft_samples: toNumber(item.ttft_samples),
    };
  });

  const bucketBy = toText(raw.bucket_by);
  return {
    buckets,
    bucket_by:
      bucketBy === '15m' || bucketBy === 'hour' || bucketBy === 'month' ? bucketBy : 'day',
    truncated: raw.truncated === true,
  };
};

const emptyModelSnapshot = (): UsageModelSnapshot => ({
  total_requests: 0,
  success_count: 0,
  failure_count: 0,
  total_tokens: 0,
  // 聚合桶里没有单条记录；需要明细的界面走 /usage/records。
  details: [],
});

const emptyApiSnapshot = (): UsageApiSnapshot => ({
  total_requests: 0,
  success_count: 0,
  failure_count: 0,
  total_tokens: 0,
  models: {},
});

/**
 * 把聚合桶还原成面板既有的 UsageStatsSnapshot 形状。
 *
 * requests_by_hour / tokens_by_hour 只有在桶至少为小时粒度时才会填充；用日粒度
 * 请求一个月的数据时它们会是空对象，这是刻意的 —— 用日桶伪造小时序列会得到
 * 错误的曲线。
 */
export const buildUsageSnapshotFromSummary = (
  buckets: UsageSummaryBucket[]
): UsageStatsSnapshot => {
  const snapshot: UsageStatsSnapshot = {
    total_requests: 0,
    success_count: 0,
    failure_count: 0,
    total_tokens: 0,
    apis: {},
    requests_by_day: {},
    requests_by_hour: {},
    tokens_by_day: {},
    tokens_by_hour: {},
  };

  buckets.forEach((bucket) => {
    const requests = bucket.requests;
    const failures = bucket.failures;
    const successes = Math.max(0, requests - failures);
    const tokens = bucket.tokens.total_tokens;

    snapshot.total_requests += requests;
    snapshot.success_count += successes;
    snapshot.failure_count += failures;
    snapshot.total_tokens += tokens;

    const apiKey = summaryGroupKey(bucket);
    const api = (snapshot.apis[apiKey] ??= emptyApiSnapshot());
    api.total_requests += requests;
    api.success_count += successes;
    api.failure_count += failures;
    api.total_tokens += tokens;

    const modelKey = summaryModelKey(bucket);
    const model = (api.models[modelKey] ??= emptyModelSnapshot());
    model.total_requests += requests;
    model.success_count += successes;
    model.failure_count += failures;
    model.total_tokens += tokens;

    const day = bucketDay(bucket.bucket);
    if (day) {
      snapshot.requests_by_day[day] = (snapshot.requests_by_day[day] ?? 0) + requests;
      snapshot.tokens_by_day[day] = (snapshot.tokens_by_day[day] ?? 0) + tokens;
    }

    const hour = bucketHour(bucket.bucket);
    if (hour) {
      snapshot.requests_by_hour[hour] = (snapshot.requests_by_hour[hour] ?? 0) + requests;
      snapshot.tokens_by_hour[hour] = (snapshot.tokens_by_hour[hour] ?? 0) + tokens;
    }
  });

  return snapshot;
};

/**
 * 从聚合桶还原凭证维度统计。
 *
 * 这正是聚合接口必须带 source / auth_index 的原因：同一个 api_key 常由多个凭证
 * 轮流承担，只按 api_key 分组会把它们合并，凭证中心就无法还原。
 */
export const computeKeyStatsFromSummary = (buckets: UsageSummaryBucket[]): KeyStats => {
  const stats: KeyStats = { bySource: {}, byAuthIndex: {} };

  buckets.forEach((bucket) => {
    const failure = bucket.failures;
    const success = Math.max(0, bucket.requests - failure);

    const source = bucket.source.trim();
    if (source) {
      const entry = (stats.bySource[source] ??= { success: 0, failure: 0 });
      entry.success += success;
      entry.failure += failure;
    }

    const authIndex = bucket.auth_index.trim();
    if (authIndex) {
      const entry = (stats.byAuthIndex[authIndex] ??= { success: 0, failure: 0 });
      entry.success += success;
      entry.failure += failure;
    }
  });

  return stats;
};

/**
 * 跨桶合并平均值必须按样本数加权。直接平均两个桶的 avg_* 是错的：一个 1000 次
 * 请求的桶和一个 1 次请求的桶权重不应相同。样本数也不等于请求数 —— 没测到首字节
 * 的请求 ttft_ms 为 0，不计入 ttft_samples。
 */
export const weightedAverage = (
  buckets: UsageSummaryBucket[],
  pick: (bucket: UsageSummaryBucket) => { avg: number; samples: number }
): { average: number | null; samples: number } => {
  let weighted = 0;
  let samples = 0;
  buckets.forEach((bucket) => {
    const { avg, samples: count } = pick(bucket);
    if (count > 0) {
      weighted += avg * count;
      samples += count;
    }
  });
  return samples > 0 ? { average: weighted / samples, samples } : { average: null, samples: 0 };
};

export const summaryLatency = (bucket: UsageSummaryBucket) => ({
  avg: bucket.avg_latency_ms,
  samples: bucket.latency_samples,
});

export const summaryTtft = (bucket: UsageSummaryBucket) => ({
  avg: bucket.avg_ttft_ms,
  samples: bucket.ttft_samples,
});

/**
 * 把桶键解析回时间戳（UTC）。支持四种粒度：
 *   2026-05            月
 *   2026-05-02         日
 *   2026-05-02T10      小时
 *   2026-05-02T10:30   季度小时
 * 无法识别时返回 NaN，由调用方决定如何处理。
 */
export const summaryBucketStartMs = (bucket: string): number => {
  const raw = bucket.trim();
  if (!raw) return Number.NaN;
  let iso: string;
  if (raw.length === 7) iso = `${raw}-01T00:00:00Z`;
  else if (raw.length === 10) iso = `${raw}T00:00:00Z`;
  else if (raw.length === 13) iso = `${raw}:00:00Z`;
  else if (raw.length === 16) iso = `${raw}:00Z`;
  else return Number.NaN;
  return Date.parse(iso);
};

/**
 * 按时间窗口筛选聚合桶。
 *
 * 聚合后的快照无法再按时间切片 —— apis/models 的总数已经跨时间加完了。
 * 所以需要按时间过滤时，必须先筛桶再重建快照，而不是去过滤快照本身。
 *
 * 桶以其起始时刻参与比较：一个横跨窗口边界的桶会被整个保留或整个丢弃，
 * 这是聚合固有的精度损失；桶越细损失越小。
 */
export const filterSummaryBucketsByWindow = (
  buckets: UsageSummaryBucket[],
  startMs: number | null,
  endMs: number
): UsageSummaryBucket[] => {
  if (startMs === null) return buckets;
  return buckets.filter((bucket) => {
    const ms = summaryBucketStartMs(bucket.bucket);
    // 解析不出时宁可保留：宁愿多显示也不要因为格式意外而静默丢数据。
    if (Number.isNaN(ms)) return true;
    return ms >= startMs && ms <= endMs;
  });
};
