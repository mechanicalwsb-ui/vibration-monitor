// Extra pages: fleet overview, statistics & comparison, machine profile & maintenance log,
// inspection route & QR labels, printable report. All read-only towards the sensor.
// Loaded before the dashboard script; uses its globals at call time.

let pCharts=[];
function pDestroy(){pCharts.forEach(c=>c.destroy());pCharts=[]}
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const isoDay=t=>{const d=new Date(t);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const pct=v=>v==null?'–':Math.round(v*100)+'%';
function quantile(a,q){if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y),i=(s.length-1)*q,lo=Math.floor(i);return s[lo]+(s[Math.ceil(i)]-s[lo])*(i-lo)}
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function lastOf(a){const s=series(a);return s[s.length-1]}

// ---------- connect the sensor of a machine (QR link, route) ----------
async function connectAsset(asset){
  const ids=Object.entries(S.sensors).filter(([,v])=>v.asset===asset).map(([id])=>id);
  try{await loadKnownSensors()}catch(e){}
  const id=ids.find(i=>scan.known.has(i));
  if(id)return useDevice(scan.known.get(id));
  if(!ids.length)$('#bleForm').asset.value=asset; // new sensor for this machine: name it after the machine
  toast(ids.length?`เลือกเซนเซอร์ของ "${asset}" จากหน้าต่างของ Chrome`:`เลือกเซนเซอร์ที่ติดกับ "${asset}"`);
  await pickAndUse();
  if(ble.cfg&&ble.cfg.asset!==asset)toast(`⚠ เซนเซอร์ที่เลือกเป็นของ "${ble.cfg.asset}" ไม่ใช่ "${asset}"`);
}

// ---------- small modal for details ----------
function infoDialog(title,html){
  let d=$('#infoDlg');
  if(!d){d=document.createElement('dialog');d.id='infoDlg';document.body.appendChild(d)}
  d.innerHTML=`<h3>${title}</h3><div style="padding:12px 16px;max-height:65vh;overflow:auto">${html}</div><div class="foot"><button class="btn" onclick="this.closest('dialog').close()">ปิด</button></div>`;
  d.showModal();
}
function showMaint(id){
  const m=(S.maint||[]).find(x=>x.id===id);if(!m)return;
  const ba=beforeAfter(m);
  infoDialog(`${esc(m.type)} · ${esc(m.asset)}`,`<p style="margin:0 0 6px"><b>${dFull(m.t)}</b>${m.by?' · โดย '+esc(m.by):''}${m.cost?' · '+(+m.cost).toLocaleString('th-TH')+' บาท':''}</p>
    <p style="white-space:pre-wrap;margin:0 0 8px">${esc(m.text||'')}</p>${m.photo?`<img src="${m.photo}" style="max-width:100%;border-radius:8px">`:''}
    ${ba?`<p class="muted" style="margin-top:8px">ก่อน 14 วัน ${fv(ba.before)} → หลัง 14 วัน ${fv(ba.after)} ${uv()} (${ba.pct>=0?'+':''}${ba.pct.toFixed(0)}%)</p>`:''}`);
}

