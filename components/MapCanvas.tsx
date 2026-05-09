'use client';

import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

type TreeNode = {
  code: string;
  name: string;
  display_name?: string;
  level: 'World' | 'Area' | 'Region' | 'Sub-Region';
  iso_alpha3?: string;
  shape_id?: string;
  population?: number;
  children?: TreeNode[];
};

// Shape of every tiered hit-target bundle (adm0-tN.json, adm1/<NNN>-tN.json,
// and adm2/<NNN>-<MMM>-tN.json when Sub-Regions return). Keys are codes —
// for the ADM0 bundle, 3-digit ISO 3166-1 numeric zero-padded; for ADM1
// bundles, '<parent>-<sequential>' (e.g. '840-005' for California in USA's
// bundle). Each entry stores the polygon's wrapped bounds (minLat/maxLat/
// minLng/maxLng — see computeWrappedBounds for the largest-gap algorithm
// that handles antimeridian crossers) and its Douglas-Peucker–simplified
// contiguous-form geometry. Produced by scripts/build-simplified-tiers.mjs.
type SimplifiedBundle = {
  [code: string]: {
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
    geom: GeoJSON.Geometry;
  };
};

// Base URL for the per-polygon, per-tier simplified-geometry corpus.
// Each polygon has its own GeoJSON file at every tier, mirroring the
// directory structure of the source-of-truth full-precision corpus at
// boundaries.supercoolradio.com — but with a tier suffix in the
// filename. The runtime fetches BORDER_TIER files from here when
// drawing borders.
//
// This corpus replaces the prior border source
// (boundaries.supercoolradio.com/tree/...). The full-precision corpus
// shipped polygons with absurd vertex counts (Nunavut: 5.4 million
// vertices in a single MultiPolygon — the Arctic Archipelago at every-
// rock detail), and Mobile Safari crashed when handed those as SVG
// paths to rasterize. T6 (~2.4 km tolerance) is the chosen ceiling:
// at our deepest tile zoom (8) one screen pixel is ~310 m at the
// equator, so T6 is barely sub-pixel; finer than that buys nothing
// visible and risks crashes.
//
// Built offline by scripts/build-simplified-tree.mjs.
const BORDERS_BASE =
  'https://simplified-boundaries.supercoolradio.com/tree';

// Cache-bust version appended as a query string to every URL fetched
// from the simplified-boundaries domain. Bump this constant after any
// rebuild of the bundles or per-polygon corpus. Browser cache and
// Cloudflare edge cache treat ?v=N as part of the cache key, so old
// cached responses become inert (they'd only be served for the old
// URL, which nothing requests anymore) and new responses populate
// freshly. Also avoids needing a Cloudflare purge after each rebuild.
//
// Bump history:
//   v1 — initial deployment (implicit, no query string)
//   v2 — 2026-05-09 diameter-cap simplifier (DIAMETER_TOLERANCE_DIVISOR=100)
const BOUNDARIES_VERSION = 'v=2';
const versioned = (url: string): string =>
  url + (url.includes('?') ? '&' : '?') + BOUNDARIES_VERSION;

// Tier used for drawn borders. Universal — applies to every level
// (ADM0, ADM1, eventually ADM2). Picked as the smallest tier that's
// effectively sub-pixel at our deepest tile zoom; any finer just
// pays for invisible detail at the risk of vertex-count blowup.
const BORDER_TIER = 6;

// Base URL for tiered simplified-geometry hit-target bundles. These
// bundles provide pre-simplified geometry for clicks/hovers: one
// bundle for all ADM0 (loaded at mount), one bundle per subdivided
// ADM0 for that country's ADM1 children (loaded on drill-in). Built
// offline by scripts/build-simplified-tiers.mjs. Served from a
// dedicated R2 bucket via CORS-enabled custom domain.
const SIMPLIFIED_BOUNDARIES_BASE =
  'https://simplified-boundaries.supercoolradio.com';

// Tier selection for hit-targets. Universal across levels: T3
// (~20 km tolerance) for both the world's ADM0 hit-targets (loaded at
// mount) and each subdivided country's ADM1 hit-targets (loaded on
// drill-in). T3 is comfortably sub-pixel at every zoom where you'd
// click a polygon at the corresponding administrative level — World
// view (zoom 0–3, pixel ≥ 10 km) for ADM0 clicks, drilled-into-
// country view (zoom 3–5, pixel ≥ 5 km) for ADM1 clicks. Click
// accuracy at borders is at most 1–2 pixels off, indistinguishable
// in practice.
//
// Borders: drawn at T3 immediately (re-using the in-heap hit-target
// geometry as a stand-in), then upgraded to T6 by background fetch
// of the per-polygon T6 file from BORDERS_BASE. Same rule for ADM0
// and ADM1 — see the two-stage policy in reconcileBordersForCode.
//
// Microstate hit-targets: the build script enforces an 8-vertex floor
// per polygon (walking down a fallback tolerance ladder, ultimately
// shipping the original geometry if even tolerance 0 collapses below
// 8). At T3 the inscribed octagon for a tiny island still covers the
// bulk of its surface area — clickable across most of the island
// once the user is zoomed in enough to see it.
const ADM0_TIER = 3;
const ADM1_TIER = 3;
const ADM0_BUNDLE_URL = versioned(
  `${SIMPLIFIED_BOUNDARIES_BASE}/adm0-t${ADM0_TIER}.json`,
);
const adm1BundleUrl = (parentCode: string) =>
  versioned(
    `${SIMPLIFIED_BOUNDARIES_BASE}/adm1/${parentCode}-t${ADM1_TIER}.json`,
  );

// Border color by administrative level. ADM0 (Areas) green, ADM1
// (Regions) yellow, ADM2 (Sub-Regions) cyan. Bright pure-channel colors
// chosen for high-contrast visibility against both ocean (#071738) and
// land (#eff2f1) backgrounds. Districts (ADM3) will get their own color
// when that tier is built.
const BORDER_COLOR_BY_LEVEL: Record<TreeNode['level'], string> = {
  World:        '#00ff00', // unused — World itself has no border
  Area:         '#00ff00',
  Region:       '#ffff00',
  'Sub-Region': '#00ffff',
};
const BORDER_WEIGHT = 2;

// Helpers for toggling the scr-flying CSS class. The class is added
// to BOTH the map container AND document.body during a fly. Body-level
// is the load-bearing one — it makes CSS rules like
// `body.scr-flying * { cursor: none }` apply to every element on the
// page, regardless of nesting or specificity. Container-level is kept
// for any rules scoped specifically inside the map. Both add/remove
// in lockstep.
const setFlyingActive = (containerEl: HTMLDivElement | null) => {
  if (containerEl) containerEl.classList.add('scr-flying');
  if (typeof document !== 'undefined') {
    document.body.classList.add('scr-flying');
  }
};
const setFlyingInactive = (containerEl: HTMLDivElement | null) => {
  if (containerEl) containerEl.classList.remove('scr-flying');
  if (typeof document !== 'undefined') {
    document.body.classList.remove('scr-flying');
  }
};

// Hit-target paint-order policy: smallest on top.
//
// When two polygons overlap — either a possession contained in its
// host (Taiwan in China, Guam / PR / ASM / MNP / VIR in USA, Vatican
// in Italy, Lesotho in South Africa, Gibraltar's footprint relative
// to Spain), or any contested-territory pair where two ADM0 outlines
// intersect — the smaller polygon's hit-target must paint on top of
// the larger one. Otherwise the larger ADM0's invisible hit-target
// catches every click and hover in the contained region, leaving the
// smaller polygon effectively unclickable at any zoom.
//
// SVG paint order = DOM order, last sibling on top; bringToFront moves
// the path to the end of the parent SVG group, which is also what
// Leaflet's hit-testing follows. So we re-stack every attached hit-
// target layer in descending bbox-area order on each reconcile,
// calling bringToFront on each in turn — the layer called LAST (the
// smallest) ends up on top. The reorder is universal: no hand-edited
// list of special-case codes, no maintenance burden as new map
// adjustments add small contained polygons. See the re-stack pass at
// the end of reconcileTargetsForCode.

// Walk tree.json once to build:
//   - codeToNode: lookup any node by code
//   - codeToAncestry: full ancestry path including the node itself,
//     starting at World, e.g. '840-006' -> ['000', '840', '840-006']
type TreeIndex = {
  codeToNode: Map<string, TreeNode>;
  codeToAncestry: Map<string, string[]>;
};

const indexTree = (root: TreeNode): TreeIndex => {
  const codeToNode = new Map<string, TreeNode>();
  const codeToAncestry = new Map<string, string[]>();
  const walk = (node: TreeNode, ancestors: string[]) => {
    const ancestry = [...ancestors, node.code];
    codeToNode.set(node.code, node);
    codeToAncestry.set(node.code, ancestry);
    for (const child of node.children ?? []) {
      walk(child, ancestry);
    }
  };
  walk(root, []);
  return { codeToNode, codeToAncestry };
};

const extractGeometry = (
  geojson: GeoJSON.GeoJSON,
): GeoJSON.Geometry | null => {
  if (geojson.type === 'FeatureCollection') {
    if (geojson.features.length === 0) return null;
    return geojson.features[0].geometry;
  }
  if (geojson.type === 'Feature') return geojson.geometry;
  if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') return geojson;
  return null;
};

// Compute a bounding box for a polygon, correctly handling antimeridian-
// crossing geometries (USA via the Aleutians, Russia, Fiji, etc.).
//
// Latitude is straightforward: min and max.
//
// Longitude lives on a circle, so the right notion of "bounds" is: find
// the largest empty arc on that circle, and the bounding interval is its
// complement. Concretely:
//   1. Sort all longitudes ascending.
//   2. Compute the gap between each consecutive pair, plus the wrap-gap
//      from the last entry back to the first via ±180.
//   3. The largest gap is the empty arc.
//   4. The complement of that gap on the circle is [minLng, maxLng].
//
// For ordinary countries (France, China) the wrap-gap is the largest, and
// the result collapses to the standard [min, max] form.
//
// For antimeridian-crossing countries (USA), the largest gap is somewhere
// inside the sorted list — the empty Pacific from the East Coast to the
// Aleutians. The complement is expressed by adding 360° to the smaller
// longitude so the returned bounds satisfy minLng < maxLng. fitBounds
// receiving e.g. [_, 172] to [_, 293] centers the map at 232.5°, which
// worldCopyJump then resolves to -127.5° — physical center of USA.
//
// INVARIANT (relied on downstream): maxLng - minLng <= 360. This holds
// because maxLng - minLng = 360 - bestGap and bestGap is in [0, 360].
const computeWrappedBounds = (geom: GeoJSON.Geometry): L.LatLngBounds => {
  const lngs: number[] = [];
  const lats: number[] = [];
  const collect = (g: GeoJSON.Geometry) => {
    if (g.type === 'Polygon') {
      for (const ring of g.coordinates) {
        for (const [lng, lat] of ring) {
          lngs.push(lng);
          lats.push(lat);
        }
      }
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          for (const [lng, lat] of ring) {
            lngs.push(lng);
            lats.push(lat);
          }
        }
      }
    }
  };
  collect(geom);

  if (lngs.length === 0) {
    return L.latLngBounds([0, 0], [0, 0]);
  }

  let minLat = Infinity, maxLat = -Infinity;
  for (const lat of lats) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // Sort longitudes ascending. For Russia (~100k vertices on the full-
  // precision polygon) this is the dominant cost of the function — modern
  // V8 sorts 100k floats in roughly 30-50 ms, acceptable for a one-shot
  // zoom action. The result is not cached; if it ever shows up as a hot
  // path we can memoize per code.
  const sorted = [...lngs].sort((a, b) => a - b);
  const n = sorted.length;

  // Find the largest gap. bestGapAfter = i means the gap is between
  // sorted[i] and sorted[i+1] (or, when i === n-1, the wrap-around gap
  // from sorted[n-1] back to sorted[0] + 360).
  let bestGap = -1;
  let bestGapAfter = n - 1;
  for (let i = 0; i < n - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestGapAfter = i;
    }
  }
  const wrapGap = sorted[0] + 360 - sorted[n - 1];
  if (wrapGap > bestGap) {
    bestGap = wrapGap;
    bestGapAfter = n - 1;
  }

  let minLng: number, maxLng: number;
  if (bestGapAfter === n - 1) {
    // Wrap gap is largest: polygon does not cross the antimeridian.
    minLng = sorted[0];
    maxLng = sorted[n - 1];
  } else {
    // Largest gap is inside the sorted list: polygon crosses the
    // antimeridian. The complement runs from sorted[bestGapAfter+1]
    // east across ±180 to sorted[bestGapAfter]. Express by adding
    // 360 to sorted[bestGapAfter] so minLng < maxLng numerically.
    minLng = sorted[bestGapAfter + 1];
    maxLng = sorted[bestGapAfter] + 360;
  }

  return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
};

