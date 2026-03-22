import json, urllib.request, glob, os

PORT = 12525
BASE = "./dist/"

for path in glob.glob(BASE + "**/*.js", recursive=True):
    name = path.replace(BASE, "").replace("\\", "/")
    code = open(path, encoding="utf-8").read()
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "pushFile",
        "params": {"filename": name, "content": code, "server": "home"}
    }).encode()
    req = urllib.request.Request(
        f"http://localhost:{PORT}",
        data=body,
        headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req)
    print(f"Pushed {name}")