// ================= FLEET (#18) =================
function renderFleet(){
  const p=$('#fleetPage'),ns=names();
  if(!ns.length){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีเครื่องจักร</h2><p>เชื่อมต่อเซนเซอร์หรือนำเข้า CSV ก่อน</p><button class="btn primary" onclick="setView(\'sensor\')">เชื่อมต่อเซนเซอร์</button></div>';return}
  const items=ns.map(a=>{const c=cfg(a),r=lastOf(a),z=status(r,c),stale=Date.now()-r.t>3*DAY;
    const key=sensorKeysOf(a)[0],h=key&&S.health[key]?S.health[key].filter(x=>x.batt).at(-1):null;
    const fc=forecast(series(a),c,'ov');
    return{a,c,r,z,stale,batt:h&&h.batt,batLow:h&&h.batLow,fc,area:(c.profile&&c.profile.area)||'ไม่ระบุพื้นที่'}});
  const cnt=k=>items.filter(i=>i.z===k).length;
  const F=S.fleetF||'all',sort=S.fleetSort||'risk';
  let list=items.filter(i=>F==='all'||(F==='need'&&(i.z==='C'||i.z==='D'||i.batLow||(i.fc.ok&&i.fc.dAlarm!=null&&i.fc.dAlarm<30)))||(F==='stale'&&i.stale));
  const rank={D:0,C:1,B:2,A:3,null:4};
  list.sort((x,y)=>sort==='name'?x.a.localeCompare(y.a,'th'):sort==='area'?x.area.localeCompare(y.area,'th')||x.a.localeCompare(y.a,'th'):(rank[x.z]-rank[y.z])||x.a.localeCompare(y.a,'th'));
  const groups=sort==='area'?[...new Set(list.map(i=>i.area))].map(g=>[g,list.filter(i=>i.area===g)]):[['',list]];
  const card=i=>`<button class="panel fcard z${i.z||''}" data-a="${esc(i.a)}">
      <div class="fc-top"><span class="dot z${i.z||''}"></span><b>${esc(i.a)}</b>${i.z?`<span class="tag z${i.z}">${ZL[i.z]}</span>`:''}</div>
      <div class="fc-v num">${fv(overall(i.r))}<small> ${uv()}</small></div>
      <canvas class="spark" data-a="${esc(i.a)}" width="220" height="44"></canvas>
      <div class="fc-sub">${i.stale?'<span class="up">ข้อมูลเก่า</span> · ':''}${ago(i.r.t)}${i.batt?` · แบต ${i.batt.toFixed(2)} V${i.batLow?' ⚠':''}`:''}</div>
      ${i.fc.ok&&i.fc.dAlarm!=null&&i.fc.dAlarm<60?`<div class="fc-sub up">ถึงอันตราย${fmtDays(i.fc.dAlarm)}</div>`:''}</button>`;
  p.innerHTML=`<div class="mainhead"><h2>ทุกเครื่อง</h2>
    <div class="row"><div class="seg" id="flF">${[['all','ทั้งหมด'],['need','ต้องดู'],['stale','ข้อมูลเก่า > 3 วัน']].map(([v,l])=>`<button data-v="${v}" class="${F===v?'on':''}">${l}</button>`).join('')}</div>
    <select id="flSort"><option value="risk">เรียงตามความเสี่ยง</option><option value="name">เรียงตามชื่อ</option><option value="area">จัดกลุ่มตามพื้นที่</option></select></div></div>
  <div class="kpis">${kpi('ปกติ',cnt('A')+cnt('B'),'เครื่อง','','hero zA')}${kpi('เฝ้าระวัง',cnt('C'),'เครื่อง','','hero zC')}${kpi('อันตราย',cnt('D'),'เครื่อง','','hero zD')}${kpi('ข้อมูลเก่า',items.filter(i=>i.stale).length,'เครื่อง','ไม่ได้ดึงเกิน 3 วัน')}</div>
  ${groups.map(([g,l])=>`${g?`<div class="sub-h" style="margin:12px 0 6px">${esc(g)} (${l.length})</div>`:''}<div class="fgrid">${l.map(card).join('')}</div>`).join('')||'<p class="muted">ไม่มีเครื่องที่ตรงเงื่อนไข</p>'}`;
  $('#flSort').value=sort;
  p.querySelectorAll('#flF button').forEach(b=>b.onclick=()=>{S.fleetF=b.dataset.v;save();render()});
  $('#flSort').onchange=e=>{S.fleetSort=e.target.value;save();render()};
  p.querySelectorAll('.fcard').forEach(b=>b.onclick=()=>{S.sel=b.dataset.a;setView('overview')});
  const k=css();
  p.querySelectorAll('canvas.spark').forEach(cv_=>{
    const a=cv_.dataset.a,rs=series(a),end=rs.at(-1).t,xs=rs.filter(r=>r.t>=end-7*DAY);
    const ctx=cv_.getContext('2d'),W=cv_.width,H=cv_.height;ctx.clearRect(0,0,W,H);
    const v=xs.map(overall).filter(x=>x!=null);if(v.length<2)return;
    const hi=Math.max(...v)*1.1||1;ctx.strokeStyle=k.x;ctx.lineWidth=1.5;ctx.beginPath();
    xs.forEach((r,i)=>{const y=overall(r);if(y==null)return;const px=(r.t-(end-7*DAY))/(7*DAY)*W,py=H-y/hi*(H-4)-2;i?ctx.lineTo(px,py):ctx.moveTo(px,py)});ctx.stroke();
  });
}

// ================= STATISTICS (#12) + COMPARISON (#13) =================
function aggregate(rs,c,per){
  const key=r=>{const d=new Date(r.t);if(per==='month')return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if(per==='week'){const m=new Date(d);m.setHours(0,0,0,0);m.setDate(m.getDate()-((m.getDay()+6)%7));return isoDay(m)}return isoDay(d)};
  const g=new Map();
  for(const r of rs){if(isRunning(r,c)===false)continue;const v=overall(r);if(v==null)continue;const k=key(r);
    const e=g.get(k)||{k,t:r.t,v:[],temp:[],al:0};e.v.push(v);if(r.temp!=null)e.temp.push(r.temp);const z=status(r,c);if(z==='C'||z==='D')e.al++;g.set(k,e)}
  return[...g.values()].map(e=>({k:e.k,t:e.t,n:e.v.length,min:Math.min(...e.v),avg:mean(e.v),max:Math.max(...e.v),p95:quantile(e.v,.95),tmax:e.temp.length?Math.max(...e.temp):null,al:e.al}));
}
const PER_LABEL={day:'วัน',week:'สัปดาห์',month:'เดือน'};
function renderStats(){
  pDestroy();
  const p=$('#statsPage'),ns=names(),a=S.sel;
  if(!a||!ns.includes(a)){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีข้อมูล</h2></div>';return}
  const c=cfg(a),all=series(a),end=all.at(-1).t,days=S.range||0,rs=days?all.filter(r=>r.t>=end-days*DAY):all;
  const per=S.stPer||'day',agg=aggregate(rs,c,per).reverse();
  const run=rs.filter(r=>isRunning(r,c)!==false),zc={A:0,B:0,C:0,D:0};run.forEach(r=>{const z=status(r,c);if(z)zc[z]++});
  const zt=Object.values(zc).reduce((x,y)=>x+y,0)||1;
  // this month vs previous month
  const mStart=t=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),1).getTime()};
  const m0=mStart(end),m1=mStart(m0-1);
  const mstat=(f,t)=>{const xs=all.filter(r=>r.t>=f&&r.t<t),v=xs.filter(r=>isRunning(r,c)!==false).map(overall).filter(x=>x!=null);
    return{avg:mean(v),max:v.length?Math.max(...v):null,temp:mean(xs.map(r=>r.temp).filter(x=>x!=null)),runH:runInfo(xs,c).runH,al:xs.filter(r=>{const z=status(r,c);return z==='C'||z==='D'}).length}};
  const A=mstat(m0,end+1),B=mstat(m1,m0);
  const diff=(x,y,f=fv)=>x==null||y==null?'–':`<span class="${x>y*1.1?'up':x<y*0.9?'down':''}">${x>=y?'▲':'▼'} ${y?Math.abs((x-y)/y*100).toFixed(0)+'%':''}</span>`;
  const mName=t=>new Date(t).toLocaleDateString('th-TH',{month:'long',year:'numeric'});
  const cmp=S.cmp||(S.cmp={assets:[a],mode:'assets',per:'month'});
  p.innerHTML=`<div class="mainhead"><h2>สถิติ · ${esc(a)}</h2>
    <div class="row"><div class="seg" id="stRange">${[[7,'7 วัน'],[30,'30 วัน'],[90,'90 วัน'],[365,'1 ปี'],[0,'ทั้งหมด']].map(([d,l])=>`<button data-d="${d}" class="${(S.range||0)===d?'on':''}">${l}</button>`).join('')}</div></div></div>
  <div class="pgrid">
    <div class="panel"><div class="ph"><h3>เวลาที่อยู่ในแต่ละโซน (ตอนเครื่องเดิน)</h3></div><div class="pbody">
      <div class="zstack">${['A','B','C','D'].map(z=>zc[z]?`<i class="z${z}" style="flex:${zc[z]}" title="${ZL[z]} ${pct(zc[z]/zt)}"></i>`:'').join('')}</div>
      <div class="row" style="margin-top:8px">${['A','B','C','D'].map(z=>`<span class="tag z${z}">${ZL[z]} ${pct(zc[z]/zt)}</span>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">${run.length.toLocaleString('th-TH')} ค่าตอนเครื่องเดิน จาก ${rs.length.toLocaleString('th-TH')} ค่า · เดินเครื่อง ${runInfo(rs,c).runH.toFixed(0)} ชม. · สตาร์ท ${runInfo(rs,c).starts} ครั้ง</p></div></div>
    <div class="panel"><div class="ph"><h3>${mName(m0)} เทียบ ${mName(m1)}</h3></div><div class="tablewrap" style="margin:0"><table>
      <thead><tr><th></th><th>เดือนนี้</th><th>เดือนก่อน</th><th>เปลี่ยน</th></tr></thead><tbody>
      <tr><td>Velocity เฉลี่ย (${uv()})</td><td class="num">${fv(A.avg)}</td><td class="num">${fv(B.avg)}</td><td>${diff(A.avg,B.avg)}</td></tr>
      <tr><td>Velocity สูงสุด</td><td class="num">${fv(A.max)}</td><td class="num">${fv(B.max)}</td><td>${diff(A.max,B.max)}</td></tr>
      <tr><td>อุณหภูมิเฉลี่ย (${ut()})</td><td class="num">${ft(A.temp)}</td><td class="num">${ft(B.temp)}</td><td>${diff(A.temp,B.temp)}</td></tr>
      <tr><td>ชั่วโมงเดินเครื่อง</td><td class="num">${A.runH.toFixed(0)}</td><td class="num">${B.runH.toFixed(0)}</td><td>${diff(A.runH,B.runH)}</td></tr>
      <tr><td>ค่าที่เกินเกณฑ์</td><td class="num">${A.al}</td><td class="num">${B.al}</td><td></td></tr></tbody></table></div></div>
    <div class="panel"><div class="ph"><h3>การกระจายของค่า Velocity (${uv()})</h3></div><div class="cbox"><canvas id="stHist"></canvas></div></div>
    <div class="panel"><div class="ph"><h3>อุณหภูมิ กับ การสั่น</h3></div><div class="cbox"><canvas id="stScatter"></canvas></div>
      <p class="muted live-note">จุดเรียงเป็นเส้นขึ้น = ร้อนขึ้นพร้อมสั่นมากขึ้น (มักเป็นปัญหาทางกล) · อุณหภูมิขึ้นแต่การสั่นคงที่ = มักมาจากโหลดหรือสภาพแวดล้อม</p></div>
    <div class="panel span"><div class="ph"><h3>สรุปราย${PER_LABEL[per]} (ตอนเครื่องเดิน)</h3>
      <div class="row"><div class="seg" id="stPer">${Object.entries(PER_LABEL).map(([v,l])=>`<button data-v="${v}" class="${per===v?'on':''}">ราย${l}</button>`).join('')}</div><button class="btn sm" id="stCsv">ส่งออก CSV</button></div></div>
      <div class="tablewrap"><table><thead><tr><th>ช่วง</th><th>จำนวน</th><th>ต่ำสุด</th><th>เฉลี่ย</th><th>สูงสุด</th><th>P95</th><th>อุณหภูมิสูงสุด</th><th>เกินเกณฑ์</th></tr></thead><tbody>
      ${agg.slice(0,400).map(g=>`<tr><td>${g.k}</td><td class="num">${g.n}</td><td class="num">${fv(g.min)}</td><td class="num">${fv(g.avg)}</td><td class="num"><b>${fv(g.max)}</b></td><td class="num">${fv(g.p95)}</td><td class="num">${ft(g.tmax)}</td><td class="num">${g.al||''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel span" id="cmpPanel"></div>
  </div>`;
  p.querySelectorAll('#stRange button').forEach(b=>b.onclick=()=>{S.range=+b.dataset.d;save();render()});
  p.querySelectorAll('#stPer button').forEach(b=>b.onclick=()=>{S.stPer=b.dataset.v;save();render()});
  $('#stCsv').onclick=()=>{const L=['period,count,min,avg,max,p95,temp_max,over_threshold'].concat(agg.map(g=>[g.k,g.n,g.min.toFixed(3),g.avg.toFixed(3),g.max.toFixed(3),g.p95.toFixed(3),g.tmax??'',g.al].join(',')));
    download(`stats-${a}-${per}.csv`,new Blob(['﻿'+L.join('\n')],{type:'text/csv'}))};
  const k=css(),v=run.map(r=>cv(overall(r))).filter(x=>x!=null);
  if(v.length){const hi=quantile(v,.995)||1,nb=24,w=hi/nb,bins=new Array(nb).fill(0);v.forEach(x=>bins[Math.min(nb-1,Math.floor(x/w))]++);
    pCharts.push(new Chart($('#stHist'),{type:'bar',data:{labels:bins.map((_,i)=>(i*w).toFixed(2)),datasets:[{label:'จำนวนค่า',data:bins,backgroundColor:k.x}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:k.muted,maxTicksLimit:8},grid:{display:false},title:{display:true,text:uv(),color:k.muted}},y:{ticks:{color:k.muted},grid:{color:k.line}}}}}));}
  const sp=decimate(rs.filter(r=>r.temp!=null&&overall(r)!=null),1500).map(r=>({x:ct(r.temp),y:cv(overall(r))}));
  pCharts.push(new Chart($('#stScatter'),{type:'scatter',data:{datasets:[{label:'ค่าที่วัด',data:sp,backgroundColor:k.t,pointRadius:2}]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false}},scales:{x:{title:{display:true,text:'อุณหภูมิ '+ut(),color:k.muted},ticks:{color:k.muted},grid:{color:k.line}},y:{title:{display:true,text:uv(),color:k.muted},ticks:{color:k.muted},grid:{color:k.line}}}}}));
  renderCompare();
}
function renderCompare(){
  const el=$('#cmpPanel'),ns=names(),C=S.cmp,k=css();
  C.assets=C.assets.filter(x=>ns.includes(x));if(!C.assets.length&&S.sel)C.assets=[S.sel];
  const repairs=(S.maint||[]).filter(m=>m.asset===S.sel&&m.type!=='ตรวจ').sort((a,b)=>b.t-a.t);
  el.innerHTML=`<div class="ph"><h3>เปรียบเทียบ</h3><div class="seg" id="cmpMode">${[['assets','หลายเครื่อง'],['periods','ช่วงเวลา (เครื่องที่เลือก)']].map(([v,l])=>`<button data-v="${v}" class="${C.mode===v?'on':''}">${l}</button>`).join('')}</div></div>
    <div class="pbody">${C.mode==='assets'?`<div class="row">${ns.map(n=>`<label class="check" style="font-size:13px"><input type="checkbox" value="${esc(n)}" ${C.assets.includes(n)?'checked':''}> ${esc(n)}</label>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">เลือกได้สูงสุด 6 เครื่อง · ค่าเฉลี่ยรายวันตอนเครื่องเดิน (velocity รวม)</p>`
    :`<div class="row"><select id="cmpPreset"><option value="month">เดือนนี้ เทียบ เดือนก่อน</option><option value="year">30 วันล่าสุด เทียบ ช่วงเดียวกันปีก่อน</option>
      ${repairs.map(m=>`<option value="m:${m.id}">ก่อน/หลัง ${esc(m.type)} ${dShort(m.t)}</option>`).join('')}</select></div>`}</div>
    <div class="cbox" style="height:300px"><canvas id="cmpChart"></canvas></div><div class="tablewrap" id="cmpTable" style="max-height:none"></div>`;
  el.querySelectorAll('#cmpMode button').forEach(b=>b.onclick=()=>{C.mode=b.dataset.v;save();renderCompare()});
  const pal=[k.x,k.y,k.z,k.r,k.t,k.zb],daily=(a,f,t)=>{const c=cfg(a);return aggregate(series(a).filter(r=>r.t>=f&&r.t<t),c,'day').map(g=>({t:new Date(g.k+'T12:00').getTime(),y:g.avg,max:g.max}))};
  let ds=[],rows=[];
  if(C.mode==='assets'){
    el.querySelectorAll('input[type=checkbox]').forEach(i=>i.onchange=()=>{
      const s=new Set(C.assets);i.checked?s.add(i.value):s.delete(i.value);
      if(s.size>6){i.checked=false;return toast('เลือกได้สูงสุด 6 เครื่อง')}C.assets=[...s];save();renderCompare()});
    const from=Date.now()-(S.range||90)*DAY;
    C.assets.forEach((a,i)=>{const d=daily(a,from,Infinity);ds.push({label:a,data:d.map(p=>({x:p.t,y:cv(p.y)})),borderColor:pal[i],backgroundColor:pal[i],borderWidth:1.6,pointRadius:1.5,tension:.2});
      const v=d.map(p=>p.y);rows.push([a,mean(v),v.length?Math.max(...d.map(p=>p.max)):null,v.length])});
    const base=rows[0]&&rows[0][1];
    $('#cmpTable').innerHTML=`<table><thead><tr><th>เครื่อง</th><th>เฉลี่ย (${uv()})</th><th>สูงสุด</th><th>จำนวนวัน</th><th>ต่างจาก ${esc(rows[0]?rows[0][0]:'')}</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${esc(r[0])}</td><td class="num">${fv(r[1])}</td><td class="num">${fv(r[2])}</td><td class="num">${r[3]}</td><td class="num">${base&&r[1]!=null?((r[1]-base)/base*100).toFixed(0)+'%':'–'}</td></tr>`).join('')}</tbody></table>`;
    const o=opts(uv());pCharts.push(new Chart($('#cmpChart'),{type:'line',data:{datasets:ds},options:o}));
  }else{
    const sel=$('#cmpPreset');sel.value=C.preset||'month';if(sel.value!==(C.preset||'month'))sel.value='month';
    sel.onchange=()=>{C.preset=sel.value;save();renderCompare()};
    const a=S.sel,end=lastOf(a).t;let A,B,la,lb;
    if(sel.value==='month'){const m0=new Date(new Date(end).getFullYear(),new Date(end).getMonth(),1).getTime(),m1=new Date(new Date(m0-1).getFullYear(),new Date(m0-1).getMonth(),1).getTime();A=[m0,end+1];B=[m1,m0];la='เดือนนี้';lb='เดือนก่อน'}
    else if(sel.value==='year'){A=[end-30*DAY,end+1];B=[end-395*DAY,end-365*DAY];la='30 วันล่าสุด';lb='ปีก่อน'}
    else{const m=(S.maint||[]).find(x=>'m:'+x.id===sel.value);B=[m.t-14*DAY,m.t];A=[m.t,m.t+14*DAY];la='หลัง';lb='ก่อน'}
    const dA=daily(a,...A),dB=daily(a,...B),off=(d,f)=>d.map(p=>({x:(p.t-f)/DAY,y:cv(p.y)}));
    ds=[{label:lb,data:off(dB,B[0]),borderColor:k.muted,backgroundColor:k.muted,borderDash:[6,4],borderWidth:1.6,pointRadius:2},{label:la,data:off(dA,A[0]),borderColor:k.x,backgroundColor:k.x,borderWidth:1.8,pointRadius:2}];
    const o=opts(uv());o.scales.x={type:'linear',title:{display:true,text:'วันที่ (นับจากต้นช่วง)',color:k.muted},ticks:{color:k.muted},grid:{color:k.line}};
    o.plugins.tooltip.callbacks.title=it=>it.length?'วันที่ '+(Math.floor(it[0].parsed.x)+1):'';
    pCharts.push(new Chart($('#cmpChart'),{type:'line',data:{datasets:ds},options:o}));
    const s=d=>({avg:mean(d.map(p=>p.y)),max:d.length?Math.max(...d.map(p=>p.max)):null});const sa=s(dA),sb=s(dB);
    $('#cmpTable').innerHTML=`<table><thead><tr><th></th><th>${lb}</th><th>${la}</th><th>เปลี่ยน</th></tr></thead><tbody>
      <tr><td>เฉลี่ย (${uv()})</td><td class="num">${fv(sb.avg)}</td><td class="num">${fv(sa.avg)}</td><td class="num">${sa.avg!=null&&sb.avg?((sa.avg-sb.avg)/sb.avg*100).toFixed(0)+'%':'–'}</td></tr>
      <tr><td>สูงสุด</td><td class="num">${fv(sb.max)}</td><td class="num">${fv(sa.max)}</td><td class="num">${sa.max!=null&&sb.max?((sa.max-sb.max)/sb.max*100).toFixed(0)+'%':'–'}</td></tr></tbody></table>`;
  }
}

