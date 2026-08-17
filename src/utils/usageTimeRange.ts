import type { UsageTimeRange } from '@/utils/usage';

export const DEFAULT_USAGE_TIME_RANGE: UsageTimeRange = '24h';

export const USAGE_TIME_RANGE_OPTIONS: ReadonlyArray<{ value: UsageTimeRange; labelKey: string }> = [
  { value: '7h', labelKey: 'usage_stats.range_7h' },
  { value: '24h', labelKey: 'usage_stats.range_24h' },
  { value: '7d', labelKey: 'usage_stats.range_7d' },
  { value: '30d', labelKey: 'usage_stats.range_30d' },
  { value: 'all', labelKey: 'usage_stats.range_all' }
];

export const HOUR_WINDOW_BY_USAGE_TIME_RANGE: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '7h': 7,
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24
};

/**
 * 时间范围的毫秒长度。聚合快照无法再按时间切片，需要先把聚合桶按窗口筛
 * 选再重建，因此页面需要拿到这个长度。
 */
export const usageTimeRangeToMs = (range: Exclude<UsageTimeRange, 'all'>): number =>
  HOUR_WINDOW_BY_USAGE_TIME_RANGE[range] * 60 * 60 * 1000;

export const isUsageTimeRange = (value: unknown): value is UsageTimeRange =>
  value === '7h' || value === '24h' || value === '7d' || value === '30d' || value === 'all';
