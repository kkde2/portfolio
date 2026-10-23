/* ============================================================
   Portfolio — 交互脚本（零依赖）
   1. 中英切换   2. 滚动入场   3. 顶栏状态
   4. 导航高亮   5. 播放灯箱   6. 数字滚动
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. 中英切换 ---------- */
  var LANE_KEY = 'pf-lang';
  var langToggle = document.getElementById('langToggle');

  var i18nEls = Array.prototype.slice.call(document.querySelectorAll('[data-cn]'));

  function applyLang(lang) {
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');

    // 短标签（chip / badge / tag 等）由属性驱动切换
    i18nEls.forEach(function (el) {
      var txt = el.getAttribute(lang === 'en' ? 'data-en' : 'data-cn');
      if (txt) el.textContent = txt;
    });

    try { localStorage.setItem(LANE_KEY, lang); } catch (e) { /* 隐私模式忽略 */ }

    // 文案长度变了，右栏高度随之变化，技能卡要重新对齐
    alignSkillsCard();
  }

  try {
    var saved = localStorage.getItem(LANE_KEY);
    if (saved === 'en' || saved === 'cn') applyLang(saved);
  } catch (e) { /* ignore */ }

  if (langToggle) {
    langToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-lang') === 'cn' ? 'en' : 'cn';
      applyLang(next);
    });
  }

  /* ---------- 2. 滚动入场 ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var siblings = Array.prototype.slice.call(
          el.parentElement ? el.parentElement.children : []
        ).filter(function (c) { return c.classList.contains('reveal'); });
        var idx = Math.max(0, siblings.indexOf(el));
        el.style.transitionDelay = Math.min(idx * 90, 360) + 'ms';
        el.classList.add('is-in');
        revealIO.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    revealEls.forEach(function (el) { revealIO.observe(el); });
  }

  /* ---------- 3. 顶栏状态 ---------- */
  var topbar = document.querySelector('.topbar');
  if (topbar) {
    var onScrollTop = function () {
      topbar.classList.toggle('is-stuck', window.scrollY > 12);
    };
    window.addEventListener('scroll', onScrollTop, { passive: true });
    onScrollTop();
  }

  /* ---------- 4. 导航高亮 ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
  var sections = navLinks
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if (sections.length && 'IntersectionObserver' in window) {
    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = '#' + entry.target.id;
        navLinks.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

    sections.forEach(function (s) { navIO.observe(s); });
  }

  /* ---------- 5. 播放灯箱 ---------- */
  var lb = document.getElementById('lightbox');
  var lbVideo = document.getElementById('lbVideo');
  var lbCaption = document.getElementById('lbCaption');
  var lbClose = document.getElementById('lbClose');
  var lastFocus = null;

  function openLightbox(src, title) {
    if (!lb || !lbVideo) return;
    lastFocus = document.activeElement;
    lbVideo.src = src;
    lbCaption.textContent = title || '';
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    var play = lbVideo.play();
    if (play && typeof play.catch === 'function') play.catch(function () { /* 需用户再点 */ });
    if (lbClose) lbClose.focus();
  }

  function closeLightbox() {
    if (!lb || !lbVideo) return;
    lbVideo.pause();
    lbVideo.removeAttribute('src');
    lbVideo.load();
    lb.classList.remove('is-open');
    lb.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-locked');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.querySelectorAll('.work-card').forEach(function (card) {
    var media = card.querySelector('.work-media');
    var video = card.querySelector('video');
    var btn = card.querySelector('.play-btn');
    if (!media || !video) return;

    var trigger = function (ev) {
      ev.preventDefault();
      openLightbox(video.getAttribute('src'), video.getAttribute('data-title'));
    };

    if (btn) btn.addEventListener('click', trigger);
    media.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.play-btn')) return;
      trigger(ev);
    });
  });

  if (lbClose) lbClose.addEventListener('click', closeLightbox);

  if (lb) {
    lb.addEventListener('click', function (ev) {
      if (ev.target === lb) closeLightbox();
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && lb && lb.classList.contains('is-open')) closeLightbox();
  });

  /* ---------- 6. 数字滚动 ---------- */
  var counters = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));

  function runCount(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduceMotion) { el.textContent = String(target); return; }
    var start = null;
    var dur = 1100;

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);

    // 兜底：若动画因页面不可见等原因被节流，最终仍显示正确数值
    setTimeout(function () { el.textContent = String(target); }, dur + 260);
  }

  if (counters.length) {
    if (!('IntersectionObserver' in window)) {
      counters.forEach(runCount);
    } else {
      var countIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          runCount(entry.target);
          countIO.unobserve(entry.target);
        });
      }, { threshold: 0.6 });
      counters.forEach(function (el) { countIO.observe(el); });
    }
  }

  /* ---------- 7. 微信二维码：触屏点击开合 ---------- */
  var qrItem = document.querySelector('.contact-item--qr');
  if (qrItem) {
    var qrPop = qrItem.querySelector('.qr-pop');

    // 触屏走 pointerup，鼠标走 click，避免同一次轻点被切换两次
    var lastPointerType = 'mouse';

    qrItem.addEventListener('pointerdown', function (ev) {
      lastPointerType = ev.pointerType || 'mouse';
    });

    qrItem.addEventListener('pointerup', function (ev) {
      if (ev.pointerType !== 'touch') return;
      ev.stopPropagation();
      qrItem.classList.toggle('is-open');
    });

    qrItem.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (lastPointerType === 'touch') return;   // 已由 pointerup 处理
      qrItem.classList.toggle('is-open');
    });

    // 点别处收起
    document.addEventListener('click', function () {
      qrItem.classList.remove('is-open');
    });

    // 无需点进图片本身触发拖拽
    if (qrPop) {
      qrPop.addEventListener('dragstart', function (ev) { ev.preventDefault(); });
    }
  }

  /* ---------- 8. 软件技能卡：底边对齐到「项目经验」卡的一半 ---------- */
  function alignSkillsCard() {
    var skills = document.querySelector('.resume-card--skills');
    if (!skills) return;

    var cols = document.querySelectorAll('.resume-col');
    var right = null;
    for (var i = 0; i < cols.length; i++) {
      if (!cols[i].classList.contains('resume-col--lead')) { right = cols[i]; break; }
    }

    // 单栏布局下两卡是上下堆叠，不做对齐
    if (!right || window.matchMedia('(max-width: 1024px)').matches) {
      skills.style.height = '';
      return;
    }

    var proj = right.lastElementChild;          // 右栏末卡 = 项目经验
    if (!proj) { skills.style.height = ''; return; }

    // offsetTop 链不受 reveal 的 transform 影响
    var docTop = function (el) {
      var y = 0;
      for (var n = el; n; n = n.offsetParent) y += n.offsetTop;
      return y;
    };

    var target = docTop(proj) + proj.offsetHeight / 2 - docTop(skills);
    skills.style.height = Math.max(340, Math.round(target)) + 'px';
  }

  alignSkillsCard();
  window.addEventListener('load', alignSkillsCard);

  var rafId = null;
  window.addEventListener('resize', function () {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(alignSkillsCard);
  });

  /* ---------- 9. 年份 ---------- */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
