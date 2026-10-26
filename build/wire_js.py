# -*- coding: utf-8 -*-
r"""研学台 · 前端接线：把设计稿的"假数据 + 假工具"换成真服务调用。

做两件事：
1) 区块替换：首屏、工具层、导航、今日、课表、课程库、课堂、练习、考场、统计、Agent、初始化
   —— 这些区块里全是写死的数字和 logTool() 假日志，整段换掉。
2) 定点补丁：背单词页那 420 行刷词状态机是设计稿里最值钱的部分，**整段保留**，
   只在 6 个点上接真服务（词源 / 词组地图 / 评分落库 / 词表 box / 模式记录）。

每个替换都断言命中次数；改不到就报错退出。
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
JS = os.path.join(APP, "web", "app.js")
CSS = os.path.join(APP, "web", "app.css")

# ==========================================================================
# 新区块
# ==========================================================================
NEW_HEADER = r"""(async function(){
  async function boot(){
    var r = await fetch('/api/base', {cache:'no-store'});
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  var D;
  try{ D = await boot(); }
  catch(e){
    console.error('首屏数据拉取失败', e);
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="booterr"><b>连不上本机服务</b><p>' + String((e && e.message) || e) +
      '</p><p class="sub">先运行 start.bat，服务地址 127.0.0.1:8770</p></div>');
    return;
  }
"""

NEW_TOOLS = r"""  /* ---------- 工具层：界面只调工具，不直连数据 ---------- */
  var TOOLS = (D.tools || []);
  var TLOG = [], TCALLS = 0, TFAILS = 0;
  function toolMeta(n){
    for(var i=0;i<TOOLS.length;i++){ if(TOOLS[i].name===n) return TOOLS[i]; }
    return {name:n, perm:'local', desc:'不在注册表里'};
  }
  function callTool(name, args, opts){
    opts = opts || {};
    function nowms(){ return (window.performance && performance.now) ? performance.now() : Date.now(); }
    var t0 = nowms();
    return fetch('/api/tool/' + encodeURIComponent(name), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({args: args || {}, confirm: !!opts.confirm})
    }).then(function(r){ return r.json(); }).then(function(res){
      res.ms = (res.ms != null) ? res.ms : Math.round(nowms() - t0);
      TCALLS++; if(!res.ok) TFAILS++;
      pushLog(res);
      if(opts.onDone) opts.onDone(res);
      return res;
    }).catch(function(e){
      var res = {ok:false, tool:name, perm:toolMeta(name).perm, ms:Math.round(nowms()-t0),
                 error:'本机服务无响应（' + ((e && e.message) || e) + '）', data:{}};
      TCALLS++; TFAILS++; pushLog(res);
      if(opts.onDone) opts.onDone(res);
      return res;
    });
  }
  function briefOf(res){
    if(res.need_confirm) return '等待确认（这个工具会写盘）';
    if(!res.ok) return res.error || '失败';
    var d = res.data || {};
    if(d.rows) return d.rows.length + ' 条编排';
    if(d.questions) return d.questions.length + ' 题' + (d.total ? ' / 共 ' + d.total : '');
    if(d.is_word_lesson === false) return '非单词课，按规则不给词表';
    if(d.words && d.words.length) return d.words.length + ' 词';
    if(d.subjects) return d.subjects.length + ' 门科目';
    if(d.groups) return d.groups.length + ' 章 / ' + (d.lessons_total||0) + ' 讲';
    if(d.papers) return d.papers.length + ' 套卷 · ' + (d.total_questions||0) + ' 题';
    if(d.by_part) return d.by_part.length + ' 个考点有错题';
    if(d.lessons && d.lessons.total) return d.lessons.done + '/' + d.lessons.total + ' 讲';
    if(d.mem) return (d.ok ? '答对' : '答错') + ' → box' + d.mem.box + ' · 到期 ' + d.mem.due;
    if(d.ans !== undefined) return (d.ok ? '答对' : '答错') + '，已入库';
    if(d.key) return d.key + (d.count ? ' · ' + d.count + ' 词' : '');
    if(d.calls) return d.calls.length + ' 条审计';
    return 'ok';
  }
  function pushLog(res){
    TLOG.unshift({t:new Date().toTimeString().slice(0,8), n:res.tool, ok:!!res.ok,
      need:!!res.need_confirm, ms:res.ms||0, perm:res.perm || toolMeta(res.tool).perm,
      brief:briefOf(res)});
    if(TLOG.length > 12) TLOG.pop();
    renderLog();
  }
  function renderLog(){
    var box = $('#toollog'); if(!box) return;
    if(!TLOG.length){ box.innerHTML = '<div class="sub" style="padding:16px 22px">切页面就会触发真实工具调用</div>'; return; }
    box.innerHTML = TLOG.map(function(x){
      return '<div class="logrow"><span class="t">' + x.t + '</span>' +
        '<span class="n">' + esc(x.n) + '()</span>' +
        '<span class="r">' + esc(x.brief || '') + '</span>' +
        '<span class="ms num">' + (x.ms||0) + 'ms</span>' +
        '<span class="bdg ' + (x.ok ? 'ok' : (x.need ? 'warn' : 'bad')) + '">' +
        (x.ok ? 'ok' : (x.need ? '待确认' : '失败')) + '</span></div>';
    }).join('');
  }
  function noteEvent(kind, body){
    try{
      var b = body || {}; b.kind = kind;
      fetch('/api/event', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(b)});
    }catch(e){}
  }
