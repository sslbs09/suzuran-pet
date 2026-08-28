/**
 * SuzuranPet PSD 角色工具（v2.6）
 * - 拖入/选择 .psd → ag-psd 解析图层树
 * - 单图层编辑：显示/隐藏、复制、删除、按内容中心缩放、导入 PNG 新增图层（便于他人调整）
 * - 扁平化合成预览（canvas）+ 导出 PNG 到用户数据目录 assets/psd-export/
 * - 2.5D 动态预览 / 应用到桌宠：编辑过的图层经过内存序列化一并生效（pet:rig-apply-buffer）
 */
"use strict";

const $ = (id) => document.getElementById(id);
let psd = null;
let sel = null;         // { node, parent, el } 当前选中的图层/组
let edited = false;     // 是否做过图层改动（应用到桌宠时需走内存重序列化）
let previewImg = null;  // 已有的扁平化预览 <img>（编辑后自动刷新）
let lastPsdBuf = null;  // 保留原始 buffer（仍用于「未编辑走原文件路径」的旧链路）
let lastPsdPath = null; // 原 PSD 文件路径

/** 图层是否隐藏：ag-psd 记录 hidden，工具页历史上用 visible:false，两者都认 */
function isHidden(L) { return !!(L && (L.hidden === true || L.visible === false)); }
function setHidden(L, v) {
  L.hidden = !!v;          // ag-psd 序列化用的标志（读写都走它）
  L.visible = !!v ? false : true; // 工具页内部约定，兼容旧逻辑
  return v;
}

$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && /\.psd$/i.test(f.name)) loadFile(f);
  else setStatus("请拖入 .psd 文件", true);
});
$("file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
  e.target.value = "";
});

function setStatus(msg, isErr) {
  const s = $("status");
  s.textContent = msg;
  s.className = isErr ? "err" : "";
}
function dbg(msg) { try { window.petAPI && window.petAPI.playback("[psd] " + msg); } catch { /* 忽略 */ } }

/* ---------------- 图层树（可选择 + 显隐切换） ---------------- */

function buildTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  let leafCount = 0;
  const draw = (children, depth) => {
    for (const c of children || []) {
      const isGroup = c.children && c.children.length;
      if (isGroup) {
        const div = document.createElement("div");
        div.className = "lvl grp";
        div.style.paddingLeft = (depth * 12) + "px";
        div.textContent = `${isHidden(c) ? "🙈 " : ""}${c.name || "未命名"} [组]`;
        tree.appendChild(div);
        draw(c.children, depth + 1);
      } else {
        leafCount++;
        const row = document.createElement("div");
        row.className = "lvl leaf-row";
        row.style.paddingLeft = (depth * 12) + "px";
        row.dataset.node = "";
        // 显隐切换（不改变结构，只改 hidden/visible）
        const eye = document.createElement("span");
        eye.className = "eye";
        const hidden = isHidden(c);
        eye.textContent = hidden ? "🙈" : "👁";
        eye.title = hidden ? "显示该图层" : "隐藏该图层";
        eye.addEventListener("click", (e) => {
          e.stopPropagation();
          pushSnap(); // 撤销快照（显隐切换）
          setHidden(c, !isHidden(c));
          setEdited({ tree: false, eye: true });
        });
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = c.name || "未命名";
        const dim = document.createElement("span");
        dim.className = "dim";
        dim.textContent = c.canvas ? `（${c.canvas.width}×${c.canvas.height}）` : "";
        row.append(eye, nm, dim);
        row.addEventListener("click", () => selectLayer(c, children, row));
        tree.appendChild(row);
        if (sel && sel.node === c) { sel.el = row; row.classList.add("sel"); }
      }
    }
  };
  draw(psd ? psd.children : [], 0);
  if (!tree.children.length) tree.textContent = "尚未加载 PSD";
  if (sel) refreshSelButton();
  return leafCount;
}

