#!/usr/bin/env python3
"""Stage 4 evidence: launch Chromium with WebGPU enabled (SwiftShader), drive
the coverage worker through both backends on identical input, and report
parity + timings. Runs detached; output -> wgpu-probe.out.json."""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request

import websockets

CHROME = "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome"
PORT = 9223
APP = "http://127.0.0.1:13400/?v=wgpu1"

PARITY_JS = r"""
(async () => {
  const out = { ua: navigator.userAgent.slice(0, 90) };
  out.hasGpu = 'gpu' in navigator;
  if (navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      out.adapter = ad ? JSON.stringify(ad.info || {}) : 'null';
      if (ad) out.isFallback = ad.isFallbackAdapter === true;
    } catch (e) { out.adapterErr = String(e); }
  }
  const entries = performance.getEntriesByType('resource').map(e => e.name);
  const wUrl = entries.find(n => n.includes('coverage.worker'));
  if (!wUrl) { out.err = 'coverage worker url not found'; return JSON.stringify(out); }
  const site = { lat: 54.9648, lon: -1.6237, antennaHeightAglM: 2 };
  const rf = { frequencyMhz: 868, txPowerDbm: 22, txGainDbi: 3, rxGainDbi: 0, rxSensitivityDbm: -124,
    fadeMarginDb: 20, antennaHeightAglM: 2, rxHeightAglM: 2, maxRangeKm: 100, marginGreenDb: 15, marginMarginalDb: 5 };
  function run(force, detail) {
    return new Promise((resolve) => {
      const w = new Worker(wUrl, { type: 'module' });
      const t0 = performance.now();
      const timer = setTimeout(() => { w.terminate(); resolve({ error: 'timeout 240s' }); }, 240000);
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === 'coverage-result') { clearTimeout(timer); w.terminate(); resolve({ ms: Math.round(performance.now() - t0), d }); }
        if (d.type === 'coverage-error') { clearTimeout(timer); w.terminate(); resolve({ error: d.error }); }
      };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: 'worker ' + (e.message || 'error') }); };
      w.postMessage({ type: 'coverage', jobId: 1, site, detail, rf, forceBackend: force });
    });
  }
  const gpuRun = await run('webgpu', 'low');
  out.gpuRun = gpuRun.error ? { error: gpuRun.error } : { ms: gpuRun.ms, backend: gpuRun.d.backend, counts: gpuRun.d.counts, notices: gpuRun.d.notices };
  if (gpuRun.error || gpuRun.d.backend !== 'webgpu') {
    out.verdict = 'webgpu-unavailable';
    return JSON.stringify(out);
  }
  const cpuRun = await run('cpu', 'low');
  const cpuRun2 = await run('cpu', 'low');
  out.cpuRun = cpuRun.error ? { error: cpuRun.error } : { ms: cpuRun.ms, backend: cpuRun.d.backend, counts: cpuRun.d.counts };
  const unk = (codes) => { const a = []; for (let i = 0; i < codes.length; i++) if (codes[i] === 4) a.push(i); return a; };
  const u1 = unk(cpuRun.d.codes), u2 = unk(cpuRun2.d.codes);
  const s1 = new Set(u1), s2 = new Set(u2);
  out.unknownComparison = {
    cpu1: { count: u1.length, sample: u1.slice(0, 14) },
    cpu2: { count: u2.length, sample: u2.slice(0, 14) },
    equal: u1.length === u2.length && u1.every(i => s2.has(i)),
    onlyInCpu1: u1.filter(i => !s2.has(i)).slice(0, 14),
    onlyInCpu2: u2.filter(i => !s1.has(i)).slice(0, 14),
    gpuUnknownCount: (() => { let c = 0; for (const x of gpuRun.d.codes) if (x === 4) c++; return c; })(),
  };
  // tile health: fetch every window tile once, count failures
  {
    const z = 12;
    const site = { lat: 54.9648, lon: -1.6237 };
    const world = 2 ** z * 256;
    const x = (site.lon + 180) / 360 * world;
    const lr = site.lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * world;
    const mPerPx = (156543.03392 * Math.cos(lr)) / 4096;
    const halfPx = 25000 / mPerPx;
    const tMinX = Math.floor((x - halfPx - 64) / 256), tMaxX = Math.floor((x + halfPx + 64) / 256);
    const tMinY = Math.floor((y - halfPx - 64) / 256), tMaxY = Math.floor((y + halfPx + 64) / 256);
    let ok = 0, bad = 0; const badList = [];
    for (let ty = tMinY; ty <= tMaxY; ty++) for (let tx = tMinX; tx <= tMaxX; tx++) {
      try {
        const res = await fetch('/terrain-tiles/' + z + '/' + tx + '/' + ty + '.png');
        if (res.ok) ok++; else { bad++; if (badList.length < 6) badList.push(tx + '/' + ty + ':' + res.status); }
      } catch { bad++; if (badList.length < 6) badList.push(tx + '/' + ty + ':err'); }
    }
    out.tileHealth = { ok, bad, badList };
  }
  if (!cpuRun.error) {
    const gm = gpuRun.d.margins, gc = gpuRun.d.codes, cm = cpuRun.d.margins, cc = cpuRun.d.codes;
    let maxDelta = 0, sumDelta = 0, nBoth = 0, mism = 0;
    const samples = [];
    const allMismatches = [];
    for (let i = 0; i < gm.length; i++) {
      const g = gm[i], c = cm[i];
      const gNaN = g !== g, cNaN = c !== c;
      if (!gNaN && !cNaN) { const d2 = Math.abs(g - c); if (d2 > maxDelta) maxDelta = d2; sumDelta += d2; nBoth++; }
      if (gc[i] !== cc[i]) {
        mism++;
        allMismatches.push({ i, g: gNaN ? null : g, c: cNaN ? null : c });
        if (samples.length < 8) samples.push({ i, gpu: { code: gc[i], m: gNaN ? null : Math.round(g * 100) / 100 }, cpu: { code: cc[i], m: cNaN ? null : Math.round(c * 100) / 100 } });
      }
    }
    // Documented parity tolerance (docs/performance/benchmarks.md):
    //  - typical: mean |delta margin| <= 0.3 dB
    //  - classification identical for >= 99.75% of cells
    //  - every residual mismatch must be a boundary case: |delta| <= 7 dB
    //    (one knifeEdge(v~0) = 6.03 dB step) or a margin within 2 dB of a
    //    classification threshold (15 / 5 dB). Both classes are inherent
    //    f32-vs-f64 sensitivity at grazing geometry, not model differences.
    const THRESHOLDS = [15, 5];
    const nearT = (m) => THRESHOLDS.some(t => Math.abs(m - t) <= 2);
    let boundaryOk = true;
    for (const mm of allMismatches) {
      if (mm.g === null || mm.c === null) { boundaryOk = false; break; }
      const d2 = Math.abs(mm.g - mm.c);
      if (!(d2 <= 7 || nearT(mm.g) || nearT(mm.c))) { boundaryOk = false; break; }
    }
    const meanDelta = nBoth ? sumDelta / nBoth : null;
    out.parity = {
      cells: gm.length,
      maxDeltaDb: Math.round(maxDelta * 1000) / 1000,
      meanDeltaDb: meanDelta !== null ? Math.round(meanDelta * 1000) / 1000 : null,
      classificationMismatches: mism,
      mismatchRate: Math.round((mism / gm.length) * 100000) / 100000,
      allMismatchesBoundaryClass: boundaryOk,
      mismatchSamples: samples,
    };
    out.verdict = (meanDelta !== null && meanDelta <= 0.3 && mism / gm.length <= 0.0025 && boundaryOk)
      ? 'pass' : 'review';
  }
  return JSON.stringify(out);
})()
"""


