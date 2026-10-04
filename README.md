# Navitor Vision commissural alignment planner (investigational prototype)

> ## ⚠ Investigational prototype – NOT validated – not a medical device
> * **Investigational / not validated.** Not compared with 3mensio, fluoroscopy or clinical outcomes; the automatic nadir/commissure detection and all accuracy figures come from **synthetic phantoms only** and have never been run on real CT. Verify every marker yourself; not for clinical decision-making.
> * **No patient data leaves your browser.** Everything runs client-side in the page: no uploads, no CDN/external requests, no analytics. This repository contains **no patient data** – only synthetic phantoms (generated in code), source, tests and screenshots of the phantom.
>
> ### Quick start
> * **Open it:** download/clone and open **`index.html`** (single self-contained file, works from `file://`), or `node serve.js` and open the printed `http://127.0.0.1:<port>/`. The `index.html` committed here is the built app (also attached to the GitHub release).
> * **Build:** `node build.js` inlines `src/` (CSS + JS) into `index.html` (Node ≥ 18, no npm dependencies for the build).
> * **Test:** see [Running the tests](#running-the-tests) – setup is `npm install` + a Python venv, then `bash tests/run_all.sh` (starts/stops its own server; exits non-zero if anything fails).
> * Layout: `src/js/` (`math`, `volume`, `codecs`, `dicom`, `nadir`, `mpr`, `phantom`, `views`, `app`), `src/css/`, `src/index.template.html`, `tests/`, `screenshots/`.

Client-side, dependency-free web app that implements the *Navitor Vision commissural alignment protocol from CT* (manual
H-marker → descending-aorta A-marker transfer → 2:1 C-arm projection search). Everything runs in the browser tab;
**no patient data is uploaded or stored**, there are no CDN/library requests (hand-written DICOM, ZIP, volume and maths code).

> **Investigational decision-support tool – not validated, not a medical device, not for sole clinical use.
> Verify against 3mensio and live fluoroscopy.** No accuracy or clinical-validity claim is made (see *Limitations*).

## Run / open

| How | Command |
|---|---|
| Static server (a free port is chosen, written to `.port`) | `node serve.js` → prints `http://127.0.0.1:<port>/` |
| Any static server | `python3 -m http.server 8000` in this folder, open `http://localhost:8000/` |
| Straight from disk | open `index.html` (single self-contained file, works from `file://`) |

`index.html` is the **single-file build** (CSS + JS inlined, ~130 kB). Sources live in `src/` (`src/js/{math,volume,codecs,dicom,nadir,mpr,phantom,views,app}.js`,
`src/css/style.css`, `src/index.template.html`); rebuild with `node build.js`. Node ≥ 18 only needed for build/serve/tests.
Browser: current Chrome/Edge/Firefox/Safari (ZIP input uses the built-in `DecompressionStream`). Only Chrome was exercised.

## Workflow in the app (tabs)

1. **Load CT** – choose files / a folder / a `.zip`, or drag-drop (folders supported via `webkitGetAsEntry`). Series are listed; the largest loads automatically.
   Or press **Load synthetic phantom** (+ **Place demo markers**) – no patient data needed.
2. **Mark (MPR)** – axial/coronal/sagittal with window/level presets. Pick a tool, click on a view to place a marker at that in-plane position on the view's *current slice*:
   optional cusp nadirs (NCC yellow ▲ / LCC red ▲ / RCC green ▲; set by hand or with **Auto-detect nadirs + commissures**, see below), **H_NL, H_NR, H_LR**, and **centreline points in the order LV apex → LV outflow/aortic root → arch → descending aorta** (C1 = apex; optionally "insert at nearest segment"). The order is checked against the root markers (first point must be the end nearer the aortic root; falls back to height) and a warning is shown if it looks reversed; all calculations then use the corrected direction anyway, so results do not depend on the direction you click in (the *Reverse order* button just fixes the numbering). Sessions saved by older versions (bifurcation → apex) are detected and converted when loaded.
   Scroll / two-finger swipe = slice (trackpad deltas accumulate, ~30 px per slice; one mouse-wheel notch = 1 slice), ↑/↓/PageUp/PageDown = slice on the hovered view (Shift = 5), slider + k/N label under each view, Ctrl+scroll or pinch = zoom, **drag the round handles at the ends of the blue crosshair lines to rotate the other two planes (oblique / double-oblique MPR, see below), drag a line to move that plane**, Shift/middle-drag = pan, right-drag = W/L, drag marker = move, Alt+click marker = delete, ⌖/✕ in the lists = go to / delete.
3. **Transfer** – smoothed centreline (σ slider), rotation-minimising frame (RMF), annulus-level and descending-aorta-level sliders (arc length is measured from the LV apex end; default descending level = 80 mm of centreline beyond the highest centreline point, i.e. past the top of the arch), cross-sections at both levels (markers draggable), a **stretched (straightened) vessel view** with adjustable cut-plane angle and a live **C-arm angulation overlay** (see below), a schematic polar plot and a table of angles/radii, and the **Overlap projection (2 right / 1 left)** panel (see below). Output: **A_NL, A_NR, A_LR** in patient LPS mm (draggable → marked "manual"; reset button).
4. **C-arm projections** – the suggested (selected) projection angles and the best-ranked row of each list are shown in **bold green** (high contrast on the dark theme, `--suggest` #00e676; darker green #0b6e2f on the white printed summary) – heat map of the 2:1 margin over LAO/RAO −60…+60° × CRAN/CAUD −40…+40° (1° grid), **ranked lists** (best separation *S#*; most practical *P#* = margin ≥ x % of best, smallest angle burden √(LAO²+CRAN²) first; 4° non-maximum suppression; optional filter "pair on image left/right" and "±2° stable only"), click to select, simulated projection diagram of the three A markers left/right of the projected centreline axis, the corresponding H-marker view, and a cross-section schematic with the beam-plane trace.
5. **Summary / print** – one-page A4 summary (selected projection angle in bold green, the best overlap projection (2 right / 1 left) in bold green, best entries of the alternatives in bold green, margin, marker coordinates, diagrams, heat map, protocol reminder, limitations, disclaimer) with optional anonymised ID / age / note; **Print / Save as PDF**. No patient name, no DICOM identifiers, no image pixels are in the summary.
6. **Method & assumptions** – the conventions and approximations below, in-app.

"Save markers (.json)" / "Load markers…" stores only coordinates + parameters.

## Marker colours (changed)

| Marker | Colour / shape |
|---|---|
| Cusp nadir NCC / LCC / RCC | **yellow / red / green** triangles (`#ffd600` / `#d50000` / `#00c853`, white outline) – markers, labels, tool list, cross-sections, diagrams, summary |
| H_NL / H_NR / H_LR (commissures) | red / green / blue **circles** (`#ff5252` / `#69f0ae` / `#448aff`, unchanged) |
| A_NL / A_NR / A_LR (descending-aorta transfer) | diamonds, H colours |
| Centreline points | **cyan** (`#00e5ff`) – were yellow, which would now be confused with NCC |
| Root seed (auto-detect) | magenta circle + cross |

Red and green are now used by both the nadirs and the H markers (the H colours were kept because they are part of the established scheme). They are separated by *shape* (triangle vs circle), by tone (nadir red/green are darker and more saturated, H are lighter), by the white outline on triangles, and every marker carries its text label. Check the screenshots (`02_mark_mpr`, `11_auto_nadirs`) to judge whether that is clear enough on your screen; the constants are `GROUPS` / `CL_COLOR` at the top of `src/js/app.js`.

## Auto-detect nadirs + commissures (experimental, semi-automatic)

`src/js/nadir.js` (`NavNadir.detect`), button **Auto-detect nadirs + commissures** on the Mark tab. In one run it places the three cusp nadirs *and* the three native commissure markers H_NL, H_NR, H_LR.

1. **Starting point** – *Set root seed* tool (click inside the opacified aortic root, around mid-sinus level, in any MPR view) or *Seed = crosshair*. Without a seed it falls back to the H-marker centroid projected on the centreline, or to scanning the root end of a centreline with ≥ 3 points. If none is available it says so (no error).
2. **Lumen** – seed snapped to the local brightest lumen (≤ 7 mm); adaptive threshold `T = clamp(40 + 0.5·(HU_seed − 40), 130, 450)` HU (≈ 250-600 HU CTA lumens → T ≈ 170-300); 6-connected region growing restricted to a 40 mm sphere around the seed on a resampled 0.8 mm grid; morphological opening followed by geodesic regrowth (removes coronary/leaflet bridges but keeps the thin sinus-pocket wedges).
3. **Axis** – centreline tangent (apex → descending = flow direction) when a centreline exists within 30 mm, otherwise PCA of the lumen plus a grid of tilted candidate axes (15° steps up to 45° around the scanner z-axis); each candidate is refined from the lumen centres of the sinus-level slabs.
4. **Sinus geometry** – lumen area profile along the axis → sinus level (area maximum) and annulus/valve level; per-angle pocket depth (72 bins); three pockets ≈ 120° apart; per pocket the lowest (most ventricular) lumen cells give the **nadir**; small partial-volume wedge correction.
5. **Labelling** – viewed from the aorta looking toward the LV, **RCC → LCC → NCC is counter-clockwise** (= right-handed about the LV→aorta axis in LPS; same order as the phantom/sample report). RCC anterior-right, LCC left(-posterior), NCC posterior-right next to the interatrial septum. The cyclic assignment that best matches these direction priors is chosen; **Rotate labels** cycles it if the guess is wrong (the handedness never flips).
6. **Quality** – confidence 0-100 (sinus relief, three-lobed cross-section, 120° spacing, planarity of the nadirs, area prominence, label certainty) with good ≥ 70 / fair ≥ 45 / poor, plus warnings. Below 25, or if any geometric check fails (seed not in lumen, lumen too small/leaking, seed in calcium > 900 HU, flat/no sinuses, not three-lobed, irregular spacing, tilted nadir plane) it places **nothing** and explains why and what to try. The score is an internal consistency measure, **not** a validated accuracy.
7. **Commissures (H_NL, H_NR, H_LR).** Geometry: each commissure is at the sinus-to-sinus junction, i.e. the **angular midpoint (about the fitted root axis) between the two adjacent nadir directions** – H_NL between NCC and LCC, H_NR between NCC and RCC, H_LR between LCC and RCC (the arc not containing the third cusp). Height: the **apex of the cusp-attachment crown** – the highest point of the sinus floor profile (lowest wall-side lumen per 3° bin, 3-bin running mean, within ±12° of the junction), normally 12-22 mm above the nadir plane; it must lie 6-30 mm above the nadir plane and agree between the three commissures (±6 mm) or the *typical* height nadir plane + 17 mm is used for that marker (flagged in the warnings and the commissure score). Radial position: the lumen wall at that angle/height, found sub-voxel by ray-marching the resampled HU through the half-way HU between lumen and soft tissue (median of 15 rays: 5 angles × 3 heights). Consistency check: the narrowest inter-sinus notch (minimum wall radius between the lobes just above the apex) should lie at the midpoint angle; the offset is reported. A *commissure score* (0-100: how many heights could be measured, their agreement, rise above the nadirs, notch offset) lowers the overall confidence by up to 15 points when the commissures are ambiguous, and adds warnings. The summary table marks auto-detected H rows "auto-detected (EXPERIMENTAL, conf X%) – verify".
8. **Rotate labels** also renames the H markers (a commissure keeps its pair of cusps: when NCC→RCC, LCC→NCC, RCC→LCC, H_NL→H_NR, H_NR→H_LR, H_LR→H_NL) as long as all three H markers are present and at least one is still auto-detected. **Undo auto-detect** restores the previous nadirs *and* H markers (including hand-placed ones – detection replaces them, a note says so). Markers are normal markers: draggable (dragged ones become "manual"), the summary labels auto-detected points "auto-detected (EXPERIMENTAL) – verify". The root seed is stored in the markers .json.

### Accuracy on the synthetic phantom (`tests/test_nadir.js`, mm from detected to known nadir)

`NavPhantom.generateRoot()` builds a 128³ (0.75 mm) volume: contrast lumen (350 HU, soft tissue 40 HU), root wall radius 12 mm at the annulus, three bulging sinuses (5 mm), bowl-shaped sinus floors with known lowest points (lumen ends at the closed-leaflet bowl), coronary stubs and an adjacent bright left-atrium blob, Gaussian noise (σ 25-40 HU), arbitrary axis tilt and cusp rotation, anisotropic voxel option, open-valve variant (lumen continuous with the LV).

| Case | mean | max | confidence |
|---|---|---|---|
| closed valve, default tilt, σ25 | 2.06 | 2.15 | 94 % |
| cusps rotated +25°, axis tilted, σ25 | 1.72 | 1.76 | 92 % |
| cusps rotated -25°, ~30° axis tilt, σ40, no hint | 2.03 | 2.11 | 92 % |
| anisotropic 0.5×0.5×1.0 mm | 1.89 | 2.02 | 94 % |
| open valve (no closed leaflets), σ35 | 2.09 | 2.45 | 95 % |
| e2e (in Chrome, via real clicks) rotated +20°, σ30 | 1.89 / 2.10 / 2.03 (NCC/LCC/RCC) | | |

All labels were correct on all phantoms; error is a systematic ≈ 2 mm *too high* (the last millimetres of the pocket wedge are thinner than the voxel noise can resolve). Failure cases covered: seed in air / outside the volume / in soft tissue / in 1200-HU calcification, seed in the left-atrium blob, the plain tube phantom (no sinuses), missing inputs – all give a message, never an exception. Runtime ≈ 0.5-1 s on the main thread (UI is busy meanwhile).

#### Commissure (H) accuracy on the synthetic phantom (`tests/test_nadir.js`)

Truth = angular midpoint of the true cusp angles, apex height = the phantom's `commHeight` (default 18 mm above the nadir plane), on the wall at that height. Angle = angle about the **true** root axis (signed; what matters most for the protocol), height = along the axis (detected − true).

| Case | distance mean / max (mm) | angle mean / max (°) | per-marker angle NL / NR / LR (°) | height error NL / NR / LR (mm) |
|---|---|---|---|---|
| closed valve, default tilt | 0.89 / 1.64 | 0.93 / 1.27 | 1.3 / −1.0 / −0.5 | −0.82 / −1.61 / 0.06 |
| cusps rotated +25°, axis tilted, σ25 | 1.15 / 1.29 | 1.98 / 3.46 | 3.5 / −1.1 / 1.3 | −0.88 / −1.25 / −0.88 |
| cusps rotated −25°, ~30° axis tilt, σ40 | 1.79 / 2.68 | 0.98 / 1.74 | 1.7 / −1.1 / −0.1 | −1.60 / −0.98 / 2.67 |
| anisotropic 0.5×0.5×1.0 mm | 0.57 / 0.83 | 1.24 / 1.56 | 1.0 / −1.6 / −1.2 | −0.29 / −0.31 / −0.78 |
| open valve, σ35 | 0.72 / 0.98 | 1.85 / 2.81 | 1.6 / 1.2 / −2.8 | 0.19 / −0.94 / 0.23 |
| low commissures (apex 14 mm) | 0.56 / 0.73 | 0.49 / 0.61 | −0.5 / −0.6 / 0.3 | −0.44 / 0.71 / −0.48 |
| e2e in Chrome (σ30, +20° cusps): H_NL / H_NR / H_LR | 0.05 / 1.21 / 0.62 | 0.1 / 0.9 / 0.9 | | |

Across the six unit cases: angle error mean ≈ 1.2°, worst 3.5°; 3D position error mean 0.6-1.8 mm, worst 2.7 mm; height error −1.6…+2.7 mm. The angle error is essentially the angular error of the two neighbouring nadirs (they define the midpoint); the radial position is nearly exact because the wall is measured directly. An "ambiguous commissure" phantom (apex far too high, notch 33° off) drops the confidence by 4 points and raises a warning (also tested).

**Important caveat about these numbers:** the phantom's commissure *is defined* as the midpoint angle between cusps and the top of its attachment crown, which is exactly the geometry the detector assumes – so the test shows the implementation recovers its own definition under noise/tilt/anisotropy, **not** that real commissures sit there. In real roots the commissure angle is not always the exact angular midpoint of the nadirs (asymmetric sinuses, bicuspid or calcified valves), the crown apex may be hidden by leaflets/calcium, and the lumen can be too poorly defined at the junction. Always check each H marker against the interleaflet triangle/commissure in the three views.

**Honesty note:** this (nadirs and commissures) has been tested **only on synthetic phantoms that I built together with the detector** – i.e. the geometry assumptions (a clean three-lobed lumen with visible pockets, nadirs = lowest lumen point of each pocket) are the same on both sides. It has **not been run on any real CT**. Real roots have calcified leaflets/annulus, stents/prostheses, bicuspid or asymmetric sinuses, ECG-gating motion, variable contrast, hidden hinge points behind thick leaflets (nadirs may then be several mm too high), and anatomical orientation that differs from the label priors. Expect to correct points by hand; treat the output as a starting suggestion only.


## Oblique / double-oblique MPR (3mensio-style rotatable crosshair)

`src/js/mpr.js` (`NavMPR`, pure maths) + the Mark-tab views.

* The three MPR views are always **mutually orthogonal planes through the crosshair** (orientation = orthonormal right-handed frame X, Y, Z in patient/LPS space; normals: axial = Z, coronal = Y, sagittal = −X; identity = scanner axes and is exactly the classic axial/coronal/sagittal).
* The two blue **crosshair lines** in each view are the traces of the other two planes. Each line has **round handles at both ends** (inside the view border). **Drag a handle** → both other planes rotate about **this view's normal** (axial handle: coronal+sagittal rotate about the axial normal; coronal handle: axial+sagittal rotate about the coronal normal; sagittal handle: axial+coronal). The dragged view's own image does not rotate (its lines tilt instead, as in 3mensio); the other two views re-render live, the crosshair stays fixed on screen. **Drag a line body** (anywhere except within 14 px of the crosshair centre, Navigate tool) → translates that plane (moves the crosshair along that plane's normal). Clicking/dragging elsewhere still moves the crosshair; hovering over a handle/line changes the cursor.
* Angles are shown in each view (“lines rotated +30.0°”, clockwise on screen positive) and in the info box (rotation per view, tilt of the axial normal from scanner z, the three normal vectors). **Reset orientation** returns to scanner axes. **Align to centreline** sets the axial normal to the local centreline tangent at the crosshair (cranial sign; needs ≥ 2 centreline points) – image x stays as close as possible to scanner x.
* In rotated views everything works in patient space: wheel/arrow-key/slider scrolling steps along the rotated normal (smallest voxel size per step; label shows “oblique”), clicks place/drag markers at the exact patient position under the mouse (stay on the plane through the crosshair), the cursor readout shows the patient (LPS) position and HU, W/L, zoom, pan, and slice scroll are unchanged. All markers, the transfer step and the C-arm projection maths use patient-space coordinates only – rotating a view never changes them (checked in the e2e test). The orientation is stored in the markers .json.
* Not done: reformatting a thick-slab/MIP, oblique rotation of the cross-section views (those follow the centreline), snapping angles, keyboard rotation.
* Tests: `tests/test_mpr.js` (frames equal the classic ones at identity; orthonormality after 2000 random rotations; 30° rotation gives exactly 30° normals/line tilt; **rendered pixels equal the analytic HU field** of a linear-gradient volume for rotated and double-oblique planes; a gradient along a 30°-rotated axis gives the expected HU/mm along the rotated screen axes; align-to-centreline) and e2e (real mouse drags of handles by 30° and 20°, line translation by 10 mm, wheel step along the rotated normal, marker place/drag in rotated view, W/L/zoom/pan, Reset, Align, session round-trip, patient-space data unchanged).

### Overlap projection (2 right / 1 left) (Transfer tab, step 3)

A panel below the stretched view suggests C-arm projections, at the **descending-aorta level**, in which **two of the A markers overlap** (project onto the same point) on the **right** of the fluoro screen while the third marker is **alone on the left** (e.g. "A_NR + A_LR overlap right, A_NL left").

* **Method.** For each of the three marker pairs the overlap beam is parallel to the vector between the two markers, d = (P_j − P_i)/|P_j − P_i|. LAO/RAO and CRAN/CAUD of that line of sight use the app convention (LAO and CRAN positive, d = (sin LAO·cos CRAN, −cos LAO·cos CRAN, sin CRAN)); d and −d are the same line (mirror image) and the physically reachable **source-posterior representation (|LAO| ≤ 90°)** is used. The 1° grid within ±3° of the exact angles is searched for the smallest **residual after rounding** (image distance between the two overlapped markers; ties → smaller angle burden √(LAO²+CRAN²)).
* **Right/left convention (same as the 2:1 logic and the C-arm tab).** Image as seen from the detector, the projected centreline axis drawn pointing *up*; a marker's lateral coordinate is its signed distance from the plane spanned by axis and beam, **positive = image right** (`evalViewFast`). A pair is offered only if (pair mean − lone) ≥ min margin (the C-arm tab setting, default 2 mm), i.e. the pair is to the image **right** of the lone marker. Pairs that would overlap on the left are listed as "not offered".
* **Ranking.** In-range first (LAO/RAO ±60°, CRAN/CAUD ±40°), then smallest angles. Out-of-range solutions are shown with a ⚠ flag and a disabled button.
* **Each entry shows** the overlapping markers, exact and rounded angles, the **overlap residual (mm)**, the **separation of the lone marker from the pair (mm)**, the range flag, a small schematic fluoro view and **Use in C-arm tab** (selects the angle there). The **best suggestion** angle is shown in **bold green** (same style as the selected projection) and in the printed summary.
* **Degenerate cases.** Collinear markers (all three would overlap), coincident markers, a beam within 10° of the centreline axis, missing A markers and "only out-of-range solutions" each give an explicit message instead of a suggestion.
* **Approximations.** As for the whole app (RMF transfer, ideal orthographic isocentric C-arm). Overlap is exact only for the A markers as points; real fluoroscopy of the markers/valve frame will differ.
* Tests: `tests/test_math.js` (constructed marker sets with known overlap beams – residual ≈ 0, correct side checked by an independent 2D projection, mirrored set rejected, brute-force residual minimum, out-of-range, degenerate), `tests/e2e.js` (panel + values, independent in-browser projection check, button, green/bold computed style, schematic, degenerate messages, printed summary).

### Stretched view: C-arm angulation of the cut plane (Transfer tab)

While you move the **cut-plane angle** slider, an overlay on the stretched vessel view shows the C-arm angulation that belongs to the displayed cut plane, at the **descending level** (A markers) and the **annulus level** (H markers), plus **Use edge-on / face-on angle in C-arm tab** buttons (descending level; selects the projection in the C-arm tab, snapped to its 1° grid).

* **Cut plane.** At a centreline level with RMF frame (T, N1, N2) and slider angle α (measured about the centreline from N1 towards N2, as for the image), the cut plane is span{T, e} with e = cos α·N1 + sin α·N2 – the vertical axis of the stretched view – and normal n = T × e. The plane follows the centreline, so its normal differs between levels (hence one angulation per level).
* **Edge-on (beam in plane)** – primary. Beam direction d = e: in the plane *and* perpendicular to the centreline, so the plane projects to a line along the projected vessel axis and the axis is not foreshortened. Any other beam inside the plane (d = cos t·T + sin t·e) also keeps it edge-on and gives exactly the same marker left/right split (lateral offsets n·(P−C)); e is the one without foreshortening.
* **Face-on (beam ⟂ plane)**. d = n: the plane is seen full-face; marker lateral offsets are e·(P−C), i.e. what the stretched view displays. Face-on at α equals edge-on at α + 90°.
* **Convention.** d is the source→detector direction used throughout the app (d = (sin LAO·cos CRAN, −cos LAO·cos CRAN, sin CRAN) in LPS; LAO and CRAN positive, RAO and CAUD negative). d and −d are the same line of sight (mirror-image projection); the representation with the source posterior (|LAO| ≤ 90°) is shown, rounded to whole degrees. Angles outside the C-arm tab's range (LAO/RAO ±60°, CRAN/CAUD ±40°) are flagged and cannot be sent to the C-arm tab.
* **Marker status.** "n left / m right · 2:1 ✓ (pair on image right, margin x mm)" uses the same projection maths as the C-arm tab (`evalViewFast`) at the rounded angle: A markers about the descending-level axis, H markers about the annulus-level axis.
* **Approximations.** Same as the rest of the app: the angles come from the rotation-minimising frame model (which may differ from 3mensio's straightened frame), the C-arm is ideal (orthographic, isocentric, no table tilt/rotation, no magnification/parallax), the centreline tangent at the level is used as the vessel axis, and the plane normal is evaluated at that level only (the sheet is curved along the vessel). Not validated against fluoroscopy or 3mensio; check the sign convention on your angiography system.

## Maths (all in `src/js/math.js`)

* Patient frame: DICOM **LPS** (x → patient left, y → posterior, z → superior), mm. Voxel→patient from ImagePositionPatient, ImageOrientationPatient and PixelSpacing (`P = IPP₀ + i·Δcol·r + j·Δrow·c + k·step`, step = (IPP_last−IPP_first)/(n−1), so tilt/oblique stacks are handled as a sheared volume).
* Centreline: manual points → centripetal Catmull-Rom → 0.5 mm arc-length resampling → Gaussian smoothing (σ mm, end points fixed).
* Frame: rotation-minimising frame by the double-reflection method (Wang et al. 2008); angle φ measured clockwise (looking along the centreline direction, apex → descending aorta) from the RMF axis N1. The centreline direction is the apex → descending order; points entered the other way round are reversed automatically (see *Workflow*), and the transferred A markers and projection results are identical either way (tested).
* Transfer: for each H marker, φ and radial offset ρ about the centreline at the marker's own level (or a common annulus level) → **A = C(s_desc) + ρ(cosφ·N1 + sinφ·N2)**. Radius options: as measured / mean / fixed.
* **C-arm sign convention: LAO positive, RAO negative; CRAN positive, CAUD negative; AP = 0°/0°.** Supine head-first patient, beam (source→detector) d = (sin LAO·cos CRAN, −cos LAO·cos CRAN, sin CRAN) in LPS; image displayed as seen from the detector (patient left on image right at AP; head up). Orthographic projection.
* Lateral offset *s* of each A marker = signed distance (mm) from the projected centreline axis at the descending level (+ = image right). A view is **2:1** when the signs split 2 vs 1; **margin** = min |s| (nearest marker to the axis); **gap** = distance between the single marker and the nearest pair marker. Valid if margin ≥ the configurable minimum (default 2 mm). Ranked lists use margin (S) and angle burden (P).
* For an axis along z the margin does not depend on the cranial angle (rings project identically) – the heat map then shows vertical bands; real descending-aorta tilt breaks this.

## Tests

### Running the tests

Requirements: Node ≥ 18, Python 3 (with `venv`), system Google Chrome (`/usr/bin/google-chrome`), and poppler-utils (`pdftoppm`, `pdfinfo`, `pdftotext`; e.g. `apt install poppler-utils`).

```bash
# one-time setup, from the repository root
npm install                                   # playwright-core only (drives the system Chrome; no browser download)
python3 -m venv tests/out/venv                # Python oracles: independent JPEG / DICOM decoders
tests/out/venv/bin/pip install numpy pydicom imagecodecs pylibjpeg pylibjpeg-libjpeg

# run everything (build, unit tests, Python oracle checks, headless-Chrome e2e)
bash tests/run_all.sh                          # or: npm test
```

`tests/run_all.sh` starts its own static server on a free port for the e2e step and stops it afterwards – you do **not** need to run `node serve.js` first. It runs every step even if an earlier one fails, prints a PASS/FAIL summary table at the end, and **exits non-zero if any step failed** (including the Python oracle steps; a missing venv counts as a failure). The full run takes about 2 minutes.

Everything the tests generate is untracked and lives under `tests/out/` (log: `tests/out/results.txt`, per-step logs: `tests/out/steps/`, e2e screenshots: `tests/out/screenshots/`), so a test run leaves `git status` clean. The committed images in `screenshots/` are reference screenshots of the phantom; refresh them deliberately with `NVAP_SHOTS=screenshots bash tests/run_all.sh`. Unit tests alone (no browser, no venv): `node tests/test_math.js`, `test_dicom.js`, `test_mpr.js`, `test_codecs.js`, `test_nadir.js` (~1 min).

Last full run: **33 maths + 8 DICOM/geometry + 8 oblique-MPR + 11 codec + 17 nadir/commissure auto-detect + 74 headless-Chrome checks, plus both Python oracle checks (0 mismatches), all passed.**

* `tests/test_math.js` – beam/image-basis geometry; straight-axis ring with 0/120/240° markers → AP is 2:1 with 6 mm margin; **known rotation → known angle** (rotate markers 25° → best LAO = 25° and −35°, margin = ρ/2, independent of CRAN); **tilted axis constructed so LAO 8°/CRAN 19° is the exact 2:1 optimum → recovered**; fast plane-based evaluation vs explicit 2D projection agree (signed offsets, side, class; 2000 random cases); RMF orthonormal and twist-free on a helix; angle transfer on a planar arc preserves the Frenet-relative angle; invariance to the RMF start vector; ranking/NMS properties.
* Centreline order (apex → descending aorta) in `test_math.js` + `e2e.js`: order check (root-marker distance, height fallback, tie, <2 points); the same geometry entered in either direction gives **identical** A markers, annulus/descending levels, projection scan, rankings and selection; a non-canonicalised reversed centreline still agrees to < 0.05 mm; flow-axis hint sign; warning + *Reverse order* button; *Align to centreline* independent of entry order; session v2 round-trip and automatic conversion of old (bifurcation → apex) sessions incl. level conversion; centreline-only auto-detect scans the apex end for both entry orders.
* Cut-plane angulation (`test_math.js` + `e2e.js`): `beamAngles` inverse of `beamDir` over the full range; known planes → known angulation (vertical axis: face-on AP / edge-on LAO 90° at 0°, 30° → LAO 60° / RAO 30°, …); tilted axis: beams exactly ⟂ axis and equal to an independently constructed plane normal; the plane really projects to a line in the edge-on beam and face-on in the face-on beam; lateral offsets equal |n·(P−C)| / |e·(P−C)| and are the same for any in-plane beam; face-on(α) = edge-on(α+90°); the rounded angles are valid C-arm grid cells whose scan classification equals the overlay status; e2e with real keyboard/mouse slider events (overlay text changes, angles equal an independent in-page computation at both levels), the *Use … angle* buttons (selection in the C-arm tab equals the overlay, out-of-range disables the button).
* `tests/test_dicom.js` – synthetic phantom → DICOM (explicit VR, implicit VR, deflated; shuffled slice order; undefined-length sequences; a fake patient name that must never be read) → parsed volume voxel-identical; ZIP (deflate/stored); oblique IOP + anisotropic PixelSpacing reproduce a linear field at arbitrary patient points; unsupported codec (JPEG 2000) rejected cleanly.
* `tests/test_nadir.js` – auto-detect (nadirs + commissures) on synthetic root phantoms: accuracy tables above, commissure angle/position/height errors, H-label rotation algebra, ambiguity lowers confidence, label correctness/handedness, seed off-axis, axis hint, `rotateLabels` algebra, and 6 failure modes (air, soft tissue, calcification seed, LA blob, tube phantom with no sinuses, null inputs). Takes ≈ 1 min (phantom generation).
* `tests/test_codecs.js` – decoders: 252 lossless-JPEG streams (8/12/16-bit, predictors 1–7, point transform 0/2, restart intervals, long Huffman codes) sample-identical to the source; compressed phantom DICOM series (JPEG Lossless SV1 `.70` uint16 with basic offset table + 3 fragments, Process 14 `.57` signed 12-bit multi-fragment without offset table, RLE Lossless, JPEG Baseline 8-bit) → volume voxel-identical to the uncompressed volume (baseline: ≤1 stored level vs libjpeg-turbo); corrupted data → per-slice error; ~2,400-file mixed folder (6 listed series, RGB secondary captures, no-geometry, no-pixel, text) → grouping, skipping, pre-selection, timing.
* Independent oracles (`tests/verify_jpeg_cases.py`, `tests/make_compressed_series.py`, venv in `tests/out/venv` with numpy, pydicom, imagecodecs, pylibjpeg, pylibjpeg-libjpeg): the *encoders* used for test data are not mine for the DICOM series (imagecodecs / pydicom), and the JS test encoder's streams are decoded identically by Richter libjpeg (all Pt=0 cases) and libjpeg-turbo 3.2 (all 8-bit cases incl. point transform).
* `tests/e2e.js` (playwright-core + system Chrome) – loads the app from the local server and from `file://`; DICOM zip via the real file input and synthetic drop; real mouse clicks place 17 centreline + 3 H + 3 nadir markers on the axial view (within 1.2 mm of the phantom's truth); transferred angle equals H angle; A markers within 0.6–1.6 mm of the phantom's analytic truth; whole 121×81 grid cross-checked against brute-force explicit projection; best-ranked view verified 2:1 by independent projection; heat-map click, drag of A marker, reset, level slider, Alt+click delete, wheel slice scroll; summary text (no name/ID leakage) and print-to-PDF = exactly 1 A4 page; session JSON round trip; **no external network requests; no JS errors.**
* `node tests/make_sample_dicom.js` writes the phantom as DICOM (`tests/out/phantom_dicom/`, `.zip`) so you can test the file-loading path.

Highlight test (`e2e.js`): computed style of the suggested projection line, the rank-1 rows and the printed summary (print media) must be bold (≥ 700) and green with WCAG contrast ≥ 7:1 (dark theme) / ≥ 4.5:1 (white paper); summary stays one A4 page.

Screenshots: `16_overlap_projection_panel` (overlap-projection panel), `17_overlap_used_in_carm` (after *Use in C-arm tab*), `15_stretched_carm_angulation` (Transfer tab with the angulation overlay), `01_load_dicom_zip`, `02_mark_mpr`, `03_transfer`, `04_carm`, `05_summary`, `06_summary_print-1.png` (the print-to-PDF file is regenerated by the e2e test and not committed; the e2e writes its own copies to `tests/out/screenshots/`), `07_help`, `08_phantom_mark_filescheme`, `11_auto_nadirs` (auto-detected nadirs + commissures on the root phantom), `12_oblique_rotated`, `13_oblique_double`, `14_oblique_align_centreline` (oblique MPR).

## Limitations (please read)

* **Manual marker-based** – the only automation is the experimental, phantom-only-validated suggestion of the nadirs and the H commissure markers described above; there is no automatic centreline extraction. Result quality is only as good as the marker placement.
* **Not validated** – not compared with 3mensio or against fluoroscopy/clinical outcomes; tested only on a synthetic phantom and unit/geometry checks. The phantom truth is internally generated by the same maths library (A vs truth compares the app's manual-marker pipeline with the analytic chain, not with reality). No real patient CT has been tried.
* **Approximations:** descending-aorta level is user-chosen (default is an arbitrary heuristic); the RMF "same rotational angle" model may differ from 3mensio's straightened-vessel frame (especially around the arch); C-arm is an ideal orthographic, isocentric model (no magnification/parallax, table rotation/tilt, cradle offsets; patient assumed lying as in the CT). Sign conventions must be verified on the actual angiography system.
* **DICOM support:** uncompressed (implicit/explicit VR little endian, deflated; explicit big-endian is implemented but untested), **JPEG Lossless Process 14 (1.2.840.10008.1.2.4.57) and SV1 (…4.70)** (hand-written Huffman decoder: predictors 1–7, 2–16-bit precision, point transform, restart intervals, 0xFF00 stuffing; encapsulated multi-fragment pixel data, basic offset table tolerated), **JPEG Baseline/Extended (…4.50/4.51, grey-scale only, float IDCT, ±1 level vs libjpeg)** and **RLE Lossless (…1.2.5)**. Signed pixels (sign-extended from Bits Stored) and RescaleSlope/Intercept are applied. **Not supported (clear error naming the codec): JPEG 2000 (…4.90/4.91), JPEG-LS, progressive/arithmetic JPEG, multi-component (colour) JPEG, multi-frame/enhanced CT.** Re-export or convert (`gdcmconv --raw`, `dcmdjpeg`, `dcmdjp2k`…) in those cases. ZIP64 not supported. Large folders: a header-only scan (8 files in parallel, progress bar) groups files by Series UID/matrix/orientation, lists series (description, slice count, matrix, spacing, orientation, coverage, contrast, codec, score reasons) and pre-selects the best axial thin contrast CT series; only the series you load is decoded. RGB/secondary-capture, no-position and no-pixel files are counted and skipped. Decoding runs on the main thread (UI yields between slices; ≈10 ms per 512×512 lossless slice in Node/V8). Non-uniform slice spacing only produces a warning. Very large series (> 320 M voxels) are downsampled 2× in-plane; ZIP input holds the decompressed files in memory.
* Folder drag-drop relies on `webkitGetAsEntry` (not exercised by automation; file inputs and a synthetic file drop were). Firefox/Safari untested.
* The 2:1 criterion is a geometric proxy (nearest marker to projected axis); it does not model marker visibility, overlap on the fluoroscopic image, or valve/delivery-system rotation behaviour.