function selectLayer(node, parent, el) {
  if (sel && sel.el) sel.el.classList.remove("sel");
  sel = { node, parent, el };
  if (sel.el) sel.el.classList.add("sel");
  refreshSelButton();
}

function refreshSelButton() {
  if (!sel) {
    $("sel-info").textContent = "未选择图层";
    $("btn-layer-dup").disabled = $("btn-layer-scale").disabled = $("scale-pct").disabled = $("btn-layer-del").disabled = true;
    return;
  }
  const L = sel.node;
  const hasCanvas = !!(L && L.canvas);
  $("sel-info").textContent = (L.name || "未命名") + (hasCanvas ? `（${L.canvas.width}×${L.canvas.height}）` : " [组]");
  $("btn-layer-dup").disabled = $("btn-layer-scale").disabled = $("scale-pct").disabled = !hasCanvas;
  $("btn-layer-del").disabled = false;
}

/* ---------------- 编辑操作 ---------------- */

/** 标记已编辑：编辑过 → 应用到桌宠改走内存序列化 */
function setEdited({ tree = false, eye = false } = {}) {
  edited = true;
  $("btn-apply-rig").disabled = false;
  if (eye && sel && sel.el) { // 只刷新眼睛图标
    const eyeEl = sel.el.querySelector(".eye");
    if (eyeEl) eyeEl.textContent = isHidden(sel.node) ? "🙈" : "👁";
  } else if (tree) {
    buildTree();
  }
  if (previewImg) refreshPreviewSoon();
  if (rigRuntime) refreshRigSoon();
}

let previewTimer = null;
function refreshPreviewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(doFlatten, 250);
}

/* ---------------- 撤销 / 重做（快照式，只存引用与字段值，不拷贝画布像素） ---------------- */
let undoStack = [];
let redoStack = [];
const UNDO_MAX = 30;

/** 操作前快照：记录根层/组子级引用顺序 + 叶子层字段值（canvas 引用原对象，缩放替换后旧画布仍被快照持有） */
function snapshotPsd() {
  const snap = { root: (psd.children || []).slice(), groups: [], leaves: [] };
  const walk = (kids) => {
    for (const c of kids || []) {
      if (c.children && c.children.length) {
        snap.groups.push({ obj: c, order: c.children.slice() });
        walk(c.children);
      } else if (c.canvas) {
        snap.leaves.push({ obj: c, state: { left: c.left | 0, top: c.top | 0, right: c.right, bottom: c.bottom, opacity: c.opacity, visible: c.visible, hidden: c.hidden, canvas: c.canvas } });
      }
    }
  };
  walk(psd.children);
  return snap;
}
function pushSnap() {
  undoStack.push(snapshotPsd());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restorePsd(snap, label) {
  psd.children = snap.root.slice();
  for (const g of snap.groups) g.obj.children = g.order.slice();
  for (const l of snap.leaves) {
    for (const k of Object.keys(l.state)) l.obj[k] = l.state[k];
  }
  // 选区指向已不在树里的节点 → 清空
  if (sel) {
    let found = false;
    (function walk(kids) {
      for (const c of kids || []) { if (c === sel.node) { found = true; return; } if (c.children) walk(c.children); }
    })(psd.children);
    if (!found) sel = null;
  }
  edited = true;
  $("btn-apply-rig").disabled = false;
  buildTree();
  refreshSelButton();
  if (previewImg) refreshPreviewSoon();
  if (rigRuntime) refreshRigSoon();
  updateUndoButtons();
  setStatus(label);
}
function undoPsd() {
  if (!undoStack.length || !psd) return;
  redoStack.push(snapshotPsd());
  restorePsd(undoStack.pop(), "↩ 已撤销");
}
function redoPsd() {
  if (!redoStack.length || !psd) return;
  undoStack.push(snapshotPsd());
  restorePsd(redoStack.pop(), "↪ 已重做");
}
function updateUndoButtons() {
  const u = document.getElementById("btn-layer-undo");
  const r = document.getElementById("btn-layer-redo");
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}
if (document.getElementById("btn-layer-undo")) {
  document.getElementById("btn-layer-undo").addEventListener("click", undoPsd);
  document.getElementById("btn-layer-redo").addEventListener("click", redoPsd);
}
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redoPsd(); else undoPsd();
  }
});

