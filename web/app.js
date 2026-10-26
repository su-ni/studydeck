(async function(){
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
  var SUB = (D.subjects||[]);
  var byId = {}; SUB.forEach(function(s){ byId[s.id]=s; });
  /* 空白实例（一个科目都没有）时，SUB 是空数组，EN 会是 undefined ——
     后面 paintHero 里 en.next 一句就把整个首屏渲染打断，十个页面只剩今日页那点字。
     所以给一个空壳科目顶上：不是假数据，是「什么都没有」这个状态本身。 */
  var EMPTY_SUB = {id:null, name:'', score:0, lessons:[], lessons_total:0, lessons_done:0,
                   next:{}, groups:[], cover:'', video_title:'', video_up:'', mode:'', kind:''};
  var EN = byId['english'] || SUB[0] || EMPTY_SUB;
  function $(s,r){ return (r||document).querySelector(s); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function pct(a,b){ return b? Math.round(a/b*100) : 0; }
  function mss(sec){ sec=Math.max(0,Math.round(sec||0)); var h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
    return (h? (h+':'+String(m).padStart(2,'0')) : String(m)) + ':' + String(s).padStart(2,'0'); }
  function mins(sec){ return Math.round((sec||0)/60); }
  var CLS = {cs:'cs', clang:'cs', english:'en', math:'ma', politics:'po'};
  function clsOf(id){ return CLS[id]||'cs'; }
  var ORDER = SUB.slice().sort(function(a,b){ return (b.score||0)-(a.score||0); });

  /* ---------- 工具层：界面只调工具，不直连数据 ---------- */
  var TOOLS = (D.tools || []);
  var TLOG = [], TCALLS = 0, TFAILS = 0;
  function toolMeta(n){
    for(var i=0;i<TOOLS.length;i++){ if(TOOLS[i].name===n) return TOOLS[i]; }
    return {name:n, perm:'local', desc:'不在注册表里'};
  }
  var CALL_TIMEOUT = 30000;   /* 一次调用最多等 30 秒 */
  var CALL_RETRY = 2;         /* 网络层失败（连都没连上）重试两次 */
  /* 读工具一次就够，写工具重复执行会多出一条记录 —— 只在**网络层没送到**时重试，
     而且只重试读那一类。判据用 `opts.write` 由调用处显式声明，不靠名字猜。 */
  function isNetErr(e){
    var m = String((e && e.message) || e);
    return /Failed to fetch|NetworkError|Load failed|net::|ERR_|aborted|timeout|timed out/i.test(m);
  }
  function callTool(name, args, opts){
    opts = opts || {};
    function nowms(){ return (window.performance && performance.now) ? performance.now() : Date.now(); }
    var t0 = nowms();
    var body = JSON.stringify({args: args || {}, confirm: !!opts.confirm});
    var tries = 0;
    function once(){
      tries++;
      var ctl = (window.AbortController) ? new AbortController() : null;
      var tid = ctl ? setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, CALL_TIMEOUT) : 0;
      return fetch('/api/tool/' + encodeURIComponent(name), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: body, signal: ctl ? ctl.signal : undefined
      }).then(function(r){ return r.json(); }).then(function(res){
        if(tid) clearTimeout(tid);
        res.ms = (res.ms != null) ? res.ms : Math.round(nowms() - t0);
        res.tries = tries;
        TCALLS++; if(!res.ok) TFAILS++;
        pushLog(res);
        if(opts.onDone) opts.onDone(res);
        return res;
      });
    }
    function again(e){
      /* 写工具不重试：重发可能让服务端多落一条。读工具网络层失败才补一次。 */
      if(tries <= CALL_RETRY && !opts.write && isNetErr(e)){
        return new Promise(function(r){ setTimeout(r, 260 * tries); }).then(once).catch(again);
      }
      var msg = String((e && e.message) || e);
      var why;
      if(/aborted/i.test(msg)) why = '等了 ' + Math.round(CALL_TIMEOUT/1000) + ' 秒还没回来，先不等了';
      else if(isNetErr(e)) why = '连不上本机服务（' + msg + '），试了 ' + tries + ' 次';
      else why = msg;
      var res = {ok:false, tool:name, perm:toolMeta(name).perm, ms:Math.round(nowms()-t0),
                 error:'调用没成：' + why, data:{}, tries: tries};
      TCALLS++; TFAILS++; pushLog(res);
      if(opts.onDone) opts.onDone(res);
      return res;
    }
    return once().catch(again);
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
  /* ---------- 页面元信息 ---------- */
  var PAGES = {
    today:{k:'今日',t:'今日',s:'今日编排按「断点续学 > 到期复习 > 最大错因 > 未开科目」现场算'},
    classroom:{k:'课堂',t:'课堂',s:'一屏学完一讲：视频 + 讲义 + 本讲词群 + 当堂测'},
    courses:{k:'课程库',t:'课程库',s:'课程 + 本地资料 · 进度直接读本机数据'},
    schedule:{k:'课表',t:'课表',s:'计划由规则生成，完成情况来自真实记录'},
    vocab:{k:'背单词',t:'背单词',s:'SM-2 记忆状态存在本机数据库，评分即落库'},
    practice:{k:'练习',t:'练习',s:'所有题源共用一张表 · 判分在服务端，不提前泄答案'},
    exam:{k:'考场',t:'考场',s:'真题卷 · 答案来自 exam_papers.json'},
    stats:{k:'统计',t:'统计',s:'只展示能核对到源头的数字'},
    writing:{k:'作文',t:'作文批改',s:'本机先数能数的（词数 / 要点 / 格式），语言与文采要模型判 —— 模型没接就写「没判」，不给分'},
    agent:{k:'设置',t:'设置与工具台',s:'模型、题源、备份、同步 —— 所有能力都是可调用工具，点一行就真调一次'}
  };

  /* ---------- 选中状态（用户手动选的东西） ---------- */
  var SEL = {subject:'english', lesson:null, group:null, part:null, partWant:null, paper:null};
  var SUB_MAP = {}; SUB.forEach(function(s){ SUB_MAP[s.id]=s; });
  function subById(id){ return SUB_MAP[id] || null; }
  function enSubject(){ return subById('english') || EN || EMPTY_SUB; }
  /* 当前学科记在本机，刷新/换页都别掉回英语（以前就是这个坑：每个课程打开全是英语） */
  function setSubject(id, opts){
    id = String(id||'english');
    if(!subById(id)) id = 'english';
    if(SEL.subject === id && !(opts && opts.force)) return SEL.subject;
    SEL.subject = id;
    /* 换学科必须把上一科的讲次丢掉，否则会用英语的讲次去开政治/数学的课 */
    SEL.lesson = null;
    try{ localStorage.setItem('sd.subject', id); }catch(e){}
    paintSubjectChip();
    if(typeof paintResume === 'function') paintResume();
    /* 换了学科，任何「按学科算出来的数字」都不能再留着上一科的：
       讲次标题先置灰，等 get_current_lesson 回来再写，否则这一瞬间屏幕上
       是「顶栏=计算机、标题=英语某一讲」，看起来就是没换。 */
    if(typeof CLS_S !== 'undefined' && !CLS_S.lesson){
      var ct = $('#clsTitle'); if(ct) ct.textContent = '正在换到 ' + ((subById(id)||{}).name||'') + '…';
    }
    if(opts && opts.reload){ loadPage(opts.page || currentPage()); }
    return id;
  }
  function currentPage(){
    var on=document.querySelector('.page.on');
    return on ? on.id.replace(/^p-/,'') : 'today';
  }
  /* 顶栏「当前学科」——只认 SEL.subject，不再依赖课堂页的渲染顺序 */
  function paintSubjectChip(){
    var s = subById(SEL.subject) || enSubject();
    var t = $('#selSubjectT'); if(t) t.textContent = s.name || '—';
    var dot = $('#selSubject .dot'); if(dot) dot.className = 'dot ' + clsOf(s.id);
  }
  (function restoreSubject(){
    var saved=null;
    try{ saved = localStorage.getItem('sd.subject'); }catch(e){}
    if(saved && subById(saved)) SEL.subject = saved;
  })();

  /* ---------- 导航 ---------- */
  var PAGE_TOOLS = {
    today:    [['plan_today',        function(){ return {}; }]],
    classroom:[['get_current_lesson',function(){ return {subject:SEL.subject}; }],
               ['list_lessons',      function(){ return {subject:SEL.subject}; }]],
    courses:  [['list_subjects',     function(){ return {}; }]],
    schedule: [['plan_today',        function(){ return {}; }],
               ['plan_budget',       function(){ return {}; }],
               ['plan_week',         function(){ return {days: 7}; }]],
    vocab:    [['list_word_group',   function(){ return SEL.group ? {key:SEL.group} : {}; }],
                ['word_plan',         function(){ return SEL.group ? {key:SEL.group} : {}; }]],
    practice: [['pick_question_part',function(){ return SEL.part ? {part:SEL.part} : {}; }],
               ['list_item_sources',function(){ return {}; }]],
    exam:     [['list_exam_papers',  function(){ return {}; }]],
    stats:    [['stats_overview',    function(){ return {}; }],
               ['lesson_play_time',  function(){ return {}; }],
               ['list_backups',      function(){ return {limit:20}; }],
               ['sync_status',       function(){ return {}; }],
               ['sync_peers',        function(){ return {limit:20}; }]],
    writing:  [['writing_list',    function(){ return {}; }],
                ['writing_mine',    function(){ return {limit:20}; }]],
    agent:    [['recent_tool_calls', function(){ return {limit:12}; }],
                ['ai_providers',      function(){ return {}; }]]
  };
  function go(p){
    [].forEach.call(document.querySelectorAll('.navitem'),function(b){ b.classList.toggle('on', b.getAttribute('data-p')===p); });
    [].forEach.call(document.querySelectorAll('.page'),function(s){ s.classList.toggle('on', s.id==='p-'+p); });
    var m=PAGES[p]; if(m){ $('#pkick').textContent=m.k; $('#ptitle').textContent=m.t; $('#psub').textContent=m.s; }
    updatePageSub(p);
    $('#view').scrollTop=0; window.scrollTo(0,0);
    paintSubjectChip();
    if(('#'+p)!==location.hash){ try{ history.replaceState(null,'','#'+p); }catch(e){} }
    noteEvent('page', {payload:p});
    loadPage(p);
  }
  /* 页面副标题里的数字必须跟着数据走：空白实例上写「15 套真题 995 题」就是假数字。
     这几个数都来自已经取回来的数据，不额外发请求。 */
  function updatePageSub(p){
    var sub=$('#psub'); if(!sub) return;
    if(p==='courses'){
      var n=(SUB||[]).length;
      sub.textContent = (n? (n+' 门课程') : '课程目录是空的') + ' + 本地资料 · 进度直接读本机数据';
    } else if(p==='exam'){
      var ps=((D.exam||{}).papers)||[], tot=0;
      ps.forEach(function(x){ tot += (x.total||0); });
      sub.textContent = ps.length
        ? (ps.length+' 套真题 '+tot+' 题 · 答案来自 exam_papers.json')
        : '这台机器上还没有真题卷（exam_papers.json 不在数据目录里）';
    } else if(p==='practice'){
      var srcs=(D.sources||[]), tq=0;
      srcs.forEach(function(s){ tq += (s.total||0); });
      sub.textContent = srcs.length
        ? (srcs.length+' 个题源 · '+tq+' 题 · 判分在服务端，不提前泄答案')
        : '还没有任何题源 · 可以把你的题库导进来，判分在服务端';
    } else if(p==='vocab'){
      var g=((D.vocab||{}).lists||[]).length;
      sub.textContent = g ? 'SM-2 记忆状态存在本机数据库，评分即落库'
                          : '这台机器上还没有词书 —— 有词书这一页才有卡片';
    } else if(p==='schedule'){
      sub.textContent = '计划由规则生成，完成情况来自真实记录';
    }
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
    updatePageSub(p);
    if(p==='today' || p==='schedule') return paintToday(res, p, tool);
    if(p==='classroom') return paintClassroom(tool, res);
    if(p==='courses') return paintCourses(res);
    if(tool==='word_plan') return paintWordPlan(res);
    if(p==='vocab') return paintVocabGroup(res);
    if(p==='practice') return paintPractice(tool, res);
    if(p==='exam') return paintExam(tool, res);
    if(tool==='lesson_play_time') return paintTime(res);
    if(tool==='list_backups') return paintBackups(res);
    if(tool==='sync_status') return paintSyncStatus(res);
    if(tool==='sync_peers') return paintSyncPeers(res);
    if(p==='stats') return paintStats(res);
    if(tool==='writing_list') return paintWritingList(res);
    if(tool==='writing_mine') return paintWritingMine(res);
    if(tool==='ai_providers') return paintAiProvs(res);
    if(p==='agent') return paintAgent(res);
  }
  document.addEventListener('click',function(e){
    var t = e.target.closest('[data-p]');
    if(!t) return;
    e.preventDefault();
    var sub = t.getAttribute('data-sub');
    if(sub) setSubject(sub);
    go(t.getAttribute('data-p'));
  });
  window.addEventListener('hashchange',function(){
    var p=(location.hash||'').replace(/^#/,'').split('|')[0];
    var on=document.querySelector('.navitem.on');
    if(PAGES[p] && (!on || on.getAttribute('data-p')!==p)) go(p);
  });
  /* ---------- 侧栏：接着学 / 最近 7 天 ---------- */
  /* 「接着学」跟当前选中的学科走，不是永远英语（以前写死 enSubject()） */
  function paintResume(){
    var s = subById(SEL.subject) || enSubject();
    var nx = (s && s.next) || {};
    var t=$('#resumeT'), m=$('#resumeM'), b=$('#resumeGo');
    /* 一台机器上一门课都没有时，这块「接着学」没有可接着的东西 ——
       与其画一张写着「—」的空卡占着侧栏，不如整块收起来。第一屏只留该说的话。 */
    var rbox = $('#resumeBox');
    if(rbox) rbox.hidden = !((SUB || []).length);
    /* 初始化时这些节点可能还没解析出来，静默跳过，等 DOM 好了再画一次 */
    if(!t && !m && !b) return;
    if(t) t.textContent = nx.title || '—';
    if(m) m.textContent = nx.id ? ((nx.chapter||'') + ' · ' + mss(nx.dur)) : '这门课还没有讲次数据';
    if(b){
      b.setAttribute('data-go-subject', SEL.subject);
      b.setAttribute('data-go-lesson', nx.id || '');
      b.disabled = !nx.id;
      b.textContent = nx.id ? '继续这一讲' : '暂无可学讲次';
    }
  }
  paintResume();
  var k = D.kpi || {};
  $('#cntCourses').textContent = k.lesson_total || 0;
  $('#cntVocab').textContent = (k.mem_xuecheng||0) + '/' + (k.vocab_total||0);
  $('#chipMin').textContent = mins((D.events||{}).today_seconds || 0);
  (function(){
    var nav=$('#nav');
    var pv=nav.querySelector('[data-p="practice"] .cnt');
    if(pv){
      /* 导航计数改成五科题源合计：以前写死 781（只有英语语法那一本），
         装上计算机和政治的卡以后写死的数字就是假的了。 */
      var st=0; (D.sources||[]).forEach(function(s){ st += (s.total||0); });
      pv.textContent = (st || ((D.exercise_bank||{}).total||0)) + ' 题';
    }
    var ev=nav.querySelector('[data-p="exam"] .cnt'); if(ev) ev.textContent = ((D.exam||{}).papers||[]).length + ' 套';
    var ag=nav.querySelector('[data-p="agent"] .cnt'); if(ag) ag.textContent = (D.tools||[]).length + ' 个';
  })();
  /* ---------- 今日 ---------- */
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
    var en=enSubject()||EMPTY_SUB, nx=en.next||{};
    /* 三种空法要分开说：
       ①一个科目都没有（空白实例）→ 直说没有科目，别假装「学完了」；
       ②有科目但这科没讲次 → 这门课没有讲次数据；
       ③有讲次但都学完了 → 才是「全部上完」。 */
    $('#heroLead').textContent = nx.title
      ? ('接着上次：「' + nx.title + '」（' + (nx.chapter||'') + '，' + mins(nx.dur) + ' 分钟）。' +
         (k.due_today ? '今天有 ' + k.due_today + ' 个词到期。' : ''))
      : (!SUB.length ? '这台机器上还没有任何科目数据 —— 课程目录是空的，所以这里没有「接着学」这一项。'
         : ((en.lessons_total ? '这门课已经全部上完。' : '这门课还没有讲次数据。')));
    $('#heroCap').textContent = (en.video_up||'') + ' · ' + (nx.local ? '本地 MP4 · 可离线' : 'B 站 · 免登录');
    /* 封面图也是数据：这门课自带封面才挂，没有就整块不显示。
       空白实例上留一张别人的课程封面，等于告诉人「这儿有课」——最误导的一种空。 */
    var art=$('.hero-art');
    if(art){
      if(en.cover){ art.hidden=false; var im=art.querySelector('img'); if(im) im.src=en.cover; }
      else { art.hidden=true; }
    }
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
  /* ---------- 课表：倒计时排程 ---------- */
  /* 这一页以前是写死的一周（日期栏写 10-12..10-18 且把今天当周五）。
     真排程的依据只有两个：考试日期、每天能学多久——都由用户填，系统不猜。 */
  var WKEN = ['一','二','三','四','五','六','日'];
  var BUD = null, WEEK = null;
  function paintSchedule(tool, res){
    if(!res || !res.ok) return;
    if(tool==='plan_budget'){ BUD = res.data; paintBudget(); paintCut(); return; }
    if(tool==='plan_week'){ WEEK = res.data; paintWeekTl(); if(!BUD){ BUD=res.data; paintBudget(); paintCut(); } return; }
  }
  function setTxt(sel, html){ var e=$(sel); if(e) e.innerHTML = html; }
  function schUnset(d){
    var box=$('#schBudget'); if(!box) return;
    $('#schTl').hidden = true;
    var lg=$('#schLegend'); if(lg) lg.innerHTML='<span style="color:var(--tx3)">还没排，所以没有色块可图例</span>';
    $('#schMeta').textContent = '还没排';
    setTxt('#cutMeta','—');
    setTxt('#cutlist','<div class="sub" style="padding:16px 22px">排不出来就没有「这些不看」</div>');
    setTxt('#reachlist','<div class="sub" style="padding:16px 22px">—</div>');
    box.innerHTML = '<p class="sub" style="margin-bottom:14px">' + esc(d.reason||'还没定考试日期和每天时长。') + '</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
      '<label class="fld"><span>考试日期</span><input id="schDate" type="date" style="height:44px;padding:0 12px;border:1px solid var(--line);border-radius:8px"></label>' +
      '<label class="fld"><span>每天分钟</span><input id="schMin" type="number" min="10" max="720" placeholder="例如 150" style="width:150px;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:8px"></label>' +
      '<label class="fld"><span>其中单词</span><input id="schVoc" type="number" min="0" max="300" placeholder="0" style="width:130px;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:8px"></label>' +
      '<button class="btn act" id="schSave">定下来</button></div>' +
      '<p class="sub" style="margin-top:10px">这三个数只有你自己知道。填了之后，这一页的所有块都由它们算出来。</p>';
    var b=$('#schSave');
    if(b) b.addEventListener('click', function(){
      var dv=$('#schDate').value, mv=$('#schMin').value, vv=$('#schVoc').value || 0;
      if(!dv || !mv){ b.textContent='两个都要填'; return; }
      b.textContent='正在写…';
      callTool('plan_set_budget', {exam_date:dv, minutes_per_day:+mv, vocab_minutes:+vv}, {onDone:function(rr){
        if(rr && rr.ok && rr.data && rr.data.set){ BUD=null; WEEK=null; go('schedule'); }
        else { b.textContent='写不进去'; }
      }});
    });
  }
  function paintBudget(){
    var d = BUD; if(!d) return;
    if(!d.set || !d.ok){ schUnset(d); return; }
    var box=$('#schBudget'); if(!box) return;
    $('#schMeta').textContent = d.exam_date + ' · 还有 ' + d.days_left + ' 天 · 每天 ' + d.minutes_per_day + ' 分钟';
    var cov = (d.coverage==null) ? null : Math.round(d.coverage*1000)/10;
    var nSub = (d.subjects||[]).length;
    var head =
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
        '<div class="kpi"><div class="k">距离考试</div><div class="v">'+d.days_left+'<small>天</small></div></div>' +
        '<div class="kpi"><div class="k">总可用</div><div class="v">'+Math.round(d.total_minutes/60)+'<small>小时</small></div></div>' +
        '<div class="kpi"><div class="k">待学内容</div><div class="v">'+(nSub? d.pending_hours : '—')+'<small>小时</small></div></div>' +
        '<div class="kpi"><div class="k">能覆盖</div><div class="v">'+(cov==null?'—':cov)+'<small>%</small></div></div>' +
      '</div>';
    /* 一科都没有的时候不许印「0 小时 / 覆盖 —%」那种半截话 ——
       那是把「没东西可排」伪装成「排了但排得不好」。空就说空。 */
    var body = nSub
      ? ('<p class="sub" style="margin-top:12px">' +
          '按每天 '+d.minutes_per_day+' 分钟算，到考试那天一共 ' + Math.round(d.total_minutes/60) +
          ' 小时；要学的内容 ' + d.pending_hours + ' 小时，只能吃到 ' + d.keep_hours +
          ' 小时，剩下 <em class="a">' + (d.cut_hours||0) + ' 小时（' + (d.cut_total||0) + ' 讲）</em>排不进去。' +
          '这个百分比不是估的：把每讲的实测时长从头加，加到额度用完为止。' +
        '</p>')
      : ('<p class="sub" style="margin-top:12px">' +
          '日期和每天时长已经记下了：到 ' + esc(d.exam_date) + ' 还有 ' + d.days_left +
          ' 天，一共 ' + Math.round(d.total_minutes/60) + ' 小时。' +
          '<b style="color:var(--tx)">但这台机器上一门课都没有</b> —— 课程目录是空的，' +
          '所以这 ' + Math.round(d.total_minutes/60) + ' 小时现在没有东西可以填。' +
          '去上面那个输入框说一句「要考什么」，或者到「练习」页把自己的题库导进来。' +
        '</p>');
    box.innerHTML = head + body;
    setTxt('#schRule', esc(d.rule||'—'));
  }
  function paintCut(){
    var d = BUD; if(!d || !d.set || !d.ok) return;
    var rows=(d.cut_sample||[]);
    setTxt('#cutMeta', '共 ' + (d.cut_total||0) + ' 讲 · 下面列出前 ' + rows.length + ' 条');
    setTxt('#cutlist', rows.length
      ? rows.map(function(x){
          return '<div class="row"><span class="bar '+x.cls+'"></span>'+
            '<span class="tt"><b>'+esc(x.title)+'</b><span>'+esc(x.chapter||'')+' · '+x.minutes+' 分钟</span></span>'+
            '<span class="rt" style="font-size:11px;color:var(--tx3);max-width:190px;text-align:right">'+esc(x.why)+'</span></div>';
        }).join('')
      : '<div class="sub" style="padding:16px 22px">按现在的额度，一讲都不用砍</div>');
    setTxt('#reachlist', (d.subjects||[]).map(function(s){
      return '<div class="row"><span class="bar '+s.cls+'"></span>'+
        '<span class="tt"><b>'+esc(s.name)+'</b><span>'+s.score+' 分 · 权重 '+Math.round(s.weight*100)+'% · 额度 '+s.quota_minutes+' 分钟</span></span>'+
        '<span class="rt" style="font-size:11px;color:var(--tx3);max-width:230px;text-align:right">吃到 '+s.keep+' / '+s.lessons_total+' 讲'+(s.reach? ('　' + esc(s.reach)) : '')+'</span></div>';
    }).join(''));
  }
  /* 图例按当前排程里真出现的科目画：空白实例上不该还挂着英语/高数/政治五个色块 */
  var CLS_NAME = {en:'英语', ma:'高数', po:'政治', cs:'计算机', vo:'单词'};
  function paintLegend(){
    var box=$('#schLegend'); if(!box) return;
    var subs=((BUD||{}).subjects)||[];
    var seen={}, out=[];
    subs.forEach(function(s){ if(s.cls && !seen[s.cls]){ seen[s.cls]=1; out.push(s.cls); } });
    if(((BUD||{}).vocab_minutes||0) > 0) out.push('vo');
    box.innerHTML = (out.length ? out.map(function(c){
      return '<span><i style="background:var(--s-'+c+')"></i>'+esc(CLS_NAME[c]||c)+'</span>';
    }).join('') : '') +
      '<span style="color:var(--tx3)">块＝按考试日期和每天时长算出来的计划，不是随手画的</span>';
  }
  function paintWeekTl(){
    var d = WEEK; if(!d || !d.days) return;
    paintLegend();
    var head=$('#schHead'), days=$('#schDays'), gut=$('#schGutter');
    $('#schTl').hidden = false;
    head.innerHTML = '<div class="h"></div>' + d.days.map(function(x){
      return '<div class="h'+(x.is_today?' today':'')+'"><b>'+WKEN[x.wd]+'</b><em>'+
        (x.is_today ? '今天' : x.date.slice(5))+'</em></div>';
    }).join('');
    gut.innerHTML = [6,8,10,12,14,16,18,20].map(function(h){
      return '<span style="top:'+((h-6)*32.5)+'px">'+('0'+h).slice(-2)+':00</span>';
    }).join('');
    days.innerHTML = d.days.map(function(x){
      return '<div class="day'+(x.is_today?' today':'')+'">' + (x.blocks||[]).map(function(b){
        var mm = (+b.start.split(':')[0])*60 + (+b.start.split(':')[1]);
        var top = (mm - 360) * (32.5/60);
        var hgt = Math.max(b.minutes * (32.5/60), 14);
        return '<div class="blk '+b.cls+'" style="top:'+top.toFixed(1)+'px;height:'+hgt.toFixed(1)+'px" title="'+esc(b.title)+' · '+b.minutes+' 分钟">'+
          '<b>'+esc(b.title)+'</b><span>'+b.start+' · '+b.minutes+'m</span></div>';
      }).join('') + '</div>';
    }).join('');
  }
  function paintToday(res, p, tool){
    if(p === 'schedule'){ paintSchedule(tool, res); if(tool==='plan_today') return; }
    if(res && res.ok && (!tool || tool==='plan_today')) PLAN = res.data;
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
    var box=$('#weekDone'); if(!box) return;   /* 课表页改版后不再挂这一块，今日页还在 */
    var en=enSubject(), d=(en.done||[]).slice().reverse();   /* 全量，不截断成 6 条 */
    box.innerHTML = d.length
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
  /* ---------- 课表 ---------- */
  /* 课表页跟"今日编排"共用 plan_today 的结果：计划是规则现场算的，
     完成情况读 D.subjects[].done（本机记录）。这里不再单独放静态排期。 */
  /* ---------- 课程库 ---------- */
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
    /* 词表卡的标题、词量、单元数全部取词书自己报的，不写死。
       空白实例里没有词书——这时候连这张卡都不出，而不是挂一张「刘晓艳」的空卡。 */
    var wl=((D.vocab||{}).lists||[])[0];
    if(wl){
    cards += '<article class="cc" data-subj="vocab-book"><div class="cover"><img src="img/mnemo.jpg" alt="词表">'+
      '<span class="kind bdg">本地 · 词表</span><span class="dur">'+(wl.count||0)+' 词</span>'+
      '<span class="pl"><i><svg class="ic" style="width:22px;height:22px"><use href="#i-play"/></svg></i></span></div>'+
      '<div class="bd"><h4>'+esc(wl.name||'词表')+'</h4>'+
      '<div class="tg"><span class="bdg">'+(wl.count||0)+' 词</span><span class="bdg">'+esc(wl.unit_range||'—')+'</span>'+
      '<span class="bdg">'+(wm.wb_groups||0)+' 组</span></div>'+
      '<div class="pr"><span class="bar vo"><i class="vo" style="width:'+Math.max(pct(wm.mapped_words||0, wm.check_total||1),1)+'%"></i></span>'+
      '<b>有视频可覆盖 '+(wm.mapped_words||0)+' / '+(wm.check_total||0)+' 词</b></div>'+
      '<div class="now">另有 '+((wm.appendix_groups)||0)+' 组讲义附录词没有对应视频</div>'+
      '<div class="foot"><button class="btn act block" data-p="vocab">去背单词</button></div></div></article>';
    }
    /* 一门课都没有的时候不能留一张空网格：那看起来像加载失败。
       直接说清楚「目录是空的」，并且告诉人能怎么办（导入自己的题库 / 放课程数据）。 */
    if(!subs.length && !wl){
      cards = '<div class="card pad" style="grid-column:1/-1">' +
        '<div class="k" style="font-size:13px;color:var(--dim);margin-bottom:8px">课程目录是空的</div>' +
        '<p class="sub" style="margin:0">这台机器上还没有任何课程数据：没有科目、没有讲次、没有词书。' +
        '这不是加载失败，是数据目录里确实什么都没有。' +
        '可以去「练习」页把自己的题库导进来，或者把课程数据放进数据目录。</p></div>';
    }
    $('#courselist').innerHTML = cards;
    $('#reslist').innerHTML = (D.resources||[]).map(function(r){
      return '<div class="row"><span class="bar"></span><span class="tt"><b>'+esc(r.label)+'</b><span>'+esc(r.file)+'</span></span>'+
        '<span class="rt"><span class="bdg">'+esc(r.kind)+'</span><span class="num" style="font-size:12px">'+
        (r.kb? r.kb+' KB' : (r.pdf? r.pdf+' 份 PDF':''))+'</span></span></div>';
    }).join('');
  }
  /* ---------- 课堂 ---------- */
  var CLS_S = {lesson:null, subject:null, words:[], pos:0, toc:null, want:null, tocOpened:false, autoGroup:null};
  function paintClassroom(tool, res){
    if(!res.ok){
      /* get_current_lesson 失败本身就是一条真信息（比如这台机器一个科目都没有）。
         以前这里直接 return，屏幕上留着上一讲的播放器和一颗播放键 —— 看起来像视频坏了。 */
      if(tool==='get_current_lesson'){
        CLS_S.lesson = null; CLS_S.subject = null; CLS_S.pos = 0;
        paintStage();
      }
      if(tool==='pick_lesson') $('#dwWhy').textContent = '选讲失败：' + (res.error||'');
      return;
    }
    if(tool==='get_current_lesson'){
      CLS_S.lesson = res.data.lesson;
      CLS_S.subject = res.data.subject;
      CLS_S.pos = res.data.pos_sec || 0;
      if(!SEL.lesson) SEL.lesson = (res.data.lesson||{}).id;
      /* 服务端回来的学科才是准的，顶栏跟着它走，别各说各话 */
      if((res.data.subject||{}).id) setSubject(res.data.subject.id);
      paintStage(); paintTocProgress(res.data); loadDock();
    } else if(tool==='list_lessons'){
      CLS_S.toc = res.data; paintToc(res.data);
    } else if(tool==='list_lesson_words'){
      paintDockWords(res.data);
    } else if(tool==='pick_lesson'){
      var sub = subById(res.data.subject) || CLS_S.subject;
      CLS_S.lesson = res.data.lesson; CLS_S.subject = sub; CLS_S.pos = 0;
      CLS_S.want = (res.data.lesson||{}).id || null;
      if((res.data.subject||'')) setSubject(res.data.subject);
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
    /* 没有讲次就把播放器收起来，并说清为什么空着。
       以前这里直接 return，屏幕上留一个空黑框加一颗播放键 —— 看起来像视频挂了。 */
    if(!les.id){
      var scr=$('#screen'); if(scr){ scr.setAttribute('data-empty','1'); }
      var ov=$('#vplay'); if(ov) ov.style.display='none';
      var pv=$('#vposter'); if(pv){ pv.hidden=true; pv.style.display='none'; pv.removeAttribute('src'); }
      var et=$('#vtimes'); if(et) et.textContent='— / —';
      var es=$('#vsrc'); if(es){
        es.textContent = !SUB.length
          ? '这台机器上还没有任何科目数据 —— 有课程目录，这里才有得播。'
          : '这门课还没有讲次数据 —— 有讲次，这里才有得播。';
      }
      var t1=$('#clsTitle'); if(t1) t1.textContent='还没有讲次';
      var t2=$('#clsSub'); if(t2) t2.textContent='课程目录是空的，所以没有「这一讲」';
      var t3=$('#selLessonT'); if(t3) t3.textContent='还没有讲次';
      var t4=$('#tocProgT'); if(t4) t4.textContent='已完成';
      var t5=$('#tocProg'); if(t5) t5.textContent='—';
      return;
    }
    var scr2=$('#screen'); if(scr2) scr2.removeAttribute('data-empty');
    $('#clsTitle').textContent = les.title || '—';
    $('#clsSub').textContent = (sub.name||'') + ' · ' + (sub.video_up||'') + ' · ' + (les.chapter||'') +
      ' · 本讲约 ' + mins(les.dur) + ' 分钟（课程文件实测）';
    $('#selLessonT').textContent = les.title || '—';
    $('#selSubjectT').textContent = sub.name || '—';
    var dot=$('#selSubject .dot'); if(dot) dot.className = 'dot ' + clsOf(sub.id);
    $('#clsSrc').textContent = les.local ? '本地 MP4 · 可离线' : ('B 站 · ' + (les.bvid||''));
    $('#followT').textContent = (CLS_S.manual ? '手动选讲' : '跟随进度');
    $('#daHint').textContent = '问题会带上「' + (les.title||'') + '」和点发送那一刻的播放位置一起发出去。';
    var fb0=$('#clsFin'); if(fb0) fb0.hidden = true;
    var sb0=$('#clsSync'); if(sb0) sb0.hidden = true;
    /* 手动打勾按钮常驻：不靠「播到 95%」这一条路，播不动、或者只想先把这讲标掉，都能点 */
    var db0=$('#clsDone'); if(db0){ db0.hidden=false; db0.removeAttribute('data-armed'); db0.textContent='标记本讲看完'; }
    CLS_S.finished = false; CLS_S.posSec = CLS_S.pos || 0;
    mountPlayer(les, sub);
  }
  document.addEventListener('input', function(e){
    if(e.target && e.target.id==='wrText'){ paintWrCount(); return; }
  });
  /* 品牌抬头：从 /api/base 的 brand 取，不再把「某年某考」写死在页面上。
     研学台是通用学习台，考什么由 workbench/data 里的数据决定，不由界面决定。 */
  function paintBrand(){
    var b=(D && D.brand) || {};
    var t=$('#brandTitle'), s=$('#brandSub');
    if(t && b.title) t.textContent=b.title;
    if(s && b.subtitle) s.textContent=b.subtitle;
  }

  /* ---------------- XMind 云端同步（笔记区） ----------------
     官方是标准 MCP over Streamable HTTP + OAuth：未登录 401 并给
     WWW-Authenticate: Bearer resource_metadata=... 我们照这套走：
     服务起动态注册拿 client_id → 浏览器打开官方授权页 → 回调换 token。
     没登录就如实显示「未登录」，不假装有导图。 */
  function xmPost(path, args){
    return fetch(path, {method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify(args||{})}).then(function(r){ return r.json(); })
      .catch(function(e){ return {ok:false, error:String(e)}; });
  }
  function paintXm(st){
    var on = !!(st && st.connected);
    var lb=$('#xmLogin'), pb=$('#xmPull'), ob=$('#xmLogout'), ss=$('#xmState');
    if(lb) lb.hidden = on;
    if(pb) pb.hidden = !on;
    if(ob) ob.hidden = !on;
    /* 没连上就把「粘回调 URL」那一行露出来：授权完浏览器不跳回来也不至于卡死。 */
    var mm=$('#xmManual'); if(mm) mm.hidden = on;
    /* 顶栏那颗是主入口（藏在下方面板里根本没人找得到），连上就变绿。 */
    var tp=$('#xmTop'), tt=$('#xmTopT');
    if(tp){
      tp.classList.toggle('act', on);
      tp.title = on ? 'XMind 已连接：点一下断开' : '连接 XMind 云端：登录后可拉你在平板上做的导图';
    }
    if(tt) tt.textContent = on ? 'XMind 已连' : '连 XMind';
    if(ss){
      ss.textContent = on
        ? ('已连 XMind · ' + ((st.scope||'').replace('openid','').trim()||'mcp:connect')
           + (st.expires_in ? (' · ' + Math.round(st.expires_in/60) + ' 分钟后过期') : ''))
        : '未登录';
    }
  }
  function loadXm(){
    fetch('/api/xmind/status').then(function(r){ return r.json(); }).then(paintXm)
      .catch(function(){ paintXm(null); });
  }
  /* 授权在另一个标签页里做，这一页得自己问一次才知道。
     每 3 秒问一回，最多 3 分钟；连上了就停，并且顺手把导图列表拉出来。
     不做无限轮询——等不到就停下，让人自己点「拉 XMind 导图」。 */
  var _xmTimer = null;
  function xmWatch(){
    if(_xmTimer) clearInterval(_xmTimer);
    var n = 0;
    _xmTimer = setInterval(function(){
      n++;
      fetch('/api/xmind/status', {cache:'no-store'}).then(function(r){ return r.json(); })
        .then(function(st){
          if(st && st.connected){
            clearInterval(_xmTimer); _xmTimer = null;
            paintXm(st);
            var pb=$('#xmPull'); if(pb) pb.click();
          }else if(n >= 60){
            clearInterval(_xmTimer); _xmTimer = null;
            var ss=$('#xmState');
            if(ss) ss.textContent='还没等到授权（3 分钟）。再点一次「登录 XMind」';
          }
        }).catch(function(){});
    }, 3000);
  }
  function paintXmList(rows){
    var box=$('#xmList'); if(!box) return;
    if(!rows || !rows.length){ box.innerHTML=''; return; }
    box.innerHTML = rows.map(function(m){
      var t=esc(m.name||m.title||'未命名导图');
      var u=m.url||m.link||'';
      return '<div style="padding:6px 0;border-bottom:1px solid var(--line)">'
        + (u ? '<a href="'+esc(u)+'" target="_blank" rel="noopener">'+t+'</a>'
             : '<span>'+t+'</span>')
        + '</div>';
    }).join('');
  }
  document.addEventListener('click', function(e){
    if(!e.target) return;
    /* 顶栏主入口：没连上就开授权页，已连上就断开。 */
    if(e.target.closest('#xmTop')){
      var tp2=$('#xmTop'); var on2 = !!(tp2 && tp2.classList.contains('act'));
      if(on2){ var ob9=$('#xmLogout'); if(ob9) ob9.click(); return; }
      var lb2=$('#xmLogin'); if(lb2) lb2.click();
      return;
    }
    /* 人工兜底：授权完浏览器没跳回来时，把回调 URL 粘进去照样能换 token。 */
    if(e.target.closest('#xmCodeGo')){
      var ip=$('#xmCode'); var raw=(ip && ip.value || '').trim();
      if(!raw){ var s9=$('#xmState'); if(s9) s9.textContent='先把回调 URL 粘进输入框'; return; }
      var s8=$('#xmState'); if(s8) s8.textContent='正在换 token…';
      xmPost('/api/xmind/code', {url:raw}).then(function(r){
        var s7=$('#xmState');
        if(r && r.ok){
          if(s7) s7.textContent='已连上 XMind · scope=' + (((r.status||{}).scope)||'mcp:connect');
          loadXm();
          var pb8=$('#xmPull'); if(pb8) pb8.click();
        }else{
          if(s7) s7.textContent='没连上：'+((r&&r.error)||'未知原因')+' '+((r&&r.detail)||'');
        }
      });
      return;
    }
    if(e.target.closest('#xmLogin')){
      var lb=$('#xmLogin'); if(lb) lb.textContent='正在打开授权页…';
      xmPost('/api/xmind/login').then(function(r){
        if(r && r.url){
          window.open(r.url, '_blank', 'noopener');
          var ss=$('#xmState');
          if(ss) ss.textContent='浏览器里授权，授权完这里会自己变';
          /* 授权是在另一个标签页里完成的，这一页自己不知道。开个窗盯着后端：
             连上了就重画按钮行，最多等 3 分钟，别无限轮询。 */
          xmWatch();
        }else{
          var ss2=$('#xmState');
          if(ss2) ss2.textContent='登录失败：'+(r&&r.error||'未知原因');
        }
        if(lb) lb.textContent='登录 XMind';
      });
      return;
    }
    if(e.target.closest('#xmPull')){
      var pb=$('#xmPull'); if(pb) pb.textContent='拉取中…';
      callTool('xmind_list_maps', {}, {onDone:function(r){
        if(pb) pb.textContent='拉 XMind 导图';
        var d=r.data||{};
        var list=d.maps||[];
        paintXmList(list);
        var ss=$('#xmState');
        if(ss) ss.textContent = r.ok ? ('拉到 '+list.length+' 张（以服务端返回为准）')
                                    : ('拉取失败：'+((d.error)||(r.error)||''));
      }});
      return;
    }
    if(e.target.closest('#xmLogout')){
      xmPost('/api/xmind/logout').then(function(){ loadXm(); });
      return;
    }
  });

  /* 手动打勾：播不播得完都能自己标「本讲看完」。第一次点下去先变「再点一次确认」，
     防手滑；确认后只写本机事件库，进度文件那条仍然要另外点「写回进度文件」。 */
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#clsDone')){
      var les0=CLS_S.lesson; if(!les0 || !les0.id) return;
      var db=$('#clsDone'); if(!db) return;
      var pos=0;
      var v0=$('#vid'); if(v0 && isFinite(v0.currentTime)) pos=Math.round(v0.currentTime);
      else pos=Math.round(CLS_S.posSec||0);
      var armed0 = db.getAttribute('data-armed')==='1';
      db.textContent = armed0 ? '标记中…' : '再点一次确认看完';
      db.setAttribute('data-armed','1');
      callTool('finish_lesson', {lesson_id:les0.id, pos_sec:pos}, {onDone:function(r){
        var db2=$('#clsDone'); if(!db2) return;
        db2.removeAttribute('data-armed');
        if(!r.ok){ db2.textContent='标记失败：' + (r.error||'未知原因'); return; }
        db2.hidden = true;
        var fb2=$('#clsFin'); if(fb2){ fb2.hidden=false; fb2.textContent='本讲已看完 · 已写进本机事件库'; }
        var sb2=$('#clsSync'); if(sb2) sb2.hidden=false;
        callTool('list_lessons',{subject:SEL.subject},{onDone:function(r2){ if(r2.ok){ CLS_S.toc=r2.data; paintToc(r2.data); } }});
        callTool('get_current_lesson',{subject:SEL.subject},{onDone:function(r3){
          if(r3.ok) paintTocProgress(r3.data);
        }});
      }});
      return;
    }
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
      var lastSync=0, lastPos=0, playAcc=0, seeking=false;
      /* 真正记到的秒数才上报：拖动/跳断点期间一律不进 playAcc */
      function flushPlay(force){
        if(!playAcc && !force) return;
        var sec=Math.round(playAcc*10)/10;
        playAcc=0;
        callTool('log_playback',{lesson_id:les.id, pos_sec:Math.round(v.currentTime), seconds:sec});
      }
      v.addEventListener('loadedmetadata', function(){
        $('#vtimes').textContent = mss(v.currentTime) + ' / ' + mss(v.duration);
        if(CLS_S.pos > 5 && CLS_S.pos < v.duration - 3){
          v.currentTime = CLS_S.pos;
          $('#vsrc').textContent = '本地 MP4 · 已跳到上次 ' + mss(CLS_S.pos);
        }
        lastPos = v.currentTime;
      });
      /* 播不了就当场说清楚是哪一环断的，别让人对着黑屏猜。
         这里的每句提示都有实测依据：readyState/error 来自 <video> 自身，URL 就是它真在取的那条。 */
      v.addEventListener('error', function(){
        var e0 = v.error || {};
        var codeMap = {
          1: '读取被中断（MEDIA_ERR_ABORTED）',
          2: '网络中断，文件没取下来（MEDIA_ERR_NETWORK）',
          3: '文件解码失败，可能不是标准 MP4（MEDIA_ERR_DECODE）',
          4: '这个浏览器放不了这条视频的编码（MEDIA_ERR_SRC_NOT_SUPPORTED）'
        };
        var why = codeMap[e0.code] || ('未知错误 code=' + e0.code);
        $('#vsrc').textContent = '播不了：' + why;
        var tb = $('#vplay');
        if(tb){ tb.style.display=''; tb.setAttribute('data-href',''); }
        var pv2 = $('#vposter');
        if(pv2){
          pv2.style.display='';
          var scr2 = $('#screen');
          var box = scr2 && scr2.querySelector('.vid-fail');
          if(!box && scr2){
            box = document.createElement('div');
            box.className = 'vid-fail';
            scr2.appendChild(box);
          }
          if(box){
            box.innerHTML = '<b>这条视频放不出来</b><span>' + esc(why) + '</span>' +
              '<span class="p">取的是：' + esc(v.getAttribute('src') || '') + '</span>' +
              '<span class="p">文件在本机：' + (les.local ? '是' : '否') + '</span>' +
              '<span class="p">不看视频也能把这讲标掉：点上面「标记本讲看完」</span>';
          }
        }
      });
      v.addEventListener('loadeddata', function(){
        var scr3 = $('#screen');
        var box3 = scr3 && scr3.querySelector('.vid-fail');
        if(box3) box3.remove();
      });
      v.addEventListener('seeking', function(){ seeking=true; });
      v.addEventListener('seeked', function(){ seeking=false; lastPos=v.currentTime; });
      v.addEventListener('timeupdate', function(){
        $('#vtimes').textContent = mss(v.currentTime) + ' / ' + mss(v.duration || les.dur || 0);
        $('#plineNow').textContent = mss(v.currentTime);
        CLS_S.posSec = v.currentTime;
        var seg=v.currentTime-lastPos;
        /* 只有真在播、且没在拖、且间隔正常（<3 秒）才累 —— 浏览器卡一下多出来的空白不算 */
        if(!v.paused && !seeking && seg>0 && seg<3) playAcc += seg;
        lastPos=v.currentTime;
        var n=Date.now();
        if(n-lastSync > 10000){
          lastSync=n;
          flushPlay(false);
        }
        var dur=v.duration||les.dur||0;
        if(!CLS_S.finished && dur>30 && v.currentTime/dur>=0.95){
          CLS_S.finished=true;
          flushPlay(true);
          callTool('finish_lesson',{lesson_id:les.id, pos_sec:Math.round(v.currentTime)},{onDone:function(r){
            if(!r.ok) return;
            var fb1=$('#clsFin'); if(fb1){ fb1.hidden=false; fb1.textContent='本讲已看完 · 已写进本机事件库'; }
            var sb1=$('#clsSync'); if(sb1) sb1.hidden=false;
          }});
        }
      });
      /* 暂停/播完/关掉这一讲：把剩下没满 10 秒的那点也如实报上去，别丢 */
      v.addEventListener('pause', function(){ flushPlay(true); });
      v.addEventListener('ended', function(){ flushPlay(true); });
      $('#vsrc').textContent = '本地 MP4 · 可离线';
    } else {
      /* 封面是数据：这科自带封面才挂，没有就不挂 —— 顶上别人的封面等于说「这儿有课」 */
      if(pv){
        if(sub.cover){ pv.hidden=false; pv.style.display=''; pv.src = sub.cover; }
        else { pv.hidden=true; pv.style.display='none'; pv.removeAttribute('src'); }
      }
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
    paintCovers(c);
    if(sub.id==='english'){
      var bank=D.exercise_bank||{};
      $('#dqHead').textContent = '当堂测 · ' + ((bank.name||'').replace(/\s*·\s*.*$/,'') || '题库');
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
  /* 本讲考点 → 题库分部。分部名是精确比对，映射不上就一个都不显示，
     不随手塞个不相干的考点充数（「同位语」映射到感叹句就是这么错过的）。 */
  function paintCovers(c){
    var box=$('#dqCovers'); if(!box) return;
    var cv=((c&&c.covers)||[]).filter(function(x){ return x && x.name && x.n > 0; });
    box.innerHTML = cv.length ? cv.map(function(x){
      return '<button class="coverchip" data-cover-part="'+esc(x.name)+'" title="'+esc(x.why||'')+'">'+
        '<b>'+esc(x.name)+'</b><span>题库 '+x.n+' 题 · 点这里单刷这一分部</span></button>';
    }).join('') : '';
  }
  function paintToc(d, kw){
    if(!d || !d.groups) return;
    var cur=(CLS_S.lesson||{}).id;
    var q=(kw||'').trim().toLowerCase();
    var shown=0;
    /* 待选讲次（目录里点了、pick_lesson 还在路上）：先把这一章摊开、把这条标出来，
       否则用户点完看着目录没反应，下一讲的渲染回来又把它顶掉，以为点丢了 */
    var want=CLS_S.want;
    var html = d.groups.map(function(g){
      var kids=(g.lessons||[]);
      if(q) kids = kids.filter(function(l){ return (l.title||'').toLowerCase().indexOf(q) >= 0; });
      if(!kids.length) return '';
      shown += kids.length;
      var hasCur=(g.lessons||[]).some(function(l){ return l.id===cur; });
      var hasWant=!!want && (g.lessons||[]).some(function(l){ return l.id===want; });
      return '<div class="tocch'+((hasCur||hasWant||q)?' open':'')+'">' +
        '<button class="tocch-h"><svg class="ic cv"><use href="#i-chev"/></svg>' + esc(g.chapter) +
        '<span class="n">' + kids.length + '</span></button>' +
        '<div class="tocch-kids">' + kids.map(function(l){
          var st = (l.id===cur) ? 'cur' : (l.done ? 'done' : '');
          return '<button class="tocit'+(l.id===cur?' on':'')+(l.id===want?' pend':'')+'" data-l="'+esc(l.id)+'">' +
            '<span class="st '+st+'"></span><span class="nm">'+esc(l.title)+'</span>' +
            '<span class="du">'+(l.is_word_lesson?'词汇':'精讲')+' · '+mss(l.dur)+'</span></button>';
        }).join('') + '</div></div>';
    }).join('');
    $('#tocList2').innerHTML = html || '<div class="sub" style="padding:16px 18px">本门课没有匹配「' + esc(kw) + '」的讲次</div>';
    /* 「当前讲」在哪个已收起的分组里，就把那一组摊开一次。
       只在「打开目录」那一刻做一次（CLS_S.tocOpened），不跟手动收起的动作较劲。 */
    if(!CLS_S.tocOpened && cur && !q){
      var wantOpen=(CLS_S.want||cur);
      var sub=$('#tocList2').querySelector('.tocit[data-l="'+wantOpen+'"]');
      var grp=sub && sub.closest('.tocch');
      if(grp && grp.classList.contains('open')){
        CLS_S.tocOpened = true;
        CLS_S.autoGroup = grp;
      }
    }
    if(!CLS_S.tocOpened && CLS_S.autoGroup && !q){
      CLS_S.autoGroup.scrollIntoView({block:'center'});
      CLS_S.tocOpened = true;
    }
    $('#tocProg').textContent = q ? (shown + ' / ' + (d.lessons_total||0) + ' 讲（筛选）')
                                  : ((d.lessons_done||0) + ' / ' + (d.lessons_total||0));
  }
  $('#tocList2').addEventListener('click',function(e){
    var h=e.target.closest('.tocch-h');
    if(h){ h.parentNode.classList.toggle('open'); return; }
    var it=e.target.closest('.tocit'); if(!it) return;
    CLS_S.manual = true;
    CLS_S.want = it.getAttribute('data-l');
    paintToc(sublistRefresh(), $('#tocSearch') ? $('#tocSearch').value : '');
    callTool('pick_lesson', {lesson_id: CLS_S.want, subject: SEL.subject},
      {onDone:function(res){ paintClassroom('pick_lesson', res); }});
  });
  $('#tocBtn').addEventListener('click',function(){
    var off=$('#cls3').classList.toggle('hide');
    $('#tocBtnT').textContent = off ? '展开目录' : '收起目录';
    /* 每次重新摊开目录，都把「当前这一讲」那次自动展开再做一遍 */
    if(!off){ CLS_S.tocOpened = false; CLS_S.autoGroup = null; paintToc(sublistRefresh(), $('#tocSearch') ? $('#tocSearch').value : ''); }
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
      /* 先把上一科的讲次从状态里清掉再改学科：setSubject 里会顺手重画「接着学」，
         那些重画会读 CLS_S.lesson，留着英语那讲就会把旧标题又画回去。 */
      CLS_S.lesson = null; CLS_S.subject = null; CLS_S.words = [];
      SEL.lesson = null; CLS_S.manual=false;
      setSubject(mi.getAttribute('data-m-sub'));
      $('#clsMenu').hidden = true;
      $('#clsTitle').textContent = '正在换到 ' + ((subById(SEL.subject)||{}).name||'') + '…';
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
    /* 本讲考点 → 练习页只刷这一分部。落到练习页后由 __sdPickPart 点中同名 chip，
       这样「分部高亮 + 题目列表」都跟着换，不是只改了个变量。 */
    var cvc=e.target.closest('#dqCovers [data-cover-part]');
    if(cvc){
      var partName=cvc.getAttribute('data-cover-part');
      SEL.part = partName;
      SEL.partWant = partName;
      go('practice');
      var pk=$('#dqCovers');
      if(pk) pk.setAttribute('data-picked', partName);
      var hs=((D.exercise_bank||{}).parts||[]).filter(function(x){ return x.name===partName; })[0];
      if(hs && $('#dqSub')) $('#dqSub').textContent = '已跳到练习页：' + partName + ' · ' + hs.n + ' 题';
      return;
    }
    var da=e.target.closest('#daBtn');
    if(da){
      var q=($('#daArea')||{}).value || '';
      var vid=$('#vid');
      var pos=vid ? Math.round(vid.currentTime) : Math.round(CLS_S.posSec||0);
      callTool('ask_ai', {question: q, lesson_id:(CLS_S.lesson||{}).id, pos_sec:pos}, {onDone:function(r){
        var d=r.data||{};
        var ctx=(d.context||[]).join(' · ');
        $('#daOut').className='explain reveal on';
        $('#daOutT').textContent = d.answer || ((d.reason||'') + '。' + (d.note||'') +
          (ctx ? '　这次提问带上的上下文：' + ctx : ''));
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
  /* 下方面板的文本框笔记已经删了：本讲的内容现在都在右侧「笔记画布」里，
     一张图 = 一棵树，能改字、写备注、标颜色、导出 Markdown。 */
    /* ---------- 背单词：独立模式 + 全自动推进（听写默写／挖空填写／看中文默写／看词选义／翻转自评） ---------- */
  var words=(curry.words||[]).slice();
  var FI = D.vocab.freq_index||{};
  var MEM = {};
  words.forEach(function(w){ if(w.mem) MEM[w.w]=w.mem; });
  /* 背单词按「不背单词」的三段走：
     ① first —— 第一次见这个组：整张词面全摊开，底下四选一。选对＝认识，选错＝不认识并当场塞回队尾重问。
     ② know  —— 第一轮过完，翻屏只问「认识 / 不认识」，自评，不判分。
     ③ drill —— 用户自己挑的加练（默写/听写/挖空/选义/翻转），不是必经步骤。
     默写类永远不摆在必经路径上。 */
  var MODES = ['card','dictation','cloze','cn2write','pick','flip'];
  var queue=[], qi=0, combo=0, bestCombo=0, rightN=0, wrongN=0, ST={}, answered=false, timer=null;
  var mode='card';
  var PHASE='first', fbTimer=null, kTimer=null, REASKED={};  // first / know / review / drill
  var KNOWN={};       // word → 1 认识 / 0 不认识
  var FIRSTPASS={};   // word → 'ok' / 'no'，第一轮四选一的判定
  var REQUEUE=[];     // 不认识、已塞回队尾的词
  var FIRSTQ=[];      // 第一轮要过的队列（会被「塞回队尾」动态加长）
  var WORDSET=true;   // 读屏用：刚换了一组新词，第一轮卡面按词表顺序走

  var CURG = curry.key;
  var wmS = (D.wordmap||{}).summary||{};
  function paintVocabHeader(){
    $('#wmNow').textContent = CURG ? (CURG + ' · ' + words.length + ' 词') : '（没有可跟随的词组）';
    $('#wmMeta').textContent = (wmS.wb_groups||0)+' 组 / '+(wmS.with_video||0)+' 组有视频 · 对齐 '+(wmS.mapped_words||0)+' 词 · 附录 '+(wmS.appendix_words||0)+' 词无视频';
  }
  var WRONG = {words:[], count:0};
  function loadVocabExtras(){
    callTool('word_goal', {}, {onDone:function(res){
      var d=(res.data||{});
      var g=$('#wGoal');
      /* 没有词书时目标就是 0，「0 / 0 已完成」会让人以为今天背完了 —— 直说没有词书 */
      if(g) g.textContent = d.has_book === false
        ? '今日 0 词（这台机器上还没有词书）'
        : ('今日 ' + (d.done||0) + ' / ' + (d.goal||0) + ' 词' + (d.left? ('（还差 ' + d.left + '）') : '（已完成）'));
    }});
    callTool('list_wrong_words', {}, {onDone:function(res){
      WRONG.words = ((res.data||{}).words)||[];
      WRONG.count = WRONG.words.length;
      var b=$('#wrongBtn');
      if(b){
        b.innerHTML = '<svg class="ic"><use href="#i-refresh"/></svg>';
        b.title = '错词本 · ' + WRONG.count + ' 词';
      }
    }});
  }
  /* ---- 今日复习：进门先清掉到期词，再学新词（不背单词的顺序） ---- */
  var REVIEW = {on:false, rows:[], ok:0, no:0, fuzzy:0, base:null};
  /* 复习会话开着就一直是 true —— 用来兜住「PHASE 被别的路径重置后左栏又把中文摊出来」 */
  var REVRUN = false;
  function loadReviewCount(){
    callTool('review_today', {limit:200}, {onDone:function(res){
      var d=(res.data||{});
      var b=$('#dueN');
      if(b) b.textContent = (d.count||0) + ' 个';
      var rb=$('#reviewBtn');
      if(rb) rb.classList.toggle('on', (d.count||0) > 0);
      REVIEW.base = d;
      if(d.intervals && d.intervals.length) REV_IV = d.intervals;
    }});
  }
  function enterReview(){
    callTool('review_today', {limit:200}, {onDone:function(res){
      var d=(res.data||{}), rows=d.words||[];
      if(!rows.length){ showNudge('今天没有到期要复习的词'); return; }
      REVIEW.on = true; REVRUN = true; REVIEW.rows = rows; REVIEW.ok = 0; REVIEW.no = 0; REVIEW.fuzzy = 0;
      
      if(d.intervals && d.intervals.length) REV_IV = d.intervals;
      words = rows.map(function(r, i){
        return {no:i+1, w:r.w, ph:r.ph||'', pos:r.pos||'', cn:r.cn||'',
                mem:{box:r.box, due:r.due}};
      });
      /* 复习段 words 就是到期队列本身，下标直接用 qi（跟别段共用一套翻页） */
      queue = words.map(function(_, i){ return i; });
      qi = 0;
      MEM = {}; words.forEach(function(w){ if(w.mem) MEM[w.w]=w.mem; });
      ST = {}; REV_SHOW = {};
      CURG = '今日复习 · ' + rows.length + ' 词';
      /* 先把 PHASE 摆好再画左栏：反过来的话左栏会比状态早一步，把中文先摊出来 */
      PHASE = 'review'; mode = 'card';
      paintVocabHeader(); paintWordList();
      paintModeBar(); paintHud(); paintRail(); renderDrill();
      $('#duoFb').className='vx-fb on';
      $('#duoFbT').textContent='先清掉今天到期 ' + rows.length + ' 个词';
      var iv = REV_IV || [];
      $('#duoFbR').textContent = iv.length
        ? ('认了才排期（最多隔 '+iv[iv.length-1]+' 天再来）；不认识或模糊都留在今天，本轮到它还得再答一次')
        : '认了才排期；不认识或模糊都留在今天，本轮到它还得再答一次';
    }});
  }
  function leaveReview(){
    REVIEW.on = false; REVRUN = false;
    callTool('resolve_vocab_group', {lesson_id: SEL.lesson}, {onDone:function(res){
      paintVocabGroup(res); loadReviewCount();
    }});
  }
  /* 复习判档：'ok' 认识 / 'fuzzy' 模糊 / 'no' 不认识。
     后推逻辑全在后端 store.grade_word 里，这里只负责把三档如实传过去。 */
  function gradeReview(w, grade){
    if(grade === true) grade = 'ok';
    if(grade === false) grade = 'no';
    answered = true;
    ST[w.w] = grade;
    if(grade==='ok'){ REVIEW.ok++; rightN++; combo++; if(combo>bestCombo) bestCombo=combo; }
    else if(grade==='no'){ REVIEW.no++; wrongN++; combo=0; }
    else { REVIEW.fuzzy=(REVIEW.fuzzy||0)+1; combo=0; }
    var m0 = MEM[w.w] || {};
    var nd = revDays(grade==='ok' ? ((m0.box||0)+1) : 1);
    $('#duoFb').className='vx-fb on '+(grade==='ok'?'ok':(grade==='no'?'bad':'mid'));
    $('#duoFbT').textContent = (grade==='ok'? '认识 · ' : (grade==='no'? '不认识 · ' : '模糊 · ')) + w.w;
    /* 口径：认了才排期；不认识 / 模糊 都留在今天，本轮里反复回来直到答对 */
    $('#duoFbR').textContent =
        grade==='ok'   ? ((nd===null)? '升一档，下次隔更久' : ('升到 box'+((m0.box||0)+1)+'，'+nd+' 天后再来'))
      : grade==='fuzzy'? '留在今天，本轮到它再来一次'
      :                  '打回最低档，留在今天直到答对';
    paintHud(); paintRail();
    /* 复习是真正走 SM-2 的地方：认识→升档，模糊→压最短档，不认识→打回最低档 */
    var pass = {word:w.w, mode:'review', answer:w.w, right: (grade==='ok')};
    if(grade==='fuzzy') pass.fuzzy = true;
    callTool('grade_word', pass,
      {onDone:function(res){
        var d=res.data||{};
        if(d.mem) MEM[w.w]={box:d.mem.box, due:d.mem.due, seen:d.mem.seen};
        paintRail(); loadReviewCount();
      }});
    timer = setTimeout(function(){ reviewStep(1); }, grade==='no' ? 1200 : 700);
  }
  function reviewStep(dir){
    clearTimeout(timer);
    var nxt = qi + dir;
    if(nxt < 0) nxt = 0;
    if(nxt >= REVIEW.rows.length){ endReview(); return; }
    qi = nxt; renderDrill(true);
    fbTimer = setTimeout(function(){ var f=$('#duoFb'); if(f) f.className='vx-fb'; }, 1400);
  }
  function endReview(){
    REVIEW.on = false; REVRUN = false;
    $('#duoMain').className='vx-quiz';
    var forgot = REVIEW.rows.filter(function(r){
      var s = ST[r.w]; return s === 'no';
    }).length;
    $('#duoBody').innerHTML =
      '<div class="knowend">'+
        '<div class="kpis">'+
          '<div class="kp"><b>'+REVIEW.rows.length+'</b><span>到期</span></div>'+
          '<div class="kp ok"><b>'+(REVIEW.rows.length-forgot)+'</b><span>还记得</span></div>'+
          '<div class="kp bad"><b>'+forgot+'</b><span>忘了</span></div>'+
        '</div>'+
        '<p class="sub" style="margin-top:12px">'+
          (forgot? ('这 '+forgot+' 个打回最低档，明天还会再出现；记得的都往后推了。')
                 : '到期词全部记得，间隔已经拉长。')+'</p>'+
        '<div class="vx-knowacts" style="margin-top:16px">'+
          '<button class="b1" id="wRevDone">好，去学新词</button>'+
        '</div>'+
      '</div>';
    $('#duoFb').className='vx-fb';
    var btn=$('#duoBtn'); if(btn) btn.style.display='none';
    var bar=$('#duoModes'); if(bar){ bar.innerHTML=''; bar.style.display='none'; }
    var b=$('#wRevDone');
    if(b) b.addEventListener('click', function(){ leaveReview(); });
    loadReviewCount();
  }
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#reviewBtn')){ enterReview(); }
  });
  /* ---- 生词本 / 打卡日历 ---- */
  var STARS = {};
  function loadStars(){
    callTool('list_star_words', {}, {onDone:function(res){
      var rows=((res.data||{}).words)||[];
      STARS = {}; rows.forEach(function(r){ STARS[r.w]=1; });
      var b=$('#starBtn'); if(b) b.classList.toggle('on', rows.length>0);
      b.title = '生词本 · ' + rows.length + ' 词';
    }});
  }
  function toggleStar(word){
    var on = !STARS[word];
    callTool('star_word', {word:word, on:on}, {log:false, onDone:function(res){
      var d=res.data||{};
      if(d.starred) STARS[word]=1; else delete STARS[word];
      loadStars();
      $('#duoFb').className='vx-fb on '+(d.starred?'ok':'');
      $('#duoFbT').textContent = d.starred ? ('已加入生词本 · '+word) : ('已移出生词本 · '+word);
      $('#duoFbR').textContent = '生词本共 ' + (d.count||0) + ' 词';
    }});
  }
  function loadWordbook(){
    /* 上一段（复习/自评/加练）可能还挂着自动推进的定时器，
       不先清掉的话它会在几百毫秒后把这里的提示刷成别的词，
       用户点「生词本」却看见「认识 · social」。 */
    clearTimeout(timer); clearTimeout(fbTimer); clearTimeout(kTimer);
    answered = false;
    var fb0 = $('#duoFb');
    if(fb0) fb0.className = 'vx-fb';
    var ft0 = $('#duoFbT'); if(ft0) ft0.textContent = '';
    var fr0 = $('#duoFbR'); if(fr0) fr0.textContent = '';
    callTool('list_star_words', {}, {onDone:function(res){
      var rows=((res.data||{}).words)||[];
      if(!rows.length){ showNudge('生词本是空的：在卡片上点一下「收藏」就会进来'); return; }
      words = rows.map(function(r, i){
        return {no:i+1, w:r.w, ph:r.ph||'', pos:r.pos||'', cn:r.cn||'',
                mem:(r.box!==null && r.box!==undefined)? {box:r.box, due:r.due} : null};
      });
      MEM = {}; words.forEach(function(w){ if(w.mem) MEM[w.w]=w.mem; });
      CURG = '生词本 · ' + rows.length + ' 词';
      paintVocabHeader(); paintWordList();
      PHASE='drill'; mode='card'; qi=0;
      paintModeBar(); paintHud(); paintRail(); renderDrill();
    }});
  }
  function paintCheckin(){
    callTool('checkin_calendar', {days:70}, {onDone:function(res){
      var d=(res.data||{}), days=d.days||{}, n=d.count||0;
      var html =
        '<div class="wc-cal">'+
          '<div class="wc-cal-hd">'+
            '<div class="kp"><b>'+n+'</b><span>打卡天数</span></div>'+
            '<div class="kp ok"><b>'+(d.streak||0)+'</b><span>连续天数</span></div>'+
            '<div class="kp"><b>'+(d.checked_today? '已':'未')+'</b><span>今日</span></div>'+
          '</div>'+
          '<div class="wc-cal-grid">' + calCells(days) + '</div>'+
          '<p class="sub" style="margin-top:10px">'+esc(d.note||'')+'</p>'+
        '</div>';
      var box=$('#duoBody');
      if(box){
        PHASE='drill';
        box.innerHTML = html;
        var btn=$('#duoBtn'); if(btn){ btn.style.display=''; btn.className='vcta'; btn.textContent='返回本组'; btn.setAttribute('data-end','1'); }
        var bar=$('#duoModes'); if(bar){ bar.innerHTML=''; bar.style.display='none'; }
        var fx=$('#wCalBack'); if(fx) fx.addEventListener('click', function(){ initRound(); });
      }
    }});
  }
  function calCells(days){
    /* 本地日期，别用 toISOString（UTC 会把晚上 8 点后的今天算成明天） */
    var out=[], i, d=new Date();
    function key(x){
      return x.getFullYear()+'-'+('0'+(x.getMonth()+1)).slice(-2)+'-'+('0'+x.getDate()).slice(-2);
    }
    for(i=69;i>=0;i--){
      var x=new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      var k=key(x), r=days[k];
      var lv = !r ? 0 : (r.words>=20? 3 : (r.words>=8? 2 : 1));
      /* 最后一格就是今天（循环从 69 天前走到今天）；给它一个 .today 好让界面标出来 */
      var isToday = (i === 0);
      out.push('<i class="cl l'+lv+(isToday? ' today':'')+'" title="'+esc(k)+(r? (' · '+r.words+' 词'):' · 没背')+(isToday? ' · 今天':'')+'"></i>');
    }
    return out.join('');
  }
  /* ---- 例句收藏夹：收了就得有地方翻，否则收了等于没收 ---- */
  function loadFavCount(){
    callTool('list_fav_sentences', {limit:300}, {log:false, onDone:function(res){
      var n=((res.data||{}).count)||0;
      var b=$('#favBtn'); if(b){ b.classList.toggle('on', n>0); b.title='例句收藏 · '+n+' 句'; }
    }});
  }
  function paintFavs(){
    callTool('list_fav_sentences', {limit:300}, {onDone:function(res){
      var d=(res.data||{}), rows=d.sentences||[];
      var box=$('#duoBody'); if(!box) return;
      if(!rows.length){
        $('#duoFb').className='vx-fb on';
        $('#duoFbT').textContent='例句收藏夹是空的';
        $('#duoFbR').textContent='在词卡上看到顺手的例句，点它右边的「收藏」就存这儿了';
        return;
      }
      /* 按词分组：同一个词的几句挨在一起，翻起来像个小词卡 */
      var byW={}, order=[];
      rows.forEach(function(r){
        if(!byW[r.word]){ byW[r.word]=[]; order.push(r.word); }
        byW[r.word].push(r);
      });
      box.innerHTML =
        '<div class="wc-fav">'+
          '<div class="wc-cal-hd">'+
            '<div class="kp"><b>'+rows.length+'</b><span>收藏句</span></div>'+
            '<div class="kp ok"><b>'+order.length+'</b><span>涉及词</span></div>'+
            '<div class="kp"><b>'+esc(order[0]||'—')+'</b><span>最近收的</span></div>'+
          '</div>'+
          '<div class="wc-fav-list">'+ order.map(function(w){
            return '<div class="wc-fav-g">'+
              '<div class="wc-fav-w"><b>'+esc(w)+'</b><span>'+byW[w].length+' 句</span></div>'+
              byW[w].map(function(r){
                return '<div class="wc-fav-sent"><p>'+esc(r.text)+'</p>'+
                  '<span>'+esc(r.kind||'')+' · '+esc(r.src||'')+'</span>'+
                  '<button class="sent-fav on" data-fav-w="'+esc(r.word)+'" data-fav-t="'+esc(r.text)+
                  '" data-fav-s="'+esc(r.src||'')+'" data-fav-k="'+esc(r.kind||'')+
                  '" title="取消收藏"><svg class="ic"><use href="#i-star"></use></svg>移出</button>'+
                  '</div>';
              }).join('')+
            '</div>';
          }).join('') + '</div>'+
          '<p class="sub" style="margin-top:10px">'+esc(d.note||'')+'</p>'+
        '</div>';
      PHASE='drill';
      var btn=$('#duoBtn');
      if(btn){ btn.style.display=''; btn.className='vcta'; btn.textContent='返回本组'; btn.setAttribute('data-end','1'); }
      var bar=$('#duoModes'); if(bar){ bar.innerHTML=''; bar.style.display='none'; }
    }});
  }
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#starBtn')){ loadWordbook(); }
    if(e.target && e.target.closest('#checkinBtn')){ paintCheckin(); }
    if(e.target && e.target.closest('#favBtn')){ paintFavs(); }
  });
  function loadWrongBook(){
    /* 点错词本必须当场再拉一次：页面加载时缓存的那份是旧的，
       刚答错的词根本不在里面 —— 拿旧列表去组队，点了跟没点一样。 */
    callTool('list_wrong_words', {limit:200}, {onDone:function(res){
      var ws=(((res.data||{}).words)||[]);
      if(!ws.length) return;
      WRONG.words = ws; WRONG.count = ws.length;
      words = ws.map(function(r){
        return {no:0, w:r.w, ph:r.ph||'', pos:r.pos||'', cn:r.cn||'', mem:{box:r.box, due:r.due}};
      });
      MEM = {}; words.forEach(function(w){ MEM[w.w]=w.mem; });
      CURG = '错词本';
      PHASE='drill'; mode='card'; qi=0;
      paintVocabHeader(); paintWordList(); paintModeBar(); paintHud(); paintRail(); renderDrill();
    }});
  }
  document.addEventListener('click', function(e){
    if(e.target && e.target.closest('#wrongBtn')){ loadWrongBook(); }
  });

  function paintVocabMap(){
    $('#vocabmap').innerHTML = ((D.wordmap||{}).groups||[]).map(function(g){
      return '<button class="'+(g.key===CURG?'on':'')+'" data-g="'+esc(g.key)+'"><b>'+esc(g.unit+' '+g.lesson)+'</b>'+
        '<span>'+g.count+' 词 · '+esc(g.first)+' → '+esc(g.last)+(g.has_video? '' : ' · 无视频')+
        (g.mem_count? ' · 已学 '+g.mem_count : '')+'</span></button>';
    }).join('');
  }
  /* ---- 排卡：这一轮背哪些、为什么是这个顺序 ----
     以前是「按词表顺序翻页」，那不是决策。现在顺序由本机记录算出来，
     每个词都带一句「凭什么排在这」，界面上原样显示 —— 不许出现「系统觉得你该背这个」。 */
  var WPLAN = {key:null, order:[], tiers:{}, rule:'', byWord:{}};
  function paintWordPlan(res){
    if(!res || !res.ok) return;
    var d = res.data || {};
    if(!d.order) return;
    WPLAN.key = d.key || null;
    WPLAN.order = d.order;
    WPLAN.tiers = d.tiers || {};
    WPLAN.rule = d.rule || '';
    WPLAN.byWord = {};
    d.order.forEach(function(r){ WPLAN.byWord[r.w] = r; });
    /* 排卡结果出来时词组可能还没到（两个工具并发），到齐了再重排一次队列 */
    if(words && words.length && CURG === WPLAN.key) applyPlanOrder();
    paintPlanBar();
  }
  /* 按排卡结果重排本轮队列：只在第一轮（还没开始背）时生效，
     背到一半突然换顺序会让人以为卡跳了。 */
  function applyPlanOrder(){
    if(PHASE !== 'first') return;
    var idx = {};
    words.forEach(function(w,i){ idx[w.w] = i; });
    var ordered = [];
    WPLAN.order.forEach(function(r){ if(idx[r.w] != null) ordered.push(idx[r.w]); });
    words.forEach(function(w,i){ if(!WPLAN.byWord[w.w]) ordered.push(i); });
    if(!ordered.length) return;
    queue = ordered;
    FIRSTQ = queue.slice();
    qi = 0;
    if(typeof renderDrill === 'function') renderDrill();
  }
  function paintPlanBar(){
    var box = $('#planBar'); if(!box) return;
    var tiers = WPLAN.tiers || {};
    var names = {overdue:'逾期没复习', due:'今天到期', wrong:'答错过', freq:'真题高频', fresh:'新词'};
    var keys = Object.keys(names).filter(function(k){ return tiers[k]; });
    if(!keys.length){ box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="pl-hd"><b>这一轮的顺序是算出来的</b><span>' + keys.length + ' 档</span></div>' +
      '<div class="pl-tiers">' + keys.map(function(k){
        return '<span class="pl-t t-' + k + '">' + esc(names[k]) + ' <b>' + tiers[k] + '</b></span>';
      }).join('') + '</div>' +
      '<p class="pl-rule">' + esc(WPLAN.rule) + '</p>';
  }
  /* 当前词的排卡理由：直接显示在卡面上，不藏在 tooltip 里 */
  function planReason(word){
    var r = WPLAN.byWord[word];
    if(!r) return '';
    return r.reason || '';
  }
  function planTierOf(word){
    var r = WPLAN.byWord[word];
    return r ? (r.tier || '') : '';
  }
  function paintWordList(){
    /* 复习段左栏只留词形：这时候中文释义就是答案，摆在旁边等于把底牌亮给人看。 */
    /* 复习段左栏只留词形：这时候中文释义就是答案。
       以前只判 PHASE==='review'，可复习结束回到重学时 PHASE 就被改掉，
       底牌又全摊出来了 —— 所以再挂一道 REVRUN（复习会话是否还开着），两道都成立才露中文。 */
    var isRev = (PHASE === 'review') || REVRUN;
    var hideCn = isRev;
    $('#wordlistAll').innerHTML = words.map(function(w){
      return '<button class="wt" data-w="'+esc(w.w)+'"><span class="st"></span><b>'+esc(w.w)+'</b>'+
        '<span class="cn">'+esc(hideCn? '' : bareCn(w.cn))+'</span></button>';
    }).join('');
  }
  function paintVocabEmpty(){
    var box=$('#duoBody'); if(!box) return;
    var hasBook = ((((D.vocab||{}).lists)||[]).length > 0);
    box.innerHTML =
      '<div class="vx-empty">' +
        '<div class="ve-h">' + (hasBook ? '这一组里没有词' : '这台机器上还没有词书') + '</div>' +
        '<p class="ve-p">' + (hasBook
          ? '词组存在，但一个词也没读出来 —— 词书文件可能在，内容没跟上。'
          : '背单词要有词书才开得起来：词表、发音、记忆状态全靠它。现在数据目录里没有词书，所以这一页没有卡片可翻 —— 不是我把它藏起来了。') + '</p>' +
        '<p class="ve-p sub">想用的话，把词书导入数据目录（或换一个有词书的数据目录启动），这页会自动长出词来。</p>' +
      '</div>';
    var btn=$('#duoBtn'); if(btn) btn.style.display='none';
    var bar=$('#duoModes'); if(bar){ bar.innerHTML=''; bar.style.display='none'; }
    var ring=$('#vxRing'); if(ring) ring.setAttribute('stroke-dashoffset','326.7');
    ['#sOk','#sNo','#sBest','#sAcc'].forEach(function(s){ var e=$(s); if(e) e.textContent = (s==='#sAcc'? '—':'0'); });
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
    loadVocabExtras(); loadReviewCount(); loadStars(); loadFavs(); loadFavCount();
    /* 一本词书都没有的时候不能走下去 —— 以前会画出一张空卡：
       词是空的、四个选项是空的、成绩全 0，看起来像加载失败，其实是「没词可背」。 */
    if(d.words && !d.words.length){
      paintVocabEmpty();
      return;
    }
    if(d.words){
      initRound();
      /* 排卡结果可能先到（两个工具并发）：词一到就按排卡顺序重排一次 */
      if(WPLAN.order.length && WPLAN.key === CURG) applyPlanOrder();
      paintPlanBar();
    }
  }
  /* 词表（左栏）显示 / 隐藏：L 键或左上角图标，收起后左下角浮出「词表」按钮。
     面板一旦收起就记住选择，刷新后照旧。 */
  function toggleList(force){
    var vx=document.querySelector('.vx'), fab=$('#vxFab'); if(!vx) return;
    var hide = (force==null)? !vx.classList.contains('hide-list') : !!force;
    vx.classList.toggle('hide-list', hide);
    if(fab) fab.hidden = !hide;
    try{ localStorage.setItem('sd.vx.hidelist', hide? '1':'0'); }catch(e){}
  }
  var vtl=$('#vxListToggle'); if(vtl) vtl.addEventListener('click',function(){ toggleList(); });
  var vfb=$('#vxFab'); if(vfb) vfb.addEventListener('click',function(){ toggleList(false); });
  $('#wmToggle').addEventListener('click',function(){
    var p=$('#wmpanel'); if(!p) return;
    p.hidden = !p.hidden;
  });
  document.addEventListener('click',function(e){
    var g=e.target.closest('#vocabmap [data-g]'); if(!g) return;
    callTool('list_word_group', {key:g.getAttribute('data-g')},
      {onDone:function(res){ paintVocabGroup(res); }});
  });

  function stripPh(p){ return String(p||'').replace(/^英/,''); }
  function cleanCn(c){ return String(c||'').replace(/^[;；,，、\s]+/,''); }
  // 输入归一化：只留英文字母 → 小写 → 折叠「同一串被重复上屏」（中文输入法双提交）→ 按词长截断
  // 说明：只在结果不等于正确答案时才折叠，避免把 murmur / coco 这类真·叠词误伤
  function normalizeTyped(raw, target){
    var v=String(raw||'').replace(/[^a-zA-Z]/g,'').toLowerCase();
    var t=String(target||'').toLowerCase();
    if(v!==t && v.length>1){
      for(var p=1;p<=v.length/2;p++){
        if(v.length%p) continue;
        var unit=v.slice(0,p), all=true;
        for(var i=p;i<v.length;i+=p){ if(v.slice(i,i+p)!==unit){ all=false; break; } }
        if(all){ v=unit; break; }   // 例：screenscreen → screen；scrscrscr → scr
      }
    }
    if(t && v.length>t.length) v=v.slice(0,t.length);
    return v;
  }
  function say(w){
    try{
      if(!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      var u=new SpeechSynthesisUtterance(w); u.lang='en-GB'; u.rate=.88;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }catch(e){}
  }
  // 优先播放教材真实音频（词条自带 audio，缺失时按 audio_pattern 拼），失败退回浏览器朗读
  function audioURL(obj){
    if(!obj) return '';
    if(obj.audio) return obj.audio;
    var pat=D.vocab.audio_pattern;
    return pat? pat.replace('{word}', obj.w) : '';
  }
  function playWord(obj){
    var url=audioURL(obj);
    if(url){
      try{
        var a=new Audio(url);
        var pr=a.play();
        if(pr && pr['catch']) pr['catch'](function(){ say(obj.w); });
        return;
      }catch(e){}
    }
    say((obj&&obj.w)||'');
  }
  // 同根词：本词表内与当前词有词根关系的其它词（真实数据，不是占位文案）
  function kinWords(obj){
    var w=String(obj.w||'').toLowerCase(), out=[];
    if(w.length<3) return [];
    words.forEach(function(x){
      if(out.length>=6) return;
      var s=String(x.w).toLowerCase();
      if(s===w) return;
      var hit=false;
      if(s.length>=4 && w.indexOf(s)>=0) hit=true;        // 词表里已有它的词根，如 uncover 含 cover
      if(!hit && w.length>=4 && s.indexOf(w)>=0) hit=true; // 它是当前词的派生
      if(!hit && s.length>=4 && w.length>=4 && s.slice(0,4)===w.slice(0,4)) hit=true;
      if(hit) out.push(x);
    });
    return out;
  }
  function curWord(){
    /* 第一轮用 FIRSTQ（会因为「塞回队尾」变长），第二三轮回落到 queue，
       复习段 words 本身就是到期队列，直接按下标取 */
    if(PHASE==='review') return words[qi] || {w:'',cn:'',ph:''};
    var arr = (PHASE==='first') ? FIRSTQ : queue;
    return words[arr[qi]] || {w:'',cn:'',ph:''};
  }
  function roundSize(){
    if(PHASE==='review') return REVIEW.rows.length;
    return (PHASE==='first') ? FIRSTQ.length : queue.length;
  }
  // 挖空布局：首尾字母（长词再保一个中间字母）做固定提示，其余位置是需要你填的空
  function slotsOf(w){
    var cs=w.split(''), n=cs.length, keep={};
    if(n<=3){ keep[0]=1; }
    else { keep[0]=1; keep[n-1]=1; if(n>=6) keep[Math.floor(n/2)]=1; }
    return cs.map(function(c,i){ return { ch:c, blank: !keep[i] }; });
  }

  function paintHud(){
    var n = roundSize();
    var cur = Math.min(qi+1, Math.max(n,1));
    var pc = Math.round(cur/Math.max(n,1)*100);
    var bar=$('#duoProg'); if(bar) bar.style.width = pc+'%';
    var right=(PHASE==='first') ? Object.keys(FIRSTPASS).filter(function(k){ return FIRSTPASS[k]==='ok'; }).length
                                : rightN;
    var wrong=(PHASE==='first') ? Object.keys(FIRSTPASS).filter(function(k){ return FIRSTPASS[k]==='no'; }).length
                                : wrongN;
    var acc=(right+wrong)? Math.round(right/(right+wrong)*100) : 0;
    $('#sOk').textContent=right; $('#sNo').textContent=wrong;
    $('#sBest').textContent=bestCombo; $('#sAcc').textContent=(right+wrong)? (acc+'%') : '—';
    var r1=$('#vxRight'), r2=$('#vxWrong'), r3=$('#vxRedo'), r4=$('#vxTotal'), r5=$('#vxAcc'), r6=$('#vxRing');
    if(r1) r1.textContent=right;
    if(r2) r2.textContent=wrong;
    if(r3) r3.textContent=Math.max(roundSize()-qi-1, 0);
    if(r4) r4.textContent=words.length;
    if(r5) r5.textContent=((right+wrong)? acc : 0)+'%';
    if(r6) r6.setAttribute('stroke-dashoffset', String(Math.round(326.7*(1-(right+wrong? acc/100 : 0)))));
  }
  /* 点左栏词表的任意一个词，卡片就切到它 —— 以前这一列只画不响，
     要跳到某个词只能从头一路「下一个」按过去，等于摆了一列看得见、点不动的词。 */
  function jumpToWord(w){
    w = String(w||'');
    if(PHASE==='review'){
      for(var i=0;i<words.length;i++){ if(words[i] && words[i].w===w){ qi=i; renderDrill(); return true; } }
      return false;
    }
    var arr = (PHASE==='first') ? FIRSTQ : queue;
    for(var j=0;j<arr.length;j++){
      var it = words[arr[j]];
      if(it && it.w===w){ qi=j; renderDrill(); return true; }
    }
    return false;
  }
  document.addEventListener('click',function(e){
    var b = e.target && e.target.closest ? e.target.closest('#wordlistAll .wt') : null;
    if(!b) return;
    jumpToWord(b.getAttribute('data-w'));
  });
  function paintRail(){
    var curW=curWord().w, n=roundSize();
    /* 一个词都没有的时候写「—」，不要写「1 / 0」——那个 1 是下标算出来的假进度 */
    $('#wlistMeta').textContent = n ? ((qi+1)+' / '+n) : '—';
    [].forEach.call(document.querySelectorAll('#wordlistAll .wt'),function(b,i){
      var w=words[i], st=ST[w.w], isCur=(w.w===curW);
      var kn=FIRSTPASS[w.w] || KNOWN[w.w];
      var okv = (kn==='ok'||kn===1), nov = (kn==='no'||kn===0);
      b.className='wt'+(isCur?' on':(st==='ok'||okv?' ok':(st==='no'||nov?' bad':'')));
    });
  }
  /* 四选一选项：干扰项只从本组词里抽（同组词义近，比全库抽更难更准），
     只给中文释义、不带词性，凑不够 4 个时放宽长度限制再补，
     真的补不齐就少给几个 —— 不拿重复项或不存在的释义凑数。 */
  /* 四选一的干扰项规则（同组里挑，但挑得干净）：
     1) 剥掉释义里的词性前缀（"混合；v.(使) 混合" → "混合"），只把一条中文义当选项，
        不然选项又长又互相包含，看着像同一件事。
     2) 不拿同根/近形词当干扰项：association 是 associate 的派生，选错了也不丢人，
        这种题测不出「认不认识这个词」。
     3) 不拿同义/近义项当干扰项：community「社区; 社会」和 society「社会; 社团」撞义，
        选 society 判错是冤案。
     4) 还要互不重复：四个选项里任何两个不能共享同一个义项。 */
  var POS_RE = /^(v|n|adj|adv|prep|conj|pron|vt|vi|a|ad)\.\s*/i;
  function bareCn(c){
    return String(c||'').replace(/^[;；,，、\s]+/,'')
      .split(/[;；,，、]/).map(function(x){ return x.replace(POS_RE,'').trim(); })
      .filter(function(x){ return x; })[0] || '';
  }
  function sensesOf(c){
    return String(c||'').split(/[;；,，、]/).map(function(x){ return x.replace(POS_RE,'').trim(); })
      .filter(function(x){ return x && x.length>=2; });
  }
  function stemOf(w){
    var s=String(w||'').toLowerCase();
    return s.length>5 ? s.slice(0,5) : s;
  }
  function shareSense(a,b){
    var A=sensesOf(a), B=sensesOf(b);
    for(var i=0;i<A.length;i++){
      for(var j=0;j<B.length;j++){
        if(A[i]===B[j]) return true;
        if(A[i].length>=2 && B[j].indexOf(A[i])>=0) return true;
        if(B[j].length>=2 && A[i].indexOf(B[j])>=0) return true;
      }
    }
    return false;
  }
  function optsHTML(w, pool0){
    var base=bareCn(w.cn), src=(pool0 && pool0.length? pool0 : words), me=stemOf(w.w);
    var out=[], seen={};
    src.forEach(function(x){
      if(out.length>=3) return;
      if(x.w===w.w) return;
      if(stemOf(x.w)===me) return;              // 同根 / 近形
      if(shareSense(x.cn, w.cn)) return;        // 撞义
      var c=bareCn(x.cn);
      if(!c || c===base || c.length<2 || seen[c]) return;
      for(var i=0;i<out.length;i++){ if(shareSense(c, out[i])) return; }
      seen[c]=1; out.push(c);
    });
    /* 真凑不齐三个干净干扰项时，宁可少给几个，也不拿同根词或同义项凑数 */
    var opts=out.concat([base]).sort(function(){ return Math.random()-0.5; });
    var L=['A','B','C','D'];
    return opts.map(function(cn,i){
      return '<button class="opt" data-cn="'+esc(cn)+'"><i>'+L[i]+'</i>'+esc(cn)+'</button>';
    }).join('');
  }
  /* ---------------- 单词卡片（三栏版） ----------------
     版面结构（照参考稿，全部左对齐，不居中漂浮）：
       词 + 音标 + 读音 + 配图   一字排开
       四个释义                    2×2，A B C D
       页脚                        跳过
     作答之前一个字释义都不露：词根、例句译文也属于答案，第一轮一律不摆。 */
  function wordCardHTML(w, m, f, kin, phase){
    var kn=KNOWN[w.w], first=(phase==='first');
    var head =
      '<div class="vx-card">'+
        '<div class="vx-card-hd">'+
          '<div class="vx-word">'+
            '<div class="vx-w">'+esc(w.w)+'</div>'+
            '<div class="vx-wm">'+
              (w.pos? '<i class="pos">'+esc(w.pos)+'</i>' : '')+
              '<span class="ipa">'+esc(stripPh(w.ph))+'</span>'+
              '<button class="vx-say" id="wSay" aria-label="播放发音"><svg class="ic"><use href="#i-vol"/></svg></button>'+
            '</div>'+
          '</div>'+
          '<figure class="vx-pic" id="wPic" data-word="'+esc(w.w)+'">'+
            '<span class="wc-pic-slot"><span>无图</span></span>'+
            '<figcaption id="wPicSrc"></figcaption>'+
          '</figure>'+
        '</div>'+
        (first
          ? '<div class="vx-q">选它的意思 <b>A B C D</b></div>'+
            (planReason(w.w)? '<div class="vx-why"><i>排在这的理由</i>'+esc(planReason(w.w))+'</div>' : '')+
            '<div class="vx-opts" id="firstList">'+optsHTML(w, words)+'</div>'
          : '<div class="vx-knowt">'+
              '<div class="vx-knowdef">'+esc(cleanCn(w.cn)||'—')+'</div>'+
            '</div>'+
            '<div class="vx-ex"><span class="k">真题例句</span><div class="sents" id="wSents" data-word="'+esc(w.w)+'"></div></div>'+
            '<div class="vx-memo" id="wMemo" data-word="'+esc(w.w)+'"></div>')+
      '</div>';

    var foot;
    if(first){
      foot = '<button class="vx-txt" id="wSkip" style="margin-top:16px">跳过</button>';
    } else if(phase==='know'){
      /* 三档自评：认识 / 模糊 / 不认识。模糊是单独一档，不判分、不进错词，
         只把间隔压短 —— 「好像见过但说不准」和「压根没见过」不能是同一个按钮。 */
      foot = '<div class="vx-knowacts">'+
        '<button class="b2" id="wBeg">'+(kn===0? '不认识了':'不认识')+'</button>'+
        '<button class="b3" id="wFuzzy">'+(kn===2? '模糊了':'模糊')+'</button>'+
        '<button class="b1" id="wKnow">'+(kn===0? '认识 · 开始自评':'认识')+'</button>'+
      '</div>';
    } else if(phase==='review'){
      foot = '<div class="vx-knowacts">'+
        '<button class="b2" id="wRevNo">忘了</button>'+
        '<button class="b1" id="wRevYes">还记得</button>'+
      '</div>'+
      '<div class="vx-knowacts" style="margin-top:10px">'+
        '<button class="vx-txt" id="wRevFav">收藏到生词本</button>'+
        '<button class="vx-txt" id="wRevQuit">退出复习</button>'+
      '</div>';
    } else {
      foot = '<div class="vx-knowacts">'+
        '<button class="b2" id="wPrev"'+(qi>0?'':' disabled')+'>上一个</button>'+
        '<button class="b2" id="wBackRail">回词组</button>'+
        '<button class="b1" id="wNext"'+(qi<queue.length-1?'':' disabled')+'>下一个</button>'+
      '</div>';
    }
    return head + foot;
  }

  /* ---------------- 复习卡（到期词） ----------------
     复习跟首见是两件事：
       首见 —— 要把词喂给你，所以词面全摊 + 四选一；
       复习 —— 要你自己先想，所以只给词形和上次到期日，释义先藏着，
               点了「还记得 / 忘了」之后才翻出来，当场告诉你下次什么时候再来。 */
  var REV_SHOW = {}, REV_IV = null;
  function revDays(box){
    /* 间隔表是后端 config.SM2_INTERVALS 给的，页面上不写死任何天数 */
    var iv = REV_IV || (REVIEW.base && REVIEW.base.intervals) || [];
    if(!iv.length) return null;
    return iv[Math.min(Math.max(box||0, 0), iv.length-1)];
  }
  /* 复习卡：只给英文词 + 发音，别的全空。
     这是照不背单词的复习口径来的 —— 复习是「你想不想得起来」，不是「再看一遍」。
     所以翻开之前，词性、音标、配图、例句、释义一个都不出现；
     点完自评才一次性摊开，摊开的东西才允许带中文。 */
  function reviewCardHTML(w, m, f){
    var open = !!REV_SHOW[w.w];
    var days = revDays(m.box);
    if(!open){
      return '<div class="vx-card vx-card-blank">'+
          '<div class="vx-word">'+
            '<div class="vx-w">'+esc(w.w)+'</div>'+
            '<div class="vx-wm">'+
              '<button class="vx-say" id="wSay" aria-label="播放发音"><svg class="ic"><use href="#i-vol"/></svg></button>'+
            '</div>'+
          '</div>'+
        '</div>'+
        rawFootHTML(w, m, days, false);
    }
    return '<div class="vx-card">'+
        '<div class="vx-card-hd">'+
          '<div class="vx-word">'+
            '<div class="vx-w">'+esc(w.w)+'</div>'+
            '<div class="vx-wm">'+
              (w.ph? '<span class="ipa">'+esc(stripPh(w.ph))+'</span>' : '')+
              '<button class="vx-say" id="wSay" aria-label="播放发音"><svg class="ic"><use href="#i-vol"/></svg></button>'+
            '</div>'+
          '</div>'+
          '<figure class="vx-pic" id="wPic" data-word="'+esc(w.w)+'">'+
            '<span class="wc-pic-slot"><span>无图</span></span>'+
            '<figcaption id="wPicSrc"></figcaption>'+
          '</figure>'+
        '</div>'+
        '<div class="vx-knowt"><div class="vx-knowdef">'+esc(cleanCn(w.cn)||'—')+'</div></div>'+
        '<div class="vx-ex"><span class="k">真题例句</span><div class="sents" id="wSents" data-word="'+esc(w.w)+'"></div></div>'+
        '<div class="vx-memo" id="wMemo" data-word="'+esc(w.w)+'"></div>'+
      '</div>'+
      rawFootHTML(w, m, days, true);
  }
  /* 复习按钮：认识 / 模糊 / 不认识 —— 和学完那一遍的三档自评同一套口径。
     三档各自的后推天数全从后端 SM2_INTERVALS 取，页面上不写死数字。
     opened=false 时只给「想不起来 / 有点印象 / 认识」，点了才翻开看答案。 */
  function rawFootHTML(w, m, days, opened){
    var tip = (days === null) ? '' :
      '<div class="vx-knowhint">现在 box'+((m&&m.box)||0)+'：认了隔 '+days+' 天再来；模糊、不认识都留在今天，本轮到它还得再答一次</div>';
    if(!opened){
      return tip +
        '<div class="vx-knowacts">'+
          '<button class="b2" id="wRevNo">想不起来</button>'+
          '<button class="b3" id="wRevFuzzy">有点印象</button>'+
          '<button class="b1" id="wRevYes">认识</button>'+
        '</div>'+
        '<div class="vx-knowacts" style="margin-top:10px">'+
          '<button class="vx-txt" id="wRevFav">收藏到生词本</button>'+
          '<button class="vx-txt" id="wRevQuit">退出复习</button>'+
        '</div>';
    }
    return tip +
      '<div class="vx-knowacts">'+
        '<button class="b2" id="wRevNo">不认识</button>'+
        '<button class="b3" id="wRevFuzzy">模糊</button>'+
        '<button class="b1" id="wRevYes">认识</button>'+
      '</div>'+
      '<div class="vx-knowacts" style="margin-top:10px">'+
        '<button class="vx-txt" id="wRevFav">收藏到生词本</button>'+
        '<button class="vx-txt" id="wRevQuit">退出复习</button>'+
      '</div>';
  }

  function renderDrill(keepFb){
    clearTimeout(timer); clearTimeout(kTimer); answered=false;
    var w=curWord(), body=$('#duoBody'), btn=$('#duoBtn');
    $('#duoMain').className='vx-quiz'+(PHASE==='review'? ' rev' : '');
    /* 只有换词/换轮才收反馈条；同一轮里翻页时反馈条要留到定时器收走，
       否则用户看不到自己刚选错。 */
    if(!keepFb) $('#duoFb').className='vx-fb';
    btn.className='vcta'; btn.textContent='检查'; btn.removeAttribute('data-end'); btn.style.display='';
    var html='';
    if(PHASE==='first'){
      /* 第一轮：第一次见这个词 —— 词面 + 四选一必须同屏。
         第一轮不是复习，不摊同根词；记忆状态与词表位置留在第二遍说。
         选对＝认识；选错＝不认识，当场把这个词塞回队尾再问一次。
         这一轮不写 SM-2 box，只记「认识 / 不认识」。 */
      var m0=MEM[w.w], f0=FI[w.w]? FI[w.w].freq : null;
      btn.style.display='none';
      html = wordCardHTML(w, m0, f0, [], 'first');
    } else if(PHASE==='review'){
      /* 复习：到期词先只给词形，等你自己在心里过一遍，再点「还记得 / 忘了」。
         这才是复习 —— 一上来就把释义摆出来那是重看，不是回忆。 */
      var rv=MEM[w.w]||{}, fv=FI[w.w]? FI[w.w].freq : null;
      btn.style.display='none';
      html = reviewCardHTML(w, rv, fv);
    } else if(mode==='card' && PHASE==='know'){
      /* 第二轮：翻屏自评，只问认识 / 不认识 —— 不判分、不限时、不逼默写。 */
      var m=MEM[w.w], f=FI[w.w]? FI[w.w].freq : null, kin=kinWords(w);
      btn.style.display='none';
      html = wordCardHTML(w, m, f, kin, 'know');
    } else if(mode==='card'){
      var m2=MEM[w.w], f2=FI[w.w]? FI[w.w].freq : null, kin2=kinWords(w);
      btn.style.display='none';
      html = wordCardHTML(w, m2, f2, kin2, 'review');
    } else if(mode==='dictation'){
      html = '<button class="spk" id="spkBtn" aria-label="重播发音"><svg class="ic"><use href="#i-vol"/></svg></button>'+
             '<div class="duo-tools">'+
               '<button class="tip" id="tipCn">听不出来？看中文提示</button>'+
               '<button class="tip" id="tipPh" disabled>再看音标</button>'+
             '</div>'+
             '<div class="hintline" id="hintCn" style="display:none"></div>'+
             '<div class="hintline" id="hintPh" style="display:none;color:var(--tx3);font-weight:400;font-size:14px"></div>'+
             '<input class="duo-in" id="duoIn" placeholder="边听边写" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="latin" lang="en">';
    } else if(mode==='cloze'){
      var slots=slotsOf(w.w);
      html = '<div class="hintline" style="font-size:16px">'+esc(w.cn||'')+'</div>'+
             '<div class="slotrow'+(w.w.length>=8?' tight':'')+'" id="slotrow">'+
               slots.map(function(s,i){
                 return s.blank
                   ? '<input class="slot" data-i="'+i+'" maxlength="1" inputmode="latin" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="第 '+(i+1)+' 个字母">'
                   : '<span class="slot fixed">'+esc(s.ch)+'</span>';
               }).join('')+
             '</div>'+
             '<div class="sub">在横线上直接填，填一处自动跳下一处</div>';
    } else if(mode==='cn2write'){
      html = '<div class="duo-q cn">'+esc(w.cn||'')+'</div>'+
             '<input class="duo-in" id="duoIn" placeholder="输入英文单词" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="latin" lang="en">';
    } else if(mode==='pick'){
      html = '<div class="duo-q">'+esc(w.w)+'</div>'+
             '<div class="opts" id="duoOpts" style="width:100%;max-width:560px;margin-top:0">'+optsHTML(w)+'</div>';
    } else {
      html = '<div class="duo-q">'+esc(w.w)+'</div>'+
             '<div class="duo-tools">'+
               '<button class="tip" data-flip="1" style="border-style:solid">想起来了</button>'+
               '<button class="tip" data-flip="0">想不起来，直接看答案</button>'+
             '</div>';
    }
    body.innerHTML = html;
    /* 第一轮重问、第二遍翻页都会走回来：先把上一次挂的「跳下一步」定时器清掉，
       否则它会在新卡上再点一次 #wKnow/#wSkip，把刚渲染的卡片顶走（第二遍一直翻不动）。 */
    clearTimeout(kTimer);
    bindDrill(w);
    if(mode==='card' && PHASE!=='know') loadSents(w.w);
    paintHud(); paintRail();
    if(mode==='dictation'){
      var spk=$('#spkBtn');
      if(spk){
        spk.classList.add('on');
        setTimeout(function(){ playWord(w); }, 260);
        setTimeout(function(){ if(spk) spk.classList.remove('on'); }, 1700);
      }
    }
  }

  var SENTS = {};
  function loadSents(w){
    var box=$('#wSents'); if(!box) return;
    /* 新版卡面里例句容器就是 #wSents 本身，没有 .sbody / #wSentSrc 子节点 ——
       老代码在这里直接 return，例句永远取不到（第二遍只看到「真题例句」四个字）。 */
    var body=box.querySelector('.sbody') || box, src=$('#wSentSrc');
    if(SENTS[w] !== undefined){ paintSents(w, box, body, src); return; }
    body.innerHTML = '<span class="sub">取例句中…</span>';
    if(src) src.textContent = '正在查真卷';
    callTool('word_sentences', {word:w, limit:3}, {onDone:function(res){
      SENTS[w] = (res.ok && res.data) ? res.data : {word:w, count:0, sentences:[],
        note: res.error || '取例句失败'};
      if($('#wSents') && $('#wSents').getAttribute('data-word')===w) paintSents(w, box, body, src);
    }});
  }
  /* ---- 例句收藏：看到一句顺手的就存下来，回头能集中翻 ---- */
  var FAVS = {};
  function loadFavs(){
    callTool('list_fav_sentences', {limit:300}, {log:false, onDone:function(res){
      var rows=((res.data||{}).sentences)||[];
      FAVS = {}; rows.forEach(function(r){ FAVS[r.text]=1; });
    }});
  }
  function toggleFav(word, text, src, kind){
    var on = !FAVS[text];
    callTool('fav_sentence', {word:word, text:text, src:src||'', kind:kind||'', on:on},
      {log:false, onDone:function(res){
        var d=res.data||{};
        if(d.saved) FAVS[text]=1; else delete FAVS[text];
        loadFavCount();
        /* 在收藏夹页里点「移出」别去重绘词卡，就地把这一页重画 */
        if($('#duoBody') && $('#duoBody').querySelector('.wc-fav')) paintFavs();
        else { var w=curWord(); if(w) renderDrill(true); }
        $('#duoFb').className='vx-fb on '+(d.saved? 'ok':'');
        $('#duoFbT').textContent = d.saved ? '例句已收藏' : '已取消收藏';
        $('#duoFbR').textContent = '例句收藏夹共 ' + (d.count||0) + ' 句';
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
      var on = !!FAVS[s.t];
      return '<div class="sent"><p>'+esc(s.t)+'</p>'+
        '<span>'+esc(s.kind)+' · '+esc(s.src)+'</span>'+
        '<button class="sent-fav'+(on? ' on':'')+'" data-fav-w="'+esc(w)+'" data-fav-t="'+esc(s.t)+
        '" data-fav-s="'+esc(s.src||'')+'" data-fav-k="'+esc(s.kind||'')+
        '" title="'+(on? '取消收藏':'收藏这句')+'"><svg class="ic"><use href="#i-star"></use></svg>'+
        (on? '已收藏':'收藏')+'</button></div>';
    }).join('');
    if(src) src.textContent = '全部摘自真卷，不是生成的 · ' + (d.count||0) + ' 句';
  }
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('[data-fav-t]') : null;
    if(!b) return;
    toggleFav(b.getAttribute('data-fav-w'), b.getAttribute('data-fav-t'),
              b.getAttribute('data-fav-s'), b.getAttribute('data-fav-k'));
  });

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

  /* 卡片态：真卷例句 + 百词斩配图/词根，各自填各自的槽位。
     拿不到就写清为什么拿不到 —— 不拿本地插画假装是配图。 */
  function loadWordExtra(word){
    var picBox=$('#wPic'), picSrc=$('#wPicSrc'), memo=$('#wMemo');
    callTool('fetch_word_detail', {word:word}, {onDone:function(res){
      var d=(res.data)||{}, okp=!!d.available, img=d.image||d.image_url;
      /* 词条是异步回来的，这期间用户可能已经翻到下一个词。
         槽位对不上就丢掉这次结果，不然图上的是上一个词。 */
      var picNow=$('#wPic');
      if(picNow && picNow.getAttribute('data-word') !== word) return;
      picBox=picNow;
      /* 第一遍没有 #wMemo（答案要先藏住），这时 memo 是 null，绝不能因此把配图/发音一起丢掉。 */
      var memoNow=$('#wMemo');
      if(memoNow && memoNow.getAttribute('data-word') !== word) return;
      memo=memoNow;
      if(picBox){
        /* 图片槽在 .vx-pic 里面；老选择器 .wc-pic-slot 在新卡面上不存在，会直接抛错
           把后面的词根渲染整段跳过。 */
        var slot=picBox.querySelector('.wc-pic-slot') || picBox;
        if(okp && img){
          slot.innerHTML = '<img src="'+esc(img)+'" alt="'+esc(word)+'" loading="lazy"'+
            ' onerror="this.parentNode.innerHTML=\'<span>无图</span>\'">';
          picBox.classList.add('has');
        } else {
          slot.innerHTML = '<span>无图</span>';
          picBox.classList.remove('has');
        }
      }
      /* 图注只在「用的不是这个词的主图」时才写一句，正常情况不留任何说明 */
      if(picSrc){
        picSrc.textContent = (okp && d.image_kind==='example')
          ? ('第 ' + ((d.image_example_index||0)+1) + ' 条例句配图') : '';
      }
      if(memo){
        var rows=[];
        rows.push([d.etyma || '无词根拆分']);
        if((d.senses||[]).length) rows.push([d.senses.map(function(x){ return (x.pos||'')+' '+(x.cn||''); }).join('；')]);
        if(d.short_phrase) rows.push([d.short_phrase]);
        if(d.word_variants) rows.push([d.word_variants]);
        memo.innerHTML = rows.map(function(r){ return '<div class="wc-m">'+esc(r[0])+'</div>'; }).join('');
      }
      /* 发音优先用百词斩英美音，没有才回落到教材原音/浏览器朗读 */
      var say=$('#wSay');
      if(say && okp){
        var au=d.audio_us||d.audio_uk||d.audio;
        if(au) WORD_AUDIO[word]=au;
      }
    }});
  }
  function friendlyWhy(d){
    var r=String(d.reason||'');
    if(/token/i.test(r)) return '没配百词斩 token，这张图取不到';
    if(/搜不到/.test(r)) return '百词斩没有这个词的条目';
    if(/HTTP|Timeout|URLError|网络/.test(r)) return '网络没通，这次没取到配图';
    return r ? ('没取到：'+r) : '这个词还没有配图';
  }
  var WORD_AUDIO = {};
  function bindDrill(w){
    if(PHASE==='first'){
      /* 第一轮四选一：选对=认识，选错=不认识并塞回队尾。点完给不到 1 秒反馈就自动翻下一个词。 */
      var base=bareCn(w.cn), box=$('#firstList');
      if(box) [].forEach.call(box.querySelectorAll('.opt'),function(b){
        b.addEventListener('click',function(){
          if(answered) return;
          gradeFirst(w, b, base);
        });
      });
      var sk=$('#wSkip');
      if(sk) sk.addEventListener('click',function(){ firstStep(1); });
      loadWordExtra(w.w);
      loadSents(w.w);
      var sy0=$('#wSay');
      if(sy0) sy0.addEventListener('click',function(){ playWord(w); });
      return;
    }
    if(PHASE==='review'){
      loadWordExtra(w.w);
      if(REV_SHOW[w.w]) loadSents(w.w);
      var sy2=$('#wSay');
      if(sy2) sy2.addEventListener('click',function(){ playWord(w); });
      /* 没翻开时点任意一档 = 先让你看答案，再判档；翻开后才真正落库。
         不这么做的话，三档按钮按下去人根本不知道自己判的是哪个意思。 */
      var reveal = function(){
        if(!REV_SHOW[w.w]){ REV_SHOW[w.w]=1; playWord(w); renderDrill(true); return true; }
        return false;
      };
      var y=$('#wRevYes');
      if(y) y.addEventListener('click',function(){ if(reveal()) return; gradeReview(w, 'ok'); });
      var fz=$('#wRevFuzzy');
      if(fz) fz.addEventListener('click',function(){ if(reveal()) return; gradeReview(w, 'fuzzy'); });
      var n=$('#wRevNo');
      if(n) n.addEventListener('click',function(){ if(reveal()) return; gradeReview(w, 'no'); });
      var fv=$('#wRevFav');
      if(fv) fv.addEventListener('click',function(){ toggleStar(w.w); });
      var qt=$('#wRevQuit');
      if(qt) qt.addEventListener('click',function(){ leaveReview(); });
      return;
    }
    if(mode==='card'){
      loadWordExtra(w.w);
      loadSents(w.w);
      var sy=$('#wSay');
      if(sy) sy.addEventListener('click',function(){ playWord(w); });
      var pv=$('#wPrev');
      if(pv) pv.addEventListener('click',function(){ if(qi>0){ qi--; renderDrill(); } });
      var nx=$('#wNext');
      if(nx) nx.addEventListener('click',function(){ if(qi<queue.length-1){ qi++; renderDrill(); } });
      var kb=$('#wKnow');
      if(kb) kb.addEventListener('click',function(){ markKnow(w, 1); });
      var fz=$('#wFuzzy');
      if(fz) fz.addEventListener('click',function(){ markKnow(w, 2); });
      var bg=$('#wBeg');
      if(bg) bg.addEventListener('click',function(){ markKnow(w, 0); });
      var br=$('#wBackRail');
      if(br) br.addEventListener('click',function(){ backToKnow(); });
      return;
    }
    var inp=$('#duoIn');
    if(inp){
      var maxLen=(w.w||'').length||24;
      inp.setAttribute('maxlength', String(maxLen));
      // 关键：输入法组合期间绝不改写 value（改写会打断组合状态，导致同一串被提交两次 = 双输入）
      var tidy=function(){
        var v=normalizeTyped(inp.value, w.w);
        if(inp.value!==v) inp.value=v;
      };
      inp.addEventListener('input',function(e){
        if(e && (e.isComposing || e.inputType==='insertCompositionText')) return; // 组合中，交给输入法
        tidy();
      });
      inp.addEventListener('compositionend', tidy);
      setTimeout(tidy, 0);
      inp.focus();
      inp.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); act(); } });
    }
    var spk=$('#spkBtn');
    if(spk){
      spk.addEventListener('click',function(){
        playWord(w); spk.classList.add('on');
        setTimeout(function(){ spk.classList.remove('on'); }, 1500);
      });
    }
    // 听写：中文提示 / 音标提示（分层，点了不会判错，只是给你台阶）
    var tipCn=$('#tipCn'), tipPh=$('#tipPh');
    if(tipCn){
      tipCn.addEventListener('click',function(){
        $('#hintCn').style.display='block';
        $('#hintCn').textContent='释义：'+(w.cn||'')+'　（'+(w.pos||'')+'）';
        tipPh.disabled=false;
        callTool('fetch_word_detail', {word:w.w}, {log:false});
      });
    }
    if(tipPh){
      tipPh.addEventListener('click',function(){
        $('#hintPh').style.display='block';
        $('#hintPh').textContent='音标：'+stripPh(w.ph)+'　首字母：'+w.w.charAt(0);
      });
    }
    // 挖空：直接在横线上填，填一处跳下一处，填满自动判分
    var slotEls=document.querySelectorAll('#slotrow .slot');
    if(slotEls.length){
      var blanks=[];
      [].forEach.call(slotEls,function(el){ if(el.tagName==='INPUT') blanks.push(el); });
      var fillAndAdvance=function(){
        var allFilled = blanks.every(function(el){ return (el.value||'').length>0; });
        if(allFilled){ judgeCloze(); return; }
        var next=blanks.filter(function(el){ return !(el.value||'').length; })[0];
        if(next) next.focus();
      };
      blanks.forEach(function(el,i){
        el.addEventListener('input',function(){
          var v=(el.value||'').replace(/[^a-zA-Z]/g,'').slice(0,1);
          el.value=v; el.classList.remove('bad');
          fillAndAdvance();
        });
        el.addEventListener('keydown',function(e){
          if(e.key==='Enter'){ e.preventDefault(); act(); return; }
          if(e.key==='Backspace' && !el.value){
            e.preventDefault();
            var prev=blanks[i-1]; if(prev){ prev.focus(); prev.value=''; prev.classList.remove('bad'); }
          }
        });
      });
      if(blanks[0]) blanks[0].focus();
    }
    if(mode==='pick'){
      var base=bareCn(w.cn);
      [].forEach.call(document.querySelectorAll('#duoOpts .opt'),function(b){
        b.addEventListener('click',function(){
          if(answered) return; answered=true;
          var good = b.getAttribute('data-cn')===base;
          [].forEach.call(document.querySelectorAll('#duoOpts .opt'),function(x){
            if(x.getAttribute('data-cn')===base) x.classList.add('ok');
            else if(x===b) x.classList.add('bad');
          });
          settle(good);
        });
      });
    }
    if(mode==='flip'){
      [].forEach.call(document.querySelectorAll('[data-flip]'),function(b){
        b.addEventListener('click',function(){
          var good = b.getAttribute('data-flip')==='1';
          [].forEach.call(document.querySelectorAll('[data-flip]'),function(x){
            x.disabled=true;
            if(x===b) x.style.borderColor = good? 'rgba(62,213,152,.6)' : 'rgba(255,87,87,.6)';
          });
          setTimeout(function(){ settle(good); }, 60);
        });
      });
    }
  }

  function judgeCloze(){
    if(answered) return;
    var target=curWord().w.toLowerCase().split('');
    var good=true;
    [].forEach.call(document.querySelectorAll('#slotrow .slot'),function(el){
      if(el.tagName!=='INPUT') return;
      var i=+el.getAttribute('data-i');
      var ok=(el.value||'').toLowerCase()===target[i];
      el.classList.add(ok?'ok':'bad');
      if(!ok) good=false;
    });
    settle(good);
  }

  function act(){
    if(mode==='card'){ if(PHASE==='know') endKnowPhase(); return; }   // 卡片态回车 = 这一遍看完了
    if(answered){ goNext(); return; }
    if(mode==='pick'){ showNudge('先选一个答案'); return; }
    if(mode==='flip'){ showNudge('先回忆一下，点上面两个按钮之一'); return; }
    if(mode==='cloze'){
      var blanks=[].filter.call(document.querySelectorAll('#slotrow .slot'),function(el){ return el.tagName==='INPUT'; });
      if(blanks.some(function(el){ return !(el.value||'').length; })){ showNudge('还有空没填完'); return; }
      judgeCloze(); return;
    }
    var el=$('#duoIn'), target=String(curWord().w);
    var v=normalizeTyped((el&&el.value)||'', target);
    if(!v){ showNudge('先把单词写出来'); return; }
    if(el) el.value=v;
    var good = v===target.toLowerCase();
    el.className = 'duo-in '+(good?'ok':'bad');
    settle(good);
  }
  function showNudge(txt){
    $('#duoFb').className='vx-fb on';
    $('#duoFbT').textContent=txt; $('#duoFbR').textContent='';
  }
  function settle(good){
    answered=true;
    var w=curWord();
    ST[w.w] = good? 'ok':'no';
    if(good){ rightN++; combo++; if(combo>bestCombo) bestCombo=combo; } else { wrongN++; combo=0; }
    $('#duoMain').className='vw-card '+(good?'ok':'bad');
    $('#duoFb').className='vfoot-fb on '+(good?'ok':'bad');
    $('#duoFbT').innerHTML = good
      ? ('答对了 · <em>'+esc(w.w)+'</em>')
      : ('正确答案 <em>'+esc(w.w)+'</em> · '+esc(stripPh(w.ph)));
    $('#duoFbR').textContent = good? ('连对 '+combo) : '这个词稍后会再问你一次';
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
    if(good) timer=setTimeout(goNext, 950);
  }
  function goNext(){
    clearTimeout(timer);
    if(!answered) return;
    if(ST[curWord().w]==='no') queue.push(queue[qi]);
    qi++;
    if(qi>=queue.length){ finish(); return; }
    renderDrill();
  }
  function finish(){
    answered=true; clearTimeout(timer);
    var acc=Math.round(rightN/Math.max(rightN+wrongN,1)*100);
    $('#duoMain').className='vw-card ok';
    $('#duoBody').innerHTML = '<div class="duo-q">'+rightN+' / '+(rightN+wrongN)+'</div>'+
      '<div class="sub">最高连对 '+bestCombo+' · 正确率 '+acc+'% · 答错的词已加入下次复习</div>';
    $('#duoFb').className='vfoot-fb';
    var btn=$('#duoBtn'); btn.style.display=''; btn.className='vcta'; btn.textContent='再来一组'; btn.setAttribute('data-end','1');
    $('#duoProg').style.width='100%';
    paintRail();
  }
  /* 按排卡结果算队列下标：排卡里没有的词（比如刚加进来的）排在后面，不丢 */
  function planQueue(){
    var idx={}; words.forEach(function(w,i){ idx[w.w]=i; });
    var out=[];
    WPLAN.order.forEach(function(r){ if(idx[r.w]!=null) out.push(idx[r.w]); });
    words.forEach(function(w,i){ if(!WPLAN.byWord[w.w]) out.push(i); });
    return out.length? out : words.map(function(_,i){ return i; });
  }
  function initRound(){
    /* 不打乱：第一轮按词组列表的顺序走，左边词表第一个就是第一张卡，
       用户看到「列表第 1 个」和「卡片」对不上就是因为以前 shuffle 过。 */
    WORDSET = true;
    /* 默认按词表顺序；排卡结果（word_plan）要是已经回来了，就按它排 —— 那是本机记录算的顺序 */
    queue = (WPLAN.order.length && WPLAN.key === CURG)
      ? planQueue()
      : words.map(function(_,i){ return i; });
    /* 第一轮的队列就是这个顺序；选错的词会被 push 到队尾重问一次，
       所以 FIRSTQ 会越用越长，进度条按它算。 */
    FIRSTQ = queue.slice();
    qi=0; combo=0; bestCombo=0; rightN=0; wrongN=0; ST={};
    KNOWN={}; FIRSTPASS={}; REQUEUE=[]; REASKED={};
    /* 一进背单词就是第一遍见词：整张词面 + 四选一。
       翻屏自评和默写加练都在这一轮之后，不是开场就摆在面前。 */
    PHASE='first'; mode='card';
    try{ if(localStorage.getItem('sd.vx.hidelist')==='1') toggleList(true); }catch(e){}
    paintModeBar(); paintHud(); paintRail(); renderDrill();
  }

  /* ---- 第一轮：整张词面 + 四选一 ---- */
  /* 动词序列不写进第二遍的回显文案：next 参数是给屏幕阅读器和外部的，
     别塞一个假英文词进去（以前这里错写成再问一次 / 跳过照看重问，语病）。 */
  function gradeFirst(w, btnEl, base, next){
    answered=true;
    var good = btnEl.getAttribute('data-cn')===base;
    /* 重问 = 这是第一轮里第二份副本（下标 >= 原始词数）；原来的做法拿
       FIRSTPASS[w.w]==='no' 当标记，那个值记下就永久为 no，每次翻回来都当成重问，
       队列永远滚不完（实测点了 191 次还在 111/111 打转）。 */
    var again = qi >= words.length;
    [].forEach.call(document.querySelectorAll('#firstList .opt'),function(x){
      x.disabled=true;
      if(x.getAttribute('data-cn')===base) x.classList.add('ok');
      else if(x===btnEl) x.classList.add('bad');
    });
    FIRSTPASS[w.w] = good? 'ok':'no';
    if(good){
      rightN++; combo++; if(combo>bestCombo) bestCombo=combo;
      /* 重问这次答对了 → 从待背里划掉，但第一轮仍记「这道题第一次答错了」 */
      if(again){ var ix=REQUEUE.indexOf(w.w); if(ix>=0) REQUEUE.splice(ix,1); }
    } else {
      wrongN++; combo=0;
      if(REQUEUE.indexOf(w.w)<0) REQUEUE.push(w.w);
      /* 第一次答错 → 把这个词塞到队尾重问一次；重问还错就不再往队尾塞，
         所以第一轮最多 n + n 步收尾，不会在队尾打转。 */
      if(!again){ REASKED[w.w]=1; FIRSTQ.push(FIRSTQ[qi]); }
    }
    $('#duoFb').className='vx-fb on '+(good?'ok':'bad');
    $('#duoFbT').innerHTML = good ? ('对了 · '+esc(w.w)) : ('正确答案 '+esc(base));
    /* 猜对和真认识在记忆里是两件事：第一轮不判错，但要说清「这次只算认出来」，
       别让人以为自己真拿下了 —— 第二遍的自评才是分档的地方。 */
    $('#duoFbR').textContent = good ? '先记成「认出来了」，第二遍再自己判认不认得' : '这个词排在队尾，等下再问一次';
    if(next != null) $('#duoFb').setAttribute('data-next', String(next));
    paintHud(); paintRail();
    /* 第一轮只记「认识 / 不认识」，不动 SM-2 的 box —— box 留给第二遍和加练 */
    callTool('grade_word', {word:w.w, mode:'pick', answer: good? w.w : String(btnEl.getAttribute('data-cn')||''), right: good},
      {log:false, onDone:function(res){
        var d=res.data||{};
        if(d.mem) MEM[w.w]={box:d.mem.box, due:d.mem.due, seen:d.mem.seen};
        paintRail();
      }});
    timer=setTimeout(function(){ firstStep(1, good); }, good? 700 : 1400);
  }
  /* 队尾重问：current 位置不变，把当前词 push 到 FIRSTQ 末尾；下一次 firstStep 照常 +1 */
  function firstStep(dir, good){
    clearTimeout(timer);
    var nxt=qi+dir;
    if(nxt<0) nxt=0;
    if(nxt>=FIRSTQ.length){ endFirstPass(); return; }
    /* 反馈条要留到下一题看得见：先跳到下一题，再在 1.4 秒后收掉。
       （以前先清后跳，用户根本看不到对错就被顶走了。） */
    qi=nxt; renderDrill(true);
    if(!good) fbTimer=setTimeout(function(){ var f=$('#duoFb'); if(f) f.className='vx-fb'; }, 1400);
  }
  function endFirstPass(){
    /* 第一轮结束：不认识的词已经在做题当中逐条塞回 FIRSTQ 队尾重问过了（答对才留 ok），
       到这里统一交接给第二轮翻屏自评。 */
    var nK=0, nN=0;
    words.forEach(function(x){
      if(FIRSTPASS[x.w]==='ok') nK++;
      else if(FIRSTPASS[x.w]==='no') nN++;
    });
    PHASE='know';
    queue = words.map(function(_,i){ return i; });
    qi=0; MODE_SYNC('card');
    paintModeBar(); paintHud(); paintRail(); renderDrill(true);
    /* 第一轮的战报让它在底部停 2 秒再收 —— 新界面不解释流程，但这一句是实打实的成绩。 */
    $('#duoFb').className='vx-fb on';
    $('#duoFbT').textContent='第一轮过完了：认识 '+nK+' · 不认识 '+nN;
    $('#duoFbR').textContent='';
    clearTimeout(fbTimer);
    fbTimer=setTimeout(function(){ var f=$('#duoFb'); if(f) f.className='vx-fb'; }, 2400);
  }
  function MODE_SYNC(m){ mode=m; }
  /* 新界面不再解释流程：该问的都在卡上，不加「第一遍 / 第二遍」这种说明。 */


  function modeLabel(m){
    return ({dictation:'听写默写', cloze:'挖空填写', cn2write:'看中文默写',
             pick:'看词选义', flip:'翻转自评', card:'回看词面'})[m] || m;
  }
  /* 模式栏只在第二轮自评结束之后才出现 —— 没认完就让人默写，是拿没学的东西考试 */
  function paintModeBar(){
    var box=$('#duoModes'); if(!box) return;
    if(PHASE!=='drill'){ box.innerHTML=''; box.style.display='none'; return; }
    box.style.display='';
    box.innerHTML = MODES.map(function(m){
      return '<button data-mode="'+m+'"'+(m===mode?' class="on"':'')+'>'+modeLabel(m)+'</button>';
    }).join('') + '<button class="endbt" id="wEndRound">下一组 →</button>';
  }
  function markKnow(w, val){
    if(PHASE!=='know') return;
    KNOWN[w.w] = val;
    if(val !== 1 && REQUEUE.indexOf(w.w)<0) REQUEUE.push(w.w);
    /* 三档自评照实各记一笔：
         认识(1) —— 判对，正常升档，往后推；
         模糊(2) —— 不判错，但间隔压到最短档，明天就回来（「好像见过」最需要马上再见面）；
         不认识(0) —— 打回最低档，也明天来。
       模糊和不认识不能共用同一个按钮：模糊的人没答错，不该进错词本。 */
    callTool('grade_word', {word:w.w, mode:('know'+val), answer:w.w,
                            right: (val===1? true : false), fuzzy: (val===2? 1 : 0)},
      {log:false, onDone:function(res){
        var d=res.data||{};
        if(d.mem) MEM[w.w]={box:d.mem.box, due:d.mem.due, seen:d.mem.seen};
        paintRail();
      }});
    stepKnow(1);
  }
  function stepKnow(dir){
    var nxt=qi+dir;
    if(nxt<0) nxt=0;
    if(nxt>=queue.length){ endKnowPhase(); return; }
    qi=nxt; renderDrill();
  }
  function endKnowPhase(){
    PHASE='drill'; mode='card';
    paintModeBar(); paintHud(); paintRail();
    var nK=0, nF=0, nN=0;
    for(var k in KNOWN){
      if(KNOWN[k]===1) nK++;
      else if(KNOWN[k]===2) nF++;
      else nN++;
    }
    var nAll=nK+nF+nN, nHard=nF+nN;
    /* 自评结束不换驾驶舱 —— 左栏词表、右栏战绩都得留着，只把中间舞台换成收尾卡。
       弹层模式的按钮（#duoBtn、#duoModes）在这一段一律不出现，免得「下一组」重复两遍。 */
    $('#duoMain').className='vx-quiz';
    $('#duoBody').innerHTML =
      '<div class="knowend">'+
        '<div class="kpis">'+
          '<div class="kp"><b>'+nAll+'</b><span>过了一遍</span></div>'+
          '<div class="kp ok"><b>'+nK+'</b><span>认识</span></div>'+
          '<div class="kp mid"><b>'+nF+'</b><span>模糊</span></div>'+
          '<div class="kp bad"><b>'+nN+'</b><span>不认识</span></div>'+
        '</div>'+
        '<p class="sub" style="margin-top:12px">'+
          (nHard? ('模糊 '+nF+' 个 + 不认识 '+nN+' 个 = 明天再来 '+nHard+' 个；想现在就练，从下面挑一个。')
                 : '这一组全认识，直接下一组也行。')+'</p>'+
        '<div class="vx-knowacts" style="margin-top:16px">'+
          '<button class="b2" id="wLookBack">回看词面（'+nAll+' 个）</button>'+
          (nHard? '<button class="b2" id="wDrillMiss">加练模糊+不认识（'+nHard+'）</button>' : '')+
        '</div>'+
        '<div class="vx-knowacts" style="margin-top:10px"><button class="b1" id="wEndRound2">这一组就这样，下一组</button></div>'+
      '</div>';
    $('#duoFb').className='vx-fb';
    var btn=$('#duoBtn'); if(btn) btn.style.display='none';
    var bar=$('#duoModes'); if(bar){ bar.innerHTML=''; bar.style.display='none'; }
    bindKnowEnd();
  }
  function bindKnowEnd(){
    var a=$('#wLookBack');
    if(a) a.addEventListener('click',function(){ PHASE='drill'; mode='card'; qi=0; paintModeBar(); renderDrill(); });
    var c=$('#wDrillMiss');
    if(c) c.addEventListener('click',function(){
      /* 模糊和不认识都算「没拿下来」，一起进加练 —— 模糊的人更需要练 */
      var miss=words.filter(function(x){ return KNOWN[x.w]===0 || KNOWN[x.w]===2; });
      if(miss.length){
        words=miss; MEM={}; words.forEach(function(x){ if(x.mem) MEM[x.w]=x.mem; });
        queue=words.map(function(_,i){return i;}); FIRSTQ=queue.slice();
        qi=0; PHASE='drill'; paintWordList();
      }
      setMode('dictation');
    });
    var e1=$('#wEndRound2');
    if(e1) e1.addEventListener('click',function(){ initRound(); });
  }
  /* 回到第一轮：只重过第一轮里答错、重问也没答对的那几个词 */
  function backToKnow(){
    var miss=words.filter(function(x){ return FIRSTPASS[x.w]!=='ok'; });
    if(!miss.length) miss=words.slice();
    FIRSTQ = miss.map(function(x){ return words.indexOf(x); });
    queue = FIRSTQ.slice();
    qi=0; PHASE='first'; mode='card';
    paintModeBar(); paintHud(); paintRail(); renderDrill();
  }
  function setMode(m){
    if(MODES.indexOf(m)<0) return;
    /* 认词阶段还没过完，模式按钮根本不该被点到；真点到了就顶回去 */
    if(PHASE==='know' && m!=='card'){ PHASE='drill'; }
    if(m!=='card') PHASE='drill';   // 加练模式只在第三段，切过去就离开自评
    mode=m;
    [].forEach.call(document.querySelectorAll('#duoModes button'),function(b){
      b.classList.toggle('on', b.getAttribute('data-mode')===m);
    });
    renderDrill();
    callTool('pick_word_mode', {mode:m}, {log:false});
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('#duoModes button'); if(!b) return;
    if(!b.getAttribute('data-mode')) return;
    setMode(b.getAttribute('data-mode'));
  });
  document.addEventListener('click',function(e){
    var b=e.target.closest('#wEndRound');
    if(b){ initRound(); }
  });
  $('#duoBtn').addEventListener('click',function(){
    if(this.getAttribute('data-end')){ initRound(); return; }
    act();
  });
  paintVocabHeader(); paintVocabMap(); paintWordList();
  document.addEventListener('keydown',function(e){
    if((e.key==='l'||e.key==='L') && $('#p-vocab').classList.contains('on')
       && !/^(INPUT|TEXTAREA)$/.test((e.target.tagName||''))){
      e.preventDefault(); toggleList(); return;
    }
    if(!$('#p-vocab').classList.contains('on')) return;
    var tag=(e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea') return;
    /* 第一轮：A–D 直接选项，← → 翻页跳过一个词 */
    if(PHASE==='first'){
      if(/^[a-dA-D]$/.test(e.key) && !answered){
        e.preventDefault();
        var fo=$('#firstList'), oo=fo? fo.querySelectorAll('.opt') : [];
        var fi='abcd'.indexOf(e.key.toLowerCase());
        if(oo[fi]) oo[fi].click();
        return;
      }
      if(e.key===' '){ e.preventDefault(); playWord(curWord()); return; }
      if(e.key==='ArrowRight'){ e.preventDefault(); firstStep(1); return; }
      if(e.key==='ArrowLeft'){ e.preventDefault(); firstStep(-1); return; }
      return;
    }
    /* 第二轮翻屏自评：上下 = 认识/不认识，左右 = 模糊，别让用户去按 Enter 进默写 */
    if(PHASE==='know' && mode==='card'){
      if(e.key==='ArrowDown'){ e.preventDefault(); markKnow(curWord(), 1); return; }
      if(e.key==='ArrowUp'){ e.preventDefault(); markKnow(curWord(), 0); return; }
      if(e.key==='ArrowRight' || e.key==='ArrowLeft'){ e.preventDefault(); markKnow(curWord(), 2); return; }
      if(e.key===' '){ e.preventDefault(); playWord(curWord()); return; }
      if(e.key==='Enter'){ e.preventDefault(); endKnowPhase(); return; }
      return;
    }
    /* 复习段：1/← = 忘了，2/→ = 还记得，空格发音 */
    if(PHASE==='review'){
      if(e.key==='1' || e.key==='ArrowLeft'){ e.preventDefault(); var n1=$('#wRevNo'); if(n1) n1.click(); return; }
      if(e.key==='2' || e.key==='ArrowDown'){ e.preventDefault(); var f1=$('#wRevFuzzy'); if(f1) f1.click(); return; }
      if(e.key==='3' || e.key==='ArrowRight'){ e.preventDefault(); var y1=$('#wRevYes'); if(y1) y1.click(); return; }
      if(e.key===' '){ e.preventDefault(); playWord(curWord()); return; }
      return;
    }
    if(e.key===' '){ e.preventDefault(); var s=$('#spkBtn')||$('#wSay'); if(s) s.click(); return; }
    if(e.key==='Enter'){ e.preventDefault(); act(); return; }
    if(mode==='pick' && /^[a-dA-D]$/.test(e.key)){
      var i='abcd'.indexOf(e.key.toLowerCase()), o=$('#duoOpts').querySelectorAll('.opt');
      if(o[i]) o[i].click();
    }
  });
  initRound();
/* ---------- 练习 ---------- */
  var PRAC = {source:null, part:null, list:[], idx:0, offset:0, judged:false, right:0, wrong:0};
  /* 科目中文名不再写死在代码里：从后端 item_sources 回传的 subject_name 读。
     写死的后果是——接进来一套考研数学，屏幕上还是显示「高数」这种猜的名字；
     而科目名本来就是数据的一部分，不该由前端决定。 */
  function subName(id){
    var hit = (D.sources||[]).filter(function(s){ return (s.subject||'')===id && s.subject_name; })[0];
    if(hit) return hit.subject_name;
    var t = ((D.subjects||[]).filter(function(s){ return s.id===id; })[0]||{}).name;
    return t || id;
  }
  function srcOf(id){
    return (D.sources||[]).filter(function(s){ return s.id===id; })[0] || null;
  }
  /* 五科题源不能平铺成五张卡：先选科目，再选这一科下面的题源。
     以前一平铺，屏幕上就是「英语两张、计算机两张、政治一张」，看起来像只有英语。 */
  var PRAC_SUB = null;   // 练习页当前看的科目（跟顶栏学科分开：顶栏是「我要学什么」，这里是「我要练什么」）
  function srcSubjects(){
    var seen={}, out=[];
    (D.sources||[]).forEach(function(s){
      var id=s.subject||'english';
      if(seen[id]){ seen[id].total += (s.total||0); seen[id].srcs.push(s); return; }
      seen[id]={id:id, total:(s.total||0), srcs:[s]};
      out.push(seen[id]);
    });
    return out;
  }
  function paintSrcBar(){
    var bar=$('#pracSrcs'); if(!bar) return;
    var subs=srcSubjects();
    if(!subs.length){ bar.innerHTML=''; return; }
    if(!PRAC_SUB || !subs.filter(function(x){ return x.id===PRAC_SUB; }).length) PRAC_SUB=subs[0].id;
    bar.innerHTML = subs.map(function(g){
      /* 科目按钮上的中文名：先看题源自带的 subject_name（导入的题有自己的名字），
         再看顶栏学科表，最后才退回 id —— 代码里不写任何学科名。 */
      var sub=(SUB_MAP[g.id]||{});
      var label=(g.srcs[0]||{}).subject_name || sub.name || subName(g.id);
      return '<button class="sbtn'+(g.id===PRAC_SUB?' on':'')+'" data-psub="'+esc(g.id)+'">' +
        '<i class="dot '+(sub.cls||'')+'"></i>' +
        '<span class="sn">' + esc(label) + '</span>' +
        '<span class="sm">' + g.srcs.length + ' 个题源 · ' + g.total + ' 题</span>' +
        '</button>';
    }).join('');
    var mine=(D.sources||[]).filter(function(s){ return (s.subject||'english')===PRAC_SUB; });
    var srcb=$('#pracSrcList');
    if(srcb){
      srcb.innerHTML = mine.map(function(s){
        var sub=(typeof SUB_MAP!=='undefined' && SUB_MAP[s.subject]) || {};
        return '<button class="'+(s.id===PRAC.source?'on':'')+'" data-src="'+esc(s.id)+'">' +
          '<span class="sn"><i class="dot '+(sub.cls||'')+'"></i>' + esc(s.name) + '</span>' +
          '<span class="sm">' + (s.total||0) + ' 题 · 判分 ' + esc(s.judge||'—') + '</span>' +
          '<span class="sj">' + esc(s.why||'') + '</span>' +
          '</button>';
      }).join('');
    }
  }
  function paintPractice(tool, res){
    if(tool==='analyze_errors'){ if(res.ok) paintErrors(res.data); return; }
    if(tool==='list_item_sources'){ if(res.ok && (res.data||{}).sources) D.sources=res.data.sources; paintSrcBar(); return; }
    if(!res.ok) return;
    var d=res.data||{};
    /* 从课堂「本讲考点」点过来的那次：服务端还没按想要的偏旁（SEL.partWant）返回，
       就补一枪按那个分部重取；一次到位后清掉待办，避免来回打转。 */
    if(SEL.partWant && d.part !== SEL.partWant){
      var want=SEL.partWant; SEL.partWant=null;
      callTool('pick_question_part', {part:want, source:PRAC.source}, {onDone:function(r2){ paintPractice('pick_question_part', r2); }});
      return;
    }
    if(SEL.partWant) SEL.partWant=null;
    if(d.source) PRAC.source=d.source;
    var srcNow=srcOf(PRAC.source);
    if(srcNow && srcNow.subject) PRAC_SUB=srcNow.subject;   // 题来自哪科，科目行就亮哪科
    /* 真题卷的 part 是「哪一套卷」，partition 的开关不该按它高亮分部分组，
       它自己的 parts 是按题型分的，照样能用。 */
    PRAC.part=d.part; SEL.part=d.part;
    PRAC.list=d.questions||[]; PRAC.idx=0; PRAC.offset=0;
    var src=srcOf(PRAC.source)||{};
    var judgeTXT = {exact:'本机直接判（有标准答案）', ai_exact:'先等值，判不出再交给模型',
                    ai_semantic:'按要点命中判，要模型', manual:'只能人看'}[src.judge]||'—';
    $('#pracMeta').textContent = (src.name||d.source||'题库') + ' · ' + (d.total||0) + ' 题 · ' +
      ((d.parts||[]).length) + ' 组 · 判分：' + judgeTXT;
    paintSrcBar();
    var grp = srcOf(PRAC.source);
    var statMap = {};
    /* 各分组的「做过/错」：现在只到题源一级（服务端 answers 按 source 统计），
       分组一级不编数字，只显示题量。 */
    $('#pracParts').innerHTML = (d.parts||[]).map(function(p){
      return '<button class="chip'+(p.name===d.part?' on':'')+'" data-part="'+esc(p.name)+'">' +
        esc(String(p.name).replace(/^第[一二三四五六七八九十]+部分：/,'').replace(/^paper:/,'')) +
        ' <span class="n">' + p.n + '</span></button>';
    }).join('');
    if(grp && grp.done){
      $('#pracMeta').textContent += ' · 本机已做 ' + grp.done + '（对 ' + grp.right + ' / 错 ' + grp.wrong + '）';
    }
    renderPracQ();
    paintSess();
    callTool('analyze_errors', {});
  }
  /* 同一道题的重复提交要挡掉：判分那一刻 answers 表就多一行，
     界面再点第二次不是「再确认一次」，而是拿同一道题把正确率刷两遍。
     遮罩加上 is 属性后，后续点击连事件都到不了按钮上。 */
  function pracLock(on){
    var q1=$('#pracOpts'), q2=$('#pracFill');
    [q1,q2].forEach(function(el){
      if(!el) return;
      if(on){ el.setAttribute('data-locked','1'); el.style.pointerEvents='none'; el.style.opacity='.72'; }
      else { el.removeAttribute('data-locked'); el.style.pointerEvents=''; el.style.opacity=''; }
    });
  }
  function renderPracQ(){
    pracLock(false);
    if(!PRAC.list.length){
      /* 一条题都没有的时候，别写「这个考点暂时取不到题」—— 那句话听起来像网络抖了一下，
         其实是这台机器上根本没有题源。两件事要分开说。 */
      var noSrc = !((D.sources||[]).length);
      $('#pracStem').textContent = noSrc
        ? '这台机器上还没有任何题源。上面那个虚线框可以把你自己的题库导进来（一张 JSON 就行）；不导的话，这一页没有题可刷 —— 不是加载失败。'
        : '这个考点暂时取不到题';
      $('#pracOpts').innerHTML='';
      var fill=$('#pracFill'); if(fill) fill.hidden = true;
      $('#pracNo').textContent='—';
      $('#pracPart').textContent='';
      $('#pracExp').classList.remove('on');
      /* 没题就别留着「下一题」可点 —— 点了会去翻一个空数组，什么也不发生，像是界面坏了 */
      ['#pracPrev','#pracNext'].forEach(function(s){ var b=$(s); if(b){ b.disabled=true; b.classList.add('off'); } });
      return;
    }
    ['#pracPrev','#pracNext'].forEach(function(s){ var b=$(s); if(b){ b.disabled=false; b.classList.remove('off'); } });
    var q=PRAC.list[PRAC.idx];
    PRAC.judged=false;
    pracLock(!!q.done);
    $('#pracNo').textContent = '第 ' + q.no + ' 题' + (q.done ? '（做过）' : '');
    $('#pracPart').textContent = q.group || q.part || '';
    var four = Object.keys(q.opts||{}).length>=2;
    /* 题源决定这题怎么答：四选一给按钮，填空/简答给输入框。
       以前只有英语语法一种题，所以这里写死只渲 ABCD —— 换成考点卡就会一屏空白。 */
    $('#pracStem').textContent = (q.stem||'') + (q.tail && !four ? (q.tail==='？'?'':q.tail) : '');
    $('#pracOpts').innerHTML = four ? Object.keys(q.opts).map(function(k){
      return '<button class="opt" data-k="'+k+'">' + '<i>'+k+'</i>' + esc(q.opts[k]) + '</button>';
    }).join('') : '';
    var fill=$('#pracFill');
    if(fill){
      fill.hidden = four;
      var inp=$('#pracInput'), btn=$('#pracSubmit');
      if(inp){ inp.value=''; inp.disabled=false; inp.classList.remove('ok','bad'); }
      if(btn){ btn.disabled=false; btn.textContent='提交'; }
      if(!four && inp) setTimeout(function(){ try{ inp.focus(); }catch(e){} }, 60);
    }
    $('#pracExp').classList.remove('on');
    $('#pracExpT').textContent='—';
    if($('#pracQuiz')) $('#pracQuiz').setAttribute('data-locked','0');
  }
  function paintSess(){
    if(!$('#pracSess')) return;
    var n=PRAC.right+PRAC.wrong;
    /* 没有题时进度写「—」：以前会算出「1 / 0」，那个 1 是假的下标 */
    var prog = PRAC.list.length ? (Math.min(PRAC.idx+1, PRAC.list.length) + ' / ' + PRAC.list.length) : '—';
    $('#pracSess').innerHTML =
      '<div class="s"><span class="k">本组进度</span><span class="v">' + prog + '</span></div>' +
      '<div class="s"><span class="k">本次会话</span><span class="v">' + n + ' 题 · 对 ' + PRAC.right + ' 错 ' + PRAC.wrong + '</span></div>' +
      '<div class="s"><span class="k">正确率（本次）</span><span class="v">' + (n? Math.round(PRAC.right*100/n)+'%' : '—') + '</span></div>';
  }
  var TAGS = ['没记住', '没看懂', '看错选项', '粗心'];
  var STAT_TAG_DIRTY = false;   // 打过错因标签 → 统计页的分布要重取
  function showTagBox(qno, part, source){
    var box=$('#tagBox'); if(!box) return;
    box.hidden=false;
    box.innerHTML = '<span class="lbl">错在哪</span>' +
      TAGS.map(function(t){ return '<button data-tag="'+t+'">'+t+'</button>'; }).join('') +
      '<span class="done">打完标，下次就按这个练</span>';
    box.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        var tag=b.getAttribute('data-tag');
        callTool('tag_error', {qno:qno, part:part, tag:tag, source:source||PRAC.source}, {onDone:function(r){
          if(!r.ok) return;
          box.querySelectorAll('button').forEach(function(x){ x.classList.remove('on'); });
          b.classList.add('on');
          var dn=box.querySelector('.done');
          if(dn) dn.textContent = '已记：' + tag;
          STAT_TAG_DIRTY = true;   // 统计页的错因分布下次进去要重取，不能拿旧缓存当现数
        }});
      });
    });
  }
  function hideTagBox(){ var box=$('#tagBox'); if(box){ box.hidden=true; box.innerHTML=''; } }

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
  /* 判完一题后的统一收尾：四种题源共用（以前是四选一点评专属的一段）。 */
  function afterJudge(q, d, wrongEl, fillEl){
    if(d.ans){
      if(wrongEl){ /* 选项按钮的 ok/bad 已在调用处标好 */ }
      if(fillEl){ fillEl.classList.add(d.ok?'ok':'bad'); }
      if(!Object.keys(q.opts||{}).length && !d.ok){
        $('#pracExpT').textContent = '标准答案：' + d.ans;
      }
    }
    var exp = d.explain || (d.full ? ('原句：' + d.full) : '');
    if(d.note && !d.judged) exp = (exp? exp + '\n\n' : '') + d.note;
    $('#pracExpT').textContent = exp || '—（这个题源本来就没有解析，不编）';
    $('#pracExp').classList.add('on');
    if(d.ok===true){ PRAC.right++; hideTagBox(); }
    else if(d.ok===false){ PRAC.wrong++; showTagBox(q.no, q.part, q.source); }
    /* ok===null：判不了（要模型 / 无标准答案）。不计对错，也不进错题本 —— 
       拿一个没判过的作答去污染正确率，比不判更糟。 */
    q.done=true;
    paintSess();
    callTool('analyze_errors', {}, {onDone:function(r2){ if(r2.ok) paintErrors(r2.data); }});
  }
  function submitPractice(chosen, wrongEl){
    if(PRAC.judged) return;
    var q=PRAC.list[PRAC.idx];
    if(!q) return;
    if(chosen!==undefined && !String(chosen).trim()) return;
    PRAC.judged=true;
    pracLock(true);
    var fillEl=null;
    if(chosen!==undefined){
      var inp=$('#pracInput'); fillEl=inp; if(inp) inp.disabled=true;
      var btn=$('#pracSubmit'); if(btn) btn.disabled=true;
    }
    callTool('grade_answer', {qno:q.no, chosen:chosen, kind:'practice', source:q.source||PRAC.source}, {onDone:function(res){
      var d=res.data||{};
      if(wrongEl){
        [].forEach.call(document.querySelectorAll('#pracOpts .opt'),function(x){
          if(x.getAttribute('data-k')===d.ans) x.classList.add('ok');
          else if(x===wrongEl) x.classList.add('bad');
        });
      }
      afterJudge(q, d, wrongEl, fillEl);
    }});
  }
  document.addEventListener('keydown', function(e){
    if(e.target && e.target.id==='pracInput' && e.key==='Enter'){
      e.preventDefault();
      submitPractice($('#pracInput').value);
    }
  });
  document.addEventListener('click',function(e){
    var wi=e.target.closest('#wrList .witem');
    if(wi){ pickWriting(wi.getAttribute('data-pid')); return; }
    var wg=e.target.closest('#wrGrade');
    if(wg){
      var pid=WR.pid, essay=($('#wrText')||{}).value || '';
      if(!pid){ return; }
      if(!essay.trim()){ var rb=$('#wrResult'); if(rb) rb.innerHTML='<p class="wr-note">先写点东西再交。</p>'; return; }
      var btn=wg; btn.disabled=true; btn.textContent='正在批改…';
      callTool('writing_grade', {pid:pid, essay:essay}, {onDone:function(res){
        btn.disabled=false; btn.textContent='交给本机 + 模型批改';
        if(!res.ok){ var r2=$('#wrResult'); if(r2) r2.innerHTML='<p class="wr-note">批改没跑通：'+esc(res.error||'未知')+'</p>'; return; }
        paintWritingResult(res.data||{});
        loadPage('writing');
      }});
      return;
    }
    var opt=e.target.closest('#pracOpts .opt');
    if(opt){ submitPractice(opt.getAttribute('data-k'), opt); return; }
    if(e.target.closest('#pracSubmit')){ submitPractice($('#pracInput').value); return; }
    var psub=e.target.closest('#pracSrcs button[data-psub]');
    if(psub){
      var pid=psub.getAttribute('data-psub');
      if(pid===PRAC_SUB) return;
      PRAC_SUB=pid;
      /* 换科目就把题源换成这一科的第一个，并真的取那一科的题——
         只改高亮不换题，屏幕上还是上一科的题，等于没换。 */
      var mine=(D.sources||[]).filter(function(s){ return (s.subject||'english')===pid; });
      var first=mine[0];
      if(!first){ paintSrcBar(); return; }
      PRAC.source=first.id; PRAC.part=null; SEL.part=null;
      PRAC.right=0; PRAC.wrong=0;
      paintSrcBar();
      callTool('pick_question_part', {source:first.id}, {onDone:function(res){ paintPractice('pick_question_part', res); }});
      return;
    }
    var srcb=e.target.closest('#pracSrcs button');
    if(srcb){
      var sid=srcb.getAttribute('data-src');
      if(sid===PRAC.source && PRAC.list.length) return;
      PRAC.source=sid; PRAC.part=null; SEL.part=null;
      PRAC.right=0; PRAC.wrong=0;
      paintSrcBar();
      callTool('pick_question_part', {source:sid}, {onDone:function(res){ paintPractice('pick_question_part', res); }});
      return;
    }
    var chip=e.target.closest('#pracParts .chip');
    if(chip){
      PRAC.right=0; PRAC.wrong=0;
      callTool('pick_question_part', {part:chip.getAttribute('data-part'), source:PRAC.source}, {onDone:function(res){ paintPractice('pick_question_part', res); }});
      return;
    }
    if(e.target.closest('#wrongOnly')){
      callTool('list_errors', {limit:50}, {onDone:function(res){
        var rows=((res.data||{}).errors)||[];
        var meta=$('#wrongOnlyMeta');
        if(!rows.length){ if(meta) meta.textContent='本机还没有答错过的题'; return; }
        PRAC.list = rows.map(function(r){
          /* 错题本是要重做一遍的：done 从 false 起，否则 renderPracQ 一标「（做过）」就判不动；
             真做对了后端 list_errors 自己会把这条摘掉，不用前端去猜对不对。 */
          return {no:r.qno, part:r.part, source:r.source, stem:r.stem||('第 '+r.qno+' 题'),
                  opts:r.opts||{}, full:r.full, ans:r.ans,
                  topic:'上次你选了 '+(r.chosen||'—'), done:false, fromError:true};
        });
        PRAC.idx=0; PRAC.right=0; PRAC.wrong=0;
        if(meta) meta.textContent = '共 ' + rows.length + ' 道错题 · 答对会自动从列表里划掉';
        renderPracQ(); paintSess();
      }});
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
      callTool('pick_question_part', {part:PRAC.part, n:10, offset:PRAC.offset, source:PRAC.source}, {onDone:function(res){
        if(res.ok && (res.data.questions||[]).length){ PRAC.list=res.data.questions; PRAC.idx=0; renderPracQ(); paintSess(); }
        else { $('#pracStem').textContent='这个考点刷完了，换个考点或从头再来。'; }
      }});
      return;
    }
    if(i<0) return;
    PRAC.idx=i; renderPracQ(); paintSess();
  }
  /* ---------- 考场 ---------- */
  var EX = {papers:[], paper:null, meta:null, groups:[], gi:0, qs:[], qi:0, state:{},
            ticking:false, minutes:120, left:120*60, timer:null, submitted:false};
  function paintExam(tool, res){
    if(!res.ok) return;
    var d=res.data||{};
    if(tool==='list_exam_papers'){
      EX.papers=d.papers||[];
      if(!EX.paper && EX.papers.length) EX.paper = EX.papers[0].id;
      $('#examMeta').textContent = EX.papers.length
        ? (EX.papers.length + ' 套卷 · 共 ' + (d.total_questions||0) + ' 题')
        : '还没有卷子';
      paintPaper();
      /* 一张卷都没有的时候不要再去取第一张 —— 那个请求一定会被拒，控制台会多一条红字 */
      if(EX.paper) callTool('get_exam_paper', {paper_id:EX.paper, group_index:0}, {onDone:function(r){ paintExam('get_exam_paper', r); }});
      else { paintExamQ(0); paintSheet(); }
      return;
    }
    if(tool==='get_exam_paper'){
      EX.meta=d.paper; EX.groups=d.groups||[]; EX.gi=d.group_index||0;
      loadExamHistory();
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
    if(!EX.qs.length){
      /* 一套卷都没有 vs 这套卷这一部分没题 —— 两件事不能共用一句话。
         空白实例上写「这套卷」会让人以为已经有卷子了。 */
      $('#examStem').textContent = !EX.papers.length
        ? '这台机器上还没有任何真题卷（exam_papers.json 不在数据目录里）。有卷子这一页才能开考。'
        : '这套卷的这个部分没有取到题目';
      $('#examOpts').innerHTML='';
      $('#examQNo').textContent='第 — 题'; $('#examQLabel').textContent='';
      ['#examPrevQ','#examNextQ'].forEach(function(s){ var b=$(s); if(b) b.disabled=true; });
      return;
    }
    ['#examPrevQ','#examNextQ'].forEach(function(s){ var b=$(s); if(b) b.disabled=false; });
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
      var cls = (st===1?'done':(st===0?'err':(i===curNo?'cur':'')));
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
      var sc=$('#examScore'); if(sc){ sc.hidden=true; sc.innerHTML=''; }
      loadExamHistory();
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
      var done=Object.keys(EX.state).length;
      var right=Object.keys(EX.state).filter(function(n){ return EX.state[n]===1; }).length;
      var total=(EX.meta||{}).total||0;
      $('#examHint').innerHTML = '交卷中：把本机答过的题交给服务端按题型算分…';
      callTool('submit_exam', {paper_id:EX.paper, seconds:examSeconds()}, {write:true, onDone:function(res){
        EX.submitted=true; EX.ticking=false;
        paintScore(res);
        var d=(res.data||{}), t=(d.totals)||{};
        if(!res.ok || !t){
          /* 说清是哪一种失败：没送到 / 送到了但服务端算不出分。
             原来一律写「本机服务无响应」，会把「服务端算分报错」也说成网络问题。 */
          var why2 = res.error || '服务端没返回分数';
          $('#examHint').innerHTML = '交卷没成：' + esc(why2) +
            (res.tries && res.tries > 1 ? '（试了 ' + res.tries + ' 次）' : '');
          return;
        }
        $('#examHint').innerHTML = '已交卷：做 ' + done + ' / ' + total + '，对 ' + right + '，错 ' + (done-right) +
          (done? '，本次正确率 ' + Math.round(right*100/done) + '%' : '，还没有作答记录') +
          '。分数按题型权重算，没答的题记 0 分；可以接着答，再交一次会多一条记录。';
        EX.submitted=false;
      }});
      return;
    }
  });
  function paintClock(){
    $('#clock').textContent = String(Math.floor(EX.left/60)).padStart(2,'0') + ':' + String(EX.left%60).padStart(2,'0');
    var m=$('#clockMeta');
    if(m) m.textContent = '按整卷 ' + (EX.minutes||120) + ' 分钟计时 · 到点不停卷，只提示';
  }
  paintClock();
  /* ---------- 统计 ---------- */
  function loadTagStats(force){
    var box0=$('#statTags');
    if(box0 && !force && !STAT_TAG_DIRTY && box0.getAttribute('data-loaded')==='1') return;
    callTool('error_tag_stats', {}, {onDone:function(res){
      STAT_TAG_DIRTY = false;
      if(box0) box0.setAttribute('data-loaded','1');
      var box=box0; if(!box) return;
      var d=(res.data||{});
      var rows=(d.tags)||[];
      if(!rows.length){
        box.innerHTML='<div class="sub" style="padding:16px 22px">还没有打过标签：答错一题就能选错因</div>';
        return;
      }
      var mx=Math.max.apply(null, rows.map(function(r){ return r.c; }));
      box.innerHTML = '<div class="statbars">' + rows.map(function(r){
        return '<div class="statrow"><span class="k">'+esc(r.tag)+'</span>' +
          '<span class="bar"><i class="en" style="width:'+Math.max(Math.round(r.c*100/mx),4)+'%"></i></span>' +
          '<span class="v">'+r.c+'</span></div>';
      }).join('') + '</div>';
    }});
  }

  var BAK = {armed:null};
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
    var d=(res.data)||{}, rows=d.backups||[], auto=d.auto||[];
    if(mt) mt.textContent = rows.length ? (rows.length + ' 份 · 存放在本机') :
      (auto.length ? ('还没自己导过 · 另有 '+auto.length+' 份恢复前自动副本') : '一份备份都还没有');
    if(!rows.length && !auto.length){
      box.innerHTML = '<p class="sub" style="padding:14px 0">还没有导出过备份——点上面那个按钮，整库会存成一份 JSON 快照。</p>';
      return;
    }
    function row(b, tag){
      var c=b.counts||{}, ev=(b.events===undefined? c.events : b.events);
      var cnt=(ev===undefined && !c.events) ? '' : (ev + ' 事件 · ' + (c.word_mem||0) + ' 词');
      return '<div class="bakrow'+(tag?' auto':'')+'"><span class="nm">'+esc(b.name)+(tag?'<i class="tag">'+tag+'</i>':'')+'</span>' +
        '<span class="sz">'+esc(b.mtime||'')+' · '+kb(b.size)+'</span>' +
        '<span class="sz">'+cnt+'</span>' +
        '<button class="btn sm'+(BAK.armed===b.name?' act':'')+'" data-bak="'+esc(b.name)+'">' +
        (BAK.armed===b.name? '再点一次确认恢复' : '恢复这份')+'</button></div>';
    }
    var html = rows.map(function(b){ return row(b, ''); }).join('');
    if(auto.length){
      html += '<p class="hint" style="margin:10px 0 4px">每次「恢复」之前，系统会先把当时的库另存一份——恢复错了还能退回来。' +
        '下面这些是自动副本，不是你自己导的：</p>' +
        auto.map(function(b){ return row(b, '自动'); }).join('');
    }
    box.innerHTML = html;
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

  /* ---------- 多端同步（G1） ---------- */
  var SYNC = {dir:null, device:null, armed:null};
  function paintSyncStatus(res){
    var d=(res.data)||{}; if(!res.ok) return;
    SYNC.dir = d.dir; SYNC.device = d.device;
    var h=$('#syncHint'), mt=$('#syncMeta');
    if(mt) mt.textContent = d.enabled === false ? '没开'
      : (d.device + ' · ' + (d.dir_exists ? (d.bundles + ' 个包在目录里') : '目录还没建'));
    if(h){
      var bits=[];
      bits.push('同步目录：' + (d.dir || '—'));
      bits.push(d.dir_exists ? '目录已建好，两台机器都指向它就能互相拉' : '目录还没建：点一次「推出本机」就建好了');
      bits.push('本机身份：' + (d.device || '—'));
      if(d.last_push) bits.push('上次推出：' + d.last_push);
      if(d.last_pull) bits.push('上次拉取：' + d.last_pull + '（来自 ' + (d.last_pull_from || '—') + '）');
      h.textContent = bits.join(' · ');
    }
  }
  // 推/拉的结果单独放一行：它和「目录在哪、上次什么时候推的」不是一回事，
  // 写在一起会被下一次状态刷新整段盖掉——刚推完的人就看不到自己推出了什么。
  function paintSyncResult(text, ok){
    var el=$('#syncResult'); if(!el) return;
    el.style.display = 'block';
    el.textContent = text || '';
    el.style.color = ok ? 'var(--tx)' : 'var(--bad)';
  }
  function paintSyncPeers(res){
    var box=$('#syncList'); if(!box) return;
    var d=(res.data)||{}, rows=d.peers||[];
    if(d.enabled === false){
      box.innerHTML = '<p class="sub" style="padding:14px 0">多端同步在配置里被关掉了。</p>';
      return;
    }
    if(!rows.length){
      box.innerHTML = '<p class="sub" style="padding:14px 0">同步目录里还没有任何包：在这台机器上点「推出本机」，' +
        '在另一台机器上把同步目录指到同一个文件夹，就能在这里看到对方并拉回来。</p>';
      return;
    }
    box.innerHTML = rows.map(function(p){
      var c=p.counts||{}, ev=(p.events===undefined? c.events : p.events);
      var cnt = p.broken ? ('读不出来：' + (p.why||'')) : (ev + ' 事件 · ' + (c.word_mem||0) + ' 词');
      var act = p.self
        ? '<span class="tagme">本机</span>'
        : '<button class="btn sm'+(SYNC.armed===p.name?' act':'')+'" data-sync="'+esc(p.name)+'">' +
          (SYNC.armed===p.name? '再点一次确认合并' : '拉回来合并')+'</button>';
      return '<div class="bakrow'+(p.self?' auto':'')+'">' +
        '<span class="nm">'+esc(p.device||p.name)+(p.self?'':'')+'</span>' +
        '<span class="sz">'+esc(p.created_at||p.mtime||'')+' · '+kb(p.size)+'</span>' +
        '<span class="sz">'+esc(cnt)+'</span>' + act + '</div>';
    }).join('');
  }
  document.addEventListener('click',function(e){
    var sp=e.target.closest('#syncPush');
    if(sp){
      sp.disabled=true; sp.textContent='推出中…';
      callTool('sync_push', {}, {onDone:function(r){
        sp.disabled=false; sp.textContent='推出本机';
        paintSyncResult(r.ok
          ? ('已推出 ' + r.data.name + '：' + r.data.events + ' 条事件 · ' + r.data.words + ' 词 · ' + kb(r.data.size))
          : ('推出失败：' + (r.error || (r.data && r.data.error) || '未知错误')), !!r.ok);
        callTool('sync_status', {}, {onDone:paintSyncStatus});
        callTool('sync_peers', {limit:20}, {onDone:paintSyncPeers});
      }});
      return;
    }
    var sr=e.target.closest('#syncList [data-sync]');
    if(sr){
      var nm=sr.getAttribute('data-sync');
      if(SYNC.armed!==nm){
        SYNC.armed=nm;
        [].forEach.call(document.querySelectorAll('#syncList [data-sync]'),function(x){
          x.textContent = (x.getAttribute('data-sync')===nm) ? '再点一次确认合并' : '拉回来合并';
          x.classList.toggle('act', x.getAttribute('data-sync')===nm);
        });
        return;
      }
      SYNC.armed=null; sr.disabled=true; sr.textContent='合并中…';
      callTool('sync_pull', {name:nm}, {confirm:true, onDone:function(r){
        var d=r.data||{};
        paintSyncResult(r.ok
          ? (d.note || ('已合并 ' + nm))
          : ('拉取失败：' + (r.error || d.error || '未知错误')), !!r.ok);
        callTool('sync_status', {}, {onDone:paintSyncStatus});
        callTool('sync_peers', {limit:20}, {onDone:paintSyncPeers});
        callTool('stats_overview', {}, {onDone:paintStats});
      }});
      return;
    }
  });

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
      /* 词库名不能写死：「晓艳学丞」是这一台机器上装的那本词书的名字，
         换一台机器、或空白实例里根本没有词书，写死就是一个假标签。 */
      ['词库 · ' + ((((D.vocab||{}).lists||[])[0]||{}).name || '没有词书'), (d.words||{}).total||0, 'vo'],
      /* 题库名同样取数据自报的，不写死「语法」——换个题库、或者根本没有题库时，
         标签得跟着变，否则统计页第一个数字就是假的。 */
      [((d.bank||{}).name || '题库').replace(/s*·s*.*$/,'').replace(/^英语/,'') || '题库', (d.bank||{}).total||0, 'en'],
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
    loadTagStats(true);   // 进统计页一律重取：错因分布是「现在几条」，不是缓存
    loadExplainStats();
    /* 可讲率这块要全量扫 2972 道题，1.5 秒左右才回得来，晚一步再挂，别让它堵住统计页第一段的显示。 */
    setTimeout(loadExplainCoverage, 30);
    $('#adviceNext').innerHTML = adviceText();
  }
  /* 讲题的家底：讲了多少、依据全过多少、被打回多少 —— 全是 explain 表里真有行数。
     这一块是给评委看的，也是给自己看的：一个敢把讲错率挂在墙上的产品，
     才敢让人现场随便点一道题。 */
  function loadExplainStats(){
    var box=$('#expCard'); if(!box) return;
    callTool('explain_stats', {}, {onDone:function(res){
      if(!res.ok){ box.innerHTML='<p class="sub">取不到讲题记录</p>'; return; }
      var d=res.data||{};
      var meta=$('#expMeta');
      if(meta) meta.textContent = '全部来自 explain 表 · 每讲一次留一版';
      if(!d.total){
        box.innerHTML = '<p class="sub">这一台机器还没讲过题。去练习页点一次「讲清这题」，这里就有一条记录。</p>';
        return;
      }
      var down=d.votes_down||0, up=d.votes_up||0, rated=up+down;
      var rate = rated? Math.round(up*100/rated)+'%' : null;
      box.innerHTML =
        '<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">' +
          '<div class="kpi"><div class="k">讲过</div><div class="v">'+d.total+'<small>道</small></div></div>' +
          '<div class="kpi"><div class="k">依据全过复核</div><div class="v">'+(d.verified||0)+'<small>道</small></div></div>' +
          '<div class="kpi"><div class="k">学生说讲得对</div><div class="v">'+up+'<small>次</small></div></div>' +
          '<div class="kpi"><div class="k">学生说讲错了</div><div class="v">'+down+'<small>次</small></div></div>' +
        '</div>' +
        '<p class="sub" style="margin-bottom:10px">' +
          (rate? ('被评价过的 '+rated+' 次里，讲对率 '+rate+'。') : '还没有人点过「讲得对 / 讲错了」——没有评价就不给讲对率，不拿空分母凑数字。') +
          '　共留底 '+(d.revisions||0)+' 版（同一题重讲一次就多一版，好查前后说法是否一致）。' +
          (d.by_model? ('　其中 '+(d.by_model)+' 版是模型写的。') : '　目前全部是本机证据版，模型没参与。') +
        '</p>' +
        '<div class="statbars">' + (d.by_source||[]).map(function(s){
          return '<div class="statrow"><span class="k">'+esc(s.source)+'</span>' +
            '<span class="bar en"><i style="width:'+Math.max(pct(s.n, d.total),2)+'%"></i></span>' +
            '<span class="v">'+s.n+' 道</span></div>';
        }).join('') + '</div>' +
        /* 可讲率要全量扫一遍（题库 2972 题，实测 1.5 秒），先占位后回填：
           不留一块空白让人以为「没数据」，也不让这一行堵住上面那段的显示。 */
        '<div id="expCoverage" class="sub" style="margin-top:14px">'
        + '可讲率：正在把题库全量扫一遍，扫完替换这一行。</div>';
    }});
  }
  /* 可讲率 / 复核率：这是在算账，不是在自夸。
     「只能靠背」的题不算失败 —— 原卷只给答案没给解析，本机不编，所以那部分如实挂零。 */
  function loadExplainCoverage(){
    var box=$('#expCard'); if(!box) return;
    callTool('explain_coverage', {}, {onDone:function(res){
      if(!res.ok || !box) return;
      var d=res.data||{};
      var slot=$('#expCoverage');
      var el=document.createElement('div');
      el.style.marginTop='14px';
      el.innerHTML = '<p class="sub" style="margin-bottom:8px">全量扫过一遍（不是抽样）：' +
        '能讲的 '+d.speakable+' / '+d.total+' 题，可讲率 '+(Math.round((d.speakable_rate||0)*1000)/10)+'%，' +
        '平均置信度 '+d.avg_confidence+'。</p>' +
        '<div class="statbars">' + Object.keys(d.by_verdict||{}).map(function(k){
          var n=d.by_verdict[k];
          return '<div class="statrow"><span class="k">'+esc(k)+'</span>' +
            '<span class="bar '+(k==='有据可依'?'en':(k==='只能靠背'?'ma':'cs'))+'"><i style="width:'+
            Math.max(pct(n, d.total),1)+'%"></i></span><span class="v">'+n+' 题</span></div>';
        }).join('') + '</div>';
      if(slot && slot.parentNode) slot.parentNode.replaceChild(el, slot);
      else box.appendChild(el);
    }});
  }

  /* ---------- 作文 ----------
     本机先数能数的：词数、要点命中、格式（应用文看称呼与落款）。
     语言与文采必须模型判 —— 模型没接就写「没判」，不给分也不给总分。
     拿字数凑总分就是编数字，这一页不许出现。 */
  var WR = {pid:null, paper:null, dims:null};
  function paintWritingList(res){
    var box=$('#wrList'); if(!box) return;
    var d=(res && res.data)||{};
    var ps=d.papers||[];
    var m=$('#wrMeta');
    if(m) m.textContent = ps.length? (ps.length+' 道真题 · 满分 15') : '没有作文题';
    if(d.dims) WR.dims = d.dims;
    var c=$('#cntWriting'); if(c) c.textContent = ps.length? (ps.length+' 题') : '—';
    if(!ps.length){ box.innerHTML='<p class="sub" style="padding:16px 22px">'+esc(d.note||'取不到作文题')+'</p>'; return; }
    box.innerHTML = ps.map(function(p){
      return '<button class="witem" data-pid="'+esc(p.id)+'">'+
        '<div class="wh"><b>'+esc(p.year+' 年')+'</b><span class="wtag">'+esc(p.kind)+'</span>'+
        '<span class="wtag">'+esc(p.min_words+' 词起')+'</span>'+
        (p.answered? '<span class="wtag">写过 '+p.answered+' 遍</span>' : '')+'</div>'+
        '<div class="wp">'+esc(String(p.prompt||'').replace(/\s+/g,' ').slice(0,120))+'</div>'+
        '<div class="wm">'+esc((p.points||[]).length+' 个要点 · '+((p.vocab||[]).length)+' 组中英对照')+'</div>'+
      '</button>';
    }).join('');
    /* 默认选中第一题，省得进来是一片空白还得猜怎么开始 */
    if(!WR.pid) pickWriting(ps[0].id, ps);
  }
  function pickWriting(pid, ps){
    var list = ps || null;
    if(!list){
      callTool('writing_list', {}, {onDone:function(r){ pickWriting(pid, ((r.data||{}).papers)||[]); }});
      return;
    }
    var p=null; list.forEach(function(x){ if(x.id===pid) p=x; });
    if(!p) return;
    WR.pid=pid; WR.paper=p;
    [].forEach.call(document.querySelectorAll('#wrList .witem'),function(b){
      b.classList.toggle('on', b.getAttribute('data-pid')===pid); });
    var box=$('#wrPrompt');
    if(box){
      box.innerHTML = '<div>'+esc(p.prompt)+'</div>'+
        (p.points && p.points.length? ('<div style="margin-top:10px"><b>要点</b>　'+p.points.map(function(x){ return esc(x); }).join('　/　')+'</div>') : '')+
        (p.vocab && p.vocab.length? ('<div style="margin-top:6px"><b>中英对照</b>　'+p.vocab.map(function(v){ return esc(v[0]+' → '+v[1]); }).join('　/　')+'</div>') : '')+
        '<div style="margin-top:6px;color:var(--tx3)">要求 '+esc(p.min_words)+' 词以上 · 满分 '+esc(p.max_score)+' 分</div>';
    }
    var st=$('#wrState'); if(st) st.textContent = (p.year||'')+' · '+(p.kind||'');
    var g=$('#wrGrade'); if(g) g.disabled = false;
    paintWrCount();
  }
  function paintWrCount(){
    var cnt=$('#wrCount'); if(!cnt) return;
    var t=$('#wrText');
    var n = t? countWords(t.value) : 0;
    var need = (WR.paper && WR.paper.min_words) || 0;
    cnt.textContent = n + ' 词' + (need? ('（要求 '+need+'）') : '');
  }
  function countWords(s){
    var m=String(s||'').match(/[A-Za-z][A-Za-z’\-]*/g);
    return m? m.length : 0;
  }
  function paintWritingMine(res){
    var box=$('#wrMine'); if(!box) return;
    var d=(res && res.data)||{};
    var items=d.items||[];
    var m=$('#wrMineMeta');
    if(m) m.textContent = d.stats? (d.stats.total+' 篇 · 有模型分 '+d.stats.scored+' · 没判 '+d.stats.unscored) : '—';
    if(!items.length){ box.innerHTML='<p class="sub" style="padding:16px 22px">还没写过</p>'; return; }
    box.innerHTML = '<div class="wr-mine">' + items.map(function(r){
      var l=r.local_json||{};
      return '<div class="wrm"><span class="ws">'+esc(String(r.ts||'').slice(5,16))+'</span>'+
        '<span class="wt">'+esc(r.kind||r.pid)+'　'+esc((String(r.essay||'').replace(/\s+/g,' ').slice(0,60)))+'</span>'+
        '<span class="ws">'+esc((l.words!=null? (l.words+' 词 · ') : '') + (l.points_hit!=null? ('要点 '+l.points_hit+'/'+l.points_total) : ''))+'</span>'+
        '<span class="ws">'+esc(r.score==null? (r.model==='local'? '本机部分' : '没判') : (r.score+' 分'))+'</span></div>';
    }).join('') + '</div>';
  }
  /* 批改结果：四档分开摆，本机算的与模型算的不混在一起说 */
  function paintWritingResult(d){
    var box=$('#wrResult'); if(!box) return;
    if(d && d.error){ box.innerHTML='<p class="wr-note">'+esc(d.error)+'</p>'; return; }
    var L=d.local||{}, dims=d.dims||null, max=d.max_score||15;
    /* dims 有两种形状：模型判过 → {content:1.0, language:2.0, ...}（对象）；
       模型没接 → null。老代码只认数组，对象进来就 dims.map 崩，
       于是「批改没跑通」。这里按 config 里的四档口径把对象摊平回数组，
       没给的档写成 null（显示「没判」），不给它编 0 分。 */
    if(dims && !dims.map){
      var conf=(WR.dims||[]);
      dims = conf.map(function(x){
        return { key:x.key, name:x.label||x.key, max:x.max,
                 score:(dims[x.key]!=null? dims[x.key] : null), by:'model' };
      });
    }
    var html='<div class="wrres">';
    if(dims){
      html += '<div class="wr-dims">' + dims.map(function(x){
        var off = x.by !== 'model';
        return '<div class="wr-dim'+(off? ' off' : '')+'">'+
          '<span class="dk">'+esc(x.name||x.key)+'</span>'+
          '<span class="db"><i style="width:'+pct(x.score, x.max)+'%"></i></span>'+
          '<span class="dv">'+esc(x.score==null? '没判' : (x.score+' / '+x.max))+'</span></div>';
      }).join('') + '</div>';
      if(d.level) html += '<p style="font-size:13px;margin:4px 0 10px"><b>'+esc(d.level)+'</b>'+
        (d.score!=null? ('　总分 '+esc(d.score)+' / '+esc(max)) : '　没给总分')+'</p>';
      if(d.summary) html += '<p class="sub">'+esc(d.summary)+'</p>';
    } else {
      html += '<div class="wr-dims">' + (WR.dims||[]).map(function(x){
        var mine = (x.key==='content' || x.key==='structure');
        return '<div class="wr-dim'+(mine? '' : ' off')+'">'+
          '<span class="dk">'+esc(x.name)+'</span>'+
          '<span class="db"><i style="width:'+(mine? 100 : 0)+'%"></i></span>'+
          '<span class="dv">'+esc(mine? '本机算了' : '没判')+'</span></div>';
      }).join('') + '</div>';
      html += '<p class="sub">没有总分 —— 语言与文采这两档只有模型能判，现在模型没接。'+
        '拿已经数出来的 '+esc(L.words)+' 词去凑一个总分出来，那就是编的。</p>';
    }
    if(L.point_hits && L.point_hits.length){
      html += '<div class="wr-pts">' + L.point_hits.map(function(h){
        return '<div class="wr-pt '+(h.hit? 'hit' : 'miss')+'"><b>'+(h.hit? '命中' : '没写')+'</b><span>'+esc(h.point)+'</span></div>';
      }).join('') + '</div>';
    }
    if(L.points_unknown && L.points_unknown.length){
      html += '<div class="wr-pts">' + L.points_unknown.map(function(p){
        return '<div class="wr-pt unk"><b>判不了</b><span>'+esc(p)+'</span></div>';
      }).join('') + '</div>';
    }
    if(d.errors && d.errors.length){
      html += '<div class="wr-pts">' + d.errors.map(function(e){
        return '<div class="wr-pt miss"><b>'+esc((e.type)||'问题')+'</b><span>'+esc(e.at||'')+'　'+esc(e.why||'')+'</span></div>';
      }).join('') + '</div>';
    }
    if(L.fmt_note) html += '<p class="sub">'+esc(L.fmt_note)+'</p>';
    if(d.note) html += '<p class="wr-note">'+esc(d.note)+'</p>';
    html += '</div>';
    box.innerHTML = html;
  }

  /* ---------- Agent 工具台 ---------- */
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
  /* ---------- 顶栏搜索：搜的是本机真数据 ---------- */
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
        setSubject(l.getAttribute('data-go-subject'));
        SEL.lesson=l.getAttribute('data-go-lesson');
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

  /* ---------- 练习：讲清这题（四段：定位/依据/判断/纠错） ----------
     跟前一版最大的不同：不再"问模型"。
     先把本机能核对的依据捞齐，再在依据上讲 —— 所以没接模型也讲得出，
     只不过措辞朴素。每句话下面挂着出处，学生能点回去核。
     依据一条都没有的题，它就说"无解析 · 可定位"（钉回本机哪一块资料）或"只能靠背"，不编。 */
  /* 别叫 EX：上面考场那套倒计时状态也叫 EX，同名 var 在同一个 IIFE 里
     后一个赋值会把前一个整个换掉 —— 表现就是考场「剩余时间 NaN:NaN」。
     讲题的这份叫 EXD。 */
  var EXD = {ref:null, doc:null};

  function exEsc(s){
    return String(s==null?'':s).replace(/[&<>]/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];
    });
  }

  function exOptMark(state){
    return state==='right' ? '✓' : (state==='wrong' ? '✗' : '·');
  }

  function paintExplain(doc){
    var head=$('#exHead');
    if(!head) return;
    if(!doc || (!doc.parts && !doc.verdict)){
      head.hidden=true;
      var pp=$('#exParts'); if(pp){pp.hidden=true; pp.innerHTML='';}
      var vv=$('#exVotes'); if(vv) vv.hidden=true;
      return;
    }
    $('#exVerdict').textContent = doc.verdict || '—';
    var vt = doc.verdict==='有据可依' ? 'good'
           : (doc.verdict==='依据部分成立' ? 'part'
           : (doc.verdict==='无解析 · 可定位' ? 'part' : 'weak'));
    $('#exVerdict').setAttribute('data-t', vt);
    $('#exConf').textContent = '置信 ' + Math.round((doc.confidence||0)*100) + '%';
    $('#exModel').textContent = doc.model==='local-evidence'
      ? '本机依据 · 未用模型' : ('模型 ' + (doc.model||'—'));
    head.hidden=false;

    var box=$('#exParts');
    box.innerHTML='';
    (doc.parts||[]).forEach(function(p){
      var el=document.createElement('div');
      el.className='expart';
      var h='<div class="pk">'+exEsc(p.title)+'</div>';
      h+='<div class="pt">'+exEsc(p.text)+'</div>';
      if(p.from || p.origin){
        h+='<div class="pf">来源：'+exEsc(p.from||'—')+
           (p.origin?('　·　'+exEsc(p.origin)):'')+'</div>';
      }
      (p.lines||[]).forEach(function(l){
        h+='<div class="exline"><span class="bd" data-ok="'+(l.verified?'1':'0')+'">'+
           exEsc(l.kind)+'</span><span class="tx">'+exEsc(l.text)+'</span>'+
           '<span class="wh">'+exEsc(l.where||'')+'</span></div>';
      });
      if((p.opts||[]).length){
        h+='<div class="exopts">';
        p.opts.forEach(function(o){
          h+='<div class="exopt" data-s="'+exEsc(o.state)+'">'+
             '<span class="ok">'+exOptMark(o.state)+'</span>'+
             '<span class="ol">'+exEsc(o.opt)+'</span>'+
             '<span class="ot">'+exEsc(o.text)+'</span>'+
             '<span class="on">'+exEsc(o.note||'')+'</span></div>';
        });
        h+='</div>';
      }
      (p.gaps||[]).forEach(function(g){
        h+='<div class="pf">讲不了的地方：'+exEsc(g)+'</div>';
      });
      el.innerHTML=h;
      box.appendChild(el);
    });
    box.hidden = !(doc.parts||[]).length;
    var ve=$('#exVotes');
    if(ve){ ve.hidden = !(doc.ok && doc.found!==false); }
  }

  function askExplain(){
    var b=$('#pracAi');
    var q=PRAC.list[PRAC.idx]||{};
    var src=q.source||PRAC.source||'grammar780';
    b.textContent='正在翻依据…';
    callTool('explain_question', {source:src, ref:q.ref||q.no, chosen:q.chosen||null},
      {onDone:function(res){
        var d=res.data||{};
        EXD.doc=d; EXD.ref=src+'|'+(q.ref||q.no);
        b.textContent='讲清这题（先找依据，再讲）';
        if(!d.ok){
          var el=$('#pracExpT');
          el.textContent='讲不了：'+(d.reason||'没有依据');
          paintExplain(null);
          return;
        }
        $('#pracExpT').textContent = d.verdict_note || '';
        paintExplain(d);
        $('#pracExp').classList.add('on');
      }});
  }

  function bindPracAi(){
    var b=$('#pracAi');
    if(!b) return;
    b.addEventListener('click', askExplain);
    ['exUp','exDown'].forEach(function(id){
      var el=$('#'+id);
      if(!el) return;
      el.addEventListener('click',function(){
        var q=PRAC.list[PRAC.idx]||{};
        var src=q.source||PRAC.source||'grammar780';
        callTool('rate_explain',
          {source:src, ref:q.ref||q.no, up:id==='exUp', down:id==='exDown'},
          {onDone:function(r){
            if(r.ok){
              el.textContent = id==='exUp' ? '已记下：讲得对' : '已记下：讲错了';
              $('#exVotes').hidden=true;
            }
          }});
      });
    });
  }

  /* ---------- 一句话入口 ----------
     三条规矩，代码里也照这三条写：
       听不懂就问（不给默认值）
       不是本机的东西就顶回来（不拿专升本冒充考研）
       认齐了才写盘，而且写盘要再点一次（改的是他的考试日期） */
  var ASK = {text:'', last:null, busy:false};

  function esc2(s){
    return String(s==null?'':s).replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  function askPaint(d, text){
    var box = $('#askOut');
    if(!box) return;
    box.hidden = false;
    var kind = d.kind || 'ask';
    var tone = (kind === 'planned' || kind === 'ready') ? 'planned'
             : ((kind === 'not_mine' || kind === 'refuse') ? 'refuse' : 'ask');
    box.setAttribute('data-k', tone);

    /* 认齐了，等你点一下（这一步还没写盘） */
    if(kind === 'ready'){
      var rd = d.ready || {};
      box.innerHTML =
        '<div class="say">' + esc2(d.say) + '</div>' +
        '<div class="why">' +
          '认出来的三样：<b>' + esc2((d.parsed||{}).goal || '—') + '</b> · ' +
          '<b>' + esc2(rd.exam_date) + '</b> · 每天 <b>' + esc2(rd.minutes_per_day) + ' 分钟</b><br>' +
          '还没写盘 —— 这一步只做预演。点下面那下才真改你的考试日期。' +
        '</div>' +
        '<div class="acts"><button class="btn act" id="askCommit">就这么排</button>' +
        '<button class="btn" id="askCancel">先算了</button></div>';
      var c = $('#askCommit');
      if(c) c.addEventListener('click', function(){ askCommit(text); });
      var x = $('#askCancel');
      if(x) x.addEventListener('click', function(){ box.hidden = true; });
      return;
    }

    /* 真排完了 */
    if(kind === 'planned'){
      var b = d.budget || {};
      var subs = (b.subjects || []).map(function(s){
        return '<div class="why" style="margin-top:8px">' +
          '<b>' + esc2(s.name) + '</b> 额度 ' + (s.quota_minutes||0) + ' 分钟 · 留 ' +
          (s.keep||0) + ' 讲 / 砍 ' + (s.cut||0) + ' 讲' +
          (s.reach ? '　排到「' + esc2(s.reach) + '」为止' : '　一讲都没排上') + '</div>';
      }).join('');
      box.innerHTML =
        '<div class="say">' + esc2(d.say) + '</div>' + subs +
        (b.cut_sample && b.cut_sample.length
          ? '<div class="why"><b>先砍掉的几讲（共 ' + (b.cut_total||0) + ' 讲）：</b>' +
            b.cut_sample.slice(0,4).map(function(c2){
              return '<br>· ' + esc2(c2.title) +
                (c2.chapter ? '　<i style="opacity:.55">[' + esc2(c2.chapter) + ']</i>' : '') +
                '<i style="opacity:.65">　' + esc2(c2.why||'') + '</i>';
            }).join('') + '</div>'
          : '') +
        '<div class="acts"><button class="btn act" id="askGoSched">看排出来的这一周</button></div>';
      var g = $('#askGoSched');
      if(g) g.addEventListener('click', function(){ go('schedule'); });
      return;
    }

    /* 顶回来 / 问清楚 */
    var why = '';
    if(kind === 'not_mine' || kind === 'refuse'){
      why = d.why ? esc2(d.why) : '';
    } else if(d.need === 'date'){
      why = '日期的位置还空着 —— ' + esc2(d.date_from || '你没说哪天') + '。' +
            '我不替你挑一个：猜出来的日子，排出来的表你也用不了。';
    } else if(d.need === 'minutes'){
      why = '每天多久还空着 —— ' + esc2(d.minutes_from || '你没说每天多久') + '。' +
            '给个区间（10 ~ 720 分钟）我才好切。';
    } else if(d.need === 'goal'){
      why = '目标还空着 —— 说个名字，例如「专升本」「英语四级」「考研」。';
    }
    box.innerHTML =
      '<div class="say">' + esc2(d.say || '这句话我没听懂。') + '</div>' +
      (why ? '<div class="why">' + why + '</div>' : '') +
      '<div class="acts"><button class="btn" id="askAgain">我再写一句</button></div>';
    var a = $('#askAgain');
    if(a) a.addEventListener('click', function(){
      var inp2 = $('#askIn'); if(inp2){ inp2.value=''; inp2.focus(); }
    });
  }

  /* 预演：只拆不写。跟真排走同一条判断链，所以两边说的话永远一致。 */
  function askPreview(){
    if(ASK.busy) return;
    var inp = $('#askIn');
    var text = String((inp && inp.value) || '').trim();
    if(!text){ if(inp) inp.focus(); return; }
    ASK.text = text; ASK.busy = true;
    var btn = $('#askGo');
    if(btn){ btn.disabled = true; btn.textContent = '正在认…'; }
    callTool('intent_parse', {text:text}, {onDone:function(res){
      ASK.busy = false;
      if(btn){ btn.disabled = false; btn.textContent = '说给它听'; }
      ASK.last = res.data || {};
      askPaint(ASK.last, text);
    }});
  }

  /* 真排：先撞一次 PERM_CONFIRM（后端回 need_confirm），拿到确认再打一次。
     中间那一下就是「改你的考试日期，你自己点」。 */
  function askCommit(text){
    callTool('plan_from_sentence', {text:text}, {onDone:function(res){
      if(res.need_confirm){
        var box = $('#askOut');
        if(box){
          box.setAttribute('data-k','ask');
          box.innerHTML =
            '<div class="say">这一步会改你的考试日期和每天时长，得你点一下。</div>' +
            '<div class="why">工具 <b>' + esc2(res.tool) + '</b> · 权限 <b>confirm</b> · ' +
            '写的是本机 kv 表里的 plan.exam_date / plan.minutes_per_day</div>' +
            '<div class="acts"><button class="btn act" id="askYes">确认，就按这个排</button></div>';
          var y = $('#askYes');
          if(y) y.addEventListener('click', function(){
            callTool('plan_from_sentence', {text:text}, {confirm:true, onDone:function(r2){
              askPaint(r2.data || {kind:'ask', say:(r2.error||'没排出来')}, text);
              if(r2.ok) refreshAfterPlan();
            }});
          });
        }
        return;
      }
      askPaint(res.data || {kind:'ask', say:(res.error || '没排出来')}, text);
      if(res.ok) refreshAfterPlan();
    }});
  }

  /* 排完了把受影响的页面重取一遍，否则今日页还挂着旧数字 */
  function refreshAfterPlan(){
    callTool('plan_today', {}, {log:false, onDone:function(r){ if(r.ok) paintToday(r,'today','plan_today'); }});
    callTool('plan_budget', {}, {log:false, onDone:function(r){
      if(r.ok && r.data && r.data.set && typeof paintBudget === 'function') paintBudget(r.data);
    }});
  }

  function bindAsk(){
    var goBtn = $('#askGo');
    if(goBtn) goBtn.addEventListener('click', askPreview);
    var inp = $('#askIn');
    if(inp){
      inp.addEventListener('keydown', function(e){
        if(e.key === 'Enter'){ e.preventDefault(); askPreview(); }
      });
    }
    /* 从这里能一步跳到「AI 主导」那条路：快路只排本机已有的课，
       本机没有的课它不会去外面找 —— 找课是另一条腿，得说一声才动。 */
    var toAi = $('#askToAi');
    if(toAi) toAi.addEventListener('click', function(){
      if(typeof gOpen === 'function'){ gOpen(); gateIntro(); }
    });
    var tryBox = $('#askTry');
    if(tryBox){
      tryBox.addEventListener('click', function(e){
        var b = e.target.closest ? e.target.closest('button[data-say]') : null;
        if(!b) return;
        var s = b.getAttribute('data-say');
        if(inp){ inp.value = s; }
        askPreview();
      });
    }
  }


  /* =========================================================================
     用哪家的模型说话
     三家里点一家就换；点「贴凭据」能把平台导出的登录态贴进来，不装那个平台的
     客户端也能用。所有状态文字都来自后端 ai_providers 的真实快照 —— 界面不猜。
     ========================================================================= */
  var AI = {state:null, prov:null};
  function aiSel(){ return (AI.state && AI.state.current) || 'apikey'; }
  function paintAiProvs(res){
    if(!res.ok){ var m=$('#aiMeta'); if(m) m.textContent='取不到'; return; }
    var d=res.data||{}; AI.state=d;
    var cur=d.current||'apikey', box=$('#aiProvs'); if(!box) return;
    var meta=$('#aiMeta'); if(meta) meta.textContent = '现在用：' + (d.current_name||cur);
    box.innerHTML = (d.providers||[]).map(function(p){
      var dot = p.usable ? 'ok' : (p.configured ? 'warn' : 'bad');
      return '<div class="apr'+(p.selected?' on':'')+'" data-ai="'+esc(p.provider)+'">' +
        '<span class="dot '+dot+'"></span>' +
        '<span class="nm">'+esc(p.name)+'</span>' +
        '<span class="why">'+esc(p.why||'')+'</span>' +
        (p.selected ? '<span class="sel">正在用</span>' : '') +
        ((p.provider!=='apikey' && !p.configured) ? '<button class="btn sm" data-ailogin="'+esc(p.provider)+'">贴凭据</button>' : '') +
        '<button class="btn sm ghost" data-aiprobe="'+esc(p.provider)+'">试一句</button>' +
        '</div>';
    }).join('');
    var sel=$('#aiModelSel');
    if(sel){
      sel.innerHTML = '<option value="'+esc(d.model||'')+'">'+esc(d.model||'（没选模型）')+'</option>';
    }
    var st=$('#aiState');
    if(st){
      var p0=null; (d.providers||[]).forEach(function(p){ if(p.provider===cur) p0=p; });
      st.textContent = p0 ? (p0.name + '：' + (p0.why||'') + (p0.from ? '（' + p0.from + '）' : '')) : '';
    }
    var lg=$('#aiLoginRow'); if(lg && !(lg.getAttribute('data-open')==='1')) lg.hidden=true;
  }
  function loadAiProvs(){
    callTool('ai_providers', {}, {log:false, onDone:paintAiProvs});
  }
  function aiDo(name, args, after){
    callTool(name, args, {onDone:function(res){
      var why=$('#aiLoginWhy');
      if(!res.ok){
        if(why) why.textContent = res.error || ('没成：' + ((res.data||{}).error||''));
        return;
      }
      if(why) why.textContent = '';
      if(res.data && res.data.state) AI.state=res.data.state;
      if(res.data && res.data.note){ var s=$('#aiState'); if(s) s.textContent=res.data.note; }
      if(after) after(res);
      loadAiProvs();
    }});
  }
  /* ---- 导题：把「换一门考试」这件事变成一次粘贴 ----
     不做题库市场、不做爬虫 —— 只认一份清单。清单进来之后它和自带题源一样，
     能练、能判、能讲、错因回流，唯一的差别是 names 来自数据而不是代码。 */
  /* 导完题要立刻在页面上看见：重拉一次题源表，然后自动选中刚导进来的那套。 */
  function refreshSrcs(){
    callTool('list_item_sources', {}, {log:false, onDone:function(res){
      if(!res.ok) return;
      D.sources=(res.data||{}).sources||[];
      paintSrcBar();
      var last=(D.sources||[]).filter(function(s){ return s.origin==='import'; }).pop();
      if(last){
        PRAC.source=last.id; PRAC.part=null; SEL.part=null; PRAC.right=0; PRAC.wrong=0;
        paintSrcBar();
        callTool('pick_question_part', {source:last.id}, {onDone:function(r2){ paintPractice('pick_question_part', r2); }});
      }
    }});
  }

  function bindImporter(){
    var box=$('#impBox'); if(!box) return;
    var sample=$('#impSample');
    if(sample) sample.addEventListener('click', function(){
      var id=$('#impId'), sub=$('#impSub'), sn=$('#impSubName'), js=$('#impJson');
      if(id && !id.value) id.value='ky-math-2023';
      if(sub && !sub.value) sub.value='kaoyan-math';
      if(sn && !sn.value) sn.value='考研数学';
      if(js) js.value = JSON.stringify([
        {no:1, stem:'当 x→0 时，sin x / x 的极限是', opts:{A:'0',B:'1',C:'∞',D:'不存在'}, ans:'B', explain:'重要极限 lim(x→0) sin x / x = 1', topic:'极限'},
        {no:2, stem:'函数 f(x)=x² 在 x=2 处的导数是', opts:{A:'2',B:'4',C:'8',D:'1'}, ans:'B', explain:"f'(x)=2x，代入得 4", topic:'导数'}
      ], null, 2);
      var why=$('#impWhy'); if(why) why.textContent='这是样例，换成你自己的就能导。';
    });
    var go=$('#impGo');
    if(go) go.addEventListener('click', function(){
      var why=$('#impWhy');
      var sid=(($('#impId')||{}).value||'').trim();
      var sub=(($('#impSub')||{}).value||'').trim();
      var sname=(($('#impSubName')||{}).value||'').trim();
      var raw=(($('#impJson')||{}).value||'').trim();
      if(!sid || !sub || !raw){ if(why) why.textContent='id、科目、题目这三样得有。'; return; }
      var items;
      try{ items = JSON.parse(raw); }catch(e){ if(why) why.textContent='这段不是合法 JSON：'+e.message; return; }
      if(!(items instanceof Array)) items = items.items || items.questions;
      if(!(items instanceof Array)){ if(why) why.textContent='要一个数组（或者 {items:[...]}）。'; return; }
      if(why) why.textContent='导着…';
      callTool('source_import', {source:sid, subject:sub, subject_name:sname||sub, items:items}, {onDone:function(res){
        if(res.need_confirm){
          if(why) why.textContent='这会写盘，再点一次确认。';
          callTool('source_import', {source:sid, subject:sub, subject_name:sname||sub, items:items},
            {confirm:true, onDone:function(r2){
              var d=r2.data||{};
              if(why) why.textContent = r2.ok ? ('收下 '+d.kept+' 道'+(d.dropped?('，丢掉 '+d.dropped+' 道（'+((d.dropped_sample||[])[0]||{}).why+'）'):'')+'。判分档：'+d.judge)
                                             : ('没成：'+(d.error||r2.error||'不知道原因'));
              if(r2.ok){ refreshSrcs(); }
            }});
          return;
        }
        var d=res.data||{};
        if(why) why.textContent = res.ok ? ('收下 '+d.kept+' 道') : ('没成：'+(d.error||''));
        if(res.ok) refreshSrcs();
      }});
    });
  }

  function bindAi(){
    document.addEventListener('click', function(e){
      // 「试一句」必须先于 [data-ai] 判：按钮在卡片里面，closest('[data-ai]') 会先抓到卡片，
      // 于是点「试一句」变成「换这家」，按钮自己的处理永远轮不到（实测点了没反应就是这个）。
      if(e.target.closest('[data-aiprobe]')){
        var pb0 = e.target.closest('[data-aiprobe]');
        var who = pb0.getAttribute('data-aiprobe');
        if(pb0.hasAttribute('data-busy')) return;
        pb0.setAttribute('data-busy','1');
        pb0.setAttribute('disabled','1');
        pb0.textContent = '问着…';
        var t0 = Date.now();
        callTool('ai_probe', {provider:who}, {onDone:function(res){
          pb0.removeAttribute('disabled');
          pb0.removeAttribute('data-busy');
          var d = res.data || {};
          var took = d.elapsed_ms || (Date.now()-t0);
          var s0=$('#aiState');
          if(d.usable){
            pb0.textContent = '能用 · ' + (took/1000).toFixed(1) + 's';
            pb0.setAttribute('data-r','ok');
            if(s0) s0.textContent = d.provider_name + ' 真回话了：' + (d.said||'') +
              '（' + took + ' 毫秒 · 模型 ' + (d.model||'—') + '）';
          }else{
            pb0.textContent = '不通';
            pb0.setAttribute('data-r','bad');
            if(s0) s0.textContent = d.provider_name + ' 没打通：' + (d.reason || d.note || '不知道原因') +
              (d.elapsed_ms ? '（等了 ' + took + ' 毫秒）' : '');
          }
        }});
        return;
      }
      var pick = e.target.closest('[data-ai]');
      if(pick){
        var p = pick.getAttribute('data-ai');
        if(p === aiSel()) return;
        aiDo('ai_use', {provider:p});
        return;
      }
      var lg = e.target.closest('[data-ailogin]');
      if(lg){
        AI.prov = lg.getAttribute('data-ailogin');
        var row=$('#aiLoginRow');
        if(row){ row.hidden=false; row.setAttribute('data-open','1');
          var w=$('#aiLoginWhy'); if(w) w.textContent = '把 '+AI.prov+' 那边导出的凭据整份贴进来';
          var t=$('#aiCred'); if(t) t.focus(); }
        return;
      }
      if(e.target.closest('#aiLoginCancel')){
        var r2=$('#aiLoginRow'); if(r2){ r2.hidden=true; r2.removeAttribute('data-open'); }
        return;
      }
      if(e.target.closest('#aiLoginGo')){
        var v=($('#aiCred')||{}).value||'';
        if(!v.trim()){ var w2=$('#aiLoginWhy'); if(w2) w2.textContent='空的，没东西可认'; return; }
        aiDo('ai_login', {provider:AI.prov, credential:v}, function(){
          var r3=$('#aiLoginRow'); if(r3){ r3.hidden=true; r3.removeAttribute('data-open'); }
          var c=$('#aiCred'); if(c) c.value='';
        });
        return;
      }
      if(e.target.closest('#aiRefresh')){ aiDo('ai_refresh', {provider:aiSel()}); return; }
      if(e.target.closest('#aiForget')){
        aiDo('ai_forget', {provider:aiSel()}, null);
        return;
      }
      if(e.target.closest('#aiModelsGo')){
        callTool('ai_models', {provider:aiSel()}, {onDone:function(res){
          var sel=$('#aiModelSel'), st=$('#aiState');
          if(!res.ok){ if(st) st.textContent = res.error || '没拿到清单'; return; }
          var ms=(res.data||{}).models||[];
          if(!ms.length){ if(st) st.textContent = (res.data||{}).reason || '这家没给出模型'; return; }
          if(sel){
            sel.innerHTML = ms.map(function(m){
              return '<option value="'+esc(m.id)+'">'+esc(m.name||m.id)+'</option>';
            }).join('');
            if((res.data||{}).current) sel.value = res.data.current;
          }
          if(st) st.textContent = '这家现在能给 '+ms.length+' 个模型，选一个就行。';
        }});
        return;
      }
    });
    var sm=$('#aiModelSel');
    if(sm) sm.addEventListener('change', function(){
      aiDo('ai_use', {provider:aiSel(), model:sm.value});
    });
  }


  /* ==========================================================================
     AI 接管层：空白实例进去只有这一个输入框。
     这不是聊天框 —— 后端 intake 是一条有站点的流水线（听 / 翻本机 / 出去找 / 核一遍 / 拟计划），
     这里的动画一格一格对着 stages 里的真实 status 画。没跑过的站不会亮。
     ========================================================================== */
  var GATE = {state:null, files:[], busy:false, picked:{}, skipped:false, armed:false};
  var GKEY = 'sd.gate.skip';

  function gEl(id){ return document.getElementById(id); }
  /* AI 不是一个单独的页面，是今日页的一个模式。切换只藏整块，不删节点：
     侧栏、顶栏、设置入口永远在 —— 藏掉侧栏等于没有设置。 */
  var MODEKEY = 'sd.today.mode';
  function setMode(m, quiet){
    var ai = (m !== 'cards');
    var g=gEl('aiGate'), c=gEl('cardSec');
    if(g) g.hidden = !ai;
    if(c) c.hidden = !!ai;
    var b1=gEl('modeAi'), b2=gEl('modeCards');
    if(b1) b1.classList.toggle('on', ai);
    if(b2) b2.classList.toggle('on', !ai);
    var sub=gEl('mbSub');
    if(sub) sub.textContent = ai ? '你说一句，它跑完五站再给候选' : '按你库里的真数据排好的卡片';
    if(!quiet){ try{ sessionStorage.setItem(MODEKEY, ai? 'ai':'cards'); }catch(e){} }
    if(ai){ var box=gEl('gIn'); if(box && !quiet){ /* 不抢焦点：进门先让人看见问题，不是让人看见光标 */ } }
  }
  function gOpen(){ setMode('ai'); }
  function gClose(){
    setMode('cards');
    try{ sessionStorage.setItem(GKEY,'1'); }catch(e){}
  }
  function gSay(t){
    var f=gEl('gFoot'); if(f) f.innerHTML = t || '';
  }
  /* 进门那句话得说实话：库里有东西就说有，空就说空。
     空实例和内容实例共用同一句「你想考什么？」，差别写在这行小字里。 */
  function gateIntro(){
    var n=(SUB||[]).length, src=((D&&D.sources)||[]).length;
    var sub=gEl('gSub'); if(!sub) return;
    var tit=gEl('gTitle'); if(tit) tit.textContent = n? '接下来怎么排？' : '你想考什么？';
    sub.textContent = n
      ? ('本机已经有 '+n+' 门课'+(src? ('、'+src+' 个题源'):'')+'。你说一句新的目标，它按新目标重排；'
         + '不想动就切到卡片看现在排到哪。')
      : '这台机器上还什么都没有。说一句就行 —— 考什么、哪天考、每天能学多久。缺哪样它会问，不替你填。';
  }

  /* ---- 流水线 ---- */
  function gPaintPipe(s){
    var box=gEl('gPipe'); if(!box) return;
    var st=(s && s.stages) || [];
    if(!st.length){ box.hidden=true; return; }
    box.hidden=false;
    box.innerHTML = st.map(function(x,i){
      var logs=(x.log||[]).map(function(L){ return '<div>'+esc(L)+'</div>'; }).join('');
      return '<div class="pst" data-s="'+esc(x.status||'pending')+'">'+
        '<span class="dot"><i></i></span>'+
        '<div class="ph"><b>'+esc(x.title)+'</b><em>'+(i+1)+'/'+st.length+'</em></div>'+
        '<div class="ps">'+esc(x.sub)+'</div>'+
        (logs? '<div class="plog">'+logs+'</div>' : '')+
      '</div>';
    }).join('');
  }

  /* ---- 它问你的话 ---- */
  var ASKFIELD = {
    goal:       {ph:'说一个名字，例如「专升本」「考研」', btn:'就说这个', field:'goal'},
    date:       {ph:'哪天考？例如 2027-03-15', btn:'就这天', field:'date'},
    minutes:    {ph:'每天能学多久？例如 120（分钟）', btn:'就这么多', field:'minutes'},
    confirm_goal:{ph:'', btn:'', field:null},
    pick:       {ph:'', btn:'', field:null}
  };
  function gPaintAsk(s){
    var box=gEl('gAsk'); if(!box) return;
    if(!s || !s.need || s.need==='pick' || s.status==='choosing' || s.status==='done'){
      box.hidden=true; box.innerHTML=''; return;
    }
    var f=ASKFIELD[s.need] || null;
    box.hidden=false;
    var input = (f && f.field)
      ? '<div class="arow"><input id="gAskIn" autocomplete="off" placeholder="'+esc(f.ph)+'">'+
        '<button class="btn act" id="gAskGo">'+esc(f.btn)+'</button></div>'
      : '<div class="arow"><button class="btn act" id="gAskYes">去找</button>'+
        '<button class="btn" id="gAskNo">先不动</button></div>';
    box.innerHTML = '<p class="aw">'+esc(s.say||'')+'</p>'+input;
    var inp=gEl('gAskIn');
    if(inp){
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); gReply(f.field, inp.value); } });
      setTimeout(function(){ try{ inp.focus(); }catch(e){} }, 30);
    }
    var go=gEl('gAskGo'); if(go) go.addEventListener('click', function(){ gReply(f.field, (gEl('gAskIn')||{}).value); });
    var yes=gEl('gAskYes'); if(yes) yes.addEventListener('click', function(){ gReply('goal', (s.parsed||{}).goal || '考研'); });
    var no=gEl('gAskNo'); if(no) no.addEventListener('click', function(){ gSay('那就不动了。这台机器上没有的东西，我不会拿别的东西凑给你。'); box.hidden=true; });
  }

  /* ---- 候选 ---- */
  function gPaintCand(s){
    var box=gEl('gCand'); if(!box) return;
    var cs=(s && s.candidates) || [];
    /* 还在问话的时候不许把候选摊出来 —— 人还没说完，先给他一堆课表挑，
       等于把「先问清楚」这件事跳过去了。问完（choosing）再摆。 */
    if(!cs.length || s.status==='done' || s.status==='waiting' || s.applied){
      box.hidden=true; box.innerHTML=''; return;
    }
    box.hidden=false;
    box.innerHTML =
      '<div class="chd"><h4>我找到这些，你挑要学的</h4>'+
      '<span>都过了交叉核对：分集数、总时长两项都对得上。一条都不勾也行。</span></div>'+
      cs.map(function(c){
        var on = GATE.picked[c.bvid] ? '1' : '0';
        var parts=(c.first_parts||[]).slice(0,4).map(function(p){ return '<span>'+esc(p||'（无标题）')+'</span>'; }).join('');
        return '<div class="gco" data-bv="'+esc(c.bvid)+'" data-on="'+on+'">'+
          '<span class="ck"><svg class="ic"><use href="#i-check"/></svg></span>'+
          '<div class="bd"><b>'+esc(c.title||c.bvid)+'</b>'+
            '<div class="mt"><span>'+esc(c.up||'未知UP')+'</span><span>'+c.pages+' P</span>'+
            '<span>'+c.hours+' 小时</span><span>'+esc(c.bvid)+'</span>'+
            (c.play? '<span>'+Math.round(c.play/10000)+' 万播放</span>' : '')+
            '<i>两项已核对</i></div>'+
            (parts? '<div class="pp">'+parts+'</div>' : '')+
          '</div></div>';
      }).join('')+
      '<div class="acts" style="display:flex;gap:9px;flex-wrap:wrap;margin-top:14px">'+
        '<button class="btn act" id="gPickGo">排给我看</button>'+
        '<button class="btn" id="gPickNone">这些都不要</button></div>';
    [].forEach.call(box.querySelectorAll('.gco'), function(el){
      el.addEventListener('click', function(){
        var bv=el.getAttribute('data-bv');
        var on = el.getAttribute('data-on')==='1';
        el.setAttribute('data-on', on? '0':'1');
        GATE.picked[bv] = !on;
      });
    });
    var pg=gEl('gPickGo'); if(pg) pg.addEventListener('click', gPick);
    var pn=gEl('gPickNone'); if(pn) pn.addEventListener('click', function(){ GATE.picked={}; gPick(); });
  }

  /* ---- 计划 ---- */
  function gPaintPlan(s){
    var box=gEl('gPlan'); if(!box) return;
    if(!s || !s.plan || !s.applied){ box.hidden = !(s && s.plan); if(!s||!s.plan){ box.innerHTML=''; return; } }
    var p=s.plan;
    box.hidden=false;
    var wk=(p.week||[]).slice(0,7).map(function(d,i){
      var bl=(d.blocks||[]).map(function(b){
        return '<span class="pb">'+esc(String(b.course||''))+
          (b.page? ' · P'+b.page : '')+
          (b.part? ' '+esc(b.part) : '')+
          ' <em>'+b.minutes+'′</em></span>';
      }).join('');
      var empty = !bl && (d.minutes||0)>0;
      return '<div class="pwd" data-t="'+(d.is_today?'1':'0')+'">'+
        '<span class="pd">'+esc(d.date.slice(5))+' · '+esc('一二三四五六日'[d.wd])+
        (d.is_today? '<i>今天</i>' : '')+'</span>'+
        '<div class="pbs">'+(bl || '<span class="pb ne">'+
          (empty? '还没挑课 —— 挑完这里就会填上' : '没有排')+'</span>')+'</div>'+
        '<em class="pt">'+(d.filled||0)+' / '+(d.minutes||0)+' 分钟</em>'+
      '</div>';
    }).join('');
    box.innerHTML =
      '<div class="pcard">'+
        '<div class="pk">'+
          '<div><span>考试日期</span><b style="font-size:15px">'+esc(p.exam_date)+'</b></div>'+
          '<div><span>还有</span><b>'+p.days_left+'<small>天</small></b></div>'+
          '<div><span>可支配</span><b>'+Math.round(p.budget_hours)+'<small>小时</small></b></div>'+
          '<div><span>本机现有</span><b>'+(p.local_hours||0)+'<small>小时</small></b></div>'+
        '</div>'+
        '<p class="ps" style="color:var(--dim);font-size:12.5px;line-height:1.7;margin:0">'+
          (p.local_hours
            ? ('按这个预算，本机现有的课能吃到 <b style="color:var(--tx)">'+Math.round((p.coverage_local||0)*100)+'%</b>；吃不完的部分到时候会列出来，不会假装排得下。')
            : '本机没有课 —— 计划先按你挑的那几门算，排进课表后可以随时改。')+
        '</p>'+
        '<div class="pw">'+wk+'</div>'+
        '<div class="acts">'+
          (s.applied
            ? '<button class="btn act" id="gToSched">去课表看排到哪</button><button class="btn" id="gAgain">重来一次</button>'
            : '<button class="btn act" id="gApply">就这么排</button><button class="btn" id="gBackPick">回去改选</button>')+
        '</div>'+
      '</div>';
    var a=gEl('gApply');
    if(a){
      if(GATE.armed){ a.textContent='确认写进去'; a.className='btn act'; }
      a.addEventListener('click', function(){ gApply(!!GATE.armed); });
    }
    var t=gEl('gToSched'); if(t) t.addEventListener('click', function(){ gClose(); go('schedule'); });
    var b=gEl('gBackPick'); if(b) b.addEventListener('click', function(){ gPaintCand(GATE.state); });
    var g2=gEl('gAgain'); if(g2) g2.addEventListener('click', function(){ gReset(); });
  }

  function gPaint(s){
    if(!s) return;
    GATE.state=s;
    gPaintPipe(s);
    gPaintAsk(s);
    gPaintCand(s);
    gPaintPlan(s);
    var k=gEl('gKick');
    if(k){
      var done=(s.stages||[]).filter(function(x){ return x.status==='done'||x.status==='skip'; }).length;
      k.textContent = s.applied ? '已认下' : (s.status==='choosing' ? '等你挑' :
        (s.status==='waiting' ? '等你补一句' : '跑到第 '+(s.stage+1)+' 站'));
      if(done && !s.applied) k.textContent += ' · ' + done + '/5 站跑过';
    }
  }

  /* ---- 动作 ---- */
  function gBusy(on){
    GATE.busy=!!on;
    var b=gEl('gBox'); if(b) b.setAttribute('data-busy', on? '1':'0');
    var btn=gEl('gSend'); if(btn) btn.disabled=!!on;
  }

  function gStart(text){
    if(!text || !text.replace(/\s/g,'')) { gSay('写一句再发 —— 空着发出去，它就什么都不知道。'); return; }
    gBusy(true); gSay('');
    callTool('intake_start', {text:text, files:GATE.files.map(function(f){ return f.name; })}, {onDone:function(res){
      gBusy(false);
      if(!res.ok){ gSay('没跑起来：'+esc(res.error||'后端没回话')); return; }
      var s=(res.data||{}).state;
      gPaint(s);
      /* 只要还有站没跑完就接着跑 —— 不能只在 need==='pick' 时才跑，
         那样第一次发完就会停在第三站，人对着一个不动的进度条等。 */
      if(s && s.stage < 5) gRun();
    }});
  }

  function gReply(field, value){
    if(field && (value===undefined || String(value).trim()==='')){
      gSay('这一栏还空着 —— 我不替你填一个。'); return;
    }
    gBusy(true);
    callTool('intake_reply', {field:field, value:(field? String(value).trim() : null)}, {onDone:function(res){
      gBusy(false);
      if(!res.ok){ gSay('没接上：'+esc(res.error||'')); return; }
      var s=(res.data||{}).state;
      gPaint(s);
      if(s && s.stage < 5) gRun();
    }});
  }

  /* 一站一站往前跑；核候选那一段一次只核一条，所以会连着调几次 —— 进度是真进度。 */
  function gRun(){
    if(GATE.busy) return;
    gBusy(true);
    function once(){
      callTool('intake_step', {}, {onDone:function(res){
        if(!res.ok){ gBusy(false); gSay('这一站没跑成：'+esc(res.error||'')); return; }
        var s=(res.data||{}).state;
        gPaint(s);
        var more = s && s.stage < 5;
        if(more){ setTimeout(once, 90); return; }
        gBusy(false);
        if(s && s.need==='pick') gPaintAsk(s);
      }});
    }
    once();
  }

  function gPick(){
    var bvids=Object.keys(GATE.picked).filter(function(k){ return GATE.picked[k]; });
    gBusy(true);
    callTool('intake_pick', {bvids:bvids}, {onDone:function(res){
      gBusy(false);
      if(!res.ok){ gSay('没记下你挑的：'+esc(res.error||'')); return; }
      var s=(res.data||{}).state;
      gPaint(s);
      if(s && s.stage < 5) gRun();
    }});
  }

  /* 写盘要两次点击 —— 这是全站老规矩。第一次只拿到 need_confirm（后端把闸门拦下来），
     第二次带 confirm:true 才真写。注意 need_confirm 在响应体顶层，不在 data 里。 */
  function gApply(confirmNow){
    gBusy(true);
    callTool('intake_apply', {}, {confirm:!!confirmNow, write:true, onDone:function(res){
      gBusy(false);
      /* 闸门拦下来时后端回的是 ok:false + need_confirm:true —— 不能写成 res.ok &&
         need_confirm，那样这一支永远进不去，用户只看到一句「没写进去」。 */
      if(res.need_confirm){
        GATE.armed=true;
        gSay('这一步会改你的考试日期和每天时长。确认的话再点一次「确认写进去」。');
        var a=gEl('gApply');
        if(a){ a.textContent='确认写进去'; a.className='btn act'; }
        return;
      }
      if(!res.ok){ gSay('没写进去：'+esc(res.error||'')); return; }
      GATE.armed=false;
      var s=(res.data||{}).state; gPaint(s);
      gSay('认下了。计划在课表页，随时可以回来改。');
      refreshAfterPlan();
    }});
  }

  function gReset(){
    callTool('intake_reset', {}, {onDone:function(){
      GATE.state=null; GATE.files=[]; GATE.picked={};
      ['gPipe','gAsk','gCand','gPlan'].forEach(function(id){ var e=gEl(id); if(e){ e.hidden=true; e.innerHTML=''; } });
      var t=gEl('gIn'); if(t){ t.value=''; t.focus(); }
      gPaintFiles(); gSay('');
    }});
  }

  /* ---- 附件：只收名字，并且当场说清楚只读了名字 ---- */
  function gPaintFiles(){
    var box=gEl('gFiles'); if(!box) return;
    if(!GATE.files.length){ box.hidden=true; box.innerHTML=''; return; }
    box.hidden=false;
    box.innerHTML = GATE.files.map(function(f,i){
      return '<span class="gf"><b>'+esc(f.name)+'</b><button data-fi="'+i+'" aria-label="移除">×</button></span>';
    }).join('');
    [].forEach.call(box.querySelectorAll('button[data-fi]'), function(b){
      b.addEventListener('click', function(){
        GATE.files.splice(parseInt(b.getAttribute('data-fi'),10),1);
        gPaintFiles();
      });
    });
  }
  function gAddFiles(list){
    for(var i=0;i<list.length;i++){
      var f=list[i];
      if(GATE.files.length>=8){ gSay('最多挂 8 个 —— 再多我也读不过来（本机没接视觉模型，只读文件名）。'); break; }
      GATE.files.push({name:(f.name||('图片 '+(GATE.files.length+1))), size:f.size||0});
    }
    gPaintFiles();
    if(GATE.files.length) gSay('收到 '+GATE.files.length+' 个附件。<b>只读了文件名</b> —— 本机没接视觉模型，图里的字读不出来；要它知道，就在上面用一句话说一遍。');
  }

  function bindMode(){
    var a=gEl('modeAi'), c=gEl('modeCards');
    if(a) a.addEventListener('click', function(){ setMode('ai'); });
    if(c) c.addEventListener('click', function(){ setMode('cards'); });
  }

  function bindGate(){
    bindMode();
    var g=gEl('aiGate'); if(!g) return;
    var t=gEl('gIn');
    if(t){
      t.addEventListener('input', function(){ t.style.height='auto'; t.style.height=Math.min(180, t.scrollHeight)+'px'; });
      t.addEventListener('keydown', function(e){
        if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); gStart(t.value.trim()); }
      });
      t.addEventListener('paste', function(e){
        var it=(e.clipboardData||{}).items||[];
        var imgs=[];
        for(var i=0;i<it.length;i++){ if(it[i].kind==='file'){ var f=it[i].getAsFile(); if(f) imgs.push(f); } }
        if(imgs.length){ e.preventDefault(); gAddFiles(imgs); }
      });
    }
    var send=gEl('gSend'); if(send) send.addEventListener('click', function(){ gStart(((gEl('gIn')||{}).value||'').trim()); });
    var pic=gEl('gPic'); if(pic) pic.addEventListener('click', function(){ var p=gEl('gFilePick'); if(p) p.click(); });
    var doc=gEl('gDoc'); if(doc) doc.addEventListener('click', function(){ var p=gEl('gDocPick'); if(p) p.click(); });
    var fp=gEl('gFilePick'); if(fp) fp.addEventListener('change', function(){ gAddFiles(fp.files||[]); fp.value=''; });
    var dp=gEl('gDocPick'); if(dp) dp.addEventListener('change', function(){ gAddFiles(dp.files||[]); dp.value=''; });
    var tryb=gEl('gTry');
    if(tryb) tryb.addEventListener('click', function(e){
      var b=e.target.closest? e.target.closest('button[data-say]') : null;
      if(!b) return;
      var v=b.getAttribute('data-say');
      if(t){ t.value=v; }
      gStart(v);
    });
    /* 「进工作台」按钮已去掉：模式条上就有「卡片主导」，两个入口做同一件事只会让人犹豫。 */
    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && !g.hidden){ gClose(); }
    });
  }

  /* 首屏：有没走完的接手就接着走；没有就从空白开始。
     空白实例和内容实例都先看这一层 —— AI 领头，人可以随时点右上角进工作台。 */
  function gateBoot(){
    bindGate();
    var last='ai';
    try{ last = sessionStorage.getItem(MODEKEY) || 'ai'; }catch(e){}
    callTool('intake_state', {}, {log:false, onDone:function(res){
      var s=res.ok ? (res.data||{}).state : null;
      if(s && !s.applied){
        setMode('ai', true); gPaint(s);
        if(s.stage < 5 || s.status==='choosing') gRun();
        return;
      }
      /* 没有正在走的接手：记住上次用的是哪个模式，默认 AI。
         这里不设 sd.gate.skip —— 切模式不是「关掉它」，下次进门还该是上次那个模式。 */
      setMode(last, true);
      if(last==='ai'){ gPaintPipe(s); gPaintAsk(s); gateIntro(); }
    }});
  }


  /* 版本号：后端 /api/build 返回三个静态文件的最新 mtime。
     刷新后这串数字不变 = 你看到的是缓存里的旧页面，Ctrl+F5 再来一次。 */
  function paintBuildTag(){
    var el=$('#buildTag'); if(!el) return;
    fetch('/api/build', {cache:'no-store'})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ el.textContent = d && d.build ? ('build ' + d.build) : 'build —'; })
      .catch(function(){ el.textContent = 'build —'; });
  }

  /* ---------- 对外桥：canvas.js 要用同一套 callTool 和同一个「当前讲次」 ---------- */
  window.SD = {
    callTool: callTool,
    esc: esc,
    go: go,
    noteEvent: noteEvent,
    currentLesson: function(){
      return (typeof CLS_S !== 'undefined' && CLS_S.lesson && CLS_S.lesson.id) || null;
    },
    currentLessonTitle: function(){
      if(typeof CLS_S === 'undefined' || !CLS_S.lesson) return '';
      return CLS_S.lesson.title || CLS_S.lesson.name || '';
    },
    subject: function(){ return SEL.subject; }
  };

  /* 初始化 */
  paintBuildTag(); paintBrand();
  if(typeof loadXm==='function') loadXm();
  paintHeroKick(); paintKpi(); paintHero(); paintStreak(); paintSubjProg(); paintWeekDone();
  paintClock();
  bindSearch(); bindCourseCats(); bindClassroomExtras(); bindPracAi(); bindAsk(); bindAi(); bindImporter();
  gateBoot();
  callTool('analyze_errors', {}, {log:false, onDone:function(r){ if(r.ok) paintErrors(r.data); }});
  var hp=(location.hash||'').replace(/^#/,'').split('|');
  go(PAGES[hp[0]] ? hp[0] : 'today');
  if(hp[1] && typeof setMode==='function') setMode(hp[1]);

})();
