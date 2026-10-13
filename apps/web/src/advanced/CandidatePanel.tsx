/**
 * Advanced: candidate-site search (plan §5.2.5).
 *
 * Screening + evaluation run in the compute worker (bounded: at most
 * `maxCandidates` screened points, each evaluated against the nearest
 * repeaters within range). This panel drives the job and renders the ranked
 * result with its explainable factors.
 */
import type { CandidateGoal, RankedCandidate } from './candidates.js';

export interface CandidatesUiState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: { done: number; total: number } | null;
  candidates: Array<RankedCandidate & { lat: number; lon: number }>;
  screened: number;
  error: string | null;
}

interface Props {
  state: CandidatesUiState;
  goal: CandidateGoal;
  onGoal: (g: CandidateGoal) => void;
  onSearch: () => void;
  onView: (c: { lat: number; lon: number }) => void;
  onUseAsSite: (c: { lat: number; lon: number }) => void;
  disabled: boolean;
}

const GOALS: Array<{ id: CandidateGoal; label: string }> = [
  { id: 'reach', label: 'Reach' },
  { id: 'resilience', label: 'Resilience' },
  { id: 'balanced', label: 'Balanced' },
];

export function CandidatePanel({ state, goal, onGoal, onSearch, onView, onUseAsSite, disabled }: Props) {
  return (
    <div className="cand-panel">
      <div className="coverage-detail">
        <span className="muted small">Goal:</span>
        {GOALS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={goal === g.id ? 'detail-btn detail-btn--active' : 'detail-btn'}
            onClick={() => onGoal(g.id)}
          >
            {g.label}
          </button>
        ))}
        <button type="button" className="detail-btn" onClick={onSearch} disabled={disabled || state.status === 'running'}>
          {state.status === 'running' ? 'Searching…' : 'Find candidate sites'}
        </button>
      </div>
      {state.status === 'running' && state.progress ? (
        <p className="muted small">
          evaluating {state.progress.done}/{state.progress.total} screened candidates…
        </p>
      ) : null}
      {state.status === 'error' ? <div className="adv-error">Search failed: {state.error}</div> : null}
      {state.status === 'done' ? (
        <>
          <p className="muted small">
            {state.screened} high-ground candidates screened · top {state.candidates.length} evaluated and ranked
            (deterministic scoring; see factors below).
          </p>
          <ol className="cand-list">
            {state.candidates.map((c) => (
              <li key={c.id}>
                <div className="cand-row">
                  <span className="cand-rank">#{c.rank}</span>
                  <span className="cand-main">
                    <span className="mono">{c.id}</span> · {c.elevM.toFixed(0)} m ASL · score {c.score.toFixed(2)}
                  </span>
                  <button type="button" className="ghost small" onClick={() => onView(c)}>
                    View
                  </button>
                  <button type="button" className="ghost small" onClick={() => onUseAsSite(c)}>
                    Use as site
                  </button>
                </div>
                <div className="muted small">{c.explanation}</div>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
