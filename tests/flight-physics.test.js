// 仿真 walkFlightTick 抛掷物理（从 main.js 提取逻辑，注入桩对象）
function makeSim() {
  const state = {
    win: { x: 800, y: 600, width: 124, height: 300, destroyed: false },
    wa: { x: 0, y: 0, width: 1920, height: 1040 }, // 工作区
    groundGap: 3,
    barriers: [], // {left,right,top,bottom}
    flight: null, resting: false, seated: false, perched: false, sunk: false,
    perchBarrier: null,
    positions: [],
  };
  const walkSetPosition = (x, y) => { state.win.x = x; state.win.y = y; state.positions.push([Math.round(x), Math.round(y)]); return true; };
  const barrierFloorFor = (x) => {
    const b = state.win;
    const cx = x + b.width / 2;
    const cands = state.barriers.filter(r => r.right > x + 12 && r.left < x + b.width - 12 && r.top > 20 && r.top < 1040);
    if (!cands.length) return null;
    const r = cands.reduce((best, item) => item.top < best.top ? item : best);
    if (cx < r.left - b.width / 2 || cx > r.right + b.width / 2) return null;
    return r;
  };
  const tick = (dt = 0.04) => {
    const flight = state.flight; if (!flight) return false;
    const b = state.win;
    const minX = -100, maxX = 1920 - b.width;
    const groundY = 0 + 1040 - b.height + state.groundGap;
    flight.vy = Math.min(1200, flight.vy + 900 * dt);
    flight.vx *= 0.995;
    let nx = b.x + flight.vx * dt;
    let ny = b.y + flight.vy * dt;
    if (nx < minX || nx > maxX) { nx = Math.min(Math.max(nx, minX), maxX); flight.vx *= -0.35; }
    if (ny < state.wa.y) { ny = state.wa.y; if (flight.vy < 0) flight.vy *= -0.35; }
    let landingBarrier = barrierFloorFor(nx);
    let landingFloorY = groundY;
    let catchBarrier = false;
    if (landingBarrier) {
      const bt = landingBarrier.top;
      const prevBottom = b.y + b.height;
      const bot = ny + b.height;
      if ((prevBottom - bt) * (bot - bt) <= 0 && flight.vy >= 0) {
        landingFloorY = bt + state.groundGap - b.height;
        catchBarrier = true;
      } else landingBarrier = null;
    }
    if (!catchBarrier && ny < landingFloorY) { walkSetPosition(nx, ny); return true; }
    if (!walkSetPosition(nx, landingFloorY)) { state.flight = null; return true; }
    if (flight.vy > 250) { flight.vy *= -0.35; flight.bounces++; return true; }
    state.flight = null;
    state.resting = true;
    if (landingBarrier) { state.perched = true; state.seated = false; state.sunk = false; state.perchBarrier = landingBarrier; }
    else { state.seated = true; state.sunk = true; }
    walkSetPosition(nx, landingFloorY);
    return true;
  };
  return { state, walkSetPosition, tick, setFlight: (vx, vy) => { state.flight = { vx, vy, bounces: 0 }; } };
}

function run(name, cfg, assert) {
  const s = makeSim();
  s.state.barriers = cfg.barriers || [];
  s.state.win.x = cfg.x || 800; s.state.win.y = cfg.y || 600;
  s.setFlight(cfg.vx, cfg.vy);
  let t = 0;
  for (let i = 0; i < 600 && s.state.flight; i++) { s.tick(); t += 0.04; if (t > 20) break; }
  assert(s.state, t);
  console.log("PASS: " + name + `  (${t.toFixed(1)}s, 末位置 y=${Math.round(s.state.win.y)}, perch=${s.state.perched}, bounces=${s.state.flight ? s.state.flight.bounces : "settled"})`);
}

// 1. 普通抛物线：应落地于地面 (1040-300+3=743)
run("正常抛物线落地", { x: 800, y: 600, vx: 300, vy: -400 }, (st) => {
  if (st.flight) throw new Error("未落地");
  if (Math.abs(st.win.y - 743) > 2) throw new Error("落点错: y=" + st.win.y + " 期望≈743");
  if (!st.seated) throw new Error("应为坐姿");
});