// Hover-target simplification tolerance, in degrees of lat/lon. ~0.01° is
// roughly 1 km at the equator. Way below one screen pixel at world zoom
// (each pixel ≈ 40 km there), and the hit-target polygons are invisible
// anyway — what matters is that the point-in-polygon boundary stays close
// enough to the real coastline that the hover behaves intuitively. The
// visible green border continues to use the full-precision file. Tunable.
const HOVER_SIMPLIFY_TOLERANCE_DEG = 0.01;

// Iterative Douglas-Peucker on an open polyline. Operates in raw lat/lon
// degree space, comparing squared perpendicular distances to skip a sqrt
// per point. Iterative (with an explicit stack) rather than recursive so
// huge rings — Russia's coastline has ~100k vertices — don't blow the
// JS engine's recursion limit.
const dpSimplifyOpenPath = (
  points: number[][],
  toleranceSq: number,
): number[][] => {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const ax = points[first][0], ay = points[first][1];
    const bx = points[last][0], by = points[last][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxDistSq = 0;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i][0], py = points[i][1];
      let distSq: number;
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
  const result: number[][] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
};

// Simplify a closed ring. Two-anchor strategy: find the vertex furthest
// from ring[0], use it as the second anchor, run DP on each half. Treating
// a closed ring as an open path with identical endpoints would degenerate
// (line of length 0) and over-simplify the start/end region.
const simplifyRing = (
  ring: number[][],
  toleranceSq: number,
): number[][] => {
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
  // Ensure the output ring is closed (Leaflet/GeoJSON requires this).
  if (out.length >= 3) {
    const f = out[0], l = out[out.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  }
  return out;
};

const countCoords = (geom: GeoJSON.Geometry): number => {
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

// Simplify a Polygon or MultiPolygon. Rings that collapse below 4 vertices
// are dropped; sub-polygons whose outer ring collapses are dropped entirely.
// The collapse rule means very small holes (e.g. Vatican-shaped holes in
// Italy) may disappear at aggressive tolerances — at HOVER_SIMPLIFY_TOLERANCE_DEG
// = 0.01° this is fine for everything bigger than ~1 km across.
const simplifyGeometry = (
  geom: GeoJSON.Geometry,
  tolerance: number,
): GeoJSON.Geometry => {
  const tolSq = tolerance * tolerance;
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates
      .map((r) => simplifyRing(r as number[][], tolSq))
      .filter((r) => r.length >= 4);
    return { type: 'Polygon', coordinates: rings as GeoJSON.Position[][] };
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map((poly) =>
        poly
          .map((r) => simplifyRing(r as number[][], tolSq))
          .filter((r) => r.length >= 4),
      )
      .filter((poly) => poly.length > 0);
    return {
      type: 'MultiPolygon',
      coordinates: polys as GeoJSON.Position[][][],
    };
  }
  return geom;
};

// Modular shift: map a single longitude into [minLng, minLng + 360) by
// subtracting the right multiple of 360. Used at fetch time to put every
// vertex of an antimeridian-crossing polygon into a single contiguous
// longitude range.
const shiftLng = (lng: number, minLng: number): number =>
  lng - 360 * Math.floor((lng - minLng) / 360);

// Modular shift, applied to every vertex of a Polygon/MultiPolygon. For
// an antimeridian-crossing country whose bounds extend past +180° (USA at
// [144.6, 295.4]), this places the antimeridian-side vertices on a single
// contiguous longitude range — Aleutians stay at +172°, mainland's -67°
// becomes +293°. The polygon's natural drawing path no longer crosses
// ±180° anywhere; the antimeridian discontinuity is gone.
const shiftGeometryLngs = (
  geom: GeoJSON.Geometry,
  minLng: number,
): GeoJSON.Geometry => {
  if (geom.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geom.coordinates.map((ring) =>
        ring.map(([lng, lat]) => [shiftLng(lng, minLng), lat]),
      ) as GeoJSON.Position[][],
    };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map((poly) =>
        poly.map((ring) =>
          ring.map(([lng, lat]) => [shiftLng(lng, minLng), lat]),
        ),
      ) as GeoJSON.Position[][][],
    };
  }
  return geom;
};

// Uniform additive shift: add `offset` (a number, typically a multiple of
// 360) to every longitude. Distinct from the modular shiftGeometryLngs
// above — this one does NOT clamp into a 360°-wide window. Used at render
// time to translate a contiguous-form polygon into the correct viewport
// position.
const translateGeometryLng = (
  geom: GeoJSON.Geometry,
  offset: number,
): GeoJSON.Geometry => {
  if (offset === 0) return geom;
  if (geom.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geom.coordinates.map((ring) =>
        ring.map(([lng, lat]) => [lng + offset, lat]),
      ) as GeoJSON.Position[][],
    };
  }
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map((poly) =>
        poly.map((ring) =>
          ring.map(([lng, lat]) => [lng + offset, lat]),
        ),
      ) as GeoJSON.Position[][][],
    };
  }
  return geom;
};

// Wrap a single bare Polygon/MultiPolygon in a minimal FeatureCollection
// so it can be passed straight to L.geoJSON. The HPSCU properties from
// the original file are deliberately dropped — they're irrelevant for
// rendering and dropping them avoids deep-copying the metadata blob.
const featureCollectionOf = (
  geom: GeoJSON.Geometry,
): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: geom }],
});

// Construct a closed-ring Polygon from an axis-aligned bounding box.
// Vertex order: SW → SE → NE → NW → SW (counter-clockwise when read
// in standard cartographic convention with north up). Used during
// bundle hydration to substitute a node's natural geometry with its
// bbox when the node is in the Maldives-problem set (see the doc
// block below and bboxHitTargetCodesRef inside the component).
const bboxToPolygon = (b: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}): GeoJSON.Geometry => ({
  type: 'Polygon',
  coordinates: [
    [
      [b.minLng, b.minLat],
      [b.maxLng, b.minLat],
      [b.maxLng, b.maxLat],
      [b.minLng, b.maxLat],
      [b.minLng, b.minLat],
    ],
  ],
});

// Codes that exhibit the "Maldives problem" — the node's natural
// geometry is too small or too dispersed for hit-targets and borders
// rendered from it to be useful. At bundle hydration time, the bbox
// polygon supplants the simplified geom in both the hit-target cache
// and the full-precision cache; fetchGeometry then short-circuits
// because contiguousGeomByCodeRef is already populated. Net effect:
// clickable region is the entire bbox, hover border is the bbox
// rectangle, no T6 fetch ever fires.
//
// The set is loaded at mount time from /data/bbox-hit-targets.json,
// which is generated by the build pipeline running
//   boundaries/scripts/rank_maldives_problem.py
// across every bundle (ADM0, ADM1, and eventually districts) and
// emitting every code with land_area / bbox_area below 0.015.
//
// Threshold rationale: 0.015 sits in a clean ~5x gap in the ADM0
// data (worst included country, Wallis and Futuna at 0.004; worst
// excluded, Solomon Islands at 0.019, which is empirically "barely
// findable but livable"). Anything below 0.015 is guaranteed to be
// no worse than that lower bound. The same threshold applies at
// every level — same metric, same UX problem.
//
// At ADM0 the membership is expected to be ~14 codes (Maldives,
// Marshall Islands, Kiribati, Tuvalu, FSM, Saint Helena, Cook
// Islands, French Polynesia, Tokelau, Seychelles, Tonga, Mauritius,
// Palau, Wallis and Futuna). ADM1 and district counts depend on
// what the build script produces — empty file is a valid result.

// Given a polygon's contiguous-form bounds [polyMin, polyMax] and the
// map's current viewport longitude range [viewLeft, viewRight], return
// the set of offsets (multiples of 360) at which the polygon should be
// rendered to fully cover its visible portion of the viewport.
//
// For a viewport that's a strict subset of one world (viewWidth < 360),
// returns 0 or 1 offsets if the polygon is entirely inside or outside the
// viewport, or 2 offsets when the polygon "wraps" across the viewport —
// e.g. at min zoom panned so USA is half on the east edge and half on the
// west edge.
//
// At min zoom (viewWidth = 360), an antimeridian-crossing polygon like
// USA always returns 2 offsets: one places mainland in view, the other
// places the Aleutians in view. A non-crosser like France returns 1.
//
// Algorithm:
//   1. Anchor candidate baseOffset such that polyMin + baseOffset lands
//      in [viewLeft, viewLeft + 360). For non-crossers this is typically
//      the offset that places the polygon at its natural geographic
//      position; for crossers this is the offset that places polyMin (the
//      west edge of the contiguous form) into the viewport's first cycle.
//   2. Test three candidate offsets — baseOffset - 360, baseOffset, and
//      baseOffset + 360 — for whether the polygon under that offset
//      overlaps the viewport. Keep the ones that do.
// Three candidates suffices because polygon span and viewport span are
// each <= 360, so at most two consecutive offsets can produce an
// overlapping copy.
const placeForView = (
  bounds: L.LatLngBounds,
  viewLeft: number,
  viewRight: number,
): number[] => {
  const polyMin = bounds.getWest();
  const polyMax = bounds.getEast();
  const baseOffset = 360 * Math.ceil((viewLeft - polyMin) / 360);
  const offsets: number[] = [];
  for (const candidate of [baseOffset - 360, baseOffset, baseOffset + 360]) {
    const left = polyMin + candidate;
    const right = polyMax + candidate;
    if (right >= viewLeft && left <= viewRight) {
      offsets.push(candidate);
    }
  }
  return offsets;
};

// Read the map's current viewport longitude range. Returns [west, east]
// with east - west <= 360 (the viewport never spans more than one world).
// At min zoom east - west = 360 exactly; at higher zooms it's smaller.
const getViewportLngRange = (map: L.Map): [number, number] => {
  const b = map.getBounds();
  return [b.getWest(), b.getEast()];
};

// Smallest signed longitude displacement, normalized to [-180, 180].
// `dx` is the raw difference between two longitudes; the return value is
// the equivalent angle that takes the short way around the globe.
// JavaScript's `%` returns a result with the dividend's sign, so we add
// 360 and re-mod before subtracting 180 to handle negative inputs.
const wrapLngDiff = (dx: number): number =>
  ((dx + 180) % 360 + 360) % 360 - 180;

// Shift bounds by a multiple of 360° so its center is the short way
// around from the reference longitude. Same physical region of the
// globe, just expressed in a different ±360° representation. Used so
// that flyToBounds takes the direct route to the destination instead
// of circling the world.
//
// The math: let `current` be the reference longitude (where the map
// is now) and `target` be the bounds' center longitude (where it will
// go). The smallest signed displacement is x = wrapLngDiff(target -
// current); the destination center under the short-way path is
// current + x. The shift to apply to the bounds equals (current + x) -
// target, which is always 0 or ±360°.
const shiftBoundsToNearest = (
  bounds: L.LatLngBounds,
  refLng: number,
): L.LatLngBounds => {
  const target = (bounds.getWest() + bounds.getEast()) / 2;
  const x = wrapLngDiff(target - refLng);
  const shift = (refLng + x) - target;
  if (shift === 0) return bounds;
  return L.latLngBounds(
    [bounds.getSouth(), bounds.getWest() + shift],
    [bounds.getNorth(), bounds.getEast() + shift],
  );
};

// Shortest-way variant of flyTo's target longitude. Returns the
// equivalent of `targetLng` that takes the short path from `refLng`.
// Used by the World-case flyTo, where there is no bounds object —
// just a fixed target lng of 0.
const shiftLngToNearest = (targetLng: number, refLng: number): number =>
  refLng + wrapLngDiff(targetLng - refLng);

// Custom CRS: identical to the standard EPSG:3857 (Spherical Mercator)
// except MAX_LATITUDE is raised from 85.0511° to 86°. SphericalMercator
// clamps lat to ±MAX_LATITUDE before computing pixel y; with the default
// clamp every Antarctica vertex past -85.0511° projects to a single y
// value and renders as a horizontal seam at the visible south edge of
// the map. Raising the clamp to 86° pushes that seam to lat=-86°, which
// is below the pannable region (enforceConstraints holds the viewport
// to ±85.051°), so the seam is off-screen. The map's panning extent and
// rendered tile area are unchanged — this only affects where vertices
// past the old clamp project to.
const customCRS = L.Util.extend({}, L.CRS.EPSG3857, {
  projection: L.Util.extend({}, L.Projection.SphericalMercator, {
    MAX_LATITUDE: 86,
  }),
});

// Polar-safe pannable lat limit. Camera viewport must stay within
// [+POLAR_LIMIT, -POLAR_LIMIT]; below or above shows blue sky / white
// ice. Matches the NORTH_LIMIT / SOUTH_LIMIT used by enforceConstraints.
const POLAR_LIMIT = 85.051;

