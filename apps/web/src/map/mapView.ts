/**
 * Single MapLibre instance owner (build brief §3.2: one map, focused modules,
 * no whole-map React re-render per move).
 *
 * Layers: basemap (OpenFreeMap, no key), Terrarium terrain + hillshade from
 * our own /terrain-tiles/, clustered repeater pins coloured by freshness,
 * planned-site marker (draggable), and assessed-link lines.
 */
import {
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// MapLibre parses tiles in its own worker. Left to itself, the bundler keeps a
// URL that does not exist in the built output ("Worker failed to load" → the
// basemap never renders). Point it at the Vite-emitted asset instead.
setWorkerUrl(maplibreWorkerUrl);
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { PlannerRepeater } from '@ukmesh-planner/contracts';
import { freshnessBucket, type FreshnessBucket } from '../lib/freshness.js';
import { CODE_RGBA } from '../compute/coverage/codes.js';

export const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
export const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

export type Theme = 'light' | 'dark';

/**
 * Minimal built-in styles used when the external basemap cannot load
 * (offline, blocked, or slow): a plain background is enough for the planner
 * core — terrain hillshade, repeaters and predicted links all come from our
 * own origin — so the tool stays usable instead of showing a blank canvas.
 */
const FALLBACK_STYLES: Record<Theme, StyleSpecification> = {
  light: {
    version: 8,
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e9e6df' } },
    ],
  },
  dark: {
    version: 8,
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#101722' } },
    ],
  },
};

export const REPEATER_COLORS = {
  fresh: '#15803d',
  recent: '#65a30d',
  stale: '#d97706',
  long: '#9ca3af',
} as const satisfies Record<FreshnessBucket, string>;

export const LINK_COLORS = {
  likely: '#15803d',
  marginal: '#d97706',
  unlikely: '#94a3b8',
  blocked: '#dc2626',
  'unknown-terrain': '#9333ea',
} as const;

export interface MapViewCallbacks {
  onMapClick: (lngLat: { lng: number; lat: number }) => void;
  onSiteDrag: (lngLat: { lng: number; lat: number }) => void;
  onSiteDragEnd: (lngLat: { lng: number; lat: number }) => void;
}

export class MapView {
  readonly map: MapLibreMap;
  private siteMarker: Marker | null = null;
  private overlaysReady = false;
  private repeaterClickBound = false;
  private pendingRepeaters: FeatureCollection<Point> | null = null;
  private pendingLinks: FeatureCollection<LineString> | null = null;
  private theme: Theme = 'light';
  /** True while the built-in minimal style is displayed (no remote basemap). */
  private styleIsFallback = true;

