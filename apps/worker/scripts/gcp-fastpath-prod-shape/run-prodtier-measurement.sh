#!/bin/zsh
# MEAS-SYNTH production-tier cloud measurement: the full-recompute analytics
# refresh over the PRODUCTION-SHAPED synthetic corpus on a DISPOSABLE Cloud
# SQL instance of production's shape (db-custom-4-16384, PostgreSQL 17,
# dedicated cores), in the TEST project `tibotattle` only. Never production
# or staging. This script issues no gcloud command itself: every remote call
# goes through scripts/gcp-fastpath-test-deploy.mjs (D), whose builders pin
# the project, the region and the measurement names
# (tibotattle-meas-prodtier-<YYYYMMDD>, tibotattle-fastpath-meas-analytics-refresh),
# and through scripts/gcp-fastpath-seed.mjs --meas-instance, whose connection
# names no other instance. The instance is deleted on every exit the shell
# can trap (see "Teardown" below).
#
# Profiling (MEAS-SYNTH, 2026-10-03): the main deliverable is ONE profiled,
# UNCAPPED run per profile, which shows where its time goes even if it is
# killed: the Job's CPU profiler (ANALYTICS_V2_REFRESH_PROFILE=cpu) logs a
# content-free summary every MEAS_PROFILE_SUMMARY_SECONDS (10 min; written
# synchronously at a refresh checkpoint or on its timer: the reliable record)
# and at exit; on SIGTERM it also tries a "signal" line, best effort only (its
# handler runs only when the event loop is free, so a long synchronous compute
# call can outlast Cloud Run's grace period and end in SIGKILL first); the database's
# pg_stat_statements, pg_stat_database and pg_stat_io are snapshotted before
# the run, every MEAS_PGSTAT_INTERVAL during it and after it (meas-pgstat,
# read-only); Cloud Monitoring's CPU and memory series for the Job and the
# instance are read after it (meas-metrics, read-only). The guarded run (the
# production time guard's refusal) is optional and off by default.
#
#   zsh apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh
#
# Environment (all optional):
#   MEAS_INSTANCE   tibotattle-meas-prodtier-<YYYYMMDD> (default: today, UTC,
#                   evaluated ONCE here and written to $MEAS_OUT/instance). The
#                   date is only a name. Cloud SQL may hold a deleted
#                   instance's name for days (up to a week, per its
#                   documentation), so a retry after a teardown sets another
#                   unused valid date
#   MEAS_CORPUS     seed-source.mjs work directory (default
#                   ~/Library/Caches/tibotattle-meas-synth/full/seed); it must
#                   be the full-scale corpus (own3.matches all true)
#   MEAS_OUT        receipt directory (default
#                   ~/Documents/Coding/tibotattle-gcp-parity/receipts/gcp-meas-prodtier-<UTC stamp>)
#   MEAS_IMAGE      reuse an image digest built from this commit (skips build)
#   MEAS_PROFILES   refresh profiles to measure in order (default "dense", the
#                   production profile: inline, heap 12,288 MiB; add
#                   "dense-workers" for K-PAR's four compute Workers)
#   MEAS_UNCAPPED_TIMEOUT  the uncapped execution's task timeout and time
#                   guard (default 172,800 s, 48 h; 14,401..604,800)
#   MEAS_GUARDED    1: execute the guarded refresh first (the production time
#                   guard, 14,400 s) and run uncapped only when it does not
#                   complete. Default 0: deploy the Job without executing it
#                   (refresh --no-execute) and run uncapped directly
#   MEAS_CPU_PROFILE  the Job's CPU profiler: "cpu" (default) or "off"
#   MEAS_CPU_SAMPLE_US  its V8 sampling interval (default 10000 us; the
#                   receipt states the measured overhead, 1000..100000)
#   MEAS_PROFILE_SUMMARY_SECONDS  its summary period (default 600, 60..86400;
#                   the job's own default is 1800). A shorter period loses
#                   less at a kill and costs one more stop-fold-restart per
#                   period: about 0.1-0.15 s each on the 1% slice (the
#                   receipt), and every line reports its cost in `fold`
#   MEAS_PGSTAT_INTERVAL  seconds between meas-pgstat snapshots during a run
#                   (default 1800)
#
# Steps:
#   preflight  clean checkout of HEAD for every path the seed and image use;
#              corpus manifest present, full scale, OWN-3 matched; the seed
#              plan runs; the instance name is a measurement name
#   build      D build --commit=HEAD (the image must hold this commit's
#              analytics-refresh, which accepts the measurement Job)
#   create     D meas-create: the instance (about 10-15 min), its database
#              and the migrator and runtime IAM users, read back
#   seed       gcp-fastpath-seed.mjs seed --meas-instance (the reviewed
#              importer chain through the Cloud SQL connector as the migrator
#              IAM user; runs on THIS machine, Node 26, large heap; the local
#              import took 24 min, the connector's round trips make this
#              hours)
#   pgstat-enable  D meas-pgstat-enable: pg_stat_statements on the measurement
#              database and a reset after the seed. Failure is not fatal: the
#              run then measures without statement statistics (Query Insights
#              and the other views still apply)
#   per profile in MEAS_PROFILES:
#     pgstat   D meas-pgstat --label=<profile>-before (read-only)
#     refresh  MEAS_GUARDED=1: D refresh --meas-instance with the profile and
#              the production time guard
#              (ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400) at the corpus
#              clock; a guard refusal is data; the script stops unless
#              refresh.json exists and is not LOCK_HELD. Default: D refresh
#              --no-execute, which deploys the Job only (refresh.json records
#              executed false)
#     uncapped when no guarded run completed: D refresh-uncapped
#              (execution-level task timeout and guard at
#              MEAS_UNCAPPED_TIMEOUT), timed to its end. While it (or the
#              guarded run) executes, a sampler takes D meas-pgstat
#              --label=<profile>-during-NN every MEAS_PGSTAT_INTERVAL
#     pgstat   D meas-pgstat --label=<profile>-after
#     metrics  D meas-metrics over the execution's window (read-only)
#   collect    summarize-prodtier.mjs: summary.json, each run's duration,
#              outcome and phase timings, the profiler's last summary and
#              cadence, the database delta and the Cloud Monitoring summaries
#   teardown   (trap, every exit) D meas-teardown: cancel and delete the
#              measurement Job, delete the instance, read both back absent
#              from listings that succeeded; it fails while any measurement
#              instance remains in the project
#
# Teardown: every remote step after the trap (the database snapshots and the
# metrics read included) runs as a background child the shell waits on,
# because zsh runs an INT/TERM/HUP trap only once a FOREGROUND child exits
# (up to the 48 h cap) but interrupts `wait` at once. The trap
# signals the child and all its descendants (node and the gcloud it runs)
# and exits, and the EXIT trap tears down at once. Only the child's output is
# redirected, so the teardown's lines reach this script's log. SIGKILL (and a
# host crash or sleep) cannot be trapped: then run, by hand, from apps/worker,
#   $NODE26 scripts/gcp-fastpath-test-deploy.mjs meas-teardown \
#     --meas-instance=<the literal name in $MEAS_OUT/instance> --out=$MEAS_OUT/teardown-manual
# and check instanceAbsent and jobAbsent are true and
# remainingMeasurementInstances is [] in its meas-teardown.json. The remote
# execution survives the local child; meas-teardown cancels it.
#
# Stopping early: signal THIS shell only, by the PID it records at start:
#   kill -TERM $(cat $MEAS_OUT/pid)
# Never `pkill -f run-prodtier-measurement.sh`: that pattern also matches
# caffeinate (the Mac may then sleep during teardown) and the script's forked
# subshells, whose node processes it orphans.
#
# Profile lines while the run executes, or after a stop: they reach
# $MEAS_OUT/<profile>/uncapped/refresh-uncapped.json only when refresh-uncapped
# finishes polling, so mid-run or after a stop they exist only in Cloud
# Logging. Save them (read-only) where summarize-prodtier.mjs reads them:
#   gcloud logging read 'resource.type="cloud_run_job" AND
#     resource.labels.job_name="tibotattle-fastpath-meas-analytics-refresh" AND
#     jsonPayload.profile="analytics-refresh-profile-v1"' --project=tibotattle \
#     --freshness=3d --format=json > $MEAS_OUT/<profile>/profile-log.json
# (summary.json's profile.source then says "cloud-logging"; the newest
# execution's lines are used).
#
# Occupancy: the measurement instance and Job are this run's own, so the
# shared fast-path database's lock and Job are untouched and nothing else
# waits on this run.
set -u
setopt pipefail
H=${MEAS_PARITY_HOME:-$HOME/Documents/Coding/tibotattle-gcp-parity}
SCRIPT_DIR=${0:A:h}
WT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel) || { echo "not in a git checkout"; exit 2; }
WORKER=$WT/apps/worker
COMMIT=$(git -C "$WT" rev-parse HEAD)
INSTANCE=${MEAS_INSTANCE:-tibotattle-meas-prodtier-$(date -u +%Y%m%d)}
CORPUS=${MEAS_CORPUS:-$HOME/Library/Caches/tibotattle-meas-synth/full/seed}
OUT=${MEAS_OUT:-$H/receipts/gcp-meas-prodtier-$(date -u +%Y%m%dT%H%M%SZ)}
NODE26=${MEAS_NODE26:-$HOME/.nvm/versions/node/v26.2.0/bin/node}
NOW=2026-10-01T12:46:00.000Z
PROFILES=(${=${MEAS_PROFILES:-dense}})
UNCAPPED_TIMEOUT=${MEAS_UNCAPPED_TIMEOUT:-172800}
GUARDED=${MEAS_GUARDED:-0}
CPU_PROFILE=${MEAS_CPU_PROFILE:-cpu}
CPU_SAMPLE_US=${MEAS_CPU_SAMPLE_US:-10000}
PGSTAT_INTERVAL=${MEAS_PGSTAT_INTERVAL:-1800}
PROFILE_SUMMARY=${MEAS_PROFILE_SUMMARY_SECONDS:-600}
# The Job's env beyond its profile: the production time guard (the uncapped
# execution overrides it) and the CPU profiler. refresh and refresh-uncapped
# take the same list, so the uncapped run reads back the Job refresh deployed.
REFRESH_ENV=(--refresh-env=ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400)
[[ "$CPU_PROFILE" == cpu ]] && REFRESH_ENV+=(--refresh-env=ANALYTICS_V2_REFRESH_PROFILE=cpu
  --refresh-env=ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US="$CPU_SAMPLE_US"
  --refresh-env=ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS="$PROFILE_SUMMARY")