// Compute a (center, zoom) target for the path-driven zoom-to-country
// flow. Replaces flyToBounds with logic that respects two universal
// map-display constraints, plus a box-aspect-dependent natural-fit
// zoom.
//
// Universal constraints (must hold regardless of bounds):
//   1. POLAR — world's pannable region (lat range [+POLAR_LIMIT,
//      -POLAR_LIMIT]) must be at least as tall as the viewport, else
//      sky/ice appears at top/bottom. Implies target_P ≥ H/pannableFrac.
//   2. NO-DOUBLING — world width must be at least as wide as the
//      viewport, else the world tiles into adjacent copies and
//      content appears twice horizontally. Implies target_P ≥ W.
//
// Natural fit (depends on box aspect vs window aspect):
//   - WIDER box (aspectBox ≥ aspectWin): fit box to window width
//     → P_natural = Weff / widthFrac.
//   - TALLER box (aspectBox <  aspectWin): fit box to window height
//     → P_natural = Heff / heightFrac.
//
//   target_P = max(P_natural, P_polar, P_noDouble)
//
// When a universal constraint binds harder than the natural fit, the
// box "shrinks" symmetrically about its center to fit the higher-zoom
// viewport — the user sees only the central portion of the box but
// the map fills the window correctly.
//
// Camera position:
//   - Latitude:  as close to box center as possible, with viewport
//     within [yPolarN, yPolarS]. When P_polar binds, the valid camera-y
//     range collapses to a single point (pannable center), which the
//     clamp returns regardless of box.
//   - Longitude: box center (worldCopyJump handles wrap-around).
const computePolarSafeFlyTarget = (
  map: L.Map,
  bounds: L.LatLngBounds,
  viewportWidth: number,
  viewportHeight: number,
  paddingPx: number,
): { center: L.LatLng; zoom: number } => {
  const Weff = viewportWidth - 2 * paddingPx;
  const Heff = viewportHeight - 2 * paddingPx;

  // Project at zoom 0 → y / 256 = y-fraction.
  const yProj0 = (lat: number) => map.project(L.latLng(lat, 0), 0).y;
  const fPolarN = yProj0(POLAR_LIMIT) / 256;
  const fPolarS = yProj0(-POLAR_LIMIT) / 256;
  const fN = yProj0(bounds.getNorth()) / 256;
  const fS = yProj0(bounds.getSouth()) / 256;
  const pannableFrac = fPolarS - fPolarN; // ≈ 0.943

  const widthFrac = (bounds.getEast() - bounds.getWest()) / 360;
  const heightFrac = fS - fN;

  const aspectBox =
    heightFrac > 1e-9 ? widthFrac / heightFrac : Infinity;
  const aspectWin = Weff / Heff;

  const P_polar = viewportHeight / pannableFrac;
  const P_noDouble = viewportWidth;
  const P_natural =
    aspectBox >= aspectWin
      ? widthFrac > 1e-9
        ? Weff / widthFrac
        : 0
      : heightFrac > 1e-9
      ? Heff / heightFrac
      : 0;

  const targetP = Math.max(P_natural, P_polar, P_noDouble);
  const targetZoom = Math.log2(targetP / 256);

  // Camera lat: clamp to the valid range so the viewport stays within
  // the pannable region.
  const yPolarN_t = fPolarN * targetP;
  const yPolarS_t = fPolarS * targetP;
  const cyMin = yPolarN_t + viewportHeight / 2;
  const cyMax = yPolarS_t - viewportHeight / 2;
  // Use the Mercator-projected midpoint of the bounds, not the
  // lat-arithmetic midpoint. For high-latitude bounds (e.g. Canada
  // 41°N–83°N), the lat-arithmetic midpoint (62°N) is far from the
  // visual center because Mercator stretches latitudes toward the
  // poles. The visual center of Canada in projected pixel space
  // corresponds to ~71°N. Using the lat-arithmetic value placed the
  // camera too far south on wide viewports where this latitude
  // controls the centering, pushing the top of far-northern
  // countries off the top of the screen. fN and fS are the projected
  // y-fractions at zoom 0 already computed above.
  const yBoundsCenter = ((fN + fS) / 2) * targetP;
  const cyClamped = Math.max(cyMin, Math.min(cyMax, yBoundsCenter));
  const targetLat = map.unproject(L.point(0, cyClamped), targetZoom).lat;
  const targetLng = (bounds.getWest() + bounds.getEast()) / 2;

  return { center: L.latLng(targetLat, targetLng), zoom: targetZoom };
};

// Render-time layer cache key. Each (code, offset) pair gets its own
// cached L.GeoJSON layer — building one is cheap once the geometry is
// in memory but non-trivial (Leaflet parses GeoJSON, builds SVG paths),
// so we keep them around across attach/detach cycles.
const layerKey = (code: string, offset: number): string =>
  `${code}@${offset}`;

// True iff the primary input is capable of true hover (desktop mouse,
// laptop trackpad, Surface in laptop mode). False for phones and tablets
// without a paired pointer. Touch browsers synthesize mouseover/mouseout
// from gestures unreliably — sometimes from the finger position, sometimes
// from where the gesture started, sometimes nowhere — and gating the
// layer hover handlers on this flag eliminates the resulting phantom
// highlights. Click is unaffected and keeps working on every device.
//
// Evaluated once at module load. The page is dynamically imported with
// ssr: false (see app/page.tsx) so window is always defined here, but
// the typeof guard is kept as cheap insurance. We don't listen for
// (hover: hover) changes — switching primary input mid-session
// (plugging in a Bluetooth mouse, removing a tablet from a keyboard
// dock) is rare enough that a page reload is acceptable.
const supportsHover =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover)').matches;

// ─── Debug instrumentation ──────────────────────────────────────────────
//
// Activated by appending `?debug=1` to the URL. When active, every dbg()
// call writes to console.log AND appends to a ring buffer that's
// rendered as a fixed-position overlay on the page (see DebugOverlay
// component in the return JSX). This lets us read instrumented state
// directly on a phone screen, where Safari's console isn't easily
// accessible without USB debugging.
//
// The overlay is invisible when DEBUG is false — zero overhead in
// production. The dbg() function itself is also a no-op when DEBUG is
// false, so there's no string-formatting cost on the production path.
//
// Diagnostic events captured:
//   - Bundle loads (mount-time ADM0, per-parent ADM1)
//   - Per-polygon fetch start/success/failure
//   - contiguousGeomByCodeRef set/delete (full-precision in-heap)
//   - cachedBordersByKeyRef set/delete (parsed Leaflet border layers)
//   - Periodic state snapshots (counts of in-heap entries, totals)
//   - pagehide event (fires when iOS Safari is about to suspend or
//     terminate the page; useful for catching the moment of soft-
//     reload)
//   - Uncaught errors and unhandled promise rejections
const DEBUG =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('debug') === '1';

const DEBUG_BUFFER_MAX = 80;
const debugLog: string[] = [];
const debugListeners = new Set<() => void>();

const dbg = (line: string): void => {
  if (!DEBUG) return;
  const stamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const formatted = `${stamp} ${line}`;
  console.log(`[dbg] ${formatted}`);
  debugLog.push(formatted);
  if (debugLog.length > DEBUG_BUFFER_MAX) {
    debugLog.splice(0, debugLog.length - DEBUG_BUFFER_MAX);
  }
  for (const fn of debugListeners) fn();
};

