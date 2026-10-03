#!/bin/zsh
# MEAS-SYNTH cloud measurement: the full-recompute analytics refresh over the
# PRODUCTION-SHAPED synthetic corpus, in the TEST project `tibotattle` only
# (the fast-path test database tibotattle_fastpath on the test primary).
# Never production or staging. Modelled on the parity home's
# receipts/run-dense-deploy.sh. This script issues no gcloud command itself:
# every remote call goes through scripts/gcp-fastpath-test-deploy.mjs (D),
# whose command builders pin the project, region and fast-path names.
#
#   zsh apps/worker/scripts/gcp-fastpath-prod-shape/run-cloud-measurement.sh
#
# Environment (all optional):
#   MEAS_CORPUS     seed-source.mjs work directory (default
#                   ~/Library/Caches/tibotattle-meas-synth/full/seed); it must
#                   be the full-scale corpus (own3.matches all true)
#   MEAS_OUT        receipt directory (default
#                   ~/Documents/Coding/tibotattle-gcp-parity/receipts/gcp-meas-synth-<UTC stamp>)
#   MEAS_IMAGE      reuse an image digest built from this commit (skips build)
#   MEAS_SKIP_SEED=1 and MEAS_SCHEMA=<schema>   reuse a schema an earlier run seeded
#   MEAS_UNCAPPED=1 when the guarded run does not complete, time one more
#                   execution of the same Job to its end (D refresh-uncapped):
#                   execution-level overrides only, a task timeout and the
#                   time guard at MEAS_UNCAPPED_TIMEOUT (default 172,800 s,
#                   48 h; at most 604,800). Costs up to that long of a
#                   4 vCPU / 16 GiB task
#
# Steps:
#   preflight  clean checkout of HEAD for every path the seed and image use;
#              corpus manifest present, full scale, OWN-3 matched; no refresh
#              execution running (D refresh-idle)
#   build      D build --commit=HEAD
#   migrate    deploy + execute the migrate Job (fast-path test database)
#   verify-database
#   seed       gcp-fastpath-seed.mjs seed --sealed-corpus (the reviewed importer
#              chain through the Cloud SQL connector as the migrator IAM user;
#              runs on THIS machine, Node 26, large heap; expect hours)
#   refresh    D refresh: the refresh Job with the production task profile
#              (dense: 4 vCPU, 16 GiB, heap 12,288 MiB, budget 10,752 MiB,
#              14,400 s task timeout) and the production time guard
#              (ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400), at the
#              corpus clock 2026-10-01T12:46:00.000Z. Its non-zero exit is
#              expected (the guard's refusal); the script stops unless
#              refresh/refresh.json exists (the deploy ran and an execution was
#              made) and its status line is not LOCK_HELD
#   uncapped   (MEAS_UNCAPPED=1 only) D refresh-uncapped, which refuses unless
#              refresh.json names this image, schema, clock and profile, the
#              Job reads back as exactly that refresh's task, and no execution
#              is running; it waits for the execution to finish and writes
#              uncapped/refresh-uncapped.json (status block, duration, status
#              line, Cloud Run's messages) whatever the outcome
#   protected  read the shared test services' revisions (never written)
#
# Expected (docs/receipts/2026-10-03-gcp-meas-synth.md): the local run took
# 15,530 s and projects to 13.6-19.1 h on Cloud Run. The guard's time model
# plans 10,998 s, so it admits the run, then refuses
# ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED at an owner checkpoint and publishes
# nothing. Owners run in owner-digest order and the second (o02) carries 13.5%
# of the planned work, so the first checkpoint that refuses is the third
# owner's: about 1.9 h in at ratio A, 2.7 h at ratio B. The uncapped run
# measures the real duration, which sets the task timeout, the recalibrated
# rates and C3. A kill at the uncapped cap means "longer than the cap,
# undetermined".
#
# Occupancy: the refresh holds a database-wide advisory lock in
# tibotattle_fastpath, which every seeded schema shares, and there is one
# fast-path refresh Job. For the guarded run (2-3 h) and the uncapped run
# (projected 13.6-19.1 h, at most MEAS_UNCAPPED_TIMEOUT) any other workflow's
# fast-path refresh is refused by the deploy wrapper or exits LOCK_HELD.
set -u
setopt pipefail
H=${MEAS_PARITY_HOME:-$HOME/Documents/Coding/tibotattle-gcp-parity}
SCRIPT_DIR=${0:A:h}
WT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel) || { echo "not in a git checkout"; exit 2; }
WORKER=$WT/apps/worker
COMMIT=$(git -C "$WT" rev-parse HEAD)
CORPUS=${MEAS_CORPUS:-$HOME/Library/Caches/tibotattle-meas-synth/full/seed}
OUT=${MEAS_OUT:-$H/receipts/gcp-meas-synth-$(date -u +%Y%m%dT%H%M%SZ)}
NODE26=${MEAS_NODE26:-$HOME/.nvm/versions/node/v26.2.0/bin/node}
NOW=2026-10-01T12:46:00.000Z
UNCAPPED_TIMEOUT=${MEAS_UNCAPPED_TIMEOUT:-172800}
# The guarded and the uncapped steps must render the same Job (refresh-uncapped reads it back).
GUARDED=(--refresh-profile=dense --refresh-env=ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS=14400)
D() { "$NODE26" scripts/gcp-fastpath-test-deploy.mjs "$@"; }
step() { echo "== $(date -u +%H:%M:%S) $1"; }
protected_and_exit() {
  step protected; D protected --commit="$COMMIT" --out="$OUT/protected" > "$OUT/protected.log" 2>&1
  echo "protected rc=$?"; step done; echo "receipts in $OUT"; exit "$1"
}
mkdir -p -m 700 "$OUT"
echo "commit $COMMIT"; echo "corpus $CORPUS"; echo "out $OUT"
cd "$WORKER" || exit 2

