/* ============================================================
   全屏粒子特效 — 零依赖 Canvas 2D
   · 画布固定铺满视口，滚动时粒子轻微上移，形成远景视差
   · 粒子数量按视口面积自适应；触屏 / 小屏自动降载
   · 抖动网格初始化，避免随机撒点出现大片空白
   · 邻域连线，鼠标悬停高亮；按住拖拽时形成力场，粒子被
     吸过来跟着手走，内核排斥防止堆成一团，松手动量消散
   · 空间网格分桶，连线计算近似 O(n)
   · prefers-reduced-motion 下只渲染静态一帧
   调参入口：下面的 CNF
   ============================================================ */
(function () {
  'use strict';

  var canvas = document.getElementById('particles');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* ---------------- 可调参数 ---------------- */
  var CNF = {
    LINK: 124,          // 连线判定距离（px）
    MOUSE_R: 215,       // 悬停高亮半径（px）
    PARALLAX: 0.05,     // 滚动视差系数
    DENSITY: 4200,      // 每个粒子摊到多少 px²，越小越密
    DENSITY_TOUCH: 8000,
    MIN: 60,
    MAX: 420,
    LINK_RATIO: 0.3,    // 参与连线的粒子占比，其余只做漂浮尘埃
    DRIFT: 0.15,        // 基础漂移速度上限（px/帧）
    SEPARATE: 48,       // 互斥半径：挨太近的粒子互相推开，防止结团
    SEPARATE_F: 0.09,   // 互斥强度
    DRAG_R: 285,        // 拖拽力场半径（px）
    DRAG_CORE: 84,      // 内核排斥半径（px）
    DRAG_PULL: 0.05,    // 吸引强度（弱，只提供牵引感）
    DRAG_PUSH: 0.62,    // 内核排斥强度
    DRAG_FOLLOW: 1,     // 位移跟随权重峰值：1 = 完全跟手
    DRAG_FALLOFF: 1.15, // 跟随衰减指数，越小外圈响应越灵敏
    DRAG_FOLLOW_V: 0.09,// 跟随位移转成惯性的比例
    DRAG_DAMP: 0.90,    // 拖拽中的速度阻尼
    FREE_DAMP: 0.95,    // 松手后的速度阻尼
    MAX_V: 12,          // 扰动速度上限（px/帧）
    LINE_A: 0.17,       // 连线最高不透明度
    MOUSE_LINE_A: 0.17, // 指针附近连线额外不透明度
    DOT_A: 0.72,        // 粒子最高不透明度
    GLOW_A: 0.15,       // 粒子光晕最高不透明度
    MOTE_A: 0.075       // 大光斑最高不透明度
  };

  var TAU = Math.PI * 2;
  var CELL = CNF.LINK;
  var L2 = CNF.LINK * CNF.LINK;
  var M2 = CNF.MOUSE_R * CNF.MOUSE_R;
  var DR2 = CNF.DRAG_R * CNF.DRAG_R;

  /* ---------------- 颜色查找表（每帧零字符串拼接） ---------------- */
  var PALETTE = [
    '255,143,184',  // rose
    '185,163,239',  // lilac
    '143,200,245',  // sky
    '134,221,207',  // mint
    '255,185,143',  // peach
    '255,217,119'   // butter
  ];
  var STEPS = 40;

  function lut(list, peak) {
    return list.map(function (rgb) {
      var arr = [];
      for (var i = 0; i <= STEPS; i++) {
        arr.push('rgba(' + rgb + ',' + (peak * i / STEPS).toFixed(3) + ')');
      }
      return arr;
    });
  }

  var L_DOT = lut(PALETTE, CNF.DOT_A);
  var L_GLOW = lut(PALETTE, CNF.GLOW_A);
  var L_MOTE = lut(PALETTE, CNF.MOTE_A);
  var L_LINE = lut(['214,150,190'], CNF.LINE_A + CNF.MOUSE_LINE_A)[0];

  function idx(s) {
    var i = (STEPS * s) | 0;
    return i < 0 ? 0 : (i > STEPS ? STEPS : i);
  }

  /* ---------------- 运行时状态 ---------------- */
  var w = 0, h = 0, dpr = 1;
  var dots = [], linkers = [], motes = [], grid = [];
  var gcols = 0, grows = 0;
  var ptr = { x: -9999, y: -9999, dx: 0, dy: 0, on: false, down: false };
  var lastPtrX = -9999, lastPtrY = -9999;
  var scrollY = 0, lastScroll = 0;
  var raf = 0, tick = 0, seq = 0, lineCount = 0, cost = 0, pairCount = 0;
  var followK = 1;   // 外部（拖拽翻页）可临时压低跟随强度

  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function makeDot() {
    return {
      id: seq++,
      x: 0, y: 0,
      bx: rnd(-CNF.DRIFT, CNF.DRIFT), by: rnd(-CNF.DRIFT, CNF.DRIFT),
      px: 0, py: 0,
      r: rnd(1.0, 2.6),
      a: rnd(0.46, 1),
      ci: (Math.random() * PALETTE.length) | 0,
      ph: rnd(0, TAU),
      ps: rnd(0.010, 0.024),
      cx: 0, cy: 0, lk: 0
    };
  }

  function makeMote() {
    return {
      x: 0, y: 0,
      bx: rnd(-0.05, 0.05), by: rnd(-0.05, 0.05),
      px: 0, py: 0,
      r: rnd(24, 52),
      a: rnd(0.5, 1),
      ci: (Math.random() * PALETTE.length) | 0,
      ph: rnd(0, TAU),
      ps: rnd(0.004, 0.010)
    };
  }

  /* 抖动网格：把粒子摊匀，避免随机撒点留出大片空白 */
  function scatter(list, inset) {
    var n = list.length;
    if (!n) return;
    var cols = Math.max(1, Math.round(Math.sqrt(n * w / h)));
    var rows = Math.max(1, Math.ceil(n / cols));
    var cw = w / cols, ch = h / rows;
    for (var i = 0; i < n; i++) {
      var p = list[i];
      p.x = (i % cols) * cw + rnd(inset, 1 - inset) * cw;
      p.y = ((i / cols) | 0) * ch + rnd(inset, 1 - inset) * ch;
    }
  }

  /* ---------------- 尺寸与重建 ---------------- */
  function resize() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    if (!cw || !ch) return;

    w = cw; h = ch;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    build();
    if (reduce) draw();
  }

  function build() {
    var area = w * h;
    var per = coarse ? CNF.DENSITY_TOUCH : CNF.DENSITY;
    var want = Math.round(area / per);
    want = want < CNF.MIN ? CNF.MIN : (want > CNF.MAX ? CNF.MAX : want);

    if (dots.length > want) dots.length = want;
    while (dots.length < want) dots.push(makeDot());
    scatter(dots, 0.14);

    var i;
    for (i = 0; i < dots.length; i++) dots[i].lk = 0;
    linkers = dots.slice(0, Math.round(want * CNF.LINK_RATIO));
    for (i = 0; i < linkers.length; i++) linkers[i].lk = 1;

    var mwant = Math.round(area / 200000);
    mwant = mwant < 5 ? 5 : (mwant > 10 ? 10 : mwant);
    if (motes.length > mwant) motes.length = mwant;
    while (motes.length < mwant) motes.push(makeMote());
    scatter(motes, 0.2);

    gcols = Math.max(1, Math.ceil(w / CELL));
    grows = Math.max(1, Math.ceil(h / CELL));
    grid.length = 0;
    for (var i = 0; i < gcols * grows; i++) grid.push([]);
  }

  /* ---------------- 位置推进 ---------------- */
  function wrap(p, pad) {
    var sx = w + pad * 2, sy = h + pad * 2;
    p.x = ((p.x + pad) % sx + sx) % sx - pad;
    p.y = ((p.y + pad) % sy + sy) % sy - pad;
  }

  /* 空间分桶：所有粒子入桶，连线与互斥共用同一套桶 */
  function bucket() {
    var i, p, cx, cy;
    for (i = 0; i < grid.length; i++) grid[i].length = 0;
    for (i = 0; i < dots.length; i++) {
      p = dots[i];
      cx = (p.x / CELL) | 0;
      cy = (p.y / CELL) | 0;
      if (cx < 0) cx = 0; else if (cx >= gcols) cx = gcols - 1;
      if (cy < 0) cy = 0; else if (cy >= grows) cy = grows - 1;
      p.cx = cx; p.cy = cy;
      grid[cy * gcols + cx].push(p);
    }
  }

  /* 互斥：挨太近的粒子互相推开，保证铺开而不是结团 */
  function separate() {
    var R = CNF.SEPARATE, R2 = R * R, F = CNF.SEPARATE_F;
    var i, gx, gy, k, a, b, dx, dy, dsq, d, f, ux, uy, arr;

    for (i = 0; i < dots.length; i++) {
      a = dots[i];
      for (gy = a.cy - 1; gy <= a.cy + 1; gy++) {
        if (gy < 0 || gy >= grows) continue;
        for (gx = a.cx - 1; gx <= a.cx + 1; gx++) {
          if (gx < 0 || gx >= gcols) continue;
          arr = grid[gy * gcols + gx];
          for (k = 0; k < arr.length; k++) {
            b = arr[k];
            if (b.id <= a.id) continue;
            dx = a.x - b.x; dy = a.y - b.y;
            dsq = dx * dx + dy * dy;
            if (dsq > R2 || dsq < 0.01) continue;
            d = Math.sqrt(dsq);
            f = (1 - d / R) * F;
            ux = dx / d * f; uy = dy / d * f;
            a.px += ux; a.py += uy;
            b.px -= ux; b.py -= uy;
            pairCount++;
          }
        }
      }
    }
  }

  /* 拖拽跟随 + 力场 + 阻尼 + 视差；scale 让大光斑反应更迟缓 */
  function step(list, scale, pad, maxV, parallax) {
    var pull = ptr.down;
    var damp = pull ? CNF.DRAG_DAMP : CNF.FREE_DAMP;
    var mv2 = maxV * maxV;
    var mdx = ptr.dx, mdy = ptr.dy;

    for (var i = 0; i < list.length; i++) {
      var p = list[i];

      if (pull) {
        var dx = ptr.x - p.x, dy = ptr.y - p.y;
        var dsq = dx * dx + dy * dy;
        if (dsq < DR2) {
          var d = Math.sqrt(dsq);
          if (d < 0.001) d = 0.001;

          // 位移跟随：手移到哪，附近的粒子跟着平移，边缘有拖尾
          if (mdx !== 0 || mdy !== 0) {
            var s = 1 - d / CNF.DRAG_R;
            var w = Math.pow(s, CNF.DRAG_FALLOFF) * CNF.DRAG_FOLLOW * followK * scale;
            p.x += mdx * w;
            p.y += mdy * w;
            p.px += mdx * w * CNF.DRAG_FOLLOW_V;
            p.py += mdy * w * CNF.DRAG_FOLLOW_V;
          }

          // 力场：内核推开防止贴脸，外圈轻微牵引
          var f = d < CNF.DRAG_CORE
            ? -(1 - d / CNF.DRAG_CORE) * CNF.DRAG_PUSH
            : (1 - (d - CNF.DRAG_CORE) / (CNF.DRAG_R - CNF.DRAG_CORE)) * CNF.DRAG_PULL;
          p.px += dx / d * f * scale;
          p.py += dy / d * f * scale;
        }
      }

      p.px *= damp;
      p.py *= damp;

      var v2 = p.px * p.px + p.py * p.py;
      if (v2 > mv2) {
        var k = maxV / Math.sqrt(v2);
        p.px *= k;
        p.py *= k;
      }

      p.x += p.bx + p.px;
      p.y += p.by + p.py - parallax;
      wrap(p, pad);
    }
  }

  function update() {
    var dy = (scrollY - lastScroll) * CNF.PARALLAX;
    lastScroll = scrollY;
    if (dy > 40) dy = 40; else if (dy < -40) dy = -40;

    // 本帧指针位移，用于位移跟随
    ptr.dx = ptr.x - lastPtrX;
    ptr.dy = ptr.y - lastPtrY;
    lastPtrX = ptr.x;
    lastPtrY = ptr.y;

    pairCount = 0;
    bucket();
    separate();

    step(motes, 0.35, 80, 3, dy * 0.6);
    step(dots, 1, 26, CNF.MAX_V, dy);
  }

  /* ---------------- 绘制 ---------------- */
  function draw() {
    ctx.clearRect(0, 0, w, h);
    tick++;
    lineCount = 0;

    var i, k, gx, gy, p, a, arr, dx, dy, dsq;

    /* 大颗柔光尘埃（底层） */
    for (i = 0; i < motes.length; i++) {
      p = motes[i];
      var mp = 1 + Math.sin(tick * p.ps + p.ph) * 0.12;
      ctx.beginPath();
      ctx.fillStyle = L_MOTE[p.ci][idx(p.a * mp)];
      ctx.arc(p.x, p.y, p.r * mp, 0, TAU);
      ctx.fill();
    }

    /* 邻域连线（复用 update 里建好的桶） */
    ctx.lineWidth = 1;
    for (i = 0; i < linkers.length; i++) {
      a = linkers[i];
      for (gy = a.cy - 1; gy <= a.cy + 1; gy++) {
        if (gy < 0 || gy >= grows) continue;
        for (gx = a.cx - 1; gx <= a.cx + 1; gx++) {
          if (gx < 0 || gx >= gcols) continue;
          arr = grid[gy * gcols + gx];
          for (k = 0; k < arr.length; k++) {
            var b = arr[k];
            if (!b.lk || b.id <= a.id) continue;
            dx = a.x - b.x; dy = a.y - b.y;
            dsq = dx * dx + dy * dy;
            if (dsq > L2) continue;
            var near = 1 - Math.sqrt(dsq) / CNF.LINK;
            var ls = near;
            if (ptr.on) {
              var mx = (a.x + b.x) * 0.5 - ptr.x;
              var my = (a.y + b.y) * 0.5 - ptr.y;
              if (mx * mx + my * my < M2) ls += near * (CNF.MOUSE_LINE_A / CNF.LINE_A);
            }
            ctx.strokeStyle = L_LINE[idx(ls)];
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            lineCount++;
          }
        }
      }
    }

    /* 粒子本体 + 光晕 */
    for (i = 0; i < dots.length; i++) {
      p = dots[i];
      var pulse = 0.55 + 0.45 * (1 + Math.sin(tick * p.ps + p.ph) * 0.22);
      var mn = 0;
      if (ptr.on) {
        dx = p.x - ptr.x; dy = p.y - ptr.y;
        dsq = dx * dx + dy * dy;
        if (dsq < M2) {
          mn = 1 - Math.sqrt(dsq) / CNF.MOUSE_R;
          if (ptr.down) mn += 0.25;
        }
      }
      var r = p.r * (1 + mn * 0.9);
      var ai = idx(p.a * pulse + mn * 0.22);
      var gi = idx(p.a * pulse * 0.9);

      ctx.beginPath();
      ctx.fillStyle = L_GLOW[p.ci][gi];
      ctx.arc(p.x, p.y, r * 3.4, 0, TAU);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = L_DOT[p.ci][ai];
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
  }

  /* ---------------- 循环 ---------------- */
  function loop() {
    raf = requestAnimationFrame(loop);
    // 灯箱打开时画面被遮住，跳过绘制省电
    if (document.body.classList.contains('is-locked')) return;
    var t0 = performance.now();
    update();
    draw();
    var dt = performance.now() - t0;
    cost = cost ? cost * 0.9 + dt * 0.1 : dt;
  }

  function start() {
    if (raf || reduce) return;
    lastScroll = scrollY;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ---------------- 指针交互 ---------------- */
  scrollY = window.pageYOffset || 0;
  lastScroll = scrollY;

  var downX = 0, downY = 0, moved = false;

  function interactive(el) {
    // 在按钮 / 链接上按下时不当作拖拽起点
    return !!(el && el.closest && el.closest('a, button, input, textarea, .lightbox'));
  }

  function setPos(e) {
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    ptr.on = true;
  }

  window.addEventListener('pointermove', function (e) {
    setPos(e);
    if (ptr.down && (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6)) {
      moved = true;
    }
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (interactive(e.target)) return;
    setPos(e);
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    ptr.dx = 0;
    ptr.dy = 0;
    ptr.down = true;
    moved = false;
    downX = e.clientX;
    downY = e.clientY;
    document.body.classList.add('is-dragging');
  }, { passive: true });

  function release() {
    if (!ptr.down) return;
    ptr.down = false;
    document.body.classList.remove('is-dragging');
  }

  window.addEventListener('pointerup', release, { passive: true });
  window.addEventListener('pointercancel', release, { passive: true });
  document.addEventListener('mouseleave', function () {
    ptr.on = false;
    release();
  });

  // 拖过之后再松开，抑制这一次 click，避免误触发卡片灯箱
  window.addEventListener('click', function (e) {
    if (!moved) return;
    moved = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  window.addEventListener('scroll', function () {
    scrollY = window.pageYOffset || 0;
  }, { passive: true });

  var rt = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(resize, 180);
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  resize();
  start();

  // 调试 / 外部调参入口
  window.__particles = {
    config: CNF,
    pause: function () { stop(); },
    resume: function () { start(); },
    // 拖拽翻页时临时压低跟随强度，避免翻页和撸粒子互相打架
    setFollow: function (k) {
      followK = k < 0 ? 0 : (k > 1 ? 1 : k);
    },
    stats: function () {
      return {
        dots: dots.length,
        linkers: linkers.length,
        motes: motes.length,
        lines: lineCount,
        pairs: pairCount,
        size: w + 'x' + h,
        tick: tick,
        dragging: ptr.down,
        msPerFrame: +cost.toFixed(2)
      };
    },
    // 铺开程度：最近邻距离（均值 / 标准差 / 极值）
    spread: function () {
      var s = 0, s2 = 0, mn = 1e9, mx = 0, n = dots.length;
      for (var i = 0; i < n; i++) {
        var best = 1e9;
        for (var j = 0; j < n; j++) {
          if (j === i) continue;
          var dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
          var d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        var d = Math.sqrt(best);
        s += d; s2 += d * d;
        if (d < mn) mn = d;
        if (d > mx) mx = d;
      }
      var avg = n ? s / n : 0;
      return {
        avg: +avg.toFixed(1),
        sd: +Math.sqrt(Math.max(0, (n ? s2 / n : 0) - avg * avg)).toFixed(1),
        min: +mn.toFixed(1),
        max: +mx.toFixed(1)
      };
    },
    // 力场内粒子的质心 [cx, cy, n]，用于验证跟手程度
    centroid: function (x, y) {
      var sx = 0, sy = 0, n = 0;
      for (var i = 0; i < dots.length; i++) {
        var dx = dots[i].x - x, dy = dots[i].y - y;
        if (dx * dx + dy * dy < DR2) { sx += dots[i].x; sy += dots[i].y; n++; }
      }
      return n ? [Math.round(sx / n), Math.round(sy / n), n] : [0, 0, 0];
    },
    // 统计指针周围粒子分布：[内核<70px, 力场70~190px, 场外]
    ring: function (x, y) {
      var a = 0, b = 0, c = 0;
      for (var i = 0; i < dots.length; i++) {
        var dx = dots[i].x - x, dy = dots[i].y - y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < CNF.DRAG_CORE) a++; else if (d < CNF.DRAG_R) b++; else c++;
      }
      return [a, b, c];
    }
  };
})();
