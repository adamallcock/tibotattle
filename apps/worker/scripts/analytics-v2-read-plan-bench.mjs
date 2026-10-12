/** Sequential, content-free concurrency measurement; see A/B script header. */
import { readPlanAB } from "./analytics-v2-read-plan-ab.mjs";
try {
  process.stdout.write(`${JSON.stringify(await readPlanAB([...process.argv.slice(2), "--bench"]))}\n`);
} catch {
  process.stderr.write("READ_PLAN_BENCH_FAILED\n");
  process.exitCode = 1;
}
