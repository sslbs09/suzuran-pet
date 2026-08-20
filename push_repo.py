# -*- coding: utf-8 -*-
"""通过 GitHub Git Data API 推送仓库内容（绕过被屏蔽的 git 协议）。
用法: python push_repo.py <token>
"""
import base64
import json
import os
import sys
import urllib.request

TOKEN = sys.argv[1]
OWNER = "sslbs09"
REPO = "suzuran-pet"
ROOT = r"E:\SuzuranPetGit"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"


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
        with urllib.request.urlopen(req, body, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print("API 错误", e.code, e.read().decode("utf-8", "replace")[:300])
        raise


def create_blob(path):
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode("ascii")
    r = api("POST", "/git/blobs", {"content": content, "encoding": "base64"})
    print(f"  blob {path} -> {r['sha'][:8]}")
    return r["sha"]


def create_tree(entries):
    r = api("POST", "/git/trees", {"tree": entries})
    return r["sha"]


def main():
    # 1. 收集文件（相对路径 → 绝对路径）
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for fn in filenames:
            abs_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(abs_path, ROOT).replace("\\", "/")
            files.append((rel, abs_path))
    files.sort()
    print(f"共 {len(files)} 个文件")

    # 2. 建 blob（全部文件）
    blob_sha = {}
    for rel, abs_path in files:
        blob_sha[rel] = create_blob(abs_path)

    # 3. 自底向上建目录树（目录名挂到父级，文件挂 blob sha）
    dir_entries = {}  # dir_path -> {name: sha 或 None(目录)}
    for rel in blob_sha:
        parts = rel.split("/")
        cur = ""
        for i, p in enumerate(parts):
            nxt = (cur + "/" + p) if cur else p
            if i < len(parts) - 1:
                # 目录：注册到自身与父级
                if nxt not in dir_entries:
                    dir_entries[nxt] = {}
                dir_entries.setdefault(cur, {}).setdefault(p, None)
            else:
                # 文件
                dir_entries.setdefault(cur, {})[p] = blob_sha[rel]
            cur = nxt

    def build_tree(dir_path):
        entries = []
        for name, sha in sorted(dir_entries.get(dir_path, {}).items()):
            sub = (dir_path + "/" + name) if dir_path else name
            if sha is None and sub in dir_entries:
                tree_sha = build_tree(sub)
                entries.append({"path": name, "mode": "040000", "type": "tree", "sha": tree_sha})
            else:
                entries.append({"path": name, "mode": "100644", "type": "blob", "sha": sha})
        sha = create_tree(entries)
        print(f"  tree {dir_path or '/'} -> {sha[:8]}")
        return sha

    root_tree = build_tree("")
    print("根树:", root_tree[:8])

    # 4. 提交（挂在初始提交上，保持线性历史）
    initial = os.environ.get("INITIAL_SHA", "")
    commit = api("POST", "/git/commits", {
        "message": "苏苏洛桌宠分享版：可配置任意API与人设，AI自动选情绪，表情/语音可自定义",
        "tree": root_tree,
        "parents": [initial] if initial else []
    })
    print("提交:", commit["sha"][:8])

    # 5. 强制更新 main 分支（修正历史，仓库刚建可安全 force）
    api("PATCH", "/git/refs/heads/main", {"sha": commit["sha"], "force": True})
    print("✅ 已更新 main 分支:", commit["sha"][:8])


if __name__ == "__main__":
    main()
