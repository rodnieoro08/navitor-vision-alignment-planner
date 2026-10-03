#!/usr/bin/env bash
# Runs unit checks + headless-browser e2e; writes tests/results.txt. Needs: node >= 18, google-chrome, poppler-utils (pdfinfo/pdftotext), and the static server running (node serve.js) for e2e.
cd "$(dirname "$0")/.." || exit 1
node build.js
# test data: phantom DICOM, lossless-JPEG stream cases, compressed phantom series (independent encoders: imagecodecs/pydicom, venv in tests/out/venv)
node tests/make_sample_dicom.js >/dev/null && node tests/make_jpeg_cases.js >/dev/null
if [ -x tests/out/venv/bin/python ]; then tests/out/venv/bin/python tests/make_compressed_series.py >/dev/null || echo 'WARNING: make_compressed_series.py failed'; fi
{
  echo "Run: $(date '+%Y-%m-%d %H:%M:%S %Z')  node $(node -v)  $(google-chrome --version 2>/dev/null)"
  echo; echo "=== test_math.js ==="; node tests/test_math.js
  echo; echo "=== test_dicom.js ==="; node tests/test_dicom.js
  echo; echo "=== independent oracle check of the test JPEG streams (libjpeg / libjpeg-turbo) ==="; tests/out/venv/bin/python tests/verify_jpeg_cases.py
  echo; echo "=== independent oracle check of the compressed DICOM test series (pydicom/libjpeg decode == original) ==="; tests/out/venv/bin/python tests/make_compressed_series.py | grep 'independent decode'
  echo; echo "=== test_mpr.js (oblique MPR) ==="; node tests/test_mpr.js
  echo; echo "=== test_codecs.js ==="; node tests/test_codecs.js
  echo; echo "=== test_nadir.js (auto-detect nadirs on synthetic root phantoms) ==="; node tests/test_nadir.js
  echo; echo "=== e2e.js ==="; node tests/e2e.js
} 2>&1 | tee tests/results.txt