D() { "$NODE26" scripts/gcp-fastpath-test-deploy.mjs "$@"; }
step() { echo "== $(date -u +%H:%M:%S) $1"; }
TORN=0
CHILD=0
SAMPLER=0
PGSTAT=1
# A long step (see "Teardown" above):
#   child <stdout file> <stderr file, or - for the stdout file> <command...>
child() {
  local out=$1 err=$2; shift 2
  if [[ $err == - ]]; then "$@" > "$out" 2>&1 & else "$@" > "$out" 2> "$err" & fi
  CHILD=$!; wait $CHILD; local rc=$?; CHILD=0; return $rc
}
# A process and all its descendants (D's subshell, node, the gcloud it runs).
tree() { local p; print -r -- $1; for p in $(pgrep -P $1 2>/dev/null); do tree $p; done; }
stop() { (( SAMPLER )) && kill -TERM $(tree $SAMPLER) 2>/dev/null; SAMPLER=0
  (( CHILD )) && kill -TERM $(tree $CHILD) 2>/dev/null; CHILD=0; exit 130; }
# One read-only database snapshot (bounded: a 15 s connect and 60 s statement
# timeout), a waited child; a failure is recorded, never fatal.
pgstat() {
  (( PGSTAT )) || return 0
  child "$OUT/pgstat/$1.log" - D meas-pgstat --meas-instance="$INSTANCE" --label="$1" --out="$OUT/pgstat" \
    || echo "pgstat $1 failed (see $OUT/pgstat/$1.log)"
}
# Snapshots every PGSTAT_INTERVAL while a run executes (a background loop the
# stop trap also ends).
sampler() {
  local n=0
  while true; do
    sleep "$PGSTAT_INTERVAL"
    n=$(( n + 1 ))
    pgstat "$1-during-$(printf %02d $n)"
  done
}
# child, with the sampler running for its duration:
#   sampled <label> <stdout file> <stderr file, or -> <command...>
sampled() {
  local label=$1; shift
  sampler "$label" &
  SAMPLER=$!
  child "$@"; local rc=$?
  (( SAMPLER )) && kill -TERM $(tree $SAMPLER) 2>/dev/null; SAMPLER=0
  return $rc
}
# The Cloud Monitoring read for one run: the execution's window from its
# receipt, five minutes either side (read-only; rerunnable for six weeks).
metrics() {
  local receipt=$1 label=$2 window
  window=$("$NODE26" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const start = Date.parse(r.status?.startTime ?? r.startTime ?? r.requestedAt ?? "");
    const end = Date.parse(r.status?.completionTime ?? r.completionTime ?? "") || Date.now();
    if (!Number.isFinite(start)) process.exit(1);
    const iso = (ms) => new Date(Math.min(ms, Date.now())).toISOString();
    console.log(iso(start - 300000) + " " + iso(end + 300000));' "$receipt" 2>/dev/null) \
    || { echo "metrics $label: no execution window in $receipt"; return 0; }
  mkdir -p -m 700 "$OUT/metrics"
  child "$OUT/metrics/$label.log" - D meas-metrics --meas-instance="$INSTANCE" --since="${window% *}" --until="${window#* }" \
    --out="$OUT/metrics/$label" || echo "metrics $label failed (see $OUT/metrics/$label.log)"
}
teardown() {
  [[ $TORN == 1 ]] && return; TORN=1
  step teardown
  D meas-teardown --meas-instance="$INSTANCE" --out="$OUT/teardown" > "$OUT/teardown.log" 2>&1
  local rc=$?
  echo "teardown rc=$rc (receipt $OUT/teardown/meas-teardown.json)"
  [[ $rc == 0 ]] || { echo "TEARDOWN FAILED: run it again, and tear down every name in remainingMeasurementInstances:"
    echo "  (cd $WORKER && $NODE26 scripts/gcp-fastpath-test-deploy.mjs meas-teardown --meas-instance=$INSTANCE --out=$OUT/teardown-retry)"
    tail -c 800 "$OUT/teardown.log"; }
  echo "receipts in $OUT"
}
mkdir -p -m 700 "$OUT"
print -r -- "$INSTANCE" > "$OUT/instance"
# This shell's PID: stop the run with `kill -TERM $(cat $OUT/pid)` (see "Stopping early").
print -r -- $$ > "$OUT/pid"
echo "commit $COMMIT"; echo "instance $INSTANCE"; echo "corpus $CORPUS"; echo "profiles ${PROFILES[*]}"; echo "out $OUT"
echo "guarded $GUARDED; cpu profile $CPU_PROFILE at $CPU_SAMPLE_US us, summary every $PROFILE_SUMMARY s; pgstat every $PGSTAT_INTERVAL s"
echo "pid $$ (stop: kill -TERM \$(cat $OUT/pid))"
cd "$WORKER" || exit 2

step preflight
if [[ -n "$(git -C "$WT" status --porcelain -- apps/worker packages apps/web/public)" ]]; then
  echo "preflight FAILED: the checkout differs from HEAD under apps/worker, packages or apps/web/public"; exit 1
fi
"$NODE26" -e '
  import("./cloud-run/origin-fastpath-mode.mjs").then(({ fastpathMeasurementInstance }) => {
    process.exit(fastpathMeasurementInstance(process.argv[1]) === null ? 1 : 0); });' "$INSTANCE" \
  || { echo "preflight FAILED: $INSTANCE is not tibotattle-meas-prodtier-<YYYYMMDD>"; exit 1; }
for PROFILE in "${PROFILES[@]}"; do
  [[ "$PROFILE" == dense || "$PROFILE" == dense-workers ]] || { echo "preflight FAILED: profile $PROFILE"; exit 1; }
done
[[ "$UNCAPPED_TIMEOUT" == <14401-604800> ]] || { echo "preflight FAILED: MEAS_UNCAPPED_TIMEOUT must be 14401..604800"; exit 1; }
[[ "$GUARDED" == 0 || "$GUARDED" == 1 ]] || { echo "preflight FAILED: MEAS_GUARDED must be 0 or 1"; exit 1; }
[[ "$CPU_PROFILE" == cpu || "$CPU_PROFILE" == off ]] || { echo "preflight FAILED: MEAS_CPU_PROFILE must be cpu or off"; exit 1; }
[[ "$CPU_SAMPLE_US" == <1000-100000> ]] || { echo "preflight FAILED: MEAS_CPU_SAMPLE_US must be 1000..100000"; exit 1; }
[[ "$PGSTAT_INTERVAL" == <60-86400> ]] || { echo "preflight FAILED: MEAS_PGSTAT_INTERVAL must be 60..86400"; exit 1; }
[[ "$PROFILE_SUMMARY" == <60-86400> ]] || { echo "preflight FAILED: MEAS_PROFILE_SUMMARY_SECONDS must be 60..86400"; exit 1; }
"$NODE26" -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const m = JSON.parse(fs.readFileSync(process.argv[1] + "/corpus-manifest.json", "utf8"));
  // The corpus was generated by the seeder files this checkout holds.
  const blob = (file) => { const bytes = fs.readFileSync(file);
    return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); };
  const seeders = Object.entries(m.seederFiles).map(([file, id]) => blob(path.join(process.argv[2], file)) === id);
  const ok = m.corpus.scale === 1 && m.corpus.owners === "all" && m.own3.matches
    && Object.values(m.own3.matches).every(Boolean) && m.sealed.sealReady === true && seeders.every(Boolean);
  console.log(JSON.stringify({ scale: m.corpus.scale, owners: m.owners.length, totals: m.totals,
    own3: m.own3.matches, sealed: m.sealed.sha256, seederFilesMatch: seeders.every(Boolean) }));
  process.exit(ok ? 0 : 1);' "$CORPUS" "$WT" > "$OUT/preflight.json" || { echo "preflight FAILED: corpus"; cat "$OUT/preflight.json"; exit 1; }
