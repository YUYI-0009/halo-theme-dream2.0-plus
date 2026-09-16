/*
 * 游戏记录页面脚本
 *
 * 数据来源：同目录下的 site.json（由 sync_extra.py 生成）
 *
 * 关于 pjax
 *   主题启用了 pjax，只替换 .column-main，并且配置里是 scripts:false ——
 *   也就是说通过站内链接跳转到本页时，页面里的内联 <script> 不会被执行。
 *   所以本文件必须以 <script src data-pjax> 的方式引入：主题的 pjax
 *   实现会识别 data-pjax 属性并在导航后加载它。
 *
 *   初始化同时挂两条路径，并用 dataset 标志位防止重复渲染：
 *     1) pjax:success —— 站内跳转进来
 *     2) DOMContentLoaded / 立即执行 —— 直接打开或刷新本页
 *   每次执行都先找 #game-tracker，找不到说明当前不是本页，直接返回。
 */
(function () {
  'use strict';

  var payload = null;   // 已取到的 site.json，站内来回跳转时不重复请求
  var pending = null;   // 进行中的请求

  // 游戏库默认折叠，先显示这么多款。242 张卡片一次性铺开会拉得很长，
  // 而且图片是懒加载的，不展开就不下载，首屏也更快。
  var COLLAPSE_LIMIT = 24;
  var expanded = false;

  /* ---------------------------------------------------------- 小工具 */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(n, d) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    try {
      return Number(n).toLocaleString('zh-CN', {
        minimumFractionDigits: d || 0,
        maximumFractionDigits: d || 0
      });
    } catch (e) {
      return String(n);
    }
  }

  function day(iso) {
    if (!iso) return '';
    return String(iso).slice(0, 10);
  }

  /*
   * 图片地址基准目录，从容器的 data-json 属性推出来。
   * site.json 里的封面有几种可能，这里统一处理：
   *   1. Halo 附件的根相对路径（/upload/game/xxx.jpg）—— 最常见
   *   2. 还没本地化的原始 Steam 地址（https://...）—— fetch_images.py 没下下来的
   *   3. 主题目录下的相对路径（covers/xxx.jpg）—— 早期版本，兼容用
   * 前两种本身就能直接用，只有第三种需要补 base。
   */
  var base = '';

  function img(u) {
    if (!u) return '';
    // charAt(0)==='/' 同时也覆盖了 //cdn.example.com 这种协议相对地址
    if (u.charAt(0) === '/' || u.indexOf('http') === 0) return u;
    return base + u;
  }

  /* ---------------------------------------------------------- 渲染片段 */

  function heroHtml(d) {
    var s = d.summary || {};
    var p = d.profile || {};
    var updated = day(d.extra_generated_at || d.generated_at);

    // 注意所有 <img> 都带 class：主题有 .main-content img:not([class]) 的
    // 悬浮放大规则，加上类名就匹配不上了，避免封面图乱动
    var avatar = p.avatar
      ? '<img class="gt-img" src="' + esc(img(p.avatar)) + '" alt="' + esc(p.personaname) +
        '" onerror="this.style.display=\'none\'">'
      : '';

    return '' +
      '<section class="gt-hero">' +
        '<div>' +
          '<div class="gt-hero-label">总游玩时长</div>' +
          '<div class="gt-hero-hours">' + num(s.total_hours, 1) + '<em>小时</em></div>' +
          '<div class="gt-hero-sub">' +
            '<span>共 <b>' + num(s.total_games) + '</b> 款游戏</span>' +
            '<span class="gt-sep">·</span>' +
            '<span>玩过 <b>' + num(s.played_games) + '</b> 款</span>' +
            '<span class="gt-sep">·</span>' +
            '<span>未开封 <b>' + num(s.never_played) + '</b> 款</span>' +
            (s.top_game
              ? '<span class="gt-sep">·</span><span>最长 <b>' + esc(s.top_game) + '</b> ' +
                num(s.top_game_hours, 1) + ' 小时</span>'
              : '') +
          '</div>' +
        '</div>' +
        (p.personaname
          ? '<div class="gt-hero-user">' + avatar +
              '<div><div class="gt-uname">' + esc(p.personaname) + '</div>' +
              (updated ? '<div class="gt-utime">数据更新于 ' + esc(updated) + '</div>' : '') +
              '</div></div>'
          : '') +
      '</section>';
  }

  function statHtml(icon, label, value, unit) {
    return '' +
      '<div class="gt-stat">' +
        '<div class="gt-stat-k"><i class="' + icon + '"></i>' + esc(label) + '</div>' +
        '<div class="gt-stat-v">' + value +
          (unit ? '<small>' + esc(unit) + '</small>' : '') +
        '</div>' +
      '</div>';
  }

  function statsHtml(d) {
    var s = d.summary || {};
    var out = '';

    if (s.achievements_total) {
      out += statHtml('ri-trophy-fill', '成就解锁',
        num(s.achievements_earned) + '<small>/ ' + num(s.achievements_total) + '</small>');
    }
    if (s.reviews_total) {
      out += statHtml('ri-star-fill', '写过的评测', num(s.reviews_total), '条');
    }
    out += statHtml('ri-gamepad-fill', '游戏总数', num(s.total_games), '款');
    out += statHtml('ri-time-fill', '单款最长', num(s.top_game_hours, 1), '小时');

    return out ? '<section class="gt-stats">' + out + '</section>' : '';
  }

  function achHtml(d) {
    var s = d.summary || {};
    if (!s.achievements_total) return '';

    var rate = s.achievements_rate || 0;
    return '' +
      '<section class="gt-ach-card">' +
        '<div class="gt-ach-top">' +
          '<div><div class="gt-stat-k"><i class="ri-trophy-line"></i>成就进度</div>' +
            '<div class="gt-ach-num">' + num(s.achievements_earned) +
              '<span> / ' + num(s.achievements_total) + ' （' + num(rate, 1) + '%）</span></div>' +
          '</div>' +
          '<div class="gt-ach-foot">' +
            '<span>覆盖 <b>' + num(s.achievements_games) + '</b> 款有成就的游戏</span>' +
            '<span>全成就 <b>' + num(s.achievements_perfect) + '</b> 款</span>' +
          '</div>' +
        '</div>' +
        '<div class="gt-meter"><i style="width:' + rate + '%"></i></div>' +
      '</section>';
  }

  function recentHtml(d) {
    var list = d.recently_played || [];
    if (!list.length) return '';

    var cards = list.map(function (g) {
      return '' +
        '<a class="gt-recent-item" href="' + esc(g.store) + '" target="_blank" rel="noopener">' +
          '<img class="gt-img" loading="lazy" src="' + esc(img(g.header)) + '" alt="' + esc(g.name) + '" ' +
            'onerror="this.style.opacity=0">' +
          '<div class="gt-recent-meta">' +
            '<div class="gt-recent-name">' + esc(g.name) + '</div>' +
            '<div class="gt-recent-time">两周 ' + num(g.hours_2weeks, 1) + ' 小时</div>' +
          '</div>' +
        '</a>';
    }).join('');

    return '' +
      // 计数走 data-count + CSS ::after，不放进标题文本 ——
      // 主题的目录侧边栏是用 textContent 取标题的，放文本里会被带进目录
      '<h2 class="gt-h2" data-count="' + esc(list.length + ' 款') + '">' +
        '<i class="ri-fire-fill"></i>最近在玩</h2>' +
      '<div class="gt-recent">' + cards + '</div>';
  }

  function cardHtml(g) {
    var played = (g.minutes || 0) > 0;
    var ach = g.achievements;
    var sub = played ? '最后游玩 ' + day(g.last_played_iso) : '从未启动';

    var achBit = '';
    if (ach && ach.total) {
      var pct = Math.round(ach.earned / ach.total * 100);
      var done = ach.earned === ach.total;
      achBit = '<span class="gt-mini' + (done ? ' gt-ach-done' : '') + '" title="成就 ' +
        ach.earned + '/' + ach.total + '">' +
        '<span class="gt-mini-bar"><i style="width:' + pct + '%"></i></span>' +
        ach.earned + '/' + ach.total + '</span>';
    }

    return '' +
      '<article class="gt-card' + (played ? '' : ' is-unplayed') + '"' +
        ' data-name="' + esc(g.name.toLowerCase()) + '"' +
        ' data-played="' + (played ? '1' : '0') + '">' +
        '<a class="gt-cover" href="' + esc(g.store) + '" target="_blank" rel="noopener"' +
          ' title="' + esc(g.name) + '">' +
          '<img class="gt-img" loading="lazy" src="' + esc(img(g.header)) + '" alt="' + esc(g.name) + '"' +
            ' onerror="this.style.opacity=0">' +
          '<span class="gt-hours">' + (played ? num(g.hours, 1) + 'h' : '未玩') + '</span>' +
        '</a>' +
        '<div class="gt-meta">' +
          '<div class="gt-name" title="' + esc(g.name) + '">' + esc(g.name) + '</div>' +
          '<div class="gt-sub"><span>' + esc(sub) + '</span>' + achBit + '</div>' +
        '</div>' +
      '</article>';
  }

  function libHtml(d) {
    var games = d.games || [];
    return '' +
      '<h2 class="gt-h2" id="gt-lib-h2" data-count="' + esc(games.length + ' 款') + '">' +
        '<i class="ri-gamepad-fill"></i>游戏库</h2>' +
      '<div class="gt-tools" style="margin-bottom:12px">' +
        '<div class="gt-tabs" id="gt-tabs">' +
          '<button class="gt-tab is-active" data-filter="all">全部</button>' +
          '<button class="gt-tab" data-filter="played">玩过</button>' +
          '<button class="gt-tab" data-filter="unplayed">未玩过</button>' +
        '</div>' +
        '<label class="gt-search"><i class="ri-search-line"></i>' +
          '<input type="search" id="gt-q" placeholder="搜索游戏名…">' +
        '</label>' +
      '</div>' +
      '<div class="gt-grid" id="gt-grid">' + games.map(cardHtml).join('') + '</div>' +
      '<div class="gt-expand-wrap" id="gt-expand-wrap" hidden>' +
        '<button class="gt-expand" id="gt-expand">' +
          '<i class="ri-arrow-down-s-line"></i><span></span>' +
        '</button>' +
      '</div>' +
      '<div class="gt-empty" id="gt-empty" hidden>没有匹配的游戏</div>';
  }

  function reviewHtml(r) {
    var vote = r.voted_up === true
      ? '<span class="gt-vote up"><i class="ri-thumb-up-fill"></i>推荐</span>'
      : (r.voted_up === false
        ? '<span class="gt-vote down"><i class="ri-thumb-down-fill"></i>不推荐</span>'
        : '');

    var long = (r.text || '').length > 120;

    return '' +
      '<article class="gt-review">' +
        '<div class="gt-review-head">' +
          (r.header
            ? '<img class="gt-img" loading="lazy" src="' + esc(img(r.header)) + '" alt="' + esc(r.name) + '"' +
              ' onerror="this.style.display=\'none\'">'
            : '') +
          '<div class="gt-review-title">' +
            '<a class="gt-review-name" href="' + esc(r.store) + '" target="_blank"' +
              ' rel="noopener">' + esc(r.name) + '</a>' +
            '<div class="gt-review-meta">' + vote +
              (r.hours ? '<span>' + num(r.hours, 1) + ' 小时</span>' : '') +
              (r.posted ? '<span>' + esc(r.posted) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        (r.text
          ? '<div class="gt-review-text">' + esc(r.text) + '</div>' +
            (long ? '<button class="gt-more">展开全文</button>' : '')
          : '') +
      '</article>';
  }

  function reviewsHtml(d) {
    var list = d.reviews || [];
    if (!list.length) return '';

    var s = d.summary || {};
    var extra = [];
    if (s.reviews_up) extra.push('好评 ' + s.reviews_up);
    if (s.reviews_down) extra.push('差评 ' + s.reviews_down);

    return '' +
      '<h2 class="gt-h2" data-count="' +
        esc(list.length + ' 条' + (extra.length ? '（' + extra.join(' · ') + '）' : '')) +
        '"><i class="ri-star-fill"></i>我的游戏评测</h2>' +
      '<div class="gt-reviews">' + list.map(reviewHtml).join('') + '</div>';
  }

  /* ---------------------------------------------------------- 交互 */

  function applyFilter(root) {
    var active = root.querySelector('.gt-tab.is-active');
    var mode = active ? active.getAttribute('data-filter') : 'all';
    var qEl = root.querySelector('#gt-q');
    var q = qEl ? qEl.value.trim().toLowerCase() : '';
    var cards = root.querySelectorAll('.gt-card');

    // 搜索时不受折叠限制 —— 否则搜一个排在第 200 位的游戏会搜不到
    var uncapped = expanded || q !== '';
    var matched = 0;   // 命中筛选条件的总数
    var shown = 0;     // 其中实际显示出来的

    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var okMode = mode === 'all' ||
        (mode === 'played' && c.getAttribute('data-played') === '1') ||
        (mode === 'unplayed' && c.getAttribute('data-played') === '0');
      var okText = !q || c.getAttribute('data-name').indexOf(q) !== -1;
      var show = false;
      if (okMode && okText) {
        matched++;
        show = uncapped || matched <= COLLAPSE_LIMIT;
        if (show) shown++;
      }
      c.classList.toggle('is-hidden', !show);
    }

    var h2El = root.querySelector('#gt-lib-h2');
    if (h2El) {
      // 折叠时显示「已显示 / 总数」，让读者知道后面还有。
      // 写进 data-count 而不是文本，否则会被主题的目录侧边栏当成标题文字
      h2El.setAttribute('data-count',
        (shown < matched ? shown + ' / ' + matched : matched) + ' 款');
    }

    var wrapEl = root.querySelector('#gt-expand-wrap');
    var btnEl = root.querySelector('#gt-expand');
    if (wrapEl && btnEl) {
      wrapEl.hidden = q !== '' || (!expanded && matched <= COLLAPSE_LIMIT);
      var label = btnEl.querySelector('span');
      if (label) label.textContent = expanded ? '收起' : '展开全部 ' + matched + ' 款';
      var ico = btnEl.querySelector('i');
      if (ico) {
        ico.className = expanded ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line';
      }
    }

    var emptyEl = root.querySelector('#gt-empty');
    if (emptyEl) emptyEl.hidden = matched !== 0;
    var gridEl = root.querySelector('#gt-grid');
    if (gridEl) gridEl.style.display = matched === 0 ? 'none' : '';
  }

  function bind(root) {
    root.addEventListener('click', function (ev) {
      var tab = ev.target.closest ? ev.target.closest('.gt-tab') : null;
      if (tab) {
        var tabs = root.querySelectorAll('.gt-tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('is-active');
        tab.classList.add('is-active');
        applyFilter(root);
        return;
      }

      var exp = ev.target.closest ? ev.target.closest('#gt-expand') : null;
      if (exp) {
        expanded = !expanded;
        applyFilter(root);
        // 收起时列表会骤然变短，把视线拉回「游戏库」标题，免得看丢
        if (!expanded) {
          var anchor = root.querySelector('#gt-lib-h2');
          if (anchor && anchor.scrollIntoView) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        return;
      }

      var more = ev.target.closest ? ev.target.closest('.gt-more') : null;
      if (more) {
        var text = more.parentNode.querySelector('.gt-review-text');
        if (text) {
          var open = text.classList.toggle('is-open');
          more.textContent = open ? '收起' : '展开全文';
        }
      }
    });

    root.addEventListener('input', function (ev) {
      if (ev.target && ev.target.id === 'gt-q') applyFilter(root);
    });
  }

  /* ---------------------------------------------------------- 加载与初始化 */

  /*
   * 让主题的「目录」侧边栏认到本页内容。
   *
   * 主题的 TOC 是前端生成的（assets/js/btoc.min.js）：扫描
   * .main-content:not(.not-toc) 里的 h1~h6 填进 .toc-content；一个标题都
   * 扫不到时，common.min.js 的 initTocAndNotice 会给 .widget.toc 加
   * is-hidden-all 把它藏起来。
   *
   * 本页标题是本脚本渲染的，比主题初始化晚，所以渲染完必须手动再触发一次。
   * 主题脚本尚未就位时返回 false，交给调用方稍后重试。
   */
  function syncToc() {
    if (typeof window.tocPjax !== 'function') return false;

    window.tocPjax();

    // tocPjax 只负责填列表，「要不要藏」是 initTocAndNotice 决定的，
    // 这里补上同样那一步
    var hasToc = document.querySelector('.widget.toc .card-content ul');
    var widgets = document.querySelectorAll('.widget.toc, .action-toc');
    for (var i = 0; i < widgets.length; i++) {
      widgets[i].classList.toggle('is-hidden-all', !hasToc);
    }
    return true;
  }

  function render(root, data) {
    root.innerHTML =
      heroHtml(data) +
      statsHtml(data) +
      achHtml(data) +
      recentHtml(data) +
      libHtml(data) +
      reviewsHtml(data);
    bind(root);
    applyFilter(root);   // 套用默认折叠

    if (!syncToc()) {
      // pjax 场景下主题脚本与本脚本的加载顺序不固定，稍后补一次
      setTimeout(syncToc, 500);
    }
  }

  function fail(root, msg) {
    root.innerHTML =
      '<div class="gt-state is-error">' +
        '<div>读取游戏数据失败</div>' +
        '<div style="font-size:12px;margin-top:4px">' + esc(msg) + '</div>' +
      '</div>';
  }

  function init() {
    var root = document.getElementById('game-tracker');
    // 当前不是本页，或已经渲染过 —— 直接跳过
    if (!root || root.getAttribute('data-rendered') === '1') return;
    root.setAttribute('data-rendered', '1');

    if (payload) {
      render(root, payload);
      return;
    }

    var url = root.getAttribute('data-json');
    if (!url) {
      fail(root, '页面缺少 data-json 属性');
      return;
    }
    base = url.replace(/[^/]*$/, '');   // 去掉文件名，留下目录

    if (!pending) {
      pending = fetch(url, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + '（' + url + '）');
          return res.json();
        })
        .then(function (data) { payload = data; return data; })
        .catch(function (err) { pending = null; throw err; });
    }

    pending.then(function (data) {
      render(root, data);
    }).catch(function (err) {
      fail(root, (err && err.message ? err.message : String(err)) +
        ' —— 请确认 site.json 已由 sync_extra.py 生成');
    });
  }

  // 站内 pjax 跳转进来
  document.addEventListener('pjax:success', init);

  // 直接打开 / 刷新本页
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
