# -*- coding: utf-8 -*-
r"""研学台 · 第 2 期接线：让错的有处去。

PRD 第 2 期：C5(已随 SM-2 落地) / C6 错词本 / C7 今日词量 / D3 错题本 /
D5 错因打标 / E1 笔记落库 / B5 播完打勾；外加「六、界面瘦身」剩余 1 条
（Agent 工具台移出主导航）。

本脚本必须跑在 wire_js.py 之后（它按设计稿重建 app.js / app.css）。

坑：字符串里不要出现"被求值成真换行"的转义，大块一律用三引号 raw 块。
每处替换都断言命中次数，改不到就报错退出。
"""
import io
import os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(APP, "web", "index.html")
CSS = os.path.join(APP, "web", "app.css")
JS = os.path.join(APP, "web", "app.js")

H_EDITS = []
J_EDITS = []


def H(label, old, new, n=1):
    H_EDITS.append((label, old, new, n))


def J(label, old, new, n=1):
    J_EDITS.append((label, old, new, n))


# ========================================================== HTML
H("背单词页加今日词量 + 错词本入口",
  """          <button class="btn sm" id="wmToggle" style="margin-left:auto"><svg class="ic" style="width:15px;height:15px"><use href="#i-list"/></svg>换词组</button>""",
  """          <span class="bdg" style="height:30px" id="wGoal">今日词量 —</span>
          <button class="btn sm" id="wrongBtn"><svg class="ic" style="width:15px;height:15px"><use href="#i-refresh"/></svg>错词本 —</button>
          <button class="btn sm" id="wmToggle" style="margin-left:auto"><svg class="ic" style="width:15px;height:15px"><use href="#i-list"/></svg>换词组</button>""")

H("课堂页加看完标记与写回按钮",
  """                <span class="bdg" id="clsSrc" style="margin-left:auto">—</span>""",
  """                <span class="bdg" id="clsSrc" style="margin-left:auto">—</span>
                <span class="bdg ok" id="clsFin" hidden style="height:26px">本讲已看完</span>
                <button class="btn sm" id="clsSync" hidden>写回进度文件</button>""")

H("练习页加只看错题入口",
  """        <div class="chips" id="pracParts" style="margin-bottom:20px"></div>""",
  """        <div class="chips" id="pracParts" style="margin-bottom:20px"></div>
        <div class="chips" style="margin-bottom:20px">
          <button class="chip" id="wrongOnly">只看错题（本机答错过的题）</button>
          <span class="sub" id="wrongOnlyMeta">答错过的题会列在这里，答对自动划掉</span>
        </div>""")

H("练习页加错因打标区",
  """              <div class="opts" id="pracOpts"></div>""",
  """              <div class="opts" id="pracOpts"></div>
              <div class="tagbox" id="tagBox" hidden></div>""")

H("统计页加错因分布卡",
  """            <div class="card" id="statsMem"></div>
            <div class="advice" style="margin-top:20px">""",
  """            <div class="card" id="statsMem"></div>
            <div class="sechd" style="margin-top:20px"><h3>错因分布</h3><span class="meta">答错时手动打标</span></div>
            <div class="card" id="statTags"></div>
            <div class="advice" style="margin-top:20px">""")

# 界面瘦身：Agent 工具台移出主导航，收进侧栏底部
H("主导航移除 Agent 工具台",
  """        <div class="navsep"></div>
        <button class="navitem" data-p="agent"><svg class="ic"><use href="#i-spark"/></svg><span>Agent 工具台</span><span class="cnt">9</span></button>
""", "")

H("侧栏底部放开发入口",
  """    <div class="streak" id="streak" title="最近 7 天"></div>""",
  """    <div class="streak" id="streak" title="最近 7 天"></div>
    <button class="devlink" data-p="agent" title="工具注册表与调用审计（开发用）">工具台</button>""")

# ========================================================== CSS
CSS_APPEND = r"""
/* ---- 第 2 期新增 ---- */
[hidden]{display:none!important}
.devlink{margin:0 10px 12px;padding:8px 10px;border-radius:8px;font-size:12px;color:var(--tx3);
  text-align:left;transition:.15s var(--ease)}
.devlink:hover{background:#1A1D24;color:var(--tx2)}
.tagbox{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px;
  padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card2)}
.tagbox .lbl{margin-right:2px}
.tagbox button{height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--line2);
  font-size:13px;color:var(--tx2);transition:.15s var(--ease)}
.tagbox button:hover{border-color:var(--act);color:var(--tx)}
.tagbox button.on{border-color:var(--act);color:var(--act);font-weight:700}
.tagbox .done{font-size:12px;color:var(--tx3);margin-left:auto}
"""

