# -*- coding: utf-8 -*-
r"""研学台 · 第 4 期接线：真实投入时长 / 带时间点提问 / 本机备份导出恢复。

对应 PRD：
  F1  只统计能核对的量 —— 统计页加「真实投入时长」卡（看视频每 10 秒上报实看
      秒数，考场每分钟打点；没记到的就是没有，不按课程时长估算）
  F2  没有数据就不显示那一项 —— 时长为 0 时给一句人话，不给「0 分钟」冒充数据
  E2  提问带讲次 + 时间点 —— 课堂侧舱提问时把视频当前秒数一起发过去
  G2  本机备份 / 导出一键可恢复 —— 统计页底部加备份卡：导出、列出、恢复（二次确认）

必须跑在 wire_v3.py 之后。每处替换都断言命中次数，改不到就报错退出。
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
H("统计页：真实投入时长卡 + 本机备份卡（不新增导航 tab）",
  """        </div>
      </section>

      <!-- ============ 9 Agent 工具台 ============ -->""",
  """        </div>
        <div class="sec" style="margin-top:22px">
          <div class="sechd"><h3>真实投入时长</h3><span class="meta" id="timeMeta">—</span></div>
          <div class="card" id="timeCard"><p class="sub" style="padding:16px 22px">取时长中…</p></div>
        </div>
        <div class="sec" style="margin-top:22px">
          <div class="sechd"><h3>本机备份 · 一键导出可恢复</h3><span class="meta" id="bakMeta">—</span></div>
          <div class="card pad">
            <p class="sub" id="bakHint">备份 = 整库快照（事件、记忆、作答、笔记、交卷记录），写在 data/backup/ 下，不上传任何地方。</p>
            <div style="display:flex;gap:10px;margin-top:12px"><button class="btn act" id="bakMake">导出一份备份</button></div>
            <div id="bakList" style="margin-top:14px"></div>
          </div>
        </div>
      </section>

      <!-- ============ 9 Agent 工具台 ============ -->""")

# ========================================================== JS
J("播放：上报真看秒数（拖进度条不算时间）",
  """      var lastSync=0;""",
  """      var lastSync=0, lastPos=0, playAcc=0;""")

J("播放：本段实看时长随位置一起上报",
  """        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)});
        }""",
  """        var seg=v.currentTime-lastPos;
        if(!v.paused && seg>0 && seg<30) playAcc += seg;   /* 只累真看的，拖进度条/跳断点不算 */
        lastPos=v.currentTime;
        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime),
                                   seconds:Math.round(playAcc*10)/10});
          playAcc=0;
        }""")

J("课堂提问：把视频里的第几秒一起发出去（E2）",
  """      callTool('ask_ai', {question: q, lesson_id:(CLS_S.lesson||{}).id}, {onDone:function(r){
        var d=r.data||{};
        $('#daOut').className='explain reveal on';
        $('#daOutT').textContent = d.answer || ((d.reason||'') + '。' + (d.note||''));
      }});""",
  """      var vid=$('#vid');
      var pos=vid ? Math.round(vid.currentTime) : Math.round(CLS_S.posSec||0);
      callTool('ask_ai', {question: q, lesson_id:(CLS_S.lesson||{}).id, pos_sec:pos}, {onDone:function(r){
        var d=r.data||{};
        var ctx=(d.context||[]).join(' · ');
        $('#daOut').className='explain reveal on';
        $('#daOutT').textContent = d.answer || ((d.reason||'') + '。' + (d.note||'') +
          (ctx ? '　这次提问带上的上下文：' + ctx : ''));
      }});""")

J("课堂提问提示语：说明会带讲次与时间点",
  """    $('#daHint').textContent = '问题会带上「' + (les.title||'') + '」一起发出去。';""",
  """    $('#daHint').textContent = '问题会带上「' + (les.title||'') + '」和点发送那一刻的播放位置一起发出去。';""")

J("统计页：多拉两个工具（真实时长 + 备份列表）",
  """    stats:    [['stats_overview',    function(){ return {}; }]],""",
  """    stats:    [['stats_overview',    function(){ return {}; }],
               ['lesson_play_time',  function(){ return {}; }],
               ['list_backups',      function(){ return {limit:20}; }]],""")

J("分发：时长/备份各走自己的渲染",
  """    if(p==='stats') return paintStats(res);""",
  """    if(tool==='lesson_play_time') return paintTime(res);
    if(tool==='list_backups') return paintBackups(res);
    if(p==='stats') return paintStats(res);""")

J("新增：真实投入时长卡 + 本机备份卡",
  """  function paintStats(res){""",
  r"""  var BAK = {armed:null};
  function hm(sec){
    sec=Math.round(sec||0);
    if(sec<60) return sec + ' 秒';
    var m=Math.floor(sec/60), h=Math.floor(m/60);
    return h ? (h + ' 小时 ' + (m%60) + ' 分') : (m + ' 分');
  }
  function paintTime(res){
    var box=$('#timeCard'), mt=$('#timeMeta'); if(!box) return;
    var d=(res.data)||{}, total=d.total||0, today=d.today||0, by=d.by_kind||{};
    if(mt) mt.textContent = total ? ('总计 ' + hm(total) + ' · 今日 ' + hm(today)) : '还没有计时记录';
    if(!total){
      box.innerHTML = '<p class="sub" style="padding:16px 22px">还没有真实计时：看视频每 10 秒上报一次实看时长，' +
        '考场每分钟打一次点——没记到的就是没有，不按课程时长估算，也不显示假的 0。</p>';
      return;
    }
    var kpi=[['总计', hm(total)], ['今日', hm(today)],
             ['看视频', hm(by.play||0)], ['考场计时', hm(by.exam_tick||0)]];
    var html='<div class="kpis">' + kpi.map(function(x){
      return '<div class="kpi"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>';
    }).join('') + '</div>';
    var ls=d.lessons||[];
    if(ls.length){
      var mx=Math.max.apply(null, ls.map(function(l){ return l.seconds||0; }).concat([1]));
      html += '<div class="statbars" style="padding:4px 20px 18px">' + ls.map(function(l){
        return '<div class="statrow"><span class="k">'+esc(l.title)+'</span>' +
          '<span class="bar act"><i class="act" style="width:'+Math.max(Math.round((l.seconds||0)*100/mx),2)+'%"></i></span>' +
          '<span class="v">'+hm(l.seconds)+'</span></div>';
      }).join('') + '</div>';
    }
    html += '<p class="hint" style="padding:0 20px 18px;margin:0">'+esc(d.note||'')+'</p>';
    box.innerHTML = html;
  }
  function kb(n){
    n=n||0;
    return n > 1048576 ? (Math.round(n/1048576*10)/10 + ' MB') : (Math.max(1, Math.round(n/1024)) + ' KB');
  }
  function paintBackups(res){
    var box=$('#bakList'), mt=$('#bakMeta'); if(!box) return;
    var d=(res.data)||{}, rows=d.backups||[];
    if(mt) mt.textContent = rows.length ? (rows.length + ' 份 · 存放在本机') : '一份备份都还没有';
    if(!rows.length){
      box.innerHTML = '<p class="sub" style="padding:14px 0">还没有导出过备份——点上面那个按钮，整库会存成一份 JSON 快照。</p>';
      return;
    }
    box.innerHTML = rows.map(function(b){
      var c=b.counts||{};
      var cnt=(b.events===undefined && !c.events) ? '' :
        ((b.events===undefined? c.events : b.events) + ' 事件 · ' + (c.word_mem||0) + ' 词');
      return '<div class="bakrow"><span class="nm">'+esc(b.name)+'</span>' +
        '<span class="sz">'+esc(b.mtime||'')+' · '+kb(b.size)+'</span>' +
        '<span class="sz">'+cnt+'</span>' +
        '<button class="btn sm'+(BAK.armed===b.name?' act':'')+'" data-bak="'+esc(b.name)+'">' +
        (BAK.armed===b.name? '再点一次确认恢复' : '恢复这份')+'</button></div>';
    }).join('');
  }
  document.addEventListener('click',function(e){
    var bm=e.target.closest('#bakMake');
    if(bm){
      bm.disabled=true; bm.textContent='导出中…';
      callTool('make_backup', {}, {onDone:function(r){
        bm.disabled=false; bm.textContent='导出一份备份';
        var h=$('#bakHint');
        if(h) h.textContent = r.ok
          ? ('已导出 '+r.data.name+'：'+r.data.events+' 条事件 · '+r.data.words+' 词 · '+kb(r.data.size)+'，存在本机 data/backup/ 下')
          : ('导出失败：'+(r.error||'未知错误'));
        callTool('list_backups', {limit:20}, {onDone:paintBackups});
      }});
      return;
    }
    var br=e.target.closest('#bakList [data-bak]');
    if(br){
      var nm=br.getAttribute('data-bak');
      if(BAK.armed!==nm){
        BAK.armed=nm;
        [].forEach.call(document.querySelectorAll('#bakList [data-bak]'),function(x){
          x.textContent = (x.getAttribute('data-bak')===nm) ? '再点一次确认恢复' : '恢复这份';
          x.classList.toggle('act', x.getAttribute('data-bak')===nm);
        });
        return;
      }
      BAK.armed=null; br.disabled=true; br.textContent='恢复中…';
      callTool('restore_backup', {name:nm}, {confirm:true, onDone:function(r){
        var h=$('#bakHint');
        if(h) h.textContent = r.ok
          ? ('已用 '+nm+' 恢复当前库；恢复前的库另存为 '+((r.data||{}).before||'—'))
          : (r.need_confirm ? '这个工具要二次确认' : ('恢复失败：'+(r.error||'未知错误')));
        callTool('list_backups', {limit:20}, {onDone:paintBackups});
        callTool('stats_overview', {}, {onDone:paintStats});
      }});
      return;
    }
  });

  function paintStats(res){""")

CSS_APPEND = """
/* ---- 第 4 期新增 ---- */
#timeCard .kpis{grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}
#timeCard .kpi{border-right:1px solid var(--line);border-bottom:0}
#timeCard .kpi:last-child{border-right:0}
#timeCard .statrow{padding:9px 0}
.bakrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.bakrow:first-child{border-top:0}
.bakrow .nm{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:var(--tx2);
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bakrow .sz{font-size:11.5px;color:var(--tx3);flex:none}
"""


def apply(path, edits, kind):
    with io.open(path, encoding="utf-8") as f:
        t = f.read()
    for label, old, new, n in edits:
        if new and new in t:
            print("OK %s %s (skip)" % (kind, label))
            continue
        c = t.count(old)
        if c != n:
            raise SystemExit("FAIL %s [%s] expect %d got %d" % (kind, label, n, c))
        t = t.replace(old, new)
        print("OK %s %s" % (kind, label))
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(t)
    return t


apply(HTML, H_EDITS, "HTML")

with io.open(CSS, encoding="utf-8") as f:
    css = f.read()
if "第 4 期新增" not in css:
    with io.open(CSS, "w", encoding="utf-8", newline="\n") as f:
        f.write(css.rstrip() + "\n" + CSS_APPEND)
    print("OK CSS append")
else:
    print("OK CSS (skip)")

apply(JS, J_EDITS, "JS")

print("第 4 期接线完成：HTML %d 处 · JS %d 处" % (len(H_EDITS), len(J_EDITS)))
