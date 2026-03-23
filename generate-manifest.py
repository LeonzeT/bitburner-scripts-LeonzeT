import os, json, hashlib

ROOT = r"E:\OneDrive\BB-Scripts\bitburner-scripts-LeonzeT"
EXCLUDE_DIRS = {"Temp", "Remote", "deploy", ".git", "__pycache__"}
EXCLUDE_FILES = {"generate-manifest.py", "list-files.py", "push.py", "copy-assets.js", "package-lock.json", "README.md", "log.autopilot.txt"}
EXTENSIONS = {".js", ".json", ".txt", ".script"}

files = {}
for root, dirs, filenames in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
    for filename in filenames:
        if filename in EXCLUDE_FILES:
            continue
        ext = os.path.splitext(filename)[1].lower()
        if ext not in EXTENSIONS:
            continue
        full = os.path.join(root, filename)
        rel = os.path.relpath(full, ROOT).replace("\\", "/")
        md5 = hashlib.md5(open(full, "rb").read()).hexdigest()
        files[rel] = md5

with open(os.path.join(ROOT, "manifest.json"), "w") as f:
    json.dump(files, f, indent=2)

print(f"Generated manifest.json with {len(files)} files")
input("Press Enter to exit...")