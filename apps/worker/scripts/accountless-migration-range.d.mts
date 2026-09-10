import type {MovementState,MovementStatement,MovementResult,MovementPermission} from './accountless-migration-movement.mjs';
export type RangeMovementState = MovementState & {rangeRecordBatches?: true};
export type RangeMovementSelection = {
  selected_rows: number; first_key: string | null; last_key: string | null;
  selected_bytes: number; max_row_bytes: number;
};
export function usesRangeRecordBatch(current: RangeMovementState): boolean;
export function accountlessRangeSelection(current: RangeMovementState, options?: {maxRows?: number}): MovementStatement;
export function planAccountlessRangeBatch(options: {
  current: RangeMovementState; selection: RangeMovementSelection; expectedRevision: number;
  maxRows?: number; maxBytes?: number; permission?: MovementPermission | null;
}): {statements: MovementStatement[]; result: MovementResult; readback: MovementStatement};

export function balancedSqlExpression(terms: readonly string[], operator: "+" | "AND"): string;