// 2. 从窗口下方水平穿过：不得被吸上窗顶（bug 修复验证）
run("窗口下方穿过不吸顶", {
  x: 100, y: 500, vx: 600, vy: -300,
  barriers: [{ left: 300, right: 900, top: 200, bottom: 900 }], // 窗顶 y=200 高于弧线最高点
}, (st) => {
  if (st.flight) throw new Error("未落地");
  if (Math.abs(st.win.y - 743) > 2) throw new Error("被吸上窗口: y=" + st.win.y);
  if (st.perched) throw new Error("不应坐窗");
  if (st.win.x < 300) throw new Error("未穿过窗口: x=" + st.win.x);
});

// 3. 落到窗口顶：应从上方落入并坐在窗顶 (窗顶200, 落点=200+3-300=-97)
run("落入窗口顶坐窗", {
  x: 500, y: -120, vx: 0, vy: 200, // 底边 180 高于窗顶 200：正落入
  barriers: [{ left: 300, right: 900, top: 200, bottom: 900 }],
}, (st) => {
  if (st.flight) throw new Error("未落地");
  if (!st.perched) throw new Error("应坐窗");
  if (Math.abs(st.win.y - (-97)) > 2) throw new Error("窗顶落点错: y=" + st.win.y);
});

// 4. 向下猛掷：弹跳后最终停在地面
run("猛掷弹跳后静止", { x: 800, y: 500, vx: 50, vy: 900 }, (st) => {
  if (st.flight) throw new Error("未落地");
  if (Math.abs(st.win.y - 743) > 2) throw new Error("落点错: y=" + st.win.y);
});

// 5. 从地面抛上窗顶：上升穿越不捕获，回落到窗顶
run("从上方抛起越过窗顶回落到窗顶", {
  x: 500, y: 100, vx: 0, vy: -700, // 顶棚反弹后回落，底边穿越窗顶(400)才落窗
  barriers: [{ left: 300, right: 900, top: 400, bottom: 900 }],
}, (st) => {
  if (st.flight) throw new Error("未落地");
  if (!st.perched) throw new Error("应坐窗: y=" + st.win.y);
  if (Math.abs(st.win.y - 103) > 2) throw new Error("窗顶落点错: y=" + st.win.y); // 400+3-300
});

// 6. 从窗口上方越过：不落窗，落地面
run("从窗口上方越过落地面", {
  x: 100, y: 600, vx: 300, vy: -800, // 弧顶高于窗顶但底边不与窗顶交叉
  barriers: [{ left: 300, right: 900, top: 400, bottom: 900 }],
}, (st) => {
  if (st.flight) throw new Error("未落地");
  if (st.perched) throw new Error("不应坐窗");
  if (Math.abs(st.win.y - 743) > 2) throw new Error("应落地面: y=" + st.win.y);
});

// 7. 顶棚反弹：向上猛掷不能穿顶
run("顶棚反弹", { x: 800, y: 300, vx: 0, vy: -1200 }, (st) => {
  if (st.flight) throw new Error("未落地");
  if (st.win.y < 0) throw new Error("穿过顶棚: y=" + st.win.y);
  if (Math.abs(st.win.y - 743) > 2) throw new Error("应最终落地面: y=" + st.win.y);
});

// 8. 高速砸向窗顶：弹跳数次后最终仍坐窗
run("高速砸窗顶弹跳后坐窗", {
  x: 500, y: 100, vx: 0, vy: 900, // 底边 400 从上方高速砸向窗顶
  barriers: [{ left: 300, right: 900, top: 400, bottom: 900 }],
}, (st) => {
  if (st.flight) throw new Error("未落地");
  if (!st.perched) throw new Error("应坐窗: y=" + st.win.y);
  if (Math.abs(st.win.y - 103) > 2) throw new Error("窗顶落点错: y=" + st.win.y);
});

console.log("全部抛掷物理测试通过");