/** 内容包围盒中心：alpha>8 的像素范围中心；全透明层退回画布中心 */
function contentCenterOf(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    for (let x = 0; x < w; x++) if (d[o + x * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? { cx: w / 2, cy: h / 2 } : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** 单层缩放：以图层内容中心为锚缩放画布，内容中心在 PSD 文档中的位置不变 */
function scaleLayer() {
  const L = sel && sel.node;
  if (!L || !L.canvas) { setStatus("请先选择一个有像素的图层", true); return; }
  let pct = Number($("scale-pct").value);
  if (!Number.isFinite(pct)) pct = 100;
  pct = Math.max(10, Math.min(500, pct));
  $("scale-pct").value = pct;
  pushSnap(); // 撤销快照
  const s = pct / 100;
  const c = contentCenterOf(L.canvas);
  const nw = Math.max(1, Math.round(L.canvas.width * s));
  const nh = Math.max(1, Math.round(L.canvas.height * s));
  const n = document.createElement("canvas");
  n.width = nw; n.height = nh;
  const ctx = n.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const dx = c.cx * (1 - s), dy = c.cy * (1 - s);
  ctx.drawImage(L.canvas, dx, dy, nw, nh);
  L.canvas = n;
  L.left = Math.round((L.left | 0) + dx);
  L.top = Math.round((L.top | 0) + dy);
  if (typeof L.right === "number") L.right = L.left + nw;
  if (typeof L.bottom === "number") L.bottom = L.top + nh;
  setEdited({ tree: true }); // 尺寸/坐标变化 → 重建行（dim 更新）
  setStatus(`已缩放「${L.name || "图层"}」至 ${pct}%（按内容中心）`);
}

/** 复制选中图层：原样复制，偏移 +16,+16 便于看到效果，插入到原图层上方 */
function dupLayer() {
  const L = sel && sel.node;
  if (!L || !L.canvas) { setStatus("请先选择一个有像素的图层", true); return; }
  const parent = sel.parent || psd;
  const kids = parent.children || (parent.children = []);
  const idx = kids.indexOf(L);
  pushSnap(); // 撤销快照
  const n = document.createElement("canvas");
  n.width = L.canvas.width; n.height = L.canvas.height;
  n.getContext("2d").drawImage(L.canvas, 0, 0);
  const cp = {
    name: (L.name || "图层") + " 副本",
    canvas: n,
    left: (L.left | 0) + 16,
    top: (L.top | 0) + 16,
    opacity: typeof L.opacity === "number" ? L.opacity : 1,
    visible: !isHidden(L),
    hidden: isHidden(L),
  };
  if (typeof L.right === "number") { cp.right = cp.left + n.width; cp.bottom = cp.top + n.height; }
  kids.splice(idx + 1, 0, cp);
  edited = true;
  $("btn-apply-rig").disabled = false;
  buildTree();
  selectLayer(cp, parent);
  setStatus(`已复制图层「${cp.name}」`);
}

/** 删除选中图层（组整体删除其子级） */
function delLayer() {
  if (!sel) return;
  const parent = sel.parent || psd;
  const kids = parent.children || [];
  const idx = kids.indexOf(sel.node);
  const nm = sel.node.name || "图层";
  pushSnap(); // 撤销快照
  if (idx >= 0) kids.splice(idx, 1);
  else nm = "未知节点";
  edited = true;
  $("btn-apply-rig").disabled = false;
  sel = null;
  buildTree();
  refreshSelButton();
  if (previewImg) refreshPreviewSoon();
  if (rigRuntime) refreshRigSoon();
  setStatus(`已删除图层「${nm}」`);
}

/** 导入一张图片作为新图层（放最上层，居中） */
$("btn-layer-add").addEventListener("click", () => {
  if (!psd) { setStatus("请先加载 PSD", true); return; }
  $("layer-file").click();
});
$("layer-file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (f && /\.(png|jpe?g|webp|gif)$/i.test(f.name)) addLayerFile(f);
  else setStatus("请选择 PNG/JPG/WebP/GIF 图片", true);
});
async function addLayerFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: file.type || "image/png" }));
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    URL.revokeObjectURL(url);
    const n = document.createElement("canvas");
    n.width = img.naturalWidth || img.width;
    n.height = img.naturalHeight || img.height;
    n.getContext("2d").drawImage(img, 0, 0);
    const L = {
      name: "新增图层",
      canvas: n,
      left: Math.max(0, Math.round((psd.width - n.width) / 2)),
      top: Math.max(0, Math.round((psd.height - n.height) / 2)),
      opacity: 1,
      visible: true,
      hidden: false,
      right: Math.max(0, Math.round((psd.width + n.width) / 2)),
      bottom: Math.max(0, Math.round((psd.height + n.height) / 2)),
    };
    pushSnap(); // 撤销快照
    psd.children = psd.children || [];
    psd.children.push(L);
    edited = true;
    $("btn-apply-rig").disabled = false;
    buildTree();
    selectLayer(L, psd);
    if (previewImg) refreshPreviewSoon();
    if (rigRuntime) refreshRigSoon();
    setStatus(`已新增图层「${file.name}」（${n.width}×${n.height}）`);
  } catch (e) {
    setStatus("导入图层失败：" + (e && e.message || e), true);
  }
}

