#!/usr/bin/env python3
"""Evaluate JS in the phone's WebView over the forwarded DevTools port.
   cdp.py 'expr'            -> prints the JSON value
   cdp.py --reload          -> reloads the page (bypassing cache)"""
import asyncio, json, sys, urllib.request
import websockets

async def main():
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=3))
    page = next(t for t in targets if t["type"] == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
        async def call(method, **params):
            call.n += 1; me = call.n
            await ws.send(json.dumps({"id": me, "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == me: return m
        call.n = 0
        if sys.argv[1] == "--reload":
            await call("Page.reload", ignoreCache=True); print("reloaded"); return
        r = await call("Runtime.evaluate", expression=sys.argv[1], awaitPromise=True, returnByValue=True)
        res = r.get("result", {})
        if "exceptionDetails" in res: print("EXC", json.dumps(res["exceptionDetails"].get("exception", {}).get("description", res["exceptionDetails"]))[:800])
        else: print(json.dumps(res.get("result", {}).get("value"), indent=1))
asyncio.run(main())
