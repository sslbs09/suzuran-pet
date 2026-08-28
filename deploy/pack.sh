#!/usr/bin/env bash
# asar 打包部署（§14 追加 104）：dev → prod 更新后，把 resources/app 散目录重打成 app.asar
# 用法：先把 dev 改动复制到 resources/app（散目录）→ 运行本脚本 → 重启桌宠验证
set -e
RES="E:/SuzuranPetGit/release/v2.5/苏苏洛桌宠 2.5 正式版/resources"
cd "$RES"
# 源目录兜底：优先 app（新复制），若只有 app_legacy（上次打包的回退件）则提权为 app
if [ ! -d app ] && [ -d app_legacy ]; then mv app_legacy app; fi
[ -d app ] || { echo "缺少 resources/app 散目录（应先把 dev 改动复制进来）"; exit 1; }
# 上一版回退件换新
rm -rf app_legacy
mv app app_legacy
export npm_config_proxy=http://127.0.0.1:7897 npm_config_https_proxy=http://127.0.0.1:7897
npx --yes asar@3.2.0 pack app_legacy app.asar.new 2>/tmp/asar_err.log || {
  echo "asar 打包失败，回滚散目录："; tail -3 /tmp/asar_err.log
  mv app_legacy app
  exit 1
}
[ -f app.asar ] && mv app.asar app.asar.old
mv app.asar.new app.asar
echo "OK app.asar=$(stat -c%s app.asar)B  回退：删 app.asar 并把 app_legacy 改回 app"