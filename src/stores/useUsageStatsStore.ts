import { create } from 'zustand';
import { usageApi } from '@/services/api/usage';
import { useAuthStore } from '@/stores/useAuthStore';
import {
  buildUsageSnapshotFromSummary,
  computeKeyStatsFromSummary,
  normalizeSummaryResponse,
  type KeyStats,
  type UsageDetail,
  type UsageStatsSnapshot,
  type UsageSummaryBucket,
  type UsageSummaryBucketSize,
  type UsageTimeRange,
} from '@/utils/usage';
import i18n from '@/i18n';

export const USAGE_STATS_STALE_TIME_MS = 240_000;

/**
 * 明细表最多渲染 500 行，所以一次取满即可，不必把整个时间范围的原始记录拉回来。
 * 旧实现会下载范围内的全部记录再切片，7 天窗口实测 4.35 MB / 7380 条。
 */
export const USAGE_RECORDS_PAGE_SIZE = 500;

/**
 * 小时桶只在范围不太宽时才请求：日桶无法还原小时曲线，而用小时桶覆盖一个月会把
 * 桶数放大 24 倍且没有对应的图表消费它。
 */
const HOURLY_BUCKET_MAX_SPAN_MS = 8 * 24 * 60 * 60 * 1000;

const USAGE_RANGE_MS: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '7h': 7 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export type LoadUsageStatsOptions = {
  force?: boolean;
  /** 保留以兼容既有调用方；聚合请求总是覆盖完整目标范围，无需增量拼接。 */
  fullRange?: boolean;
  staleTimeMs?: number;
  timeRange?: UsageTimeRange;
  minimumLookbackMs?: number;
};

export type LoadUsageRecordsOptions = {
  timeRange?: UsageTimeRange;
  minimumLookbackMs?: number;
  limit?: number;
};

type UsageStatsState = {
  usage: UsageStatsSnapshot | null;
  keyStats: KeyStats;
  summaryBuckets: UsageSummaryBucket[];
  summaryTruncated: boolean;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
  scopeKey: string;

  /** 明细表数据源，独立于聚合快照。 */
  records: UsageDetail[];
  recordsLoading: boolean;
  recordsError: string | null;
  recordsHasMore: boolean;
  recordsCursor: string | null;

  loadUsageStats: (options?: LoadUsageStatsOptions) => Promise<void>;
  loadUsageRecords: (options?: LoadUsageRecordsOptions) => Promise<void>;
  deleteUsageRecords: (ids: string[]) => Promise<void>;
  clearUsageStats: () => void;
};

const createEmptyKeyStats = (): KeyStats => ({ bySource: {}, byAuthIndex: {} });

let usageRequestToken = 0;
let recordsRequestToken = 0;

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : i18n.t('usage_stats.loading_error');

const toIsoString = (ms: number): string => new Date(ms).toISOString();

const getRangeStartMs = (timeRange: UsageTimeRange | undefined, nowMs: number): number | null => {
  if (!timeRange || timeRange === 'all') {
    return null;
  }
  return nowMs - USAGE_RANGE_MS[timeRange];
};

const getTargetStartMs = (
  timeRange: UsageTimeRange | undefined,
  nowMs: number,
  minimumLookbackMs: number | undefined
): number | null => {
  if (timeRange === 'all') {
    return null;
  }

  const rangeStartMs = getRangeStartMs(timeRange, nowMs);
  const minimumStartMs =
    typeof minimumLookbackMs === 'number' &&
    Number.isFinite(minimumLookbackMs) &&
    minimumLookbackMs > 0
      ? nowMs - minimumLookbackMs
      : null;

  if (rangeStartMs === null) return minimumStartMs;
  if (minimumStartMs === null) return rangeStartMs;
  return Math.min(rangeStartMs, minimumStartMs);
};

const rangeToParams = (startMs: number | null, endMs: number) =>
  startMs === null ? {} : { start: toIsoString(startMs), end: toIsoString(endMs) };

const bucketForSpan = (startMs: number | null, endMs: number): UsageSummaryBucketSize => {
  if (startMs === null) return 'day';
  return endMs - startMs <= HOURLY_BUCKET_MAX_SPAN_MS ? 'hour' : 'day';
};

const getScopeKey = (): string => {
  const { apiBase = '', managementKey = '' } = useAuthStore.getState();
  return `${apiBase}::${managementKey}`;
};

