/** Independent switches keep schema deployment, code deployment and activation
 * separate. Unknown values fail closed; no default silently enables work. */
export interface AnalyticsFeatureControlEnv {
  STORAGE_ANALYTICS_SHARED_FEATURES?:'enabled'|'disabled';
  STORAGE_ANALYTICS_MODEL_BLOCKS?:'enabled'|'disabled';
}
export function analyticsFeatureControls(env:AnalyticsFeatureControlEnv):{
  sharedFeatures:boolean;modelBlocks:boolean;
}{
  for(const value of [env.STORAGE_ANALYTICS_SHARED_FEATURES,env.STORAGE_ANALYTICS_MODEL_BLOCKS])
    if(value!==undefined&&value!=='disabled'&&value!=='enabled')
      throw new Error('STORAGE_ANALYTICS_FEATURE_CONFIGURATION_INVALID');
  return {sharedFeatures:env.STORAGE_ANALYTICS_SHARED_FEATURES==='enabled',
    modelBlocks:env.STORAGE_ANALYTICS_MODEL_BLOCKS==='enabled'};
}