"""

NEW_NAV = r"""  /* ---------- 页面元信息 ---------- */
  var PAGES = {
    today:{k:'今日',t:'今日',s:'今日编排按「断点续学 > 到期复习 > 最大错因 > 未开科目」现场算'},
    classroom:{k:'课堂',t:'课堂',s:'一屏学完一讲：视频 + 讲义 + 本讲词群 + 当堂测'},
    courses:{k:'课程库',t:'课程库',s:'5 门主体课程 + 本地资料 · 进度直接读本机数据'},
    schedule:{k:'课表',t:'课表',s:'计划由规则生成，完成情况来自真实记录'},
    vocab:{k:'背单词',t:'背单词',s:'SM-2 记忆状态存在本机数据库，评分即落库'},
    practice:{k:'练习',t:'练习',s:'英语语法 781 题 · 判分在服务端，不提前泄答案'},
    exam:{k:'考场',t:'考场',s:'15 套真题 995 题 · 答案来自 exam_papers.json'},
    stats:{k:'统计',t:'统计',s:'只展示能核对到源头的数字'},
    agent:{k:'Agent',t:'Agent 工具台',s:'所有能力都是可调用工具，点一行就真调一次'}
  };

  /* ---------- 选中状态（用户手动选的东西） ---------- */
  var SEL = {subject:'english', lesson:null, group:null, part:null, paper:null};
  var SUB_MAP = {}; SUB.forEach(function(s){ SUB_MAP[s.id]=s; });
  function subById(id){ return SUB_MAP[id] || null; }
  function enSubject(){ return subById('english') || EN; }

  /* ---------- 导航 ---------- */
  var PAGE_TOOLS = {
    today:    [['plan_today',        function(){ return {}; }]],
    classroom:[['get_current_lesson',function(){ return {subject:SEL.subject}; }],
               ['list_lessons',      function(){ return {subject:SEL.subject}; }]],
    courses:  [['list_subjects',     function(){ return {}; }]],
    schedule: [['plan_today',        function(){ return {}; }]],
    vocab:    [['list_word_group',   function(){ return SEL.group ? {key:SEL.group} : {}; }]],
    practice: [['pick_question_part',function(){ return SEL.part ? {part:SEL.part} : {}; }]],
    exam:     [['list_exam_papers',  function(){ return {}; }]],
    stats:    [['stats_overview',    function(){ return {}; }]],
    agent:    [['recent_tool_calls', function(){ return {limit:12}; }]]
  };
  function go(p){
    [].forEach.call(document.querySelectorAll('.navitem'),function(b){ b.classList.toggle('on', b.getAttribute('data-p')===p); });
    [].forEach.call(document.querySelectorAll('.page'),function(s){ s.classList.toggle('on', s.id==='p-'+p); });
    var m=PAGES[p]; if(m){ $('#pkick').textContent=m.k; $('#ptitle').textContent=m.t; $('#psub').textContent=m.s; }
    $('#view').scrollTop=0; window.scrollTo(0,0);
    if(('#'+p)!==location.hash){ try{ history.replaceState(null,'','#'+p); }catch(e){} }
    noteEvent('page', {payload:p});
    loadPage(p);
  }
  function loadPage(p){
    var list = PAGE_TOOLS[p] || [];
    for(var i=0;i<list.length;i++){
      (function(name, argFn){
        callTool(name, argFn(), {onDone:function(res){ paintFor(p, name, res); }});
      })(list[i][0], list[i][1]);
    }
  }
  function paintFor(p, tool, res){
    if(p==='today' || p==='schedule') return paintToday(res);
    if(p==='classroom') return paintClassroom(tool, res);
    if(p==='courses') return paintCourses(res);
    if(p==='vocab') return paintVocabGroup(res);
    if(p==='practice') return paintPractice(tool, res);
    if(p==='exam') return paintExam(tool, res);
    if(p==='stats') return paintStats(res);
    if(p==='agent') return paintAgent(res);
  }
  document.addEventListener('click',function(e){
    var t = e.target.closest('[data-p]');
    if(!t) return;
    e.preventDefault();
    var sub = t.getAttribute('data-sub');
    if(sub) SEL.subject = sub;
    go(t.getAttribute('data-p'));
  });
  window.addEventListener('hashchange',function(){
    var p=(location.hash||'').replace(/^#/,'').split('|')[0];
    var on=document.querySelector('.navitem.on');
    if(PAGES[p] && (!on || on.getAttribute('data-p')!==p)) go(p);
  });
"""

NEW_SIDEBAR = r"""  /* ---------- 侧栏：接着学 / 最近 7 天 ---------- */
  var next = (enSubject().next) || {};
  $('#resumeT').textContent = next.title || '—';
  $('#resumeM').textContent = (next.chapter||'') + ' · ' + mss(next.dur);
  var k = D.kpi || {};
  $('#cntCourses').textContent = k.lesson_total || 0;
  $('#cntVocab').textContent = (k.mem_xuecheng||0) + '/' + (k.vocab_total||0);
  $('#chipMin').textContent = mins((D.events||{}).today_seconds || 0);
  (function(){
    var nav=$('#nav');
    var pv=nav.querySelector('[data-p="practice"] .cnt'); if(pv) pv.textContent = ((D.exercise_bank||{}).total||0) + ' 题';
    var ev=nav.querySelector('[data-p="exam"] .cnt'); if(ev) ev.textContent = ((D.exam||{}).papers||[]).length + ' 套';
    var ag=nav.querySelector('[data-p="agent"] .cnt'); if(ag) ag.textContent = (D.tools||[]).length + ' 个';
  })();
"""

NEW_TODAY = r"""  /* ---------- 今日 ---------- */
  var curry = D.vocab.current || {};
  var PLAN = null;
  function wd(d){ return ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]; }
  function paintHeroKick(){
    var n=new Date();
    $('#heroKick').innerHTML = '<b>' + (n.getMonth()+1) + ' 月 ' + n.getDate() + ' 日 · ' + wd(n) + '</b> · 数据来自本机';
  }
  function paintKpi(){
    var kk=D.kpi||{}, ev=D.events||{};
    $('#kpis').innerHTML = [
      ['讲次进度', kk.lesson_done||0, '/ ' + (kk.lesson_total||0) + ' 讲'],
      ['词入记忆', kk.mem_xuecheng||0, '词 · 到期 ' + (kk.due_today||0)],
      ['真题卷', kk.exam_papers||0, '套 · 已答 ' + (kk.answered||0) + ' 题'],
      ['今日投入', mins(ev.today_seconds||0), '分钟 · ' + (ev.today_count||0) + ' 个动作']
    ].map(function(x){
      return '<div class="kpi"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'<small>'+x[2]+'</small></div></div>';
    }).join('');
  }
  function paintHero(){
    var en=enSubject(), nx=en.next||{};
    $('#heroLead').textContent = nx.title
      ? ('接着上次：「' + nx.title + '」（' + (nx.chapter||'') + '，' + mins(nx.dur) + ' 分钟）。' +
         (k.due_today ? '今天有 ' + k.due_today + ' 个词到期。' : ''))
      : '这门课已经全部上完。';
    $('#heroCap').textContent = (en.video_up||'') + ' · ' + (nx.local ? '本地 MP4 · 可离线' : 'B 站 · 免登录');
    var im=$('.hero-art img'); if(im && en.cover) im.src = en.cover;
  }
  function paintStreak(){
    var days=(D.events||{}).days7||{};
    var box=$('#streak'); if(!box) return;
    var n=new Date();
    var todayStr = n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
    var keys=Object.keys(days).sort().slice(-7);
    box.innerHTML = keys.length
      ? keys.map(function(d){ return '<i class="'+(d===todayStr?'f':'')+'" title="'+d+' · '+days[d]+' 分钟"></i>'; }).join('')
      : '<i title="还没有学习记录"></i>';
  }
  function adviceText(){
    var kk=D.kpi||{}, rows=(PLAN&&PLAN.rows)||[], t=[];
    if(rows[0]) t.push('先做第 1 项：<em class="a">' + esc(rows[0].title) + '</em>。');
    var zero = SUB.filter(function(s){ return (s.score||0) > 0 && !s.lessons_done; });
    if(zero.length) t.push('还有 ' + zero.length + ' 门计分科目一讲都没动（' +
      zero.map(function(s){ return esc(s.name); }).join('、') + '），其中 <em class="a">' +
      esc(zero[0].name) + '</em> 占 ' + zero[0].score + ' 分。');
    if(kk.due_today) t.push('今天有 <em class="a">' + kk.due_today + '</em> 个词到期，别堆到明天。');
    if(!kk.answered) t.push('练习一道都还没做过，正确率暂时为空——不是 0%，是还没有数据。');
    t.push('规则：' + esc((PLAN && PLAN.rule) || '—'));
    return t.join(' ');
  }
  function paintToday(res){
    if(res && res.ok) PLAN = res.data;
    var rows=(PLAN&&PLAN.rows)||[];
    $('#todaylist').innerHTML = rows.length
      ? rows.map(function(r,i){
          return '<div class="row"><span class="idx">0'+(i+1)+'</span><span class="bar '+r.cls+'"></span>'+
            '<span class="tt"><b>'+esc(r.title)+'</b><span>'+esc(r.meta)+'</span></span>'+
            '<span class="rt"><button class="btn sm'+(i===0?' act':'')+'" data-todo="'+i+'">'+esc(r.action)+'</button></span></div>';
        }).join('')
      : '<div class="sub" style="padding:16px 22px">没有可编排的任务</div>';
    $('#adviceToday').innerHTML = adviceText();
    paintWeekDone(); paintSubjProg(); paintKpi(); paintHero(); paintStreak();
  }
  function paintWeekDone(){
    var en=enSubject(), d=(en.done||[]).slice().reverse();   /* 全量，不截断成 6 条 */
    $('#weekDone').innerHTML = d.length
      ? d.map(function(x,i){
          return '<div class="row"><span class="idx">0'+(i+1)+'</span><span class="bar '+clsOf(en.id)+'"></span>'+
            '<span class="tt"><b>'+esc(x.title)+'</b><span>'+esc(x.chapter||'')+' · '+mss(x.dur)+'</span></span>'+
            '<span class="rt"><span class="bdg ok">已完成</span></span></div>';
        }).join('')
      : '<div class="sub" style="padding:16px 22px">还没有完成记录</div>';
  }
  function paintSubjProg(){
    $('#subjprog').innerHTML = ORDER.map(function(s){
      var p=pct(s.lessons_done||0, s.lessons_total||1);
      return '<div class="row"><span class="bar '+clsOf(s.id)+'"></span>'+
        '<span class="tt"><b>'+esc(s.name)+'</b><span>'+(s.lessons_done||0)+' / '+(s.lessons_total||0)+' 讲 · '+
        esc(s.kind||'')+(s.score? ' · '+s.score+' 分':'')+'</span></span>'+
        '<span class="rt" style="width:150px;display:flex;align-items:center;gap:10px">'+
        '<span class="bar '+clsOf(s.id)+'" style="flex:1"><i class="'+clsOf(s.id)+'" style="width:'+Math.max(p,1)+'%"></i></span>'+
        '<span class="num" style="font-size:11px;color:var(--tx3)">'+p+'%</span></span></div>';
    }).join('');
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-todo]'); if(!b) return;
    var r=((PLAN&&PLAN.rows)||[])[ +b.getAttribute('data-todo') ]; if(!r) return;
    if(r.subject) SEL.subject = r.subject;
    if(r.lesson_id) SEL.lesson = r.lesson_id;
    if(r.group) SEL.group = r.group;
    if(r.part) SEL.part = r.part;
    go(r.page || 'today');
  });
"""

NEW_SCHEDULE = r"""  /* ---------- 课表 ---------- */
  /* 课表页跟"今日编排"共用 plan_today 的结果：计划是规则现场算的，
     完成情况读 D.subjects[].done（本机记录）。这里不再单独放静态排期。 */
"""

NEW_COURSES = r"""  /* ---------- 课程库 ---------- */
  function paintCourses(res){
    var subs=(res && res.ok && res.data.subjects) || SUB;
    var cats=[['全部','all', subs.length]];
    subs.forEach(function(s){ cats.push([s.name, s.id, 1]); });
    cats.push(['资料','res', (D.resources||[]).length]);
    $('#courseCats').innerHTML = cats.map(function(c,i){
      return '<button class="chip'+(i===0?' on':'')+'" data-cat="'+c[1]+'">'+esc(c[0])+' <span class="n">'+c[2]+'</span></button>';
    }).join('');
    var cards = subs.map(function(s){
      var p=pct(s.lessons_done||0, s.lessons_total||1);
      var last=((s.done||[]).slice(-1)[0]) || null;
      var now = last ? ('已上到：'+last.title) : ('未开始 · 第一讲：'+((s.next||{}).title||'—'));
      return '<article class="cc" data-subj="'+s.id+'"><div class="cover"><img src="'+esc(s.cover||'img/cover.jpg')+'" alt="">'+
        '<span class="kind bdg">'+(s.next && s.next.local ? '本地 MP4':'B 站')+'</span>'+
        '<span class="dur">'+(s.video_pages||s.lessons_total||0)+' P</span>'+
        '<span class="pl"><i><svg class="ic" style="width:22px;height:22px"><use href="#i-play"/></svg></i></span></div>'+
        '<div class="bd"><h4>'+esc(s.name)+'</h4>'+
        '<div class="tg"><span class="bdg">'+esc(s.kind||'')+'</span><span class="bdg">'+(s.score? s.score+' 分':'不计总分')+'</span>'+
        '<span class="bdg">'+(s.next&&s.next.local?'本地片源':'B 站 '+esc(s.bvid||''))+'</span></div>'+
        '<div class="pr"><span class="bar '+clsOf(s.id)+'"><i class="'+clsOf(s.id)+'" style="width:'+Math.max(p,1)+'%"></i></span><b>'+(s.lessons_done||0)+' / '+(s.lessons_total||0)+' 讲</b></div>'+
        '<div class="now">'+esc(now)+'</div>'+
        '<div class="foot"><button class="btn '+(p>0?'act':'')+' block" data-p="classroom" data-sub="'+s.id+'">'+(p>0?'继续学习':'开始第一讲')+'</button></div></div></article>';
    }).join('');
    var wm=(D.wordmap||{}).summary||{};
    cards += '<article class="cc" data-subj="vocab-book"><div class="cover"><img src="img/mnemo.jpg" alt="词表">'+
      '<span class="kind bdg">本地 · 词表</span><span class="dur">'+((D.vocab||{}).lists||[{}])[0].count+' 词</span>'+
      '<span class="pl"><i><svg class="ic" style="width:22px;height:22px"><use href="#i-play"/></svg></i></span></div>'+
      '<div class="bd"><h4>刘晓艳《专升本你还在背单词吗》</h4>'+
      '<div class="tg"><span class="bdg">'+((D.vocab||{}).lists||[{}])[0].count+' 词</span><span class="bdg">Unit 1–12</span>'+
      '<span class="bdg">'+(wm.wb_groups||0)+' 组</span></div>'+
      '<div class="pr"><span class="bar vo"><i class="vo" style="width:'+Math.max(pct(wm.mapped_words||0, wm.check_total||1),1)+'%"></i></span>'+
      '<b>有视频可覆盖 '+(wm.mapped_words||0)+' / '+(wm.check_total||0)+' 词</b></div>'+
      '<div class="now">另有 '+((wm.appendix_groups)||0)+' 组讲义附录词没有对应视频</div>'+
      '<div class="foot"><button class="btn act block" data-p="vocab">去背单词</button></div></div></article>';
    $('#courselist').innerHTML = cards;
    $('#reslist').innerHTML = (D.resources||[]).map(function(r){
      return '<div class="row"><span class="bar"></span><span class="tt"><b>'+esc(r.label)+'</b><span>'+esc(r.file)+'</span></span>'+
        '<span class="rt"><span class="bdg">'+esc(r.kind)+'</span><span class="num" style="font-size:12px">'+
        (r.kb? r.kb+' KB' : (r.pdf? r.pdf+' 份 PDF':''))+'</span></span></div>';
    }).join('');
  }
