#!/usr/bin/env python3
"""Stage 4 evidence: drive the planner UI with the WebGPU backend FORCED, place
a site, enable the coverage preview, and capture the rendered heatmap. Runs the
WebGPU-capable Chromium (SwiftShader) and screenshots the result."""
import asyncio
import base64
import json
import subprocess
import urllib.request

import websockets

CHROME = "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome"
PORT = 9224
APP = "http://127.0.0.1:13400/?v=gpuui2"
SHOT = "/home/ben/ukmesh-planner-work/evidence/stage4/coverage-webgpu-ui-zoom.png"


async def main():
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={PORT}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/wgpu-ui-profile", "--window-size=1280,800", "about:blank"],
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
            print(json.dumps({"error": "no devtools endpoint"}))
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

            async def ev(expr, sid, await_promise=False):
                r = await cmd("Runtime.evaluate",
                              {"expression": expr, "awaitPromise": await_promise, "returnByValue": True, "timeout": 300000},
                              session=sid)
                return r.get("result", {}).get("result", {}).get("value")

            t = await cmd("Target.createTarget", {"url": "about:blank"})
            tid = t["result"]["targetId"]
            a = await cmd("Target.attachToTarget", {"targetId": tid, "flatten": True})
            sid = a["result"]["sessionId"]
            await cmd("Page.enable", session=sid)
            await cmd("Runtime.enable", session=sid)
            await cmd("Page.navigate", {"url": APP}, session=sid)

            out = {}
            # wait for app data
            for _ in range(40):
                await asyncio.sleep(1)
                v = await ev("(() => { const p = window.__planner; return p ? JSON.stringify({rc: p.repeaterCount}) : null; })()", sid)
                if v:
                    d = json.loads(v)
                    if d.get("rc", 0) > 0:
                        out["repeaters"] = d["rc"]
                        break
            # force webgpu for the coverage worker
            await ev("(() => { window.__plannerForceBackend = 'webgpu'; return 1; })()", sid)
            # project the site location and click
            pt = json.loads(await ev(
                "(() => { const m = window.__plannerMap; const p = m.project([-1.61, 54.97]); return JSON.stringify({x: p.x, y: p.y}); })()", sid))
            for kind in ("mousePressed", "mouseReleased"):
                await cmd("Input.dispatchMouseEvent",
                          {"type": kind, "x": pt["x"], "y": pt["y"], "button": "left", "clickCount": 1, "buttons": 1},
                          session=sid)
                await asyncio.sleep(0.12)
            # wait for assess
            for _ in range(40):
                await asyncio.sleep(1)
                v = await ev("(() => window.__planner ? window.__planner.assess.status : 'null')()", sid)
                if v == "done":
                    break
            out["assess"] = v
            # toggle coverage on
            out["toggle"] = await ev("""(() => {
              const cbs = [...document.querySelectorAll('input[type=checkbox]')];
              const cb = cbs.find(el => (el.closest('label')?.textContent || '').toLowerCase().includes('coverage'));
              if (!cb) return 'not-found';
              cb.click();
              return 'clicked';
            })()""", sid)
            # poll coverage
            final = None
            for _ in range(80):
                await asyncio.sleep(3)
                v = await ev("(() => { const c = window.__planner?.coverage; return c ? JSON.stringify({status: c.status, backend: c.backend, counts: c.counts, progress: c.progress, notices: c.notices}) : 'null'; })()", sid)
                if v and v != "null":
                    d = json.loads(v)
                    if d.get("status") in ("done", "error"):
                        final = d
                        break
            out["coverage"] = final
            # zoom into the coverage area and inspect the raster layer
            await ev("(() => { const m = window.__plannerMap; m.jumpTo({ center: [-1.61, 54.97], zoom: 9.6 }); return 1; })()", sid)
            await asyncio.sleep(4)
            v = await ev("(() => { const m = window.__plannerMap; const s = m.getStyle(); return JSON.stringify({ sources: Object.keys(s.sources || {}), hasLayer: !!m.getLayer('coverage-raster'), rendered: m.queryRenderedFeatures({ layers: ['coverage-raster'] }).length, zoom: m.getZoom() }); })()", sid)
            out["coverageLayer"] = v
            await asyncio.sleep(2)
            shot = await cmd("Page.captureScreenshot", {"format": "png"}, session=sid)
            b64 = shot.get("result", {}).get("data")
            if b64:
                open(SHOT, "wb").write(base64.b64decode(b64))
                out["screenshot"] = SHOT
            print(json.dumps({"ok": True, "result": out}))
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
