# -*- coding: utf-8 -*-
r"""研学台 · 第 3 期接线：整卷有分，背词有真例句。

PRD 第 3 期 D4（整卷模考评分）+ C1 真例句 + 界面瘦身最后一条（拆掉卡片态
写死的占位助记图）。

必须跑在 wire_v2.py 之后。

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
H("考场页：交卷结果卡 + 历史抽屉",
  """            <button class="btn act block lg" style="margin-top:20px" id="examSubmit">交卷看分</button>
            <p class="hint" id="examHint" style="margin-top:14px">绿色已答、红色错题。点题号跳到那一题；分数只按本机真实作答算。</p>""",
  """            <button class="btn act block lg" style="margin-top:20px" id="examSubmit">交卷看分</button>
            <div class="scorecard" id="examScore" hidden></div>
            <p class="hint" id="examHint" style="margin-top:14px">绿色已答、红色错题。点题号跳到那一题；分数只按本机真实作答算。</p>
            <div class="sec" style="margin-top:20px">
              <div class="sechd"><h3>这套卷交过几次</h3><span class="meta" id="examHisMeta">—</span></div>
              <div class="card" id="examHistory"><p class="sub" style="padding:16px 22px">还没有交过卷——分数只在你点了「交卷看分」之后才有</p></div>
            </div>""")

# ========================================================== JS
J("单词卡：拆掉写死的占位助记图（换真例句块）",
  """               '<figure class="cimg"><img src="img/mnemo.jpg" alt="助记图"><figcaption>助记图（原型示例）· 上线后按词生成并缓存</figcaption></figure>'+""",
  """                '<figure class="cimg"><div class="sents" id="wSents" data-word="'+esc(w.w)+'">'+
                  '<span class="k">真卷例句</span><div class="sbody">取例句中…</div></div>'+
                  '<figcaption id="wSentSrc">—</figcaption></figure>'+""")

J("单词卡：渲染后拉真例句",
  """    body.innerHTML = html;
    bindDrill(w);""",
  r"""    body.innerHTML = html;
    bindDrill(w);
    if(mode==='card') loadSents(w.w);""")

J("新增：真例句装载 + 交卷流程",
  """  function bindDrill(w){""",
  r"""  var SENTS = {};
  function loadSents(w){
    var box=$('#wSents'); if(!box) return;
    var body=box.querySelector('.sbody'), src=$('#wSentSrc');
    if(SENTS[w] !== undefined){ paintSents(w, box, body, src); return; }
    body.innerHTML = '<span class="sub">取例句中…</span>';
    if(src) src.textContent = '正在查真卷';
    callTool('word_sentences', {word:w, limit:3}, {onDone:function(res){
      SENTS[w] = (res.ok && res.data) ? res.data : {word:w, count:0, sentences:[],
        note: res.error || '取例句失败'};
      if($('#wSents') && $('#wSents').getAttribute('data-word')===w) paintSents(w, box, body, src);
    }});
  }
  function paintSents(w, box, body, src){
    var d=SENTS[w]||{};
    if(!d.count){
      body.innerHTML = '<span class="sub">这个词在 15 套真卷里没出现过，所以这里没有例句——不编句子。</span>';
      if(src) src.textContent = d.note || '原卷没出现过';
      return;
    }
    body.innerHTML = d.sentences.map(function(s){
      return '<div class="sent"><p>'+esc(s.t)+'</p><span>'+esc(s.kind)+' · '+esc(s.src)+'</span></div>';
    }).join('');
    if(src) src.textContent = '全部摘自真卷，不是生成的 · ' + (d.count||0) + ' 句';
  }

  function examSeconds(){
    return Math.max(0, (EX.minutes||0)*60 - (EX.left||0));
  }
  function loadExamHistory(){
    callTool('exam_scores', {paper_id:EX.paper, limit:8}, {onDone:function(res){
      var box=$('#examHistory'); if(!box) return;
      var d=(res.data||{}), rows=d.sessions||[];
      var mt=$('#examHisMeta');
      if(mt) mt.textContent = rows.length
        ? ('共 '+rows.length+' 次 · 最好 '+((d.best||{}).best))
        : '还没有交过卷';
      if(!rows.length){ box.innerHTML='<p class="sub" style="padding:16px 22px">还没有交过卷——分数只在你点了「交卷看分」之后才有</p>'; return; }
      box.innerHTML = '<div class="statbars">' + rows.map(function(r){
        return '<div class="statrow"><span class="k">'+esc((r.ts||'').slice(5,16).replace('T',' '))+'</span>' +
          '<span class="bar"><i class="act" style="width:'+Math.max(Math.round((r.scored||0)),3)+'%"></i></span>' +
          '<span class="v">'+(r.scored===null||r.scored===undefined? '—' : r.scored)+' 分</span>' +
          '<span class="sub" style="flex:none">答 '+r.answered+'/'+r.judgeable+' · 对 '+r.right+'</span></div>';
      }).join('') + '</div>';
    }});
  }
  function paintScore(res){
    var box=$('#examScore'); if(!box) return;
    var d=(res.data||{}), t=d.totals||{};
    if(!res.ok || !t){ box.hidden=true; return; }
    box.hidden=false;
    var scored=(t.scored===null||t.scored===undefined)? '—' : t.scored;
    var mm=t.seconds? (Math.floor(t.seconds/60)+' 分 '+(t.seconds%60)+' 秒') : '没开计时';
    box.innerHTML =
      '<div class="sctop"><div><span class="lbl">本次得分</span>'+
        '<div class="scnum">'+scored+'<small> / '+(t.full||100)+'</small></div></div>'+
        '<span class="bdg '+(t.pass? 'ok' : 'bad')+'">'+(t.pass? '过线' : '未过线')+'（线 '+(t.pass_line||60)+'）</span></div>'+
      '<div class="scmeta">答 '+t.answered+' / 可判分 '+t.judgeable+' 题 · 对 '+t.right+' · 错 '+t.wrong+
        ' · 还有 '+t.unanswered+' 题没做 · 用时 '+mm+'</div>'+
      '<div class="statbars" style="margin-top:14px">' + (d.rows||[]).map(function(r){
        var w=r.full? Math.max(Math.round((r.got||0)*100/r.full),3) : 0;
        return '<div class="statrow"><span class="k">'+esc(r.label)+' · 每题 '+r.each+' 分</span>' +
          '<span class="bar"><i class="act" style="width:'+w+'%"></i></span>' +
          '<span class="v">'+(r.judgeable? ((r.got||0)+' / '+r.full) : '不判分')+'</span></div>';
      }).join('') + '</div>'+
      '<p class="hint" style="margin-top:14px">'+esc(d.note||'')+
        (d.best && d.best.best!==null? ('　这套卷历史最好 '+d.best.best+' 分，共交过 '+d.best.sessions+' 次。') : '')+'</p>';
    loadExamHistory();
  }

  function bindDrill(w){""")

J("EX 状态：按整卷口径计时（120 分钟）",
  """  var EX = {papers:[], paper:null, meta:null, groups:[], gi:0, qs:[], qi:0, state:{},
            ticking:false, left:20*60, timer:null, submitted:false};""",
  """  var EX = {papers:[], paper:null, meta:null, groups:[], gi:0, qs:[], qi:0, state:{},
            ticking:false, minutes:120, left:120*60, timer:null, submitted:false};""")

J("初始时钟与副标题按真题量给",
  """  function paintClock(){
    $('#clock').textContent = String(Math.floor(EX.left/60)).padStart(2,'0') + ':' + String(EX.left%60).padStart(2,'0');
  }""",
  r"""  function paintClock(){
    $('#clock').textContent = String(Math.floor(EX.left/60)).padStart(2,'0') + ':' + String(EX.left%60).padStart(2,'0');
    var m=$('#clockMeta');
    if(m) m.textContent = '按整卷 ' + (EX.minutes||120) + ' 分钟计时 · 到点不停卷，只提示';
  }
  paintClock();""")

J("交卷：改走服务端 submit_exam 并渲染分数卡",
  r"""    if(e.target.closest('#examSubmit')){
      if(EX.submitted) return;
      EX.submitted=true; EX.ticking=false;
      var done=Object.keys(EX.state).length;
      var right=Object.keys(EX.state).filter(function(n){ return EX.state[n]===1; }).length;
      var total=(EX.meta||{}).total||0;
      $('#examHint').innerHTML = '已交卷：做 ' + done + ' / ' + total + '，对 ' + right + '，错 ' + (done-right) +
        (done? '，本次正确率 ' + Math.round(right*100/done) + '%' : '，还没有作答记录');
      return;
    }""",
  r"""    if(e.target.closest('#examSubmit')){
      var done=Object.keys(EX.state).length;
      var right=Object.keys(EX.state).filter(function(n){ return EX.state[n]===1; }).length;
      var total=(EX.meta||{}).total||0;
      $('#examHint').innerHTML = '交卷中：把本机答过的题交给服务端按题型算分…';
      callTool('submit_exam', {paper_id:EX.paper, seconds:examSeconds()}, {onDone:function(res){
        EX.submitted=true; EX.ticking=false;
        paintScore(res);
        var d=(res.data||{}), t=(d.totals)||{};
        if(!res.ok || !t){
          $('#examHint').innerHTML = '交卷失败：' + esc(res.error || '服务端没返回分数');
          return;
        }
        $('#examHint').innerHTML = '已交卷：做 ' + done + ' / ' + total + '，对 ' + right + '，错 ' + (done-right) +
          (done? '，本次正确率 ' + Math.round(right*100/done) + '%' : '，还没有作答记录') +
          '。分数按题型权重算，没答的题记 0 分；可以接着答，再交一次会多一条记录。';
        EX.submitted=false;
      }});
      return;
    }""")

J("切卷 / 首次入考场时拉交卷历史",
  """    if(tool==='get_exam_paper'){
      EX.meta=d.paper; EX.groups=d.groups||[]; EX.gi=d.group_index||0;""",
  """    if(tool==='get_exam_paper'){
      EX.meta=d.paper; EX.groups=d.groups||[]; EX.gi=d.group_index||0;
      loadExamHistory();""")

J("切年份后清掉上一套的分数卡",
  """      EX.paper=mp.getAttribute('data-m-paper'); EX.state={}; EX.submitted=false;
      $('#examMenu').hidden=true;""",
  """      EX.paper=mp.getAttribute('data-m-paper'); EX.state={}; EX.submitted=false;
      $('#examMenu').hidden=true;
      var sc=$('#examScore'); if(sc){ sc.hidden=true; sc.innerHTML=''; }
      loadExamHistory();""")

CSS_APPEND = """
/* ---- 第 3 期新增 ---- */
.scorecard{margin-top:18px;padding:18px 20px;border-radius:var(--r-l);
  background:var(--card2);border:1px solid var(--line)}
.scorecard .sctop{display:flex;align-items:flex-start;gap:14px}
.scorecard .scnum{font-family:"SFMono-Regular",Consolas,monospace;font-size:40px;line-height:1.1;
  letter-spacing:-.03em;margin-top:6px}
.scorecard .scnum small{font-size:13px;color:var(--tx3);font-family:inherit;letter-spacing:0;margin-left:6px}
.scorecard .sctop .bdg{margin-left:auto}
.scorecard .scmeta{margin-top:10px;font-size:12.5px;color:var(--tx3);line-height:1.7}
.cimg .sents{display:flex;flex-direction:column;gap:8px;padding:11px}
.cimg .sents .k{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tx3)}
.cimg .sents .sbody{display:flex;flex-direction:column;gap:9px}
.cimg .sent p{font-size:11.5px;line-height:1.65;color:var(--tx2)}
.cimg .sent span{display:block;margin-top:3px;font-size:10px;color:var(--tx3);line-height:1.5}
.cimg figcaption{white-space:normal}
"""


def apply(path, edits, kind):
    with io.open(path, encoding="utf-8") as f:
        t = f.read()
    for label, old, new, n in edits:
        if new and new in t:
            print("✓ %s %s（已在，跳过）" % (kind, label))
            continue
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
if "第 3 期新增" not in css:
    with io.open(CSS, "w", encoding="utf-8", newline="\n") as f:
        f.write(css.rstrip() + "\n" + CSS_APPEND)
    print("✓ CSS 追加第 3 期样式")
else:
    print("✓ CSS 第 3 期样式已在，跳过")

apply(JS, J_EDITS, "JS")

print("第 3 期接线完成：HTML %d 处 · JS %d 处" % (len(H_EDITS), len(J_EDITS)))