export const useUsageStatsStore = create<UsageStatsState>((set, get) => ({
  usage: null,
  keyStats: createEmptyKeyStats(),
  summaryBuckets: [],
  summaryTruncated: false,
  loading: false,
  error: null,
  lastRefreshedAt: null,
  scopeKey: '',

  records: [],
  recordsLoading: false,
  recordsError: null,
  recordsHasMore: false,
  recordsCursor: null,

  loadUsageStats: async (options = {}) => {
    const force = options.force === true;
    const staleTimeMs = options.staleTimeMs ?? USAGE_STATS_STALE_TIME_MS;
    const nowMs = Date.now();
    const targetStartMs = getTargetStartMs(options.timeRange, nowMs, options.minimumLookbackMs);
    const scopeKey = getScopeKey();
    const state = get();
    const scopeChanged = state.scopeKey !== scopeKey;

    if (
      !force &&
      !scopeChanged &&
      state.lastRefreshedAt !== null &&
      nowMs - state.lastRefreshedAt < staleTimeMs
    ) {
      return;
    }

    if (scopeChanged) {
      set({
        usage: null,
        keyStats: createEmptyKeyStats(),
        summaryBuckets: [],
        summaryTruncated: false,
        records: [],
        recordsHasMore: false,
        recordsCursor: null,
        error: null,
        lastRefreshedAt: null,
        scopeKey,
      });
    }

    const requestId = (usageRequestToken += 1);
    set({ loading: true, error: null, scopeKey });

    try {
      const response = await usageApi.getSummary({
        ...rangeToParams(targetStartMs, nowMs),
        bucket: bucketForSpan(targetStartMs, nowMs),
      });

      // 请求期间作用域切换或有更新的请求发出时，丢弃这份已过期的结果。
      if (requestId !== usageRequestToken) return;

      const summary = normalizeSummaryResponse(response);
      set({
        usage: buildUsageSnapshotFromSummary(summary.buckets),
        keyStats: computeKeyStatsFromSummary(summary.buckets),
        summaryBuckets: summary.buckets,
        summaryTruncated: summary.truncated,
        loading: false,
        error: null,
        lastRefreshedAt: Date.now(),
        scopeKey,
      });
    } catch (error: unknown) {
      if (requestId !== usageRequestToken) return;
      const message = getErrorMessage(error);
      set({ loading: false, error: message, scopeKey });
      // tsconfig 目标为 ES2020，Error 构造函数的 cause 选项是 ES2022 才有的，
      // 因此改用属性赋值挂上原始错误，不为此抬高全局 target。
      const symptom: Error & { cause?: unknown } = new Error(message);
      symptom.cause = error;
      throw symptom;
    }
  },

  loadUsageRecords: async (options = {}) => {
    const nowMs = Date.now();
    const targetStartMs = getTargetStartMs(options.timeRange, nowMs, options.minimumLookbackMs);
    const scopeKey = getScopeKey();
    const requestId = (recordsRequestToken += 1);
    set({ recordsLoading: true, recordsError: null });

    try {
      const page = await usageApi.getRecords({
        ...rangeToParams(targetStartMs, nowMs),
        // 倒序：表格要的是最新的记录，升序分页得把整个范围翻完才能到达。
        order: 'desc',
        limit: options.limit ?? USAGE_RECORDS_PAGE_SIZE,
      });

      if (requestId !== recordsRequestToken) return;

      set({
        records: Array.isArray(page?.records) ? page.records : [],
        recordsHasMore: page?.has_more === true,
        recordsCursor: page?.next_cursor ?? null,
        recordsLoading: false,
        recordsError: null,
        scopeKey,
      });
    } catch (error: unknown) {
      if (requestId !== recordsRequestToken) return;
      set({ recordsLoading: false, recordsError: getErrorMessage(error) });
    }
  },

  deleteUsageRecords: async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return;

    await usageApi.deleteUsage(uniqueIds);

    const idSet = new Set(uniqueIds);
    set((state) => ({
      records: state.records.filter((record) => !record.id || !idSet.has(record.id)),
    }));

    // 聚合是服务端算的，本地删几行不会改变它；强制重取以免统计与明细对不上。
    await get()
      .loadUsageStats({ force: true })
      .catch(() => {});
  },

  clearUsageStats: () => {
    usageRequestToken += 1;
    recordsRequestToken += 1;
    set({
      usage: null,
      keyStats: createEmptyKeyStats(),
      summaryBuckets: [],
      summaryTruncated: false,
      loading: false,
      error: null,
      lastRefreshedAt: null,
      scopeKey: '',
      records: [],
      recordsLoading: false,
      recordsError: null,
      recordsHasMore: false,
      recordsCursor: null,
    });
  },
}));
