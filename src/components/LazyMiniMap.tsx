import { lazy, Suspense, type ComponentProps } from 'react';

// Leaflet is only downloaded when a map is actually shown.
const MiniMapImpl = lazy(() => import('./MiniMap').then((m) => ({ default: m.MiniMap })));

export function MiniMap(props: ComponentProps<typeof MiniMapImpl>) {
  return (
    <Suspense fallback={<div className="mini-map" />}>
      <MiniMapImpl {...props} />
    </Suspense>
  );
}
