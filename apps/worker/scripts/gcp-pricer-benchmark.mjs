#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cpus } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { corpusRecords, syntheticManifest, WORKER_ROOT } from "./gcp-pricer-perf-lib.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const value = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const corpusRoot = value("corpus", null);
assert.ok(corpusRoot, "--corpus points to the explicitly synthetic full corpus");
const calls = Number(value("calls", "200000")), repeats = Number(value("repeats", "3"));
assert.ok(Number.isSafeInteger(calls) && calls > 0 && Number.isSafeInteger(repeats) && repeats > 0);
await syntheticManifest(corpusRoot);
const directory = await mkdtemp(join(tmpdir(), "gcp-pricer-bench-"));
try {
  const sampledRows = [...corpusRecords(corpusRoot, 997)];
  const sampleFormats = { 10: 0, 11: 0, 12: 0 };
  for (const row of sampledRows) sampleFormats[row.format] += 1;
  assert.ok(Object.values(sampleFormats).every((count) => count > 0), "sample covers all three telemetry formats");
  const sample = sampledRows.map(({ record, eventTime }) => ({ record, time: eventTime }));
  assert.ok(sample.length > 1000 && sample.length < 15000);
  const sampleFile = join(directory, "sample.json");
  await writeFile(sampleFile, JSON.stringify(sample));
  const measurements = [];
  for (const entrypoint of ["event", "record"]) for (const state of ["cold", "warm"]) for (const implementation of ["reference", "fast"]) {
    const cpuRuns = [];
    for (let repetition = 0; repetition < repeats; repetition += 1) {
      const { stdout } = await run(process.execPath, ["--expose-gc", join(WORKER_ROOT, "scripts/gcp-pricer-benchmark-child.mjs"),
        implementation, state, entrypoint, String(calls), sampleFile], { maxBuffer: 128 * 1024 * 1024 });
      cpuRuns.push(JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"marker":"end"'))));
    }
    const { stdout } = await run(process.execPath, ["--expose-gc", "--trace-gc-nvp", join(WORKER_ROOT, "scripts/gcp-pricer-benchmark-child.mjs"),
      implementation, state, entrypoint, String(calls), sampleFile], { maxBuffer: 128 * 1024 * 1024 });
    let begin = null, end = null, allocation = 0, scavenges = 0, lastAfter = null;
    for (const line of stdout.split("\n")) {
      if (line.includes('"marker":"begin"')) { begin = JSON.parse(line); lastAfter = begin.heapBefore; }
      else if (line.includes('"marker":"end"')) { end = JSON.parse(line); break; }
      else if (begin && /\bgc=/.test(line)) {
        const allocated = line.match(/\ballocated=(\d+)/), after = line.match(/\btotal_size_after=(\d+)/);
        assert.ok(allocated && after, "V8 must expose allocated bytes and post-GC heap size");
        allocation += Number(allocated[1]); lastAfter = Number(after[1]);
        if (/\bgc=s\b/.test(line)) scavenges += 1;
      }
    }
    assert.ok(begin && end);
    allocation += end.heapAfter - lastAfter;
    assert.ok(allocation >= 0);
    const median = (key) => cpuRuns.map((item) => item[key]).sort((a, b) => a - b)[Math.floor(cpuRuns.length / 2)];
    const measurement = { implementation, state, entrypoint, calls, sampleEvents: sample.length,
      wallUsPerCall: median("wallUsPerCall"), cpuUsPerCall: median("cpuUsPerCall"),
      bytesAllocatedPerCall: allocation / calls, scavengesPerMillion: scavenges * 1_000_000 / calls,
      checksum: end.checksum, cpuRuns: cpuRuns.map(({ wallUsPerCall, cpuUsPerCall }) => ({ wallUsPerCall, cpuUsPerCall })) };
    measurements.push(measurement);
    console.log(JSON.stringify({ progress: "benchmark", ...measurement }));
  }
  const comparisons = [];
  for (const entrypoint of ["event", "record"]) for (const state of ["cold", "warm"]) {
    const before = measurements.find((row) => row.entrypoint === entrypoint && row.state === state && row.implementation === "reference");
    const after = measurements.find((row) => row.entrypoint === entrypoint && row.state === state && row.implementation === "fast");
    assert.equal(after.checksum, before.checksum, "both implementations consume the same outputs");
    comparisons.push({ entrypoint, state, cpuSpeedup: before.cpuUsPerCall / after.cpuUsPerCall,
      allocationReduction: before.bytesAllocatedPerCall / after.bytesAllocatedPerCall,
      projectedCpuSecondsSaved: [115_000_000, 130_000_000].map((n) => n * (before.cpuUsPerCall - after.cpuUsPerCall) / 1_000_000),
      projectedAllocationGbSaved: [115_000_000, 130_000_000].map((n) => n * (before.bytesAllocatedPerCall - after.bytesAllocatedPerCall) / 1_000_000_000) });
  }
  console.log(JSON.stringify({ status: "ok", node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, repeats, sampleFormats, allocationMethod: "V8 trace-gc-nvp allocated bytes between markers plus uncollected heap tail; separate untraced CPU runs",
    coldDefinition: "empty structural cache and no pricer warm-up at batch start; plan compilation and JIT amortized over batch",
    measurements, comparisons }));
} finally { await rm(directory, { recursive: true, force: true }); }
