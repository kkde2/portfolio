/* ============================================================
   鼠标拖拽翻页 — 按住往下拖，翻到下一屏
   · 手势分工：竖向拖动 = 翻页，横向 / 小幅拖动 = 撸粒子
   · 拖动过程 1:1 跟手；到顶 / 到底有橡皮筋阻尼
   · 松手时：拖动超过屏高 14% 或快速甩动 → 平滑翻到相邻整屏
             否则停在当前位置，不做硬吸附
   · 翻页途中滚轮 / 键盘介入会立刻接管，动画自动取消
   · 触屏（pointer: coarse）不介入，交给原生滚动
   调参入口：下面的 CNF
   ============================================================ */
(function () {
  'use strict';

  if (window.matchMedia('(pointer: coarse)').matches) return;

  var CNF = {
    AXIS_LOCK: 9,      // 判定主方向的最小位移（px）
    RATIO: 1.15,       // 垂直分量 > 水平分量 × 此值才算翻页手势
    FOLLOW: 1,         // 跟手系数：拖动 1px，页面滚 1px
    RESIST: 0.22,      // 到顶 / 到底的橡皮筋系数
    SNAP: 0.14,        // 翻页触发：拖动距离 / 屏高
    FLICK: 0.45,       // 翻页触发：甩动速度（px/ms）
    DUR_MIN: 380,      // 翻页动画最短时长（ms）
    DUR_K: 0.42,       // 每 px 追加的时长（ms）
    DUR_MAX: 900,
    FOLLOW_K: 0.28     // 翻页时对粒子跟随的压制系数
  };

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  /* ---------------- 运行时状态 ---------------- */
  var mode = '';                 // '' | 'wait' | 'page' | 'skip'
  var sx = 0, sy = 0, base = 0;  // 按下点、按下时的滚动位置
  var lastY = 0, lastT = 0, vel = 0;
  var pages = [], maxY = 0;
  var anim = 0, fromY = 0, toY = 0, t0 = 0, dur = 0;

  function curY() {
    return window.pageYOffset || root.scrollTop || 0;
  }

  function docMax() {
    return Math.max(0, Math.max(root.scrollHeight, document.body.scrollHeight) - window.innerHeight);
  }

  /* 翻页落点：各章节顶部 + 文档底部（只取带 id 的章节，避开首屏本身） */
  function measure() {
    var list = [0];
    var secs = document.querySelectorAll('main > section[id]');
    var y = curY();
    for (var i = 0; i < secs.length; i++) {
      var t = Math.round(secs[i].getBoundingClientRect().top + y);
      if (t > 8) list.push(t);
    }
    maxY = docMax();
    list.push(maxY);
    list.sort(function (a, b) { return a - b; });

    var out = [];
    for (i = 0; i < list.length; i++) {
      if (!out.length || list[i] - out[out.length - 1] > 80) out.push(list[i]);
    }
    return out;
  }

  function ahead(y) {
    for (var i = 0; i < pages.length; i++) if (pages[i] > y + 8) return pages[i];
    return -1;
  }

  function behind(y) {
    var t = -1;
    for (var i = 0; i < pages.length; i++) if (pages[i] < y - 8) t = pages[i];
    return t;
  }

  /* 拖动期间必须关掉 CSS 平滑滚动，否则跟手会变成慢半拍 */
  function lockSmooth(on) {
    root.classList.toggle('is-paging', on);
  }

  /* ---------------- 翻页动画 ---------------- */
  function glide(target) {
    var y = curY();
    var dist = Math.abs(target - y);
    if (dist < 2) { lockSmooth(false); return; }

    if (reduce) {
      window.scrollTo(0, target);
      lockSmooth(false);
      return;
    }

    fromY = y;
    toY = target;
    dur = Math.min(CNF.DUR_MAX, Math.max(CNF.DUR_MIN, CNF.DUR_MIN + dist * CNF.DUR_K));
    t0 = performance.now();
    lockSmooth(true);
    if (!anim) anim = requestAnimationFrame(tick);
  }

  function tick(ts) {
    anim = 0;
    var p = (ts - t0) / dur;
    if (p > 1) p = 1;
    var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    window.scrollTo(0, Math.round(fromY + (toY - fromY) * e));
    if (p < 1) {
      anim = requestAnimationFrame(tick);
    } else {
      lockSmooth(false);
    }
  }

  function cancel() {
    if (anim) { cancelAnimationFrame(anim); anim = 0; }
    lockSmooth(false);
  }

  /* ---------------- 指针手势 ---------------- */
  function interactive(el) {
    return !!(el && el.closest && el.closest('a, button, input, textarea, select, .lightbox'));
  }

  function onDown(e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (document.body.classList.contains('is-locked')) return;
    if (interactive(e.target)) return;

    cancel();
    mode = 'wait';
    sx = e.clientX;
    sy = e.clientY;
    lastY = e.clientY;
    lastT = performance.now();
    vel = 0;
  }

  function onMove(e) {
    if (!mode) return;

    var dx = e.clientX - sx, dy = e.clientY - sy;

    if (mode === 'wait') {
      if (Math.abs(dx) < CNF.AXIS_LOCK && Math.abs(dy) < CNF.AXIS_LOCK) return;
      mode = Math.abs(dy) > Math.abs(dx) * CNF.RATIO ? 'page' : 'skip';
      if (mode === 'page') {
        pages = measure();
        base = curY();
        lockSmooth(true);
        document.body.classList.add('is-turning');
        if (window.__particles) window.__particles.setFollow(CNF.FOLLOW_K);
      }
    }

    if (mode !== 'page') return;

    // 速度用指数平滑，避免最后一帧的抖动决定方向
    var now = performance.now();
    var dt = now - lastT;
    if (dt > 0) {
      vel += ((e.clientY - lastY) / dt - vel) * 0.4;
      lastT = now;
      lastY = e.clientY;
    }

    var target = base + dy * CNF.FOLLOW;
    if (target < 0) target *= CNF.RESIST;
    else if (target > maxY) target = maxY + (target - maxY) * CNF.RESIST;
    window.scrollTo(0, Math.round(target));
  }

  function onUp(e) {
    if (!mode) return;
    var was = mode;
    mode = '';
    if (was !== 'page') return;

    document.body.classList.remove('is-turning');
    if (window.__particles) window.__particles.setFollow(1);

    var dy = e.clientY - sy;
    var dir = Math.abs(dy) > 2 ? (dy > 0 ? 1 : -1) : (vel > 0 ? 1 : -1);
    var strong = Math.abs(dy) > window.innerHeight * CNF.SNAP || Math.abs(vel) > CNF.FLICK;
    vel = 0;

    if (!strong) { lockSmooth(false); return; }

    var target = dir > 0 ? ahead(curY()) : behind(curY());
    if (target < 0) { lockSmooth(false); return; }
    glide(target);
  }

  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', function () { if (mode === 'page') { lockSmooth(false); if (window.__particles) window.__particles.setFollow(1); } mode = ''; }, { passive: true });
  window.addEventListener('blur', function () { mode = ''; cancel(); }, { passive: true });

  // 用户中途改用滚轮 / 键盘，立刻交还控制权
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown' ||
        k === 'Home' || k === 'End' || k === ' ' || k === 'Spacebar') cancel();
  });

  // 对外：调试 / 被其它脚本调用
  window.__pageturn = {
    config: CNF,
    pages: function () { return measure(); },
    state: function () { return { mode: mode, animating: !!anim, y: curY() }; },
    // dir = 1 下一屏，-1 上一屏
    turn: function (dir) {
      pages = measure();
      var t = dir > 0 ? ahead(curY()) : behind(curY());
      if (t < 0) return false;
      glide(t);
      return true;
    }
  };
})();