$("btn-layer-scale").addEventListener("click", scaleLayer);
$("btn-layer-dup").addEventListener("click", dupLayer);
$("btn-layer-del").addEventListener("click", delLayer);

/** 编辑后序列化：克隆一份只含像素图层（隐藏层剔除）的最小结构，供 rigger 消费 */
function buildRigPsd() {
  const out = { width: psd.width, height: psd.height, children: [] };
  const walk = (kids, outKids) => {
    for (const c of kids || []) {
      if (c.children && c.children.length) {
        const g = { name: c.name || "组", children: [] };
        walk(c.children, g.children);
        if (g.children.length) outKids.push(g);
      } else if (c.canvas && !isHidden(c)) {
        const ctx = c.canvas.getContext("2d");
        const id = ctx.getImageData(0, 0, c.canvas.width, c.canvas.height);
        outKids.push({ name: c.name || "未命名", left: c.left | 0, top: c.top | 0, imageData: id });
      }
    }
  };
  walk(psd.children, out.children);
  return out;
}

/* ---------------- 扁平化 / 导出 ---------------- */

function flattenPsd(p) {
  const canvas = document.createElement("canvas");
  canvas.width = p.width || 1;
  canvas.height = p.height || 1;
  const ctx = canvas.getContext("2d");
  const stats = { layers: 0, drawn: 0, noCanvas: 0, zeroSize: 0, hidden: 0 };
  const draw = (layers) => {
    for (const l of layers || []) {
      if (l.children && l.children.length) { draw(l.children); continue; }
      stats.layers++;
      if (isHidden(l)) { stats.hidden++; continue; }
      if (!l.canvas) { stats.noCanvas++; continue; }
      if (!l.canvas.width || !l.canvas.height) { stats.zeroSize++; continue; }
      const alpha = (typeof l.opacity === "number" ? l.opacity : 1); // ag-psd opacity 已是 0~1，勿再除 255
      ctx.globalAlpha = alpha;
      ctx.drawImage(l.canvas, l.left || 0, l.top || 0);
      stats.drawn++;
    }
    ctx.globalAlpha = 1;
  };
  draw(p.children);
  return { canvas, stats };
}

