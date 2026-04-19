'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;

    // Smallest zoom where the map covers the viewport in BOTH dimensions.
    // The map is square in Mercator (map width = map height at any zoom),
    // so we size it off the longer viewport dimension. On a tall/skinny
    // viewport this means you see less than 360° at a time and must pan
    // horizontally to see more — but the canvas is always covered.
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

    // Rule 1: map's north edge never sits below viewport top.
    // Rule 2: map's south edge never sits above viewport bottom.
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

    // Background blue-to-white split follows a line 3/4 of the way down
    // the map (≈ latitude -66°, the Antarctic Circle). This line exists
    // only as a mental model — it's the seam behind the map that the body
    // gradient uses so fallback color behind loading tiles stays plausible.
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

    // Wheel: plain = pan vertically. Ctrl/Cmd = zoom at cursor.
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

    mapRef.current = map;

    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('wheel', handleWheel);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
      }}
    />
  );
}