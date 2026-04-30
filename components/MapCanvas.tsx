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

// Shape of /data/simplified-adm0.json. Keys are ADM0 codes (3-digit ISO
// 3166-1 numeric, zero-padded). Each entry stores the country's wrapped
// bounds (minLat/maxLat/minLng/maxLng — see computeWrappedBounds for the
// largest-gap algorithm that handles antimeridian crossers) and its
// Douglas-Peucker–simplified contiguous-form geometry. Produced by
// scripts/build-simplified-adm0.mjs.
type SimplifiedBundle = {
  [code: string]: {
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
    geom: GeoJSON.Geometry;
  };
};

const BOUNDARIES_BASE = 'https://boundaries.supercoolradio.com/tree';

// Mount-time bundle: simplified geometry + bounds for every ADM0 country,
// pre-computed at build time by scripts/build-simplified-adm0.mjs and
// shipped as a single static asset (~2.5 MB uncompressed). Loaded once at
// mount in parallel with tree.json. Without this, the runtime had to
// fetch all 230 country GeoJSONs at mount, parse and Douglas-Peucker
// simplify each on the main thread before any borders could render —
// enough memory pressure to OOM mobile Safari under sustained zoom
// thrashing (verified 2026-04-30: 20 sec rapid zoom on iPhone → tab
// kill). The bundle gives us hit-targets at World view "for free"; full-
// resolution geometry is fetched per-country only when a green border
// needs to be drawn.
const SIMPLIFIED_ADM0_URL = '/data/simplified-adm0.json';

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

