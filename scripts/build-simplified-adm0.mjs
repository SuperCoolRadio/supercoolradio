// build-simplified-adm0.mjs
//
// One-shot build script that produces public/data/simplified-adm0.json:
// a single static asset bundling the Douglas-Peucker–simplified contiguous
// geometry (and bounds) of every ADM0 country.
//
// Why this exists
// ───────────────
// The runtime previously fetched all 230 full-resolution country GeoJSONs
// at mount, parsed them, computed wrapped bounds, shifted antimeridian-
// crossers into contiguous form, and ran custom Douglas-Peucker on each —
// all on the user's main thread, before they did anything. On mobile this
// caused enough memory pressure to crash Safari under sustained zoom
// thrashing (verified 2026-04-30: 20 sec rapid zoom on iPhone → "A problem
// repeatedly occurred" tab kill).
//
// After this script runs, the runtime fetches just two files: tree.json
// (already exists) and simplified-adm0.json (this file's output). Full-
// resolution geometry is fetched per-country only when the user actually
// navigates into one and we need to draw the green border.
//
// Algorithmic equivalence
// ───────────────────────
// This script ports the runtime's simplification pipeline 1:1 from
// components/MapCanvas.tsx — extractGeometry, computeWrappedBounds,
// shiftLng/shiftGeometryLngs, dpSimplifyOpenPath, simplifyRing,
// simplifyGeometry, and the HOVER_SIMPLIFY_TOLERANCE_DEG constant. If any
// of those change in the runtime, this script must be updated and re-run.
// (Diverging would mean the precomputed hit-target geometry no longer
// matches what the green border is drawn from at full resolution, which
// would manifest as hit-targets that don't quite line up with what the
// user sees.)
//
// Usage
// ─────
//   node scripts/build-simplified-adm0.mjs
//
// Reads from:
//   ../Earth/boundaries/tree/<NNN>/<NNN>.geojson    (relative to web/scripts/)
// Writes to:
//   ../public/data/simplified-adm0.json             (relative to web/scripts/)
//
// Run from anywhere; paths are resolved relative to this file's location.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Paths ───────────────────────────────────────────────────────────────
// scripts/ lives inside web/. Boundaries corpus is at the sibling
// SCR/Earth/boundaries/, so we go up two levels to SCR/ and across.
const WEB_ROOT = resolve(__dirname, '..');
const BOUNDARIES_TREE = resolve(WEB_ROOT, '..', 'Earth', 'boundaries', 'tree');
const OUTPUT_FILE = resolve(WEB_ROOT, 'public', 'data', 'simplified-adm0.json');

// ─── Simplification tolerances ────────────────────────────────────────────
// Used to be set to match HOVER_SIMPLIFY_TOLERANCE_DEG in MapCanvas.tsx
// (0.01°, ~1km — chosen so hover hit-targets stay sub-pixel-accurate even
// on desktop at deep zoom). At that tolerance the precomputed bundle was
// 12.4 MB uncompressed, dominated by coastline-heavy countries (Canada
// 57k verts, Greenland 43k, Indonesia and Norway thousands of islands).
//
// We deliberately diverge here. The mount-time bundle is for FAST PAGE
// LOAD: it ships hit-targets that work at World view (where a pixel is
// ~40 km, so 0.1° / ~10 km is still 4× sub-pixel) and across most
// reasonable zoom levels. The MOMENT a user clicks into a country, the
// runtime fetches that country's full GeoJSON and produces a fresh
// hit-target at the original 0.01° tolerance — so once you've selected
// a country, hovering on its real coastline is precise. Before selection,
// hit-targets are slightly chunkier but well below visible threshold.
//
// PRIMARY tolerance: 0.1° (~10 km). Sweet spot for big-country file size.
// FALLBACK tolerances: walked down toward 0 if the primary collapses a
// country below MIN_VERTS_PER_COUNTRY. Microstates (Vatican, Monaco,
// Nauru, Tuvalu, etc.) and tiny islands fit entirely inside a 0.1° box,
// so DP at primary tolerance reduces them to 0 vertices — they'd become
// unclickable. Falling back to a finer tolerance preserves them with a
// proportional cost (San Marino at 0.01° is still only ~50 verts).
const PRIMARY_TOLERANCE_DEG = 0.1;
const FALLBACK_TOLERANCES_DEG = [0.05, 0.02, 0.01, 0.005, 0.001];
const MIN_VERTS_PER_COUNTRY = 8;

