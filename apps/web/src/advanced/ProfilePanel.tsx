/**
 * Advanced: precision LOS / terrain cross-section (plan §5.2.1).
 *
 * SVG cross-section of the sampled profile: DTM terrain, the effective
 * terrain (DTM + 4/3-Earth curvature), the straight antenna chord, the first
 * Fresnel zone and the worst obstruction. All values come from the shared
 * rf-core profile — nothing is recomputed in the view.
 */
import type { ProfileResponse } from '../compute/assess.worker.js';

export interface ProfileUiState {
  status: 'idle' | 'running' | 'done' | 'error';
  data: ProfileResponse | null;
  error: string | null;
}

interface Props {
  profile: ProfileUiState;
  labelA: string;
  labelB: string;
  aAglM: number;
  bAglM: number;
  onClear: () => void;
}

const W = 560;
const H = 190;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

export function ProfilePanel({ profile, labelA, labelB, aAglM, bAglM, onClear }: Props) {
  if (profile.status === 'idle') {
    return (
      <div className="adv-empty">
        <p>Select a repeater (list or map) to draw the terrain profile from the proposed site.</p>
      </div>
    );
  }
  if (profile.status === 'error') {
    return <div className="adv-error">Profile failed: {profile.error}</div>;
  }
  if (profile.status === 'running' || !profile.data) {
    return <div className="adv-empty">Computing profile…</div>;
  }
  const d = profile.data;
  const pts = d.points;
  const xMax = d.totalDistanceM;
  const ys: number[] = [];
  for (const p of pts) {
    if (p.terrainM !== null) ys.push(p.terrainM);
    ys.push(p.lineHeightM - p.fresnelRadiusM, p.lineHeightM + p.fresnelRadiusM);
    ys.push(p.lineHeightM);
  }
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const span = Math.max(20, yMax - yMin);
  yMin -= span * 0.06;
  yMax += span * 0.06;

  const sx = (m: number): number => PAD.l + (m / xMax) * (W - PAD.l - PAD.r);
  const sy = (m: number): number => H - PAD.b - ((m - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  // terrain path with gaps for unknown samples
  let terrain = '';
  let pen = false;
  for (const p of pts) {
    if (p.terrainM === null) {
      pen = false;
      continue;
    }
    terrain += `${pen ? 'L' : 'M'}${sx(p.distanceM).toFixed(1)},${sy(p.terrainM).toFixed(1)}`;
    pen = true;
  }
  // effective terrain (terrain + bulge) — faint
  let eff = '';
  pen = false;
  for (const p of pts) {
    if (p.terrainM === null) {
      pen = false;
      continue;
    }
    eff += `${pen ? 'L' : 'M'}${sx(p.distanceM).toFixed(1)},${sy(p.terrainM + p.bulgeM).toFixed(1)}`;
    pen = true;
  }
  // Fresnel band
  const upper = pts.map((p) => `${sx(p.distanceM).toFixed(1)},${sy(p.lineHeightM + p.fresnelRadiusM).toFixed(1)}`).join(' ');
  const lower = pts
    .slice()
    .reverse()
    .map((p) => `${sx(p.distanceM).toFixed(1)},${sy(p.lineHeightM - p.fresnelRadiusM).toFixed(1)}`)
    .join(' ');
  const chord = `${sx(0).toFixed(1)},${sy(pts[0]!.lineHeightM).toFixed(1)} ${sx(xMax).toFixed(1)},${sy(pts[pts.length - 1]!.lineHeightM).toFixed(1)}`;
  const worst = d.worstIndex !== null ? pts[d.worstIndex] : null;

  const fmtDb = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)} dB`);
  const fmtM = (v: number | null): string => (v === null ? '—' : `${v.toFixed(0)} m`);

  return (
    <div className="profile-panel">
      <div className="profile-head">
        <span>
          <strong>{labelA}</strong> → <strong>{labelB}</strong>
        </span>
        <button type="button" className="ghost small" onClick={onClear}>
          Clear
        </button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="profile-svg" role="img" aria-label="Terrain profile cross-section">
        {[0, 0.5, 1].map((f) => {
          const v = yMin + f * (yMax - yMin);
          return (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} className="profile-grid" />
              <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" className="profile-axis">
                {v.toFixed(0)}
              </text>
            </g>
          );
        })}
        <polygon points={`${upper} ${lower}`} className="profile-fresnel" />
        <path d={eff} className="profile-eff" fill="none" />
        <path d={terrain} className="profile-terrain" fill="none" />
        <polyline points={chord} className="profile-chord" fill="none" />
        {worst && worst.clearanceM !== null && worst.terrainM !== null ? (
          <circle cx={sx(worst.distanceM)} cy={sy(worst.terrainM + worst.bulgeM)} r={4} className="profile-worst" />
        ) : null}
        <text x={PAD.l} y={H - 8} className="profile-axis">
          0 km
        </text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" className="profile-axis">
          {(xMax / 1000).toFixed(1)} km
        </text>
      </svg>
      <ul className="profile-stats">
        <li>
          {d.classification} · margin {fmtDb(d.marginDb)} · diffraction {fmtDb(d.diffractionDb)}
        </li>
        <li>
          clearance ratio {d.worstClearanceRatio === null ? '—' : d.worstClearanceRatio.toFixed(2)}
          {worst ? ` at ${(worst.distanceM / 1000).toFixed(1)} km` : ''} · worst obstruction {worst ? fmtM(worst.clearanceM) : '—'}
        </li>
        <li>
          terrain: {fmtM(d.aGroundM)} → {fmtM(d.bGroundM)} ASL · antennas {aAglM} m / {bAglM} m AGL
          {d.unknownCount > 0 ? ` · ${d.unknownCount} missing sample(s)` : ''}
        </li>
        <li className="muted small">4/3-Earth effective radius · OS Terrain 50 via Terrarium z12 · model rf-model-0.1.0</li>
      </ul>
    </div>
  );
}
