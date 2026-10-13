/**
 * Saved plans + export/import (Stage 6). Local-first: plans persist in
 * IndexedDB, export works without any account, and nothing is uploaded
 * unless the visitor explicitly shares (separate flow).
 */
import { useCallback, useEffect, useState } from 'react';
import type { RfSettings } from '@ukmesh-planner/contracts';
import { deletePlan, listPlans, loadPlan, savePlan, type PlanSummary, type SerializedPlan } from './store.js';
import { exportPlanJSON, parsePlanJSON, planToCSV, planToGeoJSON, type ExportLink } from './io.js';
import type { Mode } from './planState.js';

interface Props {
  site: { lat: number; lon: number; antennaHeightAglM: number } | null;
  mode: Mode;
  rf: RfSettings;
  links: ExportLink[];
  onLoadPlan: (plan: SerializedPlan) => void;
}

function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PlanIoSection({ site, mode, rf, links, onLoadPlan }: Props) {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<PlanSummary[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listPlans().then(setSaved).catch(() => setSaved([]));
  }, []);
  useEffect(refresh, [refresh]);

  const currentPlan = (): SerializedPlan => ({
    version: 1,
    mode,
    site: site ? { lat: site.lat, lon: site.lon, antennaHeightAglM: site.antennaHeightAglM } : null,
    rf,
  });

  return (
    <div className="planio">
      <div className="planio-row">
        <input
          type="text"
          value={name}
          placeholder="Plan name"
          onChange={(e) => setName(e.target.value)}
          aria-label="Plan name"
        />
        <button
          type="button"
          className="detail-btn"
          disabled={!site}
          onClick={() => {
            void savePlan(name, currentPlan())
              .then(() => {
                setStatus('Saved to this browser.');
                setName('');
                refresh();
              })
              .catch(() => setStatus('Save failed (storage unavailable).'));
          }}
        >
          Save to this browser
        </button>
      </div>
      {saved.length > 0 ? (
        <ul className="planio-list">
          {saved.map((p) => (
            <li key={p.id}>
              <span className="planio-name">{p.name}</span>
              <span className="muted small">{new Date(p.savedAt).toLocaleString()}</span>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  void loadPlan(p.id).then((rec) => {
                    if (rec) {
                      onLoadPlan(rec.plan);
                      setStatus(`Loaded "${rec.name}".`);
                    }
                  });
                }}
              >
                Load
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  void deletePlan(p.id).then(() => {
                    refresh();
                    setStatus('Deleted.');
                  });
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No saved plans yet — plans you save stay in this browser.</p>
      )}
      <div className="coverage-detail">
        <span className="muted small">Export:</span>
        <button
          type="button"
          className="detail-btn"
          disabled={!site}
          onClick={() => site && download('ukmesh-plan.geojson', planToGeoJSON(site, links), 'application/geo+json')}
        >
          GeoJSON
        </button>
        <button
          type="button"
          className="detail-btn"
          disabled={!site || links.length === 0}
          onClick={() => site && download('ukmesh-links.csv', planToCSV(site, links), 'text/csv')}
        >
          CSV
        </button>
        <button
          type="button"
          className="detail-btn"
          onClick={() => download('ukmesh-plan.json', exportPlanJSON(currentPlan()), 'application/json')}
        >
          Plan JSON
        </button>
        <label className="detail-btn planio-import">
          Import
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void file.text().then((text) => {
                const res = parsePlanJSON(text);
                if (res.ok) {
                  onLoadPlan(res.plan);
                  setStatus('Imported plan.');
                } else {
                  setStatus(res.error);
                }
              });
            }}
          />
        </label>
      </div>
      {status ? <p className="muted small planio-status">{status}</p> : null}
    </div>
  );
}