// ─── Ported from MapCanvas.tsx (1:1, comments trimmed for brevity) ──────

const extractGeometry = (geojson) => {
  if (geojson.type === 'FeatureCollection') {
    if (geojson.features.length === 0) return null;
    return geojson.features[0].geometry;
  }
  if (geojson.type === 'Feature') return geojson.geometry;
  if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') return geojson;
  return null;
};

const computeWrappedBounds = (geom) => {
  const lngs = [];
  const lats = [];
  const collect = (g) => {
    if (g.type === 'Polygon') {
      for (const ring of g.coordinates) {
        for (const [lng, lat] of ring) { lngs.push(lng); lats.push(lat); }
      }
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          for (const [lng, lat] of ring) { lngs.push(lng); lats.push(lat); }
        }
      }
    }
  };
  collect(geom);
  if (lngs.length === 0) {
    return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  }
  let minLat = Infinity, maxLat = -Infinity;
  for (const lat of lats) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const sorted = [...lngs].sort((a, b) => a - b);
  const n = sorted.length;
  let bestGap = -1;
  let bestGapAfter = n - 1;
  for (let i = 0; i < n - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > bestGap) { bestGap = gap; bestGapAfter = i; }
  }
  const wrapGap = sorted[0] + 360 - sorted[n - 1];
  if (wrapGap > bestGap) { bestGap = wrapGap; bestGapAfter = n - 1; }
  let minLng, maxLng;
  if (bestGapAfter === n - 1) {
    minLng = sorted[0];
    maxLng = sorted[n - 1];
  } else {
    minLng = sorted[bestGapAfter + 1];
    maxLng = sorted[bestGapAfter] + 360;
  }
  return { minLat, maxLat, minLng, maxLng };
};

const shiftLng = (lng, minLng) =>
  lng - 360 * Math.floor((lng - minLng) / 360);

const shiftGeometryLngs = (geom, minLng) => {
  if (geom.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geom.coordinates.map((ring) =>
        ring.map(([lng, lat]) => [shiftLng(lng, minLng), lat]),
      ),
    };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map((poly) =>
        poly.map((ring) =>
          ring.map(([lng, lat]) => [shiftLng(lng, minLng), lat]),
        ),
      ),
    };
  }
  return geom;
};

const dpSimplifyOpenPath = (points, toleranceSq) => {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;
    const ax = points[first][0], ay = points[first][1];
    const bx = points[last][0], by = points[last][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxDistSq = 0;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i][0], py = points[i][1];
      let distSq;
      if (lenSq === 0) {
        const ex = px - ax, ey = py - ay;
        distSq = ex * ex + ey * ey;
      } else {
        const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + tc * dx, cy = ay + tc * dy;
        const ex = px - cx, ey = py - cy;
        distSq = ex * ex + ey * ey;
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIdx = i;
      }
    }
    if (maxDistSq > toleranceSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx]);
      stack.push([maxIdx, last]);
    }
  }
  const result = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
};

const simplifyRing = (ring, toleranceSq) => {
  const n = ring.length;
  if (n < 5) return ring.slice();
  const ax = ring[0][0], ay = ring[0][1];
  let maxDistSq = 0, maxIdx = 1;
  for (let i = 1; i < n - 1; i++) {
    const dx = ring[i][0] - ax, dy = ring[i][1] - ay;
    const d = dx * dx + dy * dy;
    if (d > maxDistSq) { maxDistSq = d; maxIdx = i; }
  }
  const part1 = dpSimplifyOpenPath(ring.slice(0, maxIdx + 1), toleranceSq);
  const part2 = dpSimplifyOpenPath(ring.slice(maxIdx), toleranceSq);
  const out = part1.concat(part2.slice(1));
  if (out.length >= 3) {
    const f = out[0], l = out[out.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  }
  return out;
};

const simplifyGeometry = (geom, tolerance) => {
  const tolSq = tolerance * tolerance;
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates
      .map((r) => simplifyRing(r, tolSq))
      .filter((r) => r.length >= 4);
    return { type: 'Polygon', coordinates: rings };
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map((poly) =>
        poly.map((r) => simplifyRing(r, tolSq)).filter((r) => r.length >= 4),
      )
      .filter((poly) => poly.length > 0);
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
};

const countCoords = (geom) => {
  let n = 0;
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) n += ring.length;
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      for (const ring of poly) n += ring.length;
    }
  }
  return n;
};

// ─── Main ────────────────────────────────────────────────────────────────