step preflight
if [[ -n "$(git -C "$WT" status --porcelain -- apps/worker packages apps/web/public)" ]]; then
  echo "preflight FAILED: the checkout differs from HEAD under apps/worker, packages or apps/web/public"; exit 1
fi
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
[[ "$UNCAPPED_TIMEOUT" == <14401-604800> ]] || { echo "preflight FAILED: MEAS_UNCAPPED_TIMEOUT must be 14401..604800"; exit 1; }
D refresh-idle --out="$OUT/idle" > "$OUT/idle.log" 2>&1 \
  || { echo "preflight FAILED: a fast-path refresh execution is running (its database lock would make this run LOCK_HELD)"; tail -c 600 "$OUT/idle.log"; exit 1; }

if [[ -n "${MEAS_IMAGE:-}" ]]; then
  IMG=$MEAS_IMAGE
else
  step build; D build --commit="$COMMIT" --out="$OUT/build" > "$OUT/build.log" 2>&1 || { echo "build FAILED"; exit 1; }
  IMG=$("$NODE26" -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];
    const f=fs.readdirSync(d).filter(n=>/^build-.*\.json$/.test(n)).sort().at(-1);
    console.log(JSON.parse(fs.readFileSync(p.join(d,f),"utf8")).image)' "$OUT/build")
fi
echo "image $IMG"
step migrate; D migrate --commit="$COMMIT" --image="$IMG" --out="$OUT/migrate" > "$OUT/migrate.log" 2>&1 || { echo "migrate FAILED"; exit 1; }
step verify-database; D verify-database --commit="$COMMIT" --out="$OUT/verifydb" > "$OUT/verifydb.log" 2>&1 || { echo "verify-database FAILED"; exit 1; }

if [[ "${MEAS_SKIP_SEED:-}" == "1" ]]; then
  SCHEMA=${MEAS_SCHEMA:?MEAS_SCHEMA is required with MEAS_SKIP_SEED=1}
else
  step seed
  "$NODE26" --max-old-space-size=49152 scripts/gcp-fastpath-seed.mjs seed --target=gcp-fastpath --commit="$COMMIT" \
    --sealed-corpus="$CORPUS" > "$OUT/seed.json" 2> "$OUT/seed.log" || { echo "seed FAILED"; tail -c 600 "$OUT/seed.log"; exit 1; }
  SCHEMA=$("$NODE26" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schema)' "$OUT/seed.json")
fi
echo "schema $SCHEMA"

step refresh
D refresh --commit="$COMMIT" --image="$IMG" --schema="$SCHEMA" --now="$NOW" "${GUARDED[@]}" \
  --out="$OUT/refresh" > "$OUT/refresh.log" 2>&1
echo "refresh rc=$? (a guard refusal is expected)"; tail -c 1500 "$OUT/refresh.log"; echo
# No refresh.json: the wrapper refused or the deploy failed, so the Job may
# still hold an earlier image or schema. Nothing was measured.
if [[ ! -f "$OUT/refresh/refresh.json" ]]; then
  echo "refresh FAILED before an execution of this image and schema; not measuring"; protected_and_exit 1
fi
OUTCOME=$("$NODE26" -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const line = Array.isArray(r.results) && r.results.length > 0 ? r.results.at(-1) : null;
  console.log(line === null ? "no-status-line" : line.status === "ok" ? String(line.state) : `failed:${line.code}`);' \
  "$OUT/refresh/refresh.json")
echo "guarded outcome $OUTCOME"
if [[ "$OUTCOME" == "LOCK_HELD" ]]; then
  echo "refresh FAILED: LOCK_HELD, another refresh holds the fast-path database's lock; nothing was measured"
  protected_and_exit 1
fi

if [[ "${MEAS_UNCAPPED:-}" == "1" ]]; then
  if [[ "$OUTCOME" == "complete" ]]; then
    echo "uncapped skipped: the guarded run completed inside its task; refresh/refresh.json is the measurement"
  else
    step uncapped
    D refresh-uncapped --image="$IMG" --schema="$SCHEMA" --now="$NOW" "${GUARDED[@]}" \
      --task-timeout-seconds="$UNCAPPED_TIMEOUT" --after-refresh="$OUT/refresh/refresh.json" \
      --out="$OUT/uncapped" > "$OUT/uncapped.log" 2>&1
    echo "uncapped rc=$? (receipt $OUT/uncapped/refresh-uncapped.json)"; tail -c 1500 "$OUT/uncapped.log"; echo
  fi
fi

protected_and_exit 0