"""

NEW_CLASSROOM = r"""  /* ---------- 课堂 ---------- */
  var CLS_S = {lesson:null, subject:null, words:[], pos:0, toc:null};
  function paintClassroom(tool, res){
    if(!res.ok){
      if(tool==='pick_lesson') $('#dwWhy').textContent = '选讲失败：' + (res.error||'');
      return;
    }
    if(tool==='get_current_lesson'){
      CLS_S.lesson = res.data.lesson;
      CLS_S.subject = res.data.subject;
      CLS_S.pos = res.data.pos_sec || 0;
      if(!SEL.lesson) SEL.lesson = (res.data.lesson||{}).id;
      paintStage(); paintTocProgress(res.data); loadDock();
    } else if(tool==='list_lessons'){
      CLS_S.toc = res.data; paintToc(res.data);
    } else if(tool==='list_lesson_words'){
      paintDockWords(res.data);
    } else if(tool==='pick_lesson'){
      var sub = subById(res.data.subject) || CLS_S.subject;
      CLS_S.lesson = res.data.lesson; CLS_S.subject = sub; CLS_S.pos = 0;
      paintStage(); paintToc(sublistRefresh()); loadDock();
      callTool('list_lessons',{subject:SEL.subject},{onDone:function(r2){ if(r2.ok){ CLS_S.toc=r2.data; paintToc(r2.data); } }});
    }
  }
  function sublistRefresh(){ return CLS_S.toc || {groups:[], lessons_done:0, lessons_total:0}; }
  function biliUrl(les, sub){
    var bv=(les&&les.bvid)||(sub&&sub.bvid)||'';
    return 'https://www.bilibili.com/video/' + bv + '?p=' + ((les&&les.page)||1);
  }
  function paintStage(){
    var les=CLS_S.lesson||{}, sub=CLS_S.subject||enSubject();
    if(!les.id) return;
    $('#clsTitle').textContent = les.title || '—';
    $('#clsSub').textContent = (sub.name||'') + ' · ' + (sub.video_up||'') + ' · ' + (les.chapter||'') +
      ' · 本讲约 ' + mins(les.dur) + ' 分钟（课程文件实测）';
    $('#selLessonT').textContent = les.title || '—';
    $('#selSubjectT').textContent = sub.name || '—';
    var dot=$('#selSubject .dot'); if(dot) dot.className = 'dot ' + clsOf(sub.id);
    $('#clsSrc').textContent = les.local ? '本地 MP4 · 可离线' : ('B 站 · ' + (les.bvid||''));
    $('#followT').textContent = (CLS_S.manual ? '手动选讲' : '跟随进度');
    $('#daHint').textContent = '问题会带上「' + (les.title||'') + '」一起发出去。';
    var na=$('#dnArea'); if(na) na.value = localStorage.getItem('note:' + les.id) || '';
    var ns=$('#dnState'); if(ns) ns.textContent = '笔记按讲次存在本机浏览器';
    mountPlayer(les, sub);
  }
  function paintTocProgress(d){
    $('#tocProgT').textContent = ((d.subject||{}).name||'') + ' · 已完成';
    $('#tocProg').textContent = (d.lessons_done||0) + ' / ' + (d.lessons_total||0);
    var bar=$('#tocList2').parentNode.querySelector('.pr .bar > i');
    if(bar) bar.style.width = Math.max(pct(d.lessons_done||0, d.lessons_total||1),1) + '%';
  }
  function mountPlayer(les, sub){
    var scr=$('#screen');
    var old=$('#vid'); if(old){ try{ old.pause(); }catch(e){} old.remove(); }
    var pv=$('#vposter'), ov=$('#vplay');
    if(les.local){
      if(pv) pv.style.display='none';
      if(ov) ov.style.display='none';
      var v=document.createElement('video');
      v.id='vid'; v.controls=true; v.preload='metadata';
      v.setAttribute('playsinline','');
      v.src = '/media/' + encodeURI(String(les.local).replace(/\\/g,'/'));
      v.style.cssText='width:100%;height:100%;object-fit:contain;background:#000';
      scr.insertBefore(v, scr.firstChild);
      var lastSync=0;
      v.addEventListener('loadedmetadata', function(){
        $('#vtimes').textContent = mss(v.currentTime) + ' / ' + mss(v.duration);
        if(CLS_S.pos > 5 && CLS_S.pos < v.duration - 3){
          v.currentTime = CLS_S.pos;
          $('#vsrc').textContent = '本地 MP4 · 已跳到上次 ' + mss(CLS_S.pos);
        }
      });
      v.addEventListener('timeupdate', function(){
        $('#vtimes').textContent = mss(v.currentTime) + ' / ' + mss(v.duration || les.dur || 0);
        $('#plineNow').textContent = mss(v.currentTime);
        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)});
        }
      });
      $('#vsrc').textContent = '本地 MP4 · 可离线';
    } else {
      if(pv){ pv.style.display=''; pv.src = sub.cover || 'img/cover.jpg'; }
      if(ov){ ov.style.display=''; ov.setAttribute('data-href', biliUrl(les, sub)); }
      $('#vsrc').textContent = 'B 站 · 第 ' + (les.page||1) + ' P（点播放键去官网）';
      $('#vtimes').textContent = '00:00 / ' + mss(les.dur||0);
      $('#plineNow').textContent = '00:00';
    }
  }
  function paintAnchors(words, dur, pos){
    var wrap=$('#plineNow') && $('#plineNow').closest('.barwrap'); if(!wrap) return;
    var bar=wrap.querySelector('.bar > i');
    [].forEach.call(wrap.querySelectorAll('.mk'),function(m){ m.remove(); });
    var frac = (dur && pos) ? Math.min(pos/dur, 1) : 0;
    if(bar) bar.style.width = Math.round(frac*100) + '%';
    var n=(words||[]).length;
    if(!n || !dur) return;
    words.slice(0,6).forEach(function(w,i){
      var f=(i+1)/(n+1);
      var el=document.createElement('span');
      el.className='mk'+(Math.abs(f-frac)<0.06?' now':'');
      el.style.left=Math.round(f*100)+'%';
      el.title=w.w;
      el.setAttribute('data-word', w.w);
      wrap.appendChild(el);
    });
  }
  function loadDock(){
    var les=CLS_S.lesson; if(!les || !les.id) return;
    callTool('list_lesson_words', {lesson_id:les.id}, {onDone:function(res){ paintClassroom('list_lesson_words', res); }});
    loadLessonExtras(les);
  }
  function loadLessonExtras(les){
    var sub=CLS_S.subject||enSubject();
    // 讲义面板：本机资料里有什么就说什么，不编页码
    var dp=$('#dpLinks');
    if(dp){
      var rs=(D.resources||[]).filter(function(r){ return (r.label||'').indexOf('英')>=0 || (r.label||'').indexOf('讲义')>=0; });
      var list = rs.length? rs : (D.resources||[]).slice(0,3);
      dp.innerHTML = list.map(function(r){
        return '<span class="bdg">' + esc(r.label) + '</span>';
      }).join('');
    }
    $('#dpHead').textContent = (sub.name||'') + ' · 本机资料';
    $('#dpNote').textContent = '讲义是整本扫描件，没有按讲次切页，所以这里不指页码。' +
      '本讲视频：' + (les.local ? '本地文件已就位，可直接播。' : '在 B 站第 ' + (les.page||1) + ' P。');
  }
  function paintDockWords(d){
    var dw=$('#dwlist');
    if(d.is_word_lesson){
      CLS_S.words = d.words || [];
      $('#dwhead').textContent = (d.key||'') + ' · ' + d.count + ' 词';
      dw.innerHTML = (d.words||[]).map(function(w){
        return '<div class="wordline" data-word="'+esc(w.w)+'"><b>'+esc(w.w)+'</b>' +
          '<span class="ph">'+esc(String(w.ph||'').replace(/^英/,''))+'</span>' +
          '<span class="cn">'+esc(w.cn||'')+'</span></div>';
      }).join('');
      $('#dwWhy').textContent = '这一讲在 wordmap 里映射到「' + (d.key||'') + '」，所以只给这一讲的词；点词看构词，不打断播放。';
      paintTestPanel(null);
    } else {
      CLS_S.words = [];
      var c=d.content||{};
      $('#dwhead').textContent = '本讲没有词群 · 这是' + (c.subject_name||'英语') + '的语法/精讲讲次';
      var pts=c.points||[];
      dw.innerHTML = pts.length
        ? pts.map(function(p){ return '<div class="wordline"><b>'+esc(p)+'</b><span class="cn">从讲次标题括号里提取的考点</span></div>'; }).join('')
        : '<div class="sub" style="padding:14px 0">这一讲的标题里没有标注考点</div>';
      $('#dwWhy').textContent = '规则：只有词汇讲次才给词表。语法/精讲课不给单词课的词（以前把别的讲的词挂在这里，是错的）。';
      paintTestPanel(c);
    }
    paintAnchors(CLS_S.words, (CLS_S.lesson||{}).dur, CLS_S.pos);
  }
  function paintTestPanel(c){
    var sub=CLS_S.subject||enSubject();
    if(sub.id==='english'){
      var bank=D.exercise_bank||{};
      $('#dqHead').textContent = '当堂测 · 英语语法题库';
      var pts=((c&&c.points)||[]);
      $('#dqNote').textContent = (pts.length? ('本讲考点：'+pts.join('、')+'。') : '') +
        '题库共 ' + (bank.total||0) + ' 题、' + ((bank.parts||[]).length) + ' 个考点分部，判分在服务端做，答错自动进错因表。';
      $('#dqSub').textContent = '来源：workbench/data/exercises.json';
      $('#dqStart').textContent = '去练习页刷这科';
      $('#dqStart').setAttribute('data-dq','practice');
    } else {
      var cards=(c&&c.cards)||[];
      $('#dqHead').textContent = '当堂测 · ' + (sub.name||'');
      $('#dqNote').textContent = cards.length
        ? ('这门课有 ' + cards.map(function(x){ return x.name + ' ' + x.count + ' 条'; }).join('、') + '，可以按考点卡自测。')
        : '这门课目前没有可判分的题目数据，不给假题。';
      $('#dqSub').textContent = cards.length ? '来源：workbench/data/point_cards.json' : '暂无题目源';
      $('#dqStart').textContent = cards.length ? '去看考点卡' : '暂无可用题';
      $('#dqStart').setAttribute('data-dq','vocab');
    }
  }
  function paintToc(d, kw){
    if(!d || !d.groups) return;
    var cur=(CLS_S.lesson||{}).id;
    var q=(kw||'').trim().toLowerCase();
    var shown=0;
    var html = d.groups.map(function(g){
      var kids=(g.lessons||[]);
      if(q) kids = kids.filter(function(l){ return (l.title||'').toLowerCase().indexOf(q) >= 0; });
      if(!kids.length) return '';
      shown += kids.length;
      var hasCur=(g.lessons||[]).some(function(l){ return l.id===cur; });
      return '<div class="tocch'+((hasCur||q)?' open':'')+'">' +
        '<button class="tocch-h"><svg class="ic cv"><use href="#i-chev"/></svg>' + esc(g.chapter) +
        '<span class="n">' + kids.length + '</span></button>' +
        '<div class="tocch-kids">' + kids.map(function(l){
          var st = (l.id===cur) ? 'cur' : (l.done ? 'done' : '');
          return '<button class="tocit'+(l.id===cur?' on':'')+'" data-l="'+esc(l.id)+'">' +
            '<span class="st '+st+'"></span><span class="nm">'+esc(l.title)+'</span>' +
            '<span class="du">'+(l.is_word_lesson?'词汇':'精讲')+' · '+mss(l.dur)+'</span></button>';
        }).join('') + '</div></div>';
    }).join('');
    $('#tocList2').innerHTML = html || '<div class="sub" style="padding:16px 18px">本门课没有匹配「' + esc(kw) + '」的讲次</div>';
    $('#tocProg').textContent = q ? (shown + ' / ' + (d.lessons_total||0) + ' 讲（筛选）')
                                  : ((d.lessons_done||0) + ' / ' + (d.lessons_total||0));
  }
  $('#tocList2').addEventListener('click',function(e){
    var h=e.target.closest('.tocch-h');
    if(h){ h.parentNode.classList.toggle('open'); return; }
    var it=e.target.closest('.tocit'); if(!it) return;
    CLS_S.manual = true;
    callTool('pick_lesson', {lesson_id: it.getAttribute('data-l'), subject: SEL.subject},
      {onDone:function(res){ paintClassroom('pick_lesson', res); }});
  });
  $('#tocBtn').addEventListener('click',function(){
    var off=$('#cls3').classList.toggle('hide');
    $('#tocBtnT').textContent = off ? '展开目录' : '收起目录';
  });
  document.addEventListener('click',function(e){
    var b=e.target.closest('#vplay');
    if(b){
      var href=b.getAttribute('data-href');
      if(href){ window.open(href,'_blank'); noteEvent('play',{lesson_id:(CLS_S.lesson||{}).id}); }
      else { var v=$('#vid'); if(v){ if(v.paused){ v.play(); } else { v.pause(); } } }
      return;
    }
    var seg=e.target.closest('#selSubject');
    if(seg){ toggleClsMenu(); return; }
    var sl=e.target.closest('#selLesson');
    if(sl){ $('#cls3').classList.remove('hide'); $('#tocBtnT').textContent='收起目录'; return; }
    var mi=e.target.closest('#clsMenu [data-m-sub]');
    if(mi){
      SEL.subject = mi.getAttribute('data-m-sub'); SEL.lesson = null; CLS_S.manual=false;
      CLS_S.lesson = null;
      $('#clsMenu').hidden = true;
      callTool('get_current_lesson',{subject:SEL.subject},{onDone:function(r){ paintClassroom('get_current_lesson', r); }});
      callTool('list_lessons',{subject:SEL.subject},{onDone:function(r2){ paintClassroom('list_lessons', r2); }});
      return;
    }
    var dw=e.target.closest('#dwlist [data-word]');
    if(dw){ showWordCard(dw.getAttribute('data-word')); return; }
    var dq=e.target.closest('#dqStart');
    if(dq){
      var to=dq.getAttribute('data-dq');
      if(to==='practice'){
        var parts=((D.exercise_bank||{}).parts)||[];
        if(parts.length) SEL.part = parts[0].name;
        go('practice');
      } else { go('vocab'); }
      return;
    }
    var da=e.target.closest('#daBtn');
    if(da){
      var q=($('#daArea')||{}).value || '';
      callTool('ask_ai', {question: q, lesson_id:(CLS_S.lesson||{}).id}, {onDone:function(r){
        var d=r.data||{};
        $('#daOut').className='explain reveal on';
        $('#daOutT').textContent = d.answer || ((d.reason||'') + '。' + (d.note||''));
      }});
      return;
    }
  });
  function toggleClsMenu(){
    var m=$('#clsMenu');
    if(!m.hidden){ m.hidden=true; return; }
    callTool('list_subjects', {}, {onDone:function(res){
      var subs=(res.data||{}).subjects||[];
      m.innerHTML = subs.map(function(s){
        return '<button data-m-sub="'+s.id+'"'+(s.id===SEL.subject?' style="color:var(--act)"':'')+'>' +
          '<span class="dot '+s.cls+'" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px"></span>' +
          esc(s.name) + '<span class="sub" style="margin-left:10px">' + s.lessons_done + '/' + s.lessons_total + ' 讲' +
          (s.score? ' · '+s.score+' 分':'') + '</span></button>';
      }).join('');
      m.hidden = false;
    }});
  }
  function showWordCard(word){
    var v=$('#vid');
    var wasPlaying = !!(v && !v.paused);
    callTool('fetch_word_detail', {word:word}, {onDone:function(res){
      var d=res.data||{};
      var seg=(((d.fallback||{}).segments)||[]).map(function(s){ return s.part + '（' + s.meaning + '）'; }).join(' + ');
      $('#dwWhy').innerHTML = '<b style="color:var(--tx)">' + esc(word) + '</b> · ' + esc(seg || '—') +
        '<br><span style="color:var(--tx3)">' + esc(d.available ? (d.source||'') : (d.reason||'')) +
        '　' + esc((d.fallback||{}).caveat||'') + '</span>';
      if(wasPlaying && v){ try{ v.play(); }catch(e){} }
      noteEvent('word_card', {word:word, lesson_id:(CLS_S.lesson||{}).id});
    }});
  }
  (function bindDockTabs(){
    var dock=$('#dockTabs');
    dock.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b) return;
      [].forEach.call(dock.querySelectorAll('button'),function(x){ x.classList.toggle('on', x===b); });
      [].forEach.call(document.querySelectorAll('.dpanel'),function(p){ p.classList.toggle('on', p.id===b.getAttribute('data-d')); });
    });
  })();
  (function bindNote(){
    var ta=$('#dnArea');
    ta.addEventListener('blur',function(){
      var les=(CLS_S.lesson||{}).id; if(!les) return;
      localStorage.setItem('note:' + les, ta.value);
      noteEvent('note', {lesson_id:les, payload:ta.value.slice(0,500)});
      $('#dnState').textContent = '已写入 · ' + new Date().toTimeString().slice(0,8);
    });
  })();
