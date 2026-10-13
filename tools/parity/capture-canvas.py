#!/usr/bin/env python3
"""Capture the map canvas by reading WebGL pixels during a render frame.

The headless compositor path can produce blank screenshots in this
environment; reading the canvas pixels inside MapLibre's `render` event is
compositor-independent and returns exactly what the GPU drew.

Usage: python3 tools/parity/capture-canvas.py [--app URL] [--out DIR]
"""
import argparse
import asyncio
import base64
import json
import subprocess
import urllib.request

import websockets
from PIL import Image

CHROME = "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome"

READ_PIXELS_JS = """(() => new Promise(res => {
  const m = window.__plannerMap;
  const c = m.getCanvas();
  const gl = c.getContext('webgl2');
  if (!gl) { res(JSON.stringify({error: 'no gl'})); return; }
  let tries = 0;
  function grab() {
    tries += 1;
    m.once('render', () => {
      const w = c.width, h = c.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // Content check: sample 400 pixels; a blank frame is near-uniform.
      let min = 255, max = 0, nonWhite = 0;
      const stride = Math.max(4, Math.floor(px.length / 4 / 400) * 4);
      for (let i = 0; i < px.length; i += stride) {
        const v = px[i];
        if (v < min) min = v;
        if (v > max) max = v;
        if (v < 250) nonWhite += 1;
      }
      const spread = max - min;
      if ((spread < 12 && tries < 6)) {
        // near-uniform frame (cleared/transition) — try the next one
        m.triggerRepaint();
        grab();
        return;
      }
      let bin = '';
      const CHUNK = 32768;
      for (let i = 0; i < px.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, px.subarray(i, i + CHUNK));
      }
      res(JSON.stringify({w, h, spread, nonWhite, tries, b64: btoa(bin)}));
    });
    m.triggerRepaint();
  }
  grab();
  setTimeout(() => res(JSON.stringify({error: 'render never fired'})), 15000);
}))()"""


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="http://127.0.0.1:13400/?v=canvascap")
    ap.add_argument("--out", default="/home/ben/ukmesh-planner-work/evidence/stage7")
    ap.add_argument("--port", type=int, default=9343)
    args = ap.parse_args()

    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={args.port}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/wgpu-ui-profile", "--window-size=1280,900", "about:blank"],
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
            await cmd("Emulation.setDeviceMetricsOverride",
                      {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sid)

            async def ev(expr):
                res = await cmd("Runtime.evaluate",
                                {"expression": expr, "awaitPromise": True, "returnByValue": True, "timeout": 120000},
                                session=sid)
                r = res.get("result", {})
                if "exceptionDetails" in r:
                    return "EXC: " + r["exceptionDetails"].get("text", "?")
                return r.get("result", {}).get("value")

            async def save_canvas(name: str):
                out = await ev(READ_PIXELS_JS)
                try:
                    data = json.loads(out)
                except Exception:
                    print(f"{name}: bad readback: {out}")
                    return
                if "error" in data:
                    print(f"{name}: {data['error']}")
                    return
                print(f"{name}: spread={data.get('spread')} nonWhite={data.get('nonWhite')} tries={data.get('tries')}")
                w, h = data["w"], data["h"]
                raw = base64.b64decode(data["b64"])
                img = Image.frombytes("RGBA", (w, h), raw).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                path = f"{args.out}/{name}"
                img.save(path)
                print(f"{name}: {w}x{h} -> {path}")

            for _ in range(40):
                if await ev("(() => !!document.createElement('canvas').getContext('webgl2'))()") is True:
                    break
                await asyncio.sleep(0.5)
            await cmd("Page.navigate", {"url": args.app}, session=sid)
            for _ in range(60):
                v = await ev("(() => window.__planner ? window.__planner.repeaterCount : 0)()")
                if isinstance(v, (int, float)) and v > 0:
                    break
                await asyncio.sleep(1)
            for _ in range(30):
                if await ev("(() => { try { window.__plannerMap.triggerRepaint(); return window.__plannerMap.isStyleLoaded(); } catch(e){ return false; } })()") is True:
                    break
                await asyncio.sleep(0.75)

            await ev("(() => { window.__plannerMap.fire('click', { lngLat: { lng: -1.61, lat: 54.97 }, point: { x: 640, y: 400 } }); return 1; })()")
            for _ in range(60):
                if await ev("(() => window.__planner?.assess?.status)()") == "done":
                    break
                await asyncio.sleep(1)
            await asyncio.sleep(2)
            print("assess:", await ev("(() => JSON.stringify({counts: window.__planner.assess.counts, links: window.__planner.linksDrawn}))()"))
            await save_canvas("canvas-flat.png")

            await ev("(() => { const b = document.querySelector('.map-3d-btn'); b.click(); return 1; })()")
            await asyncio.sleep(3)
            print("pitch:", await ev("(() => Math.round(window.__plannerMap.getPitch()))()"))
            await save_canvas("canvas-tilted.png")

            await ev("""(() => {
              const cb = [...document.querySelectorAll('input[type=checkbox]')].find(i => /blocked/i.test(i.closest('label')?.textContent || ''));
              if (cb && !cb.checked) cb.click();
              return 1;
            })()""")
            await asyncio.sleep(4)
            print("links with blocked:", await ev("(() => window.__planner.linksDrawn)()"))
            await save_canvas("canvas-tilted-blocked.png")
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