cat "$OUT/preflight.json"
"$NODE26" scripts/gcp-fastpath-seed.mjs plan --commit="$COMMIT" --sealed-corpus="$CORPUS" > "$OUT/seed-plan.json" \
  || { echo "preflight FAILED: seed plan"; exit 1; }
grep -q '"decision": "run"' "$OUT/seed-plan.json" || { echo "preflight FAILED: seed plan refuses"; cat "$OUT/seed-plan.json"; exit 1; }

if [[ -n "${MEAS_IMAGE:-}" ]]; then
  IMG=$MEAS_IMAGE
else
  step build; D build --commit="$COMMIT" --out="$OUT/build" > "$OUT/build.log" 2>&1 || { echo "build FAILED"; exit 1; }
  IMG=$("$NODE26" -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];
    const f=fs.readdirSync(d).filter(n=>/^build-.*\.json$/.test(n)).sort().at(-1);
    console.log(JSON.parse(fs.readFileSync(p.join(d,f),"utf8")).image)' "$OUT/build")
fi
echo "image $IMG"

# From here on the instance may exist: delete it on every exit.
trap teardown EXIT
trap stop INT TERM HUP
step create
child "$OUT/create.log" - D meas-create --meas-instance="$INSTANCE" --out="$OUT/create" \
  || { echo "create FAILED"; tail -c 800 "$OUT/create.log"; exit 1; }

