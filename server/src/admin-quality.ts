import {createHash} from 'node:crypto';
import {REPORT_STYLE} from './admin-reports.ts';
import {SCREEN_QUERY_VERSION} from './screen-query.ts';
export const QUALITY_SCRIPT=String.raw`
(() => {
  'use strict';
  const $=id=>document.getElementById(id),node=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(parent)parent.append(e);return e;};
  const profiles={spi:'SPI',reading_practice:'阅读练习',general:'通用',legacy_objective:'历史客观题（未声明 profile）'};
  const kinds={single_choice:'单选',multiple_choice:'多选',ordering:'排序',short_fill:'短填空',other:'其他 / 范围挑战'};
  const labels={protocol_valid:'协议合法率',answerable_accuracy:'可作答整体精确率',strict_usable_precision:'V1 可用答案精确率',legacy_fallback_precision:'Fallback 精确率',declared_scope_coverage:'声明范围覆盖率',strict_scope_coverage:'V1 范围覆盖率',ready_precision:'Ready 精确率',retake_recall:'Retake 召回率',out_of_scope_recognition:'范围外识别',multiple_target_recognition:'多目标识别'};
  const gaps={labels_reviewed:'真值尚未复核',results_reviewed:'输出尚未复核',complete_run:'未确认完整运行',no_selection_reruns:'未确认无挑选重跑',authorized_materials:'材料授权尚未确认',review_does_not_bind_scored_case_bytes:'原复核仅绑定摘要，未绑定逐题文件字节',not_new_scope_holdout:'不是新增范围留出集',not_screen_query_contract:'未使用新题组合约',family_split_evidence_missing:'缺少题目家族隔离证据',holdout_below_400:'新增范围少于 400 个已记录样本',no_declared_combinations:'没有声明支持组合',unlabelled_cases:'包含未标注项目'};
  function rate(value){
    if(!value||!value.denominator)return '—（0 分母）';
    if(value.rate===null)return '未知 · 已确认 '+value.numerator+'/'+value.denominator+' · 未标注 '+value.unlabelled;
    const ci=value.confidence_interval_95;return (value.rate*100).toFixed(2)+'% · '+value.numerator+'/'+value.denominator+(ci?' · 95% CI '+(ci.lower*100).toFixed(1)+'–'+(ci.upper*100).toFixed(1)+'%':'')+(value.denominator<50?' · 小样本':'');
  }
  function table(parent,headers,rows){const wrap=node('div',undefined,parent);wrap.className='table-scroll';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',headers[0]+'质量表，可横向滚动');
    const t=node('table',undefined,wrap),head=node('tr',undefined,node('thead',undefined,t));for(const h of headers){const th=node('th',h,head);th.scope='col';}
    const body=node('tbody',undefined,t);for(const row of rows){const tr=node('tr',undefined,body);for(const value of row)node('td',value,tr);}}
  const message=(text,error=false)=>{$('quality-status').textContent=text;$('quality-status').className=error?'error':'muted';};
  let generation=0,cursor=null,controller=null;
  function invalidate(){generation++;controller?.abort();controller=null;cursor=null;$('quality-results').replaceChildren();$('next-quality').hidden=true;$('load-quality').disabled=false;message('筛选已变更，请加载质量记录。');}
  const filters=()=>Object.fromEntries(['profile','kind','language','contract','scope_version'].flatMap(key=>$(key).value?[[key,$(key).value]]:[]));
  function render(record,query){
    const report=record.report,run=report.run,card=node('section',undefined,$('quality-results'));card.className='metadata';
    const title={thresholds_met:'已测点估计达到阈值',thresholds_failed:'部分阈值未通过',insufficient_evidence:'证据不足'}[report.assessment];
    node('h2',record.withdrawal?'已撤回 · '+run.id:title+' · '+run.id,card);
    if(record.withdrawal)node('p','撤回原因：'+record.withdrawal.reason+' · '+record.withdrawal.recorded_at+' · 审计引用 '+record.withdrawal.reference,card).className='error';
    node('p','数据用途：'+{legacy_regression:'历史回归',holdout:'留出集',diagnostic:'诊断'}[run.dataset_role]+' · '+run.dataset_id+' · '+run.contract+' / '+run.scope_version,card);
    node('p','模型 '+run.model+' · App '+run.app_version+' · 提交 '+run.commit,card);
    node('p','评测窗口：'+(run.started_at??'开始时间未记录')+' → '+run.finished_at+' · 定义 '+report.definition_version+' · 归档修订 '+record.revision,card);
    node('p','已记录 '+report.execution.recorded_cases+' / 计划 '+report.execution.expected_cases+' 题 · 缺失 '+report.execution.missing_cases+' 题 · 真值未标注 '+report.overall.unlabelled+' 题',card);
    node('p','执行者 '+run.executor+' · 复核声明 '+report.review.reviewer+' / '+report.review.reviewed_at+' · 家族数 '+(report.overall.families??'未知'),card).className='muted';
    node('p','这是管理员录入的复核声明；摘要验证完整性，不证明签署人的身份。点估计和历史回归均不自动放行当前候选。',card).className='muted';
    const cells=report.cells.filter(c=>(!query.profile||c.profile===query.profile)&&(!query.kind||c.kind===query.kind)&&(!query.language||c.language===query.language));
    node('h3','Profile × 题型 × 语言',card);
    table(card,['Profile','题型 / 语言','范围','样本 / 未标注','V1 可用答案精确率','声明范围覆盖率','Ready 精确率','Retake 召回率'],cells.map(c=>[profiles[c.profile],kinds[c.kind]+' / '+c.language,c.declared?'已声明':'未声明',c.samples+' / '+c.unlabelled,rate(c.strict_usable_precision),rate(c.declared_scope_coverage),rate(c.ready_precision),rate(c.retake_recall)]));
    table(card,['组合','Fallback 精确率','范围外识别','多目标识别','V1 范围覆盖率'],cells.map(c=>[profiles[c.profile]+' · '+kinds[c.kind]+' / '+c.language,rate(c.legacy_fallback_precision),rate(c.out_of_scope_recognition),rate(c.multiple_target_recognition),rate(c.strict_scope_coverage)]));
    node('p','范围覆盖使用独立标注为完整且可作答的声明范围样本；未标注项单列。Fallback 与 V1 精确率分开。下方汇总覆盖整次评测，表格筛选不会改写运行级阈值。',card).className='muted';
    const details=node('details',undefined,card);node('summary','完整运行的指标、风险阻断和证据摘要',details);
    table(details,['指标','分子 / 分母及区间'],Object.entries(labels).map(([key,label])=>[label,rate(report.overall[key])]));
    table(details,['风险标签','正确阻断 / 风险题数'],Object.entries(report.overall.risk_blocking).map(([key,value])=>[key,rate(value)]));
    const latency=report.overall.request_latency_ms,tokens=report.overall.tokens;
    table(details,['HTTP 请求 p50 / p95（ms）','计时缺失','平均 token','Token 缺失'],[[(latency.p50??'未知')+' / '+(latency.p95??'未知'),latency.missing,tokens.mean===null?'未知':tokens.mean.toFixed(2),tokens.missing]]);
    node('p','这里的耗时是隔离评测 HTTP 请求时间；用户框选、补材料和重试的完整任务耗时须另行观察。',details).className='muted';
    table(details,['阈值','最低值','本次测量','结论'],report.thresholds.map(t=>[labels[t.name]??t.name,(t.minimum*100).toFixed(0)+'%',rate(t.rate),{met:'已达点估计',failed:'未达到',missing:'缺少测量'}[t.status]]));
    node('h3','新增范围证据缺口',details);
    if(report.new_scope_sample_counts)node('p','非 SPI 已声明客观题组合中的已标注样本：'+report.new_scope_sample_counts.samples+'；SPI、未声明组合、未标注项和其他范围挑战不补足 400 / 每题型 100 的样本要求。',details);
    if(!report.evidence_gaps.length)node('p','此记录的输入检查未发现缺口；仍须匹配准确候选、固定基线比较、解释评测及软件/灰度闸门。',details);
    else{const list=node('ul',undefined,details);for(const gap of report.evidence_gaps)node('li',gaps[gap]??gap.replace('kind_below_100:','该题型少于 100 样本：').replace('combination_below_50:','该组合已标注样本少于 50：'),list);}
    node('p','报告 SHA-256：'+record.id,details);node('p','数据集 SHA-256：'+run.dataset_sha256,details);node('p','结果文件 SHA-256：'+run.results_sha256,details);node('p','原始复核文件 SHA-256：'+report.review.attestation_sha256,details);
    const download=node('button','下载此质量记录',card);download.type='button';download.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));const a=node('a',undefined,document.body);a.href=url;a.download='quality-'+record.id+'.json';a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  }
  async function load(append=false){
    const key=$('quality-key').value.trim();if(!key){message('请输入管理员密钥。',true);return;}
    const query=filters(),ticket=++generation;controller?.abort();controller=new AbortController();$('load-quality').disabled=true;$('next-quality').disabled=true;
    if(!append){cursor=null;$('quality-results').replaceChildren();}message('正在读取独立质量记录…');
    try{const params=new URLSearchParams({...query,limit:'10',...($('include_history').checked?{include_history:'true'}:{}),...(append&&cursor?{before_revision:cursor}:{})});
      const response=await fetch('/admin/quality?'+params,{cache:'no-store',headers:{'x-admin-token':key},signal:controller.signal});const data=await response.json();if(ticket!==generation)return;
      if(!response.ok)throw new Error(data.error?.message||'读取失败');for(const record of data.items)render(record,query);cursor=data.next_revision;$('next-quality').hidden=!cursor;
      if(!append&&!data.items.length)node('p','尚无与当前版本和筛选匹配的独立评测记录。不会用历史数据或产品事件代替当前候选质量。',$('quality-results')).className='empty';
      message('读取完成。'+($('include_history').checked?'包含历史修订。':'每次执行仅展示最新评分修订；已撤回的新版本不会回退到旧评分。'));
    }catch(error){if(ticket===generation)message(error.message,true);}finally{if(ticket===generation){$('load-quality').disabled=false;$('next-quality').disabled=false;}}
  }
  $('quality-key').addEventListener('input',invalidate);$('quality-filters').addEventListener('input',invalidate);
  $('quality-filters').addEventListener('submit',event=>{event.preventDefault();load();});$('next-quality').addEventListener('click',()=>load(true));
  $('history-reference').addEventListener('click',()=>{$('contract').value='objective_v1';$('scope_version').value='';$('profile').value='legacy_objective';$('kind').value='';$('language').value='';invalidate();load();});
})();`;
export const QUALITY_PAGE_CSP="default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-"+createHash('sha256').update(QUALITY_SCRIPT).digest('base64')+"'";
export function renderQualityPage():string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>NotchSPI · 独立质量评测</title><style>${REPORT_STYLE}
summary{cursor:pointer;margin:20px 0;font-weight:600}details{border-top:1px solid var(--line);margin:20px 0}.check{display:flex;flex-direction:row;align-items:center;margin-top:18px}.check input{width:auto}section button{margin-top:12px}</style></head>
<body><main><a href="/admin/reports">← 批次与经济报告</a><h1>独立质量评测</h1><p class="muted">按实际评测的合约、模型与提交读取真值结果。此页与设备批次、产品事件的分母分别计算。</p>
<label class="key">管理员密钥<input id="quality-key" type="password" autocomplete="off" spellcheck="false"></label><p class="muted">密钥仅在当前页面使用。</p>
<form id="quality-filters" class="card"><div class="grid">
<label>合约<select id="contract"><option value="screen_query_v1">新题组合约</option><option value="objective_v1">旧 Objective V1</option><option value="">全部合约</option></select></label>
<label>范围 / Prompt 版本<input id="scope_version" value="${SCREEN_QUERY_VERSION}" maxlength="100" placeholder="全部版本"></label>
<label>Profile<select id="profile"><option value="">全部 profile</option><option value="spi">SPI</option><option value="reading_practice">阅读练习</option><option value="general">通用</option><option value="legacy_objective">历史客观题（未声明 profile）</option></select></label>
<label>题型<select id="kind"><option value="">全部题型</option><option value="single_choice">单选</option><option value="multiple_choice">多选</option><option value="ordering">排序</option><option value="short_fill">短填空</option><option value="other">其他 / 范围挑战</option></select></label>
<label>语言<select id="language"><option value="">全部语言</option><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option></select></label></div>
<label class="check"><input id="include_history" type="checkbox">包含历史评分修订</label><div class="actions"><button id="load-quality" class="primary" type="submit">加载质量记录</button><button id="history-reference" type="button">查看历史客观题参考</button></div></form>
<p id="quality-status" role="status" aria-live="polite" class="muted">当前默认筛选新题组合约版本。没有评测记录时保持空值。</p><div id="quality-results"></div><button id="next-quality" type="button" hidden>下一页质量记录</button></main><script>${QUALITY_SCRIPT}</script></body></html>`;
}
