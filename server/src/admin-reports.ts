import { createHash } from 'node:crypto';

// Static application code only. Report values are rendered with textContent, never HTML.
export const REPORT_SCRIPT=String.raw`
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const sources={spi_entry:'SPI 入口',reading_practice_entry:'阅读练习入口',direct:'直接访问',unknown:'未知来源'};
  const channels={official:'官方服务',custom_key:'自有 Key',cli:'CLI',mixed:'混合通道'};
  const node=(tag,text,parent)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(parent)parent.append(e);return e;};
  const table=(parent,headers,rows)=>{const wrap=node('div',undefined,parent);wrap.className='table-scroll';const t=node('table',undefined,wrap);
    wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',headers[0]+'数据表，可横向滚动');
    const head=node('tr',undefined,node('thead',undefined,t));headers.forEach(h=>{const th=node('th',h,head);th.scope='col';});
    const body=node('tbody',undefined,t);rows.forEach(row=>{const tr=node('tr',undefined,body);row.forEach(v=>node('td',v,tr));});return body;};
  function rate(value){
    if(!value||value.denominator===0)return '—（0 分母）';
    const interval=value.confidence_interval_95;
    return (value.rate*100).toFixed(1)+'% · '+value.numerator+'/'+value.denominator+
      (interval?' · 95% CI '+(interval.lower*100).toFixed(1)+'–'+(interval.upper*100).toFixed(1)+'%':'')+
      (value.denominator<50?' · 小样本，判断不确定':'');
  }
  function fraction(value,scale=1000000n){
    if(value===null||value===undefined)return '未知';
    const n=BigInt(typeof value==='object'?value.numerator:value),d=BigInt(typeof value==='object'?value.denominator:1)*scale;
    if(d===0n)return '未知';const sign=n<0n?'-':'',abs=n<0n?-n:n,whole=abs/d,tail=(abs%d*1000000n/d).toString().padStart(6,'0').replace(/0+$/,'');
    return (abs%d*1000000n%d!==0n?'≈ ':'')+sign+whole+(tail?'.'+tail:'');
  }
  const when=s=>s.replace('T',' ').replace('Z',' UTC');
  const windowText=q=>'注册 ['+when(q.cohort_from)+', '+when(q.cohort_to)+') · 观察截至 '+when(q.as_of);
  let current=null,currentDigest=null,currentArchive=null,generation=0,archiveCursor=null,archiveGeneration=0;
  const pending=new Set();
  function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':'muted';}
  function invalidated(){generation++;for(const c of pending)c.abort();pending.clear();current=null;currentDigest=null;currentArchive=null;
    $('results').hidden=true;$('load').disabled=false;$('save').disabled=true;$('download').disabled=true;status('筛选已变更，请加载报表。');}
  async function request(url,body){
    const key=$('admin-key').value.trim();if(!key)throw new Error('请输入管理员密钥。');
    const controller=new AbortController();pending.add(controller);
    try{const response=await fetch(url,{method:body?'POST':'GET',cache:'no-store',signal:controller.signal,
      headers:{'x-admin-token':key,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'请求失败（'+response.status+'）');return data;
    }finally{pending.delete(controller);}
  }
  const query=()=>Object.fromEntries(['cohort_from','cohort_to','as_of','source','policy_version','profile','channel'].flatMap(key=>{
    const value=$(key).value.trim();return value?[[key,key==='as_of'?new Date(value+'Z').toISOString():value]]:[];}));
  function render(report,archive=null){
    current=report;currentArchive=archive;$('results').hidden=false;$('download').disabled=false;$('save').disabled=!!archive;
    $('report-window').textContent=windowText(report.query);
    $('report-dimensions').textContent='来源：'+(sources[report.query.source]??'全部')+' · 政策：'+(report.query.policy_version??'全部')+
      ' · profile：'+(report.query.profile??'全部')+' · 通道：'+(channels[report.query.channel]??'分别展示');
    $('definition').textContent='定义 '+report.definition_version+' · 事实修订 '+report.revision;
    $('report-state').textContent=archive?'已保存的不可变快照 · '+when(archive.created_at):'实时读取 · 尚未保存';
    $('integrity').textContent='内容 SHA-256：'+currentDigest;
    const c=report.cohort;
    $('counts').textContent='注册 '+c.registered+' 台 · 成熟 '+c.mature_registered+' 台 · 未成熟 '+c.immature_registered+' 台 · 内部排除 '+c.internally_excluded+' 台';
    const maturity=$('maturity');maturity.replaceChildren();
    table(maturity,['通道','R28 成熟','完整观察','部分观察','未知','共享关闭','未成熟','已过 7 天等待期'],c.channels.map(row=>{
      const r=row.repeat28,b=r.coverage;return [channels[row.channel],b.mature_total,b.observed_complete,b.partial,b.unknown,b.telemetry_disabled,r.immature,r.frozen.denominator];}));
    node('p','R28 从首次成功起计 28 天；首次成功之前也须有完整覆盖。未知和共享关闭不计作流失。已过等待期的子集仍需保存快照供长期复核。',maturity).className='muted';
    table(maturity,['通道','A28 确认下界','仅完整观察 A28','未确认激活且观察不足','R28 完整观察读数','等待期已过的 R28'],c.channels.map(row=>[
      channels[row.channel],rate(row.activation28),rate(row.activation28.observed_only),row.activation28.unknown_without_confirmed_activation,rate(row.repeat28),rate(row.repeat28.frozen)]));
    node('p','A28/P28 分母为全部成熟注册设备；身份单位为设备。所有比例都使用上方 UTC 批次与截至时间；95% CI 为 Wilson 区间，小样本提示阈值为 50 台。',maturity).className='muted';
    table(maturity,['P28','全额退款设备','确认拒付损失设备','付款状态未知设备','服务端结算激活（单列）'],[[rate(c.p28),c.p28.fully_refunded_devices,c.p28.dispute_loss_devices,c.p28.unknown_payment_devices,rate(c.operational_activation28)]]);
    const trial=c.post_trial_exhaustion;
    table(maturity,['试用耗尽 / 全部注册','耗尽后付款 / 耗尽设备','试用来源未知','耗尽后跟进时长（秒：最短 / 中位 / 最长）'],[[rate(trial.exhausted),rate(trial.paid_after_exhaustion),trial.unknown_trial_origin,
      [trial.followup_seconds.minimum,trial.followup_seconds.median,trial.followup_seconds.maximum].map(v=>v===null?'未知':String(v)).join(' / ')]]);
    const comparison=$('comparison');comparison.replaceChildren();
    table(comparison,['来源','通道','注册 / 成熟','A28 确认下界','R28 完整观察','P28','R28 未完整观察'],report.by_source.flatMap(s=>s.cohort.channels.map(row=>[
      sources[s.source],channels[row.channel],s.cohort.registered+' / '+s.cohort.mature_registered,rate(row.activation28),rate(row.repeat28),rate(s.cohort.p28),
      row.repeat28.coverage.mature_total-row.repeat28.coverage.observed_complete])));
    node('p','来源与政策筛选注册设备；profile 与通道只筛选客户端 solve 结果。P28 在各通道行重复展示同一设备批次，不能跨行相加。未知来源保留在分母。',comparison).className='muted';
    const economic=$('economic');economic.replaceChildren();const e=report.economics;
    node('p','经济口径：'+windowText(e.query)+'；'+e.registered+' 个注册设备、'+e.client_usable_official_deliveries+' 次客户端可用官方 solve。profile 与通道筛选不裁剪成本或财务分母。',economic).className='muted';
    if(e.finance_reconciliation){const f=e.finance_reconciliation;node('h3','支付资源核对覆盖',economic);
      table(economic,['已读取资源的订单 / 全部订单','新通知待重核','退款账本待同步','拒付结果未明确'],[[f.with_resource_snapshot+' / '+f.orders,f.pending_new_notices,f.refund_ledger_mismatch,f.unknown_dispute_outcomes]]);
      node('p','最近一次资源读取：'+(f.latest_checked_at?when(f.latest_checked_at):'尚未读取')+'。费用按唯一余额交易核对，拒付本金与费用分别计算；未知状态或缺少换汇依据时不计算完整贡献。资源快照是当时的核对结果。',economic).className='muted';
    }else node('p','此历史快照没有支付资源核对覆盖读数。',economic).className='muted';
    if(e.unallocated_receipts){
      const pending=e.unallocated_receipts;node('h3','已付款但尚未归入订单',economic);
      node('p','按收到已签名收据的 UTC 时间：'+when(pending.received_from)+' 至 '+when(pending.received_through)+'。同一 Checkout / PaymentIntent 去重；已入账款项排除，不能把下列金额再加到订单收款。',economic).className='muted';
      for(const [label,row] of [['本批次已识别设备，待入账',pending.cohort_uncredited],['账户级身份未分配，不能归入当前批次',pending.account_unassigned]]){
        node('h4',label,economic);
        table(economic,['待核对付款组','签名事件投递数','财务/归属冲突','信息不完整','旧投递时间未核验','币种未知'],[[row.payment_groups,row.receipt_deliveries,row.conflicts,row.incomplete,row.legacy_timing_unknown_groups,row.unknown_currency_groups]]);
        table(economic,['币种','无冲突已确认毛收款（最小单位）','仍未明确的付款组','净收款'],row.currencies.map(c=>[c.currency,c.confirmed_gross_minor,c.unresolved_groups,'未知']));
      }
      node('p','尚未核验这些款项的退款、费用及最终归属，净额保持未知；可能影响该币种的待分配收据会阻止计算贡献。其他注册设备另有 '+pending.other_registered_devices_pending+' 组待核对，已入账排除 '+pending.credited_groups_excluded+' 组。',economic).className='muted';
    }else node('p','此历史快照没有待分配收据读数，不能据此断言为零。',economic).className='muted';
    table(economic,['未用已购题数','其中持有','已撤回','未用试用题数','历史来源不明的已购题数区间'],[[e.paid_questions.remaining,e.paid_questions.held,e.paid_questions.revoked,e.unused_trial_questions,
      e.legacy_unknown_questions.lower_paid+'–'+(e.legacy_unknown_questions.upper_paid??'未知')]]);
    node('p','历史消耗样本：'+e.paid_questions.mature_lots+' 个成熟 paid lot / '+e.paid_questions.mature_devices+' 台设备，已消耗 '+e.paid_questions.observed_consumed+' / 授予 '+e.paid_questions.observed_granted+' 题。描述性比例不代表未来使用概率。',economic).className='muted';
    if(!e.currencies.length)node('p','没有已记录的收款、推理或分摊费用。成本与利润不能据此判为零。',economic).className='empty';
    for(const row of e.currencies){
      const currency=row.currency??'币种未知';node('h3',currency,economic);
      const cash=row.cash_minor,inf=row.inference_micros;
      table(economic,['确认收款（最小单位）','成功退款（最小单位）','确认拒付损失（最小单位）','净收款（最小单位）','支付费用（最小单位）'],[[cash.confirmed,cash.succeeded_refunds??'未知',cash.confirmed_dispute_losses,cash.net??'未知',cash.payment_fees_total??'未知']]);
      node('p','成功退款已知小计 '+cash.succeeded_refunds_known_subtotal+'；支付费用已知小计 '+cash.payment_fees_known+'；'+cash.orders_missing_fee_data+' 笔订单缺手续费数据。以上均为 '+currency+' 最小单位。',economic).className='muted';
      if(cash.foreign_orders_with_incomplete_fees)node('p','另有 '+cash.foreign_orders_with_incomplete_fees+' 笔其他收款币种订单在本币种的费用尚未核对完整。',economic).className='muted';
      table(economic,['全部模型尝试','未知成本 / 已记录尝试','已知成本小计','推理总成本','保守上界','每次可用 solve 成本'],[[inf.attempts,inf.unknown_count+' / '+inf.attempts,
        fraction(inf.known_subtotal),fraction(inf.total),fraction(inf.conservative_upper),fraction(inf.cost_per_client_usable_solve)]]);
      node('p','推理和履约金额单位：'+currency+'，小数显示至六位；≈ 表示截断显示，下载保留精确整数/分数。上界来自已配置尝试预算，未知成本不会并入零成本。计价版本：'+(inf.pricing_versions.join(', ')||'暂无')+'。',economic).className='muted';
      const purposes={answer:'主答案',explain:'解释',recover:'恢复',upgrade:'升级',retry:'重试',legacy_usage_without_currency:'旧使用记录（币种未知）'};
      node('p','已记录尝试用途：'+(Object.entries(inf.by_purpose).map(([key,count])=>(purposes[key]??key)+' '+count).join('；')||'暂无')+
        (inf.historical_attempt_coverage==='incomplete_pre_ledger_history'?'。历史账本之前的尝试记录不完整，总成本和上界保持未知。':''),economic).className='muted';
      const chart=node('div',undefined,economic);chart.className='chart';chart.setAttribute('aria-label',currency+' 未用已购额度的未来推理成本区间');
      const bounds=row.paid_liability_scenarios.flatMap(s=>[s.future_inference_cost_micros.lower,s.future_inference_cost_micros.upper]).filter(Boolean);
      const max=bounds.reduce((a,b)=>BigInt(b.numerator)*BigInt(a.denominator)>BigInt(a.numerator)*BigInt(b.denominator)?b:a,{numerator:'0',denominator:'1'});
      for(const s of row.paid_liability_scenarios){
        const label={zero_use:'0% 使用',observed_consumption:'按历史消耗比例',full_use:'100% 使用'}[s.name];
        const line=node('div',undefined,chart);line.className='scenario';const range=s.future_inference_cost_micros;
        node('strong',label,line);node('span',fraction(range.lower)+' – '+fraction(range.upper)+' '+currency,line);
        const track=node('div',undefined,line);track.className='track';track.setAttribute('aria-hidden','true');
        const width=v=>v&&BigInt(max.numerator)>0n?Number(BigInt(v.numerator)*BigInt(max.denominator)*10000n/(BigInt(v.denominator)*BigInt(max.numerator)))/100:0;
        const band=node('div',undefined,track);band.className='band'+(range.upper===null?' unknown':'');band.style.width=range.upper===null?'100%':width(range.upper)+'%';
        const low=node('div',undefined,track);low.className='low';low.style.width=width(range.lower)+'%';
      }
      table(economic,['履约场景','每注册设备贡献','扣获客后每设备贡献'],row.paid_liability_scenarios.map(s=>[
        {zero_use:'0% 使用',observed_consumption:'按历史消耗比例',full_use:'100% 使用'}[s.name],fraction(s.contribution_per_registered_device_micros),fraction(s.contribution_after_acquisition_micros)]));
      table(economic,['分摊服务支出','获客支出','未知输入'],[[fraction(row.allocated_service_expenses_micros),fraction(row.acquisition_expenses_micros),row.incomplete_inputs.join(', ')||'无']]);
    }
    node('p','各币种分别报告，不做隐式换汇。退款已在净收款中扣除一次。未用试用额度单列，不算已购负债；历史余额保留不确定区间。本页为运营贡献估计。',economic).className='muted';
  }
  $('filters').addEventListener('input',invalidated);
  $('admin-key').addEventListener('input',()=>{invalidated();archiveGeneration++;archiveCursor=null;$('archive-list').replaceChildren();$('archives').disabled=false;$('more').hidden=true;});
  $('filters').addEventListener('submit',async event=>{
    event.preventDefault();invalidated();const ticket=generation;$('load').disabled=true;status('正在读取同一时点的批次与账本…');
    try{const data=await request('/admin/reports/data?'+new URLSearchParams(query()));if(ticket!==generation)return;
      currentDigest=data.payload_sha256;render(data.report);status('读取完成。保存后可在明细过期后按此版本查回。');
    }catch(error){if(ticket===generation)status(error.message,true);}finally{if(ticket===generation)$('load').disabled=false;}
  });
  $('save').addEventListener('click',async()=>{
    if(!current||!currentDigest||currentArchive)return;const ticket=generation;$('save').disabled=true;
    try{const archive=await request('/admin/reports/archive',{query:current.query,expected_payload_sha256:currentDigest});if(ticket!==generation)return;
      render(archive.report,archive);status('已保存不可变快照。归档 ID：'+archive.id);
    }catch(error){if(ticket===generation){status(error.message,true);$('save').disabled=false;}}
  });
  $('download').addEventListener('click',()=>{
    if(!current)return;const blob=new Blob([JSON.stringify(currentArchive??{report:current,payload_sha256:currentDigest,status:'unsaved_read'},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=node('a',undefined,document.body);a.href=url;a.download='notchspi-report-'+currentDigest+'.json';a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  async function listArchives(append=false){
    const ticket=++archiveGeneration,authGeneration=generation;$('archives').disabled=true;$('more').disabled=true;
    if(!append){archiveCursor=null;$('archive-list').replaceChildren();}
    try{const page=await request('/admin/reports/archives?limit=10'+(append&&archiveCursor?'&cursor='+encodeURIComponent(archiveCursor):''));
      if(ticket!==archiveGeneration||authGeneration!==generation)return;
      if(!page.items.length&&!append)node('p','暂无已保存归档。',$('archive-list')).className='empty';
      for(const item of page.items){const row=node('div',undefined,$('archive-list'));row.className='archive-row';
        node('p',when(item.created_at)+' · '+windowText(item.query),row);node('small',item.definition_version+' · SHA-256 '+item.id,row);
        const button=node('button','读取 '+item.id.slice(0,12),row);button.type='button';button.addEventListener('click',async()=>{
          const ticket=++generation;current=null;$('save').disabled=true;$('download').disabled=true;button.disabled=true;
          try{const archive=await request('/admin/reports/archives/'+item.id);if(ticket!==generation)return;currentDigest=archive.payload_sha256;
            render(archive.report,archive);status('已读取已保存快照；上方输入框仅用于下一次实时查询，当前展示窗口以报告抬头为准。');
          }catch(error){if(ticket===generation)status(error.message,true);}finally{button.disabled=false;}
        });
      }
      archiveCursor=page.next_cursor;$('more').hidden=!archiveCursor;
    }catch(error){if(ticket===archiveGeneration&&authGeneration===generation)status(error.message,true);}
    finally{if(ticket===archiveGeneration){$('archives').disabled=false;$('more').disabled=false;}}
  }
  $('archives').addEventListener('click',()=>listArchives());$('more').addEventListener('click',()=>listArchives(true));
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    document.querySelectorAll('[data-panel]').forEach(panel=>panel.hidden=panel.id!==button.dataset.view);
  }));
  const now=Date.now();$('cohort_from').value=new Date(now-60*86400000).toISOString().slice(0,10);$('cohort_to').value=new Date(now-28*86400000).toISOString().slice(0,10);
})();`;