// ================= MACHINE PROFILE (#16) + MAINTENANCE LOG (#15) =================
// Deep-groove ball bearings 60xx/62xx/63xx: bore from the code, outer diameter from the ISO
// dimension series. Ball count/diameter vary by maker, so they are ESTIMATED from the section
// size (checked against known 6205/6206/6308 geometry); the user can type catalogue values instead.
const BRG_OD={'60':[26,28,32,35,42,47,55,62,68,75,80,90,95,100,110,115,125,130,140,145,150],
  '62':[30,32,35,40,47,52,62,72,80,85,90,100,110,120,125,130,140,150,160,170,180],
  '63':[35,37,42,47,52,62,72,80,90,100,110,120,130,140,150,160,170,180,190,200,215]};
const BRG_EXACT={ // published geometry (bearing data used by the Case Western Reserve University dataset)
  '6205':{n:9,d:7.94,D:39.04,ang:0,src:'ค่าจริง (SKF 6205)'},'6203':{n:9,d:6.75,D:28.5,ang:0,src:'ค่าจริง (SKF 6203)'}};
function bearingGeom(code){
  code=String(code||'').trim().toUpperCase().replace(/[-\s].*$/,'').replace(/[A-Z]+$/,'');
  if(BRG_EXACT[code])return{...BRG_EXACT[code],code};
  const m=code.match(/^(60|62|63)(\d{2})$/);if(!m)return null;
  const i=+m[2],bore=i===0?10:i===1?12:i===2?15:i===3?17:i*5,od=BRG_OD[m[1]][i];if(!od)return null;
  const D=(bore+od)/2,d=+((od-bore)*0.3).toFixed(2),n=Math.max(6,Math.round(Math.PI*D/(d*1.66)));
  return{n,d,D:+D.toFixed(2),ang:0,code,src:`ประมาณจากขนาด ${bore}×${od} mm (ควรตรวจกับแคตตาล็อก)`};
}
const BRG_LIST=['60','62','63'].flatMap(s=>BRG_OD[s].map((_,i)=>s+String(i).padStart(2,'0')));
const MTYPES=['เปลี่ยน bearing','ตั้งศูนย์','balance','อัดจาระบี','ซ่อมใบพัด/ซีล','ขันแน่นฐาน','ตรวจ','อื่น ๆ'];
const REPAIR=t=>t!=='ตรวจ';
function beforeAfter(m){
  const c=cfg(m.asset),rs=series(m.asset).filter(r=>isRunning(r,c)!==false);
  const b=rs.filter(r=>r.t>=m.t-14*DAY&&r.t<m.t).map(overall).filter(x=>x!=null),a=rs.filter(r=>r.t>m.t&&r.t<=m.t+14*DAY).map(overall).filter(x=>x!=null);
  if(b.length<3||a.length<3)return null;const mb=mean(b),ma=mean(a);return{before:mb,after:ma,pct:(ma-mb)/mb*100};
}
async function shrinkImage(file,max=900){
  const url=URL.createObjectURL(file);
  try{const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
    const s=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');
    c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    return c.toDataURL('image/jpeg',0.72)}finally{URL.revokeObjectURL(url)}
}
function isoClassFor(p){
  if(!p||!p.kw)return null;const flex=p.found==='flexible';
  return p.kw>300?(flex?'g1f':'g1r'):(flex?'g2f':'g2r');
}
function renderAssetPage(){
  const p=$('#assetPage'),ns=names(),a=S.sel;
  if(!a||!ns.includes(a)){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีเครื่องจักร</h2></div>';return}
  const c=cfg(a),pr=c.profile||(c.profile={}),br=pr.brg||{};
  const ml=(S.maint||[]).filter(m=>m.asset===a).sort((x,y)=>y.t-x.t);
  const brgRow=(pos,label)=>{const b=br[pos]||{};return`<div class="brow" data-pos="${pos}">
      <label>${label} — เบอร์ bearing<input type="text" class="bCode" list="brgList" value="${esc(b.code||'')}" placeholder="เช่น 6205, 6309"></label>
      <label>จำนวนลูก<input type="number" class="bN" value="${b.n??''}"></label><label>Ø ลูก (mm)<input type="number" step="any" class="bd" value="${b.d??''}"></label>
      <label>Ø pitch (mm)<input type="number" step="any" class="bD" value="${b.D??''}"></label><label>มุมสัมผัส°<input type="number" step="any" class="bA" value="${b.ang??0}"></label>
      <label class="check" style="align-self:end"><input type="radio" name="bUse" value="${pos}" ${(pr.brgUse||'de')===pos?'checked':''}> ใช้ในเมนู FFT</label>
      <p class="muted bSrc" style="grid-column:1/-1;margin:0;font-size:12px">${esc(b.src||'')}</p></div>`};
  const d=new Date(),nowLocal=new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,16);
  p.innerHTML=`<div class="mainhead"><h2>ข้อมูลเครื่อง · ${esc(a)}</h2></div>
  <datalist id="brgList">${BRG_LIST.map(x=>`<option value="${x}">`).join('')}</datalist>
  <div class="pgrid">
    <div class="panel"><div class="ph"><h3>ข้อมูลเครื่องจักร</h3></div>
      <div class="form" id="prForm">
        <label>ประเภท<select name="type">${['ปั๊ม','มอเตอร์','พัดลม/โบลเวอร์','เกียร์','คอมเพรสเซอร์','อื่น ๆ'].map(x=>`<option ${pr.type===x?'selected':''}>${x}</option>`).join('')}</select></label>
        <label>หมายเลขเครื่อง (Tag)<input name="tag" value="${esc(pr.tag||'')}"></label>
        <label>กำลัง (kW)<input type="number" step="any" name="kw" value="${pr.kw??''}"></label>
        <label>ฐานติดตั้ง<select name="found"><option value="rigid" ${pr.found!=='flexible'?'selected':''}>แข็ง (rigid)</option><option value="flexible" ${pr.found==='flexible'?'selected':''}>ยืดหยุ่น (flexible)</option></select></label>
        <label>RPM ปกติ<input type="number" name="rpm" value="${c.rpm??''}"></label>
        <label>จำนวนใบพัด<input type="number" name="vanes" value="${c.vanes??''}"></label>
        <label>พื้นที่ / อาคาร<input name="area" value="${esc(pr.area||'')}" list="areaList"><datalist id="areaList">${[...new Set(ns.map(n=>(cfg(n).profile||{}).area).filter(Boolean))].map(x=>`<option value="${esc(x)}">`).join('')}</datalist></label>
        <label>ตำแหน่งติดตั้ง<input name="loc" value="${esc(pr.loc||'')}" placeholder="เช่น โรงสูบน้ำ 2"></label>
        <label class="full">ตำแหน่งเซนเซอร์และทิศแกน<input name="mount" value="${esc(pr.mount||'')}" placeholder="เช่น ฝั่ง DE มอเตอร์ · X แนวตั้ง, Y แนวแกน, Z แนวนอน"></label>
        <label class="full">รูปเครื่อง<input type="file" accept="image/*" capture="environment" id="prPhoto"></label>
        ${pr.photo?`<img src="${pr.photo}" class="full" style="max-width:100%;max-height:220px;object-fit:contain;border-radius:8px">`:''}
        <div class="full row" style="justify-content:space-between">
          <span class="muted" style="font-size:12px">${isoClassFor(pr)?`กลุ่ม ISO ที่ควรใช้: ${CLASSES[isoClassFor(pr)].n}${c.cls===isoClassFor(pr)?' ✓':''}`:'ใส่ kW เพื่อเลือกกลุ่ม ISO ให้อัตโนมัติ'}</span>
          <div class="row">${isoClassFor(pr)&&c.cls!==isoClassFor(pr)?'<button class="btn" id="prIso">ใช้กลุ่ม ISO นี้</button>':''}<button class="btn primary" id="prSave">บันทึกข้อมูลเครื่อง</button></div></div>
      </div></div>
    <div class="panel"><div class="ph"><h3>ตลับลูกปืน (bearing)</h3></div>
      <div class="pbody bgrid">${brgRow('de','ด้านขับ (DE)')}${brgRow('nde','ด้านตรงข้าม (NDE)')}
      <p class="muted" style="margin:0;font-size:12px">พิมพ์เบอร์แล้วระบบเติมค่าให้ (60xx/62xx/63xx) ค่าที่ได้จะใช้วาดเส้น BPFO/BPFI/BSF/FTF ในเมนูวิเคราะห์ FFT · ถ้ามีแคตตาล็อก ใส่ค่าจริงแทนได้</p>
      <div class="row"><button class="btn primary" id="brSave">บันทึก bearing</button></div></div></div>
    <div class="panel span"><div class="ph"><h3>บันทึกการบำรุงรักษา (${ml.length})</h3></div>
      <div class="form" id="mForm" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        <label>วันที่/เวลา<input type="datetime-local" name="t" value="${nowLocal}"></label>
        <label>ประเภทงาน<select name="type">${MTYPES.map(x=>`<option>${x}</option>`).join('')}</select></label>
        <label>ผู้ทำ<input name="by" value="${esc(S.lastBy||'')}"></label>
        <label>ค่าใช้จ่าย (บาท)<input type="number" step="any" name="cost"></label>
        <label class="full">รายละเอียด<input name="text" placeholder="เช่น เปลี่ยน bearing DE 6309 เพราะเสียงดัง"></label>
        <label>รูปประกอบ<input type="file" accept="image/*" capture="environment" name="photo"></label>
        <div style="align-self:end"><button class="btn primary" id="mAdd">+ เพิ่มบันทึก</button></div>
      </div>
      <div class="tablewrap"><table><thead><tr><th>วันที่</th><th>งาน</th><th>รายละเอียด</th><th>ผู้ทำ</th><th>ค่าใช้จ่าย</th><th>ก่อน → หลัง 14 วัน</th><th></th></tr></thead><tbody>
      ${ml.map(m=>{const ba=REPAIR(m.type)?beforeAfter(m):null;return`<tr><td>${dFull(m.t)}</td><td>${esc(m.type)}</td><td style="white-space:normal;text-align:left">${esc(m.text||'')}${m.photo?' 📷':''}</td><td>${esc(m.by||'')}</td><td class="num">${m.cost?(+m.cost).toLocaleString('th-TH'):''}</td>
        <td class="num">${ba?`${fv(ba.before)} → ${fv(ba.after)} <span class="${ba.pct<0?'down':'up'}">(${ba.pct>=0?'+':''}${ba.pct.toFixed(0)}%)</span>`:'–'}</td>
        <td><button class="btn sm" data-view="${m.id}">ดู</button> <button class="btn sm danger" data-del="${m.id}">ลบ</button></td></tr>`}).join('')||'<tr><td colspan="7" class="muted">ยังไม่มีบันทึก</td></tr>'}</tbody></table></div>
      <p class="muted live-note">บันทึกจะแสดงเป็นหมุดบนกราฟในหน้าภาพรวม · "ก่อน → หลัง" เทียบค่าเฉลี่ย velocity ตอนเครื่องเดิน 14 วันก่อนและหลังงานซ่อม</p></div>
  </div>`;
  const f=$('#prForm'),val=n=>f.querySelector(`[name=${n}]`).value;
  $('#prSave').onclick=()=>{
    Object.assign(pr,{type:val('type'),tag:val('tag').trim(),kw:val('kw')===''?null:+val('kw'),found:val('found'),area:val('area').trim(),loc:val('loc').trim(),mount:val('mount').trim()});
    c.rpm=val('rpm')===''?null:+val('rpm');c.vanes=val('vanes')===''?null:+val('vanes');save();render();toast('บันทึกข้อมูลเครื่องแล้ว')};
  if($('#prIso'))$('#prIso').onclick=()=>{const k=isoClassFor(pr);c.cls=k;c.z=[...CLASSES[k].z];save();render();toast('ใช้เกณฑ์ '+CLASSES[k].n)};
  $('#prPhoto').onchange=async e=>{if(!e.target.files[0])return;pr.photo=await shrinkImage(e.target.files[0]);save();render()};
  p.querySelectorAll('.brow').forEach(row=>{
    row.querySelector('.bCode').onchange=e=>{const g=bearingGeom(e.target.value);if(!g)return toast('ไม่รู้จักเบอร์นี้ ใส่ค่าเองได้');
      row.querySelector('.bN').value=g.n;row.querySelector('.bd').value=g.d;row.querySelector('.bD').value=g.D;row.querySelector('.bA').value=g.ang;row.querySelector('.bSrc').textContent=g.src;row.dataset.src=g.src}});
  $('#brSave').onclick=()=>{
    const brg={};p.querySelectorAll('.brow').forEach(row=>{const q=s=>row.querySelector(s).value,num=s=>q(s)===''?null:+q(s);
      brg[row.dataset.pos]={code:q('.bCode').trim(),n:num('.bN'),d:num('.bd'),D:num('.bD'),ang:num('.bA')||0,src:row.dataset.src||(br[row.dataset.pos]||{}).src||'ใส่เอง'}});
    pr.brg=brg;pr.brgUse=(p.querySelector('input[name=bUse]:checked')||{}).value||'de';
    const use=brg[pr.brgUse];if(use&&use.n&&use.d&&use.D){c.bearing={n:use.n,d:use.d,D:use.D,ang:use.ang||0};FA.marks.bearing=true}
    save();toast('บันทึก bearing แล้ว (ใช้ในเมนูวิเคราะห์ FFT)')};
  const mf=$('#mForm'),mv=n=>mf.querySelector(`[name=${n}]`);
  $('#mAdd').onclick=async()=>{
    const t=new Date(mv('t').value).getTime();if(isNaN(t))return toast('ใส่วันที่');
    const m={id:uid(),asset:a,t,type:mv('type').value,text:mv('text').value.trim(),by:mv('by').value.trim(),cost:mv('cost').value===''?null:+mv('cost').value};
    if(mv('photo').files[0])m.photo=await shrinkImage(mv('photo').files[0]);
    S.lastBy=m.by;S.maint.push(m);save();render();toast('เพิ่มบันทึกแล้ว');
  };
  p.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showMaint(b.dataset.view));
  p.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{if(!confirm('ลบบันทึกนี้?'))return;S.maint=S.maint.filter(m=>m.id!==b.dataset.del);save();render()});
}

