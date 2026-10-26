/* =========================================================================
   研学台 · 笔记画布
   ---------------------------------------------------------------------------
   一张图 = 一棵树。渲染分三层：
     .cvscene  被 transform 平移缩放的容器
       svg.cvedges   连线（圆角折线 elbow，不是曲线——大图上曲线会缠成一团）
       div.cvnode    节点（绝对定位，坐标由布局算出）
   布局用「右侧树」：根在中左，子节点向右一列列排开，同层纵向居中。
   这是 XMind / 幕布 默认的那种稳态布局，节点增删不会全图乱跳。
   ========================================================================= */
(function(){
  'use strict';

  /* app.js 整个包在 (async function(){...})() 里，window.SD 不是同步就绪的
     （它在第 4014 行才赋值），所以这里绝不能缓存。每次现取，拿不到就如实报错，
     不要静默吞掉——静默吞掉的后果是面板永远空白，还查不出原因。 */
  function SDX(){ return window.SD || {}; }
  function ct(name, args, opts){
    opts = opts || {};
    var sd = SDX();
    if(typeof sd.callTool !== 'function'){
      var fake = {ok: false, error: '主程序的桥还没就绪，稍等一下再点'};
      if(opts.onDone) opts.onDone(fake);
      return Promise.resolve(fake);
    }
    return sd.callTool(name, args, opts);
  }
  var $ = function(s, r){ return (r || document).querySelector(s); };
  var $$ = function(s, r){ return [].slice.call((r || document).querySelectorAll(s)); };
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
  function uid(){ return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------------- 状态 ---------------- */
  var M = {                     // 当前打开的画布
    id: '', title: '未命名画布', lesson: null, src: 'local', srcId: null,
    tree: null, dirty: false, savedAt: '',
    layout: 'tree',             // 'tree' 自动排 | 'free' 各节点自己记坐标
    theme: 'dark'               // 主题名，见 THEMES
  };
  var VIEW = { scale: 1, x: 40, y: 40 };
  var LASTA = {};               // 上一帧每个节点的位置，用来做位置过渡
  var LASTEP = {};              // 上一帧的边（"父>子"），用来认出「新长出来的边」
  var NEWEDGE = {};             // 边 → 到期时间戳。窗口内重绘都要继续描，
                                // 因为一次操作会连续触发两三次 drawEdges，只看上一帧会被后一次冲掉。
  var FIRSTEDGE = true;         // 第一次画边不播动画（整棵树一起描出来像加载条）
  var FIRSTNODE = true;         // 这张图的第一帧：不播入场（LASTA 是空的，会被误判成「全是新节点」）

  /* 一次性动效：加类 → 到点摘掉。
     不能把动画挂在 .sel / .on 这类常驻选择器上 —— 节点每次 render 都是重建的，
     挂常驻类会每帧重播，变成一直抖。 */
  function once(el, cls){
    if(!el) return;
    el.classList.remove(cls);
    /* 强制回流，让同一个类能被重播 */
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function(){ if(el && el.classList) el.classList.remove(cls); }, 420);
  }
  var SEL = null;               // 选中的节点 id
  var FOLD = {};                // 折叠状态：{nodeId: 1}
  var POS = {};                 // 布局结果：{nodeId: {x,y,w}}
  var DRAG = null;
  var CARDS = [];               // 右侧面板的画布卡片
  var MSEL = {};                // 多选：{nodeId: 1}。Shift+点 加减，普通点清空
  var CLIP = null;              // 剪贴板：{items:[深拷贝的节点]}
  var HIST = [], HISTI = -1;    // 撤销栈（存整棵树的 JSON 快照）
  var PRE = null;               // 改动前的快照，等 commitHist() 才真正入栈
  var HISTPEND = false;         // 一次连续输入只记一个撤销点
  var NDRAG = null;             // 节点拖拽（换父级），跟画布平移是两件事
  var FINDS = [], FIND0 = 0;    // 搜索结果与当前命中

  /* ---------------- 小工具 ---------------- */
  /* 顶栏那个「已保存」槽位只有一百来像素宽。以前所有提示都往那儿塞，
     一句「已存进「英语」截图库 · 现在有 2 张」能把整条顶栏撑成三行。
     现在长短提示分开走：短的一句仍写在槽位上，长的浮在画布上方，2.2 秒自己淡走。 */
  function toast(msg, bad){
    var el = $('#cvSave');
    var short = String(msg || '').length <= 12;
    if(el && short){
      el.textContent = msg;
      el.classList.toggle('dirty', !!bad);
      clearTimeout(el._t);
      el._t = setTimeout(function(){
        el.textContent = M.dirty ? '未保存' : '已保存';
        el.classList.toggle('dirty', M.dirty);
      }, 2200);
    }
    if(short) return;
    var box = $('#cvToast');
    if(!box) return;
    box.textContent = msg;
    box.classList.toggle('bad', !!bad);
    box.hidden = false;
    box.style.opacity = '0';
    box.style.transform = 'translate(-50%,-6px)';
    requestAnimationFrame(function(){
      box.style.transition = 'opacity .18s ease,transform .18s ease';
      box.style.opacity = '1';
      box.style.transform = 'translate(-50%,0)';
    });
    clearTimeout(box._t);
    box._t = setTimeout(function(){
      box.style.transition = 'opacity .22s ease,transform .22s ease';
      box.style.opacity = '0';
      box.style.transform = 'translate(-50%,-6px)';
      setTimeout(function(){ box.hidden = true; }, 240);
    }, 2300);
  }

  /* ---------------- 极简 Markdown ----------------
     不引第三方库：只做笔记里真会用的那几种。行内的 **粗** *斜* `code` [文字](链接)，
     行级 # 标题、- 列表、1. 有序、> 引用、``` 代码块、--- 分隔线。
     先转义 HTML 再做替换，所以不会把用户写的 <script> 放进去。 */
  function mdInline(s){
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function(_, t, u){
      if(!/^(https?:|data:image\/|\/)/i.test(u)) return t;
      return '<img class="cvim" src="' + u + '" alt="' + t + '">';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(_, t, u){
      if(!/^(https?:|#|\/)/i.test(u)) return t;
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>';
    });
    return s;
  }
  function mdToHtml(src){
    var lines = String(src || '').split('\n');
    var out = [], list = null, code = null, cbuf = [];
    function closeList(){ if(list){ out.push('</' + list + '>'); list = null; } }
    for(var i = 0; i < lines.length; i++){
      var l = lines[i];
      if(code !== null){
        if(/^\s*```/.test(l)){ out.push('<pre><code>' + esc(cbuf.join('\n')) + '</code></pre>'); code = null; cbuf = []; }
        else cbuf.push(l);
        continue;
      }
      if(/^\s*```/.test(l)){ closeList(); code = l.replace(/^\s*```\s*/, ''); cbuf = []; continue; }
      if(/^\s*$/.test(l)){ closeList(); continue; }
      if(/^\s*(---|\*\*\*)\s*$/.test(l)){ closeList(); out.push('<hr>'); continue; }
      var m = l.match(/^(#{1,4})\s+(.*)$/);
      if(m){ closeList(); out.push('<h' + m[1].length + '>' + mdInline(m[2]) + '</h' + m[1].length + '>'); continue; }
      m = l.match(/^\s*[-*+]\s+(.*)$/);
      if(m){
        if(list !== 'ul'){ closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + mdInline(m[1]) + '</li>'); continue;
      }
      m = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if(m){
        if(list !== 'ol'){ closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + mdInline(m[1]) + '</li>'); continue;
      }
      m = l.match(/^\s*>\s?(.*)$/);
      if(m){ closeList(); out.push('<blockquote>' + mdInline(m[1]) + '</blockquote>'); continue; }
      closeList();
      out.push('<p>' + mdInline(l) + '</p>');
    }
    if(code !== null) out.push('<pre><code>' + esc(cbuf.join('\n')) + '</code></pre>');
    closeList();
    return out.join('');
  }
  /* 节点标签：只吃行内语法（节点是一行字，不放块级） */
  function mdLabel(s){ return mdInline(String(s || '').replace(/\n+/g, ' ')).trim() || '(空)'; }

  /* ---------------- 树操作 ---------------- */
  function walk(node, fn, parent, depth){
    if(!node) return;
    fn(node, parent, depth || 0);
    var kids = node.children || [];
    for(var i = 0; i < kids.length; i++) walk(kids[i], fn, node, (depth || 0) + 1);
  }
  function findNode(id, node, parent){
    node = node || M.tree;
    if(!node) return null;
    if(node.id === id) return {node: node, parent: parent || null};
    var kids = node.children || [];
    for(var i = 0; i < kids.length; i++){
      var r = findNode(id, kids[i], node);
      if(r) return r;
    }
    return null;
  }
  function countNodes(node){
    if(!node) return 0;
    var n = 1, kids = node.children || [];
    for(var i = 0; i < kids.length; i++) n += countNodes(kids[i]);
    return n;
  }
  function newTree(title){
    return {id: 'root', text: title || '新画布', note: '', children: [], color: '',
            layout: 'tree', theme: 'dark'};
  }
  function normalize(node){
    /* 从外部导入的树可能缺 id / children，补齐再进渲染 */
    if(!node) return;
    if(!node.id) node.id = uid();
    if(!node.text) node.text = '';
    if(!node.children) node.children = [];
    for(var i = 0; i < node.children.length; i++) normalize(node.children[i]);
  }

  /* 批注层：联系线 / 外框 / 概要。老画布里没有这三样，读进来先补空数组，
     否则后面每次都要判 undefined。 */
  function ensureExtras(){
    if(!M.tree) return;
    if(!M.tree.relations) M.tree.relations = [];
    if(!M.tree.boundaries) M.tree.boundaries = [];
    if(!M.tree.summaries) M.tree.summaries = [];
  }

  /* 一个节点连同它整棵子树（折叠的不算）在画布上的包围盒 */
  function subtreeBox(nodeId){
    var hit = findNode(nodeId);
    if(!hit) return null;
    var bb = null;
    (function rec(n){
      var p = POS[n.id];
      if(p){
        if(!bb) bb = {x1: p.x, y1: p.y, x2: p.x + p.w, y2: p.y + p.h};
        else {
          bb.x1 = Math.min(bb.x1, p.x); bb.y1 = Math.min(bb.y1, p.y);
          bb.x2 = Math.max(bb.x2, p.x + p.w); bb.y2 = Math.max(bb.y2, p.y + p.h);
        }
      }
      if(FOLD[n.id]) return;
      (n.children || []).forEach(rec);
    })(hit.node);
    return bb;
  }

  function listExtras(){
    ensureExtras();
    return {relations: M.tree.relations, boundaries: M.tree.boundaries,
            summaries: M.tree.summaries};
  }

  /* ---------------- 布局（右侧树） ----------------
     每一列 = 一个深度。列宽按该列最宽的节点算，列间距固定。
     同一父节点下的子树纵向排开，父节点在自己子树的纵向中点。
     竖排完了再整体居中到 0 附近，让根节点落在画布偏左的位置。 */
  var NODE_H = 38, NODE_H_ROOT = 46, GAP_Y = 14, GAP_X = 62;

  function layout(){
    if(!M.tree){ POS = {}; return {w: 0, h: 0}; }
    if(M.layout !== 'free') return layoutTree();
    return layoutFree();
  }

  /* 自由布局：节点上存了 x/y 就用存的，没存就沿用树形算出来的位置。
     这样「切到自由」不会把整棵树打散，只有你真正拖过的节点才移位。 */
  function layoutFree(){
    var size = layoutTree();      /* 先算一份树形坐标当缺省 */
    POS = POS;                    /* 树形结果已在 POS 里 */
    var byId = {};
    walk(M.tree, function(n){ byId[n.id] = n; });
    var maxR = 0, maxB = 0;
    for(var k in POS){
      var p = POS[k], n = byId[k];
      if(n){
        if(typeof n.x === 'number' && isFinite(n.x)) p.x = n.x;
        if(typeof n.y === 'number' && isFinite(n.y)) p.y = n.y;
      }
      if(p.x + p.w > maxR) maxR = p.x + p.w;
      if(p.y + p.h > maxB) maxB = p.y + p.h;
    }
    return {w: maxR + 60, h: maxB + 60, size: size};
  }

  function layoutTree(){
    POS = {};
    if(!M.tree) return {w: 0, h: 0};
    var colW = {};            // 每列最大宽度
    walk(M.tree, function(n, p, d){
      n._d = d;
      var w = measure(n);
      n._w = w;
      colW[d] = Math.max(colW[d] || 0, w);
    });
    var colX = [0];
    for(var d = 1; d <= 24; d++){
      if(colW[d] == null) break;
      colX[d] = colX[d - 1] + (colW[d - 1] || 120) + GAP_X;
    }
    var cursor = 0;
    function place(n, d){
      var kids = (FOLD[n.id] ? [] : (n.children || []));
      var h = (d === 0) ? NODE_H_ROOT : NODE_H;
      if(!kids.length){
        var y = cursor;
        cursor += h + GAP_Y;
        POS[n.id] = {x: colX[d] || 0, y: y, w: n._w, h: h, d: d};
        return y + h / 2;
      }
      var first = null, last = null;
      for(var i = 0; i < kids.length; i++){
        var mid = place(kids[i], d + 1);
        if(first === null) first = mid;
        last = mid;
      }
      var cy = (first + last) / 2 - h / 2;
      /* 父节点的纵向位置不能落到已经排过的区域里（叶子和子树混排时） */
      if(cy < cursor - (h + GAP_Y) && !POS[n.id]) cy = Math.max(cy, cursor - h - GAP_Y + 2);
      POS[n.id] = {x: colX[d] || 0, y: cy, w: n._w, h: h, d: d};
      cursor = Math.max(cursor, cy + h + GAP_Y);
      return cy + h / 2;
    }
    place(M.tree, 0);
    var maxR = 0, minY = 1e9, maxY = -1e9;
    for(var k in POS){
      var p = POS[k];
      maxR = Math.max(maxR, p.x + p.w);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y + p.h);
    }
    var dy = 30 - minY;
    for(var k2 in POS) POS[k2].y += dy;
    return {w: maxR + 60, h: (maxY - minY) + 60};
  }

  function measure(n){
    /* 按节点的真实字号估宽：根 15.5px、一级 13.5px、深层 13px。
       中文字宽≈字号，英文≈字号*0.53。估小了会被 .tx 的 ellipsis 截成「…」，
       所以宁可多给 6%。 */
    var isRoot = (n.id === (M.tree && M.tree.id));
    var d = n._d || 0;
    var fs = isRoot ? 15.5 : (d <= 1 ? 13.5 : 13);
    /* Markdown 标记本身不显示，按去掉标记后的长度算 */
    var hasImg = /!\[[^\]]*\]\([^)]*\)/.test(String(n.text || ''));
    var t = String(n.text || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\*\*|\*|`|\[|\]\([^)]*\)/g, '');
    var w = 0;
    for(var i = 0; i < t.length; i++){
      var c = t.charCodeAt(i);
      w += (c > 255) ? fs : fs * 0.53;
    }
    var pad = (isRoot ? 46 : 34) + (hasImg ? 30 : 0);   /* 有图就多留一个缩略图的位置 */
    /* 图标每个占 15+5，标签按「中文字 11px + 左右 12px」估，都要算进宽度 */
    pad += (n.mk || []).length * 20;
    (n.lb || []).forEach(function(t){
      var lw = 0;
      for(var j = 0; j < String(t).length; j++){
        lw += (String(t).charCodeAt(j) > 255) ? 11 : 6;
      }
      pad += lw + 18;
    });
    if(priOf(n)) pad += 4;                             /* 左侧那道竖条 */
    var min = isRoot ? 120 : 66;
    var max = isRoot ? 460 : 400;
    return Math.max(min, Math.min(max, Math.ceil(w * 1.06) + pad));
  }

  /* ---------------- 渲染 ---------------- */
  function render(){
    if(!M.tree){ M.tree = newTree(M.title); }
    normalize(M.tree);
    var size = layout();
    var scene = $('#cvScene');
    if(!scene) return;
    /* 节点 */
    var html = [];
    var fresh = {};                 // 这一帧新长出来的节点：入场时淡进来
    walk(M.tree, function(n, p, d){
      var pos = POS[n.id];
      if(!pos) return;
      if(!FIRSTNODE && !LASTA[n.id]) fresh[n.id] = 1;
      var isRoot = (d === 0);
      var cls = 'cvnode' + (isRoot ? ' root' : ' d' + Math.min(d, 4)) + (n.id === SEL ? ' sel' : '');
      var sw = n.color ? '<span class="mark" style="background:' + esc(n.color) + '"></span>' : '';
      /* 优先级最高的数挂在最左边一道竖条上，扫一眼就知道哪几块最要紧 */
      var pi = priOf(n);
      if(pi) sw = '<span class="pibar" data-pri="' + pi + '"></span>' + sw;
      var mk = (n.mk || []).map(markHtml).join('');
      var lb = (n.lb || []).map(function(t){
        return '<span class="lbl">' + esc(t) + '</span>';
      }).join('');
      var noteIc = n.note ? '<span class="noteic" title="这个节点有备注"></span>' : '';
      var kids = n.children || [];
      var fold = kids.length ? ('<span class="fold" data-fold="' + esc(n.id) + '">'
                 + (FOLD[n.id] ? '+' + kids.length : '−') + '</span>') : '';
      if(fresh[n.id]) cls += ' anim-in';
      html.push('<div class="' + cls + '" data-id="' + esc(n.id) + '" style="left:' + pos.x
        + 'px;top:' + pos.y + 'px;width:' + Math.round(pos.w) + 'px">'
        + sw + mk + '<span class="tx">' + mdLabel(n.text) + '</span>' + lb + noteIc + fold + '</div>');
    });
    /* 节点重建。svg 必须排在节点「之后」——
       #cvEdges 是 pointer-events:none，压在上面既不挡点击，
       联系线标签也不会钻到节点底下去。 */
    var keep = scene.querySelector('#cvEdges');
    scene.innerHTML = '';
    scene.insertAdjacentHTML('beforeend', html.join(''));
    if(keep) scene.appendChild(keep);
    /* 位置过渡：加节点/换父级/切布局之后，节点是从旧位置滑过去的，
       不是突然出现在新位置。做法是先把元素按旧位置偏移回去，
       下一帧再放开 —— 走 CSS 的 transform 过渡，不动 left/top，
       免得拖拽自由布局时被自己的过渡拖慢。 */
    var toSmooth = [];
    for(var id0 in POS){
      var q0 = POS[id0], o0 = LASTA[id0];
      if(!o0) continue;
      var ddx = o0.x - q0.x, ddy = o0.y - q0.y;
      if(Math.abs(ddx) < 0.5 && Math.abs(ddy) < 0.5) continue;
      var el0 = scene.querySelector('.cvnode[data-id="' + id0 + '"]');
      if(el0) toSmooth.push([el0, ddx, ddy]);
    }
    if(toSmooth.length){
      toSmooth.forEach(function(t0){
        t0[0].style.transition = 'none';
        t0[0].style.transform = 'translate(' + t0[1] + 'px,' + t0[2] + 'px)';
      });
      requestAnimationFrame(function(){
        toSmooth.forEach(function(t0){
          t0[0].style.transition = '';
          t0[0].style.transform = '';
        });
      });
    }
    /* 入场类拼在 html 里，没有摘除时机就一直挂着 —— 播完要摘掉，
       否则下一次重绘会被当成「还在动」，动画会重播。 */
    if(scene.querySelector('.cvnode.anim-in')){
      setTimeout(function(){
        var live = scene.querySelectorAll('.cvnode.anim-in');
        for(var k = 0; k < live.length; k++) live[k].classList.remove('anim-in');
      }, 300);
    }
    LASTA = {};
    for(var id1 in POS){ LASTA[id1] = {x: POS[id1].x, y: POS[id1].y}; }
    FIRSTNODE = false;
    drawEdges();
    drawExtras();
    paintOutline();
    paintInspector();
    applyView();
    paintMsel();
    paintHits();
    $('#cvOutN').textContent = countNodes(M.tree) + ' 节点';
  }

  /* 折线拐角走圆弧。直角折线在密集的树上会显得很「硬」，
     圆角一加，同一棵树看着就顺了 —— 半径按两段长度的 1/4 收，
     线短的时候自动缩小，不会互相咬在一起。 */
  function elbowPath(x1, y1, x2, y2){
    var mx = x1 + Math.max(18, (x2 - x1) / 2);
    var r = Math.max(3, Math.min(14, Math.abs(mx - x1) / 2, Math.abs(y2 - y1) / 2, 14));
    if(Math.abs(y2 - y1) < 0.6) return 'M' + x1 + ',' + y1 + ' H' + x2;
    var sgn = (y2 > y1) ? 1 : -1;
    return 'M' + x1 + ',' + y1
      + ' H' + (mx - r)
      + ' Q' + mx + ',' + y1 + ' ' + mx + ',' + (y1 + r * sgn)
      + ' V' + (y2 - r * sgn)
      + ' Q' + mx + ',' + y2 + ' ' + (mx + r) + ',' + y2
      + ' H' + x2;
  }

  /* 贝塞尔：控制点距离随水平间距伸缩，间距大时收着给（不出大回环），
     间距小时放开（不至于缩成直线）。竖差越大，弯得越柔和。 */
  function curvePath(x1, y1, x2, y2){
    var dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    var k = Math.min(1, Math.max(.36, dx / Math.max(60, dx + dy * .55)));
    var c = Math.max(24, dx * k);
    return 'M' + x1 + ',' + y1 + ' C' + (x1 + c) + ',' + y1 + ' '
      + (x2 - c) + ',' + y2 + ' ' + x2 + ',' + y2;
  }

  function drawEdges(){
    var svg = $('#cvEdges');
    if(!svg || !M.tree) return;
    var parts = [];
    var nowEdge = {};
    walk(M.tree, function(n, p){
      if(!p || FOLD[p.id]) return;
      var a = POS[p.id], b = POS[n.id];
      if(!a || !b) return;
      var ek = p.id + '>' + n.id;
      nowEdge[ek] = 1;
      if(!FIRSTEDGE && !LASTEP[ek]) NEWEDGE[ek] = Date.now() + 400;
      var isNew = !FIRSTEDGE && (Date.now() < (NEWEDGE[ek] || 0));
      var x1 = a.x + a.w, y1 = a.y + a.h / 2;
      var x2 = b.x, y2 = b.y + b.h / 2;
      var d;
      if(M.edge === 'line'){
        d = 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2;
      } else if(M.edge === 'curve'){
        d = curvePath(x1, y1, x2, y2);
      } else {
        d = elbowPath(x1, y1, x2, y2);
      }
      var pcls = (n.id === SEL || p.id === SEL) ? 'on' : '';
      if(isNew) pcls = (pcls ? pcls + ' ' : '') + 'anim-draw';
      /* pathLength 把任意长度的线归一到 100，dasharray 才能统一算，
         不然长线画 0.34s、短线 0.05s，看着一跳一跳。 */
      parts.push('<path d="' + d + '" pathLength="100"' + (pcls ? ' class="' + pcls + '"' : '') + '/>');
    });
    svg.innerHTML = parts.join('') + relationsSvg();
    LASTEP = nowEdge;
    FIRSTEDGE = false;
  }

  /* 联系线：两个节点之间额外拉一根虚线弧，箭头指过去，标签压在弧顶 */
  function relationsSvg(){
    ensureExtras();
    var out = [];
    M.tree.relations.forEach(function(r){
      var a = POS[r.from], b = POS[r.to];
      if(!a || !b) return;
      /* 从右边出去、进左边；如果目标在源的左边，就反过来 */
      var fwd = (b.x >= a.x);
      var x1 = fwd ? a.x + a.w : a.x, y1 = a.y + a.h / 2;
      var x2 = fwd ? b.x : b.x + b.w, y2 = b.y + b.h / 2;
      var dx = Math.max(46, Math.abs(x2 - x1) * 0.5);
      var c1 = x1 + (fwd ? dx : -dx), c2 = x2 + (fwd ? -dx : dx);
      /* 弧要真的弯开，否则会贴着两个节点之间的那行字走，标签一定压字 */
      var midY = (y1 + y2) / 2 - Math.max(44, Math.abs(y2 - y1) * 0.42);
      out.push('<path class="rel" d="M' + x1 + ',' + y1 + ' C' + c1 + ',' + midY + ' '
        + c2 + ',' + midY + ' ' + x2 + ',' + y2 + '" marker-end="url(#cvArrow)"/>');
      if(r.label){
        /* 标签压在弧顶，带一块底衬 —— 线穿过节点之间时字仍然读得清 */
        var lx = (x1 + x2) / 2;
        var ly = 0.125 * (y1 + y2) + 0.75 * midY;      /* 三次贝塞尔 t=0.5 的实际点 */
        var tw = 0;
        var tx0 = String(r.label);
        for(var q = 0; q < tx0.length; q++) tw += (tx0.charCodeAt(q) > 255) ? 11 : 6;
        out.push('<g class="rellbg"><rect x="' + (lx - tw / 2 - 6) + '" y="' + (ly - 15)
          + '" width="' + (tw + 12) + '" height="18" rx="5"/>'
          + '<text class="rellb" x="' + lx + '" y="' + (ly - 2)
          + '" text-anchor="middle">' + esc(r.label) + '</text></g>');
      }
    });
    return out.join('');
  }

  /* 外框 / 概要：绝对定位的 div，跟节点同一层 */
  function drawExtras(){
    ensureExtras();
    var scene = $('#cvScene');
    if(!scene) return;
    var olds = scene.querySelectorAll('.cvframe,.cvsum');
    var had = {};
    for(var i0 = 0; i0 < olds.length; i0++){
      had[(olds[i0].getAttribute('data-ex') || '')] = 1;
      olds[i0].remove();
    }
    var html = [];
    M.tree.boundaries.forEach(function(b){
      var bb = subtreeBox(b.node);
      if(!bb) return;
      var pad = 10;
      html.push('<div class="cvframe' + (had['b' + b.id] ? '' : ' anim-in') + '" data-ex="b'
        + esc(b.id) + '" style="left:' + (bb.x1 - pad) + 'px;top:' + (bb.y1 - pad)
        + 'px;width:' + (bb.x2 - bb.x1 + pad * 2) + 'px;height:' + (bb.y2 - bb.y1 + pad * 2)
        + 'px;border-color:' + esc(b.color || '#6FA8FF') + '">'
        + (b.label ? '<span style="background:' + esc(b.color || '#6FA8FF') + '">'
           + esc(b.label) + '</span>' : '') + '</div>');
    });
    M.tree.summaries.forEach(function(sm){
      /* 概要用的是「这一整片」的包围盒：被概括的节点往往还有子节点伸得更右，
         只按它自己的方块算，概要会插到下一列的节点左边去。 */
      var ids = (sm.ids || []).filter(function(id){ return POS[id]; });
      if(!ids.length) return;
      var x2 = 0, y1 = 1e9, y2 = -1e9;
      ids.forEach(function(id){
        var bb = subtreeBox(id) || POS[id];
        x2 = Math.max(x2, bb.x2);
        y1 = Math.min(y1, bb.y1);
        y2 = Math.max(y2, bb.y2);
      });
      html.push('<div class="cvsum' + (had['s' + sm.id] ? '' : ' anim-in') + '" data-ex="s'
        + esc(sm.id) + '" style="left:' + (x2 + 26) + 'px;top:' + y1
        + 'px;height:' + Math.max(20, y2 - y1) + 'px">' + esc(sm.text || '概要') + '</div>');
    });
    if(html.length) scene.insertAdjacentHTML('beforeend', html.join(''));
    var freshEx = scene.querySelectorAll('.cvframe.anim-in,.cvsum.anim-in');
    if(freshEx.length){
      setTimeout(function(){
        var a = scene.querySelectorAll('.cvframe.anim-in,.cvsum.anim-in');
        for(var k = 0; k < a.length; k++) a[k].classList.remove('anim-in');
      }, 300);
    }
  }

  /* 缩放/适合屏幕这种「跳一下」的镜头移动给它一段缓动；
     手动拖拽平移不能有过渡，否则手感发黏。 */
  function glide(on){
    var sc = $('#cvScene');
    if(!sc) return;
    sc.style.transition = on ? 'transform .2s cubic-bezier(.2,.9,.2,1)' : '';
  }

  function applyView(){
    var scene = $('#cvScene');
    if(scene) scene.style.transform = 'translate(' + VIEW.x + 'px,' + VIEW.y + 'px) scale(' + VIEW.scale + ')';
    var pct = $('#cvPct');
    if(pct) pct.textContent = Math.round(VIEW.scale * 100) + '%';
  }

  function fitView(tries){
    var st = $('#cvStage');
    if(!st || !M.tree) return;
    var W = st.clientWidth, H = st.clientHeight;
    /* 刚展开画布时 stage 可能还是 0×0，这时候算出来的居中位置是错的。
       等一帧再来，最多重试 6 次。 */
    if((W < 40 || H < 40) && (tries || 0) < 6){
      requestAnimationFrame(function(){ fitView((tries || 0) + 1); });
      return;
    }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for(var k in POS){
      var q = POS[k];
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x + q.w); maxY = Math.max(maxY, q.y + q.h);
    }
    if(minX > maxX) return;
    var w = maxX - minX, h = maxY - minY;
    var s = Math.min((W - 90) / w, (H - 140) / h, 1.25);
    VIEW.scale = Math.max(0.22, Math.min(1.25, s));
    VIEW.x = (W - w * VIEW.scale) / 2 - minX * VIEW.scale;
    VIEW.y = (H - h * VIEW.scale) / 2 - minY * VIEW.scale;
    applyView();
  }

  /* 切布局。切到自由时把当前树形坐标固化到每个节点上，
     否则第一次拖之前它们没有 x/y，一操作就会跟着树形重排走。 */
  function setLayout(mode){
    if(mode === M.layout) return;
    if(mode === 'free'){
      layoutTree();
      var byId = {};
      walk(M.tree, function(n){ byId[n.id] = n; });
      for(var k in POS){
        var n = byId[k], p = POS[k];
        if(n && p){ n.x = Math.round(p.x); n.y = Math.round(p.y); }
      }
    } else {
      /* 切回树形：把自由坐标清掉，不然界面说「自动排」但还按旧坐标摆 */
      walk(M.tree, function(n){ delete n.x; delete n.y; });
    }
    M.layout = mode;
    /* 布局模式跟着树一起落库，下次打开还是你上次用的那种 */
    if(M.tree) M.tree.layout = mode;
    paintLayout();
    render();
    requestAnimationFrame(function(){ fitView(); });
    scheduleSave();
    toast(mode === 'free' ? '自由布局：拖节点放到任意位置' : '树形布局：自动排开');
  }

  function paintLayout(){
    var b = $('#cvLayout');
    if(!b) return;
    /* 按钮里还有图标，整颗写 textContent 会把 svg 一起抹掉，只写那段文字 */
    var t = $('#cvLayoutT');
    if(t) t.textContent = (M.layout === 'free') ? '自由' : '树形';
    b.classList.toggle('on', M.layout === 'free');
    b.title = (M.layout === 'free')
      ? '现在是自由布局：拖节点放到任意位置，点一下切回自动排'
      : '现在是自动排：点一下改成自由摆放';
  }

  function centerOn(id){
    var p = POS[id], st = $('#cvStage');
    if(!p || !st) return;
    VIEW.x = st.clientWidth / 2 - (p.x + p.w / 2) * VIEW.scale;
    VIEW.y = st.clientHeight / 2 - (p.y + p.h / 2) * VIEW.scale;
    applyView();
  }

  /* ---------------- 大纲 ---------------- */
  function paintOutline(){
    var box = $('#cvOutline');
    if(!box) return;
    if(!M.tree){ box.innerHTML = '<div class="cvempty">还没有画布</div>'; return; }
    var rows = [];
    walk(M.tree, function(n, p, d){
      if(p && FOLD[p.id]) return;
      var pad = 8 + d * 12;
      rows.push('<button class="olit' + (n.id === SEL ? ' on' : '') + '" data-olid="' + esc(n.id)
        + '" data-od="' + d + '" style="padding-left:' + pad + 'px">'
        + (d ? '<i></i>' : '<i style="background:var(--act);opacity:1"></i>')
        + '<span>' + mdLabel(String(n.text || '(空)').slice(0, 40)) + '</span></button>');
    });
    box.innerHTML = rows.join('') || '<div class="cvempty">还没有节点</div>';
    /* 重绘后元素是新的，动画类要重新挂一次，否则键盘切节点时没有回应 */
    if(SEL) once(box.querySelector('.olit[data-olid="' + SEL + '"]'), 'pop');
  }

  /* ---------------- 检查器 ---------------- */
  var PALETTE = ['', '#FF6B1F', '#59A5EE', '#3ED598', '#FFC042', '#AE8DEE', '#FF5757', '#57AE83'];

  /* 来源的中文名。卡片和顶栏都读这张表，不要直接把 src id 摆给用户看。 */
  var SRCNAME = {local: '本地', xmind: 'XMind', markdown: 'Markdown', obsidian: 'Obsidian',
                 notion: 'Notion', joplin: 'Joplin', logseq: 'Logseq', yuque: '语雀',
                 wolai: '我来', opml: 'OPML'};

  /* 主题只管配色与底色；连线形状单独由 edge 控制，两件事分开换。
     每个主题只有 7 个值，改起来不用碰 CSS 文件。 */
  var THEMES = {
    dark:    {name: '深夜',  bg: '#0E1013', grid: '#1A1E24', node: '#171A20', nodeLine: '#272B33',
              tx: '#F6F7F8', root: '#FF6B1F', rootTx: '#140700', edge: '#3A3F49',
              panel: '#101217', panel2: '#171A20', line: '#272B33', tx2: '#ADB4BD'},
    paper:   {name: '纸白',  bg: '#F7F5F0', grid: '#E7E3DA', node: '#FFFFFF', nodeLine: '#DCD6C9',
              tx: '#2A2620', root: '#C2571B', rootTx: '#FFF6EE', edge: '#C9C2B2',
              panel: '#EFEBE2', panel2: '#E4DFD3', line: '#D8D2C4', tx2: '#6B6357'},
    slate:   {name: '雾蓝',  bg: '#101820', grid: '#1B2733', node: '#18222D', nodeLine: '#2A3846',
              tx: '#E8EFF5', root: '#3E8FD6', rootTx: '#04121F', edge: '#33475B',
              panel: '#0D141B', panel2: '#17222D', line: '#22303D', tx2: '#93A6B5'},
    moss:    {name: '苔绿',  bg: '#0F1412', grid: '#1A231E', node: '#161D19', nodeLine: '#28362D',
              tx: '#EAF2ED', root: '#4FA97A', rootTx: '#04170E', edge: '#2F4438',
              panel: '#0B100E', panel2: '#151C18', line: '#22302A', tx2: '#8FA79A'},
    contrast:{name: '高对比', bg: '#000000', grid: '#191919', node: '#111111', nodeLine: '#5A5A5A',
              tx: '#FFFFFF', root: '#FFD400', rootTx: '#000000', edge: '#8A8A8A',
              panel: '#000000', panel2: '#1C1C1C', line: '#4A4A4A', tx2: '#C8C8C8'}
  };
  var EDGES = {
    elbow: '折线',
    line:  '直线',
    curve: '曲线'
  };

  function applyTheme(){
    var w = $('#cvwrap');
    if(!w) return;
    var t = THEMES[M.theme] || THEMES.dark;
    w.setAttribute('data-theme', M.theme);
    w.setAttribute('data-edge', M.edge || 'elbow');
    /* 直接写变量，比在 CSS 里铺 5 个 [data-theme] 块好维护：
       新增主题只要往 THEMES 里加一行。 */
    w.style.setProperty('--cvbg', t.bg);
    w.style.setProperty('--cvgrid', t.grid);
    w.style.setProperty('--cvnode', t.node);
    w.style.setProperty('--cvnodeline', t.nodeLine);
    w.style.setProperty('--cvtx', t.tx);
    w.style.setProperty('--cvroot', t.root);
    w.style.setProperty('--cvroottx', t.rootTx);
    w.style.setProperty('--cvedge', t.edge);
    w.style.setProperty('--cvpanel', t.panel);
    w.style.setProperty('--cvpanel2', t.panel2);
    w.style.setProperty('--cvline', t.line);
    w.style.setProperty('--cvtx2', t.tx2);
    var b = $('#cvTheme');
    if(b) b.title = '主题：' + t.name + '（点一下换下一套）';
  }

  /* 换主题：按 THEMES 的顺序循环 */
  function nextTheme(){
    var keys = Object.keys(THEMES);
    var i = keys.indexOf(M.theme);
    M.theme = keys[(i + 1) % keys.length];
    if(M.tree) M.tree.theme = M.theme;
    applyTheme(); scheduleSave();
    toast('主题：' + THEMES[M.theme].name);
  }

  /* 按钮上要能看出现在是哪种形状，不然点一下只能靠 toast 猜 */
  function paintEdge(){
    var b = $('#cvEdge');
    if(b) b.title = '连线：' + (EDGES[M.edge] || '折线') + '（点一下换形状）';
  }

  /* 换连线形状：折线 / 直线 / 曲线 */
  function nextEdge(){
    var keys = Object.keys(EDGES);
    var i = keys.indexOf(M.edge || 'elbow');
    M.edge = keys[(i + 1) % keys.length];
    if(M.tree) M.tree.edge = M.edge;
    applyTheme(); paintEdge(); drawEdges(); scheduleSave();
    toast('连线：' + EDGES[M.edge]);
  }

  function marksHtml(n){
    var on = {};
    (n.mk || []).forEach(function(k){ on[k] = 1; });
    return '<div class="cvinsp-sec"><label>图标标记</label><div class="cvmarks" id="inspMarks">'
      + MARKS.map(function(m){
          var inn = /^pri/.test(m.k) ? esc(m.k.slice(3))
            : (m.ic ? '<svg class="ic" style="width:12px;height:12px"><use href="#'
                      + m.ic + '"/></svg>' : esc(m.g || '•'));
          return '<button class="cvmark' + (on[m.k] ? ' on' : '') + '" data-mk="' + m.k
            + '" style="--mkc:' + m.c + '" title="' + esc(m.n) + '">' + inn + '</button>';
        }).join('')
      + '</div></div>';
  }

  function labelsHtml(n){
    var rows = (n.lb || []).map(function(t){
      return '<span class="lbl on" data-rmlb="' + esc(t) + '" title="点一下去掉这个标签">'
        + esc(t) + '<i>×</i></span>';
    }).join('');
    return '<div class="cvinsp-sec"><label>标签</label>'
      + '<div class="cvlabels" id="inspLabels">' + (rows || '<span class="sub">还没有标签</span>')
      + '</div>'
      + '<div class="cvlbrow"><input class="inp" id="inspLbIn" placeholder="写个标签，回车加上">'
      + '<button class="cvmini" id="inspLbGo">加</button></div></div>';
  }

  function paintInspector(){
    var box = $('#cvInsp');
    if(!box) return;
    var hit = SEL ? findNode(SEL) : null;
    if(!hit){
      box.innerHTML = '<div class="cvempty">选中一个节点，这里能改字、写备注、标颜色。<br><br>'
        + '节点里的字支持 Markdown：<br><code>**粗**</code> <code>*斜*</code> '
        + '<code>`代码`</code> <code>[文字](网址)</code></div>';
      $('#cvInspN').textContent = '未选中';
      return;
    }
    var n = hit.node;
    $('#cvInspN').textContent = '第 ' + (n.id === M.tree.id ? 1 : 2) + ' 层';
    var sw = PALETTE.map(function(c){
      return '<button class="cvsw' + ((n.color || '') === c ? ' on' : '') + '" data-color="'
        + c + '" style="background:' + (c || 'transparent') + ';'
        + (c ? '' : 'border:2px dashed var(--line2);') + '"></button>';
    }).join('');
    box.innerHTML =
        '<label>节点文字</label>'
      + '<textarea id="inspText" rows="2">' + esc(n.text) + '</textarea>'
      + '<label>备注（Markdown）</label>'
      + '<textarea id="inspNote" rows="5" placeholder="支持 **粗体**、- 列表、> 引用、```代码```">' + esc(n.note || '') + '</textarea>'
      + '<label>备注预览</label>'
      + '<div class="cvmd" id="inspMd">' + (n.note ? mdToHtml(n.note) : '<span class="sub">还没有备注</span>') + '</div>'
      + '<label>分支颜色</label>'
      + '<div class="cvswatch">' + sw + '</div>'
      + '<div class="cvact">'
      + marksHtml(n) + labelsHtml(n)
      + '<button class="cvmini" id="inspImg">插图片</button>'
      + '<button class="cvmini" id="inspChild">加子节点</button>'
      + '<button class="cvmini" id="inspSib">加同级</button>'
      + '<button class="cvmini danger" id="inspDel"' + (n.id === M.tree.id ? ' disabled' : '') + '>删除</button>'
      + '</div>';
  }

  /* ---------------- 保存 / 载入 ---------------- */
  function markDirty(){
    M.dirty = true;
    var el = $('#cvSave');
    if(el){ el.textContent = '未保存'; el.classList.add('dirty'); }
  }

  var saveTimer = null;
  function scheduleSave(){
    commitHist();               /* 所有改树的路径都会走到这里，撤销点在这里落 */
    markDirty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 900);
  }

  function doSave(){
    if(!M.tree) return;
    var args = {
      lesson_id: M.lesson || null,
      title: M.title,
      tree: M.tree,
      src: M.src || 'local',
      src_id: M.srcId || null,
      /* 打开的是哪张就存哪张。从外面拉进来的图 id 是文件指纹，
         不带上它就会新存一张三元组 id 的 —— 原图不动，推回去推的还是老内容。 */
      map_id: M.id || null
    };
    ct('note_save', args, {
      onDone: function(r){
        if(r && r.ok){
          M.dirty = false;
          if(r.data && r.data.map && r.data.map.id) M.id = r.data.map.id;
          M.savedAt = (r.data && r.data.map && r.data.map.updated_ts) || '';
          var el = $('#cvSave');
          if(el){ el.textContent = '已保存'; el.classList.remove('dirty'); }
          loadCards();
        } else {
          toast('保存失败：' + ((r && r.error) || '未知'), true);
        }
      }
    });
  }

  function openCanvas(opts){
    opts = opts || {};
    M.title = opts.title || '未命名画布';
    M.id = opts.mapId ? String(opts.mapId) : '';   // 打开哪张就记住哪张 id
    M.lesson = opts.lesson != null ? opts.lesson : (SDX().currentLesson ? SDX().currentLesson() : null);
    M.src = opts.src || 'local';
    M.srcId = opts.srcId || null;
    M.tree = opts.tree || null;
    M.dirty = false;
    SEL = null;
    FOLD = {};
    MSEL = {}; CLIP = CLIP || null; FINDS = []; FIND0 = 0;
    var fEl = $('#cvFind'); if(fEl) fEl.hidden = true;
    loadShotCount();   /* 换成别的学科/讲次时，顶栏角标不能还是上一张画布的数 */
    $('#cvTitle').value = M.title;
    $('#cvBadge').textContent = SRCNAME[M.src] || M.src;
    M.layout = (opts.layout === 'free' || (opts.tree && opts.tree.layout === 'free')) ? 'free' : 'tree';
    M.theme = (opts.tree && opts.tree.theme) || 'dark';
    M.edge = (opts.tree && opts.tree.edge) || 'elbow';
    paintLayout();
    applyTheme();
    paintEdge();
    paintPushBtn();
    if(M.tree){ M.tree.layout = M.layout; M.tree.theme = M.theme; M.tree.edge = M.edge; }
    $('#cvwrap').hidden = false;
    document.body.style.overflow = 'hidden';
    var el = $('#cvSave'); if(el){ el.textContent = '已保存'; el.classList.remove('dirty'); }

    /* 树到手之后的收尾：读回布局/主题/连线、清动画状态、画、补标题。
       抽成函数是因为载入有两条路（按三元组、按 mapId），收尾必须一致，
       不然从账单里打开的那张图会丢主题、也不播入场动画。 */
    function tail(){
      M.layout = (M.tree && M.tree.layout === 'free') ? 'free' : 'tree';
      M.theme = (M.tree && M.tree.theme) || 'dark';
      M.edge = (M.tree && M.tree.edge) || 'elbow';
      paintLayout();
      applyTheme();
      /* 新载入的一张图：先清动画状态再画，否则整棵树会被当成「新长出来的」全部淡进来 */
      LASTA = {}; LASTEP = {}; NEWEDGE = {}; FIRSTEDGE = true; FIRSTNODE = true;
      render();
      /* 标题框绝不能留空：库里那张图若标题是空串，就用根节点文字顶上。
         空标题会让「这是哪张画布」当场失效，也让卡片列表和顶栏对不上。 */
      var ti = $('#cvTitle');
      if(ti && !String(ti.value || '').trim()){
        ti.value = (M.tree && M.tree.text) || '未命名画布';
        M.title = ti.value;
      }
      $('#cvBadge').textContent = SRCNAME[M.src] || M.src;
      paintPushBtn();
      resetHist();
      requestAnimationFrame(function(){ fitView(); });
    }

    if(M.tree){
      normalize(M.tree);
      /* 换了一张图，动画状态必须「先」清掉再画 ——
         放在 render 之后清，这一帧已经用旧状态判定过了，等于白清。 */
      LASTA = {}; LASTEP = {}; NEWEDGE = {}; FIRSTEDGE = true; FIRSTNODE = true;
      render();
      resetHist();
      requestAnimationFrame(function(){ fitView(); });
      return;
    }
    /* 按 mapId 打开：批量导入回来的画布 id 里带文件指纹，前端拼不出
       (讲次, 来源, 来源 id) 那个三元组，只能按 id 直接取。 */
    if(opts.mapId){
      ct('note_open', {map_id: String(opts.mapId)}, {
        onDone: function(r){
          var dd = (r && r.data) || {};
          if(!r || !r.ok || !dd.tree || dd.tree.text == null){
            toast('打不开这张画布：' + ((r && r.error) || '库里没有记录'), true);
            M.tree = newTree(M.title);
            tail();
            return;
          }
          var mp = dd.map || {};
          M.tree = dd.tree;
          M.title = mp.title || M.title;
          M.lesson = (opts.lesson != null ? opts.lesson : (mp.lesson_id || M.lesson));
          M.src = opts.src || mp.src || 'local';
          M.srcId = (opts.srcId != null ? opts.srcId : (mp.src_id || null));
          $('#cvTitle').value = M.title;
          tail();
        }
      });
      return;
    }
    var args = {lesson_id: M.lesson, src: M.src, src_id: M.srcId};
    ct('note_load', args, {
      onDone: function(r){
        if(r && r.ok && r.data && r.data.exists){
          M.tree = r.data.tree || newTree(M.title);
          M.title = (r.data.map && r.data.map.title) || M.title;
          M.id = (r.data.map && r.data.map.id) || M.id;
          $('#cvTitle').value = M.title;
        } else {
          M.tree = newTree(M.title);
        }
        /* 库里存着的布局/主题/连线形状要在这一步读回来。
           少了这一段，纸白主题的图打开还是深夜配色 —— 存了等于没存。 */
        tail();
      }
    });
  }

  function closeCanvas(){
    if(M.dirty) doSave();
    $('#cvwrap').hidden = true;
    document.body.style.overflow = '';
    loadCards();
  }

  /* ---------------- 右侧画布卡片 ---------------- */
  function thumbSvg(shape){
    /* 缩略图按真实结构画：后端 note_list 给每行带一个 shape（前 3 层、≤16 节点）。
       没有 shape 就画一条空的主干——绝不塞一棵假的树进去。 */
    var W = 320, H = 112;
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="100%"'
      + ' preserveAspectRatio="xMidYMid meet">';
    if(!shape || !shape.t){
      out += '<rect x="10" y="' + (H / 2 - 6) + '" width="56" height="12" rx="6" fill="#2A313B"/>';
      out += '<path d="M66,' + (H / 2) + ' H108" stroke="#333A44" stroke-width="1.3" fill="none"/>';
      out += '<rect x="108" y="' + (H / 2 - 4.5) + '" width="34" height="9" rx="4.5" fill="#22272F"/>';
      out += '</svg>';
      return out;
    }
    /* 三列坐标，按每列实际节点数均分纵向 */
    var colX = [10, 124, 234];
    var cols = [[], [], []];
    (function walk(n, d){
      if(d > 2 || !n) return;
      cols[d].push(n);
      (n.c || []).forEach(function(k){ walk(k, d + 1); });
    })(shape, 0);
    cols.forEach(function(arr, d){
      var step = H / (Math.max(1, arr.length) + 0.7);
      arr.forEach(function(n, i){
        n._x = colX[Math.min(d, 2)];
        n._y = step * (i + 0.85);
        n._d = d;
      });
    });
    /* 连线：父子靠对象引用对上 */
    (function edge(n, d){
      if(d > 1) return;
      var w1 = d === 0 ? 54 : 34;
      (n.c || []).forEach(function(k){
        if(k._y == null) return;
        var x1 = n._x + w1, y1 = n._y, x2 = k._x, y2 = k._y;
        var mx = x1 + Math.max(8, (x2 - x1) / 2);
        out += '<path d="M' + x1 + ',' + y1 + ' H' + mx + ' V' + y2 + ' H' + x2
          + '" fill="none" stroke="#333A44" stroke-width="1.3"/>';
        edge(k, d + 1);
      });
    })(shape, 0);
    /* 节点 */
    (function box(n, d){
      if(n._y == null) return;
      var w = d === 0 ? 54 : (d === 1 ? 34 : 26), h = d === 0 ? 13 : 9;
      var fill = d === 0 ? '#FF6B1F' : (n.col || (d === 1 ? '#2A313B' : '#22272F'));
      out += '<rect x="' + n._x + '" y="' + (n._y - h / 2) + '" width="' + w + '" height="' + h
        + '" rx="' + (h / 2) + '" fill="' + fill + '"/>';
      (n.c || []).forEach(function(k){ box(k, d + 1); });
    })(shape, 0);
    out += '</svg>';
    return out;
  }

  function loadCards(){
    var box = $('#ndCards');
    if(!box) return;
    var lesson = SDX().currentLesson ? SDX().currentLesson() : null;
    ct('note_list', {lesson_id: lesson}, {
      onDone: function(r){
        var maps = (r && r.ok && r.data && r.data.maps) || [];
        CARDS = maps;
        var n = $('#ndockN');
        if(n) n.textContent = maps.length;
        var sub = $('#ndockSub');
        if(sub) sub.textContent = maps.length ? (maps.length + ' 张 · 点开就进画布') : '还没有';
        if(!maps.length){
          var all = (r && r.data && r.data.total) || 0;
          box.innerHTML = '<div class="nempty">这一讲还没有画布。<br>'
            + (all ? '本机其它地方还有 ' + all + ' 张，切到对应讲次就能看到。' : '点上面的「新建一张画布」开始。')
            + '</div>';
          return;
        }
        box.innerHTML = maps.map(function(m){
          return '<button class="ncard" data-map="' + esc(m.id) + '">'
            + '<span class="ncard-thumb">' + thumbSvg(m.shape) + '</span>'
            + '<span class="ncard-meta">'
            + '<span class="ncard-src ' + esc(m.src || 'local') + '">'
            + esc(SRCNAME[m.src] || m.src || '本地') + '</span>'
            + '<b>' + esc(m.title || '未命名') + '</b>'
            + '<span class="sub">' + esc(m.age || '') + '</span>'
            + '</span></button>';
        }).join('');
      }
    });
  }

  function openCard(mapId){
    var m = null;
    for(var i = 0; i < CARDS.length; i++){ if(CARDS[i].id === mapId) m = CARDS[i]; }
    if(!m) return;
    openCanvas({title: m.title, lesson: m.lesson_id, src: m.src, srcId: m.src_id});
  }

  /* ---------------- 编辑动作 ---------------- */
  function selectNode(id){
    var prev = SEL;
    SEL = id;
    paintMsel();
    $$('.cvnode').forEach(function(el){ el.classList.toggle('sel', el.getAttribute('data-id') === id); });
    drawEdges();
    paintOutline();
    paintInspector();
    if(id && id !== prev){
      /* 刚落地的新节点正在播入场，再叠一个回弹会互相覆盖（CSS 里后定义的赢），
         结果入场被顶掉。所以新节点只播入场。 */
      var elp = document.querySelector('.cvnode[data-id="' + id + '"]');
      if(elp && !elp.classList.contains('anim-in')) once(elp, 'pop');
      once(document.querySelector('.olit[data-olid="' + id + '"]'), 'pop');
      once($('#cvInsp'), 'anim-in');
    }
  }

  function addChild(){
    pushHist();
    var hit = SEL ? findNode(SEL) : {node: M.tree};
    if(!hit) hit = {node: M.tree};
    var n = {id: uid(), text: '', note: '', children: [], color: ''};
    hit.node.children = hit.node.children || [];
    hit.node.children.push(n);
    FOLD[hit.node.id] = 0;
    render();
    selectNode(n.id);
    scheduleSave();          /* 结构变了就要落库，不能等下次输入 */
    startEdit(n.id);
  }

  function addSibling(){
    var hit = SEL ? findNode(SEL) : null;
    if(!hit || !hit.parent){ addChild(); return; }
    pushHist();
    var n = {id: uid(), text: '', note: '', children: [], color: ''};
    var arr = hit.parent.children;
    var i = arr.indexOf(hit.node);
    arr.splice(i + 1, 0, n);
    render();
    selectNode(n.id);
    scheduleSave();
    startEdit(n.id);
  }

  function delNode(){
    var hit = SEL ? findNode(SEL) : null;
    if(!hit || !hit.parent) return;
    pushHist();
    var gone = [];
    (function rec(n){ gone.push(n.id); (n.children || []).forEach(rec); })(hit.node);
    pruneExtras(gone);          /* 批注里引用了这些节点的，一起摘掉 */
    var arr = hit.parent.children;
    arr.splice(arr.indexOf(hit.node), 1);
    SEL = hit.parent.id;
    render();
    scheduleSave();
  }

  function startEdit(id){
    var el = document.querySelector('.cvnode[data-id="' + id + '"]');
    if(!el) return;
    var hit = findNode(id);
    if(!hit) return;
    el.classList.add('editing');
    el.innerHTML = '<textarea>' + esc(hit.node.text) + '</textarea>';
    var ta = el.querySelector('textarea');
    if(!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    function done(commit){
      if(!ta.parentNode) return;
      var v = ta.value;
      if(commit && v !== hit.node.text){ pushHist(); hit.node.text = v; scheduleSave(); }
      render();
      selectNode(id);
    }
    ta.addEventListener('blur', function(){ done(true); });
    ta.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); done(true); }
      else if(e.key === 'Escape'){ e.preventDefault(); done(false); }
      e.stopPropagation();
    });
  }


  /* ---------------- 撤销 / 重做 ----------------
     整棵树存 JSON 快照。画布不大（几百个节点也就几十 KB），
     存快照比记「操作日志 + 反向操作」可靠得多：不会因为某条反向操作写错而把树改坏。 */
  function snap(){ return JSON.stringify(M.tree); }

  /* 改动前调一次，把那一刻的树记住。重复调不会覆盖：
     一次操作里可能连着好几处改，撤销点只认最早的那一帧。 */
  function pushHist(){
    if(!M.tree) return;
    if(PRE === null) PRE = snap();
  }

  /* 改动后调。真的变了才入栈；没变就把暂存扔掉，不留空档。 */
  function commitHist(){
    if(PRE === null || !M.tree) return;
    var cur = snap();
    if(PRE !== cur){
      HIST = HIST.slice(0, HISTI + 1);
      HIST.push(cur);
      if(HIST.length > 60) HIST.shift();
      HISTI = HIST.length - 1;
    }
    PRE = null;
    paintHist();
  }

  function paintHist(){
    var u = $('#cvUndo'), r = $('#cvRedo');
    if(u) u.disabled = (HISTI <= 0);
    if(r) r.disabled = (HISTI >= HIST.length - 1);
  }

  function applyHist(){
    if(HISTI < 0 || HISTI >= HIST.length) return;
    PRE = null;                 /* 撤销本身就是一次状态切换，别再叠一层暂存 */
    var keepScale = VIEW.scale, keepX = VIEW.x, keepY = VIEW.y;
    M.tree = JSON.parse(HIST[HISTI]);
    normalize(M.tree);
    SEL = null; MSEL = {}; 
    render();
    VIEW.scale = keepScale; VIEW.x = keepX; VIEW.y = keepY; applyView();
    scheduleSave();
    paintHist();
  }

  function undo(){ if(HISTI <= 0){ toast('没有更早的了', true); return; } HISTI--; applyHist(); }
  function redo(){ if(HISTI >= HIST.length - 1){ toast('没有更新的了', true); return; } HISTI++; applyHist(); }

  function resetHist(){
    HIST = []; HISTI = -1; HISTPEND = false; PRE = null;
    if(M.tree){ HIST = [snap()]; HISTI = 0; }
    paintHist();
  }

  /* ---------------- 多选 ---------------- */
  function selIds(){
    var ids = Object.keys(MSEL);
    /* MSEL 里装的只是「另外按住 Shift 点的那几个」，主选那个在 SEL 上。
       所以主选必须并进来，否则 点A → Shift点B 之后只认 B 一个。 */
    if(SEL && ids.indexOf(SEL) < 0) ids.unshift(SEL);
    return ids;
  }
  function paintMsel(){
    [].slice.call(document.querySelectorAll('.cvnode')).forEach(function(el){
      el.classList.toggle('msel', !!MSEL[el.getAttribute('data-id')]);
    });
  }
  function clearMsel(){ MSEL = {}; paintMsel(); }

  /* ---------------- 复制 / 粘贴 / 剪切 ----------------
     剪切 = 复制 + 立刻删。这样「剪了但没粘」不会丢东西，
     也不会出现「粘两次删一次」的糊涂账。 */
  function copySel(cut){
    var ids = selIds();
    var items = [];
    ids.forEach(function(id){
      var h = findNode(id);
      if(h && h.parent) items.push({id: id, node: JSON.parse(JSON.stringify(h.node))});
    });
    if(!items.length){ toast('根节点复制不了', true); return; }
    CLIP = {items: items};
    toast((cut ? '已剪切 ' : '已复制 ') + items.length + ' 个节点');
    if(cut) delSel(true);
  }

  function reid(n){
    n.id = uid();
    var kids = n.children || [];
    for(var i = 0; i < kids.length; i++) reid(kids[i]);
  }

  function pasteClip(){
    if(!CLIP || !CLIP.items.length){ toast('剪贴板是空的', true); return; }
    var dst = (SEL && findNode(SEL)) || {node: M.tree};
    pushHist();
    var last = null;
    CLIP.items.forEach(function(it){
      var cp = JSON.parse(JSON.stringify(it.node));
      reid(cp);
      dst.node.children = dst.node.children || [];
      dst.node.children.push(cp);
      last = cp.id;
    });
    FOLD[dst.node.id] = 0;
    render();
    if(last) selectNode(last);
    scheduleSave();
    toast('已粘贴 ' + CLIP.items.length + ' 个节点');
  }

  /* 删掉的节点身上挂着的批注要一起清，否则下次渲染会画出连不到任何东西的线 */
  function pruneExtras(gone){
    if(!M.tree) return;
    var dead = {};
    gone.forEach(function(id){ dead[id] = 1; });
    if(M.tree.relations)
      M.tree.relations = M.tree.relations.filter(function(r){
        return !dead[r.from] && !dead[r.to];
      });
    if(M.tree.boundaries)
      M.tree.boundaries = M.tree.boundaries.filter(function(b){ return !dead[b.node]; });
    if(M.tree.summaries)
      M.tree.summaries = M.tree.summaries.filter(function(s){
        return (s.ids || []).filter(function(id){ return !dead[id]; }).length > 0;
      });
  }

  function delSel(silent){
    var rootId = M.tree && M.tree.id;
    var ids = selIds().filter(function(id){ return id !== rootId; });
    if(!ids.length){ if(!silent) toast('根节点删不了', true); return; }
    pushHist();
    var gone = [];
    ids.forEach(function(id){
      var h = findNode(id);
      if(!h || !h.parent) return;
      (function rec(n){ gone.push(n.id); (n.children || []).forEach(rec); })(h.node);
      var arr = h.parent.children, i = arr.indexOf(h.node);
      if(i >= 0) arr.splice(i, 1);
    });
    pruneExtras(gone);          /* 批注里引用了这些节点的，一起摘掉 */
    MSEL = {};
    SEL = rootId || null;
    render();
    scheduleSave();
    if(!silent) toast('删了 ' + ids.length + ' 个节点');
  }

  /* ---------------- 拖节点换父级 ---------------- */
  function isUnder(root, id){
    if(!root) return false;
    if(root.id === id) return true;
    var kids = root.children || [];
    for(var i = 0; i < kids.length; i++) if(isUnder(kids[i], id)) return true;
    return false;
  }

  function reparent(srcId, dstId){
    if(!srcId || !dstId || srcId === dstId) return;
    var sh = findNode(srcId), dh = findNode(dstId);
    if(!sh || !sh.parent){ toast('根节点搬不动', true); return; }
    if(!dh) return;
    if(isUnder(sh.node, dstId)){ toast('不能搬进自己的子树', true); return; }
    if(sh.parent.id === dstId){ toast('已经在这一支下面了'); return; }
    pushHist();
    sh.parent.children.splice(sh.parent.children.indexOf(sh.node), 1);
    dh.node.children = dh.node.children || [];
    dh.node.children.push(sh.node);
    FOLD[dstId] = 0;
    render(); selectNode(srcId); scheduleSave();
    toast('已挂到「' + String(dh.node.text || '未命名').slice(0, 12) + '」下面');
  }

  /* ---------------- 搜节点 ---------------- */
  function openFind(on){
    var f = $('#cvFind'); if(!f) return;
    f.hidden = !on;
    if(on){
      var i = $('#cvFindIn'); if(i){ i.focus(); i.select(); }
      runFind();
    } else {
      FINDS = []; FIND0 = 0; paintHits();
    }
  }

  function runFind(){
    var q = String((($('#cvFindIn') || {}).value) || '').trim().toLowerCase();
    FINDS = [];
    if(q && M.tree){
      walk(M.tree, function(n){
        var t = String(n.text || '').toLowerCase();
        var nt = String(n.note || '').toLowerCase();
        if(t.indexOf(q) >= 0 || nt.indexOf(q) >= 0) FINDS.push(n.id);
      });
    }
    FIND0 = 0;
    if(FINDS.length) gotoHit(0); else paintHits();
  }

  function paintHits(){
    var cur = FINDS.length ? FINDS[FIND0] : null;
    [].slice.call(document.querySelectorAll('.cvnode')).forEach(function(el){
      var id = el.getAttribute('data-id');
      el.classList.toggle('hit', FINDS.indexOf(id) >= 0);
      el.classList.toggle('cur', id === cur);
    });
    var c = $('#cvFindN');
    if(c) c.textContent = FINDS.length ? ((FIND0 + 1) + ' / ' + FINDS.length) : '没找到';
  }

  /* 命中项可能在折叠的子树里：先把路上的折叠打开，再跳过去 */
  function unfoldTo(id){
    var path = [];
    (function rec(n, chain){
      if(!n) return false;
      var c2 = chain.concat([n.id]);
      if(n.id === id){ path = c2; return true; }
      var kids = n.children || [];
      for(var i = 0; i < kids.length; i++) if(rec(kids[i], c2)) return true;
      return false;
    })(M.tree, []);
    var opened = false;
    for(var i = 0; i < path.length - 1; i++){
      if(FOLD[path[i]]){ FOLD[path[i]] = 0; opened = true; }
    }
    return opened;
  }

  function gotoHit(k){
    if(!FINDS.length) return;
    FIND0 = ((k % FINDS.length) + FINDS.length) % FINDS.length;
    var id = FINDS[FIND0];
    if(unfoldTo(id)) render();
    selectNode(id);
    centerOn(id);
    paintHits();
  }

  /* ---------------- 导出图片 ----------------
     画布是 DOM 画的，不是 canvas 画的，所以不能直接 toDataURL。
     这里把树和连线重新画成一张独立 SVG（只含 rect / text / path，不含 foreignObject，
     否则 drawImage 会把画布污染掉、toBlob 直接抛错），再转到 canvas 出 PNG。 */
  function plainText(s){
    return String(s == null ? '' : s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|\*|`|#+\s*/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }
  function escSvg(v){
    return String(v == null ? '' : v).replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  function buildSvg(){
    if(!M.tree) return '';
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, any = false;
    for(var k in POS){
      var q = POS[k]; any = true;
      if(q.x < minX) minX = q.x;
      if(q.y < minY) minY = q.y;
      if(q.x + q.w > maxX) maxX = q.x + q.w;
      if(q.y + q.h > maxY) maxY = q.y + q.h;
    }
    if(!any) return '';
    var PAD = 44;
    var W = Math.round(maxX - minX + PAD * 2), H = Math.round(maxY - minY + PAD * 2);
    var ox = -minX + PAD, oy = -minY + PAD;
    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H
      + '" viewBox="0 0 ' + W + ' ' + H + '">');
    var TH = THEMES[M.theme] || THEMES.dark;
    out.push('<rect width="100%" height="100%" fill="' + TH.bg + '"/>');
    walk(M.tree, function(n, p){
      if(!p || FOLD[p.id]) return;
      var a = POS[p.id], b = POS[n.id];
      if(!a || !b) return;
      var x1 = a.x + a.w + ox, y1 = a.y + a.h / 2 + oy;
      var x2 = b.x + ox, y2 = b.y + b.h / 2 + oy;
      var mx = x1 + Math.max(18, (x2 - x1) / 2);
      out.push('<path d="M' + x1 + ',' + y1 + ' H' + mx + ' V' + y2 + ' H' + x2
        + '" fill="none" stroke="' + TH.edge + '" stroke-width="1.6" stroke-linejoin="round"/>');
    });
    walk(M.tree, function(n, p, d){
      var q = POS[n.id]; if(!q) return;
      var isRoot = (d === 0);
      var x = q.x + ox, y = q.y + oy;
      var fill = isRoot ? TH.root : TH.node;
      var stroke = isRoot ? TH.root : (n.color || TH.nodeLine);
      out.push('<rect x="' + x + '" y="' + y + '" width="' + q.w + '" height="' + q.h
        + '" rx="' + (isRoot ? 12 : 9) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.4"/>');
      var fs = isRoot ? 15 : 12.6;
      var tc = isRoot ? TH.rootTx : TH.tx;
      var label = plainText(n.text) || '(空)';
      out.push('<text x="' + (x + 13) + '" y="' + (y + q.h / 2 + fs * 0.36) + '" font-size="' + fs
        + '" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif" fill="'
        + tc + '">' + escSvg(label) + '</text>');
    });
    out.push('</svg>');
    return out.join('');
  }

  function safeName(){
    return (String(M.title || 'mindmap').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'mindmap');
  }
  function download(href, name){
    var a = document.createElement('a');
    a.download = name; a.href = href;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function exportPng(){
    var svg = buildSvg();
    if(!svg){ toast('画布是空的', true); return; }
    closeMod();
    var img = new Image();
    img.onload = function(){
      var sc = 2;
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.width * sc);
      cv.height = Math.round(img.height * sc);
      var g = cv.getContext('2d');
      g.scale(sc, sc);
      g.fillStyle = (THEMES[M.theme] || THEMES.dark).bg;
      g.fillRect(0, 0, img.width, img.height);
      g.drawImage(img, 0, 0);
      cv.toBlob(function(b){
        var u = URL.createObjectURL(b);
        download(u, safeName() + '.png');
        setTimeout(function(){ URL.revokeObjectURL(u); }, 5000);
        toast('已导出 PNG · ' + cv.width + '×' + cv.height);
      }, 'image/png');
    };
    img.onerror = function(){ toast('导出失败：图没画出来', true); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function exportSvg(){
    var svg = buildSvg();
    if(!svg){ toast('画布是空的', true); return; }
    closeMod();
    var u = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}));
    download(u, safeName() + '.svg');
    setTimeout(function(){ URL.revokeObjectURL(u); }, 5000);
    toast('已导出 SVG');
  }

  function openImage(){
    if(!SEL){ toast('先选一个节点', true); return; }
    openMod('往节点里插一张图',
      '<p class="sub" style="margin-bottom:10px">'
      + '填图片地址（http/https），或者本机 /img/ 下的路径也行。<br>'
      + '插进去以后，节点文字里就是一句 Markdown：<code>![说明](地址)</code>。</p>'
      + '<label class="cvfl">图片地址</label>'
      + '<input class="cvin" id="imgUrl" placeholder="https://… 或 /img/…" spellcheck="false">'
      + '<label class="cvfl">一句说明（读图的人看到的就是它）</label>'
      + '<input class="cvin" id="imgAlt" placeholder="可留空" spellcheck="false">',
      '<button class="cvmini" id="cvModX6">取消</button>'
      + '<button class="btn act sm" id="imgGo">插进去</button>');
    $('#cvModX6').onclick = closeMod;
    $('#imgGo').onclick = function(){
      var u = String(($('#imgUrl') || {}).value || '').trim();
      var alt = String(($('#imgAlt') || {}).value || '').trim();
      if(!u){ toast('还没填地址', true); return; }
      if(!/^(https?:|\/|data:image\/)/i.test(u)){ toast('只认 http(s) 开头或 /img/ 开头的地址', true); return; }
      var h = findNode(SEL); if(!h) return;
      pushHist();
      h.node.text = (h.node.text ? h.node.text + ' ' : '') + '![' + alt + '](' + u + ')';
      closeMod();
      render(); selectNode(SEL); scheduleSave();
      toast('图插进去了');
    };
    setTimeout(function(){ var i = $('#imgUrl'); if(i) i.focus(); }, 30);
  }

  function openExport(){
    var svg = buildSvg();
    if(!svg){ toast('画布是空的', true); return; }
    openMod('导出这张导图',
      '<p class="sub" style="margin-bottom:10px">PNG 是 2 倍图，贴到文档里不糊；'
      + 'SVG 是矢量，放大不虚，还能再编辑。</p>'
      + '<div class="cvexp"><img alt="导出预览" src="data:image/svg+xml;charset=utf-8,'
      + encodeURIComponent(svg) + '"></div>',
      '<button class="cvmini" id="cvModX5">取消</button>'
      + '<button class="cvmini" id="expSvg">导出 SVG</button>'
      + '<button class="btn act sm" id="expPng">导出 PNG</button>');
    $('#cvModX5').onclick = closeMod;
    $('#expPng').onclick = exportPng;
    $('#expSvg').onclick = exportSvg;
  }

  /* ---------------- 事件：右侧坞 ---------------- */
  document.addEventListener('click', function(e){
    if(e.target.closest('#ndockTab')){
      var d = $('#ndock');
      var on = !d.classList.contains('on');
      d.classList.toggle('on', on);
      $('#ndockPanel').hidden = !on;
      if(on){ loadCards(); }
      return;
    }
    if(e.target.closest('#ndNew')){
      openCanvas({title: '未命名画布', src: 'local'});
      return;
    }
    var card = e.target.closest('[data-map]');
    if(card){ openCard(card.getAttribute('data-map')); return; }
    if(e.target.closest('#ndMore')){ openSources(); return; }
  });

  /* ---------------- 事件：画布 ---------------- */
  /* 搜索框防抖 320ms：一边打一边搜，但不会每个字符都打一次后端 */
  var galQTimer = null;
  document.addEventListener('input', function(e){
    if(!e.target || e.target.id !== 'galQ') return;
    clearTimeout(galQTimer);
    var v = e.target.value.trim();
    galQTimer = setTimeout(function(){
      SHOTS.q = v;
      paintGallery(SHOTS.subject);
    }, 320);
  });

  document.addEventListener('click', function(e){
    if($('#cvwrap').hidden) return;

    if(e.target.closest('#cvBack')){ closeCanvas(); return; }
    if(e.target.closest('#cvUndo')){ undo(); return; }
    if(e.target.closest('#cvRedo')){ redo(); return; }
    if(e.target.closest('#cvPush')){
      var pb3 = $('#cvPush');
      pushBack(pb3 && pb3.getAttribute('data-force') === '1');
      return;
    }
    if(e.target.closest('#cvPng')){ openExport(); return; }
    if(e.target.closest('#cvShot')){ shotNow(); return; }
    if(e.target.closest('#cvGal')){ openGallery(); return; }
    if(e.target.closest('#galShotNow')){ shotNow(); return; }
    if(e.target.closest('#galGc')){ gcShots(); return; }
    if(e.target.closest('#cvModX7')){ $('#cvGalMod').hidden = true; return; }
    var gt = e.target.closest('[data-gal]');
    if(gt){ paintGallery(gt.getAttribute('data-gal')); return; }
    if(e.target.closest('#galOnly')){
      var ol = $('#galOnly');
      if(!ol || ol.disabled){ toast('先点开一讲，才能按讲次筛', true); return; }
      SHOTS.only = !SHOTS.only;
      paintGallery(SHOTS.subject);
      return;
    }
    /* 大图预览：点缩略图打开，点背景/关掉/Esc 收起 */
    if(e.target.closest('#galBigX') || e.target.closest('#galBigBd')){ closeBig(); return; }
    var big0 = e.target.closest('[data-shot]');
    if(big0){ openBig(big0.getAttribute('data-shot')); return; }
    if(e.target.closest('#galBigIn')){
      if(GALBIG){ pullShot(GALBIG.id, false); closeBig(); }
      return;
    }
    if(e.target.closest('#galBigNode')){
      if(GALBIG){ pullShot(GALBIG.id, true); closeBig(); }
      return;
    }
    /* 搜索：输入走防抖，回车立刻搜 */
    if(e.target.closest('#galQClr')){
      SHOTS.q = '';
      var qq0 = $('#galQ'); if(qq0) qq0.value = '';
      paintGallery(SHOTS.subject);
      return;
    }
    if(e.target.closest('#galGroup')){
      SHOTS.group = !SHOTS.group;
      paintGallery(SHOTS.subject);
      return;
    }
    var gh = e.target.closest('[data-galgrp]');
    if(gh){
      var gk = gh.getAttribute('data-galgrp');
      SHOTS.shut[gk] = !SHOTS.shut[gk];
      paintGallery(SHOTS.subject);
      return;
    }
    var ps = e.target.closest('[data-pullshot]');
    if(ps){ pullShot(ps.getAttribute('data-pullshot'), false); return; }
    var sn = e.target.closest('[data-shotnode]');
    if(sn){ pullShot(sn.getAttribute('data-shotnode'), true); return; }
    var ds = e.target.closest('[data-delshot]');
    if(ds){ delShotRow(ds.getAttribute('data-delshot')); return; }
    var rn = e.target.closest('[data-renshot]');
    if(rn){ renameShot(rn.getAttribute('data-renshot')); return; }
    var ta = e.target.closest('[data-tagadd]');
    if(ta){ tagShot(ta.getAttribute('data-tagadd')); return; }
    if(e.target.closest('[data-tagpick]')){
      pickTag(e.target.closest('[data-tagpick]').getAttribute('data-tagpick')); return;
    }
    var tf = e.target.closest('[data-tagf]');
    if(tf){
      var t1 = tf.getAttribute('data-tagf');
      SHOTS.tagF = (SHOTS.tagF === t1) ? '' : t1;
      paintGallery(SHOTS.subject);
      return;
    }
    var tr = e.target.closest('[data-tagrm]');
    if(tr){ untagShot(tr.getAttribute('data-tagrm'), tr.getAttribute('data-tagtxt')); return; }
    if(e.target.closest('#cvSearch')){
      var f0 = $('#cvFind'); openFind(f0.hidden);
      return;
    }
    if(e.target.closest('#cvFindX')){ openFind(false); return; }
    if(e.target.closest('#cvFindNext')){ gotoHit(FIND0 + 1); return; }
    if(e.target.closest('#cvFindPrev')){ gotoHit(FIND0 - 1); return; }
    if(e.target.closest('#cvToggleL')){ var L = $('#cvLeft'); L.hidden = !L.hidden; $('#cvToggleL').classList.toggle('on', !L.hidden); return; }
    if(e.target.closest('#cvToggleR')){ var R = $('#cvRight'); R.hidden = !R.hidden; $('#cvToggleR').classList.toggle('on', !R.hidden); return; }
    if(e.target.closest('#cvLayout')){ setLayout(M.layout === 'free' ? 'tree' : 'free'); return; }
    if(e.target.closest('#cvTheme')){ nextTheme(); return; }
    if(e.target.closest('#cvEdge')){ nextEdge(); return; }
    if(e.target.closest('#cvInsight')){ openInsight(); return; }
    if(e.target.closest('#cvKeys')){ openKeys(); return; }
    if(e.target.closest('#cvFit') || e.target.closest('#cvZoomFit')){
      glide(true); fitView(); setTimeout(function(){ glide(false); }, 240); return;
    }
    if(e.target.closest('#cvZoomIn')){
      glide(true); VIEW.scale = Math.min(2.2, VIEW.scale * 1.16); applyView();
      setTimeout(function(){ glide(false); }, 240); return;
    }
    if(e.target.closest('#cvZoomOut')){
      glide(true); VIEW.scale = Math.max(0.22, VIEW.scale / 1.16); applyView();
      setTimeout(function(){ glide(false); }, 240); return;
    }
    if(e.target.closest('#cvChild') || e.target.closest('#inspChild')){ addChild(); return; }
    if(e.target.closest('#cvSib') || e.target.closest('#inspSib')){ addSibling(); return; }
    if(e.target.closest('#inspDel')){ delNode(); return; }
    if(e.target.closest('#inspImg')){ openImage(); return; }
    var mkb = e.target.closest('[data-mk]');
    if(mkb && SEL){ e.preventDefault(); toggleMark(SEL, mkb.getAttribute('data-mk')); return; }
    var rml = e.target.closest('[data-rmlb]');
    if(rml && SEL){ e.preventDefault(); delLabel(SEL, rml.getAttribute('data-rmlb')); return; }
    if(e.target.closest('#inspLbGo') && SEL){
      var li = $('#inspLbIn');
      if(li){ addLabel(SEL, li.value); li.value = ''; }
      return;
    }
    if(e.target.closest('#cvImport')){ openImport(); return; }
    if(e.target.closest('#cvExport')){ exportMd(); return; }
    if(e.target.closest('#cvSrcs')){ openSources(); return; }

    var fold = e.target.closest('[data-fold]');
    if(fold){
      var fid = fold.getAttribute('data-fold');
      FOLD[fid] = FOLD[fid] ? 0 : 1;   /* 折叠只是本机视图，不落库 */
      render();
      return;
    }
    var ol = e.target.closest('[data-olid]');
    if(ol){ selectNode(ol.getAttribute('data-olid')); centerOn(ol.getAttribute('data-olid')); return; }

    var node = e.target.closest('.cvnode');
    if(node && !node.classList.contains('editing')){
      var nid = node.getAttribute('data-id');
      if(e.shiftKey || e.ctrlKey || e.metaKey){
        /* MSEL 装的是「完整选择集」，主选也在里面。
           第一次 Shift 前 MSEL 是空的，得先把当前主选补进来，
           否则这一下就把上一个节点丢了，永远只剩一个。 */
        if(!Object.keys(MSEL).length && SEL) MSEL[SEL] = 1;
        if(MSEL[nid]) delete MSEL[nid]; else MSEL[nid] = 1;
        SEL = MSEL[nid] ? nid : (Object.keys(MSEL)[0] || SEL);
        paintMsel();
        drawEdges();
        paintInspector();
        paintOutline();
      } else {
        clearMsel();
        selectNode(nid);
      }
      return;
    }
    if(e.target.closest('#cvModX')){ closeMod(); return; }
    if(e.target.closest('#cvMod')){ if(e.target.id === 'cvMod') closeMod(); return; }
  });

  /* 大纲双击 → 在画布里就地改这个节点（写回同一棵树，不是另开一个编辑器） */
  document.addEventListener('dblclick', function(e){
    var ol = e.target.closest('[data-olid]');
    if(ol){
      var oid = ol.getAttribute('data-olid');
      selectNode(oid);
      centerOn(oid);
      startEdit(oid);
      return;
    }
  });

  /* 大纲里点一下就选中（跟画布里点节点等价），后面 Tab/Enter/Del 才有作用对象 */
  document.addEventListener('focusin', function(e){
    var ol = e.target.closest && e.target.closest('[data-olid]');
    if(ol && !$('#cvwrap').hidden){
      var oid = ol.getAttribute('data-olid');
      if(SEL !== oid){ selectNode(oid); }
    }
  });

  /* 双击改字 */
  document.addEventListener('dblclick', function(e){
    if($('#cvwrap').hidden) return;
    var node = e.target.closest('.cvnode');
    if(node) startEdit(node.getAttribute('data-id'));
  });

  /* 画布拖动 / 缩放 */
  document.addEventListener('mousedown', function(e){
    if($('#cvwrap').hidden) return;
    var stage = e.target.closest('#cvStage');
    if(!stage) return;
    if(e.target.closest('.cvzoom') || e.target.closest('.fold') || e.target.closest('.cvfind')) return;
    var nd0 = e.target.closest('.cvnode');
    if(nd0){
      if(nd0.classList.contains('editing')) return;
      NDRAG = {id: nd0.getAttribute('data-id'), x: e.clientX, y: e.clientY, moved: false, over: null};
      return;
    }
    DRAG = {x: e.clientX, y: e.clientY, vx: VIEW.x, vy: VIEW.y};
    stage.classList.add('panning');
  });
  document.addEventListener('mousemove', function(e){
    if(NDRAG){
      var dx = e.clientX - NDRAG.x, dy = e.clientY - NDRAG.y;
      if(!NDRAG.moved && (Math.abs(dx) + Math.abs(dy) > 7)){
        NDRAG.moved = true;
        var src = document.querySelector('.cvnode[data-id="' + NDRAG.id + '"]');
        if(src) src.classList.add('dragging');
      }
      if(NDRAG.moved){
        /* 自由布局下拖节点 = 挪位置，不是换父级。两件事不能同时干，
           否则想微调一下位置就把节点挂到别人底下去了。 */
        if(M.layout === 'free'){
          var el0 = document.querySelector('.cvnode[data-id="' + NDRAG.id + '"]');
          var p0 = POS[NDRAG.id];
          if(el0 && p0){
            NDRAG.nx = p0.x + (e.clientX - NDRAG.x) / VIEW.scale;
            NDRAG.ny = p0.y + (e.clientY - NDRAG.y) / VIEW.scale;
            el0.style.left = Math.round(NDRAG.nx) + 'px';
            el0.style.top = Math.round(NDRAG.ny) + 'px';
            drawEdges();
          }
          NDRAG.over = null;
          return;
        }
        var under = document.elementFromPoint(e.clientX, e.clientY);
        var tg = under && under.closest ? under.closest('.cvnode') : null;
        [].slice.call(document.querySelectorAll('.cvnode.dropto')).forEach(function(x){
          x.classList.remove('dropto');
        });
        if(tg && tg.getAttribute('data-id') !== NDRAG.id){
          tg.classList.add('dropto');
          NDRAG.over = tg.getAttribute('data-id');
        } else {
          NDRAG.over = null;
        }
      }
      return;
    }
    if(!DRAG) return;
    VIEW.x = DRAG.vx + (e.clientX - DRAG.x);
    VIEW.y = DRAG.vy + (e.clientY - DRAG.y);
    applyView();
  });
  document.addEventListener('mouseup', function(){
    if(NDRAG){
      var d0 = NDRAG; NDRAG = null;
      [].slice.call(document.querySelectorAll('.cvnode.dragging,.cvnode.dropto')).forEach(function(x){
        x.classList.remove('dragging'); x.classList.remove('dropto');
      });
      if(M.layout === 'free'){
        if(d0.moved && typeof d0.nx === 'number'){
          var h0 = findNode(d0.id);
          if(h0){
            pushHist();
            h0.node.x = Math.round(d0.nx);
            h0.node.y = Math.round(d0.ny);
            render();
            scheduleSave();
          }
        }
        return;
      }
      if(d0.moved && d0.over) reparent(d0.id, d0.over);
      return;
    }
    if(DRAG){ DRAG = null; var s = $('#cvStage'); if(s) s.classList.remove('panning'); }
  });
  document.addEventListener('wheel', function(e){
    if($('#cvwrap').hidden) return;
    if(!e.target.closest('#cvStage')) return;
    e.preventDefault();
    glide(false);            // 滚轮要跟手，不能带过渡
    var st = $('#cvStage');
    var rect = st.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var k = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    var ns = Math.max(0.22, Math.min(2.2, VIEW.scale * k));
    VIEW.x = mx - (mx - VIEW.x) * (ns / VIEW.scale);
    VIEW.y = my - (my - VIEW.y) * (ns / VIEW.scale);
    VIEW.scale = ns;
    applyView();
  }, {passive: false});

  /* 检查器输入 */
  document.addEventListener('input', function(e){
    if($('#cvwrap').hidden) return;
    if(e.target.id === 'inspText' && SEL){
      var h = findNode(SEL); if(!h) return;
      if(!HISTPEND){ pushHist(); HISTPEND = true; }
      h.node.text = e.target.value;
      var el = document.querySelector('.cvnode[data-id="' + SEL + '"] .tx');
      if(el) el.innerHTML = mdLabel(h.node.text);
      var p = POS[SEL];
      if(p){ p.w = measure(h.node); var nd = document.querySelector('.cvnode[data-id="' + SEL + '"]');
        if(nd) nd.style.width = Math.round(p.w) + 'px'; }
      drawEdges(); paintOutline(); scheduleSave();
      return;
    }
    if(e.target.id === 'inspNote' && SEL){
      var h2 = findNode(SEL); if(!h2) return;
      if(!HISTPEND){ pushHist(); HISTPEND = true; }
      h2.node.note = e.target.value;
      var prev = $('#inspMd');
      if(prev) prev.innerHTML = e.target.value ? mdToHtml(e.target.value) : '<span class="sub">还没有备注</span>';
      scheduleSave();
      return;
    }
    if(e.target.id === 'cvFindIn'){ runFind(); return; }
    if(e.target.id === 'cvTitle'){
      M.title = e.target.value || '未命名画布';
      scheduleSave();
      return;
    }
  });

  document.addEventListener('focusout', function(e){
    if(!e.target || !e.target.id) return;
    if(e.target.id === 'inspText' || e.target.id === 'inspNote') HISTPEND = false;
  });

  document.addEventListener('change', function(e){
    /* 标签下拉：选中某个标签就按它筛（再选回「所有标签」= 取消） */
    if(e.target && e.target.id === 'galTagSel'){
      SHOTS.tagF = e.target.value || '';
      paintGallery(SHOTS.subject);
      return;
    }
    var sw = e.target.closest('[data-color]');
    if(sw && SEL){
      var h = findNode(SEL); if(!h) return;
      pushHist();
      h.node.color = sw.getAttribute('data-color');
      render(); selectNode(SEL); scheduleSave();
    }
  });

  /* 键盘 */
  document.addEventListener('keydown', function(e){
    if($('#cvwrap').hidden) return;
    /* 大图预览开着时，Esc 先收它，不该穿透到画布的 Esc（那个会退整张画布）。 */
    if(e.key === 'Escape' && GALBIG){ e.preventDefault(); closeBig(); return; }
    if(e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT'){
      if(e.target.id === 'cvFindIn'){
        if(e.key === 'Enter'){ e.preventDefault(); gotoHit(FIND0 + (e.shiftKey ? -1 : 1)); return; }
        if(e.key === 'Escape'){ e.preventDefault(); openFind(false); return; }
      }
      if(e.target.id === 'galQ'){
        if(e.key === 'Enter'){ e.preventDefault(); SHOTS.q = e.target.value.trim(); paintGallery(SHOTS.subject); return; }
        if(e.key === 'Escape'){ e.preventDefault(); e.target.blur(); return; }
      }
      if(e.key === 'Escape' && !e.target.closest('.cvnode')) e.target.blur();
      return;
    }
    var meta = e.ctrlKey || e.metaKey;
    if(meta && (e.key === 'z' || e.key === 'Z')){ e.preventDefault(); if(e.shiftKey) redo(); else undo(); return; }
    if(meta && (e.key === 'y' || e.key === 'Y')){ e.preventDefault(); redo(); return; }
    if(meta && (e.key === 'c' || e.key === 'C')){ e.preventDefault(); copySel(false); return; }
    if(meta && (e.key === 'x' || e.key === 'X')){ e.preventDefault(); copySel(true); return; }
    if(meta && (e.key === 'v' || e.key === 'V')){ e.preventDefault(); pasteClip(); return; }
    if(meta && (e.key === 'a' || e.key === 'A')){
      e.preventDefault();
      MSEL = {};
      walk(M.tree, function(n){ if(n.id !== M.tree.id) MSEL[n.id] = 1; });
      paintMsel();
      return;
    }
    if(meta && (e.key === 'f' || e.key === 'F')){ e.preventDefault(); openFind(true); return; }
    if(e.key === 'Tab'){ e.preventDefault(); addChild(); return; }
    if(e.key === 'Enter'){ e.preventDefault(); addSibling(); return; }
    if(e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); delSel(); return; }
    if(e.key === 'Escape'){ closeCanvas(); return; }
    if(e.key === 'Enter' && e.target && e.target.id === 'inspLbIn' && SEL){
      e.preventDefault(); addLabel(SEL, e.target.value); e.target.value = ''; return;
    }
    if(e.key === 'F2' && SEL){ e.preventDefault(); startEdit(SEL); return; }
    /* ? 键在没聚焦输入框的时候打开快捷键表（XMind 也是这个习惯） */
    if(e.key === '?' && !/^(INPUT|TEXTAREA)$/.test((e.target.tagName || ''))){
      e.preventDefault(); openKeys(); return;
    }
  });

  /* 右键菜单 */
  document.addEventListener('contextmenu', function(e){
    if($('#cvwrap').hidden) return;
    var node = e.target.closest('.cvnode');
    if(!node) return;
    e.preventDefault();
    selectNode(node.getAttribute('data-id'));
    var mn = $('#cvMenu');
    mn.innerHTML =
        '<button data-mn="child">加子节点<span class="k">Tab</span></button>'
      + '<button data-mn="sib">加同级<span class="k">Enter</span></button>'
      + '<button data-mn="edit">改文字<span class="k">F2</span></button>'
      + '<hr>'
      + '<button data-mn="copy">复制<span class="k">Ctrl+C</span></button>'
      + '<button data-mn="cut">剪切<span class="k">Ctrl+X</span></button>'
      + '<button data-mn="paste">粘贴成子节点<span class="k">Ctrl+V</span></button>'
      + '<button data-mn="img">插入图片</button>'
      + '<button data-mn="ins">联系线 / 外框 / 概要</button>'
      + '<button data-mn="lb">加个标签</button>'
      + '<hr>'
      + '<button data-mn="fold">折叠 / 展开</button>'
      + '<button data-mn="del">删除这个节点<span class="k">Del</span></button>';
    mn.style.left = e.clientX + 'px';
    mn.style.top = e.clientY + 'px';
    mn.hidden = false;
  });
  document.addEventListener('click', function(e){
    var mn = $('#cvMenu');
    if(!mn || mn.hidden) return;
    var b = e.target.closest('[data-mn]');
    if(!b){ mn.hidden = true; return; }
    var a = b.getAttribute('data-mn');
    mn.hidden = true;
    if(a === 'child') addChild();
    else if(a === 'sib') addSibling();
    else if(a === 'copy') copySel(false);
    else if(a === 'cut') copySel(true);
    else if(a === 'paste') pasteClip();
    else if(a === 'img') openImage();
    else if(a === 'ins') openInsight();
    else if(a === 'lb' && SEL){
      openMod('给节点加标签', '<div class="cvfl"><label>标签文字</label>'
        + '<input class="inp" id="lbTxt" placeholder="例如：重点 / 待背 / 明天问老师"></div>',
        '<button class="cvmini" id="lbGo">加上</button>');
      $('#lbGo').onclick = function(){ addLabel(SEL, $('#lbTxt').value); closeMod(); };
    }
    else if(a === 'edit' && SEL) startEdit(SEL);
    else if(a === 'fold' && SEL){ FOLD[SEL] = FOLD[SEL] ? 0 : 1; render(); }
    else if(a === 'del') delNode();
  });

  /* ---------------- 联系线 / 外框 / 概要 ---------------- */
  function openInsight(){
    ensureExtras();
    var ids = selIds();
    var ex = M.tree;
    var nb = ex.boundaries.length, nr = ex.relations.length, ns = ex.summaries.length;
    openMod('联系线 / 外框 / 概要',
      '<p class="sub" style="margin-bottom:10px">这三样都不动树结构，只往树旁边贴批注。'
      + '选中一个节点就能加外框；选中两个（Shift 点）才能拉联系线或做概要。</p>'
      + '<div class="cvrows">'
      + '<button class="cvrow" id="inRel"><b>联系线</b>'
        + '<span>把两个节点拉一根带名字的虚线</span><i>现有 ' + nr + '</i></button>'
      + '<button class="cvrow" id="inBox"><b>外框</b>'
        + '<span>框住这个节点连同它整棵子树</span><i>现有 ' + nb + '</i></button>'
      + '<button class="cvrow" id="inSum"><b>概要</b>'
        + '<span>把几个兄弟概括成一句话，贴在最右边</span><i>现有 ' + ns + '</i></button>'
      + '</div>'
      + (ids.length < 2
         ? '<p class="sub" style="margin-top:10px">现在选中 ' + ids.length
           + ' 个节点 —— 联系线和概要要选两个以上。</p>' : ''),
      '<button class="cvmini" id="cvModX7">关掉</button>');
    $('#cvModX7').onclick = closeMod;
    $('#inBox').onclick = function(){ askBoundary(ids); };
    $('#inRel').onclick = function(){ askRelation(ids); };
    $('#inSum').onclick = function(){ askSummary(ids); };
  }

  function askBoundary(ids){
    if(!ids.length){ toast('先在画布上点一个节点', true); return; }
    var id = ids[0];
    var hit = findNode(id);
    openMod('给「' + ((hit && hit.node.text) || '节点') + '」加外框',
      '<p class="sub" style="margin-bottom:10px">会把它连同下面所有子节点一起框起来。</p>'
      + '<label class="cvfl">框上的字（可以空着）</label>'
      + '<input class="cvin" id="bndName" placeholder="比如：句子成分三大块">'
      + '<label class="cvfl">颜色</label>'
      + '<div class="cvswatch" id="bndSW">'
      + ['#6FA8FF', '#3ED598', '#FFC042', '#FF5757', '#C084FC', '#FF8A45']
          .map(function(c){ return '<button class="cvsw" data-c="' + c
            + '" style="background:' + c + '"></button>'; }).join('')
      + '</div>',
      '<button class="cvmini" id="cvModX8">取消</button>'
      + '<button class="btn act sm" id="bndGo">加上去</button>');
    var pick = '#6FA8FF';
    $('#bndSW').onclick = function(e){
      var b = e.target.closest('[data-c]'); if(!b) return;
      pick = b.getAttribute('data-c');
      [].forEach.call($('#bndSW').children, function(x){ x.classList.toggle('on', x === b); });
    };
    $('#cvModX8').onclick = closeMod;
    $('#bndGo').onclick = function(){
      var nm = ($('#bndName').value || '').trim();
      pushHist();
      M.tree.boundaries.push({id: uid(), node: id, label: nm, color: pick});
      closeMod(); render(); scheduleSave();
      toast(nm ? '框好了：' + nm : '框好了');
    };
  }

  function askRelation(ids){
    if(ids.length < 2){ toast('先选两个节点：点一个，按住 Shift 再点一个', true); return; }
    var a = findNode(ids[0]), b = findNode(ids[1]);
    openMod('在「' + ((a && a.node.text) || '?') + '」和「' + ((b && b.node.text) || '?')
      + '」之间拉联系线',
      '<label class="cvfl">线上写什么</label>'
      + '<input class="cvin" id="relLb" placeholder="比如：都靠谓语动词带出来">',
      '<button class="cvmini" id="cvModX9">取消</button>'
      + '<button class="btn act sm" id="relGo">拉上去</button>');
    $('#cvModX9').onclick = closeMod;
    $('#relGo').onclick = function(){
      var lb = ($('#relLb').value || '').trim();
      pushHist();
      M.tree.relations.push({id: uid(), from: ids[0], to: ids[1], label: lb});
      closeMod(); render(); scheduleSave();
      toast('联系线拉好了');
    };
  }

  function askSummary(ids){
    var real = ids.filter(function(id){ return POS[id]; });
    if(real.length < 2){ toast('概要要框两个以上节点', true); return; }
    openMod('给这 ' + real.length + ' 个节点写概要',
      '<p class="sub" style="margin-bottom:10px">概要贴在它们右边，不改变树里谁是谁的子节点。</p>'
      + '<label class="cvfl">一句话概括</label>'
      + '<input class="cvin" id="sumTx" placeholder="比如：这三类都是名词性成分">',
      '<button class="cvmini" id="cvModX10">取消</button>'
      + '<button class="btn act sm" id="sumGo">加上去</button>');
    $('#cvModX10').onclick = closeMod;
    $('#sumGo').onclick = function(){
      var tx = ($('#sumTx').value || '').trim();
      if(!tx){ toast('写一句话再点', true); return; }
      pushHist();
      M.tree.summaries.push({id: uid(), ids: real.slice(), text: tx});
      closeMod(); render(); scheduleSave();
      toast('概要加好了');
    };
  }

  /* ---------------- 图标标记 / 标签 ---------------- */
  /* 图标一律用字符画出来的小方块，不用 emoji（项目铁律：emoji 不当功能图标）。
     pri1..pri5 是优先级，1 最高；flag/star/q/idea/done/warn 是其余六个常用标记。 */
  var MARKS = [
    { k:'pri1', n:'优先级 1', c:'#FF5757' },
    { k:'pri2', n:'优先级 2', c:'#FF8A45' },
    { k:'pri3', n:'优先级 3', c:'#FFC042' },
    { k:'pri4', n:'优先级 4', c:'#3ED598' },
    { k:'pri5', n:'优先级 5', c:'#6FA8FF' },
    { k:'flag', n:'旗子',   c:'#FF5757', ic:'i-mflag' },
    { k:'star', n:'星标',   c:'#FFC042', ic:'i-mstar' },
    { k:'q',    n:'疑问',   c:'#6FA8FF', ic:'i-mq' },
    { k:'idea', n:'灵感',   c:'#C084FC', ic:'i-midea' },
    { k:'done', n:'已完成', c:'#3ED598', ic:'i-mdone' },
    { k:'warn', n:'易错',   c:'#FF8A45', ic:'i-mwarn' }
  ];
  var MARKOF = {};
  MARKS.forEach(function(m){ MARKOF[m.k] = m; });

  function markHtml(k){
    var m = MARKOF[k]; if(!m) return '';
    var isPri = /^pri\d$/.test(k);
    var inner = isPri ? esc(k.slice(3))
      : (m.ic ? '<svg class="ic" style="width:11px;height:11px"><use href="#' + m.ic + '"/></svg>'
              : esc(m.g || '•'));
    return '<span class="mk' + (isPri ? ' pri' : '') + '" style="--mkc:' + m.c
      + '" title="' + esc(m.n) + '">' + inner + '</span>';
  }

  /* 优先级取最高的那个（数字最小），用来决定左侧竖条要不要亮 */
  function priOf(n){
    var best = 0;
    (n.mk || []).forEach(function(k){
      var m = /^pri(\d)$/.exec(k);
      if(m){ var v = parseInt(m[1], 10); if(!best || v < best) best = v; }
    });
    return best;
  }

  function toggleMark(id, k){
    var hit = findNode(id); if(!hit) return;
    var n = hit.node;
    n.mk = n.mk || [];
    var i = n.mk.indexOf(k);
    if(i < 0){
      /* 优先级是单选：挂 pri2 就把 pri1 摘掉，不会同时亮两个数字 */
      if(/^pri/.test(k)) n.mk = n.mk.filter(function(x){ return !/^pri/.test(x); });
      n.mk.push(k);
    } else {
      n.mk.splice(i, 1);
    }
    pushHist(); scheduleSave(); render();
  }

  function addLabel(id, txt){
    var hit = findNode(id); if(!hit) return;
    var v = String(txt || '').trim(); if(!v) return;
    var n = hit.node;
    n.lb = n.lb || [];
    if(n.lb.indexOf(v) < 0) n.lb.push(v);
    pushHist(); scheduleSave(); render();
  }

  function delLabel(id, txt){
    var hit = findNode(id); if(!hit) return;
    hit.node.lb = (hit.node.lb || []).filter(function(x){ return x !== txt; });
    pushHist(); scheduleSave(); render();
  }

  /* ---------------- 快捷键面板 ---------------- */
  var KEYS = [
    ['编辑', [
      ['双击', '改这个节点的字'], ['F2', '同上'],
      ['Tab', '加子节点'], ['Enter', '加同级'],
      ['Del / Backspace', '删掉选中的（可以多选）'],
      ['Ctrl+Z', '撤销'], ['Ctrl+Shift+Z / Ctrl+Y', '重做'],
      ['Ctrl+C / Ctrl+X', '复制 / 剪切'], ['Ctrl+V', '粘成子节点'],
      ['Esc', '退出编辑 / 关掉弹层']
    ]],
    ['选择与移动', [
      ['点一下', '选中'], ['Shift+点 / Ctrl+点', '加进选择（多选）'],
      ['Ctrl+A', '全选（不含根）'], ['拖节点', '换父级（树形布局下）'],
      ['拖节点', '挪位置（自由布局下）'], ['拖空白', '平移画布'],
      ['滚轮', '缩放'], ['Shift+滚轮', '左右平移']
    ]],
    ['找与看', [
      ['Ctrl+F', '搜节点'], ['Enter / Shift+Enter', '下一个 / 上一个'],
      ['Ctrl+0', '缩放到 100%'], ['适合屏幕按钮', '整张图塞进视口']
    ]],
    ['批注', [
      ['顶栏「概要」', '联系线 / 外框 / 概要'],
      ['右键节点', '同一套操作也在右键里']
    ]]
  ];

  function openKeys(){
    var body = KEYS.map(function(g){
      return '<div class="cvkeys-g"><b>' + g[0] + '</b>'
        + g[1].map(function(r){
            return '<div class="cvkeys-r"><kbd>' + esc(r[0]) + '</kbd><span>'
              + esc(r[1]) + '</span></div>';
          }).join('')
        + '</div>';
    }).join('');
    openMod('全部快捷键',
      '<div class="cvkeys-wrap">' + body + '</div>',
      '<button class="cvmini" id="cvModX11">关掉</button>');
    $('#cvModX11').onclick = closeMod;
  }

  /* 导入 / 导出 / 来源 */
  function openMod(title, bodyHtml, footHtml){
    $('#cvModT').textContent = title;
    $('#cvModB').innerHTML = bodyHtml;
    $('#cvModF').innerHTML = footHtml || '';
    $('#cvMod').hidden = false;
  }
  function closeMod(){ $('#cvMod').hidden = true; }

  function openImport(){
    openMod('从 Markdown 导入',
      '<p class="sub" style="margin-bottom:10px">标题层级做主干，缩进列表做分支，正文进节点备注。</p>'
      + '<textarea id="mdIn" placeholder="# 第二章 句子成分\n\n## 主语\n- 名词\n- 代词\n## 谓语\n- 动词"></textarea>',
      '<button class="cvmini" id="cvModX2">取消</button>'
      + '<button class="btn act sm" id="mdGo">转成画布</button>');
    $('#cvModX2').onclick = closeMod;
    $('#mdGo').onclick = function(){
      var text = ($('#mdIn') || {}).value || '';
      if(!text.trim()){ toast('还没粘内容', true); return; }
      ct('note_from_md', {text: text, title: M.title}, {
        onDone: function(r){
          if(!r || !r.ok){ toast('转换失败', true); return; }
          M.tree = r.data.tree;
          normalize(M.tree);
          closeMod();
          render(); fitView(); scheduleSave();
          toast('已转成 ' + r.data.nodes + ' 个节点');
        }
      });
    };
    setTimeout(function(){ var t = $('#mdIn'); if(t) t.focus(); }, 30);
  }

  function exportMd(){
    if(!M.tree) return;
    var out = [];
    (function rec(n, d){
      var pad = new Array(d + 1).join('  ');
      if(d === 0) out.push('# ' + (n.text || M.title));
      else out.push(pad + '- ' + (n.text || ''));
      if(n.note){
        var lines = String(n.note).split('\n');
        for(var i = 0; i < lines.length; i++){
          out.push(new Array(d + 2).join('  ') + (d === 0 ? '' : '  ') + lines[i]);
        }
      }
      var kids = n.children || [];
      for(var j = 0; j < kids.length; j++) rec(kids[j], d + 1);
    })(M.tree, 0);
    var txt = out.join('\n');
    openMod('导出 Markdown',
      '<p class="sub" style="margin-bottom:10px">复制走，或者用浏览器另存成 .md。</p>'
      + '<textarea id="mdOut" readonly>' + esc(txt) + '</textarea>',
      '<button class="cvmini" id="cvModX3">关闭</button><button class="btn act sm" id="mdCopy">复制</button>');
    $('#cvModX3').onclick = closeMod;
    $('#mdCopy').onclick = function(){
      var t = $('#mdOut'); t.removeAttribute('readonly'); t.select();
      try{ document.execCommand('copy'); toast('已复制'); }catch(e){ toast('复制失败，手动选一下', true); }
      t.setAttribute('readonly', 'readonly');
    };
  }

  /* 云端导图拉到本机：拉完存成一张 src='xmind' 的画布，并直接打开 */
  function pullXm(mapId, mapTitle){
    toast('正在从 XMind 拉「' + (mapTitle || mapId) + '」…');
    ct('note_pull_xmind', { map_id: mapId, lesson_id: SDX().currentLesson() || M.lesson,
      title: mapTitle }, {
      onDone: function(r){
        if(!r || !r.ok){
          toast('没拉下来：' + ((r && r.error) || '云端没给内容'));
          return;
        }
        closeMod();
        toast('已拉下来 · ' + (r.data.nodes || 0) + ' 个节点');
        openCanvas({ title: r.data.title, lesson: (SDX().currentLesson() || M.lesson),
          src: 'xmind', srcId: mapId });
        loadCards();
      }
    });
  }

  function openXmPane(host){
    ct('xmind_list_maps', {}, {
      onDone: function(r){
        var box = host || $('#cvModB');
        if(!box) return;
        var d = (r && r.ok && r.data) || {};
        if(r && !r.ok){
          box.insertAdjacentHTML('beforeend',
            '<div class="srcrow"><div><b>云端导图</b><div class="sub">'
            + esc((r.error || '拿不到云端列表')) + '</div></div>'
            + '<button class="cvmini" id="xmGoLogin">登录 XMind</button></div>');
          var b = $('#xmGoLogin');
          if(b) b.onclick = function(){ $('#xmTop').click(); };
          return;
        }
        var maps = d.maps || [];
        if(!maps.length){
          box.insertAdjacentHTML('beforeend',
            '<div class="srcrow"><div><b>云端导图</b><div class="sub">'
            + '这个 XMind 账号里还没有导图 —— 在 XMind 里建一张，再回来点「刷新」</div></div>'
            + '<button class="cvmini" id="xmRe">刷新</button></div>');
          var rb = $('#xmRe');
          if(rb) rb.onclick = function(){ rb.parentNode.remove(); openXmPane(box); };
          return;
        }
        var rows = maps.slice(0, 30).map(function(m){
          var id = m.id || m.mapId || m.mindmapId || '';
          var tt = m.title || m.name || '(无标题)';
          return '<div class="srcrow"><div><b>' + esc(tt) + '</b>'
            + '<div class="sub">' + esc(String(id).slice(0, 24)) + '</div></div>'
            + '<button class="cvmini" data-pull="' + esc(id) + '" data-pt="'
            + esc(tt) + '">拉到本机</button></div>';
        }).join('');
        box.insertAdjacentHTML('beforeend',
          '<div class="cvsep2">云端导图 · ' + maps.length + ' 张</div>' + rows);
        box.querySelectorAll('[data-pull]').forEach(function(b){
          b.onclick = function(){
            pullXm(b.getAttribute('data-pull'), b.getAttribute('data-pt'));
          };
        });
      }
    });
  }

  /* ---------------- 截图库 ----------------
     渲染成 png → 飞进右侧坞（截图动画）→ 落进当前学科的库。
     拉回来时直接插进选中节点（没有选中就插进根节点的备注）。
     png 由 buildSvg 出图，跟「导出 PNG」同一套画法，不是另画一份。 */
  var SHOTS = {list: [], subject: '', busy: false, only: false, q: '', group: false, shut: {}, tagF: '', tagsAll: []};
  var GALBIG = null;   // 大图预览当前那张（Esc 关掉时要知道关哪张）

  /* 「本讲」到底指哪一讲：画布挂着的那一讲优先 —— 用户可能是从截图库里
     翻出一张老画布在看，这时候按课堂页那讲的 id 去筛，筛出来是他没在看的东西。 */
  function curLid(){
    var own = (M && M.lesson) ? String(M.lesson) : '';
    if(own) return own;
    return (SDX().currentLesson ? String(SDX().currentLesson() || '') : '');
  }

  function curSubject(){
    try{ var f = SDX().subject; return (f && f()) || 'free'; }catch(e){ return 'free'; }
  }

  function svgToPngBlob(svg, cb){
    var img = new Image();
    img.onload = function(){
      var sc = 2;
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.width * sc);
      cv.height = Math.round(img.height * sc);
      var g = cv.getContext('2d');
      g.scale(sc, sc);
      var TH = THEMES[M.theme] || THEMES.dark;
      g.fillStyle = TH.bg;
      g.fillRect(0, 0, img.width, img.height);
      g.drawImage(img, 0, 0);
      if(cv.toBlob) cv.toBlob(function(b){ cb(b, cv.width, cv.height); }, 'image/png');
      else cb(null, 0, 0);
    };
    img.onerror = function(){ cb(null, 0, 0); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function blobToB64(b, cb){
    var fr = new FileReader();
    fr.onload = function(){ cb(String(fr.result || '')); };
    fr.onerror = function(){ cb(''); };
    fr.readAsDataURL(b);
  }

  /* 截图动画：一张纸从画布中间被「拍」下来 —— 闪光 → 缩成小卡 → 沿抛物线飞进右侧坞。
     动画只是给人看的，失败了也照样存，不能因为动画没跑起来就丢图。 */
  function flyShot(dataUrl, toEl, done){
    var fl = $('#shotFly'); if(!fl){ if(done) done(); return; }
    var p = $('#shotFlyP'), f = $('#shotFlyF'), t = $('#shotFlyT');
    var host = $('#cvwrap');
    var w = host ? host.getBoundingClientRect() : {left:0, top:0, width:1200, height:800};
    var tw = Math.min(300, Math.round(w.width * 0.34));
    var tx = Math.round(w.left + w.width / 2 - tw / 2);
    var ty = Math.round(w.top + w.height / 2 - tw * 0.34);
    fl.hidden = false;
    p.style.backgroundImage = 'url("' + dataUrl + '")';
    p.style.width = tw + 'px';
    p.style.height = Math.round(tw * 0.68) + 'px';
    p.style.left = tx + 'px';
    p.style.top = ty + 'px';
    p.style.transform = 'scale(1.06)';
    p.style.opacity = '0';
    f.style.opacity = '0';
    if(t){ t.textContent = '存进截图库…'; t.style.opacity = '0'; t.style.left = tx + 'px'; t.style.top = (ty + Math.round(tw * 0.68) + 12) + 'px'; }

    var dest = toEl ? toEl.getBoundingClientRect() : {left: w.left + w.width - 60, top: w.top + 200, width: 0, height: 0};
    var dx = dest.left + dest.width / 2 - tx - tw / 2;
    var dy = dest.top + dest.height / 2 - ty - tw * 0.34;

    requestAnimationFrame(function(){
      f.style.transition = 'opacity .1s'; f.style.opacity = '.85';
      p.style.transition = 'opacity .14s, transform .34s cubic-bezier(.2,.9,.2,1)';
      p.style.opacity = '1';
      p.style.transform = 'scale(1)';
      if(t){ t.style.transition = 'opacity .2s .12s'; t.style.opacity = '1'; }
      setTimeout(function(){
        f.style.transition = 'opacity .3s'; f.style.opacity = '0';
        p.style.transition = 'transform .62s cubic-bezier(.5,0,.6,1), opacity .62s, width .62s, height .62s';
        p.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.14) rotate(-6deg)';
        p.style.opacity = '.15';
        if(t){ t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }
        setTimeout(function(){
          fl.hidden = true;
          p.style.transition = ''; p.style.transform = ''; p.style.opacity = '';
          if(done) done();
        }, 650);
      }, 340);
    });
  }

  function shotNow(){
    if(SHOTS.busy){ toast('上一张还在存'); return; }
    var svg = buildSvg();
    if(!svg){ toast('画布是空的，没什么可截', true); return; }
    SHOTS.busy = true;
    svgToPngBlob(svg, function(b, w, h){
      if(!b){ SHOTS.busy = false; toast('截图失败：图没画出来', true); return; }
      blobToB64(b, function(d){
        var subj = curSubject();
        flyShot(d, $('#ndockTab'), function(){});
        ct('shot_save', {
          data: d, subject: subj, lesson_id: (curLid() || null),
          title: String(M.title || '未命名画布').slice(0, 40), w: w, h: h, tag: 'canvas'
        }, {onDone: function(r){
          SHOTS.busy = false;
          if(!r.ok){ toast('存失败：' + (r.error || '未知原因'), true); return; }
          var n = (r.data && r.data.count) || 0;
          var b2 = $('#cvGalN'); if(b2) b2.textContent = String(n);
          toast('已存进「' + SRCSUBJ(subj) + '」截图库 · 现在有 ' + n + ' 张');
          if(!$('#cvGalMod').hidden) paintGallery(subj);
        }});
      });
    });
  }

  var SUBJNAME = {english: '英语', math: '高数', cs: '计算机', politics: '政治', clang: 'C 语言', free: '未分科'};
  function SRCSUBJ(k){ return SUBJNAME[k] || k || '未分科'; }

  function loadGallery(subject, cb){
    var q = {subject: subject || '', limit: 120};
    if(SHOTS.q) q.q = SHOTS.q;
    /* 「只看本讲」靠后端 lesson_id 过滤，不在前端筛 —— 前端筛会把 limit 之外的那截漏掉。 */
    if(SHOTS.only){
      var lidA = curLid();
      if(lidA) q.lesson_id = lidA;
    }
    /* 标签筛选走关键词交给后端搜（tags 也在 LIKE 里），不在前端二次过滤 ——
       前端筛会把 limit 之外那截漏掉。只有没在打字时才接管 q。 */
    if(SHOTS.tagF && !SHOTS.q) q.q = SHOTS.tagF;
    ct('shot_list', q, {onDone: function(r){
      if(!r.ok){ if(cb) cb([]); return; }
      SHOTS.list = (r.data && r.data.shots) || [];
      SHOTS.subject = (r.data && r.data.subject) || '';
      SHOTS.tagsAll = (r.data && r.data.tags) || [];
      if(cb) cb(SHOTS.list);
    }});
  }

  /* 一张图上的标签胶囊 + 「＋标签」。点标签本身 = 按它筛；
     后面的 × 是摘掉这一条。 */
  function galTagsHtml(r){
    var ts = r.tags || [];
    return '<div class="galtags">'
      + ts.map(function(t){
          return '<span class="galtag"><button data-tagf="' + esc(t) + '" title="只看带「' + esc(t) + '」的图">'
            + esc(t) + '</button><button class="galtagx" data-tagrm="' + esc(r.id) + '" data-tagtxt="' + esc(t) + '"'
            + ' title="摘掉这个标签">×</button></span>';
        }).join('')
      + '<button class="galtagadd" data-tagadd="' + esc(r.id) + '" title="给这张图打标签">＋标签</button>'
      + '</div>';
  }

  /* 标签筛选下拉。选项来自后端汇总，不编；一个标签都没有时整个藏起来，
     别摆一个只有「所有标签」的空控件。 */
  function paintTagFilter(){
    var w = $('#galTagSel'); if(!w) return;
    var tags = SHOTS.tagsAll || [];
    if(!tags.length){
      w.innerHTML = '';
      w.hidden = true;
      return;
    }
    w.hidden = false;
    w.innerHTML = '<option value="">所有标签</option>'
      + tags.map(function(o){
          return '<option value="' + esc(o.tag) + '"' + (SHOTS.tagF === o.tag ? ' selected' : '') + '>'
            + esc(o.tag) + '（' + o.n + '）</option>';
        }).join('');
    w.value = SHOTS.tagF || '';
  }

  function findShot(id){
    var row = null;
    (SHOTS.list || []).forEach(function(r){ if(r.id === id) row = r; });
    return row;
  }

  /* 改名走小弹层，不就地 input —— 相册是重画驱动的，就地 input 一重画就丢焦点。 */
  function renameShot(id){
    var row = findShot(id);
    if(!row){ toast('库里找不到这张', true); return; }
    openMod('给这张图改个名字',
      '<p class="sub" style="margin-bottom:10px">只改名字，不动图片。清空就退回「未命名」。</p>'
      + '<input class="cvin" id="renIn" value="' + esc(row.title || '') + '" placeholder="例如：定语从句三条例外">',
      '<button class="cvmini" id="cvModX21">取消</button>'
      + '<button class="btn act sm" id="renGo">改名</button>');
    var inp = $('#renIn');
    if(inp){ inp.focus(); inp.select(); }
    $('#cvModX21').onclick = closeMod;
    var go = function(){
      var v = ($('#renIn') || {}).value || '';
      ct('shot_rename', {id: id, title: v}, {onDone: function(r){
        if(!r || !r.ok){ toast('改名失败：' + ((r && r.error) || '未知原因'), true); return; }
        closeMod();
        toast(v.trim() ? ('改好了：' + v.trim()) : '名字清掉了');
        if(GALBIG && GALBIG.id === id){
          GALBIG.title = v.trim();
          var bt = $('#galBigT'); if(bt) bt.textContent = v.trim() || '未命名';
        }
        paintGallery(SHOTS.subject);
      }});
    };
    $('#renGo').onclick = go;
    if(inp) inp.onkeydown = function(e){ if(e.key === 'Enter'){ e.preventDefault(); go(); } };
  }

  function tagShot(id){
    var row = findShot(id);
    if(!row){ toast('库里找不到这张', true); return; }
    openMod('给这张图打标签',
      '<p class="sub" style="margin-bottom:10px">多个标签用逗号隔开。相册顶部的标签筛选就靠它。</p>'
      + '<input class="cvin" id="tagIn" value="' + esc((row.tags || []).join('，')) + '" placeholder="例如：必背，易错">'
      + '<div class="cvhint2" id="tagPickWrap"></div>',
      '<button class="cvmini" id="cvModX22">取消</button>'
      + '<button class="btn act sm" id="tagGo">存下</button>');
    /* 已经出现过的标签做成快捷胶囊，省得每次手打 */
    var pw = $('#tagPickWrap');
    if(pw && (SHOTS.tagsAll || []).length){
      pw.innerHTML = '这个库已有的：' + SHOTS.tagsAll.map(function(o){
        return '<button class="galtagadd" data-tagpick="' + esc(o.tag) + '">' + esc(o.tag) + '</button>';
      }).join(' ');
    }
    var inp = $('#tagIn');
    if(inp){ inp.focus(); inp.select(); }
    $('#cvModX22').onclick = closeMod;
    var go = function(){
      var v = ($('#tagIn') || {}).value || '';
      var arr = v.split(/[,，;；\s]+/).filter(function(x){ return !!x; });
      ct('shot_tag', {id: id, tags: arr}, {onDone: function(r){
        if(!r || !r.ok){ toast('打标签失败：' + ((r && r.error) || '未知原因'), true); return; }
        closeMod();
        toast(arr.length ? ('标签存好了：' + arr.join('、')) : '标签清掉了');
        if(GALBIG && GALBIG.id === id) GALBIG.tags = arr;
        paintGallery(SHOTS.subject);
      }});
    };
    $('#tagGo').onclick = go;
    if(inp) inp.onkeydown = function(e){ if(e.key === 'Enter'){ e.preventDefault(); go(); } };
  }

  /* 快捷胶囊：把那个标签补进输入框（已在不重复加） */
  function pickTag(txt){
    var inp = $('#tagIn'); if(!inp) return;
    var cur = inp.value.split(/[,，;；\s]+/).filter(function(x){ return !!x; });
    if(cur.indexOf(txt) < 0) cur.push(txt);
    inp.value = cur.join('，');
    inp.focus();
  }

  /* 摘掉一个标签：拿这张图现有的标签减去这个，整份写回去 */
  function untagShot(id, txt){
    var row = findShot(id);
    if(!row) return;
    var arr = (row.tags || []).filter(function(t){ return t !== txt; });
    ct('shot_tag', {id: id, tags: arr}, {onDone: function(r){
      if(!r || !r.ok){ toast('摘标签失败', true); return; }
      toast('摘掉了「' + txt + '」');
      if(GALBIG && GALBIG.id === id) GALBIG.tags = arr;
      paintGallery(SHOTS.subject);
    }});
  }

  function paintGallery(subject){
    loadGallery(subject, function(rows){
      var g = $('#galGrid'); if(!g) return;
      var tabs = $('#galTabs');
      if(tabs){
        var subs = ['', 'english', 'math', 'cs', 'politics', 'clang'];
        var lidB = curLid();
        tabs.innerHTML = subs.map(function(k){
          var on = (k === (SHOTS.subject || '')) ? ' on' : '';
          return '<button class="galtab' + on + '" data-gal="' + k + '">'
            + (k ? SRCSUBJ(k) : '全部') + '</button>';
        }).join('')
          + '<span class="galsep"></span>'
          + '<button class="galtab' + (SHOTS.only ? ' on' : '') + '" id="galOnly"'
          + (lidB ? '' : ' disabled')
          + ' title="' + (lidB ? ('只列挂在这一讲（' + esc(lidB) + '）上的截图') : '还没打开讲次，先点开一讲')
          + '">只看本讲</button>';
      }
      var sub = $('#galSub');
      if(sub){
        var lidC = curLid();
        sub.textContent = (SHOTS.subject ? SRCSUBJ(SHOTS.subject) : '全部学科')
          + (SHOTS.only && lidC ? (' · 只看本讲（' + lidC + '）') : '')
          + ' · ' + rows.length + ' 张';
      }
      /* 搜索框与分组开关的显隐/状态跟着当前列表走（重画时会重建，不能靠初始 DOM） */
      var qi = $('#galQ');
      if(qi && qi.value !== SHOTS.q) qi.value = SHOTS.q;
      paintTagFilter();
      var gc = $('#galGroup');
      if(gc) gc.classList.toggle('on', !!SHOTS.group);

      if(!rows.length){
        g.innerHTML = '<div class="galempty">'
          + (SHOTS.q ? ('没搜到「' + esc(SHOTS.q) + '」相关的截图。清掉搜索词看看。')
                     : '这个库还是空的。在画布上点「存进截图库」，或者用下面的「现在截一张」。')
          + '</div>';
      } else if(SHOTS.group){
        /* 按讲次分组：同一讲的图折成一组。组头写讲次标题（后端的 lesson_title），
           拿不到标题就退回 id —— 不编一个假名字上去。 */
        var order = [], byKey = {};
        rows.forEach(function(r){
          var k = r.lesson_id || '';
          if(!byKey[k]){ byKey[k] = []; order.push(k); }
          byKey[k].push(r);
        });
        g.innerHTML = order.map(function(k){
          var arr = byKey[k];
          var shut = !!SHOTS.shut[k];
          var ttl = k ? (arr[0].lesson_title || k) : '没挂讲次的图';
          return '<div class="galgrp' + (shut ? ' shut' : '') + '">'
            + '<button class="galgrph" data-galgrp="' + esc(k) + '">'
            + '<svg class="ic galchev"><use href="#i-chev"/></svg>'
            + '<b>' + esc(ttl) + '</b>'
            + '<span class="galgrpn">' + arr.length + ' 张</span>'
            + (k ? '<span class="galgrpid">' + esc(k) + '</span>' : '')
            + '</button>'
            + '<div class="galgrpk">' + arr.map(function(r){
                return '<div class="galcell" data-galcell="' + esc(r.id) + '">'
                  + '<button class="galimg" data-shot="' + esc(r.id) + '" title="点开看大图">'
                  + '<img src="' + esc(r.url) + '" alt="' + esc(r.title || '截图') + '" loading="lazy">'
                  + '</button>'
                  + '<div class="galmeta"><button class="galname" data-renshot="' + esc(r.id) + '" title="点一下改名">'
                  + esc(r.title || '未命名') + '</button>'
                  + '<span>' + esc(r.age || '') + ' · ' + Math.max(1, Math.round((r.bytes || 0) / 1024)) + 'KB</span></div>'
                  + galTagsHtml(r)
                  + '<div class="galacts">'
                  + '<button class="cvmini" data-pullshot="' + esc(r.id) + '">插进选中节点</button>'
                  + '<button class="cvmini" data-shotnode="' + esc(r.id) + '">挂成新节点</button>'
                  + '<button class="cvmini" data-delshot="' + esc(r.id) + '" title="只从库里摘掉，盘上的图不删">移出</button>'
                  + '</div></div>';
              }).join('') + '</div></div>';
        }).join('');
      } else {
        g.innerHTML = rows.map(function(r){
          return '<div class="galcell" data-galcell="' + esc(r.id) + '">'
            + '<button class="galimg" data-shot="' + esc(r.id) + '" title="点开看大图">'
            + '<img src="' + esc(r.url) + '" alt="' + esc(r.title || '截图') + '" loading="lazy">'
            + '</button>'
            + '<div class="galmeta"><button class="galname" data-renshot="' + esc(r.id) + '" title="点一下改名">'
            + esc(r.title || '未命名') + '</button>'
            + '<span>' + esc(r.age || '') + ' · ' + Math.max(1, Math.round((r.bytes || 0) / 1024)) + 'KB</span></div>'
            + galTagsHtml(r)
            + '<div class="galacts">'
            + '<button class="cvmini" data-pullshot="' + esc(r.id) + '">插进选中节点</button>'
            + '<button class="cvmini" data-shotnode="' + esc(r.id) + '" title="在当前选中的节点下面挂一个新的图片节点">挂成新节点</button>'
            + '<button class="cvmini" data-delshot="' + esc(r.id) + '" title="只从库里摘掉，盘上的图不删">移出</button>'
            + '</div></div>';
        }).join('');
      }
      var foot = $('#galFoot');
      if(foot) foot.textContent = '截图存在本机 data/shots/ 下，按学科分文件夹';
    });
  }

  /* 缩略图点开看大图。原来 data-shot 是个死按钮 —— 点了什么都不发生，
     这违反本项目「不许有死按钮」的规矩。 */
  function openBig(id){
    var row = null;
    for(var i = 0; i < SHOTS.list.length; i++){ if(SHOTS.list[i].id === id) row = SHOTS.list[i]; }
    if(!row){ toast('库里找不到这张', true); return; }
    GALBIG = row;
    var w = $('#galBig'), bd = $('#galBigBd');
    if(!w || !bd) return;
    var im = $('#galBigImg');
    if(!im){
      im = document.createElement('img');
      im.id = 'galBigImg';
      im.alt = '截图大图';
      bd.appendChild(im);
    }
    im.src = row.url;
    im.alt = row.title || '截图';
    var t = $('#galBigT');
    if(t){
      t.textContent = row.title || '未命名';
      t.setAttribute('data-renshot', row.id);
      t.title = '点一下改名';
    }
    var tb = $('#galBigTags'); if(tb) tb.innerHTML = galTagsHtml(row);
    var m = $('#galBigM');
    if(m){
      m.textContent = (row.w && row.h ? (row.w + '×' + row.h + ' · ') : '')
        + Math.max(1, Math.round((row.bytes || 0) / 1024)) + 'KB · '
        + (row.lesson_id || '没挂讲次') + (row.ts ? (' · ' + row.ts) : '');
    }
    w.hidden = false;
  }
  function closeBig(){
    var w = $('#galBig'); if(w) w.hidden = true;
    /* 收紧：把 img 一起摘掉，别留一个没 src 的空 <img> 在 DOM 里 */
    var im = $('#galBigImg');
    if(im && im.parentNode) im.parentNode.removeChild(im);
    GALBIG = null;
  }

  /* 清磁盘：默认只统计。第一次点先把账单摊开给人看，第二次点才真删 ——
     删盘不可逆，不能一次点击就干完。 */
  function gcShots(){
    var armed = $('#galGc') && $('#galGc').getAttribute('data-armed') === '1';
    ct('shot_gc', {dry_run: !armed}, {onDone: function(r){
      if(!r.ok){ toast('清磁盘失败：' + (r.error || '未知原因'), true); return; }
      var d = r.data || {};
      var mb = function(n){ return (Math.round((n || 0) / 1024 / 10.2) / 100) + 'MB'; };
      var b = $('#galGc');
      if(b) b.removeAttribute('data-armed');
      if(d.dry_run){
        if(!d.orphans){
          toast('磁盘很干净：' + d.files + ' 张图全都有记录引用');
          return;
        }
        var b2 = $('#galGc');
        if(b2){ b2.setAttribute('data-armed', '1'); b2.textContent = '确认清掉 ' + d.orphans + ' 张'; }
        toast((d.warn ? (d.warn + ' ') : '')
          + '没有被引用的 ' + d.orphans + ' 张，共 ' + mb(d.orphan_bytes)
          + '。再点一次才真删', true);
        return;
      }
      if(b) b.textContent = '清磁盘';
      toast('已删 ' + d.deleted + ' 个没被引用的文件，' + (d.failed ? ('失败 ' + d.failed + ' 个') : '没有失败'));
      paintGallery(SHOTS.subject);
      loadShotCount();
    }});
  }

  /* 顶栏截图库角标：跟当前学科的库对齐 */
  function loadShotCount(){
    ct('shot_list', {subject: curSubject(), limit: 1}, {onDone: function(r){
      if(!r.ok) return;
      var n = (r.data && r.data.total) || 0;
      var b = $('#cvGalN'); if(b) b.textContent = String(n);
    }});
  }

  function openGallery(){
    var m = $('#cvGalMod');
    if(!m) return;
    closeBig();
    m.hidden = false;
    paintGallery(SHOTS.subject || curSubject());
  }

  /* 把一张截图插进画布。选中了节点就插那个，没选中就插根节点的备注 —— 
     不硬塞一个「图片节点」出来，因为那会改掉用户自己搭的结构。 */
  function pullShot(id, asNode){
    var row = null;
    for(var i = 0; i < SHOTS.list.length; i++){ if(SHOTS.list[i].id === id) row = SHOTS.list[i]; }
    if(!row){ toast('库里找不到这张', true); return; }
    var target = SEL || (M.tree && M.tree.id);
    var h = target ? findNode(target) : null;
    if(!h){ toast('画布还没打开', true); return; }
    pushHist();
    var md = '![' + (row.title || '截图') + '](' + row.url + ')';
    if(asNode){
      /* 挂成新节点：给用户一个真能拖、能改字、能换父级的节点，
         而不是把图片塞进别人的字里。 */
      var nid = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var kid = {id: nid, text: md, children: []};
      if(!h.node.children) h.node.children = [];
      h.node.children.push(kid);
      FOLD[h.node.id] = 0;
      render(); selectNode(nid); centerOn(nid); scheduleSave();
      toast('挂成新节点「' + (row.title || '截图') + '」');
      return;
    }
    if(h.node.id === (M.tree && M.tree.id)){
      h.node.note = (h.node.note ? h.node.note + '\n\n' : '') + md;
    } else {
      h.node.text = (h.node.text ? h.node.text + ' ' : '') + md;
    }
    render(); if(SEL) selectNode(SEL); scheduleSave();
    toast('已拉进「' + (plainText(h.node.text) || '根节点') + '」');
  }

  function delShotRow(id){
    ct('shot_del', {id: id}, {onDone: function(r){
      if(!r.ok){ toast('移出失败：' + (r.error || '未知原因'), true); return; }
      paintGallery(SHOTS.subject);
      toast('已从库里移出');
    }});
  }

  /* ---------------- 笔记来源 ----------------
     这条路是「把别处记的笔记拿进来」。状态全部来自后端真查（note_sources），
     前端不自己判断「应该能连」—— 没填就是没填，填错了就把错因原样显示。 */
  /* 只有文件夹类来源能整库导入 —— 云端来源的接口不给全量列表，
     点了也是编的。这个表要跟后端 notesrc.FILE_SRCS 保持一致。 */
  var FILESRC = {obsidian: 1, logseq: 1, opml: 1, markdown: 1};
  var SRCUI = {open: '', cfg: '', busy: false};

  var SRCNAME = {local: '本地画布', xmind: 'XMind', markdown: 'Markdown',
                 obsidian: 'Obsidian', logseq: 'Logseq', opml: 'OPML',
                 joplin: 'Joplin', notion: 'Notion', yuque: '语雀', wolai: '我来 wolai'};

  function srcRows(list){
    return list.map(function(s){
      var id = s.id || '';
      var st = s.connected ? 'ok' : (s.ready ? 'wait' : 'off');
      var canOpen = !!s.connected && id !== 'local';
      var btn = '';
      if(id === 'local'){
        btn = '<span class="srcdot">正在用</span>';
      }else if(id === 'xmind'){
        btn = s.connected
          ? '<button class="cvmini" id="srcOpenXm">打开</button>'
          : '<button class="cvmini" id="srcLoginXm">登录</button>';
      }else if(canOpen){
        btn = '<button class="cvmini" id="srcOpen" data-src="' + esc(id) + '">打开</button>';
        /* 文件夹类来源可以整库导入：一条条点太慢，也给个一次扫完的入口。
           云端来源（api 类）没有这条路 —— 接口不给全量，点了也是编的。 */
        if(FILESRC[id]){
          btn += '<button class="cvmini" id="srcImportAll" data-src="' + esc(id)
               + '" title="把这个库里上次之后改过的笔记一次导进来">整库导入</button>';
        }
      }else{
        btn = '<button class="cvmini" id="srcCfg" data-src="' + esc(id) + '">设置</button>';
      }
      return '<div class="srcrow" data-srcrow="' + esc(id) + '">'
        + '<div class="srcmain"><b>' + esc(s.name || id) + '</b>'
        + '<div class="sub">' + esc(s.how || '') + '</div>'
        + (s.state ? '<div class="srcst ' + st + '">' + esc(s.state) + '</div>' : '')
        + '</div>' + btn + '</div>';
    }).join('');
  }

  /* 一个来源的设置表单：字段名和提示都由后端 HINTS 给，前端不硬编码 */
  function srcCfgHtml(id, hint, cfg){
    hint = hint || {};
    cfg = cfg || {};
    var field = hint.field || 'path';
    var isTok = field === 'token';
    var cur = isTok ? (cfg.token ? '' : '') : (cfg.path || '');
    var ph = hint.eg || '';
    return '<div class="srccfg" id="srcCfgBox" data-cfgfor="' + esc(id) + '">'
      + '<div class="srclb">' + esc(hint.label || (isTok ? 'Token' : '路径')) + '</div>'
      + '<input class="cvin" id="srcIn" ' + (isTok ? 'type="password" ' : '')
      + 'placeholder="' + esc(ph) + '"'
      + (cur ? ' value="' + esc(cur) + '"' : '') + '>'
      + '<div class="srchelp">' + esc(hint.help || '') + '</div>'
      + (isTok && cfg.token ? '<div class="srchelp">已经存过一个 token（不回显）。重新填会覆盖。</div>' : '')
      + '<div class="srcacts">'
      + (id === 'joplin' && !cfg.token
          ? '<button class="cvmini" id="srcProbe">先自动找一下</button>' : '')
      + '<button class="cvmini" id="srcSave">保存并测试</button>'
      + '<button class="cvmini" id="srcCancel">取消</button>'
      + (cfg.path || cfg.token ? '<button class="cvmini warn" id="srcClear">清掉</button>' : '')
      + '</div><div class="srcmsg" id="srcMsg"></div></div>';
  }

  /* Joplin 是唯一不用第三方账号就能真连的云端来源：桌面版挂着本地服务就能读。
     先探一次，探到就直接把地址填好、并在提示里写清版本号，
     用户只剩「把 token 粘进来」这一步。 */
  function srcProbe(box){
    var msg = $('#srcMsg');
    if(msg){ msg.textContent = '正在扫本机端口…'; msg.className = 'srcmsg'; }
    ct('note_src_probe', {src: 'joplin'}, {
      onDone: function(r){
        var d = (r && r.data) || {};
        var m2 = $('#srcMsg');
        if(!m2) return;
        if(d.ok){
          m2.textContent = (d.note || '探到了') + '。现在把 token 填进上面那个框。';
          m2.className = 'srcmsg good';
          /* 探到的 base 已经写进配置了，重开弹层会把状态刷新成「地址有了」 */
          SRCUI.cfgs.joplin = {base: d.base};
        } else {
          m2.textContent = (d.error || '没探到') + (d.tried && d.tried.length
            ? '（试过：' + d.tried.join('、') + '）' : '');
          m2.className = 'srcmsg bad';
        }
      }
    });
  }

  function paintSources(host){
    var box = host || $('#cvModB');
    if(!box) return;
    ct('note_sources', {}, {
      onDone: function(r){
        if(!r || !r.ok){
          box.innerHTML = '<p class="sub">拿不到来源列表：'
            + esc((r && r.error) || '后端没回话') + '</p>';
          return;
        }
        var d = r.data || {};
        var list = d.sources || [];
        SRCUI.hints = {};
        list.forEach(function(s){ SRCUI.hints[s.id] = s.hint || {}; });
        SRCUI.cfgs = {};
        list.forEach(function(s){ SRCUI.cfgs[s.id] = s.cfg || {}; });
        SRCUI.list = list;
        var nOk = (d.ready || []).length;
        box.innerHTML =
          '<p class="sub srcintro">' + esc(d.note || '') + '</p>'
          + '<div class="srcgrid">' + srcRows(list) + '</div>'
          + '<div class="srclist" id="srcListBox" hidden></div>';
        bindSources(box);
      }
    });
  }

  function bindSources(box){
    box.onclick = function(e){
      var t = e.target;
      if(t.closest('#srcLoginXm')){ closeMod(); setTimeout(function(){ $('#xmTop').click(); }, 60); return; }
      if(t.closest('#srcOpenXm')){ srcOpenXm(box); return; }
      var ia = t.closest('#srcImportAll');
      if(ia){ srcImportAll(ia.getAttribute('data-src'), box); return; }
      var ob = t.closest('#srcOpen');
      if(ob){ srcOpenList(ob.getAttribute('data-src'), box); return; }
      var cb = t.closest('#srcCfg');
      if(cb){ srcShowCfg(cb.getAttribute('data-src'), box); return; }
      if(t.closest('#srcProbe')){ srcProbe(box); return; }
      if(t.closest('#srcCancel')){ var c = $('#srcCfgBox'); if(c) c.remove(); SRCUI.cfg = ''; return; }
      if(t.closest('#srcClear')){ srcSaveCfg(true, box); return; }
      if(t.closest('#srcSave')){ srcSaveCfg(false, box); return; }
      var om = t.closest('[data-openmap]');
      if(om){
        var mid = om.getAttribute('data-openmap');
        closeMod();
        openCanvas({ mapId: mid });
        return;
      }
      var pb = t.closest('[data-pullsrc]');
      if(pb){ srcPull(pb.getAttribute('data-pullsrc'), pb.getAttribute('data-pullsrc-t'), box); return; }
      var gb = t.closest('[data-gosrc]');
      if(gb){ SRCUI.cfg = gb.getAttribute('data-gosrc'); srcShowCfg(SRCUI.cfg, box); return; }
    };
  }

  function srcShowCfg(id, box){
    var old = $('#srcCfgBox'); if(old) old.remove();
    var row = box.querySelector('[data-srcrow="' + id + '"]');
    if(!row) return;
    SRCUI.cfg = id;
    row.insertAdjacentHTML('afterend', srcCfgHtml(id, (SRCUI.hints || {})[id], (SRCUI.cfgs || {})[id]));
    var inp = $('#srcIn'); if(inp) inp.focus();
    /* Enter 直接提交 —— 填路径这件事没人想再去点按钮 */
    if(inp) inp.onkeydown = function(ev){
      if(ev.key === 'Enter'){ ev.preventDefault(); srcSaveCfg(false, box); }
      if(ev.key === 'Escape'){ var c = $('#srcCfgBox'); if(c) c.remove(); }
    };
  }

  function srcSaveCfg(clear, box){
    var id = SRCUI.cfg;
    if(!id) return;
    var inEl = $('#srcIn');
    var hint = (SRCUI.hints || {})[id] || {};
    var val = clear ? '' : (inEl ? String(inEl.value || '').trim() : '');
    if(!clear && !val){ toast('还没填东西', true); return; }
    var msg = $('#srcMsg');
    if(msg){ msg.textContent = clear ? '正在清掉…' : '正在存并测试…'; msg.className = 'srcmsg'; }
    var args = {src: id, clear: !!clear};
    if(!clear){
      if((hint.field || 'path') === 'token') args.token = val;
      else args.path = val;
    }
    ct('note_src_cfg', args, {
      onDone: function(r){
        if(!r || !r.ok){
          if(msg){ msg.textContent = (r && r.error) || '存不进去'; msg.className = 'srcmsg bad'; }
          return;
        }
        /* 存完立刻真连一次，把结果写回同一行，不用关弹层重开 */
        ct('note_src_test', {src: id}, {
          onDone: function(t){
            var tt = (t && t.data) || {};
            var box2 = $('#cvModB');
            if(msg){
              msg.textContent = (tt.ok ? '连上了 · ' : '还没通 · ')
                + ((tt.note || tt.error || tt.state) || '');
              msg.className = 'srcmsg' + (tt.ok ? ' good' : ' bad');
            }
            if(tt.ok){
              setTimeout(function(){ closeMod(); openSources(); }, 700);
            }
          }
        });
      }
    });
  }

  function srcOpenList(id, box){
    var lb = box.querySelector('#srcListBox');
    if(!lb) return;
    lb.hidden = false;
    lb.setAttribute('data-for', id);
    SRCUI.open = id;
    lb.innerHTML = '<div class="srcmsg">正在列「' + esc(SRCNAME[id] || id) + '」…</div>';
    ct('note_src_list', {src: id}, {
      onDone: function(r){
        if(!r || !r.ok){
          lb.innerHTML = '<div class="srcmsg bad">' + esc((r && r.error) || '列不出来')
            + '</div>' + ((r && r.hint)
              ? '<div class="srcacts"><button class="cvmini" data-gosrc="' + esc(id)
                + '">去设置</button></div>' : '');
          return;
        }
        var d = r.data || {};
        var items = d.items || [];
        if(!items.length){
          lb.innerHTML = '<div class="srcmsg">' + esc(d.note || '这里没有可导入的条目') + '</div>';
          return;
        }
        lb.innerHTML = '<div class="srclisthd">' + esc(SRCNAME[id] || id) + ' · '
          + items.length + ' 条 · 点「导入」就变成一张画布</div>'
          + srcListHtml(items, d.groups);
      }
    });
  }

  /* 一条条目 → 一行。抽出来是因为「有分组」和「没分组」两种渲染都要用同一套行模板，
     以前各写一份，改一处忘一处。 */
  function srcItemHtml(it){
    var sub = [];
    if(it.parent) sub.push(it.parent);
    if(it.kind) sub.push(it.kind);
    if(it.docs) sub.push(it.docs + ' 篇');
    if(it.bytes) sub.push((it.bytes / 1024).toFixed(1) + ' KB');
    if(it.updated) sub.push(String(it.updated).slice(0, 10));
    return '<div class="srcitem"><div class="srcmain"><b>' + esc(it.title || it.id) + '</b>'
      + (sub.length ? '<div class="sub">' + esc(sub.join(' · ')) + '</div>' : '')
      + '</div><button class="cvmini" data-pullsrc="' + esc(it.id)
      + '" data-pullsrc-t="' + esc(it.title || '') + '">导入</button></div>';
  }

  /* 后端给了 groups 就按组分（Joplin 的笔记本、语雀的知识库都是这个形状）；
     没给就平铺。分组标题上写清这组几条，不然用户不知道点哪个。 */
  function srcListHtml(items, groups){
    if(!groups || !groups.length) return items.map(srcItemHtml).join('');
    return groups.map(function(g){
      return '<div class="srcgrp"><div class="srcgrph">' + esc(g.title || '未分组')
        + '<span class="srcgrpn">' + (g.count || (g.items || []).length) + ' 条</span></div>'
        + (g.items || []).map(srcItemHtml).join('') + '</div>';
    }).join('');
  }

  /* 整库导入的账单要逐条报：一次导 400 篇，用户得知道有哪几篇没进来，
     不然他以为全导了，回头发现少了东西只会觉得这软件骗人。 */
  function srcImportReport(d){
    var out = [];
    out.push('<div class="srcmsg ' + (d.imported_n ? 'good' : '') + '">'
      + esc(d.note || '') + '</div>');
    if(d.imported_n){
      out.push('<div class="srclisthd">已导入 ' + d.imported_n + ' 篇</div>');
      out.push((d.imported || []).map(function(x){
        return '<div class="srcitem"><div class="srcmain"><b>'
          + esc(x.title || x.file) + '</b><div class="sub">' + esc(x.file)
          + ' · ' + (x.nodes || 0) + ' 个节点</div></div>'
          + '<button class="cvmini" data-openmap="' + esc(x.map) + '">打开</button></div>';
      }).join(''));
    }
    if(d.skipped_n){
      out.push('<div class="srcmsg">跳过 ' + d.skipped_n
        + ' 篇（上次之后没改过）' + (d.skipped_n <= 6
          ? '：' + esc((d.skipped || []).join('、')) : '') + '</div>');
    }
    if(d.heavy_n){
      out.push('<div class="srcmsg bad">' + d.heavy_n + ' 篇太大没自动导（怕一次撑爆画布），'
        + '要的话去「打开」里单独导：'
        + esc((d.heavy || []).map(function(x){ return x.file; }).join('、')) + '</div>');
    }
    if(d.failed_n){
      out.push('<div class="srcmsg bad">' + d.failed_n + ' 篇没转成树：</div>');
      out.push((d.failed || []).map(function(x){
        return '<div class="srcitem"><div class="srcmain"><b>' + esc(x.file)
          + '</b><div class="sub">' + esc(x.reason || '没转成树') + '</div></div></div>';
      }).join(''));
    }
    return out.join('');
  }

  /* 写回原笔记：只给「从文件夹类笔记拉进来的图」露出来。
     本机画布没有外部笔记可写；云端来源（Notion/语雀等）还没做回写 ——
     与其给个点了才知道不支持的按钮，不如压根不显示。 */
  function paintPushBtn(){
    var b = $('#cvPush');
    if(!b) return;
    var can = !!M.id && !!M.src && M.src !== 'local' && !!FILESRC[M.src];
    b.hidden = !can;
    if(can){ b.textContent = '写回' + (SRCNAME[M.src] || M.src); b.removeAttribute('data-force'); }
  }

  function pushBack(force){
    if(!M.id){ toast('这张画布还没存过，先存一次', true); return; }
    if(!M.src || M.src === 'local'){ toast('本机画布没有外部笔记可写回', true); return; }
    if(!FILESRC[M.src]){
      toast((SRCNAME[M.src] || M.src) + ' 还不支持写回（目前只有文件夹类笔记能双向同步）', true);
      return;
    }
    if(M.dirty) doSave();
    toast('正在写回「' + (SRCNAME[M.src] || M.src) + '」…');
    ct('note_push_src', {map_id: M.id, force: !!force}, {
      onDone: function(r){
        var d = (r && r.data) || {};
        if(!r || !r.ok){
          /* need=force 是「外面改过了」的确认步 —— 再点一次才真盖，
             而且一定会先留一份 .bak。绝不替用户做覆盖别人编辑这个决定。 */
          if(d.need === 'force'){
            var b = $('#cvPush');
            if(b){ b.textContent = '外面改过了 · 再点一次覆盖'; b.setAttribute('data-force', '1'); }
            toast(d.error || '外面改过了，再点一次就覆盖');
            return;
          }
          toast('没写回去：' + (d.error || '来源没接住'), true);
          return;
        }
        paintPushBtn();
        toast(d.note || ('已写回「' + (d.rel || '') + '」'));
      }
    });
  }

  function srcImportAll(id, box){
    if(!id || !FILESRC[id]){ toast('这个来源不能整库导入', true); return; }
    var lb = $('#srcListBox');
    if(lb){
      lb.hidden = false;
      lb.setAttribute('data-for', id);
      lb.innerHTML = '<div class="srcmsg">正在扫「' + esc(SRCNAME[id] || id) + '」并导入…</div>';
    }
    var lid = (SDX().currentLesson ? SDX().currentLesson() : null) || M.lesson || null;
    ct('note_src_import', {src: id, lesson_id: lid}, {
      onDone: function(r){
        if(!lb) return;
        if(!r || !r.ok){
          lb.innerHTML = '<div class="srcmsg bad">'
            + esc((r && r.error) || '整库导入没跑起来') + '</div>';
          return;
        }
        var d = r.data || {};
        lb.innerHTML = srcImportReport(d);
        loadCards();
      }
    });
  }

  function srcPull(item, title, box){
    /* 从哪一行点的就从哪一行拿来源 —— 列表上有 data-for，别让两个来源串了 */
    var lb = $('#srcListBox');
    var id = (lb && lb.getAttribute('data-for')) || SRCUI.open || SRCUI.cfg || '';
    if(!id){ toast('不知道从哪个来源拉', true); return; }
    toast('正在从「' + (SRCNAME[id] || id) + '」导入…');
    ct('note_src_pull', {src: id, item: item, title: title,
      save: true, lesson_id: (SDX().currentLesson ? SDX().currentLesson() : null) || M.lesson}, {
      onDone: function(r){
        if(!r || !r.ok){
          toast('没导进来：' + ((r && r.error) || '来源没给内容'));
          return;
        }
        var d = r.data || {};
        closeMod();
        toast('已导入 · ' + (d.nodes || 0) + ' 个节点');
        if(d.map){
          openCanvas({ title: d.title, lesson: (SDX().currentLesson ? SDX().currentLesson() : null) || M.lesson,
            src: id, srcId: String(item) });
        }
        loadCards();
      }
    });
  }

  function srcOpenXm(){
    var box = $('#cvModB');
    if(!box) return;
    var pane = box.querySelector('#xmPane');
    if(!pane){
      /* 新版的来源弹层里没有常驻的 XMind 区 —— 用到时才建一个，
         否则「打开」点下去没有任何地方可以画云端导图列表。 */
      var body = box.querySelector('#srcBody') || box;
      body.insertAdjacentHTML('beforeend', '<div class="cvsep2">XMind 云端导图</div><div id="xmPane"></div>');
      pane = box.querySelector('#xmPane');
    }
    if(pane){ pane.innerHTML = ''; openXmPane(pane); }
  }

  function openSources(){
    openMod('可以接入的笔记来源',
      '<div id="srcBody"><div class="srcmsg">正在查每个来源的状态…</div></div>',
      '<button class="cvmini" id="cvModX4">关闭</button>');
    $('#cvModX4').onclick = closeMod;
    paintSources($('#srcBody'));
  }

  /* ---------------- 暴露 ---------------- */
  window.CANVAS = {
    shots: function(){ return SHOTS.list.slice(); },
    shotNow: shotNow, openGallery: openGallery, pullShot: pullShot,
    flyShot: flyShot,
    open: openCanvas,
    close: closeCanvas,
    openSources: openSources,
    reload: loadCards,
    thumb: thumbSvg,
    md: mdToHtml,
    /* 只读出口：探针和排查要靠它看真结构，不要靠节点坐标反推 */
    tree: function(){ return M.tree; },
    meta: function(){ return {id: M.id, title: M.title, lesson: M.lesson, src: M.src, dirty: M.dirty}; },
    hist: function(){ return {len: HIST.length, at: HISTI, pre: PRE !== null}; }
  };

  /* 首次进来把卡片数拉一次（不展开面板，只更新角标） */
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(loadCards, 600); });
  setTimeout(function(){ if(!$('#cvwrap').hidden === false) loadCards(); }, 1500);

})();