export const REPORT_PAGE_CSP="default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-"+
  createHash('sha256').update(REPORT_SCRIPT).digest('base64')+"'";

export const REPORT_STYLE=String.raw`
:root{color-scheme:dark;--bg:#10151e;--panel:#192230;--ink:#e8eef8;--muted:#a5b3c8;--line:#344258;--accent:#9dbbff}*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,"PingFang SC",sans-serif}main{max-width:1480px;margin:auto;padding:32px 24px 80px}
h1{font-size:28px;margin:8px 0}h2{font-size:20px;margin-top:0}h3{margin-top:30px}a{color:var(--accent)}p{margin:10px 0}.muted,small{color:var(--muted)}.error{color:#ffb4b4}
section,.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;margin-top:20px}label{display:flex;flex-direction:column;gap:6px;color:var(--muted)}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:7px;padding:10px;background:var(--bg);color:var(--ink);min-width:0}button{cursor:pointer;white-space:normal}button:disabled{opacity:.45;cursor:default}
button.primary,button[aria-pressed=true]{background:var(--accent);color:#111b2d}input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible,.table-scroll:focus-visible{outline:3px solid #bdcfff;outline-offset:3px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.actions,nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.key{max-width:420px;margin-top:20px}
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin:16px 0}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px;vertical-align:top;border-bottom:1px solid var(--line);min-width:90px}th{font-weight:600;color:var(--muted);white-space:nowrap}tr:last-child td{border-bottom:0}
.empty{padding:24px;border:1px dashed var(--line);border-radius:8px}.metadata{overflow-wrap:anywhere}.metadata p{margin:6px 0}.chart{margin:20px 0;max-width:850px}.scenario{margin:16px 0}.scenario span{float:right}.track{position:relative;height:12px;background:var(--bg);margin-top:7px;border-radius:3px;overflow:hidden}.band,.low{height:100%;position:absolute}.band{background:repeating-linear-gradient(45deg,#6982aa,#6982aa 4px,#344760 4px,#344760 8px)}.band.unknown{opacity:.35}.low{background:#9dbbff}.archive-row{border-bottom:1px solid var(--line);padding:16px 0;overflow-wrap:anywhere}.archive-row button{display:block;margin-top:10px}
[hidden]{display:none!important}@media(max-width:760px){main{padding:20px 12px 50px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}section,.card{padding:16px}.scenario span{float:none;display:block}}
@media(max-width:420px){.grid{grid-template-columns:1fr}h1{font-size:23px}}
`;

