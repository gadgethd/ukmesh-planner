/**
 * Simple-journey result sheet: proposed site, antenna height, predicted links
 * and honest empty explanations.
 *
 * Link display mirrors the live MeshCore neighbours map (the thing people
 * actually use): only links at or better than the amber threshold (129.5 dB)
 * are shown — in the live map's palette, ordered best (lowest loss) first —
 * and each row reads "● Name · 9.5 km · 111 dB". Non-viable paths are not
 * shown at all (Ben's rule; also the live map's own behaviour).
 */
import type { PlannerRepeater } from '@ukmesh-planner/contracts';
import { mapLinkBand, type MapLinkBand } from '@ukmesh-planner/rf-core';
import type { AssessedLink } from '../compute/assess.worker.js';
import type { CoverageDetail } from '../compute/coverage/params.js';

export interface SiteState {
  lat: number;
  lon: number;
  antennaHeightAglM: number;
}

export interface AssessUiState {
  status: 'idle' | 'running' | 'done' | 'error';
  results: AssessedLink[];
  siteElevationM: number | null;
  elapsedMs: number | null;
  totalWithinRange: number;
  evaluated: number;
  missingTerrain: number;
  error: string | null;
}

export interface CoverageUiState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: { done: number; total: number } | null;
  backend: string | null;
  counts: number[] | null;
  elapsedMs: number | null;
  notices: string[];
  error: string | null;
}

interface Props {
  site: SiteState | null;
  assess: AssessUiState;
  repeatersById: Map<string, PlannerRepeater>;
  maxRangeKm: number;
  canUndo: boolean;
  onHeightChange: (h: number) => void;
  onClear: () => void;
  onUndo: () => void;
  onFocusRepeater: (id: string) => void;
  coverageOn: boolean;
  coverageDetail: CoverageDetail;
  coverageState: CoverageUiState;
  onToggleCoverage: (on: boolean) => void;
  onCoverageDetail: (d: CoverageDetail) => void;
}

