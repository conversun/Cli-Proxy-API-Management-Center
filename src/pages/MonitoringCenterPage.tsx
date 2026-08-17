import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types/authFile';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip
} from 'chart.js';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useConfigStore, useThemeStore } from '@/stores';
import {
  ModelStatsCard,
  PriceSettingsCard,
  RequestEventsDetailsCard,
  useSparklines,
  useUsageData,
  type UsagePayload
} from '@/components/usage';
import type { ModelStat } from '@/components/usage/ModelStatsCard';
import { MonitorStatCards } from '@/components/monitor/MonitorStatCards';
import { MonitorTrendChart } from '@/components/monitor/MonitorTrendChart';
import { ModelUsageDistributionCard } from '@/components/monitor/ModelUsageDistributionCard';
import { MonitorApiKeyStatsCard } from '@/components/monitor/MonitorApiKeyStatsCard';
import {
  buildUsageSnapshotFromSummary,
  filterSummaryBucketsByWindow,
  getModelNamesFromUsage,
  getModelStats,
  type UsageTimeRange
} from '@/utils/usage';
import {
  DEFAULT_USAGE_TIME_RANGE,
  HOUR_WINDOW_BY_USAGE_TIME_RANGE,
  USAGE_TIME_RANGE_OPTIONS,
  isUsageTimeRange,
  usageTimeRangeToMs
} from '@/utils/usageTimeRange';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import styles from './MonitoringCenterPage.module.scss';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineController,
  LineElement,
  BarController,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const TIME_RANGE_STORAGE_KEY = 'cli-proxy-monitor-time-range-v1';

const loadTimeRange = (): UsageTimeRange => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_USAGE_TIME_RANGE;
    }
    const raw = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return isUsageTimeRange(raw) ? raw : DEFAULT_USAGE_TIME_RANGE;
  } catch {
    return DEFAULT_USAGE_TIME_RANGE;
  }
};

