/**
 * Simple-journey result sheet: proposed site, antenna height, link summary,
 * top links and honest empty/blocked/no-terrain explanations.
 */
import type { PlannerRepeater } from '@ukmesh-planner/contracts';
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

const CLASS_ORDER: Record<string, number> = {
  likely: 0,
  marginal: 1,
  blocked: 2,
  unlikely: 3,
  'unknown-terrain': 4,
};

const CLASS_LABEL: Record<string, string> = {
  likely: 'likely',
  marginal: 'marginal',
  unlikely: 'unlikely',
  blocked: 'blocked',
  'unknown-terrain': 'terrain unknown',
};

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
  showAllLinks: boolean;
  canUndo: boolean;
  onToggleShowAll: (v: boolean) => void;
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

const COVERAGE_DETAIL_LABEL: Record<CoverageDetail, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

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

  const counts: Record<string, number> = {};
  for (const r of assess.results) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  const drawn = assess.results.filter((r) =>
    r.classification === 'likely' || r.classification === 'marginal' || r.classification === 'blocked',
  );
  const sorted = [...assess.results].sort((a, b) => {
    const ca = CLASS_ORDER[a.classification] ?? 9;
    const cb = CLASS_ORDER[b.classification] ?? 9;
    if (ca !== cb) return ca - cb;
    return (b.marginDb ?? -999) - (a.marginDb ?? -999);
  });
  const top = sorted.slice(0, 12);

  let explanation: string | null = null;
  if (assess.status === 'done') {
    const likelyOrMarginal = (counts['likely'] ?? 0) + (counts['marginal'] ?? 0);
    if (assess.totalWithinRange === 0) {
      explanation = `No repeaters within the modelled range (${props.maxRangeKm} km).`;
    } else if (likelyOrMarginal === 0 && (counts['blocked'] ?? 0) > 0) {
      // SIMPLE-04: terrain blockage must be stated as blockage, never as
      // "no nodes" — this fires whenever no clear path exists, even though
      // the blocked links themselves are still drawn.
      explanation = 'Every path within range is blocked by terrain — try a higher antenna height or a nearby high point.';
    } else if (likelyOrMarginal === 0 && (counts['unknown-terrain'] ?? 0) > 0) {
      explanation = 'Terrain data is unavailable along the paths within range — no honest prediction is possible here.';
    } else if (likelyOrMarginal === 0 && drawn.length === 0) {
      explanation = 'No clear paths within modelled range.';
    }
  }

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
          <div className="chips">
            {(['likely', 'marginal', 'blocked', 'unlikely', 'unknown-terrain'] as const).map((c) =>
              (counts[c] ?? 0) > 0 ? (
                <span key={c} className={`chip chip--${c}`}>
                  {CLASS_LABEL[c]} <strong>{counts[c]}</strong>
                </span>
              ) : null,
            )}
          </div>

          {explanation ? <p className="explanation">{explanation}</p> : null}

          {assess.evaluated < assess.totalWithinRange ? (
            <p className="muted small">
              Evaluated the nearest {assess.evaluated} of {assess.totalWithinRange} repeaters within range.
            </p>
          ) : null}

          {assess.missingTerrain > 0 ? (
            <p className="muted small">
              Missing terrain along {assess.missingTerrain} path{assess.missingTerrain === 1 ? '' : 's'} —
              reported as “terrain unknown”, never as a green link.
            </p>
          ) : null}

          {top.length > 0 ? (
            <ul className="top-links">
              {top.map((r) => {
                const rep = props.repeatersById.get(r.targetId);
                return (
                  <li key={r.targetId}>
                    <button type="button" className="link-row" onClick={() => props.onFocusRepeater(r.targetId)}>
                      <span className={`dot dot--${r.classification}`} aria-hidden="true" />
                      <span className="link-name">{rep?.name ?? r.name ?? r.targetId.slice(0, 8)}</span>
                      <span className="muted mono">{r.distanceKm.toFixed(1)} km</span>
                      <span className="muted mono">{r.marginDb !== null ? `${r.marginDb.toFixed(0)} dB` : '—'}</span>
                      <span className={`chip chip--${r.classification}`}>{CLASS_LABEL[r.classification]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <label className="showall">
            <input
              type="checkbox"
              checked={props.showAllLinks}
              onChange={(e) => props.onToggleShowAll(e.target.checked)}
            />
            Show blocked links (red)
          </label>

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
                    Coverage on {props.coverageState.backend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (fallback)'} in{' '}
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
            Predictions use the documented RF model (868 MHz · 22 dBm · assumed 2 m AGL) over
            OS Terrain 50 — a model, not a survey.
          </p>
        </>
      ) : null}
    </section>
  );
}
