/** Shared private producer contract; stores own execution and commit policy. */
import type {AnalyticsWorkLease,AnalyticsWorkExecutionBudget,AnalyticsWorkOutcome} from './analytics-partition-work';
import type {SharedAnalyticsFeatureInput} from './storage-analytics-shared-features';
export type StorageDailyCanonicalPreparation = (input:SharedAnalyticsFeatureInput)=>NonNullable<SharedAnalyticsFeatureInput['canonicalPreparation']>;

export interface AnalyticsCanonicalSource {
 readonly sourceId:string;readonly sourceNamespace:string;readonly database:D1Database;
}

export interface AnalyticsPublicationWorkInput {
 readonly target:D1Database;readonly sources:readonly {sourceId:string;sourceNamespace:string;database:D1Database}[];
 readonly lease:AnalyticsWorkLease;readonly budget:AnalyticsWorkExecutionBudget;
 readonly canonicalPreparation:StorageDailyCanonicalPreparation;
}
export interface AnalyticsPublicationWorkResult {
 readonly outcome:AnalyticsWorkOutcome;readonly reason:string;readonly completedWithinLease:boolean;
 readonly statements:number;readonly closureKey?:string;
}
