/**
 * UK Mesh Planner — Simple journey (Stage 3).
 *
 * One map, one planned site, immediate predicted-link feedback. All RF
 * computation runs in the visitor's browser (worker); the API only serves
 * planner-owned snapshot data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_UK_RF_SETTINGS,
  type PlannerRepeater,
  type SnapshotMeta,
} from '@ukmesh-planner/contracts';
import { haversineDistanceM } from '@ukmesh-planner/rf-core';
import type { FeatureCollection, LineString } from 'geojson';
import { MapView } from './map/mapView.js';
import { ComputeClient } from './compute/client.js';
import { CoverageClient, type CoverageProgressMessage, type CoverageResultMessage } from './compute/coverage/client.js';
import type { CoverageDetail } from './compute/coverage/params.js';
import { ResultSheet, type AssessUiState, type SiteState } from './simple/ResultSheet.js';

const MAX_EVALUATED = 300;
const DEBOUNCE_MS = 300;
const UK_BOUNDS: [number, number, number, number] = [-8.5, 50.0, 2.0, 59.4];

const EMPTY_ASSESS: AssessUiState = {
  status: 'idle',
  results: [],
  siteElevationM: null,
  elapsedMs: null,
  totalWithinRange: 0,
  evaluated: 0,
  missingTerrain: 0,
  error: null,
};

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const clientRef = useRef<ComputeClient | null>(null);
  const handlersRef = useRef({
    onSite: (_s: SiteState, _opts: { pushUndo: boolean; debounced: boolean; moveMarker: boolean }) => {},
  });
  const timerRef = useRef<number | null>(null);
  const latestJobRef = useRef(0);
  const siteRef = useRef<SiteState | null>(null);
  const undoStackRef = useRef<SiteState[]>([]);
  const coverageClientRef = useRef<CoverageClient | null>(null);
  const coverageJobRef = useRef(0);
  const coverageOnRef = useRef(false);
  const runCoverageRef = useRef<(s: SiteState) => void>(() => {});

  const [snapshot, setSnapshot] = useState<SnapshotMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repeatersById, setRepeatersById] = useState<Map<string, PlannerRepeater>>(new Map());
  const [repeaterCount, setRepeaterCount] = useState(0);
  const [site, setSite] = useState<SiteState | null>(null);
  const [undoStack, setUndoStack] = useState<SiteState[]>([]);
  const [assess, setAssess] = useState<AssessUiState>(EMPTY_ASSESS);
  const [showAllLinks, setShowAllLinks] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [legendOpen, setLegendOpen] = useState(false);
  const [coverageOn, setCoverageOn] = useState(false);
  const [coverageDetail, setCoverageDetail] = useState<CoverageDetail>('medium');
  const [coverageState, setCoverageState] = useState<{
    status: 'idle' | 'running' | 'done' | 'error';
    progress: { done: number; total: number } | null;
    backend: string | null;
    counts: number[] | null;
    elapsedMs: number | null;
    notices: string[];
    error: string | null;
  }>({ status: 'idle', progress: null, backend: null, counts: null, elapsedMs: null, notices: [], error: null });

  const rf = DEFAULT_UK_RF_SETTINGS;

  // --- data load -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, repRes] = await Promise.all([
          fetch('/api/v1/config'),
          fetch('/api/v1/repeaters?limit=20000'),
        ]);
        if (!cfgRes.ok) throw new Error(`config ${cfgRes.status}`);
        if (!repRes.ok) throw new Error(`repeaters ${repRes.status}`);
        const cfg = (await cfgRes.json()) as { snapshot: SnapshotMeta | null };
        const page = (await repRes.json()) as { items: PlannerRepeater[]; nextCursor: string | null };
        if (cancelled) return;
        setSnapshot(cfg.snapshot);
        setRepeatersById(new Map(page.items.map((r) => [r.canonicalId, r])));
        setRepeaterCount(page.items.length);
        viewRef.current?.setRepeaters(page.items);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- map + worker bootstrap ---------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new MapView(containerRef.current, UK_BOUNDS, {
      onMapClick: (ll) =>
        handlersRef.current.onSite(
          { lat: ll.lat, lon: ll.lng, antennaHeightAglM: 2 },
          { pushUndo: true, debounced: true, moveMarker: true },
        ),
      onSiteDrag: (ll) =>
        handlersRef.current.onSite(
          { lat: ll.lat, lon: ll.lng, antennaHeightAglM: 2 },
          { pushUndo: false, debounced: false, moveMarker: false },
        ),
      onSiteDragEnd: (ll) =>
        handlersRef.current.onSite(
          { lat: ll.lat, lon: ll.lng, antennaHeightAglM: 2 },
          { pushUndo: true, debounced: true, moveMarker: false },
        ),
    });
    viewRef.current = view;
    const client = new ComputeClient();
    clientRef.current = client;
    const coverageClient = new CoverageClient();
    coverageClientRef.current = coverageClient;
    return () => {
      client.terminate();
      coverageClient.terminate();
      view.map.remove();
      viewRef.current = null;
      clientRef.current = null;
      coverageClientRef.current = null;
    };
  }, []);

  // --- assessment pipeline -------------------------------------------------
  const runAssess = useCallback(
    (s: SiteState) => {
      const client = clientRef.current;
      if (!client) return;
      const all = [...repeatersById.values()];
      const within = all
        .map((r) => ({ r, d: haversineDistanceM({ lat: s.lat, lon: s.lon }, { lat: r.lat, lon: r.lon }) }))
        .filter((x) => x.d <= rf.maxRangeKm * 1000)
        .sort((a, b) => a.d - b.d);
      const candidates = within.slice(0, MAX_EVALUATED).map((x) => ({
        id: x.r.canonicalId,
        name: x.r.name,
        lat: x.r.lat,
        lon: x.r.lon,
      }));
      const total = within.length;
      setAssess((prev) => ({ ...prev, status: 'running', totalWithinRange: total, evaluated: candidates.length }));

      const handle = client.startAssess(
        { lat: s.lat, lon: s.lon, antennaHeightAglM: s.antennaHeightAglM },
        candidates,
        rf,
      );
      latestJobRef.current = handle.jobId;
      handle.done
        .then((res) => {
          if (latestJobRef.current !== handle.jobId) return; // superseded by a newer site
          setAssess({
            status: 'done',
            results: res.results,
            siteElevationM: res.siteElevationM,
            elapsedMs: res.elapsedMs,
            totalWithinRange: total,
            evaluated: res.results.length,
            missingTerrain: res.missingTerrain,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (latestJobRef.current !== handle.jobId) return;
          setAssess((prev) => ({
            ...prev,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          }));
        });
    },
    [repeatersById, rf],
  );

  const scheduleAssess = useCallback(
    (s: SiteState) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        runAssess(s);
        if (coverageOnRef.current) runCoverageRef.current(s);
      }, DEBOUNCE_MS);
    },
    [runAssess],
  );

  const runCoverage = useCallback(
    (s: SiteState) => {
      const client = coverageClientRef.current;
      if (!client) return;
      setCoverageState((prev) => ({ ...prev, status: 'running', progress: null, error: null }));
      const handle = client.start(
        { site: { lat: s.lat, lon: s.lon, antennaHeightAglM: s.antennaHeightAglM }, detail: coverageDetail, rf },
        (p: CoverageProgressMessage) => {
          if (coverageJobRef.current !== p.jobId) return;
          setCoverageState((prev) => ({ ...prev, progress: { done: p.done, total: p.total }, backend: p.backend }));
        },
      );
      coverageJobRef.current = handle.jobId;
      handle.done
        .then((res: CoverageResultMessage) => {
          if (coverageJobRef.current !== handle.jobId) return;
          setCoverageState({
            status: 'done',
            progress: { done: res.geometry.width * res.geometry.height, total: res.geometry.width * res.geometry.height },
            backend: res.backend,
            counts: res.counts,
            elapsedMs: res.elapsedMs,
            notices: res.notices,
            error: null,
          });
          void viewRef.current?.setCoverage({
            bounds: res.geometry.bounds,
            width: res.geometry.width,
            height: res.geometry.height,
            codes: res.codes,
          });
        })
        .catch((err: unknown) => {
          if (coverageJobRef.current !== handle.jobId) return;
          setCoverageState((prev) => ({ ...prev, status: 'error', error: err instanceof Error ? err.message : String(err) }));
        });
    },
    [coverageDetail, rf],
  );

  useEffect(() => {
    runCoverageRef.current = runCoverage;
  }, [runCoverage]);

  const applySite = useCallback(
    (next: SiteState, opts: { pushUndo: boolean; debounced: boolean; moveMarker: boolean }) => {
      const prev = siteRef.current;
      if (opts.pushUndo && prev && (prev.lat !== next.lat || prev.lon !== next.lon)) {
        const st = [...undoStackRef.current.slice(-9), prev];
        undoStackRef.current = st;
        setUndoStack(st);
      }
      siteRef.current = next;
      setSite(next);
      if (opts.moveMarker) viewRef.current?.setPlannedSite({ lng: next.lon, lat: next.lat });
      if (opts.debounced) scheduleAssess(next);
    },
    [scheduleAssess],
  );

  // map callbacks stay pointed at fresh state without re-creating the map
  handlersRef.current.onSite = (s, opts) => applySite(s, opts);

  const clearSite = useCallback(() => {
    const prev = siteRef.current;
    if (prev) {
      const st = [...undoStackRef.current.slice(-9), prev];
      undoStackRef.current = st;
      setUndoStack(st);
    }
    siteRef.current = null;
    setSite(null);
    setAssess(EMPTY_ASSESS);
    viewRef.current?.setPlannedSite(null);
    viewRef.current?.setLinks({ type: 'FeatureCollection', features: [] });
    coverageJobRef.current = 0; // discard in-flight coverage
    void viewRef.current?.setCoverage(null);
    setCoverageState({ status: 'idle', progress: null, backend: null, counts: null, elapsedMs: null, notices: [], error: null });
  }, []);

  const undo = useCallback(() => {
    const st = undoStackRef.current;
    const prev = st[st.length - 1];
    if (!prev) return;
    undoStackRef.current = st.slice(0, -1);
    setUndoStack(undoStackRef.current);
    siteRef.current = prev;
    setSite(prev);
    viewRef.current?.setPlannedSite({ lng: prev.lon, lat: prev.lat });
    runAssess(prev);
  }, [runAssess]);

  const changeHeight = useCallback(
    (h: number) => {
      if (!Number.isFinite(h) || h < 0 || h > 200) return;
      const cur = siteRef.current;
      if (!cur) return;
      applySite({ ...cur, antennaHeightAglM: h }, { pushUndo: false, debounced: true, moveMarker: false });
    },
    [applySite],
  );

  // --- link drawing --------------------------------------------------------
  const linkFeatures = useMemo((): FeatureCollection<LineString> => {
    if (!site) return { type: 'FeatureCollection', features: [] };
    const visible = assess.results.filter((r) => {
      if (r.classification === 'likely' || r.classification === 'marginal' || r.classification === 'blocked') {
        return true;
      }
      return showAllLinks;
    });
    return {
      type: 'FeatureCollection',
      features: visible
        .map((r) => {
          const rep = repeatersById.get(r.targetId);
          if (!rep) return null;
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [site.lon, site.lat],
                [rep.lon, rep.lat],
              ],
            },
            properties: { classification: r.classification, id: r.targetId },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    };
  }, [site, assess.results, showAllLinks, repeatersById]);

  useEffect(() => {
    viewRef.current?.setLinks(linkFeatures);
  }, [linkFeatures]);

  useEffect(() => {
    viewRef.current?.setTheme(theme);
  }, [theme]);

  // --- debug hook (used by end-to-end smoke tests) -------------------------
  useEffect(() => {
    (window as unknown as { __plannerMap?: unknown }).__plannerMap = viewRef.current?.map ?? null;
    (window as unknown as { __planner?: unknown }).__planner = {
      snapshot,
      repeaterCount,
      site,
      assess: {
        status: assess.status,
        counts: assess.results.reduce<Record<string, number>>((acc, r) => {
          acc[r.classification] = (acc[r.classification] ?? 0) + 1;
          return acc;
        }, {}),
        evaluated: assess.evaluated,
        totalWithinRange: assess.totalWithinRange,
        siteElevationM: assess.siteElevationM,
      },
      linksDrawn: linkFeatures.features.length,
      map: viewRef.current?.getState() ?? null,
      coverage: {
        on: coverageOn,
        detail: coverageDetail,
        status: coverageState.status,
        backend: coverageState.backend,
        counts: coverageState.counts,
        progress: coverageState.progress,
        notices: coverageState.notices,
      },
    };
  }, [snapshot, repeaterCount, site, assess, linkFeatures, coverageOn, coverageDetail, coverageState]);

  const snapshotAge = snapshot
    ? `${Math.max(0, Math.round((Date.now() - Date.parse(snapshot.fetchedAt)) / 60000))} min ago`
    : null;

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>UK Mesh Planner</h1>
        </div>
        <div className="topbar-meta">
          {loadError ? (
            <span className="status--error">data load failed: {loadError}</span>
          ) : snapshot ? (
            <span className="muted small">
              data: gen {snapshot.generation} · {repeaterCount.toLocaleString()} repeaters · fetched {snapshotAge}
            </span>
          ) : (
            <span className="muted small">loading repeaters…</span>
          )}
          <button type="button" className="ghost" onClick={() => setLegendOpen((v) => !v)}>
            Legend
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>

      {legendOpen ? (
        <aside className="legend">
          <h3>Existing repeaters</h3>
          <ul>
            <li><span className="swatch" style={{ background: '#15803d' }} /> seen &lt; 24 h</li>
            <li><span className="swatch" style={{ background: '#65a30d' }} /> seen &lt; 7 d</li>
            <li><span className="swatch" style={{ background: '#d97706' }} /> seen &lt; 28 d</li>
            <li><span className="swatch" style={{ background: '#9ca3af' }} /> long-unseen</li>
          </ul>
          <h3>Predicted links</h3>
          <ul>
            <li><span className="swatch" style={{ background: '#15803d' }} /> likely (solid)</li>
            <li><span className="swatch" style={{ background: '#d97706' }} /> marginal (dashed)</li>
            <li><span className="swatch" style={{ background: '#dc2626' }} /> blocked (dashed)</li>
            <li><span className="swatch" style={{ background: '#94a3b8' }} /> unlikely (thin, optional)</li>
            <li><span className="swatch" style={{ background: '#9333ea' }} /> terrain unknown</li>
          </ul>
          <p className="muted small">Clusters show counts at low zoom; zoom in for individual repeaters.</p>
        </aside>
      ) : null}

      <div ref={containerRef} className="map" />

      <ResultSheet
        site={site}
        assess={assess}
        repeatersById={repeatersById}
        maxRangeKm={rf.maxRangeKm}
        showAllLinks={showAllLinks}
        canUndo={undoStack.length > 0}
        onToggleShowAll={setShowAllLinks}
        onHeightChange={changeHeight}
        onClear={clearSite}
        onUndo={undo}
        coverageOn={coverageOn}
        coverageDetail={coverageDetail}
        coverageState={coverageState}
        onToggleCoverage={(on) => {
          coverageOnRef.current = on;
          setCoverageOn(on);
          if (on) {
            const cur = siteRef.current;
            if (cur) runCoverage(cur);
          } else {
            coverageJobRef.current = 0;
            void viewRef.current?.setCoverage(null);
            setCoverageState({ status: 'idle', progress: null, backend: null, counts: null, elapsedMs: null, notices: [], error: null });
          }
        }}
        onCoverageDetail={(d) => {
          setCoverageDetail(d);
          const cur = siteRef.current;
          if (cur && coverageOnRef.current) {
            // rerun with the new detail — runCoverageRef updates next render
            window.setTimeout(() => runCoverageRef.current(cur), 0);
          }
        }}
        onFocusRepeater={(id) => {
          const rep = repeatersById.get(id);
          if (rep) viewRef.current?.flyToSite({ lng: rep.lon, lat: rep.lat });
        }}
      />
    </div>
  );
}