"""

NEW_PRACTICE = r"""/* ---------- 练习 ---------- */
  var PRAC = {part:null, list:[], idx:0, offset:0, judged:false, right:0, wrong:0};
  function paintPractice(tool, res){
    if(tool==='analyze_errors'){ if(res.ok) paintErrors(res.data); return; }
    if(!res.ok) return;
    var d=res.data||{};
    PRAC.part=d.part; SEL.part=d.part;
    PRAC.list=d.questions||[]; PRAC.idx=0; PRAC.offset=0;
    var bank=D.exercise_bank||{};
    $('#pracMeta').textContent = (bank.name||'题库') + ' · ' + (bank.total||0) + ' 题 · ' +
      ((bank.parts||[]).length) + ' 个考点 · 源文件 workbench/data/exercises.json';
    $('#pracParts').innerHTML = (d.parts||[]).map(function(p){
      var meta=((bank.parts||[]).filter(function(x){ return x.name===p.name; })[0])||{};
      var done=meta.done||0, wrong=meta.wrong||0;
      return '<button class="chip'+(p.name===d.part?' on':'')+'" data-part="'+esc(p.name)+'">' +
        esc(p.name.replace(/^第[一二三四五六七八九十]+部分：/,'')) +
        ' <span class="n">' + p.n + '</span>' +
        (done? '<span class="n" style="color:var(--ok)">做'+done+'</span>' : '') +
        (wrong? '<span class="n" style="color:var(--bad)">错'+wrong+'</span>' : '') + '</button>';
    }).join('');
    renderPracQ();
    paintSess();
    callTool('analyze_errors', {});
  }
  function renderPracQ(){
    if(!PRAC.list.length){
      $('#pracStem').textContent='这个考点暂时取不到题'; $('#pracOpts').innerHTML='';
      $('#pracNo').textContent='—'; $('#pracExp').classList.remove('on'); return;
    }
    var q=PRAC.list[PRAC.idx];
    PRAC.judged=false;
    $('#pracNo').textContent = '第 ' + q.no + ' 题' + (q.done ? '（做过）' : '');
    $('#pracPart').textContent = q.part || '';
    $('#pracStem').textContent = (q.stem||'') + (q.topic? ('　· '+q.topic) : '');
    $('#pracOpts').innerHTML = Object.keys(q.opts||{}).map(function(k){
      return '<button class="opt" data-k="'+k+'">' + '<i>'+k+'</i>' + esc(q.opts[k]) + '</button>';
    }).join('');
    $('#pracExp').classList.remove('on');
    $('#pracExpT').textContent='—';
    if($('#pracQuiz')) $('#pracQuiz').setAttribute('data-locked','0');
  }
  function paintSess(){
    if(!$('#pracSess')) return;
    var n=PRAC.right+PRAC.wrong;
    $('#pracSess').innerHTML =
      '<div class="s"><span class="k">本组进度</span><span class="v">' + Math.min(PRAC.idx+1, PRAC.list.length||1) + ' / ' + (PRAC.list.length||0) + '</span></div>' +
      '<div class="s"><span class="k">本次会话</span><span class="v">' + n + ' 题 · 对 ' + PRAC.right + ' 错 ' + PRAC.wrong + '</span></div>' +
      '<div class="s"><span class="k">正确率（本次）</span><span class="v">' + (n? Math.round(PRAC.right*100/n)+'%' : '—') + '</span></div>';
  }
  function paintErrors(d){
    var rows=(d && d.by_part) || [];
    $('#errlist').innerHTML = rows.length
      ? rows.map(function(r){
          return '<div class="row"><span class="bar"></span>' +
            '<span class="tt"><b>'+esc(r.part.replace(/^第[一二三四五六七八九十]+部分：/,''))+'</b>' +
            '<span>做过 '+r.done+' 题 · 错 '+r.wrong+' 题 · 来自本机作答记录</span></span>' +
            '<span class="rt num">'+r.wrong+'</span></div>';
        }).join('')
      : '<div class="sub" style="padding:16px 22px">还没有错题记录（本机 answers 表为空）——不是"没有错因"，是还没做过题</div>';
  }
  document.addEventListener('click',function(e){
    var opt=e.target.closest('#pracOpts .opt');
    if(opt){
      if(PRAC.judged) return;
      PRAC.judged=true;
      var k=opt.getAttribute('data-k'), q=PRAC.list[PRAC.idx];
      callTool('grade_answer', {qno:q.no, chosen:k, kind:'practice'}, {onDone:function(res){
        var d=res.data||{};
        [].forEach.call(document.querySelectorAll('#pracOpts .opt'),function(x){
          if(x.getAttribute('data-k')===d.ans) x.classList.add('ok');
          else if(x===opt) x.classList.add('bad');
        });
        $('#pracExpT').textContent = (d.explain||'—（题库里这道题没有解析）');
        $('#pracExp').classList.add('on');
        if(d.ok){ PRAC.right++; } else { PRAC.wrong++; }
        q.done=true;
        paintSess();
        callTool('analyze_errors', {}, {onDone:function(r2){ if(r2.ok) paintErrors(r2.data); }});
      }});
      return;
    }
    var chip=e.target.closest('#pracParts .chip');
    if(chip){
      PRAC.right=0; PRAC.wrong=0;
      callTool('pick_question_part', {part:chip.getAttribute('data-part')}, {onDone:function(res){ paintPractice('pick_question_part', res); }});
      return;
    }
    if(e.target.closest('#pracNext')){ pracStep(1); return; }
    if(e.target.closest('#pracPrev')){ pracStep(-1); return; }
    if(e.target.closest('#pracReset')){ PRAC.idx=0; PRAC.right=0; PRAC.wrong=0; renderPracQ(); paintSess(); return; }
  });
  function pracStep(dir){
    var i=PRAC.idx+dir;
    if(i>=PRAC.list.length){
      PRAC.offset = PRAC.offset + PRAC.list.length;
      callTool('pick_question_part', {part:PRAC.part, n:10, offset:PRAC.offset}, {onDone:function(res){
        if(res.ok && (res.data.questions||[]).length){ PRAC.list=res.data.questions; PRAC.idx=0; renderPracQ(); paintSess(); }
        else { $('#pracStem').textContent='这个考点刷完了，换个考点或从头再来。'; }
      }});
      return;
    }
    if(i<0) return;
    PRAC.idx=i; renderPracQ(); paintSess();
  }
