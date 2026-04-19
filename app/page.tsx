'use client';

import dynamic from 'next/dynamic';

const MapCanvas = dynamic(() => import('@/components/MapCanvas'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#e8ebed',
      }}
    />
  ),
});

export default function HomePage() {
  return <MapCanvas />;
}