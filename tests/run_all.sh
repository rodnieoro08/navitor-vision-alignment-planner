#!/usr/bin/env bash
# Runs build + all unit checks + Python oracle checks + headless-Chrome e2e.
# Exits 0 only if EVERY step passed; prints a per-step summary at the end.
#
# Prerequisites (see README "Tests"): node >= 18, `npm install`, google-chrome, poppler-utils (pdftoppm/pdfinfo),
# and the python venv in tests/out/venv (numpy pydicom imagecodecs pylibjpeg pylibjpeg-libjpeg) for the oracle checks.
# This script starts (and stops) its own static server for the e2e step; nothing needs to be running beforehand.
#
# Outputs (all untracked, under tests/out/): results.txt (full log), screenshots/ (e2e screenshots).
# To refresh the committed reference images in screenshots/ deliberately:  NVAP_SHOTS=screenshots bash tests/run_all.sh
cd "$(dirname "$0")/.." || exit 1
OUT=tests/out; mkdir -p "$OUT/steps"
PY=$OUT/venv/bin/python
NAMES=(); RCS=(); SUMS=()
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

# step <name> <command...>: runs, tees to log, records exit status and the last "N passed"/"mismatches"/"identical" line
step() {
  local name="$1"; shift
  local log="$OUT/steps/$(echo "$name" | tr -c 'A-Za-z0-9\n' '_').log"
  echo; echo "=== $name ==="
  "$@" 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}
  NAMES+=("$name"); RCS+=("$rc")
  SUMS+=("$(grep -E 'passed|mismatches|identical to original' "$log" | tr '\n' ' ' | cut -c1-110)")
  return 0
}

{
  trap cleanup EXIT
  echo "Run: $(date '+%Y-%m-%d %H:%M:%S %Z')  node $(node -v)  $(google-chrome --version 2>/dev/null)"
  step "build (node build.js)" node build.js
  step "make test data: phantom DICOM" node tests/make_sample_dicom.js
  step "make test data: lossless-JPEG stream cases" node tests/make_jpeg_cases.js
  if [ -x "$PY" ]; then
    step "oracle: compressed DICOM series (pydicom/libjpeg decode == original)" "$PY" tests/make_compressed_series.py
    step "oracle: JPEG streams (libjpeg / libjpeg-turbo)" "$PY" tests/verify_jpeg_cases.py
  else
    echo; echo "ERROR: python venv missing ($PY). Create it (see README > Tests):"
    echo "  python3 -m venv tests/out/venv && tests/out/venv/bin/pip install numpy pydicom imagecodecs pylibjpeg pylibjpeg-libjpeg"
    NAMES+=("oracles (python venv present)"); RCS+=(1); SUMS+=("venv missing")
  fi
  step "test_math.js" node tests/test_math.js
  step "test_dicom.js" node tests/test_dicom.js
  step "test_mpr.js (oblique MPR)" node tests/test_mpr.js
  step "test_codecs.js" node tests/test_codecs.js
  step "test_nadir.js (auto-detect nadirs + commissures)" node tests/test_nadir.js

  # e2e: private static server on a free port, stopped on exit
  echo; echo "=== starting static server for e2e ==="
  node serve.js >"$OUT/serve.log" 2>&1 & SERVER_PID=$!
  PORT=""
  for _ in $(seq 1 50); do
    PORT=$(sed -n 's#.*http://127.0.0.1:\([0-9]*\)/.*#\1#p' "$OUT/serve.log" | head -1)
    [ -n "$PORT" ] && break; sleep 0.1
  done
  if [ -z "$PORT" ]; then echo "ERROR: static server did not start"; NAMES+=("static server"); RCS+=(1); SUMS+=("did not start")
  else echo "server on port $PORT"; NVAP_PORT=$PORT step "e2e.js (headless Chrome)" node tests/e2e.js; fi
  cleanup; SERVER_PID=""

  echo; echo "=================== SUMMARY ==================="
  FAILED=0
  for i in "${!NAMES[@]}"; do
    if [ "${RCS[$i]}" = 0 ]; then st=PASS; else st="FAIL(exit ${RCS[$i]})"; FAILED=$((FAILED+1)); fi
    printf '%-10s %-62s %s\n' "$st" "${NAMES[$i]}" "${SUMS[$i]}"
  done
  if [ "$FAILED" = 0 ]; then echo "ALL ${#NAMES[@]} STEPS PASSED"; else echo "$FAILED of ${#NAMES[@]} STEPS FAILED"; fi
  echo "$FAILED" >"$OUT/steps/.failed"
} 2>&1 | tee "$OUT/results.txt"
[ "$(cat "$OUT/steps/.failed" 2>/dev/null || echo 1)" = 0 ]
