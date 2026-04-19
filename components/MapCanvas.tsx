'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 1,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0,
      wheelPxPerZoomLevel: 120,
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

    mapRef.current = map;

    return () => {
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
        backgroundColor: '#e8ebed',
        zIndex: 0,
      }}
    />
  );
}