export function MonitoringCenterPage() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const config = useConfigStore((state) => state.config);
  const [timeRange, setTimeRange] = useState<UsageTimeRange>(loadTimeRange);
  const [usageStatsDimension, setUsageStatsDimension] = useState<'model' | 'apiKey'>('model');

  const {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage,
  } = useUsageData({ timeRange });
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);

  // 明细表走服务端分页，与上面的聚合快照是两个独立数据源：图表只需要桶，
  // 表格才需要逐条记录（TPS、首字延迟、失败日志、单条删除）。
  const usageRecords = useUsageStatsStore((state) => state.records);
  const loadUsageRecords = useUsageStatsStore((state) => state.loadUsageRecords);
  // 原始聚合桶：按时间窗口筛选时必须从它重建，快照本身已无时间维度。
  const summaryBuckets = useUsageStatsStore((state) => state.summaryBuckets);

  const loadAuthFiles = useCallback(async () => {
    const res = await authFilesApi.list();
    const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
    if (!Array.isArray(files)) return;
    setAuthFiles(files);
  }, []);

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadUsage(), loadUsageRecords({ timeRange }), loadAuthFiles()]);
  }, [loadAuthFiles, loadUsage, loadUsageRecords, timeRange]);

  useEffect(() => {
    void loadUsageRecords({ timeRange });
  }, [loadUsageRecords, timeRange]);

  useHeaderRefresh(handleRefresh);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuthFiles().catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAuthFiles]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, timeRange);
    } catch {
      // Ignore storage errors.
    }
  }, [timeRange]);

  // 聚合快照的 apis/models 总数已经跨时间加完了，无法再按时间切片。按时间
  // 过滤必须先筛聚合桶再重建快照，而不是去过滤快照本身。
  const filteredUsage = useMemo(() => {
    if (!usage) return null;
    if (timeRange === 'all') return usage;
    // 锚在数据拓取时刻而非渲染时刻：store 就是按这个时间取的范围，
    // 用 Date.now() 会让过滤窗口随渲染漂移，且在 useMemo 里不纯。
    const endMs = lastRefreshedAt ? lastRefreshedAt.getTime() : 0;
    if (!endMs) return usage;
    const startMs = endMs - usageTimeRangeToMs(timeRange);
    return buildUsageSnapshotFromSummary(
      filterSummaryBucketsByWindow(summaryBuckets, startMs, endMs)
    );
  }, [lastRefreshedAt, summaryBuckets, timeRange, usage]);
  const hourWindowHours =
    timeRange === 'all' ? undefined : HOUR_WINDOW_BY_USAGE_TIME_RANGE[timeRange];
  const rateWindowMinutes = useMemo(() => {
    if (timeRange === '7h') return 7 * 60;
    if (timeRange === '24h') return 24 * 60;
    if (timeRange === '7d') return 7 * 24 * 60;
    if (timeRange === '30d') return 30 * 24 * 60;
    return 30;
  }, [timeRange]);
  const nowMs = lastRefreshedAt?.getTime() ?? 0;

  const { requestsSparkline, tokensSparkline, rpmSparkline, tpmSparkline, costSparkline } =
    useSparklines({
      usage: filteredUsage as UsagePayload | null,
      loading,
      nowMs,
      timeRange,
      modelPrices
    });

  const modelNames = useMemo(() => getModelNamesFromUsage(usage), [usage]);
  const modelStats = useMemo<ModelStat[]>(() => getModelStats(filteredUsage, modelPrices), [filteredUsage, modelPrices]);

  const handleTimeRangeChange = useCallback((range: UsageTimeRange) => {
    setTimeRange(range);
  }, []);

  const usageStatsToggle = (
    <div className={styles.periodButtons}>
      <Button
        variant={usageStatsDimension === 'model' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setUsageStatsDimension('model')}
      >
        {t('monitoring_center.usage_stats_by_model')}
      </Button>
      <Button
        variant={usageStatsDimension === 'apiKey' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setUsageStatsDimension('apiKey')}
      >
        {t('monitoring_center.usage_stats_by_api_key')}
      </Button>
    </div>
  );

  return (
    <div className={styles.container}>
      {loading && !usage && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('monitoring_center.title')}</h1>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeButtons}>
            {USAGE_TIME_RANGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={timeRange === option.value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => handleTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh().catch(() => {})}
            disabled={loading}
          >
            {loading ? t('common.loading') : t('usage_stats.refresh')}
          </Button>
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <MonitorStatCards
        usage={filteredUsage as UsagePayload | null}
        loading={loading}
        modelPrices={modelPrices}
        rateWindowMinutes={rateWindowMinutes}
        timeRange={timeRange}
        sparklines={{
          requests: requestsSparkline,
          tokens: tokensSparkline,
          rpm: rpmSparkline,
          tpm: tpmSparkline,
          cost: costSparkline
        }}
      />

      <div className={styles.topGrid}>
        <MonitorTrendChart
          usage={filteredUsage as UsagePayload | null}
          loading={loading}
          isDark={isDark}
          isMobile={isMobile}
          hourWindowHours={hourWindowHours}
          modelPrices={modelPrices}
        />
        <ModelUsageDistributionCard
          modelStats={modelStats}
          loading={loading}
          isDark={isDark}
        />
      </div>

      <div className={styles.middleGrid}>
        {usageStatsDimension === 'model' ? (
          <ModelStatsCard
            modelStats={modelStats}
            loading={loading}
            hasPrices={true}
            title={t('monitoring_center.usage_stats_title')}
            extra={usageStatsToggle}
          />
        ) : (
          <MonitorApiKeyStatsCard
            usage={filteredUsage as UsagePayload | null}
            loading={loading}
            modelPrices={modelPrices}
            title={t('monitoring_center.usage_stats_title')}
            extra={usageStatsToggle}
          />
        )}
        <PriceSettingsCard
          modelNames={modelNames}
          modelPrices={modelPrices}
          onPricesChange={setModelPrices}
        />
      </div>

      <div className={styles.fullWidthSection}>
        <RequestEventsDetailsCard
          usage={filteredUsage}
          records={usageRecords}
          loading={loading}
          geminiKeys={config?.geminiApiKeys || []}
          claudeConfigs={config?.claudeApiKeys || []}
          codexConfigs={config?.codexApiKeys || []}
          vertexConfigs={config?.vertexApiKeys || []}
          openaiProviders={config?.openaiCompatibility || []}
          authFiles={authFiles}
          fixedHeight
          onRefresh={handleRefresh}
          lastRefreshedAt={lastRefreshedAt}
        />
      </div>
    </div>
  );
}
