/**
 * rig-delete.js — 2.5D 皮肤删除计划（纯逻辑，2026-08-27 拆出，可单测）
 * main.js `pet:rig-delete` 的判定核心：文件名安全校验 + 列表存在性 + 是否当前皮肤
 * （删除当前皮肤时需清空 rigSkinId、退出 2.5D 模式，通知渲染层切走）。
 */
"use strict";

/**
 * @param {Array<{id:string,file:string}>} list rigSkinList() 结果
 * @param {string} id 要删除的皮肤 id（= rigUser 下的 .psd 文件名）
 * @param {string} currentId 当前生效的 rigSkinId
 * @returns {{error:string} | {file:string, clearCurrent:boolean}}
 */
function planRigDelete(list, id, currentId) {
  const nm = String(id || "");
  if (!/\.psd$/i.test(nm) || /[\\/]/.test(nm)) return { error: "非法文件名" };
  // Windows 文件系统大小写不敏感：匹配与"当前皮肤"判定均按小写归一
  const low = nm.toLowerCase();
  const hit = (list || []).find((s) => String(s.id || "").toLowerCase() === low);
  if (!hit) return { error: "皮肤不存在" };
  return { file: hit.file, clearCurrent: low === String(currentId || "").toLowerCase() };
}

module.exports = { planRigDelete };