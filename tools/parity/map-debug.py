#!/usr/bin/env python3
"""Debug the 3D link layer install path in a controlled Chromium.

Launches its own Chromium with CDP, loads the deployed app, waits for the
style to load (forcing repaints), then:
  1. reports window.__mapLog / layer list / links-3d presence;
  2. runs the custom-layer re-add experiment after a style reset.

Usage: python3 tools/parity/map-debug.py [--app URL] [--port 9333]
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import urllib.request

import websockets

CHROME = os.environ.get("PARITY_CHROME", "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="http://127.0.0.1:13400/?v=localdbg")
    ap.add_argument("--port", type=int, default=9337)
    args = ap.parse_args()

    # A failed GPU init caches a blocklist entry in the profile — always start clean.
    shutil.rmtree("/tmp/planner-map-debug-profile", ignore_errors=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={args.port}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/planner-map-debug-profile", "--window-size=1280,800", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ver = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/json/version", timeout=1) as r:
                    ver = json.load(r)
                break
            except Exception:
                await asyncio.sleep(0.5)
        if not ver:
            print(json.dumps({"error": "devtools endpoint never appeared"}))
            return

        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024) as ws:
            mid = 0

            async def send(method: str, params: dict | None = None, session: str | None = None) -> dict:
                nonlocal mid
                mid += 1
                m: dict = {"id": mid, "method": method, "params": params or {}}
                if session:
                    m["sessionId"] = session
                await ws.send(json.dumps(m))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == mid:
                        return msg.get("result", {})

            t = await send("Target.createTarget", {"url": "about:blank"})
            a = await send("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
            sid = a["sessionId"]

            async def evaluate(expr: str, await_promise: bool = True):
                res = await send("Runtime.evaluate", {
                    "expression": expr, "awaitPromise": await_promise, "returnByValue": True,
                }, session=sid)
                if "exceptionDetails" in res:
                    return {"__exception": res["exceptionDetails"].get("text", "unknown")}
                return res.get("result", {}).get("value")

            # capture console from the start
            await send("Page.enable", session=sid)
            await send("Runtime.enable", session=sid)
            await send("Page.addScriptToEvaluateOnNewDocument", {"source": (
                "window.__conlog = [];"
                "const _err = console.error.bind(console), _warn = console.warn.bind(console);"
                "console.error = (...a) => { window.__conlog.push('E: ' + a.map(String).join(' ')); _err(...a); };"
                "console.warn = (...a) => { window.__conlog.push('W: ' + a.map(String).join(' ')); _warn(...a); };"
            )}, session=sid)
            # Wait for the GPU process to be ready before the app loads: a cold
            # headless start fails WebGL2 context creation and MapLibre aborts.
            warm = False
            for _ in range(40):
                v = await evaluate("(() => !!document.createElement('canvas').getContext('webgl2'))()")
                if v is True:
                    warm = True
                    break
                await asyncio.sleep(0.5)
            print(f"[debug] webgl2 warm before nav: {warm}", flush=True)
            await send("Page.navigate", {"url": args.app}, session=sid)

            # wait for the app
            for _ in range(60):
                v = await evaluate("(() => window.__planner ? window.__planner.repeaterCount : 0)()")
                if isinstance(v, (int, float)) and v > 0:
                    break
                await asyncio.sleep(1)

            # wait for the style; poke repaints in case of rAF stalls
            for _ in range(40):
                v = await evaluate("(() => { try { window.__plannerMap.triggerRepaint(); return window.__plannerMap.isStyleLoaded(); } catch (e) { return 'ERR ' + e.message; } })()")
                if v is True:
                    break
                await asyncio.sleep(0.75)

            report: dict = {}
            report["webgl2AfterLoad"] = await evaluate("(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); return g ? g.getParameter(g.VERSION) : false; })()")
            report["styleLoaded"] = await evaluate("(() => { try { return window.__plannerMap.isStyleLoaded(); } catch (e) { return 'ERR ' + e.message; } })()")
            report["layers3d"] = await evaluate("(() => { const st = window.__plannerMap.getStyle(); return st && st.layers ? st.layers.filter(l => /links|repeater|terrain/.test(l.id)).map(l => l.id + ':' + l.type) : 'NO STYLE'; })()")
            report["mapLog"] = await evaluate("(() => window.__mapLog || [])()")
            report["errs"] = await evaluate("(() => (window.__errs || []).slice(0, 8))()")
            report["conlog"] = await evaluate("(() => (window.__conlog || []).filter(l => /style|custom|layer|3d/i.test(l)).slice(0, 15))()")

            # experiment: custom layer re-add across a style reset
            report["readdExperiment"] = await evaluate("""(() => new Promise(res => {
  const m = window.__plannerMap;
  const log = [];
  class T { constructor(id) { this.id = id; this.type = 'custom'; this.renderingMode = '3d'; }
    onAdd() { log.push('onAdd ' + this.id); } onRemove() { log.push('onRemove ' + this.id); }
    render() {} }
  try {
    const A = new T('exp-a');
    m.addLayer(A);
    log.push('add A: present=' + !!m.getLayer('exp-a'));
  } catch (e) { log.push('add A threw: ' + e.message); res(JSON.stringify(log)); return; }
  m.once('styledata', () => {
    setTimeout(() => {
      log.push('after reset: present=' + !!m.getLayer('exp-a'));
      const A2 = new T('exp-a');
      try { m.addLayer(A2); log.push('re-add NEW instance: present=' + !!m.getLayer('exp-a')); }
      catch (e) { log.push('re-add NEW threw: ' + e.message); }
      res(JSON.stringify(log));
    }, 400);
  });
  m.setStyle(m.getStyle());
}))()""")

            print(json.dumps(report, indent=1))
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
