import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { v11UsageRecord } from "./kernel-parity/helpers/telemetry-v11";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { parseStrictJson } from "../src/strict-json";
import * as current from "../src/telemetry-usage-reconciliation";
import * as vendor from "../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-reconciliation";
import { reconcileGroups } from "../vendor/analytics-d43c8f92/entry";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
async function compiled(contents: string, strictForbidden = false): Promise<any> {
  const result = await build({ stdin: { contents, loader: "ts", resolveDir: resolve(root, "src/analytics-v2") }, bundle: true,
    platform: "node", format: "cjs", write: false, mainFields: ["module", "main"],
    plugins: strictForbidden ? [{ name: "strict-parser-must-not-run", setup(build) {
      build.onResolve({ filter: /strict-json$/ }, () => ({ path: "strict-json", namespace: "forbidden" }));
      build.onLoad({ filter: /.*/, namespace: "forbidden" }, () => ({ contents: 'export function parseStrictJson(){throw new Error("STRICT_JSON_UNEXPECTED");}' }));
    } }] : [],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
function reconciliation(contents: string, extra = "") {
  // Match relative imports from the original module without changing its bytes.
  return compiled(contents.replaceAll('from "./', 'from "../') + extra);
}
const oldText = readFileSync(new URL("./fixtures/usage-reconciliation-strict-oracle.ts.txt", import.meta.url), "utf8");
const oracle = await reconciliation(oldText);
const privateModule = await reconciliation(readFileSync(new URL("../src/telemetry-usage-reconciliation.ts", import.meta.url), "utf8"), "\nexport {parseInternalAnalyticsJson};");
const privateNative = privateModule.parseInternalAnalyticsJson;
const gcp = await compiled(readFileSync(new URL("../src/analytics-v2/occurrence-source.ts", import.meta.url), "utf8") + "\nexport {parseCorrectionFact, assembleOccurrences};", true);
const day = "2026-10-03", owner = "a".repeat(64);
const record = v11UsageRecord(day);
const raw = canonicalTelemetryV11Json(record);
const input = { format: "v11" as const, recordJson: raw };
const parsing = { jsonParsing: "internal_analytics_replay" as const };
const duplicated = raw.replace('"totalInputContextTokens":1000', '"totalInputContextTokens":7,"totalInputContextTokens":1000');
function errorShape(callback: () => unknown) {
  try { callback(); return null; } catch (error) {
    const e = error as Error & {code?: string; status?: number}; return {name:e.name,message:e.message,code:e.code,status:e.status};
  }
}

describe("explicit internal analytics native parsing decision", () => {
  it("keeps the immutable original parser and strict reconciliation oracle", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../src/strict-json.ts", import.meta.url))).digest("hex"))
      .toBe("137866597bebc2239e34a24aa2dc1b97069e4b2bd3b4203ce24df21570a2137b");
    expect(createHash("sha256").update(oldText).digest("hex")).toBe("35458510a2f2c69710bf7cf78e701cdd0e504cbbe903ba3a0ecc1ace6271d15c");
  });
  it("accepts last decoded duplicate value only in explicit replay composition", async () => {
    expect(duplicated).not.toBe(raw);
    for (const module of [current, vendor]) {
      await expect(module.prepareUsageCorrectionAssertion({ ...input, recordJson: duplicated })).rejects.toMatchObject({code:"USAGE_CORRECTION_INVALID"});
      expect(await module.prepareAnalyticsReplayUsageCorrectionAssertion({...input,recordJson:duplicated}))
        .toStrictEqual(await oracle.prepareUsageCorrectionAssertion(input));
      const strict = module.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId});
      await expect(strict.append([{...input,recordJson:duplicated,ownerScope:owner}])).rejects.toMatchObject({code:"USAGE_CORRECTION_INVALID"});
      const replay = module.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId,...parsing});
      await replay.append([{...input,recordJson:duplicated,ownerScope:owner}]);
      expect(replay.close().effectiveLegacyRecord).toBe((await oracle.reconcileUsageCorrectionSources({ownerScope:owner,sources:[{...input,ownerScope:owner}]}))[0].effectiveLegacyRecord);
    }
    expect(errorShape(()=>parseStrictJson('{"prompt":"PRIVATE_CONTENT","prompt":"safe"}',"DECRYPTION_FAILED")))
      .toStrictEqual({name:"ApiError",message:"DECRYPTION_FAILED",code:"DECRYPTION_FAILED",status:400});
  });
  it("preserves native values, malformed refusal, custom safe errors and non-string behavior", () => {
    for(const text of ['null','-0','1e400','"\\ud800"','{"a\\u0000b":1,"__proto__":{"x":true}}','{"a":1,"\\u0061":2}']) expect(privateNative(text)).toStrictEqual(JSON.parse(text));
    for(const text of ['', '{"a":PRIVATE_CONTENT}', '[01]', '[1,]', '/*PRIVATE_CONTENT*/{}', '{}{}', '"\\x00"']) {
      expect(errorShape(()=>privateNative(text,"DECRYPTION_FAILED"))).toStrictEqual({name:"ApiError",message:"DECRYPTION_FAILED",code:"DECRYPTION_FAILED",status:400});
    }
    expect(errorShape(()=>privateNative(null))).toStrictEqual(errorShape(()=>parseStrictJson(null as unknown as string)));
  });
  it("preserves canonical correction assertions and full accumulator replay/order semantics", async () => {
    const expected=await oracle.prepareUsageCorrectionAssertion(input);
    for(const module of [current,vendor]) {
      expect(await module.prepareUsageCorrectionAssertion(input)).toStrictEqual(expected);
      expect(await module.prepareAnalyticsReplayUsageCorrectionAssertion(input)).toStrictEqual(expected);
      for(const sources of [[input], [input,input], [{...input,recordJson:canonicalTelemetryV11Json({...record,totalInputContextTokens:null})},input]]) {
        const old=oracle.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId});
        const replay=module.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId,...parsing});
        for(const source of sources){await old.append([{...source,ownerScope:owner}]);await replay.append([{...source,ownerScope:owner}]);}
        expect(replay.close()).toStrictEqual(old.close());
      }
    }
  });
  it("retains schema/privacy, byte limits, ownership, occurrence and lifecycle failures in replay", async () => {
    for(const module of [current,vendor]) {
      expect(() => module.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId,jsonParsing:"unknown" as any})).toThrow("USAGE_CORRECTION_INVALID");
      for(const recordJson of [raw.slice(0,-1)+',"prompt":"PRIVATE_CONTENT"}', raw.replace('"modelId":"gpt-5.6-sol"','"modelId":null'), '{"a":PRIVATE_CONTENT}'])
        await expect(module.prepareAnalyticsReplayUsageCorrectionAssertion({...input,recordJson})).rejects.toMatchObject({code:"USAGE_CORRECTION_INVALID"});
      await expect(module.prepareAnalyticsReplayUsageCorrectionAssertion({...input,recordJson:' '.repeat(module.MAX_USAGE_CORRECTION_RECORD_BYTES+1)})).rejects.toMatchObject({code:"USAGE_CORRECTION_LIMIT"});
      const replay=module.createUsageCorrectionOccurrenceAccumulator({ownerScope:owner,occurrenceId:record.eventId,...parsing});
      await expect(replay.append([{...input,ownerScope:"different-owner"}])).rejects.toMatchObject({code:"USAGE_CORRECTION_SCOPE_MISMATCH"});
      await replay.append([{...input,ownerScope:owner}]);replay.close();
      await expect(replay.append([{...input,ownerScope:owner}])).rejects.toMatchObject({code:"USAGE_CORRECTION_CLOSED"});
    }
  });
  it("actual GCP assembly chooses replay while the vendored default remains strict", async () => {
    const ordered=[{occurrence_id:record.eventId,observed_at_ms:Date.parse(record.eventTime)}];
    const direct=[{format:"v11",occurrence_id:record.eventId,source_row_id:1,record_json:duplicated}];
    await expect(reconcileGroups(owner,"synthetic-participant",day,ordered as any,direct as any,[],[])).rejects.toMatchObject({code:"USAGE_CORRECTION_INVALID"});
    const result=await gcp.assembleOccurrences(new Map([[Math.floor(Date.parse(day)/86400000),new Map([[record.eventId,ordered[0]]])]]),"synthetic-participant",owner,"usage",
      {direct:new Map([[record.eventId,direct]]),v12:new Map(),facts:new Map()});
    expect([...result.values()][0]).toHaveLength(1);
  });
  it("actual GCP correction reconstruction chooses replay and keeps digest proof", async () => {
    const assertion=await oracle.prepareUsageCorrectionAssertion(input);
    const row: Record<string,unknown>={source_format:11,event_time_ms:Date.parse(record.eventTime),occurrence_id:encodeTypedTelemetryId(record.eventId),session_blob:encodeTypedTelemetryId(record.sessionUuid),
      provider_value:record.provider,model_value:record.modelId,speed_mode_value:record.speedMode,api_service_tier_value:record.apiServiceTier,surface_value:record.surface,billing_surface_value:record.billingSurface,
      reasoning_effort_value:record.reasoningEffort,agent_scope_value:record.agentScope,outcome_value:record.outcome,total_input_context_tokens:record.totalInputContextTokens,
      input_uncached_tokens:record.components.inputUncachedTokens,input_cache_read_tokens:record.components.inputCacheReadTokens,input_cache_write_tokens:record.components.inputCacheWriteTokens,
      output_text_tokens:record.components.outputTextTokens,output_reasoning_tokens:record.components.outputReasoningTokens,output_combined_tokens:record.components.outputCombinedTokens,
      attribution_account_basis:0,attribution_account_track_blob:new Uint8Array(),attribution_plan_basis:1,attribution_plan_type_value:"pro",attribution_plan_era_blob:new Uint8Array(),
      record_digest:Buffer.from(assertion.recordDigest,"hex"),base_digest:Buffer.from(assertion.baseDigest,"hex"),fact_method_version:1,id:1,fact_id:1,participant_id:"synthetic-participant",owner_digest:Buffer.from(owner,"hex"),
      owner_revision:1,authority_epoch:1,namespace_id:1,owner_id:1,device_id:1,chunk_id:1,source_storage_row_id:1,source_row_id:1,source_chunk_digest:Buffer.alloc(32),source_event_digest:Buffer.alloc(32),fact_captured_at_ms:Date.parse(day)};
    const fact=await gcp.parseCorrectionFact(row);expect(fact.recordJson).toBe(raw);
    await expect(gcp.parseCorrectionFact({...row,record_digest:Buffer.alloc(32)})).rejects.toMatchObject({code:"ANALYTICS_V2_SOURCE_CONFLICT"});
  });
});