if (DEBUG && typeof window !== 'undefined') {
  // Capture iOS Safari's "tab is going away" signals. pagehide is the
  // closest thing to a kill-warning Safari gives us.
  window.addEventListener('pagehide', (e) => {
    dbg(`PAGEHIDE persisted=${e.persisted}`);
  });
  window.addEventListener('error', (e) => {
    dbg(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg =
      reason && typeof reason === 'object' && 'message' in reason
        ? (reason as { message: string }).message
        : String(reason);
    dbg(`UNHANDLED REJECTION: ${msg}`);
  });
}

// Debug overlay: subscribes to debugListeners to re-render on each new
// dbg() line. Renders a fixed-position translucent panel showing the
// most recent debug-buffer entries. Only mounted when DEBUG is true.
//
// Top-right corner so it doesn't overlap the breadcrumb (top-left).
// Capped height with internal scrolling, but rendered "newest at
// bottom" with a flex column-reverse so the latest line is always
// visible without scrolling.
const DebugOverlay = () => {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const fn = () => forceUpdate((n) => n + 1);
    debugListeners.add(fn);
    return () => {
      debugListeners.delete(fn);
    };
  }, []);

  if (!DEBUG) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        right: 8,
        zIndex: 2000,
        width: 'min(420px, 50vw)',
        maxHeight: '60vh',
        overflowY: 'auto',
        background: 'rgba(0, 0, 0, 0.78)',
        color: '#9fe89f',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
        lineHeight: 1.35,
        padding: '6px 8px',
        borderRadius: 4,
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {debugLog.slice(-DEBUG_BUFFER_MAX).join('\n')}
    </div>
  );
};

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const treeIndexRef = useRef<TreeIndex | null>(null);

  // ─── Per-polygon static data (one entry per code, written once at fetch) ───
  //
  // boundsByCodeRef:
  //   The polygon's wrapped bounds, computed via the largest-gap algorithm.
  //   For non-crossers this is the standard [min, max]; for crossers (USA,
  //   Russia, Fiji, Alaska) east > 180, packaging the full extent into a
  //   single contiguous interval. Read by placeForView at render time and
  //   by tryZoom for fitBounds.
  //
  // contiguousGeomByCodeRef:
  //   The polygon shifted into [polyMin, polyMax] = a single contiguous
  //   representation. For non-crossers this is identity; for crossers, the
  //   antimeridian-side vertices get +360'd into the range, eliminating
  //   the ±180° discontinuity. This is the canonical render-source for
  //   the visible green border layer; translate by an offset (multiple of
  //   360) to place at any viewport position.
  //
  // contiguousSimpleGeomByCodeRef:
  //   Same shape as contiguousGeomByCodeRef but Douglas-Peucker simplified
  //   at HOVER_SIMPLIFY_TOLERANCE_DEG. Used by the invisible hit-target
  //   layer where sub-pixel boundary deviation is imperceptible and the
  //   reduced vertex count substantially speeds up point-in-polygon.
  const boundsByCodeRef = useRef<Map<string, L.LatLngBounds>>(new Map());
  const contiguousGeomByCodeRef = useRef<Map<string, GeoJSON.Geometry>>(
    new Map(),
  );
  const contiguousSimpleGeomByCodeRef = useRef<
    Map<string, GeoJSON.Geometry>
  >(new Map());

  // In-flight fetch promises by code, to dedupe concurrent loads.
  const inflightByCodeRef = useRef<Map<string, Promise<void>>>(new Map());

  // Codes that should be rendered with their bbox as the hit-target
  // and border geometry instead of their natural shape — see the
  // Maldives-problem doc block above the geometry helpers.
  // Populated at mount from /data/bbox-hit-targets.json, after which
  // it's read-only. ADM0 hydration consults it as a gate; ADM1
  // hydration consults the same ref for the same purpose. If the
  // file fails to load (404 / network error / malformed) the ref
  // stays empty, every node gets normal hit-targets, and the only
  // user-visible regression is that the "Maldives problem"
  // countries become hard to click. Logged but not fatal.
  const bboxHitTargetCodesRef = useRef<Set<string>>(new Set());

  // In-flight per-parent ADM1 bundle fetches, keyed by parent code (the
  // ADM0 code, e.g. '840' for USA). One bundle per subdivided country
  // hydrates all of that country's ADM1 children in a single fetch,
  // eliminating the per-child fetch storm that would otherwise fire on
  // drill-in (51 fetches for USA, 33 for China, etc.) — that storm was
  // the iPhone-killer for heavy countries. Deduplicates concurrent
  // requests for the same parent; entries are cleared on settle. The
  // ADM0 bundle is loaded once at mount in the data-load useEffect, so
  // parent code '000' (the World) never appears here.
  const inflightBundleByParentRef = useRef<Map<string, Promise<void>>>(
    new Map(),
  );

  // ─── Render-time Leaflet layers, keyed by (code, offset) ───
  //
  // cachedTargetsByKeyRef / cachedBordersByKeyRef:
  //   Build cache. Once a layer is parsed by Leaflet at a given offset
  //   it stays here forever — re-attach is cheap, re-parse is not. Key
  //   is `${code}@${offset}` (see layerKey). A given polygon typically
  //   has 1–3 distinct offsets used over a session.
  //
  //   cachedBordersByKeyRef holds full-precision border layers (drawn
  //   from contiguousGeomByCodeRef). cachedSimpleBordersByKeyRef holds
  //   simplified-precision border layers drawn from the in-heap bundle
  //   (contiguousSimpleGeomByCodeRef) — these are the "stage 1"
  //   immediate-draw fallback used while full precision fetches in the
  //   background. See reconcileBordersForCode for the two-stage policy.
  //
  // attachedTargetsByCodeRef / attachedBordersByCodeRef:
  //   What's currently on the map. Outer key: code. Inner: offset → layer
  //   instance (same instance as the one in the corresponding cache).
  //   For borders, the attached instance at any offset can be either the
  //   simple-precision or the full-precision layer; reconcile compares
  //   by identity to decide whether an upgrade is needed.
  //   Maintained by the reconcile* helpers below.
  const cachedTargetsByKeyRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const cachedBordersByKeyRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const cachedSimpleBordersByKeyRef = useRef<Map<string, L.GeoJSON>>(
    new Map(),
  );
  const attachedTargetsByCodeRef = useRef<
    Map<string, Map<number, L.GeoJSON>>
  >(new Map());
  const attachedBordersByCodeRef = useRef<
    Map<string, Map<number, L.GeoJSON>>
  >(new Map());

  // Path: array of codes from World down to current selection.
  const [path, setPath] = useState<string[]>(['000']);
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);

  const pathRef = useRef(path);
  const hoveredCodeRef = useRef(hoveredCode);
  // Tracks whether a fly-to-country animation is currently in progress.
  // Set synchronously in the path useEffect when a country fly is about
  // to start; cleared in onViewSettled (moveend handler) once the
  // animation completes. Used by the border useEffect to defer
  // attachment of the deepest path code's border until after the zoom
  // finishes. Otherwise iOS Safari briefly renders the border at the
  // wrong y-position when an SVG path with tens of thousands of
  // vertices (USA, Canada, Russia at HPSCU resolution) is added to the
  // map mid-flyToBounds animation.
  const isFlyingRef = useRef(false);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    hoveredCodeRef.current = hoveredCode;
  }, [hoveredCode]);

  // Map initialization.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;

    const computeMinZoom = (width: number, height: number) =>
      Math.log2(Math.max(width, height) / 512) + 1;

    const initialMinZoom = computeMinZoom(
      container.offsetWidth,
      container.offsetHeight,
    );

    const map = L.map(container, {
      center: [20, 0],
      zoom: Math.max(2, initialMinZoom),
      minZoom: initialMinZoom,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0,
      wheelPxPerZoomLevel: 120,
      scrollWheelZoom: false,
      crs: customCRS,
    });

    L.tileLayer('https://tiles.supercoolradio.com/tiles/{z}/{x}/{y}.webp', {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 0,
      maxNativeZoom: 8,
      maxZoom: 18,
      noWrap: false,
      className: 'scr-tiles',
    }).addTo(map);

    const NORTH_LIMIT = 85.051;
    const SOUTH_LIMIT = -85.051;
    let adjusting = false;

    const enforceConstraints = () => {
      if (adjusting) return;
      // Don't enforce constraints during a fly. flyToBounds emits
      // many 'move' events during the animation; at intermediate
      // frames the viewport can briefly overshoot the polar latitude
      // limits, which would otherwise trigger map.panBy() to correct
      // it. panBy fires 'moveend' even with animate:false — and that
      // moveend fires onViewSettled mid-fly, prematurely clearing
      // isFlyingRef and re-attaching borders during the still-running
      // zoom animation (the ghost-border bug). The fly's start and
      // end are both valid viewports, so skipping correction during
      // the animation is safe; if the camera ever did land out of
      // bounds, the next user pan/zoom would correct it.
      if (isFlyingRef.current) return;
      const northPixelY = map.latLngToContainerPoint([NORTH_LIMIT, 0]).y;
      const southPixelY = map.latLngToContainerPoint([SOUTH_LIMIT, 0]).y;
      const viewportHeight = container.offsetHeight;
      if (northPixelY > 0.5) {
        adjusting = true;
        map.panBy([0, northPixelY], { animate: false });
        adjusting = false;
      } else if (southPixelY < viewportHeight - 0.5) {
        adjusting = true;
        map.panBy([0, southPixelY - viewportHeight], { animate: false });
        adjusting = false;
      }
    };

    const updateBackground = () => {
      const northPixelY = map.latLngToContainerPoint([NORTH_LIMIT, 0]).y;
      const southPixelY = map.latLngToContainerPoint([SOUTH_LIMIT, 0]).y;
      const splitPixelY = northPixelY + 0.75 * (southPixelY - northPixelY);
      const viewportHeight = container.offsetHeight;
      const percent = Math.max(
        0,
        Math.min(100, (splitPixelY / viewportHeight) * 100),
      );
      document.body.style.background = `linear-gradient(
        to bottom,
        #071738 0%,
        #071738 ${percent}%,
        #eff2f1 ${percent}%,
        #eff2f1 100%
      )`;
    };

    const onMapChange = () => {
      enforceConstraints();
      updateBackground();
    };

    map.on('move', onMapChange);
    map.on('zoom', onMapChange);
    map.on('moveend', onMapChange);
    map.on('zoomend', onMapChange);
    onMapChange();

    // ─── View-settled handler: reconcile per-(code, offset) layers ───
    //
    // Phase C (after a fly completes) and "non-fly view settle"
    // (manual pan, programmatic setView, etc.) are handled here.
    //
    // For non-fly: reconcile attached layer offsets immediately.
    //
    // For fly completion: defer all DOM work via rAF×2 + setTimeout
    // 150ms to give Leaflet's animation system time to fully settle
    // before we touch the DOM. Then clear the flying flag, remove
    // the scr-flying class (re-enabling cursor and pointer events),
    // and re-attach all path[1..] borders that Phase A had detached.
    //
    // We listen on moveend AND zoomend because a zoom-with-pan-component
    // can fire only one or the other depending on Leaflet internals;
    // both paths (rAF chains) eventually run, but their work is
    // idempotent (reconcile* functions check what's already attached).
    const onViewSettled = () => {
      if (!mapRef.current) return;

      // Non-fly view settle: handle immediately.
      if (!isFlyingRef.current) {
        const [vL, vR] = getViewportLngRange(mapRef.current);
        for (const code of attachedTargetsByCodeRef.current.keys()) {
          reconcileTargetsForCode(code, vL, vR);
        }
        for (const code of attachedBordersByCodeRef.current.keys()) {
          reconcileBordersForCode(code, vL, vR);
        }
        return;
      }

      // Fly just completed. Defer DOM work to ensure Leaflet's
      // animation system is fully done. rAF×2 puts us past the next
      // paint cycle; setTimeout adds a margin past any lingering
      // internal cleanup. ~150ms before the reconciliation finishes.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (!mapRef.current) return;

            // Clear fly state. Cursor and pointer events restored.
            isFlyingRef.current = false;
            setFlyingInactive(containerRef.current);

            // Reconcile target offsets at the new viewport. Targets
            // are kept attached during the fly (they're invisible);
            // their offsets may need updating after the camera move.
            const [vL, vR] = getViewportLngRange(mapRef.current);
            for (const code of attachedTargetsByCodeRef.current.keys()) {
              reconcileTargetsForCode(code, vL, vR);
            }

            // Full border reconciliation against the new desired set.
            // Phase A no longer detached borders, so attached can
            // include any combination of: previous-path codes,
            // previous hover, plus any borders attached before that.
            // Compute the desired set (path[1..] + current hover) and
            // bring attached into agreement: detach what's not wanted,
            // attach what is.
            const currentPath = pathRef.current;
            const currentHover = hoveredCodeRef.current;
            const desired = new Set<string>();
            for (let i = 1; i < currentPath.length; i++) {
              desired.add(currentPath[i]);
            }
            if (
              currentHover &&
              currentHover !== '000' &&
              !currentPath.includes(currentHover)
            ) {
              desired.add(currentHover);
            }

            // Detach codes not in desired.
            for (const code of [...attachedBordersByCodeRef.current.keys()]) {
              if (!desired.has(code)) {
                detachAllBordersForCode(code);
              }
            }

            // Attach codes in desired using the two-stage policy. For
            // each code, reconcile immediately (which attaches the
            // simplified stand-in if full precision isn't loaded), then
            // fire fetchGeometry in the background and re-reconcile on
            // success to swap simple → full atomically. See the border
            // useEffect below for the rationale.
            for (const code of desired) {
              reconcileBordersForCode(code, vL, vR);
              if (contiguousGeomByCodeRef.current.has(code)) continue;
              fetchGeometry(code)
                .then(() => {
                  if (!mapRef.current) return;
                  const latestPath = pathRef.current;
                  const latestHover = hoveredCodeRef.current;
                  const stillDesired =
                    latestPath.includes(code) || latestHover === code;
                  if (!stillDesired) return;
                  const [vL2, vR2] = getViewportLngRange(mapRef.current);
                  reconcileBordersForCode(code, vL2, vR2);
                })
                .catch(() => {
                  // Simplified border already attached; non-upgrade is
                  // invisible to the user.
                });
            }
          }, 150);
        });
      });
    };
    map.on('moveend', onViewSettled);
    map.on('zoomend', onViewSettled);

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY > 0 ? -0.5 : 0.5;
        const point = map.mouseEventToContainerPoint(e);
        const latlng = map.containerPointToLatLng(point);
        map.setZoomAround(latlng, map.getZoom() + delta);
      } else {
        map.panBy([0, e.deltaY], { animate: false });
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: false });

    const handleResize = () => {
      // Refresh Leaflet's cached container size before any further
      // computation. Without this, after device rotation Leaflet
      // keeps using the pre-rotation dimensions and subsequent
      // flyTo / click positioning is offset by the dimension delta
      // — visible on iPhone as a consistent shift after rotating
      // until the page is reloaded. Also covers iOS Safari URL-bar
      // show/hide resizes for free. pan: false avoids unwanted
      // recentering during the resize itself.
      map.invalidateSize({ pan: false });
      const newMinZoom = computeMinZoom(
        container.offsetWidth,
        container.offsetHeight,
      );
      map.setMinZoom(newMinZoom);
      if (map.getZoom() < newMinZoom) map.setZoom(newMinZoom);
      onMapChange();
    };
    window.addEventListener('resize', handleResize);

    // Map-level click handler — fires when a click reaches the map
    // itself rather than a polygon hit-target (which calls
    // L.DomEvent.stopPropagation in its own click handler). In practice
    // this means: clicks on ocean, or on a path node whose hit-target
    // has been detached because it's the current deepest selection.
    //
    // Desktop behavior (preserved): pop one path level, or — at World —
    // return a fresh ['000'] reference to re-fire the max-expand setView
    // (recentering and zooming all the way out).
    //
    // Mobile behavior (NEW, 2026-04-29): do nothing. Without a hover
    // preview, the only way to discover whether a country has Regions
    // is to tap it and see what happens. If the user is just shy of the
    // country's edge and lands in ocean, popping a level — or worse,
    // re-centering to the default world view at zoom-min — is a punishing
    // accidental gesture. Mobile users navigate up via the breadcrumb
    // instead. ESC isn't on phones, so we don't lose anything by not
    // having an "ocean = back" gesture there.
    if (supportsHover) {
      map.on('click', () => {
        setPath((current) => {
          if (current.length > 1) return current.slice(0, -1);
          // Already at World. Return a NEW ['000'] reference so React
          // re-runs the path useEffect, which fires the max-expand setView.
          // (Returning `current` would short-circuit the state update.)
          return ['000'];
        });
      });
    }

    mapRef.current = map;

    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('wheel', handleWheel);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // CSS injection.
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .scr-target {
        pointer-events: all;
        cursor: pointer;
      }
      .scr-border {
        pointer-events: none;
      }
      .scr-target:focus, .scr-border:focus {
        outline: none;
      }
      /* While a fly-to animation is in progress, hide the cursor
         entirely and disable pointer events on country layers.

         The .scr-flying class is added to BOTH document.body and the
         map container at fly start. The selectors below match either
         placement, so the rules apply regardless of where in the DOM
         the class lands. Body-level placement is the load-bearing one
         — it lets the universal selector reach every element in the
         page, including SVG paths nested deep inside Leaflet's own
         markup, without specificity wars.

         CSS cursor on a parent does NOT override an explicit cursor
         on a child element under the pointer. .scr-target sets cursor:
         pointer directly on each country path. The universal-selector
         rule (".scr-flying *" and "body.scr-flying *") applies cursor:
         none directly to every descendant, with !important to beat
         the .scr-target rule's own pointer cursor. */
      body.scr-flying,
      body.scr-flying *,
      .scr-flying,
      .scr-flying * {
        cursor: none !important;
      }
      body.scr-flying .scr-target,
      body.scr-flying .leaflet-interactive,
      .scr-flying .scr-target,
      .scr-flying .leaflet-interactive {
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(styleEl);
    return () => {
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    };
  }, []);

  // ESC pops one level off the path. At the World level, ESC re-fires
  // the max-expand by returning a new ['000'] array reference.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPath((current) => {
        if (current.length > 1) return current.slice(0, -1);
        return ['000'];
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mount-time data load: fetch tree.json AND the ADM0 hit-target
  // bundle (adm0-tN.json) in parallel. The tree gives us the navigation
  // structure (codes, parent/child relationships); the bundle gives us
  // bounds + simplified geometry for all ADM0 countries (hit-targets
  // without a per-country network round trip). Both must arrive before
  // we can render the initial World view. After both land, we trigger
  // ensureTargetsForPath for World, which now finds simple geom already
  // in cache for every ADM0 child and builds hit-targets synchronously
  // with no fetching.
  //
  // Architectural note: full-resolution ADM0 geometry is NOT loaded
  // here. It's fetched per-country, on demand, when the user navigates
  // into a country and we need to draw the green border. See
  // fetchGeometry below — it's been made idempotent on the bundle-
  // populated refs so a subsequent fetch only does the work that wasn't
  // already done.
  //
  // ADM1 hit-targets follow the same pattern at one level deeper: when
  // the user drills into a subdivided country, we fetch a per-parent
  // ADM1 bundle (one HTTP round trip, all of that country's regions
  // hydrated at once) — see ensureChildrenBundle. Borders for any ADM1
  // region are still per-polygon full-precision.
  useEffect(() => {
    let stillMounted = true;

    const treeP = fetch('/data/tree.json')
      .then((res) => {
        if (!res.ok) throw new Error(`tree.json HTTP ${res.status}`);
        return res.json();
      });

    // Fire in parallel with tree + bundle. If it fails, log and
    // proceed with an empty set — see comment on bboxHitTargetCodesRef.
    const bboxHitTargetsP = fetch('/data/bbox-hit-targets.json')
      .then((res) => {
        if (!res.ok) throw new Error(`bbox-hit-targets.json HTTP ${res.status}`);
        return res.json() as Promise<{ codes: string[] }>;
      })
      .catch((err) => {
        console.warn(
          '[SCR] bbox-hit-targets.json failed to load — Maldives-problem nodes will fall back to natural hit-targets:',
          err,
        );
        return { codes: [] as string[] };
      });

    const bundleP = fetch(ADM0_BUNDLE_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`adm0-t${ADM0_TIER}.json HTTP ${res.status}`);
        }
        return res.json();
      });

    Promise.all([treeP, bundleP, bboxHitTargetsP])
      .then(([tree, bundle, bboxData]: [
        TreeNode,
        SimplifiedBundle,
        { codes: string[] },
      ]) => {
        if (!stillMounted) return;

        // Populate the ref BEFORE hydrating any bundle, since both
        // hydration loops (ADM0 here, ADM1 in fetchAdm1Bundle) gate
        // their bbox-substitution on this set.
        bboxHitTargetCodesRef.current = new Set(bboxData.codes);
        console.log(
          `[SCR] bbox-hit-targets.json loaded — ${bboxHitTargetCodesRef.current.size} codes`,
        );

        // Index the tree.
        const idx = indexTree(tree);
        treeIndexRef.current = idx;
        const counts: Record<string, number> = {};
        for (const node of idx.codeToNode.values()) {
          counts[node.level] = (counts[node.level] || 0) + 1;
        }
        console.log('[SCR] tree.json loaded — node counts by level:', counts);

        // Hydrate refs from the bundle. After this loop, every ADM0
        // code has bounds + simplified contiguous geometry available
        // synchronously. contiguousGeomByCodeRef stays untouched; full
        // geometry is fetched lazily.
        //
        // Exception: codes in bboxHitTargetCodesRef get their natural
        // geometry replaced with a bbox polygon, and also have
        // contiguousGeomByCodeRef pre-populated so the lazy T6 fetch
        // never fires for them.
        let hydratedCount = 0;
        for (const [code, entry] of Object.entries(bundle)) {
          const b = entry.bounds;
          boundsByCodeRef.current.set(
            code,
            L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]),
          );
          let geom: GeoJSON.Geometry = entry.geom;
          if (bboxHitTargetCodesRef.current.has(code)) {
            geom = bboxToPolygon(b);
            contiguousGeomByCodeRef.current.set(code, geom);
          }
          contiguousSimpleGeomByCodeRef.current.set(code, geom);
          hydratedCount++;
        }
        console.log(
          `[SCR] adm0-t${ADM0_TIER}.json loaded — ${hydratedCount} ADM0 entries hydrated`,
        );
        if (DEBUG) {
          let simpleVerts = 0;
          for (const g of contiguousSimpleGeomByCodeRef.current.values()) {
            simpleVerts += countCoords(g);
          }
          dbg(
            `BUNDLE adm0-t${ADM0_TIER} +${hydratedCount} | simple-cache: ${contiguousSimpleGeomByCodeRef.current.size} codes ${simpleVerts.toLocaleString()}v`,
          );
        }

        // PERMANENT: dark-green outline around Vatican City (ISO 336)
        // at all zooms so users can locate it. Vatican is extremely
        // small (~40 verts at T3, smaller than one screen pixel at
        // world zoom and barely a few pixels even at country-zoom on
        // Italy), and Italy's ADM0 polygon does not carve a hole for
        // the Vatican enclave — so the normal green border alone is
        // unfindable against Italy's overlapping border at any zoom.
        // Dark green (#006400) reads clearly against NASA Blue Marble
        // tiles without being eye-grabbing. No fill, non-interactive,
        // never removed.
        const vaticanEntry = bundle['336'];
        if (vaticanEntry && mapRef.current) {
          L.geoJSON(featureCollectionOf(vaticanEntry.geom), {
            style: {
              color: '#006400',
              weight: 2,
              fillOpacity: 0,
            },
            interactive: false,
          }).addTo(mapRef.current);
        }

        // Trigger first render: build World's children (Areas) as
        // targets. With the bundle in place, this completes
        // synchronously with zero fetches.
        if (mapRef.current) {
          ensureTargetsForPath(['000']);
        }
      })
      .catch((err) => {
        if (!stillMounted) return;
        console.error('[SCR] mount-time data load failed:', err);
      });

    return () => {
      stillMounted = false;
    };
  }, []);

  // Fetch the GeoJSON for a code, derive and cache its static
  // representations: bounds, contiguous-form geometry, simplified
  // contiguous-form geometry. Returns a promise that resolves when those
  // caches are populated (or rejects on failure). Subsequent calls for
  // the same code are deduped via inflightByCodeRef and short-circuit
  // once the geometry is cached.
  const fetchGeometry = (code: string): Promise<void> => {
    if (contiguousGeomByCodeRef.current.has(code)) return Promise.resolve();
    const inflight = inflightByCodeRef.current.get(code);
    if (inflight) return inflight;

    // Build the URL for this code in the per-polygon T6 corpus.
    // Directory structure mirrors the source-of-truth tree exactly,
    // but the filename includes a tier suffix:
    //   '840'         -> '840/840-tN.geojson'
    //   '840-006'     -> '840/840-006/840-006-tN.geojson'
    //   '156-006-003' -> '156/156-006/156-006-003/156-006-003-tN.geojson'
    // N is the BORDER_TIER constant (currently 6 — see top of file
    // for the rationale on why T6 is the chosen ceiling).
    const parts = code.split('-');
    const dirParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      dirParts.push(parts.slice(0, i + 1).join('-'));
    }
    const url = versioned(
      `${BORDERS_BASE}/${dirParts.join('/')}/${code}-t${BORDER_TIER}.geojson`,
    );
    if (DEBUG) dbg(`FETCH→ ${code}`);

    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((geojson: GeoJSON.GeoJSON) => {
        const origGeom = extractGeometry(geojson);
        if (!origGeom) throw new Error('no geometry');

        // Compute and cache bounds — but skip if already populated.
        // Codes hydrated from a tiered bundle (ADM0 at mount, ADM1 on
        // drill-in) already have bounds in the ref. Re-computing would
        // produce the same value (same source data) at the cost of
        // sorting all coords (Russia: ~100k coords sorted = 30-50ms
        // wasted main-thread time per country). Skip is safe because
        // the bundle's bounds come from the same computeWrappedBounds
        // algorithm running on the same source GeoJSON.
        let bounds: L.LatLngBounds;
        if (boundsByCodeRef.current.has(code)) {
          bounds = boundsByCodeRef.current.get(code)!;
        } else {
          bounds = computeWrappedBounds(origGeom);
          boundsByCodeRef.current.set(code, bounds);
        }
        const polyMin = bounds.getWest();
        const polyMax = bounds.getEast();

        // Shift every vertex into [polyMin, polyMin + 360). Because the
        // bounds invariant holds, every vertex lands in [polyMin,
        // polyMax]. For non-crossers this is identity (vertices were
        // already in range); for crossers the antimeridian-side
        // vertices get +360'd, eliminating the ±180° jump and leaving
        // a polygon whose natural drawing path no longer crosses
        // anywhere. This is the canonical render-source form — at
        // render time we translate it by some offset (multiple of 360,
        // chosen by placeForView) to position it correctly in the
        // current viewport.
        const contiguousGeom = shiftGeometryLngs(origGeom, polyMin);
        contiguousGeomByCodeRef.current.set(code, contiguousGeom);
        if (DEBUG) {
          const verts = countCoords(contiguousGeom);
          const totalCodes = contiguousGeomByCodeRef.current.size;
          let totalVerts = 0;
          for (const g of contiguousGeomByCodeRef.current.values()) {
            totalVerts += countCoords(g);
          }
          dbg(
            `FULL+ ${code} ${verts.toLocaleString()}v | full-cache: ${totalCodes} codes ${totalVerts.toLocaleString()}v`,
          );
        }

        // Simplify the contiguous form for the invisible hit-target
        // layer — but skip if already populated. Codes hydrated from a
        // tiered bundle (ADM0 at T3 from mount, ADM1 at T6 from drill-
        // in) already have a simplified form in cache, simplified at
        // each tier's tolerance which was chosen to be sub-pixel for
        // hit-test purposes at the relevant zoom range. The only path
        // that reaches this branch is the rare defensive case where
        // fetchGeometry is called for a code that no bundle covered
        // (e.g. ADM2 codes if Sub-Regions return before their bundle
        // pipeline ships).
        //
        // Note: we simplify AFTER the shift, not before. Simplifying the
        // unshifted geometry of a crosser would feed Douglas-Peucker a
        // shape with a giant apparent jump across ±180° (USA's Aleutians
        // at +172° "jumping" to mainland at -67°, etc.) — an artifact of
        // the coordinate representation rather than the real shape.
        // Simplifying after the shift gives DP the natural contiguous
        // shape, which is what we actually want a faithful low-resolution
        // version of.
        if (!contiguousSimpleGeomByCodeRef.current.has(code)) {
          const t0 =
            typeof performance !== 'undefined' ? performance.now() : 0;
          const before = countCoords(contiguousGeom);
          const simpleGeom = simplifyGeometry(
            contiguousGeom,
            HOVER_SIMPLIFY_TOLERANCE_DEG,
          );
          const after = countCoords(simpleGeom);
          contiguousSimpleGeomByCodeRef.current.set(code, simpleGeom);

          if (before >= 1000) {
            const ms =
              typeof performance !== 'undefined'
                ? (performance.now() - t0).toFixed(1)
                : '?';
            const pct = ((1 - after / before) * 100).toFixed(1);
            console.log(
              `[SCR] simplified ${code}: ${before} → ${after} verts (${pct}% reduction, ${ms}ms)`,
            );
          }
        }

        // Diagnostic: log antimeridian crossers as we encounter them so
        // we can verify the corpus matches expectations. After this
        // refactor crossers and non-crossers go through identical
        // handling — this log carries no semantic weight beyond
        // observability. Span <= 200° guard distinguishes "crossers
        // proper" (USA, Russia, Fiji, Alaska) from polygons that wrap
        // most of the globe (Antarctica), where the bounds also have
        // east > 180 but for a different reason.
        if (polyMax > 180 && polyMax - polyMin <= 200) {
          console.log(
            `[SCR] antimeridian crosser: ${code} (bounds ${polyMin.toFixed(1)} to ${polyMax.toFixed(1)})`,
          );
        }
      })
      .catch((err) => {
        console.error(`[SCR] fetch failed ${code}:`, err.message ?? err);
        throw err;
      })
      .finally(() => {
        inflightByCodeRef.current.delete(code);
      });
    inflightByCodeRef.current.set(code, promise);
    return promise;
  };

  // Ensure all of `parentCode`'s children have their bounds + simplified
  // geometry hydrated. For an ADM0 parent ('840', '156', etc.), this
  // means fetching the per-parent ADM1 bundle from R2, parsing it, and
  // populating boundsByCodeRef + contiguousSimpleGeomByCodeRef for every
  // entry. Idempotent and dedup'd: a second call while a fetch is in
  // flight returns the same promise; a call after the bundle has
  // already hydrated returns a resolved promise.
  //
  // The ADM0 bundle is loaded once at mount in the data-load useEffect,
  // so this function returns immediately for parentCode === '000' (the
  // World, whose children are the ADM0 codes).
  //
  // For unsubdivided countries (Algeria, Argentina, etc.) the desired
  // set won't include any of their children — they have none — so this
  // function is never called with their codes as parent. No bundle
  // exists on R2 for them and no fetch is attempted.
  //
  // Failure modes: if the bundle fetch fails (network error, HTTP
  // error, parse error), the error is logged and the promise rejects.
  // The user-visible consequence is that the affected children won't
  // have hit-targets — non-catastrophic, the user can ESC back out and
  // the rest of the map keeps working. The next attempt will retry.
  const ensureChildrenBundle = (parentCode: string): Promise<void> => {
    // World's children (the 232 ADM0 codes) are loaded at mount.
    if (parentCode === '000') return Promise.resolve();

    // Already in flight or completed.
    const inflight = inflightBundleByParentRef.current.get(parentCode);
    if (inflight) return inflight;

    // Fast-path: if every child of this parent is already hydrated, no
    // fetch needed. Catches the case where this function is called
    // again after a previous successful fetch (we don't aggressively
    // evict cache entries on path pop).
    const idx = treeIndexRef.current;
    const node = idx?.codeToNode.get(parentCode);
    const children = node?.children ?? [];
    if (
      children.length > 0 &&
      children.every((c) =>
        contiguousSimpleGeomByCodeRef.current.has(c.code),
      )
    ) {
      return Promise.resolve();
    }

    const url = adm1BundleUrl(parentCode);
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((bundle: SimplifiedBundle) => {
        let hydratedCount = 0;
        for (const [code, entry] of Object.entries(bundle)) {
          const b = entry.bounds;
          boundsByCodeRef.current.set(
            code,
            L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]),
          );
          // Apply the same Maldives-problem special case as ADM0:
          // if this ADM1 code is in the bbox-hit-target set, swap
          // its geom for the bbox and pre-populate the full-precision
          // cache so the lazy T6 fetch short-circuits.
          let geom: GeoJSON.Geometry = entry.geom;
          if (bboxHitTargetCodesRef.current.has(code)) {
            geom = bboxToPolygon(b);
            contiguousGeomByCodeRef.current.set(code, geom);
          }
          contiguousSimpleGeomByCodeRef.current.set(code, geom);
          hydratedCount++;
        }
        console.log(
          `[SCR] adm1/${parentCode}-t${ADM1_TIER}.json loaded — ${hydratedCount} entries hydrated`,
        );
        if (DEBUG) {
          let simpleVerts = 0;
          for (const g of contiguousSimpleGeomByCodeRef.current.values()) {
            simpleVerts += countCoords(g);
          }
          dbg(
            `BUNDLE adm1/${parentCode}-t${ADM1_TIER} +${hydratedCount} | simple-cache: ${contiguousSimpleGeomByCodeRef.current.size} codes ${simpleVerts.toLocaleString()}v`,
          );
        }
      })
      .catch((err) => {
        console.error(
          `[SCR] adm1/${parentCode}-t${ADM1_TIER}.json fetch failed:`,
          err.message ?? err,
        );
        throw err;
      })
      .finally(() => {
        inflightBundleByParentRef.current.delete(parentCode);
      });
    inflightBundleByParentRef.current.set(parentCode, promise);
    return promise;
  };

  // ─── Layer builders, parametrized by viewport offset ──────────────────
  //
  // Each (code, offset) pair gets its own L.GeoJSON instance. Offset is
  // applied as an additive longitude shift to the contiguous-form
  // geometry before parsing. A code typically has 1–3 distinct offsets
  // used over a session — they're built lazily on first need and cached
  // in cachedTargetsByKeyRef / cachedBordersByKeyRef forever after.

  const buildTargetLayerAt = (code: string, offset: number): L.GeoJSON | null => {
    const baseGeom =
      contiguousSimpleGeomByCodeRef.current.get(code) ??
      contiguousGeomByCodeRef.current.get(code);
    if (!baseGeom) return null;
    const geom = translateGeometryLng(baseGeom, offset);
    const layer = L.geoJSON(featureCollectionOf(geom), {
      style: {
        fillColor: 'black',
        fillOpacity: 0,
        color: 'black',
        weight: 0,
        className: 'scr-target',
      },
    });
    // Hover handlers (NEW, 2026-04-29): only on devices whose primary
    // input is capable of true hover — desktops, laptops, Surface in
    // laptop mode. The check is the module-scope `supportsHover`
    // (matchMedia '(hover: hover)'), evaluated once at load.
    //
    // Why we gate this: mobile browsers synthesize mouseover/mouseout
    // events from touch gestures, but the position they're synthesized
    // at is unreliable — sometimes the finger position, sometimes
    // gesture-start, sometimes nowhere predictable. The result on
    // SuperCoolRadio was phantom highlights: users would see a country
    // light up that they hadn't aimed at and weren't touching (Hugh
    // verified: highlighted Australia from the bottom half of the
    // screen without ever touching the bottom half). Removing the
    // hover handlers on no-hover devices eliminates this entirely
    // and also kills a stream of pointless React re-renders during
    // pans (each spurious mouseover/mouseout triggers setHoveredCode
    // → border-rendering useEffect at the bottom of this component).
    //
    // Click is attached unconditionally below — touch-to-click
    // synthesis IS reliable (every browser produces a click at the
    // tap-up position, and Leaflet's Tap handler is well-tested), so
    // the click pathway works on every device with no special casing.
    if (supportsHover) {
      layer.on({
        mouseover: () => {
          // Suppress hover state changes during a fly. Leaflet
          // re-projects SVG paths each frame of a zoom animation;
          // those re-projections can synthesize mouseover/mouseout
          // events as paths move under a stationary cursor, which
          // would otherwise trigger setHoveredCode → re-render →
          // border useEffect, potentially attaching a border for
          // whichever country the cursor briefly intersects mid-fly.
          // The flag is cleared in onViewSettled when the fly ends.
          if (isFlyingRef.current) return;
          setHoveredCode(code);
        },
        mouseout: () => {
          if (isFlyingRef.current) return;
          setHoveredCode((current) => (current === code ? null : current));
        },
      });
    }
    layer.on({
      click: (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (DEBUG) dbg(`CLICK ${code}`);
        const idx = treeIndexRef.current;
        if (!idx) return;
        const ancestry = idx.codeToAncestry.get(code);
        if (!ancestry) return;
        setPath((current) => {
          if (current[current.length - 1] === code) return current;
          return ancestry;
        });
      },
    });
    return layer;
  };

  const buildBorderLayerAt = (code: string, offset: number): L.GeoJSON | null => {
    const baseGeom = contiguousGeomByCodeRef.current.get(code);
    if (!baseGeom) return null;
    // Color by administrative level — green for Areas (ADM0), yellow for
    // Regions (ADM1), cyan for Sub-Regions (ADM2). The node lookup
    // shouldn't fail in practice (codes only enter the desired set via
    // tree-driven flows) but we fall back to Area-green defensively.
    const node = treeIndexRef.current?.codeToNode.get(code);
    const color = node
      ? BORDER_COLOR_BY_LEVEL[node.level]
      : BORDER_COLOR_BY_LEVEL.Area;
    const geom = translateGeometryLng(baseGeom, offset);
    return L.geoJSON(featureCollectionOf(geom), {
      style: {
        fillOpacity: 0,
        color,
        weight: BORDER_WEIGHT,
        className: 'scr-border',
      },
      interactive: false,
    });
  };

  // Stage-1 border builder — reads from the in-heap simplified-geometry
  // cache (populated by the ADM0 mount-time bundle and per-parent ADM1
  // bundles). Identical styling to the full-precision builder above so
  // the visual swap from simple → full is invisible at typical zoom; the
  // only visible difference is on jagged-coastline outliers (Nunavut,
  // Norway, Indonesia) at deep zoom, where the simple form is briefly
  // visibly stair-stepped before the full version arrives and sharpens
  // it. See reconcileBordersForCode for the swap mechanics.
  //
  // For polygons in the desired set (path[1..] + hover), the simple
  // geometry is essentially always available — the same geometry that
  // makes the polygon clickable (via its hit-target) also serves as the
  // border stand-in. The function returns null only if simple geometry
  // is genuinely absent, which under current call sites should not
  // happen.
  const buildSimpleBorderLayerAt = (
    code: string,
    offset: number,
  ): L.GeoJSON | null => {
    const baseGeom = contiguousSimpleGeomByCodeRef.current.get(code);
    if (!baseGeom) return null;
    const node = treeIndexRef.current?.codeToNode.get(code);
    const color = node
      ? BORDER_COLOR_BY_LEVEL[node.level]
      : BORDER_COLOR_BY_LEVEL.Area;
    const geom = translateGeometryLng(baseGeom, offset);
    return L.geoJSON(featureCollectionOf(geom), {
      style: {
        fillOpacity: 0,
        color,
        weight: BORDER_WEIGHT,
        className: 'scr-border',
      },
      interactive: false,
    });
  };

  const getOrBuildTargetLayerAt = (
    code: string,
    offset: number,
  ): L.GeoJSON | null => {
    const key = layerKey(code, offset);
    const cached = cachedTargetsByKeyRef.current.get(key);
    if (cached) return cached;
    const fresh = buildTargetLayerAt(code, offset);
    if (!fresh) return null;
    cachedTargetsByKeyRef.current.set(key, fresh);
    return fresh;
  };

  const getOrBuildBorderLayerAt = (
    code: string,
    offset: number,
  ): L.GeoJSON | null => {
    const key = layerKey(code, offset);
    const cached = cachedBordersByKeyRef.current.get(key);
    if (cached) return cached;
    const fresh = buildBorderLayerAt(code, offset);
    if (!fresh) return null;
    cachedBordersByKeyRef.current.set(key, fresh);
    return fresh;
  };

  const getOrBuildSimpleBorderLayerAt = (
    code: string,
    offset: number,
  ): L.GeoJSON | null => {
    const key = layerKey(code, offset);
    const cached = cachedSimpleBordersByKeyRef.current.get(key);
    if (cached) return cached;
    const fresh = buildSimpleBorderLayerAt(code, offset);
    if (!fresh) return null;
    cachedSimpleBordersByKeyRef.current.set(key, fresh);
    return fresh;
  };

  // ─── Per-code reconciliation against the current viewport ─────────────
  //
  // Given a code that should be visible, ensure exactly the right set of
  // (code, offset) layers are attached to the map. Detaches any attached
  // offsets that are no longer in the desired set; attaches missing ones,
  // building (or reusing cached) layer instances as needed.
  //
  // Caller must have ensured boundsByCodeRef.has(code) — these helpers
  // short-circuit cleanly if not.

  const reconcileTargetsForCode = (
    code: string,
    viewLeft: number,
    viewRight: number,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = boundsByCodeRef.current.get(code);
    if (!bounds) return;

    let attached = attachedTargetsByCodeRef.current.get(code);
    if (!attached) {
      attached = new Map();
      attachedTargetsByCodeRef.current.set(code, attached);
    }

    const desiredOffsets = new Set(placeForView(bounds, viewLeft, viewRight));

    // Detach offsets not in desired.
    for (const [offset, layer] of [...attached]) {
      if (!desiredOffsets.has(offset)) {
        map.removeLayer(layer);
        attached.delete(offset);
      }
    }

    // Attach missing offsets.
    for (const offset of desiredOffsets) {
      if (attached.has(offset)) continue;
      const layer = getOrBuildTargetLayerAt(code, offset);
      if (!layer) continue;
      layer.addTo(map);
      attached.set(offset, layer);
    }

    // Re-stack every attached hit-target layer in descending bbox-area
    // order. SVG paint order = DOM order, last sibling on top; calling
    // bringToFront moves a path to the end of the parent SVG group, so
    // iterating largest-first and calling bringToFront on each lands
    // the smallest one last — and on top, where it correctly receives
    // clicks/hovers ahead of any larger polygon it sits inside. This
    // subsumes the previous hand-maintained possessions list: Taiwan,
    // Guam, Puerto Rico, ASM, MNP, VIR all rise to the top under the
    // area rule because they're smaller than their containers, as do
    // Vatican / Monaco / Lesotho / Gibraltar / San Marino and any
    // future contained-polygon case without code changes.
    //
    // Bbox area uses (north - south) × (east - west) on the cached
    // L.LatLngBounds — accuracy doesn't matter for ordering since
    // bbox sizes differ by orders of magnitude across the cases that
    // matter. Cost: a sort plus one bringToFront per attached layer
    // (a few hundred at most), runs only on reconcile (zoom, pan
    // beyond the wrap window, path change), not on every mouse move.
    const reorderable: Array<{ area: number; layer: L.GeoJSON }> = [];
    for (const [c, offsetMap] of attachedTargetsByCodeRef.current) {
      const b = boundsByCodeRef.current.get(c);
      if (!b) continue;
      const area =
        (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
      for (const lyr of offsetMap.values()) {
        reorderable.push({ area, layer: lyr });
      }
    }
    reorderable.sort((a, b) => b.area - a.area);
    for (const { layer: lyr } of reorderable) {
      lyr.bringToFront();
    }
  };

  // Two-stage border policy. For each desired offset:
  //
  //   1. If a full-precision layer is available (contiguousGeomByCodeRef
  //      has the code's geometry), attach it. If a different layer (the
  //      simplified stand-in) is currently attached at this offset, do
  //      an atomic swap: add the full layer first (which paints on top
  //      of the simple one in DOM order), then remove the simple layer.
  //      Visually invisible because both layers carry the same color
  //      and the same shape modulo sub-pixel detail.
  //
  //   2. Otherwise — full not yet loaded — attach the simplified
  //      stand-in built from contiguousSimpleGeomByCodeRef (which is
  //      populated for every code in the desired set, since the same
  //      cache makes the polygon clickable). The caller is responsible
  //      for kicking off fetchGeometry; when that resolves, this
  //      function will be called again and will perform the upgrade.
  //
  // Stage-1-only behavior (full precision never arrives) is the failure
  // mode: the user keeps seeing the simplified border. That's a strict
  // improvement over the pre-two-stage behavior, where a fetch failure
  // meant no border at all.
  //
  // For desired offsets no longer in the desired-offset set (viewport
  // shifted past the polygon's wrap point), the attached layer at that
  // offset is detached unconditionally regardless of which quality it
  // is. Quality only matters for the upgrade decision, not for cleanup.
  const reconcileBordersForCode = (
    code: string,
    viewLeft: number,
    viewRight: number,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = boundsByCodeRef.current.get(code);
    if (!bounds) return;

    let attached = attachedBordersByCodeRef.current.get(code);
    if (!attached) {
      attached = new Map();
      attachedBordersByCodeRef.current.set(code, attached);
    }

    const desiredOffsets = new Set(placeForView(bounds, viewLeft, viewRight));

    // Detach offsets no longer desired (regardless of quality).
    for (const [offset, layer] of [...attached]) {
      if (!desiredOffsets.has(offset)) {
        map.removeLayer(layer);
        attached.delete(offset);
      }
    }

    // Attach or upgrade desired offsets.
    for (const offset of desiredOffsets) {
      const fullLayer = getOrBuildBorderLayerAt(code, offset);
      const currentLayer = attached.get(offset);

      if (fullLayer) {
        // Full precision is available. Either attach for the first time
        // or swap simple → full atomically.
        if (currentLayer === fullLayer) continue;
        if (currentLayer) {
          // Atomic swap. Add full first so it paints over simple, then
          // remove simple. The brief overlap is visually a no-op
          // because both layers carry the same color and roughly the
          // same shape — the swap looks like a sub-pixel sharpening,
          // not a flicker.
          fullLayer.addTo(map);
          map.removeLayer(currentLayer);
        } else {
          fullLayer.addTo(map);
        }
        attached.set(offset, fullLayer);
      } else {
        // Full not loaded yet. If something is already attached (the
        // simplified stand-in from a previous reconcile call, attached
        // at the same offset), leave it in place — re-using it avoids
        // the brief no-border flash that would happen if we removed
        // and re-attached. If nothing is attached yet, attach the
        // simplified stand-in now.
        if (currentLayer) continue;
        const simpleLayer = getOrBuildSimpleBorderLayerAt(code, offset);
        if (!simpleLayer) continue;
        simpleLayer.addTo(map);
        attached.set(offset, simpleLayer);
      }
    }
  };

  // Detach every attached offset for a code and forget it. Used when a
  // code leaves the desired set entirely (e.g. dropped from the path).
  // The cached layer instances are kept so re-entering this code in the
  // future doesn't have to re-parse.

  const detachAllTargetsForCode = (code: string) => {
    const map = mapRef.current;
    if (!map) return;
    const attached = attachedTargetsByCodeRef.current.get(code);
    if (!attached) return;
    for (const layer of attached.values()) {
      map.removeLayer(layer);
    }
    attachedTargetsByCodeRef.current.delete(code);
  };

  // Detach every attached border for `code`, AND evict the full-
  // precision data backing those borders so iOS Safari can actually
  // reclaim the memory.
  //
  // What gets evicted (full-precision tier — the heavy stuff):
  //   - Map layers in cachedBordersByKeyRef whose key prefix matches
  //     this code. These hold parsed SVG paths with up to ~200K
  //     vertices for the worst polygons (Russia, Canada, USA), each of
  //     which dwarfs the simplified-tier equivalent by a factor of
  //     50-200. Cleared via clearLayers() + off() before the cache
  //     reference is dropped, so Leaflet's internal references release
  //     promptly rather than waiting on GC to traverse the layer's
  //     event listeners.
  //   - The parsed GeoJSON tree in contiguousGeomByCodeRef, which is
  //     what those layers were built from. Re-clicking the code will
  //     re-fetch from simplified-boundaries.supercoolradio.com — that's
  //     a strict network cost but the two-stage border architecture
  //     means the user sees a (simplified) border immediately on
  //     re-click, no perceived latency.
  //
  // What stays cached forever (simplified tier — small):
  //   - cachedSimpleBordersByKeyRef (the immediate-draw stand-ins)
  //   - cachedTargetsByKeyRef (invisible hit-target layers)
  //   - contiguousSimpleGeomByCodeRef (the raw simplified geometry)
  //   - boundsByCodeRef
  //
  //   These are what the polygon needs to remain interactive after
  //   eviction. They're cheap (T3/T6 vertex counts are 50-200x smaller
  //   than full precision) and dropping them would break clicks/hovers
  //   while saving a trivial amount of memory.
  //
  // The motivation: on iOS Safari, accumulating full-precision data
  // across navigation steps eventually trips Safari's silent-reload
  // memory threshold (verified 2026-05-03: Canada → Nunavut → another
  // Canadian province reset the page to world view). Evicting
  // full-precision data when a code leaves the desired set keeps the
  // heap bounded by "currently displayed borders," not "every border
  // ever displayed."
  const detachAllBordersForCode = (code: string) => {
    const map = mapRef.current;
    if (!map) return;
    const attached = attachedBordersByCodeRef.current.get(code);
    if (attached) {
      for (const layer of attached.values()) {
        map.removeLayer(layer);
      }
      attachedBordersByCodeRef.current.delete(code);
    }

    // Evict any cached full-precision border layers for this code. The
    // cache key is `${code}@${offset}` (see layerKey) — match by
    // prefix. clearLayers() drops Leaflet's internal feature data;
    // off() removes any event listeners (none on borders today, but
    // defensive). After both, dropping the cache reference allows GC
    // to actually reclaim the path data.
    const fullKeyPrefix = `${code}@`;
    let evictedLayers = 0;
    for (const [key, layer] of [...cachedBordersByKeyRef.current]) {
      if (!key.startsWith(fullKeyPrefix)) continue;
      layer.clearLayers();
      layer.off();
      cachedBordersByKeyRef.current.delete(key);
      evictedLayers++;
    }

    // Evict the parsed full-precision GeoJSON. Refetched on re-click.
    //
    // EXCEPTION: codes in the Maldives-problem set
    // (bboxHitTargetCodesRef) have their bbox geometry pinned in this
    // ref by the bundle-hydration loop, intentionally — so that
    // fetchGeometry's `has(code)` short-circuit keeps firing and the
    // T6 fetch never runs (the T6 file would have the natural-shape
    // atoll geometry, which is exactly what the bbox treatment is
    // there to bypass). Evicting on every hover/unhover cycle would
    // cause the next hover to flash the bbox stand-in for a frame and
    // then upgrade to the atoll geometry, which is the bug Hugh saw
    // on supercoolradio.net the first time the rule went live.
    const hadGeom = contiguousGeomByCodeRef.current.has(code);
    if (!bboxHitTargetCodesRef.current.has(code)) {
      contiguousGeomByCodeRef.current.delete(code);
    }
    if (DEBUG) {
      const totalCodes = contiguousGeomByCodeRef.current.size;
      let totalVerts = 0;
      for (const g of contiguousGeomByCodeRef.current.values()) {
        totalVerts += countCoords(g);
      }
      dbg(
        `EVICT ${code} layers=${evictedLayers} geom=${hadGeom ? 'yes' : 'no'} | full-cache: ${totalCodes} codes ${totalVerts.toLocaleString()}v`,
      );
    }
  };

  // Given a path, ensure the right set of target polygons is on the map.
  // The desired set: children of every path node, EXCLUDING any path node
  // itself.
  // - World view (path = ['000']): children of World = all Areas.
  // - Path = ['000', '840']: 232 Areas - USA + USA's 51 states. We drop
  //   USA itself because the user is already inside it; keeping USA on
  //   the map would create a hit-target sitting under all 51 states, and
  //   in Leaflet 1.x clicks on layers in custom panes can fall through
  //   to the underlying Area, masking the state click. (Hover works
  //   fine in custom panes; click does not.)
  // - Path = ['000', '840', '840-005']: 231 Areas + 50 states (USA and
  //   California themselves dropped). California has no children in the
  //   current tree, so nothing's added at the deepest level.
  //
  // Adds missing targets, requesting per-parent bundles via
  // ensureChildrenBundle as needed; removes detached codes entirely.
  // Per-code offset reconciliation is delegated to
  // reconcileTargetsForCode.
  const ensureTargetsForPath = (currentPath: string[]) => {
    const map = mapRef.current;
    const idx = treeIndexRef.current;
    if (!map || !idx) return;

    const desired = computeDesiredFor(currentPath);
    const [viewLeft, viewRight] = getViewportLngRange(map);

    // Detach codes not in desired.
    for (const code of [...attachedTargetsByCodeRef.current.keys()]) {
      if (!desired.has(code)) {
        detachAllTargetsForCode(code);
      }
    }

    // Reconcile each desired code. Group by parent so we can fetch one
    // bundle per parent rather than one fetch per child — eliminating
    // the per-child fetch storm that previously fired on drill-in into
    // a heavy country (51 fetches for USA, 33 for China, 13 for
    // Canada). Each desired code has exactly one parent (its second-to-
    // last ancestor), and that parent is somewhere in currentPath.
    //
    // Codes whose simplified geometry is already hydrated (true for all
    // ADM0 codes after the mount-time bundle, true for ADM1 codes whose
    // parent's bundle has been fetched on a prior drill-in) reconcile
    // immediately. Codes whose parent's bundle has not yet loaded wait
    // on a single ensureChildrenBundle call per parent — which dedupes
    // concurrent calls and is a no-op for parent === '000'.
    //
    // Hit-targets are built from contiguousSimpleGeomByCodeRef, so
    // that's the correct readiness predicate — not boundsByCodeRef,
    // which would also pass for codes that have bounds but no geometry
    // yet (impossible after the bundle, but the predicate should match
    // what the consumer actually reads from).
    const childrenByParent = new Map<string, string[]>();
    for (const code of desired) {
      const ancestry = idx.codeToAncestry.get(code);
      if (!ancestry || ancestry.length < 2) continue;
      const parent = ancestry[ancestry.length - 2];
      let bucket = childrenByParent.get(parent);
      if (!bucket) {
        bucket = [];
        childrenByParent.set(parent, bucket);
      }
      bucket.push(code);
    }

    for (const [parent, children] of childrenByParent) {
      const allHydrated = children.every((c) =>
        contiguousSimpleGeomByCodeRef.current.has(c),
      );
      if (allHydrated) {
        for (const code of children) {
          reconcileTargetsForCode(code, viewLeft, viewRight);
        }
        continue;
      }
      ensureChildrenBundle(parent)
        .then(() => {
          // Re-check after async: path may have changed during fetch.
          const latestDesired = computeDesiredFor(pathRef.current);
          if (!mapRef.current) return;
          const [vL, vR] = getViewportLngRange(mapRef.current);
          for (const code of children) {
            if (!latestDesired.has(code)) continue;
            if (!contiguousSimpleGeomByCodeRef.current.has(code)) continue;
            reconcileTargetsForCode(code, vL, vR);
          }
        })
        .catch(() => {
          // Already logged in ensureChildrenBundle.
        });
    }
  };

  // Compute the set of codes whose hit-targets should be on the map for
  // the given path. Includes children of every path node, except for
  // the path nodes themselves — we don't want a redundant hit-target
  // sitting under its own descendants where it can swallow clicks.
  const computeDesiredFor = (currentPath: string[]): Set<string> => {
    const desired = new Set<string>();
    const idx = treeIndexRef.current;
    if (!idx) return desired;
    const pathSet = new Set(currentPath);
    for (const code of currentPath) {
      const node = idx.codeToNode.get(code);
      if (!node) continue;
      for (const child of node.children ?? []) {
        if (pathSet.has(child.code)) continue;
        desired.add(child.code);
      }
    }
    return desired;
  };

  // When path changes:
  //   1. Update target set (add deeper, remove popped).
  //   2. Zoom to fit the new deepest selection. For World, max-expand
  //      back to the initial centered, fully-zoomed-out view.
  //
  // Border attachment for the new deepest code is deferred until the
  // fly animation completes — see isFlyingRef and the moveend handler
  // in onViewSettled. The border useEffect is informed via isFlyingRef
  // and skips the deepest code's attach while a fly is in progress.
  // This sidesteps an iOS Safari rendering glitch where a complex SVG
  // path added to the map during a CSS-driven zoom animation briefly
  // renders at the wrong y-position before snapping into place.
  //
  // The flyToBounds animation will fire moveend at completion, which
  // the onViewSettled handler installed in the map-init effect picks
  // up to clear isFlyingRef, attach the deferred border, and
  // re-reconcile every attached code's offsets against the new
  // viewport.
  useEffect(() => {
    if (DEBUG) dbg(`PATH ${path.join('→')}`);
    ensureTargetsForPath(path);

    const map = mapRef.current;
    if (!map) return;

    // ─── Phase A: synchronous preparation for the fly ───
    //
    // Set isFlyingRef so the border useEffect bails when it runs
    // after this effect. Add the scr-flying class to disable cursor
    // interaction with country layers (pointer-events:none) and hide
    // the cursor (cursor:none) for the duration of the zoom.
    //
    // We deliberately do NOT detach the currently-attached borders
    // and do NOT clear hover state. Whatever is on screen at click
    // time — the previous selection's green border, plus any hover
    // border — stays attached and gets animated along with the rest
    // of the SVG layer by the zoom transform. The earlier "ghost
    // border" bug came from enforceConstraints firing moveend
    // mid-fly, which was fixed by gating that on isFlyingRef. With
    // that root cause addressed, leaving borders attached during the
    // animation is safe and gives a nicer visual experience: the
    // selection appears continuous through the zoom rather than
    // disappearing and reappearing.
    //
    // After the fly settles, Phase C reconciles everything to the
    // new desired set (path[1..] + current hover) — detaching codes
    // that aren't wanted, attaching new codes that are.

    // 1. Mark fly-in-progress synchronously. Border useEffect (which
    //    runs after this effect on the same render) reads this and
    //    bails. Hover handlers also read this and no-op.
    isFlyingRef.current = true;

    // 2. Disable cursor interaction with country layers and hide
    //    the cursor entirely. Adds scr-flying to BOTH document.body
    //    and the map container; CSS rules match either location.
    //    Removed in onViewSettled after the fly settles.
    const container = containerRef.current;
    setFlyingActive(container);

    const deepest = path[path.length - 1];
    if (deepest === '000') {
      // Max-expand. Same view as initial page load: centered slightly
      // above the equator, zoomed to the minimum that still keeps the
      // map filling the viewport. Triggered every time the path
      // resolves to ['000'] — including ESC and ocean clicks that pop
      // back up to World, since their callers always set a new array
      // reference rather than the same one.
      // flyTo (not setView) is required to honor `duration`. setView's
      // `duration` option is silently ignored when the zoom changes —
      // Leaflet uses a fixed CSS transition for animated zooms. flyTo
      // does an integrated zoom+pan with a real, configurable duration.
      // Same short-path treatment as the country branch: pick the
      // ±360° representation of lng=0 closest to the current center.
      //
      // Polar/no-doubling guard. The naive `Math.max(2, getMinZoom())`
      // and a fixed lat=20 can fail on tall-and-skinny viewports:
      //   - getMinZoom enforces world_height ≥ max(W, H), but
      //     pannable_height = 0.943·world_height < world_height, so on
      //     a portrait viewport the pannable region can be shorter
      //     than H even at min zoom — body background bleeds through
      //     at top and bottom.
      //   - lat=20 places the camera north of the equator; on a tall
      //     viewport this can put the viewport's top edge above
      //     +POLAR_LIMIT, showing the body background through the gap.
      // Floor the zoom at the polar/no-doubling minimum, then clamp
      // lat=20 to the valid camera range at that zoom. The country
      // branch uses the same approach via computePolarSafeFlyTarget.
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const Hfull = containerEl.offsetHeight;
      const Wfull = containerEl.offsetWidth;
      const yProj0 = (lat: number) =>
        map.project(L.latLng(lat, 0), 0).y;
      const fPolarN = yProj0(POLAR_LIMIT) / 256;
      const fPolarS = yProj0(-POLAR_LIMIT) / 256;
      const pannableFrac = fPolarS - fPolarN; // ≈ 0.943
      const P_polar = Hfull / pannableFrac;
      const P_noDouble = Wfull;
      const minSafeZoom = Math.log2(
        Math.max(P_polar, P_noDouble) / 256,
      );
      const targetZoom = Math.max(2, map.getMinZoom(), minSafeZoom);

      const targetP = 256 * Math.pow(2, targetZoom);
      const cyMin = fPolarN * targetP + Hfull / 2;
      const cyMax = fPolarS * targetP - Hfull / 2;
      const yLat20 = map.project(L.latLng(20, 0), targetZoom).y;
      const cyClamped = Math.max(cyMin, Math.min(cyMax, yLat20));
      const targetLat = map.unproject(
        L.point(0, cyClamped),
        targetZoom,
      ).lat;
      const targetLng = shiftLngToNearest(0, map.getCenter().lng);

      map.flyTo([targetLat, targetLng], targetZoom, {
        duration: 1.2,
      });
      return;
    }

    // Geometry might still be loading; if so, schedule when ready.
    const tryZoom = () => {
      const bounds = boundsByCodeRef.current.get(deepest);
      if (!bounds || !bounds.isValid()) return false;
      const containerEl = containerRef.current;
      if (!containerEl) return false;
      // Shift the bounds to the copy of the world nearest the current
      // map center, so the fly takes the short path. Without this,
      // a contiguous-form crosser (e.g. USA's [144.6, 295.4]) seen from
      // a current center near Canada at lng ~ -95 would animate +315
      // east instead of -45 west. Same destination, much shorter trip.
      const currentLng = map.getCenter().lng;
      const shiftedBounds = shiftBoundsToNearest(bounds, currentLng);
      // Compute a polar-safe (center, zoom) target rather than calling
      // flyToBounds directly. flyToBounds chooses a target by fitting
      // the bounds, but for polar-extreme bounds (Antarctica, or
      // Russia / Greenland on narrow viewports) the chosen camera
      // position can extend past the polar pannable lat range, showing
      // sky/ice. computePolarSafeFlyTarget floors the zoom at whatever
      // value keeps the camera viewport within bounds, and clamps the
      // center lat. flyTo (not setView/fitBounds) is required to honor
      // `duration`.
      const target = computePolarSafeFlyTarget(
        map,
        shiftedBounds,
        containerEl.offsetWidth,
        containerEl.offsetHeight,
        60,
      );
      map.flyTo(target.center, target.zoom, {
        duration: 1.2,
      });
      return true;
    };

    if (!tryZoom()) {
      fetchGeometry(deepest)
        .then(() => {
          // Re-check path; user may have already navigated away.
          if (pathRef.current[pathRef.current.length - 1] !== deepest) {
            isFlyingRef.current = false;
            setFlyingInactive(containerRef.current);
            return;
          }
          if (!tryZoom()) {
            isFlyingRef.current = false;
            setFlyingInactive(containerRef.current);
          }
        })
        .catch(() => {
          isFlyingRef.current = false;
          setFlyingInactive(containerRef.current);
        });
    }
  }, [path]);

  // Render border overlays in response to path/hover changes.
  // Borders to draw:
  //   - Every path node except World
  //   - The hovered code, if it's not already in the path
  //
  // Per-code offset reconciliation against the current viewport is
  // delegated to reconcileBordersForCode. The view-settled handler in
  // the map-init effect handles offset changes from pan/zoom; this
  // effect handles adds/removes from path/hover changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // While a fly is in progress, do nothing. The path useEffect ran
    // first on this same render and pre-emptively detached every
    // border that wouldn't be in the post-fly ancestor set, so the
    // currently-attached layers are exactly what should remain on
    // screen during the zoom. Path or hover changes mid-fly are
    // ignored — any new desired borders are picked up after moveend
    // by onViewSettled (for the deepest path code) or by the next
    // organic run of this effect (for hover changes after the fly
    // completes).
    if (isFlyingRef.current) return;

    const desired = new Set<string>();
    for (let i = 1; i < path.length; i++) desired.add(path[i]);
    if (hoveredCode && hoveredCode !== '000' && !path.includes(hoveredCode)) {
      desired.add(hoveredCode);
    }

    const [viewLeft, viewRight] = getViewportLngRange(map);

    // Detach codes not in desired.
    for (const code of [...attachedBordersByCodeRef.current.keys()]) {
      if (!desired.has(code)) {
        detachAllBordersForCode(code);
      }
    }

    // Two-stage attach for each desired code.
    //
    // Always call reconcileBordersForCode first — under the two-stage
    // policy, this attaches the simplified stand-in immediately if full
    // precision isn't yet loaded, or attaches/keeps full if it is. The
    // user sees a green border in the same frame as the click or hover.
    //
    // If full precision isn't loaded yet, fire fetchGeometry in the
    // background. When it resolves, re-reconcile to atomically swap
    // simple → full. If the fetch fails, leave the simplified border in
    // place (strict improvement over the pre-two-stage behavior, where
    // a fetch failure meant no border at all).
    //
    // Why two-stage matters: full-precision Nunavut (in Canada's ADM1
    // tree) is several MB of GeoJSON; parsing it and handing it to
    // Leaflet's SVG renderer synchronously inside the click handler
    // crashes Mobile Safari. Doing the heavy work in a fetch promise's
    // .then() callback gives the browser a chance to breathe, and the
    // user already sees a (simplified) border by then so there's no
    // perceived latency.
    for (const code of desired) {
      reconcileBordersForCode(code, viewLeft, viewRight);
      if (contiguousGeomByCodeRef.current.has(code)) continue;
      fetchGeometry(code)
        .then(() => {
          // Re-check: path/hover may have changed during fetch.
          const latestPath = pathRef.current;
          const latestHover = hoveredCodeRef.current;
          const latestDesired = new Set<string>();
          for (let i = 1; i < latestPath.length; i++) {
            latestDesired.add(latestPath[i]);
          }
          if (
            latestHover &&
            latestHover !== '000' &&
            !latestPath.includes(latestHover)
          ) {
            latestDesired.add(latestHover);
          }
          if (!latestDesired.has(code)) return;
          if (!mapRef.current) return;
          const [vL, vR] = getViewportLngRange(mapRef.current);
          // Re-reconcile: full precision is now loaded, so this call
          // performs the atomic simple → full swap at every desired
          // offset for this code.
          reconcileBordersForCode(code, vL, vR);
        })
        .catch(() => {
          // Stage-1 (simple) border is already attached above; failing
          // to upgrade to full precision is invisible to the user.
        });
    }
  }, [path, hoveredCode]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
        }}
      />
      {/* Breadcrumb. Each segment is a button that calls setPath with
          a prefix of the current path. Clicking the current deepest
          segment re-fires zoom-to-fit by giving setPath a fresh array.
          Container has pointerEvents: none so the map underneath is
          still clickable around the buttons; each button re-enables
          pointerEvents on itself. */}
      <nav
        aria-label="Path"
        style={{
          position: 'fixed',
          top: 16,
          left: 16,
          zIndex: 1000,
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 6,
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 14,
        }}
      >
        {path.map((code, i) => {
          let label: string;
          if (code === '000') {
            label = 'World';
          } else {
            const node = treeIndexRef.current?.codeToNode.get(code);
            label = node?.display_name ?? node?.name ?? code;
          }
          const isLast = i === path.length - 1;
          return (
            <span
              key={code}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <button
                type="button"
                aria-current={isLast ? 'page' : undefined}
                onClick={() => setPath(path.slice(0, i + 1))}
                style={{
                  pointerEvents: 'auto',
                  background: 'rgba(0, 0, 0, 0.55)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  fontSize: 'inherit',
                  fontFamily: 'inherit',
                  fontWeight: isLast ? 600 : 400,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
              {!isLast && (
                <span
                  aria-hidden="true"
                  style={{
                    color: '#fff',
                    textShadow: '0 1px 2px rgba(0, 0, 0, 0.6)',
                  }}
                >
                  ›
                </span>
              )}
            </span>
          );
        })}
      </nav>
      <DebugOverlay />
    </>
  );
}
