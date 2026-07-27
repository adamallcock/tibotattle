import { isDeepStrictEqual } from "node:util";

const METRIC_POLICIES = Object.freeze([
  {
    name: "usageEvents",
    cap: 1_000,
    quantum: 10,
    comparisonUnit: "events",
    aggregateUnit: "events_rounded_down",
    value(event) {
      return 1;
    },
  },
  {
    name: "inputUncachedTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.inputUncachedTokens;
    },
  },
  {
    name: "inputCacheReadTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.inputCacheReadTokens;
    },
  },
  {
    name: "inputCacheWriteTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.inputCacheWriteTokens;
    },
  },
  {
    name: "outputTextTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.outputTextTokens;
    },
  },
  {
    name: "outputReasoningTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.outputReasoningTokens;
    },
  },
  {
    name: "outputCombinedTokens",
    cap: 5_000_000,
    quantum: 100_000,
    comparisonUnit: "tokens",
    aggregateUnit: "tokens_rounded_down",
    value(event) {
      return event.components.outputCombinedTokens;
    },
  },
  {
    name: "toolUnits",
    cap: 1_000,
    quantum: 10,
    comparisonUnit: "units",
    aggregateUnit: "tool_units_rounded_down",
    value(event) {
      return Object.values(event.toolClassCounts)
        .reduce((sum, value) => checkedAdd(sum, value, "toolUnits"), 0);
    },
  },
]);

function checkedAdd(left, right, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new Error(`Cannot derive a safe ${label} expectation.`);
  }
  return sum;
}

function cellKey(provider, modelId) {
  return `${provider}\0${modelId}`;
}

function cellMap(cells, label) {
  if (!Array.isArray(cells)) {
    throw new Error(`${label} did not contain a cell array.`);
  }
  const mapped = new Map();
  for (const cell of cells) {
    const key = cellKey(cell?.provider, cell?.modelId);
    if (mapped.has(key)) throw new Error(`${label} contained a duplicate cell.`);
    mapped.set(key, cell);
  }
  return mapped;
}

function assertCellsMatch(actualCells, expectedCells, label) {
  const actualByKey = cellMap(actualCells, label);
  if (actualByKey.size !== expectedCells.length) {
    throw new Error(
      `${label} exposed ${actualByKey.size} cells; expected ${expectedCells.length}.`,
    );
  }
  for (const expected of expectedCells) {
    const actual = actualByKey.get(cellKey(expected.provider, expected.modelId));
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `${label} did not match the derived values for`
        + ` ${expected.provider}/${expected.modelId}.`,
      );
    }
  }
}

export function deriveCommunityExpectations(contribution, participantCount) {
  if (!Array.isArray(contribution?.usageEvents) || contribution.usageEvents.length === 0) {
    throw new Error("A contribution with usage events is required.");
  }
  if (!Number.isSafeInteger(participantCount) || participantCount < 1) {
    throw new Error("A positive safe participant count is required.");
  }

  const sourceCells = new Map();
  for (const event of contribution.usageEvents) {
    const key = cellKey(event.provider, event.modelId);
    let sourceCell = sourceCells.get(key);
    if (!sourceCell) {
      sourceCell = {
        provider: event.provider,
        modelId: event.modelId,
        values: Object.fromEntries(
          METRIC_POLICIES.map(({ name }) => [name, null]),
        ),
      };
      sourceCell.values.usageEvents = 0;
      sourceCell.values.toolUnits = 0;
      sourceCells.set(key, sourceCell);
    }
    for (const policy of METRIC_POLICIES) {
      const eventValue = policy.value(event);
      if (eventValue === null) continue;
      if (!Number.isSafeInteger(eventValue) || eventValue < 0) {
        throw new Error(`Cannot derive an invalid ${policy.name} expectation.`);
      }
      sourceCell.values[policy.name] = checkedAdd(
        sourceCell.values[policy.name] ?? 0,
        eventValue,
        policy.name,
      );
    }
  }

  const comparisonCells = [];
  const aggregateCells = [];
  const sortedCells = [...sourceCells.values()].sort(
    (left, right) => left.provider.localeCompare(right.provider)
      || left.modelId.localeCompare(right.modelId),
  );
  for (const sourceCell of sortedCells) {
    const comparisonMetrics = {};
    const aggregateMetrics = {};
    for (const policy of METRIC_POLICIES) {
      const participantValue = sourceCell.values[policy.name];
      if (participantValue === null) {
        comparisonMetrics[policy.name] = { status: "community_not_released" };
        aggregateMetrics[policy.name] = { status: "suppressed" };
        continue;
      }
      const participantClippedValue = Math.min(participantValue, policy.cap);
      const cohortClippedValue = checkedAdd(
        0,
        participantClippedValue * participantCount,
        `${policy.name} cohort`,
      );
      const communityRoundedValue = Math.floor(
        cohortClippedValue / policy.quantum,
      ) * policy.quantum;
      comparisonMetrics[policy.name] = {
        status: "comparable",
        participantClippedValue,
        communityRoundedValue,
        unit: policy.comparisonUnit,
      };
      aggregateMetrics[policy.name] = {
        status: "released",
        value: communityRoundedValue,
        unit: policy.aggregateUnit,
      };
    }
    comparisonCells.push({
      provider: sourceCell.provider,
      modelId: sourceCell.modelId,
      participantHasActivity: true,
      metrics: comparisonMetrics,
    });
    aggregateCells.push({
      provider: sourceCell.provider,
      modelId: sourceCell.modelId,
      metrics: aggregateMetrics,
    });
  }
  return { comparisonCells, aggregateCells };
}

export function assertDerivedCommunityExpectations({
  contribution,
  participantCount,
  comparisonCells,
  aggregateCells,
}) {
  const expected = deriveCommunityExpectations(contribution, participantCount);
  assertCellsMatch(
    comparisonCells,
    expected.comparisonCells,
    "Private community comparison",
  );
  assertCellsMatch(
    aggregateCells,
    expected.aggregateCells,
    "Published community aggregate",
  );
  return expected;
}