"""

NEW_EXAM = r"""  /* ---------- 考场 ---------- */
  var EX = {papers:[], paper:null, meta:null, groups:[], gi:0, qs:[], qi:0, state:{},
            ticking:false, left:20*60, timer:null, submitted:false};
  function paintExam(tool, res){
    if(!res.ok) return;
    var d=res.data||{};
    if(tool==='list_exam_papers'){
      EX.papers=d.papers||[];
      if(!EX.paper && EX.papers.length) EX.paper = EX.papers[0].id;
      $('#examMeta').textContent = EX.papers.length + ' 套卷 · 共 ' + (d.total_questions||0) + ' 题';
      paintPaper();
      callTool('get_exam_paper', {paper_id:EX.paper, group_index:0}, {onDone:function(r){ paintExam('get_exam_paper', r); }});
      return;
    }
    if(tool==='get_exam_paper'){
      EX.meta=d.paper; EX.groups=d.groups||[]; EX.gi=d.group_index||0;
      EX.qs=(d.group||{}).questions||[]; EX.qi=0; EX.state={};
      EX.label=(d.group||{}).label||''; EX.gtype=(d.group||{}).type||'';
      EX.material=(d.group||{}).material||'';
      EX.qs.forEach(function(q){ if(q.state!==null && q.state!==undefined) EX.state[q.no]=q.state; });
      $('#examNameT').textContent = (EX.meta||{}).name || '—';
      $('#examMeta').textContent = (EX.meta||{}).total + ' 题 · 答案来自 exam_papers.json';
      paintPaper(); paintExamGroups(); paintExamQ(0); paintSheet();
      return;
    }
    if(tool==='grade_answer'){
      if(d.kind==='exam'){
        EX.state[d.qno]=d.ok?1:0;
        paintSheet();
        $('#examExp').classList.add('on');
        $('#examExpT').textContent = '正确答案 ' + d.ans + ' · ' + (d.ok? '你答对了' : '你选了 ' + (d.chosen||'—')) +
          '（本题已写入本机作答记录）';
      }
      return;
    }
  }
  function paintPaper(){
    var b=$('#examPick'); if(!b) return;
    var cur=EX.papers.filter(function(p){ return p.id===EX.paper; })[0];
    if(cur){
      $('#examNameT').textContent = cur.name;
      $('#examMeta').textContent = cur.total + ' 题 · 已答 ' + cur.answered + ' · 对 ' + cur.right + ' 错 ' + cur.wrong;
    }
  }
  function paintExamGroups(){
    var box=$('#examGroups'); if(!box) return;
    if(!EX.groups.length){ box.innerHTML=''; return; }
    box.innerHTML = EX.groups.map(function(g,i){
      return '<button class="chip'+(i===EX.gi?' on':'')+'" data-eg="'+i+'">' + esc(g.label) + ' <span class="n">' + g.count + '</span></button>';
    }).join('');
  }
  function paintExamQ(i){
    if(!EX.qs.length){ $('#examStem').textContent='这套卷的这个部分没有取到题目'; $('#examOpts').innerHTML=''; return; }
    EX.qi=Math.max(0, Math.min(i, EX.qs.length-1));
    var q=EX.qs[EX.qi];
    var pass=$('#examPassage');
    if(EX.material){ pass.style.display=''; pass.textContent = EX.material; }
    else { pass.style.display='none'; }
    $('#examQNo').textContent = '第 ' + q.no + ' 题 · ' + (EX.qi+1) + '/' + EX.qs.length;
    $('#examQLabel').textContent = EX.label + (EX.gtype? '（'+EX.gtype+'）' : '');
    $('#examStem').textContent = q.stem || '';
    $('#examOpts').innerHTML = Object.keys(q.opts||{}).map(function(k){
      return '<button class="opt" data-ek="'+k+'"><i>'+k+'</i>' + esc(q.opts[k]) + '</button>';
    }).join('');
    $('#examExp').classList.remove('on');
    $('#examExpT').textContent='—';
    var src=$('#examSrc');
    if(src){
      var st=EX.state[q.no];
      src.innerHTML =
        '<div class="kv"><span class="k">卷名</span><span class="v">' + esc((EX.meta||{}).name||'') + '</span><span class="bdg ok">原卷</span></div>' +
        '<div class="kv"><span class="k">题组</span><span class="v">' + esc(EX.label) + ' · 本组 ' + EX.qs.length + ' 题</span></div>' +
        '<div class="kv"><span class="k">本机作答</span><span class="v">' +
          (st===1? '答对过' : (st===0? '答错过' : '还没做')) + '</span>' +
        '<span class="bdg ' + (st===1? 'ok' : (st===0? 'bad' : '')) + '">' + (st===1? '对' : (st===0? '错' : '未作答')) + '</span></div>' +
        '<div class="kv"><span class="k">文件</span><span class="v">' + esc(((EX.meta||{}).pdf||'').split(/[\\\\/]/).slice(-1)[0] || '—') + '</span></div>';
    }
  }
  function paintSheet(){
    var total=(EX.meta||{}).total || EX.qs.length;
    var curNo=(EX.qs[EX.qi]||{}).no;
    var html='';
    for(var i=1;i<=Math.min(total,72);i++){
      var st=EX.state[i];
      var cls = (i===curNo) ? 'cur' : (st===1?'done':(st===0?'err':''));
      html += '<button class="'+cls+'" data-sheet="'+i+'">'+i+'</button>';
    }
    $('#sheet').innerHTML = html;
    var done=Object.keys(EX.state).length;
    var right=Object.keys(EX.state).filter(function(n){ return EX.state[n]===1; }).length;
    $('#sheetMeta').textContent = '已答 ' + done + ' / ' + total + ' · 对 ' + right + ' 错 ' + (done-right);
  }
  document.addEventListener('click',function(e){
    var o=e.target.closest('#examOpts .opt');
    if(o && EX.qs[EX.qi]){
      var q=EX.qs[EX.qi];
      if(EX.state[q.no]!==undefined) return;
      callTool('grade_answer', {qno:q.no, chosen:o.getAttribute('data-ek'), kind:'exam', part:EX.paper},
        {onDone:function(res){ paintExam('grade_answer', res); }});
      return;
    }
    var g=e.target.closest('#examGroups .chip');
    if(g){ EX.gi=+g.getAttribute('data-eg'); EX.qi=0;
      callTool('get_exam_paper', {paper_id:EX.paper, group_index:EX.gi}, {onDone:function(r){ paintExam('get_exam_paper', r); }});
      return; }
    var s=e.target.closest('#sheet [data-sheet]');
    if(s){ var no=+s.getAttribute('data-sheet'); var at=-1;
      EX.qs.forEach(function(x,i){ if(x.no===no) at=i; });
      if(at>=0){ paintExamQ(at); paintSheet(); } else { $('#examExpT').textContent='这一题在别的题组里，先切题组'; }
      return; }
    if(e.target.closest('#examNextQ')){ paintExamQ(EX.qi+1); paintSheet(); return; }
    if(e.target.closest('#examPrevQ')){ paintExamQ(EX.qi-1); paintSheet(); return; }
    if(e.target.closest('#examPick')){
      var host=$('#examPick').closest('.pickbar');
      var box=$('#examMenu');
      if(box && !box.hidden){ box.hidden=true; return; }
      if(!box){
        box=document.createElement('div');
        box.id='examMenu'; box.className='card';
        box.style.cssText='position:absolute;z-index:60;min-width:360px;padding:8px;margin-top:52px';
        host.appendChild(box);
      }
      box.innerHTML = EX.papers.map(function(p){
        return '<button data-m-paper="'+esc(p.id)+'"'+(p.id===EX.paper?' style="color:var(--act)"':'')+'>' +
          esc(p.name) + '<span class="sub" style="margin-left:10px">' + p.total + ' 题 · 已答 ' + p.answered + '</span></button>';
      }).join('');
      box.hidden=false;
      return;
    }
    var mp=e.target.closest('#examMenu [data-m-paper]');
    if(mp){
      EX.paper=mp.getAttribute('data-m-paper'); EX.state={}; EX.submitted=false;
      $('#examMenu').hidden=true;
      $('#examHint').textContent='绿色已答、红色错题。点题号跳到那一题；分数只按本机真实作答算。';
      callTool('get_exam_paper', {paper_id:EX.paper, group_index:0}, {onDone:function(r){ paintExam('get_exam_paper', r); }});
      paintPaper();
      return;
    }
    var tb=e.target.closest('#timerBtn');
    if(tb){
      EX.ticking=!EX.ticking;
      tb.innerHTML = EX.ticking ? '暂停计时' : '继续计时';
      if(EX.ticking && !EX.timer){
        EX.timer=setInterval(function(){
          if(!EX.ticking) return;
          if(EX.left>0){ EX.left--; }
          paintClock();
          if(EX.left % 60 === 0) noteEvent('exam_tick', {part:EX.paper, seconds:60});
        },1000);
      }
      return;
    }
    if(e.target.closest('#examSubmit')){
      if(EX.submitted) return;
      EX.submitted=true; EX.ticking=false;
      var done=Object.keys(EX.state).length;
      var right=Object.keys(EX.state).filter(function(n){ return EX.state[n]===1; }).length;
      var total=(EX.meta||{}).total||0;
      $('#examHint').innerHTML = '已交卷：做 ' + done + ' / ' + total + '，对 ' + right + '，错 ' + (done-right) +
        (done? '，本次正确率 ' + Math.round(right*100/done) + '%' : '，还没有作答记录');
      return;
    }
  });
  function paintClock(){
    $('#clock').textContent = String(Math.floor(EX.left/60)).padStart(2,'0') + ':' + String(EX.left%60).padStart(2,'0');
  }