# ========================================================== JS
J("笔记改由服务端存取（E1）",
  """    var na=$('#dnArea'); if(na) na.value = localStorage.getItem('note:' + les.id) || '';
    var ns=$('#dnState'); if(ns) ns.textContent = '笔记按讲次存在本机浏览器';""",
  r"""    var na=$('#dnArea'); if(na) na.value = '';
    var ns=$('#dnState'); if(ns) ns.textContent = '读取中…';
    var fb0=$('#clsFin'); if(fb0) fb0.hidden = true;
    var sb0=$('#clsSync'); if(sb0) sb0.hidden = true;
    CLS_S.finished = false; CLS_S.posSec = CLS_S.pos || 0;
    callTool('get_note', {lesson_id:les.id}, {onDone:function(r){
      var t=((r.data||{}).text)||'';
      if(na && document.activeElement!==na) na.value = t;
      if(ns) ns.textContent = t ? ('已存本机 · ' + (((r.data||{}).note||{}).updated_ts||'')) : '这条讲次还没记笔记';
    }});""")

J("看到 95% 自动打勾（B5）",
  """        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)});
        }
      });""",
  r"""        CLS_S.posSec = v.currentTime;
        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)});
        }
        var dur=v.duration||les.dur||0;
        if(!CLS_S.finished && dur>30 && v.currentTime/dur>=0.95){
          CLS_S.finished=true;
          callTool('finish_lesson',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)},{onDone:function(r){
            if(!r.ok) return;
            var fb1=$('#clsFin'); if(fb1){ fb1.hidden=false; fb1.textContent='本讲已看完 · 已写进本机事件库'; }
            var sb1=$('#clsSync'); if(sb1) sb1.hidden=false;
          }});
        }
      });""")

J("笔记失焦即落库",
  """  function paintTocProgress(d){""",
  r"""  var dnTimer=null;
  document.addEventListener('input', function(e){
    if(!e.target || e.target.id!=='dnArea') return;
    var les=CLS_S.lesson; if(!les || !les.id) return;
    var txt=e.target.value;
    clearTimeout(dnTimer);
    dnTimer=setTimeout(function(){
      callTool('save_note', {lesson_id:les.id, text:txt, pos_sec:Math.round(CLS_S.posSec||0)},
        {onDone:function(r){
          var ns=$('#dnState');
          if(ns) ns.textContent = r.ok ? ('已存本机 · ' + (((r.data||{}).note||{}).updated_ts||'')) : '保存失败';
        }});
    }, 900);
  });
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#clsSync')){
      var les=CLS_S.lesson; if(!les || !les.id) return;
      var sb=$('#clsSync'); if(!sb) return;
      var armed = sb.getAttribute('data-armed')==='1';
      callTool('mark_lesson_done', {lesson_id:les.id}, {confirm:armed, onDone:function(r){
        var sb2=$('#clsSync'); if(!sb2) return;
        if(r.need_confirm || (r.data && r.data.need_confirm)){
          sb2.setAttribute('data-armed','1'); sb2.textContent='再点一次确认写入'; return;
        }
        sb2.removeAttribute('data-armed');
        sb2.textContent = r.ok ? '已写回 progress.json' : ('写入失败：' + (r.error||''));
      }});
    }
  });

  function paintTocProgress(d){""")

J("背单词：今日词量 + 错词本（C6 / C7）",
  """  function paintVocabMap(){""",
  r"""  var WRONG = {words:[], count:0};
  function loadVocabExtras(){
    callTool('word_goal', {}, {onDone:function(res){
      var d=(res.data||{});
      var g=$('#wGoal');
      if(g) g.textContent = '今日 ' + (d.done||0) + ' / ' + (d.goal||0) + ' 词' + (d.left? ('（还差 ' + d.left + '）') : '（已完成）');
    }});
    callTool('list_wrong_words', {}, {onDone:function(res){
      WRONG.words = ((res.data||{}).words)||[];
      WRONG.count = WRONG.words.length;
      var b=$('#wrongBtn');
      if(b) b.innerHTML = '<svg class="ic" style="width:15px;height:15px"><use href="#i-refresh"/></svg>错词本 ' + WRONG.count;
    }});
  }
  function loadWrongBook(){
    if(!WRONG.count){ $('#duoKicker').textContent='错词本是空的：还没有答错过词'; return; }
    words = WRONG.words.map(function(r){
      return {no:0, w:r.w, ph:r.ph||'', pos:r.pos||'', cn:r.cn||'', mem:{box:r.box, due:r.due}};
    });
    MEM = {}; words.forEach(function(w){ MEM[w.w]=w.mem; });
    CURG = '错词本';
    paintVocabHeader(); paintWordList(); initRound();
  }
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#wrongBtn')){ loadWrongBook(); }
  });

  function paintVocabMap(){""")

J("背单词页进入时拉今日词量与错词本",
  """  paintVocabHeader(); paintVocabMap(); paintWordList();
    if(d.words) initRound();""",
  r"""  paintVocabHeader(); paintVocabMap(); paintWordList();
    loadVocabExtras();
    if(d.words) initRound();""")

