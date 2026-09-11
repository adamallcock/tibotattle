export type MovementStatement = { sql: string; params: readonly (string | number | null)[] };
export type MovementDescriptor = { columns: string[]; hasRowid: boolean; keys: string[]; integerKeys: string[] };
export type MovementState = {
  digest: string; phase: 'evacuate' | 'restore' | 'complete'; revision: number; tableIndex: number; cursor: number;
  retainedObjectTables?: string[]; rangeRecordBatches?: true;
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
export type MovementSource = { name: string; sql: string };
export type MovementSchemaObject = { type: string; name: string; tbl_name: string; sql: string };
export type MovementPermission = { begin: MovementStatement; end: readonly MovementStatement[] };
/** Compound entries must go to a normal-query SQL batch, never D1.prepare(). */
export type MovementPhaseStatement = MovementStatement & { compound?: true };
export type MovementPhasePlan = { statements: MovementPhaseStatement[]; current: MovementState; readback: MovementStatement };
export function planAccountlessMovementSetup(options: {
  sources: MovementSource[]; schemaObjects: MovementSchemaObject[];
  foreignKeys: Record<string, Array<{ table: string }>>;
  tableInfo: Record<string, Array<{ name: string; type: string; pk: number }>>;
  sequences: Array<{name: string; seq: string}>;
  permission?: MovementPermission | null;
  /** Requires separate admission of the residual journal size before remote execution. */
  retainObjectReferences?: boolean;
  rangeRecordBatches?: boolean;
}): MovementPhasePlan;
export function planAccountlessMovementTransition(options: {
  sources: MovementSource[]; current: MovementState; expectedRevision: number;
  canonicalObjects: MovementSchemaObject[]; permission?: MovementPermission | null;
  guardStatements?: readonly MovementStatement[];
}): MovementPhasePlan;