/** Strip corrupted bytes some node names carry over the air. */
function cleanDisplayName(name: string): string {
  const cleaned = name.replace(/\uFFFD+/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : name;
}

const COVERAGE_DETAIL_LABEL: Record<CoverageDetail, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** The live map's display convention: viable links only, best first. */
function viableLinks(results: AssessedLink[]): Array<{ link: AssessedLink; band: MapLinkBand }> {
  const out: Array<{ link: AssessedLink; band: MapLinkBand }> = [];
  for (const r of results) {
    const band = mapLinkBand(r.itmPathLossDb);
    if (band !== null) out.push({ link: r, band });
  }
  out.sort((a, b) => (a.link.itmPathLossDb ?? 999) - (b.link.itmPathLossDb ?? 999));
  return out;
}

export function ResultSheet(props: Props) {
  const { site, assess } = props;

  if (!site) {
    return (
      <section className="sheet sheet--hint" aria-live="polite">
        <h2>Test a repeater site</h2>
        <p className="cue">
          <strong>Click or tap anywhere on the map</strong> to place a proposed
          repeater — its predicted links to existing UK Mesh repeaters appear
          straight away.
        </p>
        <p className="muted">
          No account, no setup. Drag the marker to try another spot.
        </p>
      </section>
    );
  }

  const links = viableLinks(assess.results);

  return (
    <section className="sheet" aria-live="polite">
      <div className="sheet-head">
        <h2>Proposed site</h2>
        <div className="sheet-actions">
          <button type="button" onClick={props.onUndo} disabled={!props.canUndo}>
            Undo
          </button>
          <button type="button" onClick={props.onClear}>
            Clear
          </button>
        </div>
      </div>

      <p className="muted mono">
        {site.lat.toFixed(5)}, {site.lon.toFixed(5)} · terrain{' '}
        {assess.siteElevationM !== null ? `${Math.round(assess.siteElevationM)} m ASL` : 'unknown'}
      </p>

      <label className="height-row">
        <span>Antenna height (m AGL)</span>
        <input
          type="number"
          min={0}
          max={200}
          step={1}
          value={site.antennaHeightAglM}
          onChange={(e) => props.onHeightChange(Number(e.target.value))}
        />
      </label>

      {assess.status === 'running' ? (
        <p className="status">
          <span className="spinner" aria-hidden="true" /> Evaluating {assess.evaluated || assess.totalWithinRange || '…'} candidate
          repeater{assess.totalWithinRange === 1 ? '' : 's'}…
        </p>
      ) : null}

      {assess.status === 'error' ? (
        <p className="status status--error" role="alert">
          Evaluation failed: {assess.error}
        </p>
      ) : null}

      {assess.status === 'done' ? (
        <>
          <div className="links-head">
            <h3>Predicted links ({links.length})</h3>
          </div>

          {links.length === 0 ? (
            <p className="explanation">
              {assess.missingTerrain > 0 && assess.evaluated === assess.missingTerrain
                ? 'Terrain data is unavailable along the paths within range — no honest prediction is possible here.'
                : 'No viable links to nearby repeaters — try a higher antenna height or a nearby high point.'}
            </p>
          ) : (
            <ul className="top-links">
              {links.map(({ link, band }) => {
                const rep = props.repeatersById.get(link.targetId);
                return (
                  <li key={link.targetId}>
                    <button type="button" className="link-row" onClick={() => props.onFocusRepeater(link.targetId)}>
                      <span className={`dot dot--${band}`} aria-hidden="true">●</span>
                      <span className="link-name">
                        {cleanDisplayName(rep?.name ?? link.name ?? link.targetId.slice(0, 8))}
                      </span>
                      <span className="link-meta mono">
                        {link.distanceKm.toFixed(1)} km &middot; {Math.round(link.itmPathLossDb ?? 0)} dB
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {assess.evaluated < assess.totalWithinRange ? (
            <p className="muted small">
              Evaluated the nearest {assess.evaluated} of {assess.totalWithinRange} repeaters within range.
            </p>
          ) : null}

          {assess.missingTerrain > 0 && links.length > 0 ? (
            <p className="muted small">
              Missing terrain along {assess.missingTerrain} path{assess.missingTerrain === 1 ? '' : 's'} —
              those paths are excluded, never shown as a link.
            </p>
          ) : null}

          <div className="coverage-block">
            <label className="showall">
              <input
                type="checkbox"
                checked={props.coverageOn}
                onChange={(e) => props.onToggleCoverage(e.target.checked)}
              />
              Show coverage preview (50 × 50 km, bounded)
            </label>
            {props.coverageOn ? (
              <div className="coverage-body">
                <div className="coverage-detail">
                  <span className="muted small">Detail:</span>
                  {(['low', 'medium', 'high'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={props.coverageDetail === d ? 'detail-btn detail-btn--active' : 'detail-btn'}
                      onClick={() => props.onCoverageDetail(d)}
                    >
                      {COVERAGE_DETAIL_LABEL[d]}
                    </button>
                  ))}
                </div>
                {props.coverageState.status === 'running' ? (
                  <p className="status">
                    <span className="spinner" aria-hidden="true" /> Computing coverage
                    {props.coverageState.progress
                      ? ` — ${Math.round((props.coverageState.progress.done / props.coverageState.progress.total) * 100)}%`
                      : '…'}
                    {props.coverageState.backend ? ` (${props.coverageState.backend})` : ''}
                  </p>
                ) : null}
                {props.coverageState.status === 'done' && props.coverageState.counts ? (
                  <p className="muted small">
                    Coverage on {props.coverageState.backend === 'webgpu' ? 'GPU (WebGPU)' : props.coverageState.backend === 'wasm' ? 'CPU (WebAssembly)' : 'CPU (JavaScript fallback)'} in{' '}
                    {props.coverageState.elapsedMs !== null ? `${Math.round(props.coverageState.elapsedMs)} ms` : '—'} ·{' '}
                    likely {props.coverageState.counts[0] ?? 0} · marginal {props.coverageState.counts[1] ?? 0} · blocked{' '}
                    {props.coverageState.counts[3] ?? 0} · unknown {props.coverageState.counts[4] ?? 0}
                  </p>
                ) : null}
                {props.coverageState.notices.map((n, i) => (
                  <p className="muted small" key={i}>
                    {n}
                  </p>
                ))}
                {props.coverageState.status === 'error' ? (
                  <p className="status status--error">Coverage failed: {props.coverageState.error}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <p className="muted small">
            {assess.elapsedMs !== null ? `Evaluated in ${Math.round(assess.elapsedMs)} ms. ` : ''}
            Same ITM model as the live network (868 MHz · 22 dBm · antenna {site.antennaHeightAglM} m AGL)
            over OS Terrain 50 — a model, not a survey.
          </p>
        </>
      ) : null}
    </section>
  );
}
