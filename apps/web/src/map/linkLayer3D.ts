/**
 * 3D link-of-sight layer (build brief §5 feedback 2026-10-13): predicted
 * links render as floating straight-line objects in 3D space — antenna-top
 * to antenna-top — instead of 2D lines glued to the map surface. With
 * MapLibre terrain active the line is depth-tested against hills, so a
 * terrain-blocked path visibly runs into the ground (that IS the LOS story).
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { sceneOffset, sceneOrigin, type LonLatAlt, type SceneOrigin } from './linkMath.js';

export interface Link3DPath {
  /** Consecutive points of the drawn link (>= 2); joined into 3D segments. */
  points: LonLatAlt[];
  classification: 'likely' | 'marginal' | 'blocked' | 'unknown-terrain' | string;
}

export interface Link3DLayerOptions {
  /** Vertical scale shared with MapLibre terrain exaggeration. */
  exaggeration?: number;
  linewidth?: number;
  colors?: Partial<Record<string, string>>;
}

const DEFAULT_COLORS: Record<string, string> = {
  likely: '#22c55e',
  marginal: '#fbbf24',
  blocked: '#ef4444',
  'unknown-terrain': '#9ca3af',
  // Live neighbours-map palette (frontend mapConfig.ts linkGood/linkMarginal).
  green: '#22c55e',
  amber: '#fbbf24',
  red: '#ef4444',
};

/** Live neighbours-map line widths (geojsonBuilders.ts): green 3, amber 2.1. */
const BAND_WIDTHS: Record<string, number> = {
  green: 3,
  amber: 2.1,
  likely: 3,
  marginal: 2.1,
  blocked: 1.4,
  red: 1.4,
};

export class Link3DLayer implements CustomLayerInterface {
  readonly id = 'links-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  /** A failed custom layer must never take the map's frame loop down with it. */
  private failed = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private meshes: LineSegments2[] = [];
  private materials: LineMaterial[] = [];
  private paths: Link3DPath[] = [];
  private origin: SceneOrigin | null = null;
  private readonly exaggeration: number;
  private readonly linewidth: number;
  private readonly colors: Record<string, string>;

  constructor(opts: Link3DLayerOptions = {}) {
    this.exaggeration = opts.exaggeration ?? 1;
    this.linewidth = opts.linewidth ?? 2.4;
    const merged: Record<string, string> = { ...DEFAULT_COLORS };
    for (const [key, value] of Object.entries(opts.colors ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
    this.colors = merged;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    try {
      this.map = map;
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      this.renderer.autoClear = false;
      this.rebuild();
      this.log(`link3d onAdd ok (paths=${this.paths.length})`);
    } catch (err) {
      this.log(`link3d onAdd failed (layer disabled): ${err instanceof Error ? err.message : String(err)}`);
      this.fail();
    }
  }

  private log(msg: string): void {
    const w = window as unknown as { __mapLog?: string[] };
    w.__mapLog = w.__mapLog ?? [];
    if (w.__mapLog.length < 80) w.__mapLog.push(msg);
  }

  /** Permanently disable rendering; the map must keep working without us. */
  private fail(): void {
    this.failed = true;
    try {
      this.renderer?.dispose();
    } catch {
      /* dispose best-effort */
    }
    this.renderer = null;
  }

  onRemove(): void {
    this.disposeMesh();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  setPaths(paths: Link3DPath[]): void {
    this.paths = paths;
    if (this.map) this.rebuild();
  }

  private disposeMesh(): void {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.meshes = [];
    this.materials = [];
  }

  private rebuild(): void {
    this.disposeMesh();
    if (this.paths.length === 0) {
      this.origin = null;
      return;
    }
    // Origin = the proposed site (every path starts there): a stable anchor
    // so the scene transform only changes when the site moves.
    const anchor = this.paths[0]!.points[0]!;
    const origin = sceneOrigin(anchor.lon, anchor.lat);
    // Group paths by classification so each band gets the live map's line
    // width (green 3 px, amber 2.1 px, red 1.4 px).
    const byBand = new Map<string, Link3DPath[]>();
    for (const path of this.paths) {
      const key = path.classification;
      const list = byBand.get(key);
      if (list) list.push(path);
      else byBand.set(key, [path]);
    }
    const canvas = this.map?.getCanvas();
    for (const [band, bandPaths] of byBand) {
      const positions: number[] = [];
      const colors: number[] = [];
      const c = new THREE.Color();
      c.set(this.colors[band] ?? this.colors['unknown-terrain']!);
      for (const path of bandPaths) {
        for (let i = 1; i < path.points.length; i += 1) {
          for (const p of [path.points[i - 1]!, path.points[i]!]) {
            const [x, y, z] = sceneOffset(origin, p, this.exaggeration);
            positions.push(x, y, z);
            colors.push(c.r, c.g, c.b);
          }
        }
      }
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      geometry.setColors(colors);
      const material = new LineMaterial({
        vertexColors: true,
        linewidth: BAND_WIDTHS[band] ?? this.linewidth,
        transparent: true,
        opacity: 0.95,
        // Links stay visible as floating 3D objects even where the straight
        // line passes through a ridge: ITM viability can come from knife-edge
        // diffraction over the obstruction, so burying the line in the hill
        // would contradict the model and read as "missing". Terrain profile
        // detail lives in the advanced profile view; the map shows reach.
        depthTest: false,
        depthWrite: false,
      });
      if (canvas) material.resolution.set(canvas.width, canvas.height);
      this.materials.push(material);
      const mesh = new LineSegments2(geometry, material);
      // Fat-line geometry stores positions in instanced attributes, so
      // three's bounding-sphere frustum test collapses to the origin of the
      // mercator world and culls the whole mesh. These are map-space objects
      // rendered through MapLibre's own matrix; skip three's culling.
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    this.origin = origin;
  }

  render(_gl: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.map || !this.origin || this.failed) return;
    try {
      const canvas = this.map.getCanvas();
      for (const material of this.materials) material.resolution.set(canvas.width, canvas.height);
      const s = this.origin.unitsPerMetre;
      // MapLibre v6: project through `defaultProjectionData.mainMatrix`,
      // which takes mercator [0..1] coordinates (tileMercatorCoords is
      // identity for the world tile under mercator projection). At pitch the
      // matrix carries the z->y term (m9 ~ 1.36e6 at pitch 60), so altitude
      // DOES displace on screen — pixel-measured: 300 m raises a marker ~19 px
      // at z10. At pitch 0 the term is zero (nothing can show height flat).
      // `modelViewProjectionMatrix` does NOT accept mercator input in v6 and
      // `getProjectionData({tileID: ...})` requires a real tile ID (null
      // throws and disables the layer) — do not use either.
      const proj = options.defaultProjectionData;
      const tmc = proj.tileMercatorCoords ?? [0, 0, 1, 1];
      const main = new THREE.Matrix4().fromArray(proj.mainMatrix as unknown as number[]);
      const toTile = new THREE.Matrix4()
        .makeScale(1 / tmc[2], 1 / tmc[3], 1 / tmc[2])
        .premultiply(new THREE.Matrix4().makeTranslation(-tmc[0], -tmc[1], 0));
      const local = new THREE.Matrix4()
        .makeTranslation(this.origin.x, this.origin.y, 0)
        .multiply(new THREE.Matrix4().makeScale(s, -s, s));
      this.camera.projectionMatrix = main.multiply(toTile).multiply(local);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      this.log(`link3d render failed (layer disabled): ${err instanceof Error ? err.message : String(err)}`);
      this.fail();
    }
  }
}
