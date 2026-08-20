# -*- coding: utf-8 -*-
"""推送仓库更新（复用已有 blob，只上传新增/变更文件；树内容寻址自动去重）。
用法: python update_repo.py
环境变量: GH_TOKEN, INITIAL_SHA(当前 HEAD)
"""
import base64
import json
import os
import sys
import urllib.request

TOKEN = os.environ["GH_TOKEN"]
OWNER = "sslbs09"
REPO = "suzuran-pet"
ROOT = r"E:\SuzuranPetGit"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
EXCLUDE_DIRS = {".git", "node_modules", "dist", "data", "sprites", "default", "__pycache__"}
SKIP_PATTERNS = (".pyc",)


def api(method, path, data=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "suzuran-pet-publisher")
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, body, timeout=180) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print("API 错误", e.code, e.read().decode("utf-8", "replace")[:300])
        raise


def create_blob(abs_path):
    with open(abs_path, "rb") as f:
        content = base64.b64encode(f.read()).decode("ascii")
    r = api("POST", "/git/blobs", {"content": content, "encoding": "base64"})
    print(f"  blob {os.path.basename(abs_path)} -> {r['sha'][:8]}")
    return r["sha"]


def main():
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn.endswith(SKIP_PATTERNS):
                continue
            abs_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_path, ROOT).replace("\\", "/")
            files.append((rel, abs_path))
    files.sort()
    print(f"共 {len(files)} 个文件")

    blob_sha = {}
    for rel, abs_path in files:
        blob_sha[rel] = create_blob(abs_path)

    # 建目录树（目录名挂到父级）
    dir_entries = {}
    for rel in blob_sha:
        parts = rel.split("/")
        cur = ""
        for i, p in enumerate(parts):
            nxt = (cur + "/" + p) if cur else p
            if i < len(parts) - 1:
                if nxt not in dir_entries:
                    dir_entries[nxt] = {}
                dir_entries.setdefault(cur, {}).setdefault(p, None)
            else:
                dir_entries.setdefault(cur, {})[p] = blob_sha[rel]
            cur = nxt

    def build_tree(dir_path):
        entries = []
        for name, sha in sorted(dir_entries.get(dir_path, {}).items()):
            sub = (dir_path + "/" + name) if dir_path else name
            if sha is None and sub in dir_entries:
                entries.append({"path": name, "mode": "040000", "type": "tree", "sha": build_tree(sub)})
            else:
                entries.append({"path": name, "mode": "100644", "type": "blob", "sha": sha})
        return api("POST", "/git/trees", {"tree": entries})["sha"]

    root_tree = build_tree("")
    print("根树:", root_tree[:8])

    initial = os.environ.get("INITIAL_SHA", "")
    commit = api("POST", "/git/commits", {
        "message": "ci: 添加 GitHub Actions（自动构建发布 / ESLint / markdownlint）",
        "tree": root_tree,
        "parents": [initial] if initial else []
    })
    print("提交:", commit["sha"][:8])
    api("PATCH", "/git/refs/heads/main", {"sha": commit["sha"], "force": False})
    print("✅ main 已更新:", commit["sha"][:8])


if __name__ == "__main__":
    main()
