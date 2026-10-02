/** Exact native dependency value; independent of storage adapters. */
export interface EffectiveHistoryDependency {
  version: 'effective-history-dependency-v3'; participantId: string; fromDay: string; throughDay: string;
  /** The correction-aware reader changes source selection at activation even
   * when no owner revision or historical header changes. */
  correctionRuntime: 'staged'|'active';
  /** The retained source streams represented by this identity. Session rows
   * are opt-in because usage/quota callers must keep their existing key. */
  streams: readonly ('quota'|'session'|'usage')[];
  v1: readonly Record<string, unknown>[]; v11: readonly Record<string, unknown>[];
  v12: readonly Record<string, unknown>[]; corrections: readonly Record<string, unknown>[];
  /** Immutable header coordinates for selected occurrences whose retained
   * variant lies outside the requested window. In-window rows are covered by
   * the family metadata vectors above. Correction rows use a per-day
   * count/frontier summary rather than one history/fact row per occurrence. */
  occurrenceLinks: readonly Record<string, unknown>[];
}