// Areas whose polygons sit inside another Area's polygon and would
// otherwise be unclickable because the containing Area's invisible
// hit-target sits on top. Per Partitioning Rule 5, these are the six
// "possessions" the algorithm detected: Taiwan inside China; American
// Samoa, Guam, Northern Mariana Islands, Puerto Rico, and US Virgin
// Islands inside USA. We bringToFront() these layers after attaching
// so they paint on top of their container in DOM order, which is what
// SVG paint order and Leaflet hit-testing both follow.
const POSSESSION_CODES = new Set([
  '016', // American Samoa
  '158', // Taiwan (the Area)
  '316', // Guam
  '580', // Northern Mariana Islands
  '630', // Puerto Rico
  '850', // US Virgin Islands
  // Taiwan-as-Region-of-China sits at the END of this set so the
  // bringToFront iteration delivers it last — above Area 158 at
  // China view, so users can click it to drill into China > Taiwan.
  // No effect at world view, where 156-034 isn't attached.
  '156-034', // Taiwan (province, China-claim)
]);

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

  // ─── Render-time Leaflet layers, keyed by (code, offset) ───
  //
  // cachedTargetsByKeyRef / cachedBordersByKeyRef:
  //   Build cache. Once a layer is parsed by Leaflet at a given offset
  //   it stays here forever — re-attach is cheap, re-parse is not. Key
  //   is `${code}@${offset}` (see layerKey). A given polygon typically
  //   has 1–3 distinct offsets used over a session.
  //
  // attachedTargetsByCodeRef / attachedBordersByCodeRef:
  //   What's currently on the map. Outer key: code. Inner: offset → layer
  //   instance (same instance as the one in the corresponding cache).
  //   Maintained by the reconcile* helpers below.
  const cachedTargetsByKeyRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const cachedBordersByKeyRef = useRef<Map<string, L.GeoJSON>>(new Map());
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
    // Fires after pan/zoom completes. For each currently-attached code
    // (border or target), recompute which offsets should be rendered for
    // the new viewport and adjust attached layers accordingly. Codes that
    // aren't currently attached are NOT touched here — those are the
    // responsibility of the path/hover effects, which fetch geometry if
    // needed and call reconcile when ready.
    //
    // We listen on moveend AND zoomend because a zoom-with-pan-component
    // can fire only one or the other depending on Leaflet internals; the
    // reconcile is idempotent so the occasional duplicate is harmless.
    const onViewSettled = () => {
      if (!mapRef.current) return;
      const [viewLeft, viewRight] = getViewportLngRange(mapRef.current);
      for (const code of attachedTargetsByCodeRef.current.keys()) {
        reconcileTargetsForCode(code, viewLeft, viewRight);
      }
      for (const code of attachedBordersByCodeRef.current.keys()) {
        reconcileBordersForCode(code, viewLeft, viewRight);
      }
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

  // Mount-time data load: fetch tree.json AND simplified-adm0.json in
  // parallel. The tree gives us the navigation structure (codes, parent/
  // child relationships); the bundle gives us bounds + simplified
  // geometry for all ADM0 countries (hit-targets without a per-country
  // network round trip). Both must arrive before we can render the
  // initial World view. After both land, we trigger ensureTargetsForPath
  // for World, which now finds simple geom already in cache for every
  // ADM0 child and builds hit-targets synchronously with no fetching.
  //
  // Architectural note: full-resolution ADM0 geometry is NOT loaded here.
  // It's fetched per-country, on demand, when the user navigates into a
  // country and we need to draw the green border. See fetchGeometry
  // below — it's been made idempotent on the bundle-populated refs so a
  // subsequent fetch only does the work that wasn't already done.
  useEffect(() => {
    let stillMounted = true;

    const treeP = fetch('/data/tree.json')
      .then((res) => {
        if (!res.ok) throw new Error(`tree.json HTTP ${res.status}`);
        return res.json();
      });

    const bundleP = fetch(SIMPLIFIED_ADM0_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`simplified-adm0.json HTTP ${res.status}`);
        return res.json();
      });

    Promise.all([treeP, bundleP])
      .then(([tree, bundle]: [TreeNode, SimplifiedBundle]) => {
        if (!stillMounted) return;

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
        let hydratedCount = 0;
        for (const [code, entry] of Object.entries(bundle)) {
          const b = entry.bounds;
          boundsByCodeRef.current.set(
            code,
            L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]),
          );
          contiguousSimpleGeomByCodeRef.current.set(code, entry.geom);
          hydratedCount++;
        }
        console.log(`[SCR] simplified-adm0.json loaded — ${hydratedCount} ADM0 entries hydrated`);

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

    // Build the R2 path for this code. Code structure mirrors directory
    // structure: '840' -> '840/840.geojson',
    //            '840-006' -> '840/840-006/840-006.geojson',
    //            '156-006-003' -> '156/156-006/156-006-003/156-006-003.geojson'
    const parts = code.split('-');
    const dirParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      dirParts.push(parts.slice(0, i + 1).join('-'));
    }
    const url = `${BOUNDARIES_BASE}/${dirParts.join('/')}/${code}.geojson`;

    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((geojson: GeoJSON.GeoJSON) => {
        const origGeom = extractGeometry(geojson);
        if (!origGeom) throw new Error('no geometry');

        // Compute and cache bounds — but skip if already populated. For
        // ADM0 codes hydrated from simplified-adm0.json at mount, bounds
        // are already in the ref. Re-computing would produce the same
        // value (same source data) at the cost of sorting all coords
        // (Russia: ~100k coords sorted = 30-50ms wasted main-thread
        // time per country). Skip is safe because the bundle's bounds
        // come from the same computeWrappedBounds algorithm running on
        // the same source GeoJSON.
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

        // Simplify the contiguous form for the invisible hit-target
        // layer — but skip if already populated. For ADM0 codes hydrated
        // from the bundle, the simplified form is already cached (and
        // was simplified at a coarser tolerance than the runtime would
        // use; the bundle prioritizes file size and the runtime now
        // never gets a chance to refine ADM0 hit-targets, which is fine
        // because the bundle's tolerance is still well below pixel
        // resolution at every reasonable zoom). For ADM1+ codes this
        // simplifies as before.
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
          setHoveredCode(code);
        },
        mouseout: () => {
          setHoveredCode((current) => (current === code ? null : current));
        },
      });
    }
    layer.on({
      click: (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
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
      // Possessions (Taiwan, PR, Guam, MNP, ASM, VIR) need to sit on top
      // of their containers so clicks/hovers land on the possession
      // rather than the surrounding country. SVG paint order = DOM
      // order, last sibling on top; bringToFront moves the path to the
      // end of the parent SVG group. Done after addTo so the path
      // exists in the DOM by the time we reorder it.
      if (POSSESSION_CODES.has(code)) {
        layer.bringToFront();
      }
    }
    // Re-bump every attached possession to the front, regardless of
    // which code we're reconciling. The bringToFront inside the for
    // loop only fires when the possession itself is being newly
    // attached; a container that attaches LATER would otherwise end up
    // at the end of DOM order (on top), shadowing the possession's hit
    // target. Reasserting the invariant on every reconcile makes the
    // ordering independent of fetch-completion order.
    for (const possCode of POSSESSION_CODES) {
      const possAttached = attachedTargetsByCodeRef.current.get(possCode);
      if (!possAttached) continue;
      for (const possLayer of possAttached.values()) {
        possLayer.bringToFront();
      }
    }
  };

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

    for (const [offset, layer] of [...attached]) {
      if (!desiredOffsets.has(offset)) {
        map.removeLayer(layer);
        attached.delete(offset);
      }
    }

    for (const offset of desiredOffsets) {
      if (attached.has(offset)) continue;
      const layer = getOrBuildBorderLayerAt(code, offset);
      if (!layer) continue;
      layer.addTo(map);
      attached.set(offset, layer);
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

  const detachAllBordersForCode = (code: string) => {
    const map = mapRef.current;
    if (!map) return;
    const attached = attachedBordersByCodeRef.current.get(code);
    if (!attached) return;
    for (const layer of attached.values()) {
      map.removeLayer(layer);
    }
    attachedBordersByCodeRef.current.delete(code);
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
  // - Path = ['000', '840', '840-005']: 231 Areas + 50 states + Calif's
  //   Sub-Regions. California itself dropped, USA itself dropped.
  //
  // Adds missing targets (fetching geometry as needed); removes detached
  // codes entirely. Per-code offset reconciliation is delegated to
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

    // Reconcile each desired code. If simplified geometry is loaded
    // (true for all ADM0 codes after the bundle hydrates at mount; true
    // for ADM1+ codes only after they've been fetched), reconcile
    // immediately. Otherwise fetch and reconcile when ready. Hit-targets
    // are built from contiguousSimpleGeomByCodeRef, so that's the
    // correct readiness predicate — not boundsByCodeRef, which would
    // also pass for ADM0 codes that have bounds but no geometry yet
    // (impossible after the bundle, but the predicate should match what
    // the consumer actually reads from).
    for (const code of desired) {
      if (contiguousSimpleGeomByCodeRef.current.has(code)) {
        reconcileTargetsForCode(code, viewLeft, viewRight);
      } else {
        fetchGeometry(code)
          .then(() => {
            // Re-check after async: path may have changed during fetch.
            const latestDesired = computeDesiredFor(pathRef.current);
            if (!latestDesired.has(code)) return;
            if (!mapRef.current) return;
            const [vL, vR] = getViewportLngRange(mapRef.current);
            reconcileTargetsForCode(code, vL, vR);
          })
          .catch(() => {
            // Already logged in fetchGeometry.
          });
      }
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
  // For non-World destinations: full-resolution geometry must be in
  // memory AND attached to the map AND painted to the screen before
  // the fly animation starts. Otherwise iOS Safari briefly renders
  // the border at the wrong y-position when an SVG path with tens of
  // thousands of vertices (USA, Canada, Russia at HPSCU resolution)
  // is added to the map mid-animation. The fix sequences the work:
  // fetchGeometry → reconcileBordersForCode → two animation frames
  // (one for layout, one for paint) → flyToBounds. ~32 ms of added
  // latency at 60fps; imperceptible relative to the 1.2 s zoom.
  //
  // The flyToBounds animation will fire moveend at completion, which
  // the onViewSettled handler installed in the map-init effect picks
  // up to re-reconcile every attached code's offsets against the new
  // viewport.
  useEffect(() => {
    ensureTargetsForPath(path);

    const map = mapRef.current;
    if (!map) return;

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
      const targetLng = shiftLngToNearest(0, map.getCenter().lng);
      map.flyTo([20, targetLng], Math.max(2, map.getMinZoom()), {
        duration: 1.2,
      });
      return;
    }

    // Attach the border at full resolution, wait for paint, then fly.
    // Re-checks the path at each async boundary so an in-flight
    // sequence aborts cleanly if the user navigates away mid-fetch
    // or mid-frame-wait.
    const attachBorderAndFly = () => {
      if (pathRef.current[pathRef.current.length - 1] !== deepest) return;
      const m = mapRef.current;
      if (!m) return;
      const [vL, vR] = getViewportLngRange(m);
      // Synchronously attach the full-resolution border. By this point
      // contiguousGeomByCodeRef has the geometry (we awaited it above
      // when not already cached), so reconcileBordersForCode builds
      // and adds the layer immediately rather than going through its
      // own deferred fetch path in the border useEffect.
      reconcileBordersForCode(deepest, vL, vR);
      // Two rAFs: first to commit the layer addition into a layout,
      // second to ensure the browser has painted it. After both fire
      // we know the border is on screen, and the fly animation can
      // start without iOS Safari having to insert a complex SVG path
      // mid-CSS-transform.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (pathRef.current[pathRef.current.length - 1] !== deepest) return;
          const m2 = mapRef.current;
          if (!m2) return;
          const bounds = boundsByCodeRef.current.get(deepest);
          if (!bounds || !bounds.isValid()) return;
          const currentLng = m2.getCenter().lng;
          const shiftedBounds = shiftBoundsToNearest(bounds, currentLng);
          // flyToBounds (not fitBounds) is required to honor `duration`.
          // fitBounds delegates the zoom portion to a fixed-duration CSS
          // transition, ignoring our `duration`. flyToBounds does an
          // integrated zoom+pan with a real, configurable duration.
          m2.flyToBounds(shiftedBounds, {
            padding: [60, 60],
            duration: 1.2,
          });
        });
      });
    };

    if (contiguousGeomByCodeRef.current.has(deepest)) {
      attachBorderAndFly();
    } else {
      fetchGeometry(deepest)
        .then(() => {
          attachBorderAndFly();
        })
        .catch(() => {});
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

    // Reconcile each desired code. Borders are drawn from
    // contiguousGeomByCodeRef (full-resolution), not the simplified
    // bundle — at country zoom levels the simplified geometry would
    // look chunky. So the readiness test is "do we have full geom",
    // not "do we have bounds" or "do we have simple". For ADM0 codes
    // hydrated from the bundle, bounds and simple are present but
    // full is not, so we fall through to fetchGeometry — which is
    // idempotent on the bundle-populated refs and only does the work
    // (network fetch + parse) needed to populate contiguousGeomByCodeRef.
    //
    // Tradeoff: the user sees a brief delay between selecting a country
    // and the green border appearing (one HTTP round-trip + parse). A
    // future optimization could draw the simplified geometry as a
    // placeholder border immediately and swap in the full-resolution
    // version when it arrives.
    for (const code of desired) {
      if (contiguousGeomByCodeRef.current.has(code)) {
        reconcileBordersForCode(code, viewLeft, viewRight);
      } else {
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
            reconcileBordersForCode(code, vL, vR);
          })
          .catch(() => {});
      }
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
    </>
  );
}
