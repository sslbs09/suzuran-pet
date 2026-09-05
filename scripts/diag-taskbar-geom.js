// 任务栏几何诊断脚本（只读）：实测 Shell_TrayWnd 物理 rect/DPI 与桌宠窗口落点。
// 注意：本脚本以非 DPI-aware 的普通 node 运行，GetWindowRect 返回的是系统虚拟化
// （96-DPI）坐标——恰好与 Electron 的 DIP 坐标一致，可直接与 tts.log 对账。
// 用法: node scripts/diag-taskbar-geom.js
const koffi = require("koffi");
const user32 = koffi.load("user32.dll");
const RECT = koffi.struct("DiagRect", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const EnumProc = koffi.proto("bool __stdcall EnumProc(void *hwnd, long lParam)");
const FindWindowW = user32.func("void* __stdcall FindWindowW(const char *cls, const char *title)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void *hWnd, _Out_ DiagRect *lpRect)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumProc *lpEnumFunc, long lParam)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hWnd)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16_t *s, int n)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(void *hWnd, _Out_ uint16_t *s, int n)");
const GetDpiForWindow = user32.func("uint32_t __stdcall GetDpiForWindow(void *hWnd)");

function readWide(buf, len) {
  let end = Math.max(0, Math.min(len, buf.length / 2));
  while (end > 0 && buf[end - 1] === 0) end--;
  return Buffer.from(buf.buffer, buf.byteOffset, end * 2).toString("utf16le");
}

const tray = FindWindowW("Shell_TrayWnd", null);
if (tray) {
  const r = {};
  GetWindowRect(tray, r);
  const dpi = GetDpiForWindow(tray);
  console.log(`Shell_TrayWnd 物理: left=${r.left} top=${r.top} right=${r.right} bottom=${r.bottom} 高=${r.bottom - r.top} 宽=${r.right - r.left} dpi=${dpi} scale=${(dpi / 96).toFixed(2)}`);
  const s = dpi / 96;
  console.log(`  → DIP: top=${(r.top / s).toFixed(1)} 高=${((r.bottom - r.top) / s).toFixed(1)}`);
} else {
  console.log("Shell_TrayWnd 未找到");
}

console.log("=== 桌宠/任务栏相关可见窗口（物理坐标）===");
const cb = (hwnd) => {
  if (!hwnd || !IsWindowVisible(hwnd)) return true;
  const tb = new Uint16Array(512), cb2 = new Uint16Array(256);
  const tl = GetWindowTextW(hwnd, tb, 512), cl = GetClassNameW(hwnd, cb2, 256);
  const title = readWide(tb, tl), cls = readWide(cb2, cl);
  const r = {};
  if (!GetWindowRect(hwnd, r)) return true;
  if (cls === "Shell_TrayWnd" || cls === "Shell_SecondaryTrayWnd" || (title && title.includes("苏苏洛"))) {
    const dpi = GetDpiForWindow(hwnd);
    const s = dpi / 96;
    console.log(`[${cls}] "${title}" left=${r.left} top=${r.top} w=${r.right - r.left} h=${r.bottom - r.top} dpi=${dpi} → DIP: x=${(r.left / s).toFixed(1)} y=${(r.top / s).toFixed(1)} w=${((r.right - r.left) / s).toFixed(1)} h=${((r.bottom - r.top) / s).toFixed(1)}`);
  }
  return true;
};
EnumWindows(cb, 0);
