export type MovementStatement = { sql: string; params: readonly (string | number | null)[] };
export type MovementDescriptor = { columns: string[]; hasRowid: boolean; keys: string[]; integerKeys: string[] };
export type MovementState = {
  digest: string; phase: 'evacuate' | 'restore' | 'complete'; revision: number; tableIndex: number; cursor: number;
  order: string[]; descriptors: Record<string, MovementDescriptor>;
  sequences: Array<{ name: string; seq: string }>;
  canonicalObjects: null | Array<{ type: string; name: string; tbl_name: string; sql: string }>;
};
export type MovementSelectionRow = { _bytes: number; [key: `_key${number}`]: string };
export type MovementResult = { revision: number; phase: MovementState['phase']; rows: number; bytes: number };
export function accountlessMovementSelection(current: MovementState, options?: { maxRows?: number }): MovementStatement;
export function planAccountlessMovementBatch(options: {
  current: MovementState; selectedRows: MovementSelectionRow[]; expectedRevision: number;
  maxRows?: number; maxBytes?: number;
  permission?: null | { begin: MovementStatement; end: readonly MovementStatement[] };
}): { statements: MovementStatement[]; result: MovementResult; readback: MovementStatement };
