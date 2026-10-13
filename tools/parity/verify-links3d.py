#!/usr/bin/env python3
"""End-to-end verification of the 3D link layer on the deployed app.

Drives its own Chromium via CDP: places a site, waits for the assessment,
checks the links-3d layer + segment count, tilts to 3D, toggles blocked
links, and captures screenshots at each step.

Usage: python3 tools/parity/verify-links3d.py [--app URL]
"""
import argparse
import asyncio
import base64
import json
import os
import shutil
import subprocess
import urllib.request

import websockets

CHROME = os.environ.get("PARITY_CHROME", "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome")
OUT = "/home/ben/ukmesh-planner-work/evidence/stage7"


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="http://127.0.0.1:13400/?v=links3d-verify")
    ap.add_argument("--port", type=int, default=9337)
    args = ap.parse_args()

    shutil.rmtree("/tmp/planner-links3d-verify-profile", ignore_errors=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={args.port}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/planner-links3d-verify-profile", "--window-size=1280,800", "about:blank"],
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
            print("devtools never appeared")
            return

        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=128 * 1024 * 1024) as ws:
            mid = 0

            async def cmd(method, params=None, session=None):
                nonlocal mid
                mid += 1
                m = {"id": mid, "method": method, "params": params or {}}
                if session:
                    m["sessionId"] = session
                await ws.send(json.dumps(m))
                while True:
                    resp = json.loads(await ws.recv())
                    if resp.get("id") == mid:
                        return resp

            t = await cmd("Target.createTarget", {"url": "about:blank"})
            a = await cmd("Target.attachToTarget", {"targetId": t["result"]["targetId"], "flatten": True})
            sid = a["result"]["sessionId"]
            await cmd("Page.enable", session=sid)
            await cmd("Runtime.enable", session=sid)

            async def evaluate(expr):
                res = await cmd("Runtime.evaluate",
                                {"expression": expr, "awaitPromise": True, "returnByValue": True, "timeout": 180000},
                                session=sid)
                r = res.get("result", {})
                if "exceptionDetails" in r:
                    return {"__exception": r["exceptionDetails"].get("text", "unknown")}
                return r.get("result", {}).get("value")

            async def shot(name: str):
                # Software rasterizers can flush partial frames; retry until the
                # PNG clearly has content (blank pages compress to a few KB).
                for attempt in range(10):
                    await evaluate("(() => { try { window.__plannerMap.triggerRepaint(); } catch (e) {} return 1; })()")
                    await asyncio.sleep(1.2)
                    res = await cmd("Page.captureScreenshot", {"format": "png"}, session=sid)
                    data = res.get("result", {}).get("data")
                    if not data:
                        continue
                    raw = base64.b64decode(data)
                    if len(raw) > 100_000 or attempt == 9:
                        path = os.path.join(OUT, name)
                        with open(path, "wb") as f:
                            f.write(raw)
                        print(f"screenshot: {path} ({len(raw)//1024} KB)")
                        return
                    await asyncio.sleep(1.0)

            # warm GPU then navigate
            for _ in range(40):
                v = await evaluate("(() => !!document.createElement('canvas').getContext('webgl2'))()")
                if v is True:
                    break
                await asyncio.sleep(0.5)
            await cmd("Page.navigate", {"url": args.app}, session=sid)

            for _ in range(60):
                v = await evaluate("(() => window.__planner ? window.__planner.repeaterCount : 0)()")
                if isinstance(v, (int, float)) and v > 0:
                    break
                await asyncio.sleep(1)
            for _ in range(40):
                v = await evaluate("(() => { try { window.__plannerMap.triggerRepaint(); return window.__plannerMap.isStyleLoaded(); } catch (e) { return false; } })()")
                if v is True:
                    break
                await asyncio.sleep(0.75)
            print("style loaded:", await evaluate("(() => window.__plannerMap.isStyleLoaded())()"))

            # place a site by firing the map's own click event
            await evaluate("(() => { window.__plannerMap.fire('click', { lngLat: { lng: -1.61, lat: 54.97 }, point: { x: 640, y: 400 } }); return 1; })()")
            for _ in range(60):
                v = await evaluate("(() => window.__planner?.assess?.status)()")
                if v == "done":
                    break
                await asyncio.sleep(1)
            print("assess:", await evaluate("(() => JSON.stringify({status: window.__planner.assess.status, counts: window.__planner.assess.counts}))()"))
            print("linksDrawn (likely+marginal):", await evaluate("(() => window.__planner.linksDrawn)()"))
            print("links-3d layer:", await evaluate("(() => !!window.__plannerMap.getLayer('links-3d'))()"))
            print("mapLog:", await evaluate("(() => window.__mapLog || [])()"))
            await asyncio.sleep(1)
            await shot("links3d-flat.png")

            # tilt to 3D via the button
            await evaluate("(() => { const b = document.querySelector('.map-3d-btn'); b.click(); return 1; })()")
            await asyncio.sleep(3)
            print("pitch:", await evaluate("(() => Math.round(window.__plannerMap.getPitch()))()"))
            await shot("links3d-tilted.png")

            # enable blocked links
            await evaluate("""(() => {
              const cb = [...document.querySelectorAll('input[type=checkbox]')].find(i => /blocked/i.test(i.closest('label')?.textContent || ''));
              if (cb && !cb.checked) cb.click();
              return cb ? 'toggled' : 'not-found';
            })()""")
            await asyncio.sleep(4)
            print("linksDrawn (with blocked):", await evaluate("(() => window.__planner.linksDrawn)()"))
            await shot("links3d-tilted-blocked.png")

            # errors
            print("errs:", await evaluate("(() => (window.__errs || []).slice(0, 5))()"))
    finally:
        proc.terminate()


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    asyncio.run(main())
