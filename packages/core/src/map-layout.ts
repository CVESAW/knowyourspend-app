import { geoEqualEarth, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import type { FeatureCollection } from "geojson";
import geo from "../data/geo.json";

/**
 * World map for the "Map" chart: a land outline plus one circle per owner country, sized by share
 * of spending (circles rather than shaded countries, so small places like Luxembourg stay visible).
 * Pure: returns an SVG path string and circle positions for any renderer.
 */
const land = (() => {
  const topo = (geo as unknown as { land: Topology }).land;
  return feature(topo, topo.objects.land!) as unknown as FeatureCollection;
})();
const centroids = (geo as unknown as { centroids: Record<string, [number, number]> }).centroids;

export interface MapBubble {
  iso: string;
  share: number;
  x: number;
  y: number;
  r: number;
}

const cache = new Map<string, { path: string; project: (p: [number, number]) => [number, number] | null }>();

function base(w: number, h: number) {
  const k = `${w}x${h}`;
  let b = cache.get(k);
  if (!b) {
    const proj = geoEqualEarth().fitExtent([[4, 4], [w - 4, h - 4]], land);
    b = { path: geoPath(proj)(land) ?? "", project: (p) => proj(p) };
    cache.set(k, b);
  }
  return b;
}

export function mapLayout(countries: { iso: string; share: number }[], w = 340, h = 200, maxR = 34): { path: string; bubbles: MapBubble[] } {
  const { path, project } = base(w, h);
  const bubbles: MapBubble[] = countries
    .filter((c) => centroids[c.iso])
    .map((c) => {
      const [x, y] = project(centroids[c.iso]!) ?? [0, 0];
      return { iso: c.iso, share: c.share, x, y, r: Math.max(3.5, Math.sqrt(c.share) * maxR) };
    });
  // gentle collision relaxation so small places near big ones stay visible
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < bubbles.length; i++)
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i]!, c = bubbles[j]!;
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = a.r + c.r + 1;
        if (d < min) {
          const push = (min - d) / 2;
          const ux = dx / d, uy = dy / d;
          const wa = c.r / (a.r + c.r), wc = a.r / (a.r + c.r);
          a.x -= ux * push * wa * 2;
          a.y -= uy * push * wa * 2;
          c.x += ux * push * wc * 2;
          c.y += uy * push * wc * 2;
        }
      }
  }
  return { path, bubbles: bubbles.sort((a, c) => c.r - a.r) };
}

export function hasCentroid(iso: string): boolean {
  return !!centroids[iso];
}