"""

NEW_STATS = r"""  /* ---------- 统计 ---------- */
  function paintStats(res){
    var d=res.data||{};
    if(!res.ok) return;    $('#statsKpi').innerHTML = [
      ['课时', (d.lessons||{}).done||0, '/ ' + ((d.lessons||{}).total||0)],
      ['单词', (d.words||{}).in_memory||0, '/ ' + ((d.words||{}).total||0)],
      ['练习总量', (d.bank||{}).total||0, '题'],
      ['真题卷', d.exam_papers||0, '套']
    ].map(function(x){
      return '<div class="kpi"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'<small>'+x[2]+'</small></div></div>';
    }).join('');
    var examTotal = ((D.exam||{}).papers||[]).reduce(function(a,p){ return a + (p.total||0); }, 0);
    var bars=[
      ['词库 · 晓艳学丞', (d.words||{}).total||0, 'vo'],
      ['语法题库', (d.bank||{}).total||0, 'en'],
      ['真题 · 可判分题量', examTotal, 'ma'],
      ['考点卡 · 全部', ((d.point_cards||[]).reduce(function(a,c){ return a + (c.count||0); },0)), 'cs']
    ];
    var mx=Math.max.apply(null, bars.map(function(b){ return b[1]; }).concat([1]));
    $('#statsBars').innerHTML = bars.map(function(b){
      return '<div class="statrow"><span class="k">'+esc(b[0])+'</span>' +
        '<span class="bar '+b[2]+'"><i class="'+b[2]+'" style="width:'+Math.max(pct(b[1],mx),1)+'%"></i></span>' +
        '<span class="v">'+b[1]+'</span></div>';
    }).join('');
    var w=d.words||{};
    $('#fakeMeta').textContent = 'SM-2 · 入记忆 ' + (w.in_memory||0) + ' 词 · 今日到期 ' + (w.due_today||0);
    var boxes=w.boxes||{};
    var rows=Object.keys(boxes).sort().map(function(bx){
      return '<div class="memrow"><span class="w">box ' + bx + '</span>' +
        '<span class="box">' + [1,2,3,4,5].map(function(i){ return '<i class="'+(i<=+bx?'f':'')+'"></i>'; }).join('') + '</span>' +
        '<span class="v">' + boxes[bx] + ' 词</span></div>';
    });
    $('#statsMem').innerHTML = (rows.length? rows.join('') : '<div class="sub" style="padding:16px 22px">还没有任何词进入记忆状态</div>') +
      (d.answers && d.answers.answered
        ? '<div class="memrow"><span class="w">练习作答</span><span class="box"></span><span class="v">' +
          d.answers.answered + ' 题 · 正确率 ' + (d.answers.accuracy==null? '—' : d.answers.accuracy+'%') + '</span></div>'
        : '');
    $('#adviceNext').innerHTML = adviceText();
  }
"""

NEW_AGENT = r"""  /* ---------- Agent 工具台 ---------- */
  function paintAgent(res){
    var counts=(res.data||{}).counts || {};
    $('#toolreg').innerHTML = TOOLS.map(function(t){
      var c=counts[t.name]||0;
      return '<div class="toolrow" data-call="'+t.name+'" style="cursor:pointer">' +
        '<span class="dot '+(t.perm==='local'?'ok':(t.perm==='net'?'warn':'act'))+'" style="margin-right:2px"></span>' +
        '<span class="nm">' + t.name + '</span>' +
        '<span class="d">' + esc(t.desc) + '</span>' +
        '<span class="num" style="font-size:11px;color:var(--tx3);width:56px;text-align:right">' + c + ' 次</span>' +
        '<span class="bdg '+(t.perm==='local'?'ok':(t.perm==='net'?'warn':'act'))+'">' + t.perm + '</span></div>';
    }).join('');
    $('#jevNow').textContent = 'Jev 没有接进本机：这里显示的是规则引擎的真实排序结果，不产生「一致率」——没有比对对象的时候不给数字。';
    var rows=(PLAN&&PLAN.rows)||[];
    $('#jevCands').innerHTML = rows.length ? rows.map(function(r,i){
      return '<div class="c'+(i===0?' pick':'')+'"><span class="dot '+(i===0?'act':'')+'"></span>' +
        '<span style="font-size:13px">' + esc(r.title) + '</span>' +
        '<span class="w">' + (i===0? '选中' : '候选 ' + i) + '</span></div>';
    }).join('') : '<div class="sub" style="padding:12px 0">还没有编排结果</div>';
    $('#jevRule').innerHTML = '<span class="lbl">命中规则</span><p class="sub" style="margin-top:8px">' +
      esc((PLAN&&PLAN.rule)||'断点续学 > 到期复习 > 最大错因 > 未开科目') + '</p>';
    renderLog();
  }
  document.addEventListener('click',function(e){
    var t=e.target.closest('#toolreg [data-call]');
    if(!t) return;
    var name=t.getAttribute('data-call');
    callTool(name, {}, {onDone:function(){
      callTool('recent_tool_calls', {limit:12}, {log:false, onDone:function(r){
        if(r.ok) paintAgent(r);
        if(name==='plan_today') callTool('plan_today', {}, {log:false, onDone:function(r2){ if(r2.ok) paintToday(r2); }});
      }});
    }});
  });