  constructor(
    container: HTMLElement,
    bounds: [number, number, number, number],
    private readonly cb: MapViewCallbacks,
  ) {
    // Start from the built-in minimal style (a local object cannot fail) and
    // upgrade to the remote basemap once it fetches. MapLibre does not
    // recover via setStyle() when its initial style fetch fails (observed:
    // setStyle silently no-ops afterwards), so the map must never begin in a
    // style-less state — the planner core stays usable even fully offline.
    this.map = new MapLibreMap({
      container,
      style: FALLBACK_STYLES.light,
      bounds,
      fitBoundsOptions: { padding: 32 },
      maxZoom: 15,
      attributionControl: false,
    });
    this.map.addControl(new NavigationControl({ visualizePitch: false }), 'top-left');
    this.map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    this.map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: [
          'Terrain: OS Terrain 50 (via UK Mesh)',
          'Repeater data: UK Mesh',
        ],
      }),
    );

    // Install overlays on `styledata`, not only on `load`: both events can
    // fire in different orders across browsers/engines, and `styledata` is
    // the point at which addSource/addLayer are valid. `install()` is
    // idempotent, so repeated events are harmless.
    const install = (): void => {
      try {
        this.installTerrain();
        this.installOverlays();
      } catch {
        // Style mid-update; a later styledata/load event retries.
      }
    };
    this.map.on('load', install);
    this.map.on('styledata', install);
    this.map.on('idle', install);
    this.map.on('click', (e) => this.cb.onMapClick({ lng: e.lngLat.lng, lat: e.lngLat.lat }));

    void this.tryLoadRemoteStyle(this.theme);
  }

  /**
   * Fetch the remote basemap style with a bounded timeout and swap to it.
   * On any failure the built-in style simply stays in place.
   */
  private async tryLoadRemoteStyle(theme: Theme): Promise<void> {
    try {
      const res = await fetch(theme === 'light' ? STYLE_LIGHT : STYLE_DARK, {
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) throw new Error(`style http ${res.status}`);
      const json = (await res.json()) as StyleSpecification;
      this.styleIsFallback = false;
      this.overlaysReady = false;
      this.map.setStyle(json);
    } catch {
      if (!this.styleIsFallback) {
        // A theme switch lost its remote style mid-session: swap to the
        // built-in style for the requested theme so the map stays coherent.
        this.styleIsFallback = true;
        this.overlaysReady = false;
        this.map.setStyle(FALLBACK_STYLES[theme]);
      }
    }
  }

  private installTerrain(): void {
    if (this.map.getSource('terrain-dem')) return;
    this.map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['/terrain-tiles/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 12,
    });
    const firstSymbol = this.map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
    this.map.addLayer(
      {
        id: 'terrain-hillshade',
        type: 'hillshade',
        source: 'terrain-dem',
        paint: {
          'hillshade-exaggeration': 0.3,
          'hillshade-shadow-color': 'rgba(50,50,60,0.35)',
        },
      },
      firstSymbol,
    );
    this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.3 });
  }

  private installOverlays(): void {
    if (this.overlaysReady) return;
    if (!this.map.getSource('repeaters')) {
      this.map.addSource('repeaters', {
        type: 'geojson',
        data: this.pendingRepeaters ?? { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 44,
        clusterMaxZoom: 9,
      });
      this.map.addLayer({
        id: 'repeater-clusters',
        type: 'circle',
        source: 'repeaters',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#334155',
          'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#f8fafc',
        },
      });
      this.map.addLayer({
        id: 'repeater-cluster-count',
        type: 'symbol',
        source: 'repeaters',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': '#f8fafc' },
      });
      this.map.addLayer({
        id: 'repeater-points',
        type: 'circle',
        source: 'repeaters',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'bucket'],
            'fresh', REPEATER_COLORS.fresh,
            'recent', REPEATER_COLORS.recent,
            'stale', REPEATER_COLORS.stale,
            REPEATER_COLORS.long,
          ],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 13, 6.5],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });
      if (!this.repeaterClickBound) {
        this.repeaterClickBound = true;
        this.map.on('click', 'repeater-points', (e) => {
          const f = e.features?.[0];
          if (f) {
            const coords = (f.geometry as Point).coordinates;
            const lng = coords[0] ?? 0;
            const lat = coords[1] ?? 0;
            this.map.flyTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 11) });
          }
        });
      }
    }
    if (!this.map.getSource('links')) {
      this.map.addSource('links', {
        type: 'geojson',
        data: this.pendingLinks ?? { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'links-line',
        type: 'line',
        source: 'links',
        filter: ['in', ['get', 'classification'], ['literal', ['likely', 'unlikely']]],
        paint: {
          'line-color': [
            'match',
            ['get', 'classification'],
            'likely', LINK_COLORS.likely,
            'unlikely', LINK_COLORS.unlikely,
            LINK_COLORS['unknown-terrain'],
          ],
          'line-width': ['match', ['get', 'classification'], 'likely', 2.4, 1.4],
          'line-opacity': 0.9,
        },
        layout: {
          'line-cap': 'round',
        },
      });
      // Dashed layer keeps marginal/blocked/unknown distinct without relying on
      // colour alone (build brief §5.3).
      this.map.addLayer({
        id: 'links-dashed',
        type: 'line',
        source: 'links',
        filter: ['in', ['get', 'classification'], ['literal', ['marginal', 'blocked', 'unknown-terrain']]],
        paint: {
          'line-color': [
            'match',
            ['get', 'classification'],
            'marginal', LINK_COLORS.marginal,
            'blocked', LINK_COLORS.blocked,
            LINK_COLORS['unknown-terrain'],
          ],
          // Blocked paths are context, not the headline: thinner + fainter so
          // dense sites read as a pattern instead of a hairball (build brief §5).
          'line-width': ['match', ['get', 'classification'], 'blocked', 1.4, 1.8],
          'line-opacity': ['match', ['get', 'classification'], 'blocked', 0.55, 0.85],
          'line-dasharray': [2.5, 2],
        },
        layout: {
          'line-cap': 'butt',
        },
      });
    }
    this.overlaysReady = true;
  }

  setRepeaters(repeaters: PlannerRepeater[]): void {
    const features = repeaters.map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        id: r.canonicalId,
        name: r.name ?? '',
        bucket: freshnessBucket(r.lastSeen),
        online: r.isOnline,
      },
    }));
    this.pendingRepeaters = { type: 'FeatureCollection', features };
    const src = this.map.getSource('repeaters') as GeoJSONSource | undefined;
    if (src) src.setData(this.pendingRepeaters);
  }

  setLinks(features: FeatureCollection<LineString>): void {
    this.pendingLinks = features;
    const src = this.map.getSource('links') as GeoJSONSource | undefined;
    if (src) src.setData(features);
  }

  private coverageUrl: string | null = null;

  /**
   * Coverage raster overlay (Tier B output). `codes` uses the shared cell
   * codes; pass null to remove. Rendered as a semi-transparent image source
   * below the repeater/link layers.
   */
  async setCoverage(
    data: { bounds: [number, number, number, number]; width: number; height: number; codes: Uint8Array } | null,
  ): Promise<void> {
    if (!data) {
      if (this.map.getLayer('coverage-raster')) this.map.removeLayer('coverage-raster');
      if (this.map.getSource('coverage')) this.map.removeSource('coverage');
      if (this.coverageUrl) {
        URL.revokeObjectURL(this.coverageUrl);
        this.coverageUrl = null;
      }
      return;
    }
    const { width, height, codes, bounds } = data;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < codes.length; i += 1) {
      const c = CODE_RGBA[codes[i] ?? 5] ?? [0, 0, 0, 0];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = c[3];
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const coordinates: Array<[number, number]> = [
      [bounds[0], bounds[3]],
      [bounds[2], bounds[3]],
      [bounds[2], bounds[1]],
      [bounds[0], bounds[1]],
    ];
    const src = this.map.getSource('coverage') as
      | { updateImage?: (o: { url: string; coordinates: Array<[number, number]> }) => void }
      | undefined;
    if (src && this.map.getLayer('coverage-raster')) {
      const old = this.coverageUrl;
      this.coverageUrl = url;
      src.updateImage?.({ url, coordinates });
      if (old) URL.revokeObjectURL(old);
    } else {
      this.coverageUrl = url;
      this.map.addSource('coverage', { type: 'image', url, coordinates: coordinates as never });
      const before = this.map.getLayer('repeater-clusters')
        ? 'repeater-clusters'
        : this.map.getLayer('links-line')
          ? 'links-line'
          : undefined;
      this.map.addLayer(
        {
          id: 'coverage-raster',
          type: 'raster',
          source: 'coverage',
          paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 0 },
        },
        before,
      );
    }
  }

  setPlannedSite(lngLat: { lng: number; lat: number } | null): void {
    if (!lngLat) {
      this.siteMarker?.remove();
      this.siteMarker = null;
      return;
    }
    if (!this.siteMarker) {
      const el = document.createElement('div');
      el.className = 'site-marker';
      el.setAttribute('aria-label', 'proposed repeater site');
      this.siteMarker = new Marker({ element: el, draggable: true })
        .setLngLat([lngLat.lng, lngLat.lat])
        .addTo(this.map);
      this.siteMarker.on('drag', () => {
        const p = this.siteMarker?.getLngLat();
        if (p) this.cb.onSiteDrag({ lng: p.lng, lat: p.lat });
      });
      this.siteMarker.on('dragend', () => {
        const p = this.siteMarker?.getLngLat();
        if (p) this.cb.onSiteDragEnd({ lng: p.lng, lat: p.lat });
      });
    } else {
      this.siteMarker.setLngLat([lngLat.lng, lngLat.lat]);
    }
  }

  flyToSite(lngLat: { lng: number; lat: number }): void {
    this.map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(this.map.getZoom(), 10.5) });
  }

  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    if (this.styleIsFallback) {
      this.overlaysReady = false;
      this.map.setStyle(FALLBACK_STYLES[theme]);
      return;
    }
    void this.tryLoadRemoteStyle(theme);
  }

  getState(): { center: [number, number]; zoom: number } {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom() };
  }
}
