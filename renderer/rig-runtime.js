/*!
 * SuzuranPet rig-runtime.js — Anime2.5DRig 运行时提取（MIT）
 * 来源: https://github.com/852wa/Anime2.5DRig (index.html 运行时)
 * 去掉 UI/摄像头/麦克风/fps，保留：idle/随机/口型/眨眼/鼠标跟随/发丝物理
 * 用法:
 *   const rt = RigRuntime.init(canvasEl);
 *   const rig = Rigger.buildRig(psd, opts);
 *   rt.applyRig(rig);
 *   rt.setParam('eyeOpenL', 0); rt.setAuto('blink', false);
 *   rt.destroy();
 */
(function (root) {
  "use strict";
  var Rigger = root.Rigger;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  function createGL(canvas) {
    var gl = canvas.getContext("webgl", { alpha: true, stencil: true, antialias: true, premultipliedAlpha: true });
    if (!gl) return null;
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER,
      "attribute vec2 aPos; attribute vec2 aUV; uniform vec2 uRes; varying vec2 vUV;" +
      "void main(){ vUV=aUV; vec2 c = aPos/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }"));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
      "precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uCut; uniform float uAlpha;" +
      "void main(){ vec4 c=texture2D(uTex,vUV); if(c.a<uCut) discard; gl_FragColor=c*uAlpha; }"));
    gl.linkProgram(prog); gl.useProgram(prog);
    var locPos = gl.getAttribLocation(prog, "aPos"), locUV = gl.getAttribLocation(prog, "aUV");
    var locRes = gl.getUniformLocation(prog, "uRes"), locCut = gl.getUniformLocation(prog, "uCut"), locAl = gl.getUniformLocation(prog, "uAlpha");
    gl.enableVertexAttribArray(locPos); gl.enableVertexAttribArray(locUV);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    return { gl, prog, locPos, locUV, locRes, locCut, locAl };
  }

  function mkTex(gl, imgData) {
    var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function Runtime(canvas) {
    var GL = createGL(canvas);
    if (!GL) throw new Error("WebGL 不可用");
    var layers = [], A = null, CW = 768, CH = 768, FS = 1, NP = null, BP = null, FC = null, CHEST = null;
    var bounce = { x: 0, v: 0, dy: 0 };
    // 参数（与 Anime2.5DRig 一致）
    var P = { angleX: 0, angleY: 0, angleZ: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, brow: 0,
      mouthOpen: 0, mouthForm: 0, mouthCY: 0, body: 0, physAmp: 2, soft: 2,
      browAngL: 0, browAngR: 0, browAngSym: 0, bangL: 0, bangC: 0, bangR: 0,
      armY: 0, armPos: 0, bust: 2.5, bustY: 1, irisScale: 1, mouthEase: 0.45, eyeEase: 0.3,
      fhAmp: 2, fhSoft: 0.4, eyeCY: 0, eyeCAng: 0, mouthCAng: 0, eyeScaleL: 1, eyeScaleR: 1, mouthScale: 1 };
    var T = {}, cur = {}, auto = { idle: true, blink: true, rand: true, talk: true, mouse: false, phys: true };
    Object.assign(T, P); Object.assign(cur, P);
    var mouse = { in: false, x: 0, y: 0 };
    var last = 0, raf = 0, destroyed = false;
    var nextRnd = 0, rnd = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 };
    var talkOn = false, nextTalkState = 0, nextSyl = 0, talkTgt = 0, talkV = 0;
    var blinkT = -1, nextBlink = 2000;

    function fadeAlpha(L, e) {
      if (!L.fade) return 1;
      if (L.fade === "eyeOpen") { var v = L.side === "L" ? e.eyeOpenL : e.eyeOpenR; return smooth((v - (0.10 + e.eyeEase * 0.45)) / 0.15); }
      if (L.fade === "eyeClose") { var v2 = L.side === "L" ? e.eyeOpenL : e.eyeOpenR; return 1 - smooth((v2 - (0.10 + e.eyeEase * 0.45)) / 0.15); }
      if (L.fade === "mouthOpen") return smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
      if (L.fade === "mouthClose") return 1 - smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
      return 1;
    }

    function deform(L, e) {
      var b = L.base, o = L.cur, n = b.length;
      var isHead = L.group === "head";
      var az = e.angleZ * 0.07, cz = Math.cos(az), sz = Math.sin(az);
      var ab = e.body * 0.028, cb = Math.cos(ab), sb = Math.sin(ab);
      var nm = L.name, bn = L.bn;
      var eyeSide = L.side, EA = eyeSide === "L" ? A.eyeL : (eyeSide === "R" ? A.eyeR : null);
      var vOpen = eyeSide === "L" ? e.eyeOpenL : e.eyeOpenR;
      var mo = e.mouthOpen;
      var mHalfW = (A.mouth.x1 - A.mouth.x0) / 2;
      var nS = L.strands ? L.strands.length : 0;
      var bcx = L.x + L.w / 2, bcy = L.y + L.h / 2;
      var isFH = (bn === "front hair");
      for (var k = 0; k < n; k += 2) {
        var x = b[k], y = b[k + 1];
        var vi = k >> 1;
        if (EA && bn === "eye_close") {
          var sE = eyeSide === "L" ? e.eyeScaleL : e.eyeScaleR;
          if (sE !== 1) { var cxE = (EA.x0 + EA.x1) / 2, cyE = (EA.y0 + EA.y1) / 2; x = cxE + (x - cxE) * sE; y = cyE + (y - cyE) * sE; }
        }
        if (bn === "mouth_open" || bn === "mouth_close") {
          var sM = e.mouthScale;
          if (sM !== 1) { x = A.mouth.cx + (x - A.mouth.cx) * sM; y = A.mouth.cy + (y - A.mouth.cy) * sM; }
        }
        if (L.fade === "eyeOpen" && EA) {
          if (bn === "irides") {
            var isc = e.irisScale;
            x = EA.icx + (x - EA.icx) * isc; y = EA.icy + (y - EA.icy) * isc;
            x += e.eyeX * 11 * FS; y += e.eyeY * 6 * FS;
            var tl = smooth((0.32 - vOpen) / 0.32);
            y = EA.closeY + (y - EA.closeY) * (1 - 0.80 * tl);
          } else {
            y = EA.closeY + (y - EA.closeY) * (1 - 0.85 * (1 - vOpen));
          }
        }
        if (L.fade === "eyeClose" && EA) {
          y -= vOpen * 3;
          y += e.eyeCY * 14 * FS;
          var thE = e.eyeCAng * 0.3 * (eyeSide === "L" ? 1 : -1);
          if (thE) { var ct2 = Math.cos(thE), st2 = Math.sin(thE), rx2 = x - bcx, ry2 = y - bcy; x = bcx + rx2 * ct2 - ry2 * st2; y = bcy + rx2 * st2 + ry2 * ct2; }
        }
        if (bn === "eyebrow") {
          y += (-e.brow * 9 + (1 - vOpen) * 3.5) * FS;
          var th = (eyeSide === "L" ? (e.browAngL + e.browAngSym) : (e.browAngR - e.browAngSym)) * 0.30;
          if (th) { var ct3 = Math.cos(th), st3 = Math.sin(th), rx3 = x - bcx, ry3 = y - bcy; x = bcx + rx3 * ct3 - ry3 * st3; y = bcy + rx3 * st3 + ry3 * ct3; }
        }
        if (L.fade === "mouthOpen") {
          y = A.mouth.y0 + (y - A.mouth.y0) * (0.5 + 0.5 * mo);
          var q = Math.pow(Math.abs(x - A.mouth.cx) / (mHalfW + 4), 1.5);
          y -= e.mouthForm * 6 * FS * (q - 0.35);
        }
        if (L.fade === "mouthClose") {
          y += e.mouthCY * 14 * FS;
          var thM = e.mouthCAng * 0.35;
          if (thM) { var ct4 = Math.cos(thM), st4 = Math.sin(thM), rx4 = x - A.mouth.cx, ry4 = y - A.mouth.cy; x = A.mouth.cx + rx4 * ct4 - ry4 * st4; y = A.mouth.cy + rx4 * st4 + ry4 * ct4; }
        }
        if (bn === "face" && y > A.mouth.cy) {
          y += mo * 6 * FS * smooth((y - A.mouth.cy) / (A.face.y1 - A.mouth.cy));
        }
        var hw = isHead ? 1 : (L.group === "body" ? 0.16 : 0);
        if (bn === "neck") hw = 0.55 * smooth((A.neckBottom - y) / Math.max(1, A.neckBottom - A.neckTop));
        if (hw > 0) {
          var rx = x - NP.cx, ry = y - NP.cy;
          var rx2b = rx * cz - ry * sz, ry2b = rx * sz + ry * cz;
          x += (rx2b - rx) * hw; y += (ry2b - ry) * hw;
          var dd = L.depth;
          x += hw * FS * (e.angleX * (14 + 40 * (dd - 1)) + e.angleX * (NP.cy - y) * 0.028);
          y += hw * FS * (-e.angleY * (9 + 30 * (dd - 1)) - e.angleY * (dd - 1) * (y - FC.y) * 0.05);
        }
        y -= (L.group === "body" ? e.breath * 2.0 : e.breathHead * 1.6) * FS;
        if (bn === "topwear" && y < CHEST.cy) y -= e.breath * 2.2 * FS * smooth((CHEST.cy - y) / (CHEST.ry * 2));
        if (bn === "topwear") x = NP.cx + (x - NP.cx) * (1 + e.breath * 0.003);
        if (bn === "topwear") {
          var gx = (x - CHEST.cx) / CHEST.rx, gy = (y - (CHEST.cy + e.bustY * 70 * FS)) / CHEST.ry;
          y += bounce.dy * e.bust * Math.exp(-gx * gx - gy * gy);
        }
        if (bn === "handwear") {
          var w = smooth((y - L.y) / L.h * 1.15);
          y -= e.armY * 30 * FS * w;
          y += e.armPos * 40 * FS;
          x += e.armY * 6 * FS * w * (x < NP.cx ? 1 : -1);
        }
        if (L.bw && L.su) { var m = Math.pow(L.su[vi], 1.4) * 22 * FS; x += (e.bangL * L.bw[vi * 3] + e.bangC * L.bw[vi * 3 + 1] + e.bangR * L.bw[vi * 3 + 2]) * m; }
        if (nS && auto.phys) {
          var u = isFH ? Math.min(1, L.su[vi] * 1.6) : L.su[vi];
          var amp = Math.pow(u, isFH ? 1.8 : 2.1) * (isFH ? e.fhAmp : e.physAmp);
          var softMix = Math.pow(u, 1.2) * (isFH ? e.fhSoft : e.soft);
          var dx = 0;
          for (var s = 0; s < nS; s++) {
            var w2 = L.sw[vi * nS + s]; if (w2 < 0.001) continue;
            var sp = L.spr[s];
            dx += w2 * (sp.stiff.dx * (1 - softMix) + sp.soft.dx * softMix);
          }
          x += dx * amp; y += Math.abs(dx) * amp * 0.12;
        }
        o[k] = x; o[k + 1] = y;
      }
      if (Math.abs(ab) > 1e-4) {
        for (var k2 = 0; k2 < n; k2 += 2) {
          var rxx = o[k2] - BP.cx, ryy = o[k2 + 1] - BP.cy;
          o[k2] = BP.cx + rxx * cb - ryy * sb; o[k2 + 1] = BP.cy + rxx * sb + ryy * cb;
        }
      }
    }

    function applyRig(rig) {
      for (var i = 0; i < layers.length; i++) {
        var L0 = layers[i];
        GL.gl.deleteTexture(L0.tex); GL.gl.deleteBuffer(L0.vboPos); GL.gl.deleteBuffer(L0.vboUV); GL.gl.deleteBuffer(L0.ibo);
      }
      layers = [];
      // v2.2 fit：画布裁剪到角色包围盒（+2% padding），让角色占满显示，避免 768 画布内角色过小/被裁
      if (rig && rig.layers && rig.layers.length) {
        var bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
        for (var fi = 0; fi < rig.layers.length; fi++) {
          var fl = rig.layers[fi];
          if (fl.x < bx0) bx0 = fl.x; if (fl.y < by0) by0 = fl.y;
          if (fl.x + fl.w > bx1) bx1 = fl.x + fl.w; if (fl.y + fl.h > by1) by1 = fl.y + fl.h;
        }
        if (bx1 > bx0 && by1 > by0) {
          var pad = Math.max(2, Math.round(Math.min(bx1 - bx0, by1 - by0) * 0.02));
          bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad);
          bx1 = Math.min(rig.canvas.w, bx1 + pad); by1 = Math.min(rig.canvas.h, by1 + pad);
          var offX = bx0, offY = by0;
          rig = { canvas: { w: bx1 - bx0, h: by1 - by0 }, anchors: rig.anchors, warnings: rig.warnings || [], synth: rig.synth,
            layers: rig.layers.map(function (L) { return Object.assign({}, L, { x: L.x - offX, y: L.y - offY }); }) };
          var A2 = rig.anchors;
          var offAnchor = function (p) {
            if (!p) return;
            if (p.x0 != null) p.x0 -= offX; if (p.x1 != null) p.x1 -= offX;
            if (p.y0 != null) p.y0 -= offY; if (p.y1 != null) p.y1 -= offY;
            if (p.cx != null) p.cx -= offX; if (p.cy != null) p.cy -= offY;
            if (p.icx != null) p.icx -= offX; if (p.icy != null) p.icy -= offY;
            if (p.closeY != null) p.closeY -= offY;
          };
          offAnchor(A2.face); offAnchor(A2.mouth); offAnchor(A2.eyeL); offAnchor(A2.eyeR);
          offAnchor(A2.neckPivot); offAnchor(A2.bodyPivot);
          if (A2.neckTop != null) A2.neckTop -= offY;
          if (A2.neckBottom != null) A2.neckBottom -= offY;
        }
      }
      CW = rig.canvas.w; CH = rig.canvas.h; A = rig.anchors; FS = A.faceScale;
      NP = A.neckPivot; BP = A.bodyPivot; FC = { x: A.face.cx, y: A.face.cy };
      CHEST = { cx: NP.cx, cy: A.neckBottom + (A.face.y1 - A.face.y0) * 0.60,
        rx: (A.face.x1 - A.face.x0) * 0.60, ry: (A.face.y1 - A.face.y0) * 0.45 };
      for (var j = 0; j < rig.layers.length; j++) {
        var Lr = rig.layers[j];
        var L = Object.assign({}, Lr);
        var cell = (L.phys ? 30 : 42) * Math.max(0.6, CW / 768);
        var nx = Math.max(2, Math.round(L.w / cell)), ny = Math.max(2, Math.round(L.h / cell));
        var nv = (nx + 1) * (ny + 1);
        var base = new Float32Array(nv * 2), uv = new Float32Array(nv * 2);
        var k = 0;
        for (var jj = 0; jj <= ny; jj++) for (var ii = 0; ii <= nx; ii++) {
          base[k] = L.x + L.w * ii / nx; base[k + 1] = L.y + L.h * jj / ny; uv[k] = ii / nx; uv[k + 1] = jj / ny; k += 2;
        }
        var idx = [];
        for (var j3 = 0; j3 < ny; j3++) for (var i3 = 0; i3 < nx; i3++) {
          var a = j3 * (nx + 1) + i3, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, b, c, b, d, c);
        }
        L.base = base; L.cur = new Float32Array(base); L.nIdx = idx.length;
        L.bn = Rigger.baseName(L.name.replace(/_(l|r)$/, ""));
        if (L.strands && L.strands.length) {
          var S = L.strands, nS = S.length;
          var spacing = 120;
          if (nS > 1) { var ds = []; for (var s1 = 1; s1 < nS; s1++) ds.push(S[s1].x - S[s1 - 1].x); ds.sort(function (x, y) { return x - y; }); spacing = ds[ds.length >> 1]; }
          var sig = spacing * 0.6;
          L.sw = new Float32Array(nv * nS); L.su = new Float32Array(nv);
          L.spr = S.map(function (s, si) { return { stiff: { x: 0, v: 0, dx: 0 }, soft: { x: 0, v: 0, dx: 0 }, phase: si * 1.37 + L.z }; });
          for (var v = 0; v < nv; v++) {
            var xv = base[v * 2], yv = base[v * 2 + 1];
            var tot = 0;
            for (var s2 = 0; s2 < nS; s2++) { var wv = Math.exp(-Math.pow((xv - S[s2].x) / sig, 2)); L.sw[v * nS + s2] = wv; tot += wv; }
            var rY = 0, tY = 0;
            if (tot > 1e-6) { for (var s3 = 0; s3 < nS; s3++) { L.sw[v * nS + s3] /= tot; rY += L.sw[v * nS + s3] * S[s3].rootY; tY += L.sw[v * nS + s3] * S[s3].tipY; } }
            else { L.sw[v * nS + 0] = 1; rY = S[0].rootY; tY = S[0].tipY; }
            L.su[v] = Math.min(1, Math.max(0, (yv - rY) / Math.max(1, tY - rY)));
          }
          if (L.bn === "front hair") {
            var fw = A.face.x1 - A.face.x0, fcx = A.face.cx;
            var f = 36, b1 = fcx - fw * 0.22, b2 = fcx + fw * 0.22;
            L.bw = new Float32Array(nv * 3);
            for (var v2 = 0; v2 < nv; v2++) { var x2 = base[v2 * 2];
              var s1b = smooth((x2 - b1) / f + 0.5), s2b = smooth((x2 - b2) / f + 0.5);
              L.bw[v2 * 3] = 1 - s1b; L.bw[v2 * 3 + 1] = s1b * (1 - s2b); L.bw[v2 * 3 + 2] = s2b; }
          }
        }
        L.vboPos = GL.gl.createBuffer(); L.vboUV = GL.gl.createBuffer(); L.ibo = GL.gl.createBuffer();
        GL.gl.bindBuffer(GL.gl.ARRAY_BUFFER, L.vboUV); GL.gl.bufferData(GL.gl.ARRAY_BUFFER, uv, GL.gl.STATIC_DRAW);
        GL.gl.bindBuffer(GL.gl.ELEMENT_ARRAY_BUFFER, L.ibo); GL.gl.bufferData(GL.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), GL.gl.STATIC_DRAW);
        var idata = (typeof ImageData !== "undefined") ? new ImageData(new Uint8ClampedArray(L.img.data), L.img.width, L.img.height) : L.img;
        L.tex = mkTex(GL.gl, idata); delete L.img;
        layers.push(L);
      }
      canvas.width = CW; canvas.height = CH;
    }

    function tick(now) {
      if (destroyed) return;
      raf = requestAnimationFrame(tick);
      if (!layers.length || !A) return;
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      var t = now / 1000;
      var tgt = Object.assign({}, T);
      if (auto.mouse && mouse.in) {
        tgt.angleX = clamp(mouse.x * 0.9, -1, 1); tgt.angleY = clamp(-mouse.y * 0.7, -1, 1);
        tgt.eyeX = clamp(mouse.x * 1.2, -1, 1); tgt.eyeY = clamp(-mouse.y * 0.8, -1, 1);
      }
      if (auto.idle) {
        tgt.angleX += 0.13 * Math.sin(t * 0.42) + 0.05 * Math.sin(t * 1.13);
        tgt.angleY += 0.08 * Math.sin(t * 0.31 + 1.7);
        tgt.angleZ += 0.07 * Math.sin(t * 0.23 + 0.5);
        tgt.body += 0.10 * Math.sin(t * 0.19 + 2.1);
      }
      if (auto.rand) {
        if (now > nextRnd) {
          nextRnd = now + 1400 + Math.random() * 2600;
          rnd.ax = (Math.random() * 2 - 1) * 0.55; rnd.ay = (Math.random() * 2 - 1) * 0.40;
          rnd.az = (Math.random() * 2 - 1) * 0.35; rnd.bd = (Math.random() * 2 - 1) * 0.30;
          rnd.ex = (Math.random() * 2 - 1) * 0.60; rnd.ey = (Math.random() * 2 - 1) * 0.35;
        }
        tgt.angleX = clamp(tgt.angleX + rnd.ax, -1, 1); tgt.angleY = clamp(tgt.angleY + rnd.ay, -1, 1);
        tgt.angleZ = clamp(tgt.angleZ + rnd.az, -1, 1); tgt.body = clamp(tgt.body + rnd.bd, -1, 1);
        tgt.eyeX = clamp(tgt.eyeX + rnd.ex, -1, 1); tgt.eyeY = clamp(tgt.eyeY + rnd.ey, -1, 1);
      }
      if (auto.talk) {
        if (now > nextTalkState) { talkOn = !talkOn; nextTalkState = now + (talkOn ? 1200 + Math.random() * 2200 : 600 + Math.random() * 1800); }
        if (talkOn && now > nextSyl) { nextSyl = now + 70 + Math.random() * 110; talkTgt = Math.random() < 0.25 ? 0.04 : 0.25 + Math.random() * 0.75; }
        if (!talkOn) talkTgt = 0;
        talkV += (talkTgt - talkV) * Math.min(1, dt * 22);
        tgt.mouthOpen = Math.max(tgt.mouthOpen, talkV);
      }
      if (auto.blink) {
        if (blinkT < 0 && now > nextBlink) { blinkT = 0; nextBlink = now + 1600 + Math.random() * 3800; if (Math.random() < 0.18) nextBlink = now + 280; }
        if (blinkT >= 0) {
          blinkT += dt;
          var d = blinkT; var v;
          if (d < 0.08) v = 1 - d / 0.08; else if (d < 0.42) v = 0; else if (d < 0.58) v = (d - 0.42) / 0.16; else { v = 1; blinkT = -1; }
          tgt.eyeOpenL = Math.min(tgt.eyeOpenL, v); tgt.eyeOpenR = Math.min(tgt.eyeOpenR, v);
        }
      }
      for (var k in cur) cur[k] += (tgt[k] - cur[k]) * Math.min(1, dt * 14);
      var e = Object.assign({}, cur);
      e.breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4);
      e.breathHead = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4 - 0.6);
      var headDX = (e.angleX * 14 + e.angleZ * 0.07 * (NP.cy - FC.y)) * FS;
      for (var li = 0; li < layers.length; li++) {
        var L = layers[li];
        if (!L.spr) continue;
        for (var sp of L.spr) {
          var wind = auto.idle ? (1.8 * Math.sin(t * 0.8 + sp.phase) + 1.0 * Math.sin(t * 1.9 + sp.phase * 2.3)) : 0;
          var txv = headDX + wind * FS;
          var kk = 70, cc = 9;
          var axv = -kk * (sp.stiff.x - txv) - cc * sp.stiff.v; sp.stiff.v += axv * dt; sp.stiff.x += sp.stiff.v * dt;
          sp.stiff.dx = -(sp.stiff.x - txv) * 2.2;
          kk = 16; cc = 1.3;
          axv = -kk * (sp.soft.x - txv) - cc * sp.soft.v; sp.soft.v += axv * dt; sp.soft.x += sp.soft.v * dt;
          sp.soft.dx = -(sp.soft.x - txv) * 3.0;
        }
      }
      var bustTgt = (e.breath * 3.0 - e.angleY * 6.0 + e.body * 4.0) * FS;
      var kk2 = 140, cc2 = 4.2;
      var aa = -kk2 * (bounce.x - bustTgt) - cc2 * bounce.v; bounce.v += aa * dt; bounce.x += bounce.v * dt;
      bounce.dy = -(bounce.x - bustTgt) * 3.0;
      var gl = GL.gl;
      gl.viewport(0, 0, CW, CH);
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.uniform2f(GL.locRes, CW, CH);
      for (var lj = 0; lj < layers.length; lj++) {
        var L2 = layers[lj];
        var fa = fadeAlpha(L2, e);
        if (fa < 0.004 && !(L2.fade === "eyeOpen" && L2.name.indexOf("eyewhite") === 0)) continue;
        deform(L2, e);
        gl.uniform1f(GL.locAl, fa);
        gl.bindBuffer(gl.ARRAY_BUFFER, L2.vboPos);
        gl.bufferData(gl.ARRAY_BUFFER, L2.cur, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(GL.locPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, L2.vboUV);
        gl.vertexAttribPointer(GL.locUV, 2, gl.FLOAT, false, 0, 0);
        gl.bindTexture(gl.TEXTURE_2D, L2.tex);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L2.ibo);
        if (L2.name.indexOf("eyewhite") === 0) {
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.uniform1f(GL.locCut, 0.25);
          gl.drawElements(gl.TRIANGLES, L2.nIdx, gl.UNSIGNED_SHORT, 0);
          gl.disable(gl.STENCIL_TEST); gl.uniform1f(GL.locCut, 0.0);
        } else if (L2.name.indexOf("irides") === 0) {
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          gl.drawElements(gl.TRIANGLES, L2.nIdx, gl.UNSIGNED_SHORT, 0);
          gl.disable(gl.STENCIL_TEST);
        } else {
          gl.drawElements(gl.TRIANGLES, L2.nIdx, gl.UNSIGNED_SHORT, 0);
        }
      }
    }

    // 鼠标跟随：窗口内以画布中心为原点 x/y∈[-1,1]；全局模式（setMouseMode(true)）由外部注入坐标
    var extMode = false;
    function onMove(ev) {
      if (extMode) return;
      var r = canvas.getBoundingClientRect();
      var mx = ((ev.clientX - r.left) / r.width) * 2 - 1;
      var my = ((ev.clientY - r.top) / r.height) * 2 - 1;
      mouse.in = true; mouse.x = mx; mouse.y = my;
    }
    function onLeave() { if (!extMode) mouse.in = false; }
    // 全局跟踪：注入屏幕坐标换算后的相对偏移（x/y 可超出 ±1，tick 内 clamp）
    function setExternalMouse(x, y) {
      extMode = true; mouse.in = true; mouse.x = x; mouse.y = y;
    }
    function setMouseMode(global) {
      extMode = !!global;
      if (!extMode) mouse.in = false;
    }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    last = (typeof performance !== "undefined" ? performance.now() : 0);
    raf = requestAnimationFrame(tick);

    return {
      applyRig: applyRig,
      setParam: function (key, val) { if (key in T) T[key] = val; },
      getParam: function (key) { return T[key]; },
      setAuto: function (key, val) { if (key in auto) auto[key] = !!val; },
      setExternalMouse: setExternalMouse,
      setMouseMode: setMouseMode,
      preset: function (name) {
        var p = { neutral: { eyeOpenL: 1, eyeOpenR: 1, brow: 0, mouthOpen: 0, mouthForm: 0, irisScale: 1 },
          smile: { eyeOpenL: 0, eyeOpenR: 0, brow: 0.45, mouthOpen: 0, mouthForm: 0.9, irisScale: 1 },
          surprise: { eyeOpenL: 1, eyeOpenR: 1, brow: 1, mouthOpen: 0.75, mouthForm: -0.1, irisScale: 0.7 },
          wink: { eyeOpenL: 0, eyeOpenR: 1, brow: 0.2, mouthOpen: 0.4, mouthForm: 0.7, irisScale: 1 } }[name];
        if (p) for (var k in p) T[k] = p[k];
      },
      destroy: function () {
        destroyed = true;
        cancelAnimationFrame(raf);
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
        for (var i = 0; i < layers.length; i++) {
          var L = layers[i];
          try { GL.gl.deleteTexture(L.tex); GL.gl.deleteBuffer(L.vboPos); GL.gl.deleteBuffer(L.vboUV); GL.gl.deleteBuffer(L.ibo); } catch (e) { }
        }
        layers = [];
      }
    };
  }

  // 跟随能力自适应（v2.2.1 实验性）：换 PSD 后按 rig 结构评估鼠标跟随支持级别，供调用方自动开启/降级。
  // 不依赖特定 PSD：头部跟随依赖 face/neckPivot 锚点（rigger 对缺失有兜底，几乎恒可用）；
  // 眼睛跟随要求眼白(eyewhite)左右分离出 eyeL/eyeR 锚点 + 虹膜(irides)图层，缺任一则眼睛不会动（降级为仅头部）。
  function detectFollow(rig) {
    var A = (rig && rig.anchors) || {}, layers = (rig && rig.layers) || [], i, p;
    var hasFace = !!(A.face && A.face.cx != null && A.face.cy != null);
    var hasEyeL = !!(A.eyeL && A.eyeL.icx != null), hasEyeR = !!(A.eyeR && A.eyeR.icx != null);
    var hasIrisL = false, hasIrisR = false;
    for (i = 0; i < layers.length; i++) {
      p = layers[i].name || "";
      if (p === "irides_l") hasIrisL = true;
      else if (p === "irides_r") hasIrisR = true;
    }
    if (hasFace && hasEyeL && hasEyeR && hasIrisL && hasIrisR)
      return { level: "full", head: true, eyes: true, reason: "眼白+虹膜左右分离完整" };
    if (hasFace)
      return { level: "head-only", head: true, eyes: false, reason: (hasEyeL && hasEyeR) ? "有眼白锚点但无虹膜图层" : "无分离眼白/虹膜（整眼或命名不同）" };
    return { level: "none", head: false, eyes: false, reason: "脸部锚点缺失" };
  }

  root.RigRuntime = { init: Runtime, detectFollow: detectFollow };
})(typeof self !== "undefined" ? self : this);