"""

NEW_EXTRAS = r"""  /* ---------- 顶栏搜索：搜的是本机真数据 ---------- */
  var SEARCH_T = null;
  function searchPop(res){
    var box=$('#searchPop'); if(!box) return;
    if(!res.ok){
      box.innerHTML='<div class="sub" style="padding:14px 18px">'+esc(res.error||'搜索失败')+'</div>';
      box.hidden=false; return;
    }
    var d=res.data||{}, html='';
    if((d.lessons||[]).length){
      html += '<div class="sh">讲次 <span class="n">'+d.lessons.length+'</span></div>';
      html += d.lessons.map(function(l){
        return '<button data-go-lesson="'+esc(l.lesson_id)+'" data-go-subject="'+l.subject+'">'+
          '<span class="dot '+l.cls+'" style="margin-right:10px"></span><b>'+esc(l.title)+'</b>'+
          '<span class="sub">'+esc(l.subject_name)+' · '+esc(l.chapter||'')+' · '+mss(l.dur)+'</span></button>';
      }).join('');
    }
    if((d.words||[]).length){
      html += '<div class="sh">单词 <span class="n">'+d.words.length+'</span></div>';
      html += d.words.slice(0,8).map(function(w){
        return '<button data-go-group="'+esc(w.group)+'"><b>'+esc(w.w)+'</b>'+
          '<span class="sub">'+esc(w.cn||'')+'　'+esc(w.group)+'</span></button>';
      }).join('');
    }
    if((d.cards||[]).length){
      html += '<div class="sh">考点卡 <span class="n">'+d.cards.length+'</span></div>';
      html += d.cards.slice(0,5).map(function(c){
        return '<button data-go-page="vocab"><b>'+esc(c.q||'')+'</b><span class="sub">'+esc(c.card)+'</span></button>';
      }).join('');
    }
    if((d.questions||[]).length){
      html += '<div class="sh">题库题干 <span class="n">'+d.questions.length+'</span></div>';
      html += d.questions.slice(0,5).map(function(q){
        return '<button data-go-part="'+esc(q.part)+'"><b>'+esc(String(q.stem||'').slice(0,46))+'…</b>'+
          '<span class="sub">第 '+q.no+' 题 · '+esc((q.part||'').replace(/^第[一二三四五六七八九十]+部分：/,''))+'</span></button>';
      }).join('');
    }
    box.innerHTML = html || '<div class="sub" style="padding:14px 18px">没有找到「'+esc(d.q||'')+'」</div>';
    box.hidden=false;
  }
  function bindSearch(){
    var btn=$('#searchBtn'), box=$('#searchPop'), inp=$('#searchIn');
    if(!btn||!box) return;
    btn.addEventListener('click',function(){
      box.hidden = !box.hidden;
      if(!box.hidden && inp){ inp.value=''; inp.focus(); box.innerHTML='<div class="sub" style="padding:14px 18px">输入关键词：讲次名 / 单词 / 中文释义 / 考点 / 题干</div>'; }
    });
    if(inp){
      inp.addEventListener('input',function(){
        var q=inp.value.trim();
        clearTimeout(SEARCH_T);
        if(!q){ box.innerHTML='<div class="sub" style="padding:14px 18px">输入关键词：讲次名 / 单词 / 中文释义 / 考点 / 题干</div>'; return; }
        SEARCH_T=setTimeout(function(){ callTool('search_all', {q:q}, {log:false, onDone:searchPop}); }, 220);
      });
    }
    document.addEventListener('click',function(e){
      if(box.hidden) return;
      if(e.target.closest('#searchPop') || e.target.closest('#searchBtn')) return;
      box.hidden=true;
    });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') box.hidden=true; });
    document.addEventListener('click',function(e){
      var l=e.target.closest('#searchPop [data-go-lesson]');
      if(l){
        SEL.subject=l.getAttribute('data-go-subject'); SEL.lesson=l.getAttribute('data-go-lesson');
        CLS_S.manual=true; box.hidden=true; go('classroom'); return;
      }
      var w=e.target.closest('#searchPop [data-go-group]');
      if(w){ SEL.group=w.getAttribute('data-go-group'); box.hidden=true; go('vocab'); return; }
      var p=e.target.closest('#searchPop [data-go-part]');
      if(p){ SEL.part=p.getAttribute('data-go-part'); box.hidden=true; go('practice'); return; }
      var v=e.target.closest('#searchPop [data-go-page]');
      if(v){ box.hidden=true; go(v.getAttribute('data-go-page')); return; }
    });
  }

  /* ---------- 课程库分类过滤 ---------- */
  function bindCourseCats(){
    var box=$('#courseCats');
    if(!box) return;
    box.addEventListener('click',function(e){
      var c=e.target.closest('.chip'); if(!c) return;
      [].forEach.call(box.querySelectorAll('.chip'),function(x){ x.classList.toggle('on', x===c); });
      var cat=c.getAttribute('data-cat');
      var n=0;
      [].forEach.call(document.querySelectorAll('#courselist .cc'),function(card){
        var sj=card.getAttribute('data-subj');
        var show = (cat==='all') || (cat==='res') || (cat==='vocab-book' ? sj==='vocab-book' : sj===cat);
        card.style.display = show ? '' : 'none';
        if(show) n++;
      });
      var meta=document.querySelector('#p-courses .sechd .meta');
      if(meta) meta.textContent = '显示 ' + n + ' 项';
      if(cat==='res'){ var r=$('#reslist'); if(r && r.closest('.sec')) r.closest('.sec').scrollIntoView({block:'start'}); }
    });
  }

  /* ---------- 课堂：全屏 / 本门课讲次筛选 / 把本讲词加进今天复习 ---------- */
  function bindClassroomExtras(){
    var fs=$('#fsBtn');
    if(fs){
      fs.addEventListener('click',function(){
        var stage=document.querySelector('#p-classroom .stage');
        if(!stage) return;
        if(document.fullscreenElement){ document.exitFullscreen(); }
        else if(stage.requestFullscreen){ stage.requestFullscreen(); }
      });
    }
    var ts=$('#tocSearch');
    if(ts){
      ts.addEventListener('input',function(){ paintToc(CLS_S.toc, ts.value); });
    }
    var add=$('#dwAdd');
    if(add){
      add.addEventListener('click',function(){
        var les=CLS_S.lesson; if(!les){ return; }
        callTool('add_words_to_review', {lesson_id:les.id}, {onDone:function(res){
          if(res.need_confirm){
            add.textContent='再点一次确认加入';
            add.setAttribute('data-armed','1');
            return;
          }
          if(res.ok && res.data){
            add.textContent='已加入今天复习（'+res.data.total+' 词，到期 '+res.data.due_today+'）';
            add.classList.add('act');
          } else {
            add.textContent = (res.data&&res.data.error) || '加入失败';
          }
        }, confirm: add.getAttribute('data-armed')==='1'});
        add.setAttribute('data-armed','0');
      });
    }
  }

  /* ---------- 练习：让 AI 讲清这题（没接模型就如实说） ---------- */
  function bindPracAi(){
    var b=$('#pracAi');
    if(!b) return;
    b.addEventListener('click',function(){
      var q=PRAC.list[PRAC.idx]||{};
      callTool('ask_ai', {qno:q.no, question:q.stem}, {onDone:function(res){
        var d=res.data||{};
        $('#pracExpT').textContent = d.available
          ? d.answer
          : ((d.reason||'') + '。' + (d.note||'') +
             (d.fallback_explain ? ('　正确答案 ' + d.fallback_ans + '　解析：' + d.fallback_explain) : ''));
        b.textContent = d.available ? '已由模型回答' : '模型未接入 · 已改用题库解析';
      }});
    });
  }