// ================= INSPECTION ROUTE + QR (#19) =================
const CHECKS=['เสียงผิดปกติ','รั่ว/ซึม','ร้อนผิดปกติ','น็อต/ฐานหลวม','สภาพปกติ'];
// One promise per URL, so many QR codes rendered at once all wait for the same download
const scriptLoads={};
function loadScript(src){return scriptLoads[src]||(scriptLoads[src]=new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;
  s.onerror=()=>{delete scriptLoads[src];s.remove();rej(new Error('โหลดไม่ได้: '+src))};document.head.appendChild(s)}))}
const QR_LIB='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const assetUrl=a=>location.origin+location.pathname+'#asset='+encodeURIComponent(a);
async function qrSvg(text,cell=4){await loadScript(QR_LIB);const q=qrcode(0,'M');q.addData(unescape(encodeURIComponent(text)));q.make();return q.createSvgTag(cell,8)}
function renderRoute(){
  const p=$('#routePage'),ns=names();S.routes=S.routes||[];
  const run=S.routeRun,R=run&&S.routes.find(r=>r.id===run.id);
  if(R){ // ---- running a route ----
    const list=R.assets.filter(x=>ns.includes(x)),i=Math.min(run.i,list.length),done=Object.keys(run.res).length;
    if(i>=list.length){
      p.innerHTML=`<div class="mainhead"><h2>เดินตรวจเสร็จ · ${esc(R.name)}</h2></div><div class="panel pbody">
        <p>ตรวจ ${done}/${list.length} เครื่อง · เริ่ม ${dFull(run.start)} · จบ ${dFull(Date.now())}</p>
        <div class="tablewrap"><table><thead><tr><th>เครื่อง</th><th>สถานะ</th><th>ดึงข้อมูล</th><th>ผลตรวจ</th><th>หมายเหตุ</th></tr></thead><tbody>
        ${list.map(a=>{const r=run.res[a],z=status(lastOf(a),cfg(a));return`<tr><td>${esc(a)}</td><td>${z?`<span class="tag z${z}">${ZL[z]}</span>`:''}</td><td>${r&&r.fetched?'✓':'–'}</td><td style="white-space:normal">${r?esc(r.checks.join(', ')||'-'):'ข้าม'}</td><td style="white-space:normal">${r?esc(r.note||''):''}</td></tr>`}).join('')}</tbody></table></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="rtEnd">ปิดรอบเดินตรวจ</button></div></div>`;
      $('#rtEnd').onclick=()=>{S.routeRun=null;save();render()};return;
    }
    const a=list[i],c=cfg(a),r=lastOf(a),z=status(r,c),pr=c.profile||{},res=run.res[a]||{checks:[],note:''};
    const fetchedNow=ble.cfg&&ble.cfg.asset===a&&ble.last&&ble.last>run.stepAt;
    p.innerHTML=`<div class="mainhead"><h2>เดินตรวจ · ${esc(R.name)}</h2><span class="muted">${i+1} / ${list.length}</span></div>
      <div class="zstack" style="margin-bottom:12px"><i style="flex:${i};background:var(--accent)"></i><i style="flex:${list.length-i};background:var(--line)"></i></div>
      <div class="panel pbody route-card">
        <h2 style="margin:0">${esc(a)} ${z?`<span class="tag z${z}">${ZL[z]}</span>`:''}</h2>
        <p class="muted" style="margin:4px 0 12px">${[pr.loc,pr.area,pr.tag].filter(Boolean).map(esc).join(' · ')||'—'} · ค่าล่าสุด ${fv(overall(r))} ${uv()} (${ago(r.t)})</p>
        <button class="btn primary big" id="rtFetch" ${ble.busy?'disabled':''}>${fetchedNow?'✓ ดึงข้อมูลแล้ว — ดึงอีกครั้ง':'เชื่อมต่อเซนเซอร์และดึงข้อมูล'}</button>
        <div class="sub-h" style="margin-top:14px">ตรวจด้วยตา/หู</div>
        <div class="row">${CHECKS.map(x=>`<label class="check chk-big"><input type="checkbox" value="${x}" ${res.checks.includes(x)?'checked':''}> ${x}</label>`).join('')}</div>
        <label class="form" style="padding:10px 0 0;display:block">หมายเหตุ<input type="text" id="rtNote" value="${esc(res.note)}" style="width:100%"></label>
        <div class="row" style="margin-top:14px;justify-content:space-between">
          <button class="btn" id="rtSkip">ข้ามเครื่องนี้</button>
          <div class="row"><button class="btn" id="rtStop">หยุดเดินตรวจ</button><button class="btn primary" id="rtNext">บันทึก → เครื่องถัดไป</button></div></div>
      </div>`;
    $('#rtFetch').onclick=()=>connectAsset(a).then(()=>render());
    $('#rtSkip').onclick=()=>{run.i++;run.stepAt=Date.now();save();render()};
    $('#rtStop').onclick=()=>{if(confirm('หยุดเดินตรวจ? ผลที่บันทึกแล้วยังอยู่'))S.routeRun=null;save();render()};
    $('#rtNext').onclick=()=>{
      const checks=[...p.querySelectorAll('.chk-big input:checked')].map(x=>x.value),note=$('#rtNote').value.trim();
      run.res[a]={checks,note,fetched:!!fetchedNow,t:Date.now()};
      S.maint.push({id:uid(),asset:a,t:Date.now(),type:'ตรวจ',text:`เดินตรวจ "${R.name}": ${checks.join(', ')||'ไม่ได้ติ๊ก'}${note?' — '+note:''}${fetchedNow?' (ดึงข้อมูลแล้ว)':''}`,by:S.lastBy||''});
      run.i++;run.stepAt=Date.now();save();render()};
    return;
  }
  // ---- route list / editor + QR labels ----
  const ed=S._routeEdit;
  p.innerHTML=`<div class="mainhead"><h2>เดินตรวจ / QR Code</h2></div>
  <div class="pgrid">
    <div class="panel"><div class="ph"><h3>เส้นทางตรวจ</h3><button class="btn sm" id="rtNew">+ สร้างเส้นทาง</button></div>
      <div class="pbody">${S.routes.length?`<ul class="klist">${S.routes.map(r=>`<li><div><b>${esc(r.name)}</b><div class="muted" style="font-size:12px">${r.assets.length} เครื่อง: ${r.assets.map(esc).join(' → ')}</div></div>
        <div class="row"><button class="btn sm primary" data-run="${r.id}">เริ่มเดินตรวจ</button><button class="btn sm" data-edit="${r.id}">แก้ไข</button><button class="btn sm danger" data-rdel="${r.id}">ลบ</button></div></li>`).join('')}</ul>`
        :'<p class="muted" style="margin:0">ยังไม่มีเส้นทาง กด "สร้างเส้นทาง" แล้วเลือกเครื่องเรียงตามทางเดิน</p>'}
      ${ed?`<div class="route-ed"><label class="form" style="padding:10px 0;display:block">ชื่อเส้นทาง<input id="reName" value="${esc(ed.name)}" style="width:100%"></label>
        <div class="sub-h">เลือกเครื่องและเรียงลำดับ</div><ul class="klist">${[...ed.assets,...ns.filter(n=>!ed.assets.includes(n))].map(n=>{const on=ed.assets.includes(n),k=ed.assets.indexOf(n);
          return`<li><label class="check"><input type="checkbox" data-ra="${esc(n)}" ${on?'checked':''}> ${on?`<b>${k+1}.</b> `:''}${esc(n)}</label>${on?`<div class="row"><button class="btn sm" data-up="${k}">↑</button><button class="btn sm" data-dn="${k}">↓</button></div>`:'<span></span>'}</li>`}).join('')}</ul>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="reSave">บันทึกเส้นทาง</button><button class="btn" id="reCancel">ยกเลิก</button></div></div>`:''}</div></div>
    <div class="panel"><div class="ph"><h3>QR Code ติดเครื่องจักร</h3><div class="row">${'BarcodeDetector' in window?'<button class="btn sm" id="qrScan">สแกน QR ด้วยกล้อง</button>':''}<button class="btn sm primary" id="qrPrint">พิมพ์ป้าย QR ทั้งหมด</button></div></div>
      <div class="pbody"><p class="muted" style="margin:0 0 8px;font-size:12.5px">ติดป้ายที่เครื่อง สแกนด้วยกล้องแท็บเล็ต → เปิดหน้าเครื่องนั้น แล้วกดปุ่มเชื่อมต่อเซนเซอร์ของเครื่องนั้นได้ทันที</p>
      <div class="qrgrid" id="qrGrid">${ns.map(n=>`<div class="qrcell"><div class="qr" data-a="${esc(n)}"></div><div>${esc(n)}</div></div>`).join('')}</div>
      <video id="qrVideo" playsinline muted hidden style="width:100%;border-radius:8px;margin-top:8px"></video></div></div>
  </div>`;
  $('#rtNew').onclick=()=>{S._routeEdit={id:uid(),name:'เส้นทาง '+(S.routes.length+1),assets:[]};render()};
  p.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>{S.routeRun={id:b.dataset.run,i:0,res:{},start:Date.now(),stepAt:Date.now()};save();render()});
  p.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const r=S.routes.find(x=>x.id===b.dataset.edit);S._routeEdit={...r,assets:[...r.assets]};render()});
  p.querySelectorAll('[data-rdel]').forEach(b=>b.onclick=()=>{if(confirm('ลบเส้นทางนี้?')){S.routes=S.routes.filter(x=>x.id!==b.dataset.rdel);save();render()}});
  if(ed){
    p.querySelectorAll('[data-ra]').forEach(i=>i.onchange=()=>{ed.name=$('#reName').value;const n=i.dataset.ra;ed.assets=i.checked?[...ed.assets,n]:ed.assets.filter(x=>x!==n);render()});
    const mv=(k,d)=>{ed.name=$('#reName').value;const j=k+d;if(j<0||j>=ed.assets.length)return;[ed.assets[k],ed.assets[j]]=[ed.assets[j],ed.assets[k]];render()};
    p.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>mv(+b.dataset.up,-1));
    p.querySelectorAll('[data-dn]').forEach(b=>b.onclick=()=>mv(+b.dataset.dn,1));
    $('#reSave').onclick=()=>{ed.name=$('#reName').value.trim()||ed.name;if(!ed.assets.length)return toast('เลือกอย่างน้อย 1 เครื่อง');
      const i=S.routes.findIndex(r=>r.id===ed.id);if(i>=0)S.routes[i]=ed;else S.routes.push(ed);S._routeEdit=null;save();render()};
    $('#reCancel').onclick=()=>{S._routeEdit=null;render()};
  }
  p.querySelectorAll('.qr').forEach(async el=>{try{el.innerHTML=await qrSvg(assetUrl(el.dataset.a),3)}catch(e){el.textContent='สร้าง QR ไม่ได้ (ต้องต่ออินเทอร์เน็ตครั้งแรก)'}});
  $('#qrPrint').onclick=()=>printQrLabels(ns);
  if($('#qrScan'))$('#qrScan').onclick=scanQr;
}
async function printQrLabels(ns){
  const cells=await Promise.all(ns.map(async n=>`<div class="plabel">${await qrSvg(assetUrl(n),5)}<b>${esc(n)}</b><small>${esc(((cfg(n).profile||{}).tag)||'')}</small><small>สแกนเพื่อดูข้อมูลการสั่น</small></div>`));
  printHtml(`<div class="plabels">${cells.join('')}</div>`);
}
async function scanQr(){
  const v=$('#qrVideo');let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})}catch(e){return toast('เปิดกล้องไม่ได้: '+e.message)}
  v.srcObject=stream;v.hidden=false;await v.play();
  const det=new BarcodeDetector({formats:['qr_code']}),t0=Date.now();
  const stop=()=>{stream.getTracks().forEach(t=>t.stop());v.hidden=true};
  while(Date.now()-t0<60000&&!v.hidden){
    try{const r=await det.detect(v);const hit=r.find(x=>/#asset=/.test(x.rawValue));
      if(hit){stop();const m=hit.rawValue.match(/asset=([^&]+)/);openAssetLink(decodeURIComponent(m[1]));return}}catch(e){}
    await new Promise(r=>setTimeout(r,300));
  }
  stop();
}

