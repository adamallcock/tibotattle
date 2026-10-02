import { describe, expect, it } from 'vitest';
import { analyticsFeatureControls, type AnalyticsFeatureControlEnv } from '../src/analytics-feature-controls';

describe('independent analytics activation controls',()=>{
  it('keeps canonical work disabled until its explicit activation, independently of existing paths',()=>{
    expect(analyticsFeatureControls({})).toEqual({sharedFeatures:false,modelBlocks:false,canonicalPipeline:false});
    expect(analyticsFeatureControls({STORAGE_ANALYTICS_SHARED_FEATURES:'enabled',STORAGE_ANALYTICS_MODEL_BLOCKS:'enabled'}))
      .toEqual({sharedFeatures:true,modelBlocks:true,canonicalPipeline:false});
    expect(analyticsFeatureControls({STORAGE_ANALYTICS_CANONICAL_PIPELINE:'enabled'}))
      .toEqual({sharedFeatures:false,modelBlocks:false,canonicalPipeline:true});
    expect(analyticsFeatureControls({STORAGE_ANALYTICS_CANONICAL_PIPELINE:'disabled'}).canonicalPipeline).toBe(false);
  });
  it('refuses malformed canonical activation before any scheduled work',()=>{
    for(const value of ['ENABLED','true','',true,1,null]){
      const input:AnalyticsFeatureControlEnv={};
      Reflect.set(input,'STORAGE_ANALYTICS_CANONICAL_PIPELINE',value);
      expect(()=>analyticsFeatureControls(input)).toThrow('STORAGE_ANALYTICS_FEATURE_CONFIGURATION_INVALID');
    }
  });
});
