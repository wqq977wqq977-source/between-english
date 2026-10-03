const $ = (q, parent = document) => parent.querySelector(q);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  sidebarClose:'<path d="M4 5v14m11-12-5 5 5 5"/>',
  sidebarOpen:'<path d="M4 5v14m6-12 5 5-5 5"/>',
  words:'<path d="M4 5h9M8.5 3v2M5 9c1 4 4 7 8 9M12 5c0 6-3 11-8 14M14 20l4-11 4 11M15.5 16h5"/>',
  book:'<path d="M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1zm0 0v15"/>',
  activity:'<path d="M4 20V4M4 20h17M8 16v-4M13 16V8M18 16V4"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 4 3-4 3 1 2-3-1-3 2-2-2-3-3-1-1-3z"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>'
}[name] || ''}</svg>`;
function draft(key, fallback) { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; } }
const S = { token: '', words: [], decks: [], articles: [], settings: {}, connection: {}, jobs: [], memory: null, memoryDraft: null, modelCatalog: {models:[],fetchedAt:null}, modelsLoading: false, modelsError: '', settingsDraft: null, settingsSaving: false, nav: 'curate', wordTab: 'find', readTab: 'find', deckId: '', article: null, selection: '', selectionContext: '', assistantTab: 'chat', revealed: false, cardMode: 'meaning', spell: '', compose: '', language: '中文', quizAnswers: {}, articleIds: null, error: '',
  curationDraft: draft('between.curationDraft', {prompt:'',target:'auto',defaultWordCount:10,defaultArticleCount:2,defaultLevel:''}), curationSubmitting:false, curationDefaultsOpen:false, directionsRefreshing:false, directions:{personalized:false,items:[],note:''}, selections:[],
  wordFilters: draft('between.wordFilters', { count: 20, level: 'B2', topic: '日常生活', range: '主题词汇', excludeKnown: true, extra: '' }),
  articleFilters: draft('between.articleFilters', { count: 3, level: 'B2', topic: '科技与生活', minWords: 300, maxWords: 1000, type: '不限', domain: '', since: '', extra: '' }),
  quizCount: 3, quizType: '混合'
};
S.activityFilter='all';S.activityDate='';S.activityWeek='';
S.activityMode=draft('between.activityView',{mode:'daily'}).mode==='weekly'?'weekly':'daily';
S.sidebarCollapsed=draft('between.layout',{sidebarCollapsed:false}).sidebarCollapsed===true;
const levels = ['A1','A2','B1','B2','C1','C2'];
const freshWordBrowse = () => ({ query:'', status:'all', size:10, page:1, deckId:'' });
Object.assign(S, { wordBrowse:{ find:freshWordBrowse(), saved:freshWordBrowse() }, wordSearchOpen:null, deckLibrary:{ query:'', page:1 } });
Object.assign(S, {apiDraft:null,apiCatalog:{models:[],fetchedAt:null},apiAction:'',apiError:'',apiMessage:'',apiConfigOpen:false});
const settingsBusy = () => S.settingsSaving || S.modelsLoading || Boolean(S.apiAction);
const apiEndpoint = value => String(value || '').trim().replace(/\/+$/, '');
const hasSavedApiKey = () => Boolean(S.settings.api?.hasKey && !S.apiDraft?.clearKey && apiEndpoint(S.apiDraft?.baseUrl) === apiEndpoint(S.settings.api?.baseUrl));
function apiDraftPayload() { const d=S.apiDraft;return {baseUrl:d.baseUrl.trim(),model:d.model.trim(),apiKey:d.apiKey,clearKey:d.clearKey,reasoningEffort:d.reasoningEffort,fastMode:d.fastMode}; }
const options = (values, selected) => values.map(v => `<option value="${esc(v)}" ${String(selected) === String(v) ? 'selected' : ''}>${esc(v)}</option>`).join('');
const wordById = id => S.words.find(w => w.id === id);
const deck = () => S.decks.find(d => d.id === S.deckId) || S.decks[0];
const due = () => S.words.filter(w => w.review && new Date(w.review.dueAt).getTime() <= Date.now());
const saved = () => S.words.filter(w => w.saved);
const activeJobs = () => S.jobs.filter(j => ['queued','running'].includes(j.status));
const busy = type => activeJobs().some(j => j.type === type);
const date = value => value ? new Date(value).toLocaleDateString('zh-CN', { month:'short', day:'numeric' }) : '';
const source = (url, title) => url ? `<a class="source" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title || url)}">${esc(title || new URL(url).hostname)} ↗</a>` : '<span class="muted">手动导入</span>';
let toastTimer;
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 5500); }
async function api(path, body) {
  const response = await fetch(`/api${path}`, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json','X-Study-Token':S.token}, body:JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求没有完成，请重试。'); return value;
}
let stateRequest=0;
async function refresh() { const request=++stateRequest,value=await api('/state');if(request===stateRequest)Object.assign(S,value); }
function empty(title, text, action = '', symbol = 'Aa') { return `<div class="empty"><div class="empty-symbol" aria-hidden="true">${symbol}</div><h3>${title}</h3><p>${text}</p>${action}</div>`; }
function jobsMarkup() { return activeJobs().map(j => `<div class="job-banner"><span class="spinner" aria-hidden="true"></span><div class="job-text">${esc(j.progress)}<div class="job-label">${({curate:'选材中心',directions:'推荐方向',words:'词汇检索',articles:'文章检索',explain:'阅读讲解',quiz:'生成理解题',grade:'批改回答',word:'收藏生词',open:'读取原文',connection:'连接测试'})[j.type]}</div></div><button class="ghost small" data-action="cancel-job" data-id="${j.id}">取消</button></div>`).join(''); }
function sidebarToggleMarkup() {
  const label=S.sidebarCollapsed?'展开侧边栏':'收起侧边栏';
  return `<button type="button" id="sidebar-toggle" class="sidebar-toggle" data-action="toggle-sidebar" aria-label="${label}" title="${label}" aria-expanded="${!S.sidebarCollapsed}" aria-controls="sidebar">${icon(S.sidebarCollapsed?'sidebarOpen':'sidebarClose')}</button>`;
}
function toggleSidebar() {
  S.sidebarCollapsed=!S.sidebarCollapsed;
  try { localStorage.setItem('between.layout',JSON.stringify({sidebarCollapsed:S.sidebarCollapsed})); } catch { /* The layout still works when browser storage is unavailable. */ }
  $('.shell').classList.toggle('sidebar-collapsed',S.sidebarCollapsed);
  const button=$('#sidebar-toggle'),label=S.sidebarCollapsed?'展开侧边栏':'收起侧边栏';
  button.setAttribute('aria-label',label);button.setAttribute('title',label);button.setAttribute('aria-expanded',String(!S.sidebarCollapsed));
  button.innerHTML=icon(S.sidebarCollapsed?'sidebarOpen':'sidebarClose');
}
function shell(content) {
  const reading = S.nav === 'reading' && S.article;
  return `<div class="shell ${S.sidebarCollapsed?'sidebar-collapsed':''}"><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-icon">b.</span><div class="brand-text"><div class="brand-name">句。间</div><div class="brand-en">Between</div></div></div>${sidebarToggleMarkup()}<div class="nav-label">学习空间</div><nav class="nav" aria-label="主导航">${[['curate','spark','选材中心'],['words','words','单词学习'],['reading','book','英文阅读'],['learning','activity','我的学习'],['settings','settings','设置']].map(([id,ic,label]) => `<button data-nav="${id}" class="${S.nav === id ? 'active' : ''}" title="${label}" aria-label="${label}" ${S.nav === id ? 'aria-current="page"' : ''}>${icon(ic)}<span class="nav-label-text">${label}</span><span class="nav-tooltip" aria-hidden="true">${label}</span>${id === 'learning' && due().length ? `<span class="count">${due().length}</span>`:''}</button>`).join('')}</nav><div class="sidebar-footer"><div class="connection-pill"><span class="status-dot ${S.connection.authenticated ? '' : 'off'}"></span><span>${S.connection.authenticated ? S.settings.tutorProvider==='api'?'Codex 检索 · API 助手':'Codex 已连接' : '等待连接 Codex'}</span></div><div class="small-note">一点积累，自成语感。</div></div></aside><main class="workspace ${reading ? 'reading-workspace' : ''}" id="main"><div class="topbar"><span>我的学习空间 <span aria-hidden="true">/</span> <strong>${({curate:'选材中心',words:'单词学习',reading:'英文阅读',learning:'我的学习',settings:'偏好设置'})[S.nav]}</strong></span><span class="date">${new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})}</span></div><div id="jobs">${jobsMarkup()}</div>${S.error ? `<div class="hint-strip error-strip" role="alert">${esc(S.error)} <button class="ghost small" data-action="dismiss-error">关闭</button></div>` : ''}${content}</main></div>`;
}
function render() {
  const readerScroll = $('.reader')?.scrollTop || 0, chatScroll = $('.assistant-body')?.scrollTop || 0, activityScroll=$('.activity-scroll')?.scrollLeft;
  const focus = document.activeElement?.id, cursor = document.activeElement?.selectionStart;
  $('#app').innerHTML = shell(({curate:curationPage,words:wordsPage,reading:readingPage,learning:learningPage,settings:settingsPage})[S.nav]());
  if ($('.reader')) $('.reader').scrollTop = readerScroll;
  if ($('.activity-scroll')) $('.activity-scroll').scrollLeft=activityScroll??$('.activity-scroll').scrollWidth;
  if ($('.assistant-body')) $('.assistant-body').scrollTop = chatScroll;
  if (focus && document.getElementById(focus)) { const el = document.getElementById(focus); el.focus({preventScroll:true}); if (cursor != null && el.setSelectionRange) el.setSelectionRange(cursor, cursor); }
  observeReading();
  if($('#deck-dialog')?.open)renderDeckLibrary();
}
function filterSelect(label, key, values, f, group) { return `<label>${label}<select data-filter="${group}" name="${key}">${options(values,f[key])}</select></label>`; }
function filterInput(label, key, f, group, attrs = '') { return `<label>${label}<input data-filter="${group}" name="${key}" value="${esc(f[key])}" ${attrs}></label>`; }
function persistCurationDraft() { try { localStorage.setItem('between.curationDraft',JSON.stringify(S.curationDraft)); } catch { /* A private browser can still use this page without saved drafts. */ } }
function curationTargets(selected) { return [['auto','自动'],['both','单词与文章'],['words','只选单词'],['articles','只选文章']].map(([value,label])=>`<option value="${value}" ${value===selected?'selected':''}>${label}</option>`).join(''); }
function selectionDestination(selection,kind) {
  const part=selection[kind];if(!part?.requested)return '';
  const words=kind==='words',ready=part.status==='ready'&&part.count>0;
  return `<div class="selection-destination"><div class="selection-kind">${icon(words?'words':'book')}<span>${words?'单词学习':'英文阅读'}</span></div><div class="selection-count">${ready?`${esc(part.count)}<span>${words?'个单词':'篇文章'}</span>`:'<span>暂无匹配</span>'}</div>${part.note?(ready?`<details class="result-note"><summary>备注</summary><p>${esc(part.note)}</p></details>`:`<p class="muted">${esc(part.note)}</p>`):''}${ready?`<button type="button" class="${words?'primary':'light'} small" data-action="selection-${kind}" data-id="${esc(selection.id)}">${words?'前往单词学习':'前往英文阅读'} <span aria-hidden="true">↗</span></button>`:''}</div>`;
}
function selectionMarkupCard(selection) {
  return `<article class="selection-card"><div class="row spread wrap"><h3>${esc(selection.title||'这次的学习材料')}</h3><span class="muted">${date(selection.createdAt)}</span></div><p class="selection-prompt">${esc(selection.prompt)}</p><div class="selection-destinations">${selectionDestination(selection,'words')}${selectionDestination(selection,'articles')}</div>${selection.note?`<details class="result-note"><summary>选材备注</summary><p>${esc(selection.note)}</p></details>`:''}</article>`;
}
function curationPage() {
  const d=S.curationDraft,working=S.curationSubmitting||busy('curate'),recommending=S.directionsRefreshing||busy('directions'),directions=S.directions||{items:[]},selections=S.selections||[];
  return `<header class="page-head"><div><h1>选材中心</h1></div><span class="head-mark">Follow your curiosity.</span></header>
    <form id="curation-form" class="panel curation-panel"><label class="curation-label" for="curation-prompt">今天想学什么？</label><textarea id="curation-prompt" data-curation="prompt" rows="3" maxlength="2000" required placeholder="想读太空探索相关的 B1 文章，选 10 个常用词和 2 篇短文。">${esc(d.prompt)}</textarea>
    <div class="curation-toolbar"><label class="curation-target" for="curation-target"><span>选材范围</span><select id="curation-target" data-curation="target">${curationTargets(d.target)}</select></label><button class="primary" type="submit" ${working?'disabled':''}>${working?'Codex 正在筛选…':'交给 Codex 筛选'} ${working?'':icon('spark')}</button></div>
    <details id="curation-defaults" class="curation-defaults" ${S.curationDefaultsOpen?'open':''}><summary>默认条件 <span>未注明时采用</span></summary><div class="curation-default-grid"><label for="curation-word-count">单词数量<input id="curation-word-count" data-curation="defaultWordCount" type="number" min="1" max="100" required value="${esc(d.defaultWordCount)}"></label><label for="curation-article-count">文章数量<input id="curation-article-count" data-curation="defaultArticleCount" type="number" min="1" max="10" required value="${esc(d.defaultArticleCount)}"></label><label for="curation-level">参考难度<select id="curation-level" data-curation="defaultLevel">${options(levels,d.defaultLevel||'B2')}</select></label></div></details></form>
    <section aria-labelledby="directions-title"><div class="section-head"><h2 id="directions-title">${directions.personalized?'为你推荐':'起步方向'}</h2><div class="row wrap"><span class="badge neutral">GPT-6-Luna · Fast</span><button type="button" class="ghost small" data-action="refresh-directions" ${recommending?'disabled':''}>${recommending?'推荐中…':'重新推荐'}</button></div></div>${directions.items?.length?`<div class="direction-grid">${directions.items.map((item,i)=>`<article class="direction-card"><span class="direction-number" aria-hidden="true">${String(i+1).padStart(2,'0')}</span><h3>${esc(item.title)}</h3><p>${esc(item.reason)}</p><button type="button" class="ghost small" data-action="use-direction" data-id="${esc(item.id)}">用这个方向 <span aria-hidden="true">↗</span></button></article>`).join('')}</div>`:'<p class="muted">还没有推荐方向。</p>'}${directions.note?`<p class="direction-note">${esc(directions.note)} <button type="button" class="ghost small" data-nav="settings">学习偏好 ↗</button></p>`:''}</section>
    ${selections.length?`<section aria-labelledby="selections-title"><div class="section-head"><h2 id="selections-title">最近选材</h2><span class="muted">${selections.length} 次记录</span></div>${selectionMarkupCard(selections[0])}${selections.length>1?`<details class="selection-history"><summary>此前选材 · ${selections.length-1} 次</summary><div class="selection-history-list">${selections.slice(1).map(selectionMarkupCard).join('')}</div></details>`:''}</section>`:''}`;
}
function wordFilters() {
  const f = S.wordFilters;
  return `<form id="word-search" class="panel"><div class="panel-head"><h2>筛选单词</h2></div><div class="filter-grid">${filterInput('主题','topic',f,'word','maxlength="150" placeholder="例如：商务会议、旅行、AI" required')}${filterSelect('参考难度','level',levels,f,'word')}${filterInput('单词数量','count',f,'word','type="number" min="1" max="100" required')}${filterSelect('词汇范围','range',['主题词汇','四级词汇','六级词汇','雅思词汇','托福词汇','商务英语'],f,'word')}</div><details class="advanced" ${f.extra ? 'open' : ''}><summary>补充要求</summary><label class="advanced"><span class="sr-only">补充选词要求</span><input data-filter="word" name="extra" value="${esc(f.extra)}" placeholder="例如：多选常见动词，避开过于专业的术语" maxlength="500"></label></details><div class="filter-bottom"><label class="check"><input type="checkbox" data-filter="word" name="excludeKnown" ${f.excludeKnown ? 'checked' : ''}>排除已掌握</label><button type="submit" class="primary" ${busy('words') ? 'disabled' : ''}>${busy('words') ? '正在检索…' : '检索单词'}</button></div></form>`;
}
function wordTable(words, editable = false) {
  return `<div class="table-wrap"><table class="word-table"><thead><tr><th>单词</th><th>释义</th><th>状态</th><th class="source-col">来源</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${words.map(w=>`<tr><td><div class="english">${esc(w.word)}</div><div class="phonetic">${esc(w.phonetic)} ${esc(w.partOfSpeech)}</div></td><td>${esc(w.meaning)}${w.articleTitle ? `<div class="phonetic">摘自 ${esc(w.articleTitle)}</div>`:''}</td><td><span class="badge ${w.review?.rating === 'known' ? '' : 'neutral'}">${w.review ? ({known:'已掌握',fuzzy:'需巩固',unknown:'不认识'})[w.review.rating] : esc(w.level || '新词')}</span></td><td class="source-col">${source(w.sourceUrl,w.sourceTitle)}</td><td><div class="actions"><button class="ghost small" data-action="save-word" data-id="${esc(w.id)}" title="${w.saved?'移出生词本':'加入生词本'}">${w.saved?'已收藏':'收藏'}</button>${editable ? `<button class="ghost small" data-action="replace-word" data-id="${esc(w.id)}" ${busy('words')?'disabled':''}>替换</button><button class="ghost small danger" data-action="remove-word" data-id="${esc(w.id)}" ${deck()?.wordIds.length<=1?'disabled title="词表至少保留一个单词"':''}>移除</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`;
}
const wordSearchKey = value => String(value || '').normalize('NFKC').trim().toLowerCase();
function wordBrowse(scope) {
  const view=S.wordBrowse[scope];
  if(scope==='find'&&view.deckId!==deck()?.id)Object.assign(view,freshWordBrowse(),{size:view.size,deckId:deck()?.id||''});
  return view;
}
function resetWordBrowse(){Object.assign(S.wordBrowse.find,freshWordBrowse(),{size:S.wordBrowse.find.size,deckId:deck()?.id||''});}
function listPagination({page,size,total,prefix,label}) {
  const pages=Math.max(1,Math.ceil(total/size)),start=total?(page-1)*size+1:0,end=Math.min(page*size,total);
  return `<nav class="list-pagination" aria-label="${label}"><span>${start}–${end} / ${total}</span>${pages>1?`<div class="row"><button type="button" id="${prefix}-page-prev" class="ghost small" data-action="${prefix}-page-prev" ${page<=1?'disabled':''} aria-label="${label}上一页">上一页</button><span class="page-number">${page} / ${pages}</span><button type="button" id="${prefix}-page-next" class="ghost small" data-action="${prefix}-page-next" ${page>=pages?'disabled':''} aria-label="${label}下一页">下一页</button></div>`:''}</nav>`;
}
function wordBrowser(words,scope,editable=false) {
  const view=wordBrowse(scope),query=wordSearchKey(view.query);
  const matches=words.filter(w=>(!query||wordSearchKey(`${w.word} ${w.meaning}`).includes(query))&&(view.status==='all'||(view.status==='new'?!w.review:w.review?.rating===view.status)));
  view.page=Math.max(1,Math.min(view.page,Math.ceil(matches.length/view.size)||1));
  const visible=matches.slice((view.page-1)*view.size,view.page*view.size);
  return `<section class="word-browser" id="word-browser" aria-label="${scope==='saved'?'浏览生词本':'浏览本词表'}"><div class="word-browser-tools"><label><span class="sr-only">${scope==='saved'?'搜索生词本':'搜索本词表'}</span><input id="word-list-query" type="search" value="${esc(view.query)}" placeholder="${scope==='saved'?'搜索生词本':'搜索本词表'} · 单词或释义" maxlength="100" autocomplete="off"></label><label><span class="sr-only">掌握状态</span><select id="word-list-status">${[['all','全部状态'],['new','未学习'],['fuzzy','需巩固'],['unknown','不认识'],['known','已掌握']].map(([value,label])=>`<option value="${value}" ${view.status===value?'selected':''}>${label}</option>`).join('')}</select></label><label><span class="sr-only">每页数量</span><select id="word-list-page-size">${[10,20,50].map(size=>`<option value="${size}" ${view.size===size?'selected':''}>${size} / 页</option>`).join('')}</select></label></div><div class="word-browser-meta" role="status">${query||view.status!=='all'?`匹配 ${matches.length} / ${words.length} 个词`:`共 ${words.length} 个词`}</div>${visible.length?wordTable(visible,editable):`<div class="word-empty"><p>没有匹配的单词</p><button type="button" class="ghost small" data-action="clear-word-query">清除筛选</button></div>`}${listPagination({page:view.page,size:view.size,total:matches.length,prefix:'word',label:'单词列表'})}</section>`;
}
function deckPicker() { return S.decks.length ? `<button type="button" class="deck-picker" id="deck-picker" data-action="open-deck-library" aria-haspopup="dialog" aria-controls="deck-dialog" title="当前词表：${esc(deck()?.title)}">切换词表 · ${S.decks.length}</button>`:''; }
function renderDeckLibrary() {
  const query=wordSearchKey(S.deckLibrary.query),byId=new Map(S.words.map(w=>[w.id,w]));
  const matches=S.decks.filter(d=>!query||wordSearchKey(d.title).includes(query)||d.wordIds.some(id=>{const w=byId.get(id);return w&&wordSearchKey(`${w.word} ${w.meaning}`).includes(query);})).sort((a,b)=>Number(b.id===deck()?.id)-Number(a.id===deck()?.id)||(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
  const size=8;S.deckLibrary.page=Math.max(1,Math.min(S.deckLibrary.page,Math.ceil(matches.length/size)||1));
  const start=(S.deckLibrary.page-1)*size;
  $('#deck-results').innerHTML=`<div class="word-browser-meta" role="status">${query?`找到 ${matches.length} 份词表`:`共 ${matches.length} 份词表`}</div><div class="deck-library-list">${matches.slice(start,start+size).map(d=>`<button type="button" class="deck-library-item" data-action="choose-deck" data-id="${esc(d.id)}" aria-pressed="${d.id===deck()?.id}"><span class="deck-library-copy"><strong>${esc(d.title)}</strong><small>${d.wordIds.length} 个词 · ${date(d.createdAt)}${d.progress.finished?' · 已学完':''}</small></span>${d.id===deck()?.id?'<span class="badge">当前</span>':'<span aria-hidden="true">↗</span>'}</button>`).join('')||'<p class="word-empty">没有匹配的词表</p>'}</div>${listPagination({page:S.deckLibrary.page,size,total:matches.length,prefix:'deck',label:'词表列表'})}`;
}
function wordsPage() {
  const tabs = `<div class="tabs" role="tablist" aria-label="词汇学习方式">${[['find','挑选词汇'],['study','学习卡片'],['saved','生词本']].map(([id,t])=>`<button role="tab" aria-selected="${S.wordTab===id}" data-word-tab="${id}" class="${S.wordTab===id?'active':''}">${t}${id==='saved'?` · ${saved().length}`:''}</button>`).join('')}</div>`;
  let content;
  if (S.wordTab === 'study') content = studyPage();
  else if (S.wordTab === 'saved') content = `<div class="section-head"><h2>生词本</h2><button class="primary" data-action="study-saved" ${!saved().length?'disabled':''}>开始复习</button></div>${saved().length ? wordBrowser(saved(),'saved') : empty('暂无生词','从词表或文章中收藏单词。')}`;
  else {
    const d = deck();
    content = `<details id="word-search-details" class="word-search-details" ${S.wordSearchOpen===true||(S.wordSearchOpen===null&&!d)?'open':''}><summary>筛选新词 <span>${esc(S.wordFilters.topic)} · ${esc(S.wordFilters.level)}</span></summary>${wordFilters()}</details>`+`<div class="section-head"><div class="row wrap"><h2>${d ? esc(d.title) : '本次词表'}</h2></div><div class="row">${deckPicker()}${d?'<button class="light" data-action="start-study">开始学习</button>':''}</div></div>`;
    if (d) content += `${d.note?`<details class="result-note"><summary>检索备注</summary><p>${esc(d.note)}</p></details>`:''}${wordBrowser(d.wordIds.map(wordById).filter(Boolean),'find',true)}`;
    else content += empty('暂无词表','设置条件，开始选词。');
  }
  return `<header class="page-head"><div><h1>单词学习</h1></div><span class="head-mark">Words into worlds.</span></header>${tabs}${content}`;
}
function studyPage() {
  const d=deck(); if(!d) return empty('还没有学习词表','先挑选一组你想学的单词。','<button class="primary" data-word-tab="find">挑选词汇</button>');
  if(d.progress.finished) return `<div class="study-layout">${empty('本轮完成','待巩固的词会进入复习。','<div class="row"><button data-action="restart-deck">再学一遍</button><button class="primary" data-word-tab="find">挑选下一组</button></div>','✓')}</div>`;
  const index = Math.min(d.progress.index,d.wordIds.length-1), w=wordById(d.wordIds[index]); if(!w) return empty('词条暂时不可用','请返回词表重新选择。');
  const spelling = S.cardMode==='spelling', correct = S.spell.trim().toLowerCase()===w.word.trim().toLowerCase();
  return `<div class="study-layout"><div class="row spread">${deckPicker()}<div class="card-mode"><button data-mode="meaning" class="${!spelling?'active':''}">英文 → 释义</button><button data-mode="spelling" class="${spelling?'active':''}">中文 → 拼写</button></div></div><div class="progress-track"><progress max="${d.wordIds.length}" value="${index}">${index}/${d.wordIds.length}</progress></div><div class="flashcard"><div class="row spread"><span class="badge neutral">${index+1} / ${d.wordIds.length}</span><span class="badge">${esc(w.level || '词汇复习')}</span></div><h2 class="${spelling&&!S.revealed?'chinese':''}">${esc(spelling&&!S.revealed?w.meaning:w.word)}</h2>${(!spelling||S.revealed)?`<p class="muted">${esc(w.phonetic)} <span> ${esc(w.partOfSpeech)}</span></p>`:''}${spelling&&!S.revealed?`<label class="spell"><span class="sr-only">填写英文拼写</span><input id="spell-input" placeholder="写下你的答案" value="${esc(S.spell)}" autocomplete="off" spellcheck="false"></label>`:''}${S.revealed?`${spelling?`<span class="badge ${correct?'':'neutral'}">${correct?'拼写正确':'对照上方单词，再记一次'}</span>`:''}<div class="meaning">${esc(w.meaning)}</div><p class="definition">${esc(w.definition)}</p><div class="example"><div class="eyebrow">${w.exampleKind==='original'?'原文例句':'AI 例句'}</div><div class="en">${esc(w.example)}</div><div class="zh">${esc(w.exampleTranslation)}</div></div>${source(w.sourceUrl,w.sourceTitle)}<button class="ghost small" data-action="save-word" data-id="${esc(w.id)}">${w.saved?'已加入生词本':'加入生词本'}</button>`:`<button class="primary reveal" data-action="reveal">${spelling?'检查拼写':'查看释义'}</button>`}</div>${S.revealed?`<div class="ratings"><button data-rating="unknown">不认识<small>10 分钟后复习 · 1</small></button><button data-rating="fuzzy">有些模糊<small>明天复习 · 2</small></button><button data-rating="known" class="light">已掌握<small>延后复习 · 3</small></button></div>`:''}<div class="study-footer">空格翻卡 · 1 / 2 / 3 自评</div></div>`;
}
function articleFilterPanel() {
  const f=S.articleFilters;
  return `<form id="article-search" class="panel"><div class="panel-head"><h2>筛选文章</h2><span class="eyebrow">A little reading, every day</span></div><div class="filter-grid article-filters">${filterInput('主题','topic',f,'article','maxlength="150" placeholder="例如：太空探索、产品设计" required')}${filterSelect('参考难度','level',levels,f,'article')}${filterInput('最少单词数','minWords',f,'article','type="number" min="50" max="5000" required')}${filterInput('最多单词数','maxWords',f,'article','type="number" min="50" max="8000" required')}</div><details class="advanced"><summary>更多条件</summary><div class="filter-grid">${filterSelect('文章类型','type',['不限','新闻','科普','评论','故事'],f,'article')}${filterInput('候选数量','count',f,'article','type="number" min="1" max="10" required')}${filterInput('来源网站','domain',f,'article','placeholder="例如：nasa.gov"')}${filterInput('发布时间不早于','since',f,'article','type="date"')}</div><label class="advanced">补充要求<input data-filter="article" name="extra" value="${esc(f.extra)}" placeholder="例如：讲清楚一个概念，少用专业术语" maxlength="500"></label></details><div class="filter-bottom"><button type="submit" class="primary" ${busy('articles')?'disabled':''}>${busy('articles')?'正在检索…':'检索文章'}</button></div></form>`;
}
function articleCards(articles) { return `<div class="article-grid">${articles.map(a=>`<article class="article-card"><div class="row spread"><span class="source-name">${esc(a.source || '我的文章')}</span><span class="badge ${a.completed?'lime':''}">${a.completed?'已读完':esc(a.level || '自选文章')}</span></div><h3>${esc(a.title)}</h3><p class="summary">${esc(a.summary || '')}</p><div class="card-bottom"><span class="muted">${a.wordCount || a.estimatedWords || '—'} 词${!a.wordCount&&!a.imported?'（估计）':''}</span><button class="small ${a.hasText?'light':'primary'}" data-action="open-article" data-id="${a.id}" ${busy('open')?'disabled':''}>${a.hasText?'继续阅读':'开始阅读'}</button></div><div class="row spread advanced">${source(a.url,a.source)}<button class="ghost small" data-action="save-article" data-id="${a.id}">${a.saved?'已收藏':'收藏'}</button></div></article>`).join('')}</div>`; }
function readingPage() {
  if(S.article) return readerPage();
  const articles=S.readTab==='saved'?S.articles.filter(a=>a.saved):S.articleIds?S.articles.filter(a=>S.articleIds.includes(a.id)):S.articles;
  return `<header class="page-head"><div class="page-title"><h1>英文阅读</h1><button data-action="import">导入文章</button></div><span class="head-mark">Between the lines.</span></header><div class="tabs"><button data-read-tab="find" class="${S.readTab==='find'?'active':''}">发现文章</button><button data-read-tab="saved" class="${S.readTab==='saved'?'active':''}">我的收藏 · ${S.articles.filter(a=>a.saved).length}</button></div>${S.readTab==='find'?articleFilterPanel():''}<div class="section-head"><h2>${S.readTab==='saved'?'收藏的文章':'阅读书架'}</h2><span class="muted">${articles.length} 篇</span></div>${S.articleNote?`<details class="result-note"><summary>检索备注</summary><p>${esc(S.articleNote)}</p></details>`:''}${articles.length?articleCards(articles):empty(S.readTab==='saved'?'暂无收藏':'暂无文章',S.readTab==='saved'?'收藏想再读的文章。':'检索或导入一篇文章。','','Read.')}`;
}
function readerPage() {
  const a=S.article, paragraphs=a.text.split(/\n\n+/).filter(Boolean);
  return `<header class="page-head"><div class="row"><button class="ghost small" data-action="back-library">‹ 阅读书架</button><span class="badge neutral">${a.imported?'我的文章':'原文阅读'}</span></div><div class="row"><button class="ghost small" data-action="save-article" data-id="${a.id}">${a.saved?'已收藏':'收藏文章'}</button><button class="small" data-action="import">导入文章</button></div></header><div class="reading-layout"><section class="reader" aria-label="英文原文"><div class="reader-content"><span class="eyebrow">${esc(a.source || 'English reading')}</span><h1>${esc(a.title)}</h1><div class="article-meta">${a.level?`<span class="badge">${esc(a.level)} · 估计</span>`:''}<span>${a.wordCount} words</span><span>约 ${Math.max(1,Math.round(a.wordCount/130))} 分钟</span>${source(a.url,'查看原文')}</div>${a.filters && (a.wordCount<a.filters.minWords || a.wordCount>a.filters.maxWords)?'<div class="hint-strip">正文篇幅超出筛选范围。</div>':''}<div class="article-text" id="article-text" lang="en">${paragraphs.map((p,i)=>`<p data-paragraph="${i}" id="para-${i}" tabindex="0" title="点选这一段，或拖选具体句子">${esc(p)}</p>`).join('')}</div><div class="reader-end"><button class="light" data-action="finish-reading">${a.completed?'已读完 ✓':'标记读完'}</button></div></div></section><aside class="assistant" aria-label="AI 学习助手"><div class="assistant-head"><div class="row spread"><h2>一起读懂</h2><span class="badge neutral">AI 助手</span></div><div class="tabs"><button data-assistant-tab="chat" class="${S.assistantTab==='chat'?'active':''}">解释与提问</button><button data-assistant-tab="quiz" class="${S.assistantTab==='quiz'?'active':''}">理解测试</button></div></div><div class="assistant-body">${S.assistantTab==='chat'?chatBody():quizBody()}</div><div id="selection-area">${selectionMarkup()}</div>${S.assistantTab==='chat'?`<form class="composer" id="chat-form"><label><span class="sr-only">向阅读助手提问</span><textarea id="compose" placeholder="这句话为什么这样表达？" rows="2" maxlength="2000">${esc(S.compose)}</textarea></label><div class="row"><select id="reply-language" aria-label="讲解语言">${options(['中文','English'],S.language)}</select><button type="submit" class="primary" ${busy('explain')?'disabled':''}>${busy('explain')?'思考中…':'发送提问'}</button></div></form>`:''}</aside></div>`;
}
function selectionMarkup() { return S.selection?`<div class="selection-box"><div class="selection-label"><span>已选中原文</span><span><button class="ghost small" data-action="explain-selection" ${busy('explain')?'disabled':''}>解释</button>${S.selection.split(/\s+/).length<=6?`<button class="ghost small" data-action="save-selection" ${busy('word')?'disabled':''}>收藏生词</button>`:''}<button class="icon-button" data-action="clear-selection" aria-label="清除选中文字">×</button></span></div>${esc(S.selection)}</div>`:''; }
function chatBody() {
  const messages=S.article.messages||[];
  if(!messages.length) return `<div class="assistant-welcome"><div class="serif">A little clarity.</div><p class="muted">选中原文解释，或直接提问。</p><div class="prompt-list"><button data-prompt="请解释选中句子的意思，拆解主要语法结构，并说明它在上下文中的作用。">解释这句话</button><button data-prompt="请用简明中文概括这篇文章的主旨和论证顺序。">概括主旨</button><button data-prompt="请从文章中挑选三个值得学习的英语表达，说明适用场景。">学习表达</button><button data-prompt="请按段落翻译这篇文章，并保留段落编号。">翻译全文</button></div></div>`;
  return messages.map(m=>`<div class="message ${m.role}"><div class="role">${m.role==='user'?'我的问题':'阅读助手'}</div>${m.selection&&m.role==='user'?`<div class="quote">${esc(m.selection)}</div>`:''}<div class="text">${esc(m.text)}</div>${m.evidence?`<div class="quote">${esc(m.evidence)}</div><button class="ghost small" data-evidence="${esc(m.evidence)}">定位原文</button>`:''}${m.vocabulary?.length?`<div class="vocab-chips">${m.vocabulary.map(v=>`<span>${esc(v.word)} · ${esc(v.meaning)}</span>`).join('')}</div>`:''}</div>`).join('');
}
function quizBody() {
  const quizzes=S.article.quizzes||[];const q=quizzes.find(q=>q.id===S.quizId)||quizzes[0];
  const controls=`<form id="quiz-form"><div class="quiz-controls"><label>题目数量<input id="quiz-count" type="number" min="1" max="10" value="${S.quizCount}" required></label><label>题目类型<select id="quiz-type">${options(['混合','选择题','简答题','主旨概括'],S.quizType)}</select></label></div><p class="muted advanced">${S.selection?'选中内容':'全文'} · 提交后显示答案</p><button class="primary advanced" type="submit" ${busy('quiz')?'disabled':''}>${busy('quiz')?'正在出题…':q?'重新出题':'生成理解题'}</button></form>`;
  if(!q) return controls;
  const total=q.results?.reduce((sum,r)=>sum+r.score,0)||0;
  return `${controls}<hr class="divider">${quizzes.length>1?`<label>答题记录<select id="quiz-picker">${quizzes.map((item,i)=>`<option value="${item.id}" ${item.id===q.id?'selected':''}>第 ${quizzes.length-i} 组 · ${item.questions.length} 题 · ${item.graded?'已批改':'未完成'}</option>`).join('')}</select></label><hr class="divider">`:''}${q.graded?`<div class="row spread"><h3>本次理解测试</h3><span class="score">${total} <span class="muted">/ ${q.questions.length}</span></span></div>`:'<h3>作答</h3>'}<form id="grade-form" data-id="${q.id}">${q.questions.map((question,i)=>{const result=q.results?.find(r=>r.questionId===question.id),answer=(q.graded?q.answers?.[question.id]:S.quizAnswers[question.id]??q.answers?.[question.id])||'';return `<div class="quiz-question"><span class="eyebrow">Question ${String(i+1).padStart(2,'0')}</span><h3>${esc(question.question)}</h3>${question.type==='choice'?`<div class="options">${question.options.map((opt,j)=>`<label class="option"><input type="radio" name="${question.id}" data-answer="${question.id}" value="${esc(opt)}" ${answer===opt?'checked':''} ${q.graded?'disabled':''} required><span>${String.fromCharCode(65+j)}. ${esc(opt)}</span></label>`).join('')}</div>`:`<label><span class="sr-only">第 ${i+1} 题答案</span><textarea data-answer="${question.id}" name="${question.id}" placeholder="用英文或中文写下你的理解…" maxlength="2500" rows="3" ${q.graded?'readonly':''} required>${esc(answer)}</textarea></label>`}${result?`<div class="feedback"><strong>${result.score===1?'理解正确':result.score===.5?'部分正确':'再看一看原文'}</strong><p>${esc(result.feedback)}</p><p><strong>参考答案：</strong>${esc(result.referenceAnswer)}</p><div class="evidence">${esc(result.evidence)}</div><button type="button" class="ghost small" data-evidence="${esc(result.evidence)}">定位原文</button></div>`:''}</div>`}).join('')}${!q.graded?`<button class="primary advanced" type="submit" ${busy('grade')?'disabled':''}>${busy('grade')?'正在批改…':'提交回答'}</button>`:''}</form>`;
}
// Calendar arithmetic uses UTC date-only values; event dates come from the server's learning timezone.
const activityDateOffset = (value, offset) => new Date(Date.parse(`${value}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10);
function activityCount(day, filter=S.activityFilter) {
  if(!day)return 0;
  const words=day.wordsStudied||0,reading=day.questions+day.quizzes+day.articlesCompleted;
  return filter==='words'?words:filter==='reading'?reading:words+reading;
}
function activityCalendar(activity=S.activity, filter=S.activityFilter) {
  const today=activity?.today||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Singapore'}).format(new Date());
  const start=activityDateOffset(today,-364),offset=(new Date(`${start}T00:00:00Z`).getUTCDay()+6)%7;
  const first=activityDateOffset(start,-offset),weeks=Math.ceil((365+offset)/7),byDate=new Map((activity?.days||[]).map(d=>[d.date,d]));
  const since=activity?.since?new Intl.DateTimeFormat('sv-SE',{timeZone:activity.timeZone||'Asia/Singapore'}).format(new Date(activity.since)):today;
  const days=Array.from({length:weeks*7},(_,i)=>{
    const key=activityDateOffset(first,i),day=byDate.get(key)||{date:key,reviews:0,wordsStudied:0,wordKeys:[],questions:0,quizzes:0,articlesCompleted:0,total:0};
    return {...day,date:key,count:activityCount(day,filter),outside:key<start||key>today,untracked:key<since};
  });
  const visible=days.filter(d=>!d.outside),activeDays=visible.filter(d=>d.count>0).length;
  let streak=0,cursor=activityCount(byDate.get(today),filter)>0?today:activityDateOffset(today,-1);
  while(activityCount(byDate.get(cursor),filter)>0){streak++;cursor=activityDateOffset(cursor,-1);}
  const months=[];
  for(let i=0;i<days.length;i++){
    const d=days[i];if(d.outside)continue;
    if(!months.length||d.date.slice(0,7)!==months.at(-1).key)months.push({key:d.date.slice(0,7),label:`${Number(d.date.slice(5,7))}月`,column:Math.floor(i/7)+1});
  }
  if(months.length>1&&months[1].column-months[0].column<3)months.shift();
  return {today,start,days,visible,weeks,months,activeDays,streak,filter};
}
function activityWeeks(c=activityCalendar()) {
  return Array.from({length:c.weeks},(_,i)=>{
    const days=c.days.slice(i*7,i*7+7),visible=days.filter(d=>!d.outside);
    const week={date:days[0].date,rangeStart:visible[0].date,rangeEnd:visible.at(-1).date,reviews:0,wordsStudied:0,wordKeys:[],questions:0,quizzes:0,articlesCompleted:0,total:0,count:0,untracked:visible.every(d=>d.untracked)};
    for(const day of visible)for(const field of ['reviews','questions','quizzes','articlesCompleted','total'])week[field]+=day[field];
    week.wordKeys=[...new Set(visible.flatMap(day=>day.wordKeys||[]))];
    week.wordsStudied=week.wordKeys.length;week.count=activityCount(week,c.filter);
    return week;
  });
}
function setActivityMode(mode) {
  if(!['daily','weekly'].includes(mode)||mode===S.activityMode)return;
  const weeks=activityWeeks();
  if(mode==='weekly')S.activityWeek=weeks.find(w=>S.activityDate>=w.rangeStart&&S.activityDate<=w.rangeEnd)?.date||weeks.at(-1).date;
  else {
    const week=weeks.find(w=>w.date===S.activityWeek)||weeks.at(-1);
    if(S.activityDate<week.rangeStart||S.activityDate>week.rangeEnd)S.activityDate=week.rangeEnd;
  }
  S.activityMode=mode;
  try{localStorage.setItem('between.activityView',JSON.stringify({mode}));}catch{/* View switching also works without storage. */}
  render();
}
function selectActivityWeek(value) {
  const week=activityWeeks().find(w=>w.date===value);if(!week)return;
  S.activityWeek=value;
  document.querySelectorAll('[data-activity-week]').forEach(el=>{
    const selected=el.dataset.activityWeek===value;el.classList.toggle('is-selected',selected);el.setAttribute('aria-pressed',String(selected));el.tabIndex=selected?0:-1;
  });
  $('#activity-detail').innerHTML=activityDetail(week);
}
function activityDayDescription(day) {
  if(day.untracked)return '尚未开始记录';
  const parts=[];
  if(S.activityFilter!=='reading'&&day.wordsStudied)parts.push(`学习 ${day.wordsStudied} 个词`);
  if(S.activityFilter!=='words'){
    if(day.articlesCompleted)parts.push(`读完 ${day.articlesCompleted} 篇`);
    if(day.questions)parts.push(`提问 ${day.questions} 次`);
    if(day.quizzes)parts.push(`测验 ${day.quizzes} 组`);
  }
  return parts.join(' · ')||'暂无学习记录';
}
const activityDayLabel = day => `${day.date} · ${activityDayDescription(day)}`;
function activityDetail(day) {
  if(day.rangeStart)return `<strong>${esc(day.rangeStart.replaceAll('-','.'))} — ${esc(day.rangeEnd.replaceAll('-','.'))}</strong><span>${day.count&&S.activityFilter!=='words'?`${day.count} 次学习 · `:''}${esc(activityDayDescription(day))}</span>`;
  return `<strong>${esc(day.date.replaceAll('-','.'))}${day.date===S.activity?.today?' · 今天':''}</strong><span>${esc(activityDayDescription(day))}</span>`;
}
function activityMarkup() {
  if(!S.activity)return '<section class="panel activity-panel"><h2>学习足迹</h2><p class="activity-notice">学习记录暂未载入，请刷新页面。</p></section>';
  const c=activityCalendar(),selected=c.visible.find(d=>d.date===S.activityDate)||c.visible.at(-1);S.activityDate=selected.date;
  const weeks=activityWeeks(c),selectedWeek=weeks.find(w=>w.date===S.activityWeek)||weeks.find(w=>selected.date>=w.rangeStart&&selected.date<=w.rangeEnd);S.activityWeek=selectedWeek.date;
  const weekly=S.activityMode==='weekly',maxWeek=Math.max(0,...weeks.map(w=>w.count));
  const level=count=>count===0?0:count<=3?1:count<=9?2:count<=19?3:4;
  const grid=weekly?`<div class="activity-weeks" role="group" aria-label="每周学习活动，使用左右方向键选择周">${weeks.map(w=>{
    const height=maxWeek?Math.ceil(w.count/maxWeek*7):0,label=`${w.rangeStart} — ${w.rangeEnd} · ${activityDayDescription(w)}`;
    return `<button type="button" id="activity-week-${w.date}" class="activity-week ${w.date===selectedWeek.date?'is-selected':''} ${w.untracked?'is-untracked':''}" data-activity-week="${w.date}" data-count="${w.count}" data-activity-tooltip="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${w.date===selectedWeek.date}" tabindex="${w.date===selectedWeek.date?0:-1}">${Array.from({length:7},(_,i)=>`<span class="activity-week-cell" data-filled="${i>=7-height}" aria-hidden="true"></span>`).join('')}</button>`;
  }).join('')}</div>`:`<div class="activity-days" role="group" aria-label="每日学习活动，使用方向键选择日期">${c.days.map(d=>d.outside?'<span class="activity-blank" aria-hidden="true"></span>':`<button type="button" id="activity-${d.date}" class="activity-day ${d.date===selected.date?'is-selected':''} ${d.date===c.today?'is-today':''} ${d.untracked?'is-untracked':''}" data-activity-date="${d.date}" data-level="${level(d.count)}" data-activity-tooltip="${esc(activityDayLabel(d))}" aria-label="${esc(activityDayLabel(d))}" aria-pressed="${d.date===selected.date}" tabindex="${d.date===selected.date?0:-1}"></button>`).join('')}</div>`;
  return `<section class="panel activity-panel" aria-labelledby="activity-title"><header class="activity-head"><div><h2 id="activity-title">学习足迹</h2></div><div class="activity-controls"><div class="activity-filters" role="group" aria-label="学习活动类型">${[['all','全部'],['words','单词'],['reading','阅读']].map(([value,label])=>`<button type="button" id="activity-filter-${value}" data-activity-filter="${value}" class="${S.activityFilter===value?'active':''}" aria-pressed="${S.activityFilter===value}">${label}</button>`).join('')}</div><div class="activity-modes" role="group" aria-label="统计周期">${[['daily','Daily'],['weekly','Weekly']].map(([value,label])=>`<button type="button" id="activity-mode-${value}" data-activity-mode="${value}" class="${S.activityMode===value?'active':''}" aria-pressed="${S.activityMode===value}">${label}</button>`).join('')}</div></div></header>
  <div class="activity-scroll"><div class="activity-calendar">${grid}<div class="activity-months" aria-hidden="true">${Array.from({length:c.weeks},(_,i)=>`<span>${c.months.find(m=>m.column===i+1)?.label||''}</span>`).join('')}</div></div></div>
  <div class="activity-footer"><div class="activity-summary">学习 <strong>${c.activeDays}</strong> 天 <span aria-hidden="true">·</span> 连续 <strong>${c.streak}</strong> 天</div>${weekly?`<div class="activity-week-scale">${S.activityFilter==='words'?`每周词数 · 最多 ${maxWeek} 个`:`每周总量 · 最高 ${maxWeek} 次`}</div>`:`<div class="activity-legend" aria-label="${S.activityFilter==='words'?'每日学习单词数':'每日学习量'}：0、1至3、4至9、10至19、20及以上"><span>少</span>${[0,1,2,3,4].map(n=>`<i data-level="${n}" aria-hidden="true"></i>`).join('')}<span>多</span></div>`}</div>
  <div id="activity-detail" class="activity-detail" aria-live="polite" aria-atomic="true">${activityDetail(weekly?selectedWeek:selected)}</div>${S.activity?.recording===false?'<p class="activity-notice">学习记录已暂停 <button class="ghost small" data-nav="settings">前往设置</button></p>':!c.activeDays?'<p class="activity-notice">从下一次练习开始，点亮第一格。</p>':''}<div id="activity-tooltip" class="activity-tooltip" role="tooltip" hidden></div></section>`;
}
function hideActivityTooltip(){const tooltip=$('#activity-tooltip');if(tooltip)tooltip.hidden=true;}
function showActivityTooltip(el) {
  const tooltip=$('#activity-tooltip');if(!tooltip||!el)return;
  const entry=el.dataset.activityWeek?activityWeeks().find(w=>w.date===el.dataset.activityWeek):activityCalendar().visible.find(d=>d.date===el.dataset.activityDate);
  if(!entry)return;
  tooltip.innerHTML=activityDetail(entry);
  tooltip.hidden=false;
  const box=el.getBoundingClientRect(),tip=tooltip.getBoundingClientRect();
  tooltip.style.left=`${Math.max(8,Math.min(box.x+box.width/2-tip.width/2,window.innerWidth-tip.width-8))}px`;
  tooltip.style.top=`${box.top>tip.height+16?box.top-tip.height-10:box.bottom+10}px`;
}
document.addEventListener('pointerover',event=>{const el=event.target.closest('[data-activity-tooltip]');if(el&&event.pointerType!=='touch')showActivityTooltip(el);});
document.addEventListener('pointerout',event=>{const el=event.target.closest('[data-activity-tooltip]');if(el&&!el.contains(event.relatedTarget))hideActivityTooltip();});
document.addEventListener('focusin',event=>{const el=event.target.closest('[data-activity-tooltip]');if(el)showActivityTooltip(el);});
document.addEventListener('focusout',event=>{if(event.target.closest('[data-activity-tooltip]'))hideActivityTooltip();});
document.addEventListener('scroll',hideActivityTooltip,true);
function selectActivityDate(value) {
  const day=activityCalendar().visible.find(d=>d.date===value);if(!day)return;
  S.activityDate=value;
  document.querySelectorAll('[data-activity-date]').forEach(el=>{
    const selected=el.dataset.activityDate===value;el.classList.toggle('is-selected',selected);el.setAttribute('aria-pressed',String(selected));el.tabIndex=selected?0:-1;
  });
  $('#activity-detail').innerHTML=activityDetail(day);
}
function compactRecentMarkup() {
  const decks=S.decks.slice(0,3),articles=S.articles.filter(a=>a.hasText).slice(0,3);
  const deckRows=decks.map(d=>{
    const count=d.wordIds.length,finished=d.progress.finished,reviewed=finished?count:Math.min(count,Math.max(0,d.progress.index||0)),action=finished?'查看':'继续';
    return `<button type="button" class="learning-recent-row" data-action="continue-deck" data-id="${esc(d.id)}" aria-label="${finished?'查看词表':'继续学习'}：${esc(d.title)}"><span class="learning-recent-copy"><span class="learning-recent-title" title="${esc(d.title)}">${esc(d.title)}</span><span class="learning-recent-meta">${reviewed} / ${count} 个词${finished?' · 本轮完成':''}</span></span><span class="learning-recent-action" aria-hidden="true">${action} <span>↗</span></span></button>`;
  }).join('');
  const articleRows=articles.map(a=>`<button type="button" class="learning-recent-row" data-action="open-article" data-id="${esc(a.id)}" aria-label="${a.completed?'重读':'继续阅读'}：${esc(a.title)}" ${busy('open')?'disabled':''}><span class="learning-recent-copy"><span class="learning-recent-title" title="${esc(a.title)}">${esc(a.title)}</span><span class="learning-recent-meta">${a.completed?'已读完':'阅读中'}${a.wordCount?` · ${a.wordCount} 词`:''}</span></span><span class="learning-recent-action" aria-hidden="true">${a.completed?'重读':'继续'} <span>↗</span></span></button>`).join('');
  return `<div class="learning-recent"><section class="learning-recent-section" aria-labelledby="recent-decks-title"><header class="learning-recent-head"><h2 id="recent-decks-title">最近词表</h2><button type="button" class="ghost small" data-nav="words" data-learning-all="words" aria-label="查看全部词表">查看全部 <span aria-hidden="true">↗</span></button></header><div class="learning-recent-list">${deckRows||'<p class="learning-recent-empty">还没有词表。</p>'}</div></section><section class="learning-recent-section" aria-labelledby="recent-reading-title"><header class="learning-recent-head"><h2 id="recent-reading-title">最近阅读</h2><button type="button" class="ghost small" data-nav="reading" data-learning-all="reading" aria-label="查看全部文章">查看全部 <span aria-hidden="true">↗</span></button></header><div class="learning-recent-list">${articleRows||'<p class="learning-recent-empty">还没有阅读记录。</p>'}</div></section></div>`;
}
function learningPage() {
  const known=S.words.filter(w=>w.review?.rating==='known').length;
  return `<header class="page-head"><div class="page-title"><h1>我的学习</h1><button class="primary" data-action="review" ${!due().length?'disabled':''}>复习 ${due().length} 个词</button></div><span class="head-mark">Little by little.</span></header><div class="stats-row"><div class="stat"><div class="label">已掌握词汇</div><div class="value">${known} <span class="muted">/ ${S.words.length}</span></div></div><div class="stat"><div class="label">待复习词汇</div><div class="value">${due().length}</div></div><div class="stat"><div class="label">读完的文章</div><div class="value">${S.articles.filter(a=>a.completed).length}</div></div></div>${activityMarkup()}${compactRecentMarkup()}`;
}
function memoryPanel() {
  const m=S.memory;if(!m)return '';
  if(!S.memoryDraft)S.memoryDraft={notes:m.notes,recording:m.recording,personalize:m.personalize,revision:m.revision};
  const d=S.memoryDraft,s=m.summary,st=s.stats;
  return `<section class="panel memory-panel" aria-labelledby="memory-title"><div class="panel-head"><div><h2 id="memory-title">专属助手记忆</h2></div><span class="badge ${m.recording?'':'neutral'}">${m.recording?'正在积累':'记录已暂停'}</span></div>${m.warning?`<p class="hint-strip error-strip" role="alert">${esc(m.warning)}</p>`:''}<div class="memory-grid"><form id="memory-form"><label for="memory-notes">我的目标与偏好<textarea id="memory-notes" name="notes" rows="7" maxlength="4000" ${!m.revision?'readonly':''} placeholder="例如：想读懂科技文章；先讲句子主干，再解释从句；每天学习 15 分钟。">${esc(d.notes)}</textarea></label><label class="check"><input type="checkbox" id="memory-recording" ${d.recording?'checked':''}>记录新的学习行为</label><label class="check"><input type="checkbox" id="memory-personalize" ${d.personalize?'checked':''}>让助手参考记忆</label><p class="small-note memory-help">开启参考后，备注与学习摘要发送给模型。</p><div class="row wrap"><button class="primary" type="submit">保存记忆</button><button class="ghost small" type="button" data-action="reset-memory-draft">载入备注</button></div></form><aside class="memory-summary"><h3>学习记录</h3><div class="memory-counts"><div><strong>${st.reviews}</strong><span>次词汇自评</span></div><div><strong>${st.questions}</strong><span>次提问</span></div><div><strong>${st.quizzes}</strong><span>组理解测试</span></div></div><h4>待巩固</h4>${s.reviewWords.length?`<div class="vocab-chips">${s.reviewWords.slice(0,10).map(w=>`<span>${esc(w.word)} · ${w.rating==='fuzzy'?'模糊':'不认识'}</span>`).join('')}</div>`:`<p class="muted">${st.reviews?'暂无待巩固词。':'从下一次练习开始积累。'}</p>`}${s.needsReview.length?`<h4>待回顾</h4><p class="memory-question">${esc(s.needsReview[0].question)}</p>`:''}<p class="small-note memory-help">自 ${date(m.enabledAt)} 起 · ${st.events} 条记录</p></aside></div><details class="memory-file"><summary>查看记忆文件</summary><div class="row wrap advanced"><a class="source" href="/api/memory?download=1" download="memroy.md">下载 Markdown ↗</a><button type="button" class="ghost small" data-action="refresh-memory">刷新预览</button></div><pre tabindex="0">${esc(m.markdown || '文件暂时无法预览，请检查上方提示。')}</pre></details></section>`;
}
function modelOptions(selected, fallback) {
  const models=S.modelCatalog.models||[];
  const current=selected&&!models.some(m=>m.id===selected)?`<option value="${esc(selected)}" selected>${esc(selected)} · 上次选择</option>`:'';
  return `<option value="" ${!selected?'selected':''}>${fallback}</option>${current}${models.map(m=>`<option value="${esc(m.id)}" ${selected===m.id?'selected':''}>${esc(m.name)}${m.isDefault?' · 默认':''}</option>`).join('')}`;
}
const effortLabels={none:'不启用 · None',minimal:'最低 · Minimal',low:'低 · Low',medium:'中 · Medium',high:'高 · High',xhigh:'更高 · XHigh',max:'最高 · Max',ultra:'超高 · Ultra'};
function selectedCodexModel(tutor=false) {
  const d=S.settingsDraft||S.settings,models=S.modelCatalog.models||[],id=tutor?(d.tutorModel||d.model):d.model;
  return id?models.find(m=>m.id===id):models.find(m=>m.isDefault);
}
function selectedApiModel(){return(S.apiCatalog.models||[]).find(m=>m.id===S.apiDraft.model.trim());}
function normalizeGenerationDraft(d,model,effortKey,fastKey,allowUnknown=false) {
  let changed=false;
  const knownEfforts=Array.isArray(model?.reasoningEfforts),efforts=knownEfforts?model.reasoningEfforts:allowUnknown?Object.keys(effortLabels):[];
  if(d[effortKey]&&!efforts.includes(d[effortKey])){d[effortKey]='';changed=true;}
  if(d[fastKey]&&!(model?.supportsFast===true||(allowUnknown&&model?.supportsFast!==false))){d[fastKey]=false;changed=true;}
  return changed;
}
function normalizeCodexDraft(){if(!S.settingsDraft)return false;const search=normalizeGenerationDraft(S.settingsDraft,selectedCodexModel(),'reasoningEffort','fastMode');const tutor=normalizeGenerationDraft(S.settingsDraft,selectedCodexModel(true),'tutorReasoningEffort','tutorFastMode');return search||tutor;}
function generationControls(kind) {
  const isApi=kind==='api',tutor=kind==='tutor',d=isApi?S.apiDraft:S.settingsDraft,model=isApi?selectedApiModel():selectedCodexModel(tutor),effortKey=tutor?'tutorReasoningEffort':'reasoningEffort',fastKey=tutor?'tutorFastMode':'fastMode';
  const known=Array.isArray(model?.reasoningEfforts),efforts=known?model.reasoningEfforts:isApi?Object.keys(effortLabels):[],effortDisabled=!efforts.length,fastDisabled=isApi?model?.supportsFast===false:model?.supportsFast!==true;
  const defaultLabel=model?.defaultReasoningEffort?`默认 · ${model.defaultReasoningEffort.charAt(0).toUpperCase()+model.defaultReasoningEffort.slice(1)}`:'模型默认';
  const effortNote=effortDisabled?(known?'当前模型不支持调整':'获取模型以选择'):'';
  const previousEffort=d[effortKey]&&!efforts.includes(d[effortKey])?`<option value="${esc(d[effortKey])}" selected disabled>上次选择 · ${esc(effortLabels[d[effortKey]]||d[effortKey])}</option>`:'';
  const fastNote=fastDisabled?(model?.supportsFast===false?'当前模型不支持':'获取模型以选择'):isApi&&model?.supportsFast==null?'依接口支持情况生效'+(d[fastKey]?' · 用量可能更高':''):'更快响应 · 用量更高';
  const effortAttrs=isApi?'data-api-field="reasoningEffort"':`name="${effortKey}"`,fastAttrs=isApi?'data-api-field="fastMode"':`name="${fastKey}"`;
  return `<div class="generation-controls"><label for="${kind}-effort">Effort · 思考强度<select id="${kind}-effort" ${effortAttrs} ${effortDisabled?'disabled':''} ${effortNote?`aria-describedby="${kind}-effort-note"`:''}><option value="" ${!d[effortKey]?'selected':''}>${esc(defaultLabel)}</option>${previousEffort}${efforts.map(value=>`<option value="${esc(value)}" ${d[effortKey]===value?'selected':''}>${esc(effortLabels[value]||value)}</option>`).join('')}</select>${effortNote?`<span class="field-note" id="${kind}-effort-note">${effortNote}</span>`:''}</label><div class="fast-field"><span class="control-label">Fast · 快速模式</span><label class="fast-control" for="${kind}-fast"><span>${d[fastKey]?'已开启':isApi?'接口默认':'关闭'}</span><input id="${kind}-fast" class="fast-toggle" type="checkbox" role="switch" aria-label="${isApi?'API':tutor?'阅读助手':'检索模型'} Fast 快速模式" aria-describedby="${kind}-fast-note" ${fastAttrs} ${d[fastKey]?'checked':''} ${fastDisabled?'disabled':''}></label><span class="field-note" id="${kind}-fast-note">${fastNote}</span></div></div>`;
}
function apiSettingsMarkup() {
  const d=S.apiDraft,models=S.apiCatalog.models||[];
  const keyHint=d.apiKey?'保存后更新密钥':hasSavedApiKey()?'已保存，留空保留':d.clearKey?'保存后移除密钥':'密钥仅保存在本机';
  return `<div class="api-settings"><p class="provider-caption">兼容 OpenAI · 用于讲解、出题与批改</p><div class="api-grid"><label>API 地址<input id="api-base-url" name="apiBaseUrl" data-api-field="baseUrl" type="url" value="${esc(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label><label>API Key<input id="api-key" name="apiKey" data-api-field="apiKey" type="password" value="${esc(d.apiKey)}" placeholder="${hasSavedApiKey()?'已保存，留空保留':'输入 API Key'}" autocomplete="new-password" spellcheck="false"><span class="field-note" id="api-key-hint">${keyHint}</span></label><label class="api-model-field">模型<input id="api-model" name="apiModel" data-api-field="model" value="${esc(d.model)}" placeholder="输入模型名称，或从列表选择" autocomplete="off" spellcheck="false"></label>${models.length?`<label>可用模型<select id="api-model-picker" aria-label="选择 API 模型"><option value="">从列表选择</option>${models.map(m=>`<option value="${esc(m.id)}" ${d.model===m.id?'selected':''}>${esc(m.name||m.id)}</option>`).join('')}</select></label>`:''}</div>${generationControls('api')}<div class="api-actions"><div class="row wrap"><button type="button" class="light" data-action="refresh-api-models">${S.apiAction==='models'?'获取中…':'获取可用模型'}</button><button type="button" data-action="test-api">${S.apiAction==='test'?'测试中…':'测试连接'}</button>${models.length?`<span class="field-note">${models.length} 个模型</span>`:''}</div>${S.settings.api?.hasKey?`<label class="check"><input id="api-clear-key" data-api-field="clearKey" type="checkbox" ${d.clearKey?'checked':''}>清除已存密钥</label>`:''}</div>${S.apiError?`<p class="model-error api-feedback" role="alert">${esc(S.apiError)}</p>`:S.apiMessage?`<p class="api-feedback muted" role="status">${esc(S.apiMessage)}</p>`:''}</div>`;
}
function settingsPage() {
  if(!S.settingsDraft)S.settingsDraft={model:S.settings.model||'',tutorModel:S.settings.tutorModel||'',tutorProvider:S.settings.tutorProvider||'codex',reasoningEffort:S.settings.reasoningEffort||'',fastMode:S.settings.fastMode===true,tutorReasoningEffort:S.settings.tutorReasoningEffort||'',tutorFastMode:S.settings.tutorFastMode===true};
  if(!S.apiDraft)S.apiDraft={baseUrl:S.settings.api?.baseUrl||'',model:S.settings.api?.model||'',apiKey:'',clearKey:false,reasoningEffort:S.settings.api?.reasoningEffort||'',fastMode:S.settings.api?.fastMode===true};
  const d=S.settingsDraft,c=S.modelCatalog,locked=settingsBusy();
  const updated=c.fetchedAt?new Date(c.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
  return `<header class="page-head"><div><h1>学习偏好</h1></div><span class="head-mark">Make it yours.</span></header><section class="panel model-panel" aria-labelledby="model-title"><div class="panel-head"><h2 id="model-title">模型与接口</h2><button type="button" class="light" data-action="refresh-models" ${locked?'disabled':''}>${S.modelsLoading?'获取中…':'获取 Codex 模型'}</button></div>${S.settings.api?.warning?`<p class="model-error" role="alert">${esc(S.settings.api.warning)}</p>`:''}${S.modelsError?`<p class="model-error" role="alert">${esc(S.modelsError)}</p>`:''}<form id="settings-form"><fieldset class="settings-fields" ${locked?'disabled':''}><section class="model-block" aria-labelledby="retrieval-model-title"><div class="model-block-head"><h3 id="retrieval-model-title">检索模型</h3><span class="badge neutral">Codex</span></div><div class="model-grid"><label for="search-model">模型<select name="model" id="search-model">${modelOptions(d.model,'Codex 默认')}</select></label>${generationControls('search')}</div></section><section class="model-block" aria-labelledby="reading-model-title"><div class="model-block-head"><h3 id="reading-model-title">阅读助手</h3><label class="provider-select" for="tutor-provider"><span class="sr-only">阅读助手接口</span><select name="tutorProvider" id="tutor-provider"><option value="codex" ${d.tutorProvider==='codex'?'selected':''}>Codex</option><option value="api" ${d.tutorProvider==='api'?'selected':''}>自定义 API</option></select></label></div>${d.tutorProvider==='api'?apiSettingsMarkup():`<div class="model-grid"><label for="tutor-model">讲解与出题模型<select name="tutorModel" id="tutor-model">${modelOptions(d.tutorModel,'沿用检索模型')}</select></label>${generationControls('tutor')}</div><details class="api-config-details" id="api-config-details" ${S.apiConfigOpen?'open':''}><summary>自定义 API</summary>${apiSettingsMarkup()}</details>`}</section><div class="model-footer"><span class="muted" role="status">${S.modelsLoading?'正在获取 Codex 模型…':c.fetchedAt?`${c.models.length} 个 Codex 模型 · ${updated} 获取`:'检索由 Codex 完成'}</span><button type="submit" class="primary">${S.settingsSaving?'保存中…':'保存偏好'}</button></div></fieldset></form><details class="connection-details"><summary>Codex · ${S.connection.authenticated?'已连接':'未连接'}</summary><div class="row wrap advanced"><span class="muted">${esc(S.connection.version||'未检测到 CLI')}</span><button class="ghost small" data-action="check-connection">刷新连接</button><button class="ghost small" data-action="test-connection" ${busy('connection')?'disabled':''}>测试连接</button></div>${S.connection.authenticated?'':'<p class="muted advanced">在终端运行 <code>codex login</code> 后重试。</p>'}</details></section>${memoryPanel()}`;
}

const polling=new Set();
const taskOrigins=new Map();
let articleRequest=0;
const readDrafts=new Map();
function rememberDraft(){if(S.article)readDrafts.set(S.article.id,{compose:S.compose,selection:S.selection,selectionContext:S.selectionContext,assistantTab:S.assistantTab});}
async function runTask(type,params) {
  S.error=''; const origin={nav:S.nav,articleId:S.article?.id||'',wordTab:S.wordTab,deckId:S.deckId||'',request:articleRequest}; const job=await api('/jobs',{type,params});stateRequest++;taskOrigins.set(job.id,origin);S.jobs=[job,...S.jobs.filter(item=>item.id!==job.id)];render();void watchJob(job.id);return job;
}
async function watchJob(id) {
  if(polling.has(id))return; polling.add(id);
  try {
    while(true){
      await new Promise(r=>setTimeout(r,1400)); const job=await api(`/jobs/${id}`); const idx=S.jobs.findIndex(j=>j.id===id); if(idx>=0)S.jobs[idx]=job; else S.jobs.unshift(job);
      if(['queued','running'].includes(job.status)){ if($('#jobs'))$('#jobs').innerHTML=jobsMarkup(); continue; }
      if(job.status==='completed') {
        await refresh(); await handleResult(job); render();
      } else { if(job.status==='failed'){S.error=job.error;toast(job.error);} render(); }
      break;
    }
  } catch(e) { S.error='连接中断。刷新页面后会恢复任务状态。'; render(); }
  finally {polling.delete(id);}
}
async function handleResult(job){
  const r=job.result;
  const origin=taskOrigins.get(job.id),stillHere=origin&&origin.request===articleRequest&&origin.nav===S.nav&&origin.articleId===(S.article?.id||'')&&origin.wordTab===S.wordTab&&(S.nav!=='words'||origin.deckId===(S.deckId||''));
  if(job.type==='directions')toast('推荐方向已更新');
  if(job.type==='curate'){
    if(r.words?.status==='ready'&&S.nav!=='words')S.deckId=r.words.deckId;
    if(r.articles?.status==='ready'&&S.nav==='reading'&&!S.article&&!location.hash.includes('/selection/'))S.articleIds=r.articles.articleIds;
    if(S.nav!=='curate')toast('选材完成，可在选材中心查看');
  }
  if(job.type==='words'){if(stillHere){S.deckId=r.deckId;S.wordTab='find';S.wordSearchOpen=false;wordRoute(r.deckId);}toast(`已找到 ${r.count} 个单词，可在词表中查看`);}
  if(job.type==='articles'){S.articleNote=r.note;if(stillHere){S.articleIds=r.articleIds;history.replaceState(null,'','#reading');}toast('文章已放入阅读书架');}
  if(job.type==='open'){if(stillHere)await loadArticle(r.articleId);else toast('文章原文已保存，可从书架打开');}
  if(['explain','quiz','grade'].includes(job.type)){
    if(S.nav==='reading'&&S.article?.id===r.articleId){
      const request=articleRequest,article=await api(`/articles/${r.articleId}`);
      if(request===articleRequest&&S.nav==='reading'&&S.article?.id===r.articleId){S.article=article;if(job.type!=='explain'){S.assistantTab='quiz';S.quizId=r.quizId;}}
    }
    toast(job.type==='grade'?'理解测试已批改':job.type==='quiz'?'题目已准备好':'讲解已保存');
  }
  if(job.type==='word')toast('已加入生词本');
  if(job.type==='connection')toast(r.ok?'连接正常':r.message);
  taskOrigins.delete(job.id);
}
async function loadArticle(id,{recordVisit=true}={}){rememberDraft();const request=++articleRequest;const article=await api(`/articles/${id}`);if(request!==articleRequest)return;S.article=article;if(recordVisit)void api(`/articles/${id}/visit`,{}).catch(e=>toast(e.message));S.nav='reading';Object.assign(S,{selection:'',selectionContext:'',compose:'',assistantTab:'chat'},readDrafts.get(id)||{});history.replaceState(null,'',`#read/${id}`);render();window.scrollTo(0,0);requestAnimationFrame(()=>{const reader=$('.reader'), target=document.getElementById(`para-${article.paragraph||0}`);if(reader){reader.scrollTop=article.paragraph>0&&target?target.getBoundingClientRect().top-reader.getBoundingClientRect().top+reader.scrollTop-24:0;}window.scrollTo(0,0);});}
async function navigate(nav){rememberDraft();const request=++articleRequest;S.nav=nav;S.error='';if(nav==='reading'){S.article=null;S.articleIds=null;}history.replaceState(null,'',`#${nav}`);render();window.scrollTo(0,0);if(nav==='curate'||nav==='learning'){await refresh();activeJobs().forEach(j=>void watchJob(j.id));if(request===articleRequest&&S.nav===nav)render();}}
function wordRoute(id){articleRequest++;history.replaceState(null,'',`#words/deck/${encodeURIComponent(id)}`);}
function openSelection(id,kind){
  const selection=S.selections.find(item=>item.id===id),part=selection?.[kind];
  if(!part||part.status!=='ready'){toast('这次选材暂无可打开的内容。');return;}
  rememberDraft();articleRequest++;S.error='';
  if(kind==='words'){S.nav='words';S.deckId=part.deckId;S.wordTab='find';S.revealed=false;S.spell='';}
  else{S.nav='reading';S.article=null;S.articleIds=part.articleIds;S.readTab='find';}
  history.replaceState(null,'',`#${S.nav}/selection/${encodeURIComponent(id)}`);render();window.scrollTo(0,0);
}
function showEvidence(text){const paragraphs=[...document.querySelectorAll('[data-paragraph]')];const normalize=t=>t.toLowerCase().replace(/[“”"‘’]/g,'').replace(/\s+/g,' ').trim();const found=paragraphs.find(p=>normalize(p.textContent).includes(normalize(text)));paragraphs.forEach(p=>p.classList.remove('current'));if(found){found.classList.add('current');const reader=$('.reader');reader.scrollTo({top:reader.scrollTop+found.getBoundingClientRect().top-reader.getBoundingClientRect().top-reader.clientHeight/3,behavior:'smooth'});}else toast('这段依据涉及多个段落，请在原文中核对。');}

function updateSettingsDraft(el) {
  if(el.form?.id!=='settings-form')return;
  if(['model','tutorModel','tutorProvider','reasoningEffort','fastMode','tutorReasoningEffort','tutorFastMode'].includes(el.name)){
    const changed=S.settingsDraft[el.name]!==el.value;
    S.settingsDraft[el.name]=el.type==='checkbox'?el.checked:el.value;
    if(changed&&['model','tutorModel'].includes(el.name)&&normalizeCodexDraft())toast('已按新模型恢复不兼容选项');
  }
  const field=el.dataset.apiField;
  if(field){
    const oldEndpoint=apiEndpoint(S.apiDraft.baseUrl),oldModel=S.apiDraft.model;
    S.apiDraft[field]=el.type==='checkbox'?el.checked:el.value;
    S.apiError='';S.apiMessage='';
    if(field==='baseUrl'&&oldEndpoint!==apiEndpoint(el.value)){S.apiDraft.apiKey='';S.apiDraft.reasoningEffort='';S.apiDraft.fastMode=false;S.apiCatalog={models:[],fetchedAt:null};render();}
    if(field==='model'&&oldModel!==el.value){S.apiDraft.reasoningEffort='';S.apiDraft.fastMode=false;}
    if(field==='clearKey'&&el.checked)S.apiDraft.apiKey='';
    if(field==='apiKey'&&el.value)S.apiDraft.clearKey=false;
  }
  if(el.id==='api-model-picker'&&el.value){if(S.apiDraft.model!==el.value){S.apiDraft.reasoningEffort='';S.apiDraft.fastMode=false;}S.apiDraft.model=el.value;S.apiError='';S.apiMessage='';}
}
document.addEventListener('toggle',event=>{if(event.target.id==='api-config-details')S.apiConfigOpen=event.target.open;if(event.target.id==='curation-defaults')S.curationDefaultsOpen=event.target.open;if(event.target.id==='word-search-details'&&event.target.isConnected)S.wordSearchOpen=event.target.open;},true);
function updateWordSearch(el) {
  if(el.id==='word-list-query'){const view=wordBrowse(S.wordTab==='saved'?'saved':'find');view.query=el.value;view.page=1;render();}
  if(el.id==='deck-query'){S.deckLibrary.query=el.value;S.deckLibrary.page=1;renderDeckLibrary();}
}
document.addEventListener('compositionend',event=>updateWordSearch(event.target));
document.addEventListener('input',event=>{
  const el=event.target;
  if(['word-list-query','deck-query'].includes(el.id)){if(!event.isComposing)updateWordSearch(el);return;}
  if(el.dataset.curation){S.curationDraft[el.dataset.curation]=el.value;persistCurationDraft();}
  if(el.dataset.filter){const group=el.dataset.filter;const f=group==='word'?S.wordFilters:S.articleFilters;f[el.name]=el.type==='checkbox'?el.checked:el.value;localStorage.setItem(`between.${group}Filters`,JSON.stringify(f));}
  updateSettingsDraft(el);
  if(el.id==='memory-notes')S.memoryDraft.notes=el.value;
  if(el.id==='memory-recording')S.memoryDraft.recording=el.checked;
  if(el.id==='memory-personalize')S.memoryDraft.personalize=el.checked;
  if(el.id==='compose')S.compose=el.value;
  if(el.id==='spell-input')S.spell=el.value;
  if(el.dataset.answer)S.quizAnswers[el.dataset.answer]=el.value;
  if(el.id==='quiz-count')S.quizCount=el.value;
});
document.addEventListener('change',event=>{const el=event.target;updateSettingsDraft(el);if(el.form?.id==='settings-form')render();
  if(el.id==='word-list-status'||el.id==='word-list-page-size'){const view=wordBrowse(S.wordTab==='saved'?'saved':'find');if(el.id==='word-list-status'&&['all','new','fuzzy','unknown','known'].includes(el.value))view.status=el.value;if(el.id==='word-list-page-size'&&[10,20,50].includes(Number(el.value)))view.size=Number(el.value);view.page=1;render();}
  if(el.id==='reply-language')S.language=el.value;if(el.id==='quiz-type')S.quizType=el.value;if(el.id==='quiz-picker'){S.quizId=el.value;render();}});
document.addEventListener('click',async event=>{
  const paragraph=event.target.closest('[data-paragraph]');if(paragraph&&!window.getSelection()?.toString()){S.selection=paragraph.textContent.slice(0,6000);S.selectionContext=S.selection;$('#selection-area').innerHTML=selectionMarkup();return;}
  const el=event.target.closest('button');if(!el||el.disabled)return;
  try{
    if(el.dataset.nav){if(el.dataset.learningAll==='words')S.wordTab='find';if(el.dataset.learningAll==='reading')S.readTab='find';await navigate(el.dataset.nav);return;}
    if(el.dataset.activityMode){setActivityMode(el.dataset.activityMode);return;}
    if(el.dataset.activityWeek){selectActivityWeek(el.dataset.activityWeek);return;}
    if(el.dataset.activityFilter){S.activityFilter=el.dataset.activityFilter;render();return;}
    if(el.dataset.activityDate){selectActivityDate(el.dataset.activityDate);return;}
    if(el.dataset.wordTab){S.wordTab=el.dataset.wordTab;S.revealed=false;render();return;}
    if(el.dataset.readTab){S.readTab=el.dataset.readTab;render();return;}
    if(el.dataset.assistantTab){S.assistantTab=el.dataset.assistantTab;render();if($('.assistant-body'))$('.assistant-body').scrollTop=0;return;}
    if(el.dataset.mode){S.cardMode=el.dataset.mode;S.revealed=false;S.spell='';render();return;}
    if(el.dataset.evidence){showEvidence(el.dataset.evidence);return;}
    if(el.dataset.prompt){if(el.dataset.prompt.startsWith('请解释选中')&&!S.selection){toast('先在左侧选中你想理解的句子。');return;}S.compose=el.dataset.prompt;render();$('#compose')?.focus();return;}
    if(el.dataset.rating){
      if(S.ratingBusy)return;S.ratingBusy=true;try{
      const d=deck(),w=wordById(d.wordIds[d.progress.index]);el.disabled=true;await api(`/words/${encodeURIComponent(w.id)}`,{rating:el.dataset.rating,mode:S.cardMode});
      await api(`/decks/${d.id}`,{progress:{index:Math.min(d.progress.index+1,d.wordIds.length-1),finished:d.progress.index+1>=d.wordIds.length}});S.revealed=false;S.spell='';await refresh();render();return;}finally{S.ratingBusy=false;}
    }
    const id=el.dataset.id;
    switch(el.dataset.action){
      case'toggle-sidebar':toggleSidebar();break;
      case'open-deck-library':S.deckLibrary={query:'',page:1};$('#deck-query').value='';renderDeckLibrary();$('#deck-dialog').showModal();$('#deck-query').focus();break;
      case'close-deck-library':$('#deck-dialog').close();$('#deck-picker')?.focus();break;
      case'choose-deck':{if(!S.decks.some(d=>d.id===id))break;S.deckId=id;S.revealed=false;S.spell='';resetWordBrowse();$('#deck-dialog').close();wordRoute(id);render();$('#deck-picker')?.focus();break;}
      case'deck-page-prev':case'deck-page-next':S.deckLibrary.page+=el.dataset.action.endsWith('next')?1:-1;renderDeckLibrary();break;
      case'word-page-prev':case'word-page-next':{wordBrowse(S.wordTab==='saved'?'saved':'find').page+=el.dataset.action.endsWith('next')?1:-1;render();$('#word-browser')?.scrollIntoView({block:'start',behavior:'smooth'});break;}
      case'clear-word-query':{const view=wordBrowse(S.wordTab==='saved'?'saved':'find');Object.assign(view,{query:'',status:'all',page:1});render();$('#word-list-query')?.focus();break;}
      case'use-direction':{const direction=S.directions.items.find(item=>item.id===id);if(direction){S.curationDraft.prompt=direction.prompt;S.curationDraft.target=direction.target;persistCurationDraft();render();$('#curation-prompt')?.focus();$('#curation-form')?.scrollIntoView({behavior:'smooth',block:'center'});}break;}
      case'refresh-directions':{if(S.directionsRefreshing||busy('directions'))break;S.directionsRefreshing=true;render();try{await runTask('directions',{level:S.curationDraft.defaultLevel||'B2'});}finally{S.directionsRefreshing=false;render();}break;}
      case'selection-words':openSelection(id,'words');break;
      case'selection-articles':openSelection(id,'articles');break;
      case'refresh-models':{if(settingsBusy())break;S.modelsLoading=true;S.modelsError='';render();try{S.modelCatalog=await api('/models',{});const normalized=normalizeCodexDraft();toast(`已获取 ${S.modelCatalog.models.length} 个模型${normalized?'，不兼容选项已恢复默认':''}`);}catch(error){S.modelsError=error.message;}finally{S.modelsLoading=false;render();}break;}
      case'refresh-api-models':case'test-api':{if(settingsBusy())break;const payload=apiDraftPayload();S.apiAction=el.dataset.action==='refresh-api-models'?'models':'test';S.apiError='';S.apiMessage='';render();try{const result=await api(`/provider/${S.apiAction}`,payload);if(S.apiAction==='models'){S.apiCatalog=result;const normalized=normalizeGenerationDraft(S.apiDraft,selectedApiModel(),'reasoningEffort','fastMode',true);S.apiMessage=`已获取 ${result.models.length} 个模型${normalized?'，不兼容选项已恢复默认':''}`;}else S.apiMessage=result.message||'连接正常。';}catch(error){S.apiError=error.message;}finally{S.apiAction='';render();}break;}
      case'refresh-memory':S.memory=await api('/memory');render();toast('预览已刷新，草稿已保留');break;
      case'reset-memory-draft':S.memory=await api('/memory');S.memoryDraft=null;render();toast('已载入记忆');break;
      case'dismiss-error':S.error='';render();break;
      case'cancel-job':await api(`/jobs/${id}/cancel`,{});await refresh();render();break;
      case'start-study':S.wordTab='study';S.revealed=false;render();break;
      case'reveal':S.revealed=true;render();break;
      case'restart-deck':await api(`/decks/${deck().id}`,{progress:{index:0,finished:false}});S.revealed=false;S.spell='';await refresh();render();break;
      case'save-word':{const w=wordById(id);await api(`/words/${encodeURIComponent(id)}`,{saved:!w.saved});await refresh();render();toast(w.saved?'已移出生词本':'已加入生词本');break;}
      case'remove-word':{const d=deck();await api(`/decks/${d.id}`,{wordIds:d.wordIds.filter(w=>w!==id),progress:{index:0,finished:false}});await refresh();render();break;}
      case'replace-word':await runTask('words',{...deck().filters,deckId:deck().id,replaceWordId:id});break;
      case'study-saved':case'review':{const d=await api('/decks/review',{allSaved:el.dataset.action==='study-saved'});await refresh();S.deckId=d.id;S.nav='words';S.wordTab='study';S.revealed=false;wordRoute(d.id);render();break;}
      case'continue-deck':S.deckId=id;S.nav='words';S.wordTab=deck().progress.finished?'find':'study';S.revealed=false;wordRoute(id);render();break;
      case'open-article':{const a=S.articles.find(a=>a.id===id);if(a.hasText)await loadArticle(id);else await runTask('open',{articleId:id});break;}
      case'save-article':{const a=S.articles.find(a=>a.id===id);await api(`/articles/${id}`,{saved:!a.saved});await refresh();if(S.article?.id===id)S.article.saved=!a.saved;render();break;}
      case'back-library':rememberDraft();articleRequest++;S.article=null;history.replaceState(null,'','#reading');render();window.scrollTo(0,0);break;
      case'clear-selection':S.selection='';S.selectionContext='';$('#selection-area').innerHTML='';break;
      case'explain-selection':await runTask('explain',{articleId:S.article.id,selection:S.selection,context:S.selectionContext,question:'请解释选中内容的意思、语法结构和上下文关系。',language:S.language});break;
      case'save-selection':await runTask('word',{articleId:S.article.id,selection:S.selection,context:S.selectionContext});break;
      case'finish-reading':{const articleId=S.article.id;await api(`/articles/${articleId}`,{completed:true});if(S.article?.id===articleId)S.article.completed=true;await refresh();render();toast('已保存阅读记录');break;}
      case'import':$('#import-dialog').showModal();break;
      case'close-import':$('#import-dialog').close();break;
      case'check-connection':S.connection=await api('/connection',{});render();toast(S.connection.authenticated?'登录状态正常':'请先在终端登录 Codex');break;
      case'test-connection':await runTask('connection',{});break;
    }
  }catch(error){S.error=error.message;toast(error.message);render();}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;
  try{
    if(form.id==='curation-form'){
      if(S.curationSubmitting||busy('curate'))return;
      const params={...S.curationDraft,prompt:S.curationDraft.prompt.trim(),defaultWordCount:Number(S.curationDraft.defaultWordCount),defaultArticleCount:Number(S.curationDraft.defaultArticleCount),defaultLevel:S.curationDraft.defaultLevel||'B2'};
      if(!params.prompt){$('#curation-prompt')?.focus();return;}
      S.curationSubmitting=true;render();try{await runTask('curate',params);}finally{S.curationSubmitting=false;render();}
    }
    if(form.id==='word-search')await runTask('words',S.wordFilters);
    if(form.id==='article-search')await runTask('articles',S.articleFilters);
    if(form.id==='chat-form'){
      if(!S.compose.trim()){toast('写下你的问题，或选择一条快捷提问。');return;}
      const articleId=S.article.id,question=S.compose;
      await runTask('explain',{articleId,selection:S.selection,context:S.selectionContext,question,language:S.language});
      const originalDraft=readDrafts.get(articleId);
      if(originalDraft?.compose===question)readDrafts.set(articleId,{...originalDraft,compose:''});
      if(S.article?.id===articleId&&S.compose===question){S.compose='';if($('#compose'))$('#compose').value='';rememberDraft();}
    }
    if(form.id==='quiz-form')await runTask('quiz',{articleId:S.article.id,selection:S.selection,context:S.selectionContext,count:S.quizCount,questionType:S.quizType,level:S.article.level});
    if(form.id==='grade-form'){const answers=Object.fromEntries(new FormData(form));await runTask('grade',{articleId:S.article.id,quizId:form.dataset.id,answers});}
    if(form.id==='memory-form'){const submit=form.querySelector('[type=submit]');submit.disabled=true;try{const payload=S.memory.revision?S.memoryDraft:{...S.memoryDraft,notes:'',revision:''};S.memory=await api('/memory',payload);if(S.memory.revision)S.memoryDraft=null;if(!S.memory.personalize)S.directions={personalized:false,items:[],note:''};await refresh();render();toast(S.memory.warning||'记忆已保存');}finally{submit.disabled=false;}}
    if(form.id==='settings-form'){if(settingsBusy())return;const values={...S.settingsDraft},provider=apiDraftPayload();if(values.tutorProvider==='api'||provider.baseUrl||provider.model||provider.apiKey||provider.clearKey||S.settings.api?.baseUrl)values.api=provider;S.settingsSaving=true;S.apiError='';render();try{const savedSettings=await api('/settings',values);S.settings=savedSettings;S.apiDraft.apiKey='';S.apiDraft.clearKey=false;await refresh();S.settingsDraft=null;S.apiDraft=null;toast('学习偏好已保存');}catch(error){S.apiError=error.message;toast(error.message);}finally{S.settingsSaving=false;render();}}
    if(form.id==='import-form'){const submit=form.querySelector('[type=submit]');submit.disabled=true;try{const article=await api('/articles/import',Object.fromEntries(new FormData(form)));await refresh();$('#import-dialog').close();form.reset();await loadArticle(article.id);}finally{submit.disabled=false;}}
  }catch(error){S.error=error.message;toast(error.message);render();}
});
document.addEventListener('keydown',event=>{
  const activityWeek=event.target.closest('[data-activity-week]');
  if(activityWeek){
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();const weeks=activityWeeks(),index=weeks.findIndex(w=>w.date===activityWeek.dataset.activityWeek);
      const target=event.key==='Home'?0:event.key==='End'?weeks.length-1:Math.max(0,Math.min(weeks.length-1,index+(event.key==='ArrowLeft'?-1:1)));
      const next=weeks[target];selectActivityWeek(next.date);const button=document.getElementById(`activity-week-${next.date}`);
      button?.focus({preventScroll:true});button?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    if(event.key==='Escape')hideActivityTooltip();
    return;
  }
  const activityDay=event.target.closest('[data-activity-date]');
  if(activityDay){
    if(event.key==='Escape')hideActivityTooltip();
    const steps={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1};
    if(event.key in steps||event.key==='Home'||event.key==='End'){
      event.preventDefault();const c=activityCalendar(),current=activityDay.dataset.activityDate;
      let next=event.key==='Home'?c.start:event.key==='End'?c.today:activityDateOffset(current,steps[event.key]);
      next=next<c.start?c.start:next>c.today?c.today:next;
      selectActivityDate(next);document.getElementById(`activity-${next}`)?.focus({preventScroll:true});
      document.getElementById(`activity-${next}`)?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    return;
  }
  if(event.key==='Enter'&&event.target.matches('[data-paragraph]')){event.preventDefault();event.target.click();return;}
  if(event.target.closest('#sidebar-toggle'))return;
  if(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||$('#import-dialog').open||$('#deck-dialog').open)return;
  if(S.nav==='words'&&S.wordTab==='study'){
    if(event.code==='Space') {event.preventDefault();$('[data-action=reveal]')?.click();}
    if(S.revealed&&['1','2','3'].includes(event.key)){event.preventDefault();document.querySelectorAll('[data-rating]')[Number(event.key)-1]?.click();}
  }
});
function captureSelection(){const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;const container=$('#article-text');if(!container?.contains(selection.anchorNode)||!container.contains(selection.focusNode))return;const text=selection.toString().trim();if(text.length>6000){toast('选中的内容较长，请缩小到 6000 字符以内。');return;}if(text&&S.article?.text.includes(text)){S.selection=text;const parent=selection.anchorNode?.nodeType===1?selection.anchorNode:selection.anchorNode?.parentElement;const context=parent?.closest('[data-paragraph]')?.textContent;S.selectionContext=context?.includes(text)&&context.length<=6000?context:text;$('#selection-area').innerHTML=selectionMarkup();}}
document.addEventListener('pointerup',()=>setTimeout(captureSelection,0));document.addEventListener('keyup',captureSelection);
let progressTimer, observer;
function observeReading(){
  observer?.disconnect();const reader=$('.reader');if(!reader||!S.article)return;
  const articleId=S.article.id;
  observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>Number(a.target.dataset.paragraph)-Number(b.target.dataset.paragraph));if(!visible.length)return;const paragraph=Number(visible[0].target.dataset.paragraph);clearTimeout(progressTimer);progressTimer=setTimeout(()=>{void api(`/articles/${articleId}`,{paragraph}).catch(()=>{});},750);},{root:reader,rootMargin:'-10% 0px -65% 0px',threshold:0});
  document.querySelectorAll('[data-paragraph]').forEach(p=>observer.observe(p));
}
async function boot(){
  try{
    Object.assign(S,await api('/bootstrap'));S.deckId=S.settings.lastDeck;
    // Preserve the old default once; each learning page owns its difficulty from here.
    if(!levels.includes(S.curationDraft.defaultLevel)){S.curationDraft.defaultLevel=levels.includes(S.settings.defaultLevel)?S.settings.defaultLevel:'B2';persistCurationDraft();}
    const hash=location.hash.slice(1),selectionRoute=hash.match(/^(words|reading)\/selection\/([^/]+)$/),deckRoute=hash.match(/^words\/deck\/([^/]+)$/);
    if(selectionRoute){const id=decodeURIComponent(selectionRoute[2]);S.nav=selectionRoute[1];if(S.selections.some(item=>item.id===id))openSelection(id,S.nav==='words'?'words':'articles');}
    else if(deckRoute){const id=decodeURIComponent(deckRoute[1]);S.nav='words';if(S.decks.some(item=>item.id===id))S.deckId=id;}
    else if(hash.startsWith('read/'))await loadArticle(hash.slice(5),{recordVisit:false});else if(['curate','words','reading','learning','settings'].includes(hash))S.nav=hash;
    render();activeJobs().forEach(j=>void watchJob(j.id));
    const context=document.modelContext;
    try { if(context?.registerTool){
      const controller=new AbortController();window.addEventListener('pagehide',()=>controller.abort(),{once:true});
      await context.registerTool({name:'get_learning_summary',description:'Read counts of saved English words, due reviews, and articles from the visible learning app.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>{await refresh();render();return{words:S.words.length,due:due().length,articles:S.articles.length};}},{signal:controller.signal});
      await context.registerTool({name:'open_saved_article',description:'Open an already downloaded article in the reading workspace. Does not search or call a model.',inputSchema:{type:'object',properties:{articleId:{type:'string'}},required:['articleId'],additionalProperties:false},annotations:{readOnlyHint:false},execute:async(input)=>{if(typeof input?.articleId!=='string'||!S.articles.some(a=>a.id===input.articleId&&a.hasText))throw new Error('Choose an existing downloaded article.');await loadArticle(input.articleId);return{articleId:S.article.id,title:S.article.title};}},{signal:controller.signal});
    } } catch { /* Optional browser tools must not block the learning app. */ }
  }catch(error){$('#app').innerHTML=`<div class="boot"><span class="brand-icon">b.</span><h2>学习空间暂时没有连接</h2><p>${esc(error.message)}</p><button id="retry-boot">重新连接</button></div>`;$('#retry-boot').onclick=boot;}
}
void boot();