const main = async () => {
  const t0 = Date.now();

  // Confirm boundaries tree exists before doing anything else.
  try {
    await stat(BOUNDARIES_TREE);
  } catch {
    console.error(`ERROR: boundaries tree not found at ${BOUNDARIES_TREE}`);
    console.error(`       Adjust BOUNDARIES_TREE at the top of this script.`);
    process.exit(1);
  }

  const entries = await readdir(BOUNDARIES_TREE, { withFileTypes: true });
  // ADM0 codes are three digits, optionally followed by a single lowercase
  // letter for split_adm0 synthetic Areas (PSE-G → 275a, PSE-W → 275b).
  // The letter convention is established by build_tree_json.py's
  // SPECIAL_AREA_CODES dict.
  const codes = entries
    .filter((e) => e.isDirectory() && /^\d{3}[a-z]?$/.test(e.name))
    .map((e) => e.name)
    .sort();

  console.log(`Found ${codes.length} ADM0 directories.`);

  const out = {};
  let processedCount = 0;
  let skippedCount = 0;
  let totalBeforeCoords = 0;
  let totalAfterCoords = 0;

  for (const code of codes) {
    const path = join(BOUNDARIES_TREE, code, `${code}.geojson`);
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      console.warn(`  skip ${code}: missing file ${path}`);
      skippedCount++;
      continue;
    }

    let geojson;
    try {
      geojson = JSON.parse(raw);
    } catch (err) {
      console.warn(`  skip ${code}: bad JSON (${err.message})`);
      skippedCount++;
      continue;
    }

    const origGeom = extractGeometry(geojson);
    if (!origGeom) {
      console.warn(`  skip ${code}: no geometry in file`);
      skippedCount++;
      continue;
    }

    const bounds = computeWrappedBounds(origGeom);
    const contiguous = shiftGeometryLngs(origGeom, bounds.minLng);
    const before = countCoords(contiguous);

    // Adaptive simplification: try the primary tolerance first; if that
    // collapses the country below MIN_VERTS_PER_COUNTRY, walk down the
    // fallback list until we get something usable. We give up only if
    // the original geometry itself has fewer than MIN_VERTS — in which
    // case we ship the original (some boundaries genuinely are tiny
    // 4-vertex squares from the source data).
    let simple = simplifyGeometry(contiguous, PRIMARY_TOLERANCE_DEG);
    let usedTolerance = PRIMARY_TOLERANCE_DEG;
    let after = countCoords(simple);
    if (after < MIN_VERTS_PER_COUNTRY && before >= MIN_VERTS_PER_COUNTRY) {
      for (const tol of FALLBACK_TOLERANCES_DEG) {
        simple = simplifyGeometry(contiguous, tol);
        usedTolerance = tol;
        after = countCoords(simple);
        if (after >= MIN_VERTS_PER_COUNTRY) break;
      }
      // If even the finest fallback doesn't meet the floor, ship the
      // original contiguous geometry — better an oversized hit-target
      // than no hit-target at all.
      if (after < MIN_VERTS_PER_COUNTRY) {
        simple = contiguous;
        usedTolerance = 0;
        after = before;
      }
    }

    out[code] = { bounds, geom: simple };
    processedCount++;
    totalBeforeCoords += before;
    totalAfterCoords += after;

    // Quiet log: one line per country, padded for alignment. Annotate
    // any country that needed a non-primary tolerance, so anomalies
    // are easy to spot.
    const ratio = before > 0 ? (after / before * 100).toFixed(1) : '—';
    const tolNote = usedTolerance === PRIMARY_TOLERANCE_DEG
      ? ''
      : usedTolerance === 0
        ? '  [original]'
        : `  [tol ${usedTolerance}°]`;
    console.log(
      `  ${code}: ${String(before).padStart(7)} → ${String(after).padStart(6)} verts (${ratio}%)${tolNote}`,
    );
  }

  // Serialize compact (no pretty-printing) — file size matters, this is
  // not human-edited.
  const json = JSON.stringify(out);
  await writeFile(OUTPUT_FILE, json, 'utf8');
  const sizeKB = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`  ${processedCount} countries, ${skippedCount} skipped`);
  console.log(`  ${totalBeforeCoords.toLocaleString()} input verts → ${totalAfterCoords.toLocaleString()} output verts (${(totalAfterCoords / totalBeforeCoords * 100).toFixed(1)}%)`);
  console.log(`  ${sizeKB} KB on disk (uncompressed; gzip will compress this further over the wire)`);
  console.log(`  Took ${elapsed}s`);
};

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
