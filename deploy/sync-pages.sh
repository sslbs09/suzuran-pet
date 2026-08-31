#!/usr/bin/env bash
# ============================================================
# 官网文档同步（gh-pages → GitHub Pages）
# 用法：改完 使用说明.html / API接入指南.html / !!开箱必读-先看我.html /
#       语音部署与训练指南/总览.html 之后，运行本脚本一键发布到官网。
#   bash deploy/sync-pages.sh
# 原理：用 git worktree 挂出 gh-pages 分支的独立工作目录，把文档复制进去，
#       提交并推送；完成后清理 worktree，回到 main，全程不干扰当前工作区。
# ============================================================
set -e
REPO="E:/SuzuranPetGit"
WORKTREE="$REPO/_pages_wt"          # 临时 worktree 目录（脚本结束会删除）
BRANCH="gh-pages"

cd "$REPO"
[ -d .git ] || { echo "不是 git 仓库: $REPO"; exit 1; }

# 1. 检查 gh-pages 分支存在
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "分支 $BRANCH 不存在，请先推送 gh-pages"; exit 1
fi

# 2. 清理可能残留的 worktree（上次中断）
if [ -d "$WORKTREE" ]; then
  git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
fi

# 3. 挂出 gh-pages 分支到独立目录
git worktree add "$WORKTREE" "$BRANCH" 2>/dev/null || { echo "worktree 挂载失败"; exit 1; }

# 4. 复制官网文档（从 main 工作区 → gh-pages worktree）
cp -f "!!开箱必读-先看我.html" "$WORKTREE/guide/开箱必读.html"
cp -f "使用说明.html"          "$WORKTREE/guide/使用说明.html"
cp -f "API接入指南.html"       "$WORKTREE/guide/API接入指南.html"
cp -f "语音部署与训练指南/总览.html" "$WORKTREE/guide/语音部署总览.html"
echo "已复制 4 个文档到官网工作区"

# 5. 提交 + 推送（在 worktree 内执行）
cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "✓ 文档无变化，跳过提交（官网已是最新）"
else
  git commit -m "site: 同步文档 $(date +%Y-%m-%d)"
  git push origin "$BRANCH" 2>&1 | tail -1
  echo "✓ 官网文档已推送"
fi

# 6. 清理 worktree，回到 main
cd "$REPO"
git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
echo "完成：https://sslbs09.github.io/suzuran-pet/ （GitHub Pages 约 1 分钟后生效）"