async function loadFile(file) {
  setStatus("正在解析 " + file.name + " …");
  try {
    const buf = await file.arrayBuffer();
    lastPsdBuf = buf;
    lastPsdPath = (file.path) || (window.petAPI && window.petAPI.filePath ? window.petAPI.filePath(file) : null);
    dbg("开始解析 " + file.name + " 大小=" + buf.byteLength);
    psd = window.agPsd.readPsd(buf);
    edited = false;
    sel = null;
    previewImg = null;
    buildTree();
    const total = countLayers(psd.children);
    const withCanvas = countCanvas(psd.children);
    $("meta").textContent = "尺寸 " + psd.width + "×" + psd.height + " · 图层 " + total + " 个（含像素 " + withCanvas + "）";
    dbg("解析完成 尺寸=" + psd.width + "x" + psd.height + " 图层=" + total + " 含canvas=" + withCanvas + " 顶层=" + (psd.children || []).length);
    $("btn-flatten").disabled = false;
    $("btn-rig").disabled = false;
    $("btn-export").disabled = true;
    $("btn-layer-add").disabled = false;
    $("btn-apply-rig").disabled = !lastPsdPath;
    $("preview-wrap").innerHTML = '<span class="meta">解析完成，点击「扁平化预览」，或先选中图层做调整</span>';
    setStatus("解析完成 ✓（图层 " + total + "，含像素 " + withCanvas + "）");
  } catch (e) {
    psd = null;
    dbg("解析失败: " + (e && e.message || e));
    setStatus("解析失败：" + (e && e.message || e), true);
  }
}

function countLayers(children) {
  let n = 0;
  for (const c of children || []) n += 1 + (c.children ? countLayers(c.children) : 0);
  return n;
}
function countCanvas(children) {
  let n = 0;
  for (const c of children || []) {
    if (c.canvas) n += 1;
    if (c.children) n += countCanvas(c.children);
  }
  return n;
}

function doFlatten() {
  if (!psd) return;
  try {
    const { canvas, stats } = flattenPsd(psd);
    const ctx = canvas.getContext("2d");
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque += 1;
    const wrap = $("preview-wrap");
    wrap.innerHTML = "";
    const img = document.createElement("img");
    img.id = "preview";
    img.src = canvas.toDataURL("image/png");
    wrap.appendChild(img);
    previewImg = img;
    $("btn-export").disabled = false;
    setStatus(opaque > 0 ? `预览生成 ✓（非透明像素 ${opaque}，绘制 ${stats.drawn}/${stats.layers} 层${edited ? "，已含编辑" : ""}）` : "⚠ 预览为空：图层没有可绘制像素", opaque === 0);
  } catch (e) {
    dbg("扁平化失败: " + (e && e.message || e));
    setStatus("扁平化失败：" + (e && e.message || e), true);
  }
}

$("btn-flatten").addEventListener("click", doFlatten);

$("btn-export").addEventListener("click", async () => {
  if (!psd) return;
  const img = $("preview");
  if (!img) { setStatus("请先扁平化预览", true); return; }
  try {
    const res = await window.petAPI.psdSave(img.src, psd.width + "x" + psd.height);
    if (res && res.ok) setStatus("已导出：" + res.path);
    else setStatus("导出失败：" + ((res && res.message) || "未知错误"), true);
  } catch (e) {
    setStatus("导出失败：" + (e && e.message || e), true);
  }
});

/* ---------------- 2.5D 动态预览 / 应用到桌宠（读取内存编辑态） ---------------- */
let rigRuntime = null;

function rigOpts() {
  const GP = window.GenericParts;
  const base = GP ? { eyeL: GP.get("eyeL"), eyeR: GP.get("eyeR"), mouth: GP.get("mouth") } : {};
  return (base.eyeL || base.mouth) ? { generic: base } : {};
}

function rigPsdSource() {
  // 编辑过：用内存对象（含图层改动）；未编辑：重新解析原始 buffer（保留 PSD 全部原生细节）
  if (edited) return buildRigPsd();
  return window.agPsd.readPsd(new Uint8Array(lastPsdBuf), { useImageData: true, skipThumbnail: true });
}

let rigTimer = null;
function refreshRigSoon() {
  clearTimeout(rigTimer);
  rigTimer = setTimeout(doRigPreview, 300);
}

