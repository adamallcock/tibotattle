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
# names no other instance. The instance is deleted on every exit (trap).
#
#   zsh apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh
#
# Environment (all optional):
#   MEAS_INSTANCE   tibotattle-meas-prodtier-<YYYYMMDD> (default: today, UTC)
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
#   per profile in MEAS_PROFILES:
#     refresh  D refresh --meas-instance with the profile and the production
#              time guard (ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400) at
#              the corpus clock. A guard refusal is data; the script stops
#              unless refresh.json exists and is not LOCK_HELD
#     uncapped when the guarded run did not complete: D refresh-uncapped
#              (execution-level task timeout and guard at
#              MEAS_UNCAPPED_TIMEOUT), timed to its end
#   collect    summary.json: each run's duration, outcome and phase timings
#   teardown   (trap, every exit) D meas-teardown: cancel and delete the
#              measurement Job, delete the instance, read both back absent
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
GUARD=(--refresh-env=ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400)
D() { "$NODE26" scripts/gcp-fastpath-test-deploy.mjs "$@"; }
step() { echo "== $(date -u +%H:%M:%S) $1"; }
TORN=0
teardown() {
  [[ $TORN == 1 ]] && return; TORN=1
  step teardown
  D meas-teardown --meas-instance="$INSTANCE" --out="$OUT/teardown" > "$OUT/teardown.log" 2>&1
  local rc=$?
  echo "teardown rc=$rc (receipt $OUT/teardown/meas-teardown.json)"
  [[ $rc == 0 ]] || { echo "TEARDOWN FAILED: run it again: D meas-teardown --meas-instance=$INSTANCE"; tail -c 800 "$OUT/teardown.log"; }
  echo "receipts in $OUT"
}
mkdir -p -m 700 "$OUT"
echo "commit $COMMIT"; echo "instance $INSTANCE"; echo "corpus $CORPUS"; echo "profiles ${PROFILES[*]}"; echo "out $OUT"
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
trap 'exit 130' INT TERM
step create
D meas-create --meas-instance="$INSTANCE" --out="$OUT/create" > "$OUT/create.log" 2>&1 \
  || { echo "create FAILED"; tail -c 800 "$OUT/create.log"; exit 1; }

step seed
"$NODE26" --max-old-space-size=49152 scripts/gcp-fastpath-seed.mjs seed --target=gcp-fastpath --meas-instance="$INSTANCE" \
  --commit="$COMMIT" --sealed-corpus="$CORPUS" > "$OUT/seed.json" 2> "$OUT/seed.log" \
  || { echo "seed FAILED"; tail -c 800 "$OUT/seed.log"; exit 1; }
SCHEMA=$("$NODE26" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schema)' "$OUT/seed.json")
echo "schema $SCHEMA"

for PROFILE in "${PROFILES[@]}"; do
  RUN=$OUT/$PROFILE
  step "refresh $PROFILE"
  D refresh --meas-instance="$INSTANCE" --image="$IMG" --schema="$SCHEMA" --now="$NOW" --refresh-profile="$PROFILE" "${GUARD[@]}" \
    --out="$RUN/refresh" > "$RUN.refresh.log" 2>&1
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
  if [[ "$OUTCOME" != "complete" ]]; then
    step "uncapped $PROFILE"
    D refresh-uncapped --meas-instance="$INSTANCE" --image="$IMG" --schema="$SCHEMA" --now="$NOW" \
      --refresh-profile="$PROFILE" "${GUARD[@]}" \
      --task-timeout-seconds="$UNCAPPED_TIMEOUT" --after-refresh="$RUN/refresh/refresh.json" \
      --out="$RUN/uncapped" > "$RUN.uncapped.log" 2>&1
    echo "uncapped $PROFILE rc=$? (receipt $RUN/uncapped/refresh-uncapped.json)"; tail -c 1500 "$RUN.uncapped.log"; echo
  fi
done

step collect
"$NODE26" -e '
  const fs = require("fs"), path = require("path");
  const [out, ...profiles] = process.argv.slice(1);
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  const line = (receipt) => (Array.isArray(receipt?.results) && receipt.results.length > 0 ? receipt.results.at(-1) : null);
  const summary = { create: read(path.join(out, "create/meas-create.json")),
    seed: (({ schema, durationSeconds, instanceConnectionName, timingsMs }) => ({ schema, durationSeconds,
      instanceConnectionName, timingsMs }))(read(path.join(out, "seed.json")) ?? {}), runs: {} };
  for (const profile of profiles) {
    const guarded = read(path.join(out, profile, "refresh/refresh.json"));
    const uncapped = read(path.join(out, profile, "uncapped/refresh-uncapped.json"));
    const pick = (receipt, status) => receipt === null ? null : { execution: receipt.execution,
      durationSeconds: receipt.durationSeconds, outcome: receipt.outcome ?? null, state: status?.state ?? null,
      code: status?.code ?? null, timingsMs: status?.timings ?? null, memory: status?.memory ?? null,
      readsPhaseWallMs: status?.reads?.phaseWallMs ?? null, deadline: status?.deadline ?? null };
    summary.runs[profile] = { guarded: pick(guarded, line(guarded)), uncapped: pick(uncapped, uncapped?.statusLine ?? null) };
  }
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary.runs, null, 1));' "$OUT" "${PROFILES[@]}"
exit 0
