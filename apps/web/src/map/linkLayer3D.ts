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

export interface Link3DSegment {
  a: LonLatAlt;
  b: LonLatAlt;
  classification: 'likely' | 'marginal' | 'blocked' | 'unknown-terrain' | string;
}

export interface Link3DLayerOptions {
  /** Vertical scale shared with MapLibre terrain exaggeration. */
  exaggeration?: number;
  linewidth?: number;
  colors?: Partial<Record<string, string>>;
}

const DEFAULT_COLORS: Record<string, string> = {
  likely: '#15803d',
  marginal: '#d97706',
  blocked: '#dc2626',
  'unknown-terrain': '#9333ea',
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
  private mesh: LineSegments2 | null = null;
  private material: LineMaterial | null = null;
  private segments: Link3DSegment[] = [];
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
      this.log(`link3d onAdd ok (segments=${this.segments.length})`);
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

  setSegments(segments: Link3DSegment[]): void {
    this.segments = segments;
    if (this.map) this.rebuild();
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
  }

  private rebuild(): void {
    this.disposeMesh();
    if (this.segments.length === 0) {
      this.origin = null;
      return;
    }
    // Origin = the proposed site (every segment starts there): a stable
    // anchor so the scene transform only changes when the site moves.
    const anchor = this.segments[0]!.a;
    const origin = sceneOrigin(anchor.lon, anchor.lat);
    const positions: number[] = [];
    const colors: number[] = [];
    const c = new THREE.Color();
    for (const seg of this.segments) {
      for (const p of [seg.a, seg.b]) {
        const [x, y, z] = sceneOffset(origin, p, this.exaggeration);
        positions.push(x, y, z);
        c.set(this.colors[seg.classification] ?? this.colors['unknown-terrain']!);
        colors.push(c.r, c.g, c.b);
      }
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = new LineMaterial({
      vertexColors: true,
      linewidth: this.linewidth,
      transparent: true,
      opacity: 0.95,
    });
    if (this.map) {
      material.resolution.set(this.map.getCanvas().width, this.map.getCanvas().height);
    }
    this.material = material;
    this.mesh = new LineSegments2(geometry, material);
    this.scene.add(this.mesh);
    this.origin = origin;
  }

  render(_gl: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.map || !this.origin || this.failed) return;
    try {
      const canvas = this.map.getCanvas();
      this.material?.resolution.set(canvas.width, canvas.height);
      const s = this.origin.unitsPerMetre;
      const m = new THREE.Matrix4().fromArray(options.modelViewProjectionMatrix as unknown as number[]);
      const local = new THREE.Matrix4()
        .makeTranslation(this.origin.x, this.origin.y, 0)
        .multiply(new THREE.Matrix4().makeScale(s, -s, s));
      this.camera.projectionMatrix = m.multiply(local);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      this.log(`link3d render failed (layer disabled): ${err instanceof Error ? err.message : String(err)}`);
      this.fail();
    }
  }
}