function doRigPreview() {
  if (!psd || !rigRuntime) return;
  try {
    const psdImg = rigPsdSource();
    window.Rigger.cleanPsdLayers(psdImg);
    const rig = window.Rigger.buildRig(psdImg, rigOpts());
    rigRuntime.applyRig(rig);
    $("rig-info").textContent = rig.layers.length + " 部件 / 已按编辑态刷新（含图层改动）";
    setStatus("2.5D 预览已随编辑刷新 ✓");
  } catch (e) {
    dbg("2.5D 刷新失败: " + (e && e.message || e));
    setStatus("2.5D 刷新失败：" + (e && e.message || e), true);
  }
}

$("btn-rig").addEventListener("click", async () => {
  if (!psd) return;
  try {
    setStatus("正在自动装配 2.5D …");
    const wrap = $("rig-wrap");
    wrap.innerHTML = "";
    const cv = document.createElement("canvas");
    cv.id = "rig-canvas";
    cv.style.maxWidth = "100%";
    cv.style.maxHeight = "380px";
    cv.style.background = "repeating-conic-gradient(#f0f3f6 0 25%, #fff 0 50%) 0 0/16px 16px";
    wrap.appendChild(cv);
    const psdImg = rigPsdSource();
    const pre = window.Rigger.cleanPsdLayers(psdImg);
    const rig = window.Rigger.buildRig(psdImg, rigOpts());
    dbg("2.5D 装配: 部件=" + rig.layers.length + " 锚点=" + Object.keys(rig.anchors || {}).join(",") + " 警告=" + rig.warnings.length);
    if (rigRuntime) { try { rigRuntime.destroy(); } catch (e) { } }
    rigRuntime = window.RigRuntime.init(cv);
    rigRuntime.applyRig(rig);
    if (pre && pre.noisy > 0) dbg("2.5D 预处理: 清除噪声 " + pre.noisy + "/" + pre.layers + " 层");
    if (rig.synth && (rig.synth.eye || rig.synth.mouth)) dbg("2.5D 差分: 自动生成闭眼/闭口");
    $("rig-info").textContent = rig.layers.length + " 部件 / 自动装配完成，鼠标移入预览区可视线跟随" + (edited ? "（已含图层编辑）" : "");
    setStatus("2.5D 动态预览已启动 ✓");
  } catch (e) {
    dbg("2.5D 装配失败: " + (e && e.message || e));
    setStatus("2.5D 装配失败：" + (e && e.message || e), true);
  }
});

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); // data:application/octet-stream;base64,...
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

$("btn-apply-rig").addEventListener("click", async () => {
  if (!psd) return;
  try {
    setStatus("正在应用到桌宠 …");
    if (!edited) {
      if (!lastPsdPath) { setStatus("无法获取文件路径（请用文件选择器打开，或先做任意图层编辑）", true); return; }
      const res = await window.petAPI.rigApply(lastPsdPath);
      if (res && res.ok) setStatus("✅ 已应用 2.5D 角色：" + res.id + "（桌宠已切换）");
      else setStatus("应用失败：" + ((res && res.message) || "未知错误"), true);
      return;
    }
    // 编辑过：用 ag-psd 把内存图层树序列化回 .psd，主进程落盘为当前皮肤（保留图层结构）
    const buf = window.agPsd.writePsd(psd);
    let name = ((lastPsdPath || "").split(/[\\/]/).pop() || "").replace(/\.psd$/i, "");
    if (!name) name = "psd-edit";
    name = name + "-edit.psd";
    const b64 = await blobToBase64(new Blob([buf], { type: "application/octet-stream" }));
    const res = await window.petAPI.rigApplyBuffer(name, b64);
    if (res && res.ok) setStatus("✅ 已应用编辑后 2.5D 角色：" + res.id + "（含图层改动，桌宠已切换）");
    else setStatus("应用失败：" + ((res && res.message) || "未知错误"), true);
  } catch (e) {
    setStatus("应用失败：" + (e && e.message || e), true);
  }
});