J("练习：只看错题（D3）",
  """    if(e.target.closest('#pracNext')){ pracStep(1); return; }""",
  r"""    if(e.target.closest('#wrongOnly')){
      callTool('list_errors', {limit:50}, {onDone:function(res){
        var rows=((res.data||{}).errors)||[];
        var meta=$('#wrongOnlyMeta');
        if(!rows.length){ if(meta) meta.textContent='本机还没有答错过的题'; return; }
        PRAC.list = rows.map(function(r){
          return {no:r.qno, part:r.part, stem:r.stem||('第 '+r.qno+' 题'), opts:r.opts||{},
                  topic:'上次你选了 '+(r.chosen||'—'), done:true, fromError:true};
        });
        PRAC.idx=0; PRAC.right=0; PRAC.wrong=0;
        if(meta) meta.textContent = '共 ' + rows.length + ' 道错题 · 答对会自动从列表里划掉';
        renderPracQ(); paintSess();
      }});
      return;
    }
    if(e.target.closest('#pracNext')){ pracStep(1); return; }""")

J("练习：答错后打错因（D5）",
  """        $('#pracExpT').textContent = (d.explain||'—（题库里这道题没有解析）');
        $('#pracExp').classList.add('on');
        if(d.ok){ PRAC.right++; } else { PRAC.wrong++; }""",
  r"""        $('#pracExpT').textContent = (d.explain||'—（题库里这道题没有解析）');
        $('#pracExp').classList.add('on');
        if(d.ok){ PRAC.right++; hideTagBox(); }
        else { PRAC.wrong++; showTagBox(q.no, d.part); }""")

J("错因打标的实现函数",
  """  function paintErrors(d){""",
  r"""  var TAGS = ['没记住', '没看懂', '看错选项', '粗心'];
  function showTagBox(qno, part){
    var box=$('#tagBox'); if(!box) return;
    box.hidden=false;
    box.innerHTML = '<span class="lbl">错在哪</span>' +
      TAGS.map(function(t){ return '<button data-tag="'+t+'">'+t+'</button>'; }).join('') +
      '<span class="done">打完标，下次就按这个练</span>';
    box.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        var tag=b.getAttribute('data-tag');
        callTool('tag_error', {qno:qno, part:part, tag:tag}, {onDone:function(r){
          if(!r.ok) return;
          box.querySelectorAll('button').forEach(function(x){ x.classList.remove('on'); });
          b.classList.add('on');
          var dn=box.querySelector('.done');
          if(dn) dn.textContent = '已记：' + tag;
        }});
      });
    });
  }
  function hideTagBox(){ var box=$('#tagBox'); if(box){ box.hidden=true; box.innerHTML=''; } }

  function paintErrors(d){""")

J("统计页加错因分布",
  """  function paintStats(res){""",
  r"""  function loadTagStats(){
    callTool('error_tag_stats', {}, {onDone:function(res){
      var box=$('#statTags'); if(!box) return;
      var d=(res.data||{});
      var rows=(d.tags)||[];
      if(!rows.length){ box.innerHTML='<div class="sub" style="padding:16px 22px">还没有打过标签：答错一题就能选错因</div>'; return; }
      var mx=Math.max.apply(null, rows.map(function(r){ return r.c; }));
      box.innerHTML = '<div class="statbars">' + rows.map(function(r){
        return '<div class="statrow"><span class="k">'+esc(r.tag)+'</span>' +
          '<span class="bar"><i class="en" style="width:'+Math.max(Math.round(r.c*100/mx),4)+'%"></i></span>' +
          '<span class="v">'+r.c+'</span></div>';
      }).join('') + '</div>';
    }});
  }

  function paintStats(res){""")

J("答题卡：答过的题不被「当前」态盖掉",
  """      var cls = (i===curNo) ? 'cur' : (st===1?'done':(st===0?'err':''));""",
  """      var cls = (st===1?'done':(st===0?'err':(i===curNo?'cur':'')));""")

J("统计页进入时拉错因",
  """    $('#adviceNext').innerHTML = """,
  """    loadTagStats();
    $('#adviceNext').innerHTML = """)


def apply(path, edits, kind):
    with io.open(path, encoding="utf-8") as f:
        t = f.read()
    for label, old, new, n in edits:
        c = t.count(old)
        if c != n:
            raise SystemExit("✗ %s【%s】期望命中 %d 次，实际 %d 次" % (kind, label, n, c))
        t = t.replace(old, new)
        print("✓ %s %s" % (kind, label))
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(t)
    return t


apply(HTML, H_EDITS, "HTML")

with io.open(CSS, encoding="utf-8") as f:
    css = f.read()
if "第 2 期新增" not in css:
    with io.open(CSS, "w", encoding="utf-8", newline="\n") as f:
        f.write(css.rstrip() + "\n" + CSS_APPEND)
    print("✓ CSS 追加第 2 期样式")
else:
    print("✓ CSS 第 2 期样式已在，跳过")

apply(JS, J_EDITS, "JS")

print("第 2 期接线完成：HTML %d 处 · JS %d 处" % (len(H_EDITS), len(J_EDITS)))