"""

NEW_INIT = r"""  /* 初始化 */
  paintHeroKick(); paintKpi(); paintHero(); paintStreak(); paintSubjProg(); paintWeekDone();
  paintClock();
  bindSearch(); bindCourseCats(); bindClassroomExtras(); bindPracAi();
  callTool('analyze_errors', {}, {log:false, onDone:function(r){ if(r.ok) paintErrors(r.data); }});
  var hp=(location.hash||'').replace(/^#/,'').split('|');
  go(PAGES[hp[0]] ? hp[0] : 'today');
  if(hp[1] && typeof setMode==='function') setMode(hp[1]);
"""


# ==========================================================================
# 区块替换（用标记定位，避免硬编码行号）
# ==========================================================================
SECTIONS = [
    ("首屏数据",
     "(function(){\n  var D = (function(){ try{ return JSON.parse(document.getElementById('PROTO_DATA').textContent); }",
     "  var SUB = (D.subjects||[]);", NEW_HEADER, ""),
    ("工具层", "  /* ---------- 工具注册表（界面只调工具） ---------- */",
     "  /* ---------- 页面元信息 ---------- */", NEW_TOOLS, ""),
    ("导航", "  /* ---------- 页面元信息 ---------- */",
     "  /* ---------- 侧栏：接着学 / 连击 ---------- */", NEW_NAV, ""),
    ("侧栏", "  /* ---------- 侧栏：接着学 / 连击 ---------- */",
     "  /* ---------- 今日 ---------- */", NEW_SIDEBAR, ""),
    ("今日", "  /* ---------- 今日 ---------- */",
     "  /* ---------- 课表：本周实完成 ---------- */", NEW_TODAY, ""),
    ("课表", "  /* ---------- 课表：本周实完成 ---------- */",
     "  /* ---------- 课程库 ---------- */", NEW_SCHEDULE, ""),
    ("课程库", "  /* ---------- 课程库 ---------- */",
     "  /* ---------- 课堂：左目录（章节手风琴）＋ 播放器 ---------- */", NEW_COURSES, ""),
    ("课堂", "  /* ---------- 课堂：左目录（章节手风琴）＋ 播放器 ---------- */",
     "    /* ---------- 背单词：独立模式 + 全自动推进（听写默写／挖空填写／看中文默写／看词选义／翻转自评） ---------- */",
     NEW_CLASSROOM, ""),
    ("练习", "/* ---------- 练习 ---------- */", "  /* ---------- 考场 ---------- */", NEW_PRACTICE, ""),
    ("考场", "  /* ---------- 考场 ---------- */", "  /* ---------- 统计 ---------- */", NEW_EXAM, ""),
    ("统计", "  /* ---------- 统计 ---------- */", "  /* ---------- Agent ---------- */", NEW_STATS, ""),
    ("Agent", "  /* ---------- Agent ---------- */", "  /* 初始化（hash 支持直达", NEW_AGENT, ""),
    ("接线增强 + 初始化", "  /* 初始化（hash 支持直达", "})();", NEW_EXTRAS + "\n" + NEW_INIT + "\n", ""),
]

# ==========================================================================
# 背单词页定点补丁：保留状态机，只接真服务
# ==========================================================================
PATCHES = [
    ("词源：加词组加载与记忆映射",
     """  var words=(curry.words||[]).slice();
  var FI = D.vocab.freq_index||{};
  var MEM = ((D.vocab.mem||{}).xuecheng)||{};""",
     """  var words=(curry.words||[]).slice();
  var FI = D.vocab.freq_index||{};
  var MEM = {};
  words.forEach(function(w){ if(w.mem) MEM[w.w]=w.mem; });"""),

    ("词组头 + 词表地图改工具驱动",
     """  $('#wmNow').textContent = (curry.unit||'')+' · '+(curry.lesson||'')+' · '+(curry.count||0)+' 词';
  var wmS = (D.wordmap||{}).summary||{};
  $('#wmMeta').textContent = (wmS.wb_groups||0)+' 组 / '+(wmS.with_video||0)+' 组有视频 · 对齐 '+(wmS.mapped_words||0)+' 词';
  $('#vocabmap').innerHTML = ((D.wordmap||{}).groups||[]).slice(0,12).map(function(g){
    return '<button class="'+(g.key===curry.key?'on':'')+'"><b>'+esc(g.unit+' '+g.lesson)+'</b><span>'+g.count+' 词 · '+esc(g.first)+' → '+esc(g.last)+'</span></button>';
  }).join('');
  $('#wmToggle').addEventListener('click',function(){ $('#wmpanel').classList.toggle('on'); });""",
     """  var CURG = curry.key;
  var wmS = (D.wordmap||{}).summary||{};
  function paintVocabHeader(){
    $('#wmNow').textContent = CURG ? (CURG + ' · ' + words.length + ' 词') : '（没有可跟随的词组）';
    $('#wmMeta').textContent = (wmS.wb_groups||0)+' 组 / '+(wmS.with_video||0)+' 组有视频 · 对齐 '+(wmS.mapped_words||0)+' 词 · 附录 '+(wmS.appendix_words||0)+' 词无视频';
  }
  function paintVocabMap(){
    $('#vocabmap').innerHTML = ((D.wordmap||{}).groups||[]).map(function(g){
      return '<button class="'+(g.key===CURG?'on':'')+'" data-g="'+esc(g.key)+'"><b>'+esc(g.unit+' '+g.lesson)+'</b>'+
        '<span>'+g.count+' 词 · '+esc(g.first)+' → '+esc(g.last)+(g.has_video? '' : ' · 无视频')+
        (g.mem_count? ' · 已学 '+g.mem_count : '')+'</span></button>';
    }).join('');
  }
  function paintWordList(){
    $('#wordlistAll').innerHTML = words.map(function(w){
      var m=MEM[w.w];
      return '<button class="wt"><span class="st"></span><b>'+esc(w.w)+'</b><span class="cn">'+esc(cleanCn(w.cn))+'</span>'+
        '<span class="d">'+(m? ('box'+m.box) : '未学')+'</span></button>';
    }).join('');
  }
  function paintVocabGroup(res){
    if(!res || !res.ok) return;
    var d=res.data||{};
    if(d.key){ CURG=d.key; SEL.group=d.key; }
    if(d.words){
      words = d.words.slice();
      MEM = {};
      words.forEach(function(w){ if(w.mem) MEM[w.w]=w.mem; });
    }
    paintVocabHeader(); paintVocabMap(); paintWordList();
    if(d.words) initRound();
  }
  $('#wmToggle').addEventListener('click',function(){ $('#wmpanel').classList.toggle('on'); });
  document.addEventListener('click',function(e){
    var g=e.target.closest('#vocabmap [data-g]'); if(!g) return;
    callTool('list_word_group', {key:g.getAttribute('data-g')},
      {onDone:function(res){ paintVocabGroup(res); }});
  });"""),

    ("卡片发音：记一次真实词条查询",
     """      if(sy) sy.addEventListener('click',function(){ playWord(w); logTool('fetch_word_detail'); });""",
     """      if(sy) sy.addEventListener('click',function(){
        playWord(w);
        callTool('fetch_word_detail', {word:w.w}, {onDone:function(res){
          var d=res.data||{};
          $('#wmNow').textContent = w.w + ' · ' + ((d.fallback||{}).segments||[]).map(function(s){return s.part;}).join('+') +
            (d.available? '' : '（词条源未接，用构词法兜底）');
        }});
      });"""),

    ("听写提示：真调词条工具",
     """        $('#hintCn').textContent='释义：'+(w.cn||'')+'　（'+(w.pos||'')+'）';
        tipPh.disabled=false;
        logTool('fetch_word_detail');""",
     """        $('#hintCn').textContent='释义：'+(w.cn||'')+'　（'+(w.pos||'')+'）';
        tipPh.disabled=false;
        callTool('fetch_word_detail', {word:w.w}, {log:false});"""),

    ("挖空输入：去掉每键一次的假日志",
     """          el.value=v; el.classList.remove('bad');
          logTool('grade_word');
          fillAndAdvance();""",
     """          el.value=v; el.classList.remove('bad');
          fillAndAdvance();"""),

    ("评分即落库：settle 改真调 grade_word",
     """    $('#duoFbR').textContent = good? ('连对 '+combo) : '这个词稍后会再问你一次';
    $('#duoBtn').textContent='继续';
    paintHud(); paintRail();
    logTool('grade_word');
    if(good) timer=setTimeout(goNext, 950);""",
     """    $('#duoFbR').textContent = good? ('连对 '+combo) : '这个词稍后会再问你一次';
    $('#duoBtn').textContent='继续';
    paintHud(); paintRail();
    callTool('grade_word', {word:w.w, mode:mode, answer: w.w}, {onDone:function(res){
      var d=res.data||{};
      if(d.mem){
        MEM[w.w] = {box:d.mem.box, due:d.mem.due, seen:d.mem.seen};
        $('#duoFbR').textContent = (good? '答对' : '答错') + ' → box' + d.mem.box + ' · 下次 ' + d.mem.due;
      }
      if(d.stats) $('#wmMeta').textContent = '本机记忆库 ' + d.stats.words + ' 词 · 今日到期 ' + d.stats.due_today +
        ' · ' + (wmS.wb_groups||0) + ' 组 / ' + (wmS.with_video||0) + ' 组有视频';
      paintRail();
    }});
    if(good) timer=setTimeout(goNext, 950);"""),

    ("模式切换：记一次真实偏好",
     """    renderDrill();
    logTool('pick_word_mode');
  }""",
     """    renderDrill();
    callTool('pick_word_mode', {mode:m}, {log:false});
  }"""),

    ("右栏词表：改由函数渲染",
     """  $('#wordlistAll').innerHTML = words.map(function(w){
    var m=MEM[w.w];
    return '<button class="wt"><span class="st"></span><b>'+esc(w.w)+'</b><span class="cn">'+esc(cleanCn(w.cn))+'</span>'+
      '<span class="d">'+(m? ('box'+m.box) : '未学')+'</span></button>';
  }).join('');""",
     """  paintVocabHeader(); paintVocabMap(); paintWordList();"""),
]


def splice(text, start, end, new):
    i = text.index(start)
    j = text.index(end, i)
    return text[:i] + new + text[j:]


DESIGN_HTML = os.path.join(os.path.dirname(APP), "outputs", "研学台-V3-设计稿.html")
_dl = io.open(DESIGN_HTML, encoding="utf-8").read().split("\n")
_j0 = [i for i, l in enumerate(_dl) if l.strip() == "<script>"][-1]
_j1 = [i for i, l in enumerate(_dl) if l.strip() == "</script>"][-1]
# 设计稿的 JS 本体（内联数据不进这里）
js = "\n".join(_dl[_j0 + 1:_j1]).strip() + "\n"

# 1) 先做区块替换
for label, start, end, new, _ in SECTIONS:
    if start not in js:
        raise SystemExit("✗ 区块【%s】找不到起始标记：%r" % (label, start[:40]))
    if js.count(start) != 1:
        raise SystemExit("✗ 区块【%s】起始标记出现 %d 次，不唯一" % (label, js.count(start)))
    js = splice(js, start, end, new)
    print("✓ 区块 %s" % label)

# 2) 再做定点补丁
for label, old, new in PATCHES:
    got = js.count(old)
    if got != 1:
        raise SystemExit("✗ 补丁【%s】期望命中 1 次，实际 %d 次" % (label, got))
    js = js.replace(old, new, 1)
    print("✓ 补丁 %s" % label)

with io.open(JS, "w", encoding="utf-8", newline="\n") as f:
    f.write(js)
print("app.js 完成：%d 区块 + %d 补丁" % (len(SECTIONS), len(PATCHES)))

CSS_ADD = """
/* ============ 接线新增（V3 设计系统延续，不加渐变/发光） ============ */
[hidden]{display:none!important}
.booterr{margin:24px;padding:22px 26px;border:1px solid var(--line2);border-radius:var(--r-l);background:var(--card)}
.booterr b{display:block;font-size:16px;margin-bottom:8px}
.booterr p{font-size:13px;color:var(--tx2);margin-top:4px}
.logrow .r{flex:1;color:var(--tx3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logrow .ms{flex:none;width:60px;text-align:right;color:var(--tx3)}
.logrow .bdg{flex:none}
#clsMenu{position:absolute;z-index:60;min-width:300px;padding:8px;margin-top:52px}
#clsMenu button,#examMenu button{display:flex;width:100%;text-align:left;padding:10px 12px;border-radius:8px;font-size:13.5px;align-items:center}
#clsMenu button:hover,#examMenu button:hover{background:var(--card2)}
#clsMenu button .sub,#examMenu button .sub{margin-left:auto;font-size:12px;color:var(--tx3)}
.pickbar{position:relative}
#dwlist .wordline{cursor:pointer}
#dwlist .wordline:hover b{color:var(--act)}
#plineNow{font-variant-numeric:tabular-nums}
.barwrap .mk{cursor:pointer}
#vocabmap button span{line-height:1.5}
#examGroups .chip{margin-right:8px}
.top{position:relative}
#searchPop{position:absolute;right:0;top:calc(100% - 4px);z-index:80;width:520px;max-height:70vh;overflow-y:auto}
#searchPop .sh{display:flex;align-items:center;gap:8px;padding:12px 18px 8px;font-size:11px;font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;color:var(--tx3);border-top:1px solid var(--line)}
#searchPop .sh:first-child{border-top:0}
#searchPop button{display:block;width:100%;text-align:left;padding:9px 18px}
#searchPop button:hover{background:var(--card2)}
#searchPop button b{font-size:13px;font-weight:600}
#searchPop button .sub{display:block;margin-top:2px}
input.tocsearch{width:100%;height:34px;padding:0 12px;border-radius:9px;background:var(--card2);
  border:1px solid var(--line);font-size:12.5px;color:var(--tx)}
input.tocsearch::placeholder{color:var(--tx3)}
input.tocsearch:focus{border-color:var(--act);outline:none}
.sbox{display:flex;align-items:center;gap:8px;height:36px;padding:0 6px 0 12px;border-radius:var(--r-p);
  background:var(--card2);border:1px solid var(--line);color:var(--tx3);min-width:290px}
.sbox input{flex:1;min-width:0;font-size:13px;color:var(--tx)}
.sbox input::placeholder{color:var(--tx3)}
.sbox:focus-within{border-color:var(--line2)}
.sgo{height:26px;padding:0 12px;border-radius:var(--r-p);background:var(--act);color:var(--onact);
  font-size:12px;font-weight:700}
"""

# ==========================================================================
# CSS：每次从设计稿重新提取 + 规范修正 + 接线样式
# （必须重新提取：直接追加会让重跑一次多一份）
# ==========================================================================
DESIGN_HTML = os.path.join(os.path.dirname(APP), "outputs", "研学台-V3-设计稿.html")
_dl = io.open(DESIGN_HTML, encoding="utf-8").read().split("\n")
_c0 = [i for i, l in enumerate(_dl) if l.strip() == "<style>"][0]
_c1 = [i for i, l in enumerate(_dl) if l.strip() == "</style>"][0]
css = "\n".join(_dl[_c0 + 1:_c1]).rstrip() + "\n"

# 规范：字号下限 12px（premium-ui 硬规则，也对应"小标签保证可读性"）
n11 = css.count("font-size:11px")
css = css.replace("font-size:11px", "font-size:12px")

with io.open(CSS, "w", encoding="utf-8", newline="\n") as f:
    f.write(css + CSS_ADD)
print("app.css 重建：设计稿 %d 行 + 修正 %d 处 11px→12px + 接线样式"
      % (len(css.split("\n")), n11))