export function renderReportsPage():string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>NotchSPI · 批次与经济报告</title><style>${REPORT_STYLE}</style></head><body><main><a href="/admin">← 管理后台</a><h1>批次与经济报告</h1><p><a href="/admin/quality/reports">独立质量评测 →</a></p><p class="muted">设备使用与服务账本的运营读数。独立题目正确率不从产品事件推断。</p>
<label class="key">管理员密钥<input id="admin-key" type="password" autocomplete="off" spellcheck="false"></label><p class="muted">密钥仅在当前页面使用，刷新后需重新输入。</p>
<form id="filters" class="card"><div class="grid">
<label>注册起始（UTC，含）<input id="cohort_from" type="date" required></label><label>注册截止（UTC，不含）<input id="cohort_to" type="date" required></label>
<label>观察截止（UTC，留空为现在）<input id="as_of" type="datetime-local" step="1"></label><label>来源<select id="source"><option value="">全部来源</option><option value="spi_entry">SPI 入口</option><option value="reading_practice_entry">阅读练习入口</option><option value="direct">直接访问</option><option value="unknown">未知来源</option></select></label>
<label>政策版本<input id="policy_version" maxlength="64" pattern="[A-Za-z0-9_.-]{1,64}" placeholder="全部政策"></label>
<label>查题 profile<select id="profile"><option value="">全部 profile</option><option value="spi">SPI</option><option value="reading_practice">阅读练习</option><option value="general">通用</option></select></label>
<label>交付通道<select id="channel"><option value="">各通道分别展示</option><option value="official">官方服务</option><option value="custom_key">自有 Key</option><option value="cli">CLI</option><option value="mixed">混合通道</option></select></label>
</div><div class="actions"><button id="load" class="primary" type="submit">加载报表</button><button id="save" type="button" disabled>保存当前快照</button><button id="download" type="button" disabled>下载 JSON</button></div></form>
<p id="status" role="status" aria-live="polite" class="muted">选择注册批次后加载。超过 90 天明细保留期的批次请读取已有归档。</p>
<div id="results" hidden><section class="metadata"><h2 id="report-state"></h2><p id="report-window"></p><p id="report-dimensions"></p><p id="counts"></p><p id="definition" class="muted"></p><small id="integrity"></small></section>
<nav aria-label="报告视图"><button type="button" data-view="coverage-panel" aria-pressed="true">成熟与观察覆盖</button><button type="button" data-view="source-panel" aria-pressed="false">来源比较</button><button type="button" data-view="economic-panel" aria-pressed="false">成本与履约区间</button></nav>
<section id="coverage-panel" data-panel><h2>成熟与观察覆盖</h2><div id="maturity"></div></section><section id="source-panel" data-panel hidden><h2>按来源比较 A28 / R28 / P28</h2><div id="comparison"></div></section><section id="economic-panel" data-panel hidden><h2>已发生成本与未用题包</h2><div id="economic"></div></section></div>
<section><h2>已保存的报告</h2><p class="muted">快照保留当时的定义、窗口和修订；新的收款、退款或成本修订不会改写旧报告。保存不等于独立质量、灰度或市场闸门通过。</p><button id="archives" type="button">加载归档</button><div id="archive-list"></div><button id="more" type="button" hidden>下一页归档</button></section>
</main><script>${REPORT_SCRIPT}</script></body></html>`;
}
