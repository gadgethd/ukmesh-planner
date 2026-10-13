#!/usr/bin/env python3
"""Run a page-level WebGPU probe in a WebGPU-capable Chromium and print its JSON result.

The probe is a JS file (evaluated in the page at --app) that may contain a bare
`__WGSL__` token; when --wgsl is given the token is replaced with the JSON-quoted
shader source, letting probes exercise the exact shader from the tree.

Usage:
  python3 run-page-probe.py --probe probes/trig-accuracy.js \
      --wgsl ../../apps/web/src/compute/coverage/shader.wgsl

Requires: the deployed app reachable at --app (probes fetch terrain tiles
relative to the page origin), a Chromium with WebGPU/SwiftShader support
(PARITY_CHROME env var, default below), and the `websockets` package.
"""
import argparse
import asyncio
import json
import os
import subprocess
import urllib.request

import websockets

CHROME = os.environ.get("PARITY_CHROME", "/home/ben/.hermes/tools/chromium-1208/chrome-linux64/chrome")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", required=True, help="JS probe file (may contain __WGSL__)")
    ap.add_argument("--wgsl", default=None, help="WGSL source injected for __WGSL__")
    ap.add_argument("--app", default="http://127.0.0.1:13400/")
    ap.add_argument("--port", type=int, default=9226)
    args = ap.parse_args()

    js = open(args.probe).read()
    if "__WGSL__" in js:
        if not args.wgsl:
            raise SystemExit("probe contains __WGSL__ but --wgsl was not given")
        js = js.replace("__WGSL__", json.dumps(open(args.wgsl).read()))

    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", f"--remote-debugging-port={args.port}",
         "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader",
         "--user-data-dir=/tmp/parity-page-probe-profile", "about:blank"],
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

            t = await cmd("Target.createTarget", {"url": args.app})
            a = await cmd("Target.attachToTarget", {"targetId": t["result"]["targetId"], "flatten": True})
            sid = a["result"]["sessionId"]
            await cmd("Page.enable", session=sid)
            await cmd("Runtime.enable", session=sid)
            await asyncio.sleep(4)
            ev = await cmd("Runtime.evaluate",
                           {"expression": js, "awaitPromise": True, "returnByValue": True, "timeout": 300000},
                           session=sid)
            res = ev.get("result", {})
            if "exceptionDetails" in res:
                print(json.dumps({"exception": res["exceptionDetails"].get("text", "?")}))
            else:
                print(res.get("result", {}).get("value", "NO VALUE"))
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