// ================= REPORT (#17) =================
function printHtml(html){
  let el=$('#printArea');if(!el){el=document.createElement('div');el.id='printArea';document.body.appendChild(el)}
  el.innerHTML=html;document.body.classList.add('printing');
  const done=()=>{document.body.classList.remove('printing');el.innerHTML='';removeEventListener('afterprint',done)};
  addEventListener('afterprint',done);
  setTimeout(()=>window.print(),300);
}
// Render a Chart.js chart off-screen in light colours and return it as an image for printing
async function chartImg(cfgFn,w=900,h=300){
  const cv_=document.createElement('canvas');cv_.width=w;cv_.height=h;cv_.style.cssText=`position:fixed;left:-9999px;width:${w}px;height:${h}px`;
  document.body.appendChild(cv_);const ch=new Chart(cv_,cfgFn());ch.options.animation=false;ch.resize(w,h);ch.update('none');
  const url=cv_.toDataURL('image/png');ch.destroy();cv_.remove();return url;
}
function renderReport(){
  const p=$('#reportPage'),ns=names(),R=S.rep||(S.rep={scope:'one',days:30,org:'',sec:{sum:true,trend:true,alarm:true,fft:true,fc:true,maint:true,sign:true}});
  p.innerHTML=`<div class="mainhead"><h2>รายงาน</h2></div>
  <div class="pgrid"><div class="panel"><div class="ph"><h3>ตั้งค่ารายงาน</h3></div><div class="form" id="repForm">
    <label class="full">ชื่อหน่วยงาน (หัวรายงาน)<input name="org" value="${esc(R.org||'')}" placeholder="เช่น แผนกซ่อมบำรุง โรงงาน ..."></label>
    <label>เครื่องจักร<select name="scope"><option value="one" ${R.scope==='one'?'selected':''}>เฉพาะ ${esc(S.sel||'-')}</option><option value="all" ${R.scope==='all'?'selected':''}>ทุกเครื่อง (${ns.length})</option></select></label>
    <label>ช่วงเวลา<select name="days">${[[7,'7 วัน'],[30,'30 วัน (รายเดือน)'],[90,'90 วัน'],[365,'1 ปี']].map(([d,l])=>`<option value="${d}" ${+R.days===d?'selected':''}>${l}</option>`).join('')}</select></label>
    <div class="full row">${[['sum','สรุปสถานะ'],['trend','กราฟแนวโน้ม'],['alarm','ตาราง alarm'],['fft','FFT ล่าสุด + วิเคราะห์'],['fc','พยากรณ์'],['maint','บันทึกซ่อม'],['sign','ช่องลายเซ็น']].map(([k,l])=>`<label class="check"><input type="checkbox" data-sec="${k}" ${R.sec[k]?'checked':''}> ${l}</label>`).join('')}</div>
    <div class="full row"><button class="btn primary" id="repGo">สร้างรายงานและพิมพ์ / บันทึก PDF</button></div>
    <p class="full muted" style="margin:0;font-size:12px">กดแล้วจะเปิดหน้าพิมพ์ของเบราว์เซอร์ เลือกเครื่องพิมพ์ "บันทึกเป็น PDF" (Save as PDF) เพื่อได้ไฟล์ PDF ขนาด A4</p>
  </div></div></div>`;
  const f=$('#repForm');
  const sync=()=>{R.org=f.org.value;R.scope=f.scope.value;R.days=+f.days.value;f.querySelectorAll('[data-sec]').forEach(i=>R.sec[i.dataset.sec]=i.checked);save()};
  f.querySelectorAll('input,select').forEach(i=>i.onchange=sync);
  $('#repGo').onclick=async()=>{sync();$('#repGo').disabled=true;$('#repGo').textContent='กำลังสร้างรายงาน…';
    try{printHtml(await buildReport(R))}catch(e){toast('สร้างรายงานไม่ได้: '+e.message);console.error(e)}
    finally{$('#repGo').disabled=false;$('#repGo').textContent='สร้างรายงานและพิมพ์ / บันทึก PDF'}};
}
async function buildReport(R){
  const ns=R.scope==='all'?names():[S.sel].filter(Boolean),now=Date.now(),from=now-R.days*DAY;
  const P={x:'#2f6fdb',y:'#e07b1f',z:'#14928a',t:'#c2410c',warn:'#c98205',bad:'#d1342f',grid:'#e2e5e9',ink:'#15191e'};
  const lineCfg=(ds,yT)=>()=>({type:'line',data:{datasets:ds},options:{responsive:false,animation:false,devicePixelRatio:2,plugins:{legend:{labels:{boxWidth:10,color:P.ink}}},
    scales:{x:{type:'linear',ticks:{maxTicksLimit:8,callback:v=>dShort(v),color:P.ink},grid:{color:P.grid}},y:{beginAtZero:true,title:{display:true,text:yT},ticks:{color:P.ink},grid:{color:P.grid}}}}});
  const L=(l,c,d)=>({label:l,data:d,borderColor:c,backgroundColor:c,borderWidth:1.4,pointRadius:0});
  const sumRows=ns.map(a=>{const c=cfg(a),r=lastOf(a),z=status(r,c),fc=forecast(series(a),c,'ov');return{a,c,r,z,fc}});
  const zTxt=z=>z?`<span class="pz z${z}">${ZL[z]}</span>`:'–';
  let html=`<div class="rp-head"><div><h1>รายงานการสั่นสะเทือนเครื่องจักร</h1><p>${esc(R.org||'')}</p></div>
    <div class="rp-meta">ช่วงข้อมูล ${new Date(from).toLocaleDateString('th-TH')} – ${new Date(now).toLocaleDateString('th-TH')}<br>ออกรายงาน ${new Date().toLocaleString('th-TH')}<br>Vibration Monitor ${esc($('#appVer').textContent)}</div></div>`;
  if(R.sec.sum)html+=`<h2>สรุปสถานะ</h2><table class="rp"><thead><tr><th>เครื่องจักร</th><th>สถานะ</th><th>Velocity ล่าสุด (${uv()})</th><th>อุณหภูมิ (${ut()})</th><th>ค่าล่าสุดเมื่อ</th><th>แนวโน้ม</th></tr></thead><tbody>
    ${sumRows.map(s=>`<tr><td>${esc(s.a)}</td><td>${zTxt(s.z)}</td><td>${fv(overall(s.r))}</td><td>${ft(s.r.temp)}</td><td>${dFull(s.r.t)}</td><td>${s.fc.ok?(s.fc.dAlarm!=null?'ถึงอันตราย'+fmtDays(s.fc.dAlarm):s.fc.perWeek>0?'เพิ่มขึ้นช้า ๆ':'ทรงตัว/ลดลง'):'–'}</td></tr>`).join('')}</tbody></table>`;
  for(const s of sumRows){
    const{a,c}=s,rs=series(a).filter(r=>r.t>=from),pr=c.profile||{};
    html+=`<section class="rp-asset"><h2>${esc(a)} ${zTxt(s.z)}</h2><p class="rp-sub">${[pr.type,pr.kw?pr.kw+' kW':'',c.rpm?c.rpm+' RPM':'',pr.loc,pr.tag].filter(Boolean).map(esc).join(' · ')||''}</p>`;
    if(!rs.length){html+='<p>ไม่มีข้อมูลในช่วงนี้</p></section>';continue}
    if(R.sec.trend){
      const d=decimate(rs,1500),pt=k=>d.filter(r=>r[k]!=null).map(r=>({x:r.t,y:k==='temp'?ct(r[k]):cv(r[k])}));
      html+=`<img class="rp-chart" src="${await chartImg(lineCfg([L('X',P.x,pt('vx')),L('Y',P.y,pt('vy')),L('Z',P.z,pt('vz'))],uv()))}">`;
      html+=`<img class="rp-chart" src="${await chartImg(lineCfg([L('อุณหภูมิ',P.t,pt('temp'))],ut()),900,200)}">`;
      const v=rs.filter(r=>isRunning(r,c)!==false).map(overall).filter(x=>x!=null),ri=runInfo(rs,c);
      html+=`<p class="rp-sub">ค่าเฉลี่ย ${fv(mean(v))} · สูงสุด ${fv(v.length?Math.max(...v):null)} ${uv()} · เดินเครื่อง ${ri.runH.toFixed(0)} ชม. · ${rs.length} ค่า</p>`;
    }
    if(R.sec.fc&&s.fc.ok)html+=`<p><b>พยากรณ์:</b> ${s.fc.perWeek>=0?'+':''}${fv(s.fc.perWeek)} ${uv()}/สัปดาห์ (R² ${s.fc.r2.toFixed(2)}) · ${s.fc.dWarn!=null?'ถึงเฝ้าระวัง '+fmtDays(s.fc.dWarn):''} ${s.fc.dAlarm!=null?'· ถึงอันตราย '+fmtDays(s.fc.dAlarm):''}</p>`;
    if(R.sec.alarm){const al=rs.filter(r=>{const z=status(r,c);return z==='C'||z==='D'}).slice(-15).reverse();
      html+=al.length?`<h3>ค่าที่เกินเกณฑ์ (${al.length} ล่าสุด)</h3><table class="rp"><thead><tr><th>เวลา</th><th>X</th><th>Y</th><th>Z</th><th>${ut()}</th><th>ระดับ</th></tr></thead><tbody>${al.map(r=>`<tr><td>${dFull(r.t)}</td><td>${fv(r.vx)}</td><td>${fv(r.vy)}</td><td>${fv(r.vz)}</td><td>${ft(r.temp)}</td><td>${zTxt(status(r,c))}</td></tr>`).join('')}</tbody></table>`:'<p>ไม่มีค่าที่เกินเกณฑ์ในช่วงนี้</p>'}
    if(R.sec.fft){let list=[];try{list=await FFTDB.list(a)}catch(e){}
      const rec=list[0],dec=rec&&faDecode(rec);
      if(dec){const sp=ax=>specPoints(dec,'low','vel',ax).filter(p=>p.x>=2);
        html+=`<h3>FFT ล่าสุด (${KIND_LABEL[rec.kind||'alarm']} · ${dFull(rec.ts*1000)})</h3><img class="rp-chart" src="${await chartImg(()=>{const g=lineCfg([L('X',P.x,sp('x')),L('Y',P.y,sp('y')),L('Z',P.z,sp('z'))],uv())();g.options.scales.x.ticks.callback=v=>v;g.options.scales.x.title={display:true,text:'Hz'};return g})}">`;
        const dg=diagnose(dec,c.rpm||null,null,c);
        html+=`<ul>${dg.items.map(it=>`<li><b>${it.name}</b> (${it.level}) — ${it.why}</li>`).join('')||'<li>ไม่พบรูปแบบความผิดปกติเด่น</li>'}</ul>`}}
    if(R.sec.maint){const ml=(S.maint||[]).filter(m=>m.asset===a&&m.t>=from).sort((x,y)=>x.t-y.t);
      if(ml.length)html+=`<h3>บันทึกการบำรุงรักษา</h3><table class="rp"><thead><tr><th>วันที่</th><th>งาน</th><th>รายละเอียด</th><th>ผู้ทำ</th></tr></thead><tbody>${ml.map(m=>`<tr><td>${dFull(m.t)}</td><td>${esc(m.type)}</td><td>${esc(m.text||'')}</td><td>${esc(m.by||'')}</td></tr>`).join('')}</tbody></table>`}
    html+='</section>';
  }
  if(R.sec.sign)html+=`<div class="rp-sign"><div>ผู้ตรวจสอบ<br><br>.............................................<br>(.............................................)<br>วันที่ ........./........./.........</div><div>ผู้อนุมัติ<br><br>.............................................<br>(.............................................)<br>วันที่ ........./........./.........</div></div>`;
  html+=`<p class="rp-foot">สถานะตัดสินจากเกณฑ์ที่ตั้งไว้ในระบบ (ISO 10816-3 / เกณฑ์ในเซนเซอร์ / baseline) · การวิเคราะห์อัตโนมัติเป็นแนวทางเบื้องต้น ควรให้ผู้เชี่ยวชาญยืนยันก่อนตัดสินใจซ่อม</p>`;
  return html;
}
