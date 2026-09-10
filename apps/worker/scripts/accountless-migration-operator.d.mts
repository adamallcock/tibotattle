import type { MovementState, MovementStatement, MovementPermission, MovementPhaseStatement } from './accountless-migration-movement.mjs';
export type MovementPhaseReceipt = {
 schemaVersion: 'accountless-movement-phase-v1'; outcome: 'complete' | 'stopped' | 'uncertain'; code: string | null;
 batches: number; attemptedBatches: number; rows: number; bytes: number;
 phase: MovementState['phase'] | null; checkpointRevision: number | null; checkpointSha256: string | null; durationMs: number;
};
export type MovementTransport = {
 read(statement: MovementStatement, options?: {timeoutMs: number}): Promise<Array<Record<string, unknown>>>;
 /** Must issue exactly one atomic transaction; thrown failures are treated as unknown outcomes. */
 batch(packet: { statements: MovementStatement[]; sql: string; timeoutMs?: number }): Promise<{ outcome: 'committed' | 'rolled_back' }>;
};
export function renderMovementSql(statements: readonly MovementPhaseStatement[]): string;
export function runAccountlessMovementPhase(options: {
 startJournal: MovementState; operationId: string; permission: MovementPermission; transport: MovementTransport;
 maxRows?: number; maxBytes?: number; maxSqlBytes?: number; maxBatches?: number; timeoutMs?: number;
 now?: () => number;
 /** Synchronous content-free progress sink; exact private checkpoint is returned separately. */
 onProgress?: (receipt: Readonly<MovementPhaseReceipt>) => void;
}): Promise<{ receipt: MovementPhaseReceipt; checkpoint: MovementState }>;
