import { useEffect, useState } from 'react';

interface ApiConfig {
  bounds: [number, number, number, number];
  modelVersion: string;
  datasetVersion: string | null;
  computeBackends: string[];
  snapshot: unknown;
}

/**
 * Stage 1 bootstrap shell. The MapLibre map, planning flow and compute
 * workers arrive in Stages 3–4 on top of this frame.
 */
export function App() {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c: ApiConfig) => setConfig(c))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1 style={{ marginBottom: '0.25rem' }}>UK Mesh Planner</h1>
      <p style={{ color: '#555' }}>
        Test a hypothetical repeater site against the live UK Mesh network.
      </p>
      <p>
        <strong>Stage 1 foundation</strong> — the interactive map and planning
        tools land here next.
      </p>
      {error ? (
        <p role="alert" style={{ color: '#b00020' }}>
          API unavailable: {error}
        </p>
      ) : null}
      {config ? (
        <ul style={{ color: '#333' }}>
          <li>model: {config.modelVersion}</li>
          <li>compute: {config.computeBackends.join(', ')}</li>
          <li>
            bounds: [{config.bounds.map((v) => v.toFixed(1)).join(', ')}]
          </li>
        </ul>
      ) : null}
    </main>
  );
}
