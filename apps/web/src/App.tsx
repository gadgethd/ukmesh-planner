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
  type PlannerObservedLink,
  type PlannerRepeater,
  type RfSettings,
  type SnapshotMeta,
} from '@ukmesh-planner/contracts';
import { haversineDistanceM, mapLinkBand } from '@ukmesh-planner/rf-core';
import { isActive } from './lib/freshness.js';
import type { FeatureCollection, LineString } from 'geojson';
import { MapView } from './map/mapView.js';
import { ComputeClient } from './compute/client.js';
import { CoverageClient, type CoverageProgressMessage, type CoverageResultMessage } from './compute/coverage/client.js';
import type { CoverageDetail } from './compute/coverage/params.js';
import { ResultSheet, type AssessUiState, type SiteState } from './simple/ResultSheet.js';
import { ProfilePanel, type ProfileUiState } from './advanced/ProfilePanel.js';
import { RfEditor } from './advanced/RfEditor.js';
import { TopologyPanel } from './advanced/TopologyPanel.js';
import { PlanIoSection } from './plan/PlanIoSection.js';
import { fetchShare, shareIdFromHash } from './plan/shareClient.js';
import { parsePlanJSON } from './plan/io.js';
import type { SerializedPlan } from './plan/store.js';
import { CandidatePanel, type CandidatesUiState } from './advanced/CandidatePanel.js';
import {
  removalImpact as computeRemovalImpact,
  stats as computeTopoStats,
  type TopoEdge,
  type TopoNode,
} from './advanced/topology.js';
import type { CandidateGoal } from './advanced/candidates.js';
import type { Link3DPath } from './map/linkLayer3D.js';
import type { Mode, ProfilePair } from './plan/planState.js';

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
  const [is3d, setIs3d] = useState(false);
  const calibrationRef = useRef<{ usablePathLossDb: number } | null>(null);
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

  const [mode, setMode] = useState<Mode>('simple');
  const [observedLinks, setObservedLinks] = useState<PlannerObservedLink[]>([]);
  const observedLoadedRef = useRef<string | null>(null);
  const [removalId, setRemovalId] = useState<string | null>(null);
  const [shareBanner, setShareBanner] = useState<
    | { kind: 'offer'; plan: SerializedPlan; expiresAt: string }
    | { kind: 'problem'; message: string }
    | null
  >(null);
  const [candGoal, setCandGoal] = useState<CandidateGoal>('balanced');
  const [candidatesState, setCandidatesState] = useState<CandidatesUiState>({
    status: 'idle',
    progress: null,
    candidates: [],
    screened: 0,
    error: null,
  });
  const candidatesJobRef = useRef(0);
  const [rf, setRf] = useState<RfSettings>({ ...DEFAULT_UK_RF_SETTINGS });
  const [profilePair, setProfilePair] = useState<ProfilePair | null>(null);
  const [profileState, setProfileState] = useState<ProfileUiState>({ status: 'idle', data: null, error: null });
  const profileJobRef = useRef(0);

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
        // Only nodes active on the network recently (Ben, 2026-10-13):
        // dead repeaters must not appear on the map or in assessments.
        const active = page.items.filter((r) => isActive(r.lastSeen));
        setRepeatersById(new Map(active.map((r) => [r.canonicalId, r])));
        setRepeaterCount(active.length);
        viewRef.current?.setRepeaters(active);
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

  // Calibrated MeshCore-convention thresholds (from the snapshot's observed
  // links); fetched once, tolerated failure -> model defaults.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/calibration');
        if (!res.ok) return;
        const body = (await res.json()) as { usablePathLossDb: number };
        if (!cancelled && Number.isFinite(body.usablePathLossDb)) {
          calibrationRef.current = { usablePathLossDb: body.usablePathLossDb };
        }
      } catch {
        /* defaults apply */
      }
    })();
    return () => {
      cancelled = true;
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
      // Identity aliases (the same physical node under several keys, often
      // with corrupted name bytes) would otherwise flood the link list — the
      // live system merges aliases; do the same, two passes:
      //   1. same name within ~110 m (alias pins of one site);
      //   2. brokered/duplicated records at the exact same position (~11 m).
      // Keep the cleanest-named representative for each cluster.
      type Scored = { r: PlannerRepeater; d: number };
      const aliasScore = (r: PlannerRepeater): number =>
        (r.name && !r.name.includes('\uFFFD') ? 1_000_000 : 0) + (r.name?.length ?? 0);
      const cleanKey = (name: string): string =>
        name.replace(/\uFFFD+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const mergeInto = (map: Map<string, Scored>, key: string, x: Scored): void => {
        const prev = map.get(key);
        if (!prev || aliasScore(x.r) > aliasScore(prev.r)) map.set(key, x);
      };
      let pass: Scored[] = within;
      if (within.some((x) => x.r.name)) {
        // Same cleaned name clustered by PROXIMITY (~500 m) — a grid key
        // misses aliases that straddle a cell boundary (GNOME-STKTN-RPT-V4
        // appeared twice at 40 m apart, Ben 2026-10-14).
        const ALIAS_RADIUS_M = 500;
        const byName = new Map<string, Scored[]>();
        for (const x of within) {
          const key = x.r.name ? cleanKey(x.r.name) : `anon|${x.r.canonicalId}`;
          const list = byName.get(key);
          if (list) list.push(x);
          else byName.set(key, [x]);
        }
        const merged: Scored[] = [];
        for (const [key, list] of byName) {
          if (key.startsWith('anon|')) {
            merged.push(...list);
            continue;
          }
          const clusters: Scored[][] = [];
          for (const x of list) {
            const cl = clusters.find((c) =>
              c.some(
                (y) =>
                  haversineDistanceM({ lat: x.r.lat, lon: x.r.lon }, { lat: y.r.lat, lon: y.r.lon }) <=
                  ALIAS_RADIUS_M,
              ),
            );
            if (cl) cl.push(x);
            else clusters.push([x]);
          }
          for (const cl of clusters) {
            merged.push(cl.reduce((best, x) => (aliasScore(x.r) > aliasScore(best.r) ? x : best)));
          }
        }
        pass = merged;
      }
      const byPos = new Map<string, Scored>();
      for (const x of pass) mergeInto(byPos, `${x.r.lat.toFixed(4)}|${x.r.lon.toFixed(4)}`, x);
      const deduped = [...byPos.values()].sort((a, b) => a.d - b.d);
      const candidates = deduped.slice(0, MAX_EVALUATED).map((x) => ({
        id: x.r.canonicalId,
        name: x.r.name,
        lat: x.r.lat,
        lon: x.r.lon,
      }));
      const total = deduped.length;
      setAssess((prev) => ({
        ...prev,
        status: 'running',
        results: [],
        siteElevationM: null,
        elapsedMs: null,
        missingTerrain: 0,
        error: null,
        totalWithinRange: total,
        evaluated: candidates.length,
      }));

      const handle = client.startAssess(
        { lat: s.lat, lon: s.lon, antennaHeightAglM: s.antennaHeightAglM },
        candidates,
        rf,
        calibrationRef.current?.usablePathLossDb,
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
      if (!client || document.hidden) return;
      void viewRef.current?.setCoverage(null);
      setCoverageState((prev) => ({ ...prev, status: 'running', progress: null, error: null }));
      const handle = client.start(
        {
          site: { lat: s.lat, lon: s.lon, antennaHeightAglM: s.antennaHeightAglM },
          detail: coverageDetail,
          rf,
          // Debug/testing override (used by the WebGPU parity harness): lets a
          // forced backend drive the UI without changing production defaults.
          forceBackend: (window as unknown as { __plannerForceBackend?: 'webgpu' | 'wasm' | 'cpu' | null })
            .__plannerForceBackend ?? null,
        },
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

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) {
        coverageJobRef.current = 0;
        coverageClientRef.current?.cancel();
        if (coverageOnRef.current) {
          void viewRef.current?.setCoverage(null);
          setCoverageState((prev) => ({
            ...prev, status: 'idle', progress: null,
            notices: ['Coverage paused while this tab is hidden; it resumes when you return.'],
          }));
        }
      } else if (coverageOnRef.current && siteRef.current) {
        runCoverageRef.current(siteRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

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
      // Stale links must not linger while the new assessment runs (Ben
      // 2026-10-14): drop the previous results and drawn links the moment
      // the site moves — the sheet shows the evaluating spinner instead.
      setAssess(EMPTY_ASSESS);
      viewRef.current?.setLinks3D([]);
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
    viewRef.current?.setLinks3D([]);
    coverageJobRef.current = 0; // discard in-flight coverage
    coverageClientRef.current?.cancel();
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

  // --- link drawing (3D LOS objects) ---------------------------------------
  // Blocked (red) links are hidden by default — they read as noise over the
  // map; the results sheet toggle reveals them when wanted.
  const linkSegments = useMemo((): Link3DPath[] => {
    if (!site) return [];
    const siteAltM = (assess.siteElevationM ?? 0) + site.antennaHeightAglM;
    return assess.results
      .map((r) => {
        // Live neighbours-map rule: green (<=121.5 dB) and amber (<=129.5 dB)
        // only — anything worse is never drawn at all.
        const band = mapLinkBand(r.itmPathLossDb);
        if (band === null) return null;
        const rep = repeatersById.get(r.targetId);
        if (!rep) return null;
        // Prefer the worker's terrain-clearing drawn path; fall back to a
        // straight antenna-to-antenna segment.
        const points =
          r.itmPath && r.itmPath.length >= 2
            ? r.itmPath.map((p) => ({ lon: p.lon, lat: p.lat, altM: p.altM }))
            : [
                { lon: site.lon, lat: site.lat, altM: siteAltM },
                {
                  lon: rep.lon,
                  lat: rep.lat,
                  altM: (r.targetGroundM ?? assess.siteElevationM ?? 0) + rf.rxHeightAglM,
                },
              ];
        return { points, classification: band };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [site, assess.results, assess.siteElevationM, repeatersById, rf.rxHeightAglM]);

  useEffect(() => {
    viewRef.current?.setLinks3D(linkSegments);
  }, [linkSegments]);

  useEffect(() => {
    viewRef.current?.setTheme(theme);
  }, [theme]);

  // --- advanced: precision profile -----------------------------------------
  useEffect(() => {
    if (mode !== 'advanced' || !site || !profilePair) {
      setProfileState({ status: 'idle', data: null, error: null });
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    setProfileState((prev) => ({ ...prev, status: 'running', error: null }));
    const handle = client.startProfile(
      { lat: site.lat, lon: site.lon, antennaHeightAglM: site.antennaHeightAglM },
      { lat: profilePair.lat, lon: profilePair.lon, antennaHeightAglM: rf.rxHeightAglM },
      rf,
    );
    profileJobRef.current = handle.jobId;
    handle.done
      .then((res) => {
        if (profileJobRef.current !== handle.jobId) return;
        setProfileState({ status: 'done', data: res, error: null });
      })
      .catch((err: unknown) => {
        if (profileJobRef.current !== handle.jobId) return;
        setProfileState({ status: 'error', data: null, error: err instanceof Error ? err.message : String(err) });
      });
  }, [mode, site, profilePair, rf]);

  // --- advanced: observed links (loaded once per site neighbourhood) -------
  useEffect(() => {
    if (mode !== 'advanced' || !site) return;
    const key = `${Math.round(site.lat)},${Math.round(site.lon)}`;
    if (observedLoadedRef.current === key) return;
    observedLoadedRef.current = key;
    const bbox = [site.lon - 1.5, site.lat - 1.2, site.lon + 1.5, site.lat + 1.2].map((v) => v.toFixed(3));
    void (async () => {
      try {
        const res = await fetch(`/api/v1/observed-links?bbox=${bbox.join(',')}&limit=20000`);
        if (!res.ok) throw new Error(`observed-links ${res.status}`);
        const page = (await res.json()) as { items: PlannerObservedLink[] };
        setObservedLinks(page.items);
      } catch {
        setObservedLinks([]);
      }
    })();
  }, [mode, site]);

  const observedFeatures = useMemo((): FeatureCollection<LineString> => {
    const feats: Array<{
      type: 'Feature';
      geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
      properties: {
        reciprocal: boolean;
        id: string;
        pathLossDb: number | null;
        viable: boolean | null;
        observedCount: number;
        strongCount: number;
      };
    }> = [];
    for (const l of observedLinks) {
      const a = repeatersById.get(l.sourceId);
      const b = repeatersById.get(l.targetId);
      if (!a || !b) continue;
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
        properties: {
          reciprocal: l.countAToB > 0 && l.countBToA > 0,
          id: `${l.sourceId}~${l.targetId}`,
          pathLossDb: l.pathLossDb,
          viable: l.itmViable === null && l.forceViable === null ? null : (l.itmViable === true || l.forceViable === true),
          observedCount: l.observedCount,
          strongCount: l.strongObservationCount,
        },
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }, [observedLinks, repeatersById]);

  useEffect(() => {
    viewRef.current?.setObservedLinks(observedFeatures);
  }, [observedFeatures]);

  // Re-run when RF settings change (Simple and Advanced share them).
  const rfRef = useRef(rf);
  useEffect(() => {
    if (rfRef.current === rf) return;
    rfRef.current = rf;
    const cur = siteRef.current;
    if (!cur) return;
    runAssess(cur);
    if (coverageOnRef.current) runCoverageRef.current(cur);
  }, [rf, runAssess]);

  // --- advanced: topology + candidate search --------------------------------
  const topology = useMemo((): { nodes: TopoNode[]; edges: TopoEdge[] } | null => {
    if (mode !== 'advanced') return null;
    const nodes: TopoNode[] = [...repeatersById.values()].map((r) => ({
      id: r.canonicalId,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
    }));
    const edges: TopoEdge[] = observedLinks.map((l) => ({
      aId: l.sourceId,
      bId: l.targetId,
      kind: 'observed' as const,
    }));
    if (site) {
      nodes.push({ id: '__planned', name: 'Proposed site', lat: site.lat, lon: site.lon });
      for (const r of assess.results) {
        if (r.classification === 'likely' || r.classification === 'marginal') {
          edges.push({ aId: '__planned', bId: r.targetId, kind: 'predicted' });
        }
      }
    }
    return { nodes, edges };
  }, [mode, repeatersById, observedLinks, assess.results, site]);

  const topologyStats = useMemo(() => (topology ? computeTopoStats(topology.nodes, topology.edges) : null), [topology]);

  const removalOptions = useMemo(() => {
    if (!site) return [];
    return assess.results.slice(0, 25).map((r) => ({
      id: r.targetId,
      label: `${r.name ?? r.targetId.slice(0, 8)} (${r.distanceKm.toFixed(1)} km)`,
    }));
  }, [assess.results, site]);

  const removal = useMemo(
    () => (topology && removalId ? computeRemovalImpact(topology.nodes, topology.edges, removalId) : null),
    [topology, removalId],
  );

  const runCandidates = useCallback(
    (goal: CandidateGoal) => {
      const client = clientRef.current;
      const s = siteRef.current;
      if (!client || !s) return;
      const repeaters = [...repeatersById.values()]
        .map((r) => ({ r, d: haversineDistanceM(s, r) }))
        .filter((x) => x.d <= 150_000)
        .map((x) => ({ id: x.r.canonicalId, name: x.r.name, lat: x.r.lat, lon: x.r.lon }));
      setCandidatesState({ status: 'running', progress: null, candidates: [], screened: 0, error: null });
      const handle = client.startCandidates(
        {
          site: { lat: s.lat, lon: s.lon, antennaHeightAglM: s.antennaHeightAglM },
          halfSizeKm: 25,
          stepPx: 24,
          maxCandidates: 32,
          goal,
          rf,
          repeaters,
        },
        (p) => {
          if (candidatesJobRef.current !== p.jobId) return;
          setCandidatesState((prev) => ({ ...prev, progress: { done: p.done, total: p.total } }));
        },
      );
      candidatesJobRef.current = handle.jobId;
      handle.done
        .then((res) => {
          if (candidatesJobRef.current !== handle.jobId) return;
          setCandidatesState({
            status: 'done',
            progress: { done: res.evaluatedCount, total: res.screenedCount },
            candidates: res.candidates,
            screened: res.screenedCount,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (candidatesJobRef.current !== handle.jobId) return;
          setCandidatesState({
            status: 'error',
            progress: null,
            candidates: [],
            screened: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [repeatersById, rf],
  );

  const exportLinks = useMemo(
    () =>
      assess.results.flatMap((r) => {
        const rep = repeatersById.get(r.targetId);
        if (!rep) return [];
        return [
          {
            targetId: r.targetId,
            targetName: r.name,
            targetLat: rep.lat,
            targetLon: rep.lon,
            classification: r.classification,
            distanceKm: r.distanceKm,
            marginDb: r.marginDb,
          },
        ];
      }),
    [assess.results, repeatersById],
  );

  const applySerializedPlan = useCallback(
    (plan: SerializedPlan) => {
      setRf(plan.rf);
      setMode(plan.mode);
      if (plan.site) {
        applySite(
          { lat: plan.site.lat, lon: plan.site.lon, antennaHeightAglM: plan.site.antennaHeightAglM },
          { pushUndo: true, debounced: true, moveMarker: true },
        );
        viewRef.current?.flyToSite({ lng: plan.site.lon, lat: plan.site.lat });
      }
    },
    [applySite],
  );

  // Shared-plan link (#share=<id>): offer, never auto-apply — the visitor
  // explicitly opts in before a shared plan replaces what is on screen.
  useEffect(() => {
    const id = shareIdFromHash(window.location.hash);
    if (!id) return;
    void fetchShare(id).then((res) => {
      if (res.status === 'ok') {
        const parsed = parsePlanJSON(JSON.stringify(res.plan));
        if (parsed.ok) {
          setShareBanner({ kind: 'offer', plan: parsed.plan, expiresAt: res.expiresAt });
        } else {
          setShareBanner({ kind: 'problem', message: 'That share does not contain a valid plan.' });
        }
      } else if (res.status === 'revoked' || res.status === 'expired' || res.status === 'not-found') {
        setShareBanner({ kind: 'problem', message: `Shared plan ${res.status === 'not-found' ? 'not found' : res.status}.` });
      } else {
        setShareBanner({ kind: 'problem', message: 'Could not fetch the shared plan.' });
      }
    });
  }, []);

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
      linksDrawn: linkSegments.length,
      is3d,
      mode,
      rf: { frequencyMhz: rf.frequencyMhz, txPowerDbm: rf.txPowerDbm, rxSensitivityDbm: rf.rxSensitivityDbm },
      profile: profileState.status,
      observedLinks: observedLinks.length,
      topology: topologyStats
        ? {
            components: topologyStats.componentCount,
            nodes: topologyStats.nodeCount,
            observed: topologyStats.observedEdgeCount,
            predicted: topologyStats.predictedEdgeCount,
          }
        : null,
      candidates: { status: candidatesState.status, count: candidatesState.candidates.length },
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
  }, [
    snapshot,
    repeaterCount,
    site,
    assess,
    linkSegments,
    coverageOn,
    coverageDetail,
    coverageState,
    mode,
    rf,
    profileState,
    observedLinks,
    topologyStats,
    candidatesState,
  ]);

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
              data: gen {snapshot.generation} · {repeaterCount.toLocaleString()} repeaters active in 14 d · fetched {snapshotAge}
            </span>
          ) : (
            <span className="muted small">loading repeaters…</span>
          )}
          <div className="mode-switch" role="group" aria-label="Mode">
            <button
              type="button"
              className={mode === 'simple' ? 'mode-btn mode-btn--active' : 'mode-btn'}
              onClick={() => setMode('simple')}
            >
              Simple
            </button>
            <button
              type="button"
              className={mode === 'advanced' ? 'mode-btn mode-btn--active' : 'mode-btn'}
              onClick={() => setMode('advanced')}
            >
              Advanced
            </button>
          </div>
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
            <li><span className="swatch" style={{ background: '#65a30d' }} /> seen &lt; 14 d</li>
          </ul>
          <p className="muted small">
            Only repeaters seen on the network in the last 14 days are shown.
          </p>
          <h3>Predicted links</h3>
          <ul>
            <li><span className="swatch" style={{ background: '#22c55e' }} /> strong (≤ 121.5 dB path loss)</li>
            <li><span className="swatch" style={{ background: '#fbbf24' }} /> marginal (≤ 129.5 dB)</li>
          </ul>
          <p className="muted small">
            Weaker paths are not shown. Links are drawn as elevated 3D arcs between sites (held
            clear of the terrain, arc height for visibility only) — tilt with the 3D button to see
            them. Path-loss numbers are unaffected by the arc.
          </p>
          <p className="muted small">
            Links are drawn as 3D line-of-sight objects at antenna height — tilt with the 3D
            button to see them against the terrain.
          </p>
          <h3>Observed links</h3>
          <ul>
            <li><span className="swatch" style={{ background: '#64748b' }} /> reciprocal evidence (solid)</li>
            <li><span className="swatch" style={{ background: '#94a3b8' }} /> one-way report (dashed)</li>
          </ul>
          <p className="muted small">Clusters show counts at low zoom; zoom in for individual repeaters.</p>
        </aside>
      ) : null}

      <div ref={containerRef} className="map" />
      <button
        type="button"
        className="map-3d-btn"
        aria-pressed={is3d}
        title="Toggle 3D view (tilt the camera)"
        onClick={() => setIs3d(viewRef.current?.togglePitch() ?? false)}
      >
        {is3d ? '2D' : '3D'}
      </button>

      <div className="sheets">
      {shareBanner ? (
        <div className="share-banner" role="status">
          {shareBanner.kind === 'offer' ? (
            <>
              <span>
                A plan was shared with you (expires{' '}
                {new Date(shareBanner.expiresAt).toLocaleDateString()}).
              </span>
              <button
                type="button"
                className="detail-btn"
                onClick={() => {
                  applySerializedPlan(shareBanner.plan);
                  setShareBanner(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                Load it
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setShareBanner(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span>{shareBanner.message}</span>
              <button type="button" className="ghost small" onClick={() => setShareBanner(null)}>
                Dismiss
              </button>
            </>
          )}
        </div>
      ) : null}
      <ResultSheet
        site={site}
        assess={assess}
        repeatersById={repeatersById}
        maxRangeKm={rf.maxRangeKm}
        canUndo={undoStack.length > 0}
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
            coverageClientRef.current?.cancel();
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
          if (rep) {
            viewRef.current?.flyToSite({ lng: rep.lon, lat: rep.lat });
            if (mode === 'advanced') {
              setProfilePair({
                repeaterId: id,
                label: rep.name ?? id,
                lat: rep.lat,
                lon: rep.lon,
                antennaHeightAglM: rf.rxHeightAglM,
              });
            }
          }
        }}
      />

      {mode === 'simple' ? (
        <section className="sheet" aria-label="Saved plans">
          <details className="adv-section">
            <summary>Saved plans &amp; export</summary>
            <PlanIoSection
              site={site}
              mode={mode}
              rf={rf}
              links={exportLinks}
              onLoadPlan={applySerializedPlan}
            />
          </details>
        </section>
      ) : null}

      {mode === 'advanced' ? (
        <section className="sheet sheet--advanced" aria-label="Advanced analysis">
          <div className="sheet-head">
            <h2>Advanced analysis</h2>
          </div>
          <ProfilePanel
            profile={profileState}
            labelA="Proposed site"
            labelB={profilePair?.label ?? 'no target selected'}
            aAglM={site?.antennaHeightAglM ?? rf.antennaHeightAglM}
            bAglM={rf.rxHeightAglM}
            onClear={() => setProfilePair(null)}
          />
          <details className="adv-section" open>
            <summary>Link budget / RF settings</summary>
            <RfEditor rf={rf} onChange={setRf} />
          </details>
          <details className="adv-section" open>
            <summary>Network topology &amp; site removal</summary>
            <TopologyPanel
              stats={topologyStats}
              removalOptions={removalOptions}
              removalId={removalId}
              removal={removal}
              onSelectRemoval={setRemovalId}
            />
          </details>
          <details className="adv-section" open>
            <summary>Saved plans &amp; export</summary>
            <PlanIoSection
              site={site}
              mode={mode}
              rf={rf}
              links={exportLinks}
              onLoadPlan={applySerializedPlan}
            />
          </details>
          <details className="adv-section" open>
            <summary>Candidate site search</summary>
            <CandidatePanel
              state={candidatesState}
              goal={candGoal}
              onGoal={(g) => {
                setCandGoal(g);
                if (candidatesState.status === 'done') runCandidates(g);
              }}
              onSearch={() => runCandidates(candGoal)}
              onView={(c) => viewRef.current?.flyToSite({ lng: c.lon, lat: c.lat })}
              onUseAsSite={(c) => {
                const cur = siteRef.current;
                applySite(
                  { lat: c.lat, lon: c.lon, antennaHeightAglM: cur?.antennaHeightAglM ?? rf.antennaHeightAglM },
                  { pushUndo: true, debounced: true, moveMarker: true },
                );
                viewRef.current?.flyToSite({ lng: c.lon, lat: c.lat });
              }}
              disabled={!site}
            />
          </details>
        </section>
      ) : null}
      </div>
    </div>
  );
}
