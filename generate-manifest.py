import os, json

ROOT = r"E:\OneDrive\Scripts\typescript-template-main\dist"

EXCLUDE_DIRS = {"Temp", "Remote", "deploy", ".git", "__pycache__"}
EXCLUDE_FILES = {"generate-manifest.py", "list-files.py", "push.py", "copy-assets.js", "package-lock.json", "README.md", "log.autopilot.txt"}
EXTENSIONS = {".js", ".json", ".txt", ".script"}

files = []
skipped = []

for root, dirs, filenames in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
    for filename in filenames:
        full = os.path.join(root, filename)
        rel = os.path.relpath(full, ROOT).replace("\\", "/")
        ext = os.path.splitext(filename)[1].lower()
        if filename in EXCLUDE_FILES:
            continue
        if ext not in EXTENSIONS:
            skipped.append(f"  SKIPPED (ext={repr(ext)}): {rel}")
            continue
        files.append(rel)

files.sort()

print(f"INCLUDED ({len(files)}):")
for f in files:
    print(f"  {f}")

print(f"\nSKIPPED ({len(skipped)}):")
for s in skipped:
    print(s)

with open(os.path.join(ROOT, "manifest.json"), "w") as f:
    json.dump(files, f, indent=2)

input("\nPress Enter to exit...")