/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import {
  computeKeyStats,
  normalizeUsageData,
  type KeyStats,
  type UsageDeleteResponse,
  type UsageQueryRange,
  type UsageSummaryBucketSize,
  type UsageSummaryResponse,
} from '@/utils/usage';
import type { UsageDetail } from '@/utils/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;

// usage-statistics 插件端点（官方 CPA 已移除内建 usage API，改由插件提供）。
const USAGE_ENDPOINT = '/plugins/usage-statistics/usage';
const USAGE_SUMMARY_ENDPOINT = `${USAGE_ENDPOINT}/summary`;
const USAGE_RECORDS_ENDPOINT = `${USAGE_ENDPOINT}/records`;

export interface UsageSummaryParams extends UsageQueryRange {
  bucket?: UsageSummaryBucketSize;
}

export interface UsageRecordsParams extends UsageQueryRange {
  id?: string;
  api_key?: string;
  provider?: string;
  model?: string;
  failed?: boolean;
  /** 缺省 asc。「最近请求」类列表用 desc，否则要把整个范围翻完才能拿到最新记录。 */
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface UsageRecordsPage {
  records: UsageDetail[];
  next_cursor?: string;
  has_more: boolean;
}

export const usageApi = {
  /**
   * 获取使用统计原始数据
   */
  getUsage: (params?: UsageQueryRange) =>
    apiClient.get<Record<string, unknown>>(USAGE_ENDPOINT, { timeout: USAGE_TIMEOUT_MS, params }),

  /**
   * 获取聚合统计。响应大小只取决于「时间桶 × api_key × provider × model ×
   * source × auth_index」的组合数，与请求量无关。图表与统计卡片应该走这里，
   * 而不是把数千条原始记录拉到前端再算。
   */
  getSummary: (params?: UsageSummaryParams) =>
    apiClient.get<UsageSummaryResponse>(USAGE_SUMMARY_ENDPOINT, {
      timeout: USAGE_TIMEOUT_MS,
      params,
    }),

  /**
   * 获取原始记录分页。按 (timestamp, id) 游标翻页，第 N 页与第 1 页开销相同。
   * 仅用于真正需要逐条数据的地方：请求明细表、单条删除、失败日志。
   */
  getRecords: (params?: UsageRecordsParams) =>
    apiClient.get<UsageRecordsPage>(USAGE_RECORDS_ENDPOINT, {
      timeout: USAGE_TIMEOUT_MS,
      params,
    }),

  /**
   * 删除指定 usage 记录
   */
  deleteUsage: (ids: string[]) =>
    apiClient.delete<UsageDeleteResponse>(USAGE_ENDPOINT, {
      timeout: USAGE_TIMEOUT_MS,
      data: { ids },
    }),

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      payload = await usageApi.getUsage();
    }
    return computeKeyStats(normalizeUsageData(payload));
  }
};