step seed
child "$OUT/seed.json" "$OUT/seed.log" \
  "$NODE26" --max-old-space-size=49152 scripts/gcp-fastpath-seed.mjs seed --target=gcp-fastpath --meas-instance="$INSTANCE" \
  --commit="$COMMIT" --sealed-corpus="$CORPUS" \
  || { echo "seed FAILED"; tail -c 800 "$OUT/seed.log"; exit 1; }
SCHEMA=$("$NODE26" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schema)' "$OUT/seed.json")
echo "schema $SCHEMA"

mkdir -p -m 700 "$OUT/pgstat"
step pgstat-enable
child "$OUT/pgstat/enable.log" - D meas-pgstat-enable --meas-instance="$INSTANCE" --out="$OUT/pgstat" \
  || echo "pg_stat_statements unavailable (see $OUT/pgstat/enable.log): measuring without statement statistics"

for PROFILE in "${PROFILES[@]}"; do
  RUN=$OUT/$PROFILE
  mkdir -p -m 700 "$RUN"
  pgstat "$PROFILE-before"
  if [[ "$GUARDED" == 1 ]]; then
    step "refresh $PROFILE (guarded)"
    sampled "$PROFILE-guarded" "$RUN.refresh.log" - \
      D refresh --meas-instance="$INSTANCE" --image="$IMG" --schema="$SCHEMA" --now="$NOW" --refresh-profile="$PROFILE" \
      "${REFRESH_ENV[@]}" --out="$RUN/refresh"
    echo "refresh $PROFILE rc=$? (a guard refusal is data)"; tail -c 1500 "$RUN.refresh.log"; echo
    # No refresh.json: the wrapper refused or the deploy failed; nothing was measured.
    if [[ ! -f "$RUN/refresh/refresh.json" ]]; then echo "refresh $PROFILE FAILED before an execution; not measuring"; exit 1; fi
    OUTCOME=$("$NODE26" -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const line = Array.isArray(r.results) && r.results.length > 0 ? r.results.at(-1) : null;
      console.log(line === null ? "no-status-line" : line.status === "ok" ? String(line.state) : `failed:${line.code}`);' \
      "$RUN/refresh/refresh.json")
    echo "guarded $PROFILE outcome $OUTCOME"
    if [[ "$OUTCOME" == "LOCK_HELD" ]]; then echo "refresh $PROFILE FAILED: LOCK_HELD on the measurement database"; exit 1; fi
  else
    # The profiled uncapped run is the measurement: deploy the Job only.
    step "deploy $PROFILE (no guarded execution)"
    child "$RUN.refresh.log" - \
      D refresh --meas-instance="$INSTANCE" --image="$IMG" --schema="$SCHEMA" --now="$NOW" --refresh-profile="$PROFILE" \
      "${REFRESH_ENV[@]}" --no-execute --out="$RUN/refresh" \
      || { echo "deploy $PROFILE FAILED"; tail -c 1500 "$RUN.refresh.log"; exit 1; }
    [[ -f "$RUN/refresh/refresh.json" ]] || { echo "deploy $PROFILE wrote no refresh.json"; exit 1; }
    OUTCOME=deployed
  fi
  if [[ "$OUTCOME" != "complete" ]]; then
    step "uncapped $PROFILE"
    sampled "$PROFILE" "$RUN.uncapped.log" - \
      D refresh-uncapped --meas-instance="$INSTANCE" --image="$IMG" --schema="$SCHEMA" --now="$NOW" \
      --refresh-profile="$PROFILE" "${REFRESH_ENV[@]}" \
      --task-timeout-seconds="$UNCAPPED_TIMEOUT" --after-refresh="$RUN/refresh/refresh.json" \
      --out="$RUN/uncapped"
    echo "uncapped $PROFILE rc=$? (receipt $RUN/uncapped/refresh-uncapped.json)"; tail -c 1500 "$RUN.uncapped.log"; echo
    pgstat "$PROFILE-after"
    step "metrics $PROFILE"
    metrics "$RUN/uncapped/refresh-uncapped.json" "$PROFILE"
  else
    pgstat "$PROFILE-after"
    step "metrics $PROFILE"
    metrics "$RUN/refresh/refresh.json" "$PROFILE"
  fi
done

step collect
"$NODE26" scripts/gcp-fastpath-prod-shape/summarize-prodtier.mjs "$OUT" "${PROFILES[@]}"
exit 0