async def main():
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={PORT}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/wgpu-probe-profile", "--window-size=1280,800", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ver = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1) as r:
                    ver = json.load(r)
                break
            except Exception:
                await asyncio.sleep(0.5)
        if not ver:
            print(json.dumps({"error": "chrome devtools endpoint never appeared"}))
            return
        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=200 * 1024 * 1024) as ws:
            mid = 0

            async def cmd(method, params=None, session=None):
                nonlocal mid
                mid += 1
                msg = {"id": mid, "method": method, "params": params or {}}
                if session:
                    msg["sessionId"] = session
                await ws.send(json.dumps(msg))
                while True:
                    resp = json.loads(await ws.recv())
                    if resp.get("id") == mid:
                        return resp

            t = await cmd("Target.createTarget", {"url": "about:blank"})
            tid = t["result"]["targetId"]
            a = await cmd("Target.attachToTarget", {"targetId": tid, "flatten": True})
            sid = a["result"]["sessionId"]
            await cmd("Page.enable", session=sid)
            await cmd("Runtime.enable", session=sid)
            await cmd("Page.navigate", {"url": APP}, session=sid)
            await asyncio.sleep(9)
            ev = await cmd("Runtime.evaluate",
                           {"expression": PARITY_JS, "awaitPromise": True, "returnByValue": True, "timeout": 600000},
                           session=sid)
            val = ev.get("result", {}).get("result", {}).get("value")
            print(json.dumps({"ok": True, "result": json.loads(val) if isinstance(val, str) else val}))
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
