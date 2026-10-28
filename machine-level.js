// Machine level: one machine (c.machine) has several measuring points, one sensor each.
// - Shared settings: motor, driven machine, transmission, all bearings, criticality, alarm rules, PM, parts and
//   documents belong to the machine. Edit them on any point and every point of the machine gets them
//   (S.machines[m].data is the shared copy, synced like everything else). Per point stay: which bearing the
//   sensor sits on, sensor axes and mounting, shaft speed at the point, thresholds, baseline, bands.
// - Whole-machine page: all points side by side, trends, latest spectra and findings that need several points.
// - Whole-machine AI analysis, report and grouped alerts.
// Loaded after machine-setup.js; uses the dashboard's globals at call time.

const SHARED_PATHS=['spec.driver','spec.turbine','profile.type','profile.kw','profile.found','profile.tag','profile.area','profile.loc','profile.photo','profile.brg','vfd','drive','vanes',
  'spec.crit','spec.standby','spec.hoursDay','spec.note','spec.motor','spec.driven','spec.trans','spec.brg2','spec.lube','spec.pm','spec.parts','spec.docs','spec.alarm','spec.vertical','spec.lubeTemp'];
const mlClone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
function sharedSlice(c){const o={};for(const p of SHARED_PATHS){const v=getPath(c,p);if(v!==undefined&&v!==null)o[p]=mlClone(v)}return o}
function applySlice(c,o){for(const p of SHARED_PATHS){const ks=p.split('.'),last=ks.pop();let x=c;for(const k of ks){if(x[k]==null||typeof x[k]!=='object')x[k]={};x=x[k]}
  if(p in o)x[last]=mlClone(o[p]);else delete x[last]}}
// Called at every save (mark = a local edit) and after a merge (mark = false: take the machine's copy)
function machineShareSync(mark,stamp){
  S.machines=S.machines||{};
  const groups=new Map();
  for(const[a,c]of Object.entries(S.assets||{})){const m=(c.machine||'').trim();if(!m)continue;if(!groups.has(m))groups.set(m,[]);groups.get(m).push(a)}
  for(const[m,pts]of groups){
    let M=S.machines[m];if(pts.length<2&&!M)continue; // nothing to share until a second point joins
    let src=null;
    if(mark&&M){const mj=JSON.stringify(M.data);
      for(const a of pts){const prev=stamp.get('a|'+a);if(prev===undefined)continue;let pc;try{pc=JSON.parse(prev)}catch(e){continue}
        if((pc.machine||'').trim()!==m)continue; // just joined this machine: it takes the machine's values
        const now=JSON.stringify(sharedSlice(S.assets[a]));if(now!==JSON.stringify(sharedSlice(pc))&&now!==mj){src=a;break}}}
    if(!M){ // first time: the most complete point, gaps filled from the others
      const order=pts.slice().sort((x,y)=>completeness(y).pct-completeness(x).pct),d={};
      for(const a of order)for(const[p,v]of Object.entries(sharedSlice(S.assets[a])))if(!(p in d))d[p]=v;
      M=S.machines[m]={data:d,mt:Date.now()};if(typeof appLog==='function')appLog('edit',`เริ่มใช้ค่าตั้งร่วมของเครื่อง "${m}" (${pts.length} จุดวัด)`)}
    // a listed machine (no point yet) meets its first point: its values win, the point fills the rest
    if(M.cat&&!M.joined){for(const a of pts)for(const[p,v]of Object.entries(sharedSlice(S.assets[a])))if(!(p in M.data))M.data[p]=v;M.joined=true;M.mt=Date.now()}
    if(src){M.data=sharedSlice(S.assets[src]);M.mt=Date.now()}
    const j=JSON.stringify(M.data);
    for(const a of pts){const c=S.assets[a];if(JSON.stringify(sharedSlice(c))!==j){applySlice(c,M.data);syncMeasured(c)}}
  }
}
const sharedWith=a=>{const c=cfg(a),m=(c.machine||'').trim();if(!m)return[];const pts=Object.entries(S.assets).filter(([,x])=>(x.machine||'').trim()===m).map(([n])=>n);return pts.length>1?pts:[]};

// ---------- where a point sits on the machine ----------
function pointSide(a){const c=cfg(a),u=(c.profile||{}).brgUse,l=pointLabel(a);
  if(u==='dde'||u==='dnde')return'driven';if(/motor|มอเตอร์|turbine|เทอร์ไบน์|^[mt][\s-]?n?de/i.test(l))return'motor';
  if(/pump|ปั๊ม|fan|พัดลม|gear|เกียร์|blower|โบลเวอร์|comp|^p[\s-]?n?de/i.test(l))return'driven';return u==='de'||u==='nde'?'motor':'?'}
function pointEnd(a){const c=cfg(a),u=(c.profile||{}).brgUse,l=pointLabel(a);if(/nde/i.test(l)||u==='nde'||u==='dnde')return'NDE';if(/de\b|ฝั่งขับ/i.test(l)||u==='de'||u==='dde')return'DE';return'?'}
const SIDE_TH={motor:'ต้นกำลัง',driven:'เครื่องถูกขับ','?':'ไม่ระบุ'};
// radial / axial from the trend reading, using this point's sensor axes
function radAx(a,r){const o=sensorAxesOf(cfg(a)),v={x:r.vx,y:r.vy,z:r.vz};let ax=null,rad=null;
  for(const k of['x','y','z']){if(v[k]==null)continue;if(o[k]==='A')ax=v[k];else rad=Math.max(rad??0,v[k])}return{rad,ax}}

// ---------- findings that need several points ----------
async function machineDiag(m){
  const pts=pointsOf(m),out=[];if(pts.length<2)return out;
  const P=pts.map(a=>{const c=cfg(a),r=lastOf(a),ra=radAx(a,r);return{a,c,r,ov:overall(r),z:status(r,c),side:pointSide(a),end:pointEnd(a),...ra}});
  const add=(lvl,t,why)=>out.push({lvl,t,why});
  // 1. which side is the source
  const mx=s=>vmax(P.filter(p=>p.side===s).map(p=>p.ov));const mo=mx('motor'),dr=mx('driven');
  if(mo&&dr){const k=mo/dr;if(k>=1.5)add('info',`ต้นเหตุน่าจะอยู่ฝั่ง${drvName(P[0].c)}`,`${drvName(P[0].c)}สั่นสูงกว่าเครื่องถูกขับ ~${k.toFixed(1)} เท่า (${fv(mo)} vs ${fv(dr)} ${uv()})`);
    else if(1/k>=1.5)add('info','ต้นเหตุน่าจะอยู่ฝั่งเครื่องถูกขับ',`เครื่องถูกขับสั่นสูงกว่า${drvName(P[0].c)} ~${(1/k).toFixed(1)} เท่า (${fv(dr)} vs ${fv(mo)} ${uv()})`)}
  // 2. axial high on both sides of the coupling -> misalignment
  const cp=P.filter(p=>p.end==='DE'&&p.ax!=null&&p.rad);
  const hiAx=cp.filter(p=>p.ax>=0.5*p.rad&&p.ov>=(p.c.z||[1.4])[0]);
  if(cp.length>=2&&hiAx.length>=2&&new Set(hiAx.map(p=>p.side)).size>=2)add('warn','สงสัยแนวเพลาไม่ตรง (misalignment)',`แนวแกน (axial) สูงทั้งสองฝั่งคัปปลิ้ง: ${hiAx.map(p=>`${pointLabel(p.a)} axial ${fv(p.ax)} / radial ${fv(p.rad)}`).join(' · ')}`);
  // 3. one point far above the rest -> local problem
  const ovs=P.map(p=>p.ov).filter(v=>v>0);
  for(const p of P){const others=P.filter(q=>q!==p).map(q=>q.ov).filter(v=>v>0).sort((x,y)=>x-y);if(!others.length||!p.ov)continue;const med=others[others.length>>1];
    if(p.ov>=2*med&&(p.z==='C'||p.z==='D'))add('warn',`${pointLabel(p.a)} สูงกว่าจุดอื่นมาก`,`${fv(p.ov)} ${uv()} เทียบกับจุดอื่น ~${fv(med)}: มักเป็นปัญหาเฉพาะจุด เช่น หลวม/ฐานไม่แน่น/bearing ตรงจุดนี้`)}
  // 4. every point high and alike -> whole machine
  if(ovs.length>=2&&P.every(p=>p.z==='C'||p.z==='D')&&vmax(ovs)/vmin(ovs)<1.5)add('warn','ทุกจุดสูงใกล้เคียงกัน','ปัญหาระดับทั้งเครื่อง เช่น ไม่สมดุล, resonance, ฐาน/โครงสร้าง หรือสภาพการทำงาน (โหลด/การไหล)');
  // 5. temperature
  const ts=P.filter(p=>p.r.temp!=null);if(ts.length>=2){const hot=ts.reduce((x,y)=>y.r.temp>x.r.temp?y:x),rest=ts.filter(p=>p!==hot).map(p=>p.r.temp),avg=rest.reduce((x,y)=>x+y,0)/rest.length;
    if(hot.r.temp-avg>=15)add('warn',`อุณหภูมิ ${pointLabel(hot.a)} สูงกว่าจุดอื่น`,`${hot.r.temp.toFixed(1)} °C เทียบกับเฉลี่ย ${avg.toFixed(1)} °C: ตรวจการหล่อลื่น/bearing ตรงจุดนี้`)}
  // 6. spectra (latest capture of each point, when they were taken within a week of each other)
  const F=[];for(const p of P){let rec=null;try{rec=(await FFTDB.list(p.a))[0]}catch(e){}const d=rec&&faDecode(rec);if(d){const f1=speedOf(rec,d,p.c);F.push({...p,rec,d,f1})}}
  if(F.length>=2&&vmax(F.map(x=>x.rec.ts))-vmin(F.map(x=>x.rec.ts))<=7*86400){
    const h=x=>{if(!x.f1)return null;const pk=f=>Math.max(...['x','y','z'].map(k=>peakAt(rawSpec(x.d,'low','vel',k),f,Math.max(0.5,f*0.03))));return{h1:pk(x.f1),h2:pk(2*x.f1)}};
    const cpl=F.filter(x=>x.end==='DE').map(x=>({x,...(h(x)||{})})).filter(y=>y.h1>0);
    if(cpl.length>=2&&cpl.every(y=>y.h2>=0.5*y.h1))add('warn','สเปกตรัม: 2X สูงทั้งสองฝั่งคัปปลิ้ง',`${cpl.map(y=>`${pointLabel(y.x.a)} 2X/1X = ${(y.h2/y.h1).toFixed(2)}`).join(' · ')} → รูปแบบของแนวเพลาไม่ตรง`);
    const items=new Map();for(const x of F){for(const it of diagnose(x.d,x.f1?x.f1*60:null,null,x.c).items){const k=it.name;if(!items.has(k))items.set(k,[]);items.get(k).push(pointLabel(x.a))}}
    for(const[k,l]of items)add(l.length>1?'warn':'info',`${k}`,`พบที่ ${l.join(', ')}${l.length>1?' (หลายจุด = น่าจะเป็นอาการของทั้งเครื่อง)':' (จุดเดียว = น่าจะเป็นเฉพาะจุดนี้)'}`)}
  else if(F.length<2)add('info','ยังเทียบสเปกตรัมข้ามจุดไม่ได้','ต้องมี FFT อย่างน้อย 2 จุดที่วัดห่างกันไม่เกิน 7 วัน (สั่งวัด FFT ทุกจุดในวันเดียวกัน)');
  if(!out.length)add('ok','ไม่พบความผิดปกติที่ต้องเทียบหลายจุด','ระดับการสั่นของทุกจุดใกล้เคียงกันและไม่มีรูปแบบเด่น');
  return out;
}
const DIAG_ICON={warn:'⚠',info:'ℹ',ok:'✓'};
const diagListHtml=L=>`<ul class="md-list">${L.map(d=>`<li class="md-${d.lvl}"><b>${DIAG_ICON[d.lvl]} ${esc(d.t)}</b><br><span class="muted">${esc(d.why)}</span></li>`).join('')}</ul>`;

// ---------- the whole-machine page ----------
let machCharts=[];
async function renderMachinePage(){
  const p=$('#machPage');if(!p)return;machCharts.forEach(c=>c.destroy());machCharts=[];
  const ns=names();if(!ns.length){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีข้อมูล</h2></div>';return}
  const a=S.sel&&ns.includes(S.sel)?S.sel:ns[0],m=machineOf(a),pts=pointsOf(m);
  if(pts.length<2){p.innerHTML=machineGroupHtml(a);bindMachineGroup();return}
  const z=worstZone(pts),c0=cfg(pts[0]),crit=critOf(c0),from=Date.now()-(S.range||30)*DAY;
  const row=x=>{const c=cfg(x),r=lastOf(x),zz=status(r,c),ra=radAx(x,r),bd=c.useBaseline?baselineDelta(r,c):null;
    return`<tr data-pt="${esc(x)}" style="cursor:pointer"><td><span class="dot z${zz||''}"></span> <b>${esc(pointLabel(x))}</b><br><small class="muted">${SIDE_TH[pointSide(x)]} ${pointEnd(x)!=='?'?pointEnd(x):''}</small></td>
      <td>${zz?`<span class="tag z${zz}">${ZL[zz]}</span>`:'–'}</td><td class="num">${fv(overall(r))}</td><td class="num">${fv(r.vx)} / ${fv(r.vy)} / ${fv(r.vz)}</td>
      <td class="num">${ra.ax!=null&&ra.rad?(ra.ax/ra.rad).toFixed(2):'–'}</td><td class="num">${r.temp!=null?ft(r.temp):'–'}</td><td class="num">${bd!=null?(bd>=0?'+':'')+bd.toFixed(0)+'%':'–'}</td><td>${ago(r.t)}</td></tr>`};
  const mmh=typeof mmMachineHtml==='function'?mmMachineHtml(m):{btn:'',banner:''};
  p.innerHTML=`<div class="mainhead"><h2>${esc(m)} ${z?`<span class="tag z${z}"><span class="dot z${z}"></span>${ZL[z]} (จุดที่แย่ที่สุด)</span>`:''}${crit?`<span class="crit ${crit}">สำคัญ ${crit}</span>`:''}</h2>
      <div class="row">${mmh.btn}<button class="btn" id="mlAI">✨ วิเคราะห์ทั้งเครื่องด้วย AI</button><button class="btn" id="mlRep">รายงานทั้งเครื่อง</button><button class="btn" onclick="setView('setup')">⚙ ตั้งค่าเครื่อง</button></div></div>
    ${mmh.banner}
    <div class="panel"><div class="ph"><h3>จุดวัด ${pts.length} จุด · ค่าล่าสุด</h3></div><div class="tablewrap"><table>
      <thead><tr><th>จุดวัด</th><th>สถานะ</th><th class="num">รวม (${uv()})</th><th class="num">${AXES.map(x=>x[1].split(' ')[0]).join(' / ')}</th><th class="num" title="axial ÷ radial">Axial/Radial</th><th class="num">อุณหภูมิ</th><th class="num">เทียบ baseline</th><th>อัปเดต</th></tr></thead>
      <tbody>${pts.map(row).join('')}</tbody></table></div><p class="muted fa-note">แตะแถวเพื่อเปิดภาพรวมของจุดนั้น · Axial/Radial ≥ 0.5 ที่ฝั่งคัปปลิ้งมักบอกแนวเพลาไม่ตรง</p></div>
    <div class="pgrid">
      <div class="panel"><div class="ph"><h3>วิเคราะห์ข้ามจุดวัด</h3></div><div class="pbody" id="mlDiag"><p class="muted">กำลังวิเคราะห์…</p></div></div>
      <div class="panel"><div class="ph"><h3>แนวโน้มความสั่นรวมทุกจุด (${S.range||30} วัน)</h3></div><div class="cbox"><canvas id="mlTrend"></canvas></div></div>
    </div>
    <div class="panel"><div class="ph"><h3>สเปกตรัมล่าสุดของแต่ละจุด (สเกลเท่ากัน)</h3></div><div class="pbody" id="mlSpec"><p class="muted">กำลังโหลด…</p></div></div>`;
  p.querySelectorAll('[data-pt]').forEach(tr=>tr.onclick=()=>{S.sel=tr.dataset.pt;setView('overview')});
  if($('#mlMeasure'))$('#mlMeasure').onclick=()=>openMeasureMachine(m);
  $('#mlAI').onclick=()=>{S.sel=a;S.view='ai';save();render();setTimeout(()=>aiRunMachine(a),50)};
  $('#mlRep').onclick=()=>{S.rep=S.rep||{};S.rep.scope='machine';S.sel=a;setView('report')};
  // trend: overall per point
  const k=css(),pal=CMP_COL;
  machCharts.push(new Chart($('#mlTrend'),{type:'line',data:{datasets:pts.map((x,i)=>({label:pointLabel(x),data:series(x).filter(r=>r.t>=from&&!r.live).map(r=>({x:r.t,y:cv(overall(r))})).filter(q=>q.y!=null),
    borderColor:pal[i%pal.length],backgroundColor:pal[i%pal.length],borderWidth:1.4,pointRadius:0,tension:.2}))},options:(()=>{const o=opts(uv());o.scales.x={type:'linear',ticks:{color:k.muted,callback:v=>dShort(v),maxTicksLimit:7},grid:{color:k.line}};o.plugins.tooltip.callbacks.title=it=>it.length?dFull(it[0].parsed.x):'';return o})()}));
  // findings
  machineDiag(m).then(L=>{const el=$('#mlDiag');if(el)el.innerHTML=diagListHtml(L)});
  // spectra
  const items=[];for(const x of pts){let rec=null;try{rec=(await FFTDB.list(x))[0]}catch(e){}const d=rec&&faDecode(rec);if(d)items.push({x,rec,d})}
  const box=$('#mlSpec');if(!box)return;
  if(!items.length){box.innerHTML='<p class="muted">ยังไม่มี FFT ของจุดใด (สั่งวัด FFT ที่แต่ละจุด)</p>';return}
  let top=0,fmax=0;const env=items.map(it=>{const e=faEnvelope(it.d,['x','y','z']).filter(q=>q.x>=VEL_MIN_HZ);for(const q of e){if(q.y>top)top=q.y;if(q.x>fmax)fmax=q.x}return e});
  const f1s=items.map(it=>speedOf(it.rec,it.d,cfg(it.x))),hi=Math.min(fmax,(vmax(f1s.filter(Boolean))||25)*15);
  {const h=box.closest('.panel')&&box.closest('.panel').querySelector('.ph h3');if(h&&typeof mmSpecNote==='function')h.innerHTML='สเปกตรัมล่าสุดของแต่ละจุด (สเกลเท่ากัน)<small class="muted" style="font-weight:400">'+mmSpecNote(items.map(it=>it.rec))+'</small>'}
  box.innerHTML=items.map((it,i)=>`<div class="cmp-row"><div class="cmp-title"><i style="background:${pal[i%pal.length]}"></i><b>${esc(pointLabel(it.x))}</b> ${esc(dFull(it.rec.ts*1000))}${f1s[i]?` · 1X ${(f1s[i]*60).toFixed(0)} RPM`:''}</div><div class="cmp-box"><canvas data-ms="${i}"></canvas></div></div>`).join('')+
    `<p class="muted fa-note">แสดงค่าสูงสุดของ 3 แกน ช่วง 0–${Math.round(hi)} Hz · ชี้/แตะกราฟเพื่อดูความถี่เดียวกันทุกจุด · ดูละเอียดที่เมนูวิเคราะห์ FFT</p>`;
  FA._syncGroup=[];
  box.querySelectorAll('canvas[data-ms]').forEach((cv_,i)=>{const o=opts(uv());o.scales.x={type:'linear',min:VEL_MIN_HZ,max:hi,ticks:{color:k.muted},grid:{color:k.line},title:{display:i===items.length-1,text:'ความถี่ (Hz)',color:k.muted}};
    o.scales.y.max=+(top*1.08).toPrecision(3);o.scales.y.afterFit=s=>{s.width=58};o.plugins.legend.display=false;o.plugins.tooltip.enabled=false;
    o.plugins.faVlines={lines:f1s[i]?[1,2,3].map(n=>({x:n*f1s[i],label:n+'X',color:k.muted})):[]};
    const ch=new Chart(cv_,{type:'line',data:{datasets:[{label:pointLabel(items[i].x),data:env[i].map(q=>({x:q.x,y:q.y})),borderColor:pal[i%pal.length],backgroundColor:pal[i%pal.length],borderWidth:1.1,pointRadius:0,tension:0}]},options:o,plugins:[faVlines,faSync]});
    machCharts.push(ch);FA._syncGroup.push(ch)});
}
// a machine that has only one point yet: pick the points that belong together
function machineGroupHtml(a){
  const ns=names(),cur=machineOf(a),exist=[...new Set(ns.map(n=>(cfg(n).machine||'').trim()).filter(Boolean))];
  return`<div class="mainhead"><h2>ภาพรวมทั้งเครื่อง</h2></div><div class="panel"><div class="ph"><h3>จัดกลุ่มจุดวัดเป็นเครื่องจักร</h3></div><div class="pbody">
    <p style="margin-top:0">"${esc(a)}" ยังเป็นจุดวัดเดียวของเครื่อง ถ้าเครื่องนี้ติดเซนเซอร์หลายตัว (เช่น มอเตอร์ DE/NDE, ปั๊ม DE/NDE) ให้เลือกจุดวัดที่อยู่บนเครื่องเดียวกัน แล้วตั้งชื่อเครื่อง</p>
    <div class="form" style="padding:0"><label>ชื่อเครื่องจักร<input id="mgName" value="${esc((cfg(a).machine||'').trim()||'')}" list="mgList" placeholder="เช่น P-101 ปั๊มน้ำดิบ"><datalist id="mgList">${exist.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></label></div>
    <div class="mg-pick">${ns.map(n=>`<label class="check"><input type="checkbox" data-mg="${esc(n)}" ${n===a||machineOf(n)===cur&&cfg(n).machine?'checked':''}> ${esc(n)} <input class="mg-pt" data-pl="${esc(n)}" value="${esc(cfg(n).point||'')}" placeholder="ชื่อจุด เช่น Motor DE"></label>`).join('')}</div>
    <button class="btn primary" id="mgGoGroup">จัดกลุ่ม</button>
    <p class="muted" style="font-size:12px">หลังจัดกลุ่ม ค่าตั้งเครื่อง (มอเตอร์ เครื่องถูกขับ การส่งกำลัง bearing ความสำคัญ กฎเตือน PM) จะใช้ร่วมกันทุกจุด เริ่มจากจุดที่กรอกไว้ครบที่สุด ค่าเฉพาะจุด (bearing ตรงจุดวัด ทิศแกน ตำแหน่ง เกณฑ์) แยกเหมือนเดิม · ตั้งในหน้าตั้งค่าเครื่องจักร แท็บทั่วไป ได้เช่นกัน</p></div></div>`;
}
function bindMachineGroup(){if(!$('#mgGoGroup'))return;$('#mgGoGroup').onclick=()=>{const m=$('#mgName').value.trim();if(!m)return toast('ใส่ชื่อเครื่องจักร');
  const sel=[...document.querySelectorAll('[data-mg]:checked')].map(i=>i.dataset.mg);if(sel.length<2)return toast('เลือกอย่างน้อย 2 จุดวัด');
  for(const n of sel){const c=cfg(n);c.machine=m;const pl=document.querySelector(`[data-pl="${CSS.escape(n)}"]`);if(pl&&pl.value.trim())c.point=pl.value.trim()}
  appLog('edit',`จัดกลุ่ม ${sel.length} จุดวัดเป็นเครื่อง "${m}"`);save();render();toast(`จัดกลุ่มเป็น "${m}" แล้ว`)}}

// ---------- whole-machine AI analysis ----------
const AI_MACHINE_PROMPT=`ด้านล่างเป็นข้อมูลของเครื่องจักร 1 เครื่องที่ติดเซนเซอร์หลายจุด (แต่ละจุดคือ bearing หนึ่งตำแหน่ง) วิเคราะห์ทั้งเครื่องโดยเทียบทุกจุดพร้อมกัน ตอบเป็นภาษาไทย ใช้หัวข้อ:
## สรุปสภาพเครื่อง (1–2 ประโยค พร้อมระดับความเร่งด่วน)
## เทียบแต่ละจุดวัด (ตาราง: จุด | สถานะ | ค่าเด่น | ข้อสังเกต)
## ต้นเหตุที่น่าจะเป็น (ระบุว่าอยู่ฝั่งมอเตอร์หรือเครื่องถูกขับ หรือทั้งเครื่อง พร้อมหลักฐานจากการเทียบจุด เช่น axial/2X ทั้งสองฝั่งคัปปลิ้ง = misalignment, 1X เด่นที่ฝั่งใบพัด = unbalance, จุดเดียวสูง = ปัญหาเฉพาะจุด)
## สิ่งที่ควรทำ (เรียงตามความสำคัญ ระบุว่าทำที่จุดไหน)
## ข้อมูลที่ควรเก็บเพิ่ม
ใช้เฉพาะข้อมูลที่ให้มา ถ้าข้อมูลไม่พอให้บอกตรง ๆ`;
async function aiRunMachine(asset){
  if(AI.busy||AI.preparing)return toast('กำลังวิเคราะห์อยู่ รอให้เสร็จก่อน');
  const m=machineOf(asset),pts=pointsOf(m);if(pts.length<2)return toast('เครื่องนี้มีจุดวัดเดียว');
  AI.preparing=true;let ctx;
  try{const points=[];for(const a of pts){const c=await buildAIContext(a,{fft:true});delete c.machineSetup;if(c.machine){delete c.machine.group}
      points.push({point:pointLabel(a),side:SIDE_TH[pointSide(a)],end:pointEnd(a),...c})}
    const c0=cfg(pts[0]),ms=machineSetupSummary(c0,(c0.rpm||0)/60);delete ms.sensorAxes;
    ctx={machine:aiCfg().anon?'เครื่อง A':m,setup:ms,points,crossPointFindings:(await machineDiag(m)).map(d=>`${d.t}: ${d.why}`)}}
  catch(e){console.error(e);return toast('เตรียมข้อมูลให้ AI ไม่สำเร็จ: '+e.message)}
  finally{AI.preparing=false}
  AI.chat[asset]=[];
  aiAsk(asset,`${AI_MACHINE_PROMPT}\n\nข้อมูล (JSON):\n${JSON.stringify(ctx)}`,`วิเคราะห์ทั้งเครื่อง ${m}`,`วิเคราะห์ทั้งเครื่อง ${m}`);
}

// ---------- plant machine list ----------
// Names offered when adding a machine, naming a sensor's machine or grouping points (Eastern Sugar mill yard,
// as given by the maintenance team on 2026-10-28). A machine from the list, or imported from a machine-list
// CSV, lives in S.machines[name] (cat: true) before it has any point; its values go to the first point that joins.
const PLANT_MACHINES=['ไฮดลอลิคยกดั๊มพ์ เบอร์ 1 (Hydraulic Truck Tipper No.1)','ไฮดลอลิคยกดั๊มพ์ เบอร์ 2 (Hydraulic Truck Tipper No.2)','ไฮดลอลิคยกดั๊มพ์ เบอร์ 3 (Hydraulic Truck Tipper No.3)',
  'ตะกาวโกยอ้อย เบอร์ 1 (Cane Rake No.1)','ตะกาวโกยอ้อย เบอร์ 2 (Cane Rake No.2)','สะพานดั๊มพ์ (Side Cane Carrier)','ใบเกลี่ยสะพานดั๊มพ์ (Cane Leveller for Side cane carrier)',
  'สะพานสิ่งไร้สาระ เบอร์ 1 (Sand conveyer No.1)','สะพานสิ่งไร้สาระ เบอร์ 2 (Sand conveyer No.2)','ใบเตะสะพานดั๊มพ์ เบอร์ 1 (Kicker No.1)','ใบเตะสะพานดั๊มพ์ เบอร์ 2 (Kicker No.2)',
  'สะพานเมน (Main cane carrier)','ใบมีด Precutter (Pre-cutter for main cane carrier)','ใบมีดสะพานเมน เบอร์ 1 (Cane cutter No.1)','ใบมีดสะพานเมน เบอร์ 2 (Cane cutter No.2)',
  'ใบเกลี่ยสะพานเมน (Cane Leveller for Main cane carrier)','ใบเตะสะพานเมน เบอร์ 3 (Kicker No.3)','แม่เหล็กก่อนลงเชร็ดเดอร์ (Magnetic separator (for Shredder))',
  'เชร็ดเดอร์ (Heavy Duty Shredder)','เทอร์ไบน์ (Turbine for Heavy Duty Shredder)','สะพานเชร็ดเดอร์ (Shredder Elevator)','สายพานยาง High speed belt (High speed belt)',
  'แม่เหล็กสำหรับสะพานยาง (Magnetic separator (for speed belt))','สะพานข้ามชุด เบอร์ 1 (Intermediate Carrier No.1)','สะพานข้ามชุด เบอร์ 2 (Intermediate Carrier No.2)',
  'สะพานข้ามชุด เบอร์ 3 (Intermediate Carrier No.3)','โรตารี่สกีน (Rotary screen)','รางสว่าน (Screw Conveyer)','ใบเกลี่ย High Speed Belt'];
function machineCatalog(){
  const inUse=Object.values(S.assets||{}).map(c=>(c.machine||'').trim()).filter(Boolean);
  return[...new Set([...PLANT_MACHINES,...Object.keys(S.machines||{}),...inUse])];
}
const catalogOptions=()=>machineCatalog().map(n=>`<option value="${esc(n)}">`).join('');
// a machine with no point yet: an entry in S.machines that the first point merges with (see machineShareSync)
function addCatalogMachine(name,data){
  name=String(name||'').trim();if(!name)return null;S.machines=S.machines||{};
  const M=S.machines[name]||(S.machines[name]={data:{},mt:Date.now(),cat:true});
  if(data){Object.assign(M.data,data);M.mt=Date.now()}
  return M;
}
// machine-list CSV: one row per machine, the machine-wide settings that every point of it shares
const MCAT_COLS=[['name',null],['tag','profile.tag'],['area','profile.area'],['location','profile.loc'],['type','profile.type'],['driver','spec.driver'],['kw','profile.kw'],['criticality','spec.crit'],['hours_per_day','spec.hoursDay'],['note','spec.note']];
function machineListCsv(){
  const q=v=>v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':String(v);
  const rows=machineCatalog().map(m=>{const M=(S.machines||{})[m],pt=Object.keys(S.assets||{}).find(a=>(S.assets[a].machine||'').trim()===m||(!S.assets[a].machine&&a===m));
    const d=M?M.data:pt?sharedSlice(S.assets[pt]):{};return MCAT_COLS.map(([k,p])=>k==='name'?m:d[p]).map(q).join(',')});
  return'﻿'+[MCAT_COLS.map(x=>x[0]).join(','),...rows].join('\n');
}
function machineListExport(){download('รายชื่อเครื่องจักร.csv',new Blob([machineListCsv()],{type:'text/csv'}));appLog('data','ส่งออกรายชื่อเครื่องจักร')}
async function machineListImport(file){
  const rows=parseCSV(await file.text());if(rows.length<2)return toast('ไฟล์ว่าง');
  const h=rows[0].map(x=>String(x).trim().toLowerCase().replace(/^﻿/,'')),col=k=>h.indexOf(k);if(col('name')<0)return toast('ไม่พบคอลัมน์ name');
  let n=0;
  for(const r of rows.slice(1)){const m=String(r[col('name')]||'').trim();if(!m)continue;const d={};
    for(const[k,p]of MCAT_COLS){const i=col(k);if(!p||i<0)continue;const raw=String(r[i]??'').trim();if(raw==='')continue;
      d[p]=p==='profile.kw'||p==='spec.hoursDay'?+raw:p==='spec.crit'?raw.toUpperCase():p==='spec.driver'?(/turb|เทอร์/i.test(raw)?'turbine':'motor'):raw}
    // a machine that already has points: the values go to every point (shared settings)
    const pts=Object.keys(S.assets||{}).filter(a=>(S.assets[a].machine||'').trim()===m);
    if(pts.length){for(const a of pts)for(const[p,v]of Object.entries(d))setPath(S.assets[a],p,v);if(S.machines&&S.machines[m]){Object.assign(S.machines[m].data,d);S.machines[m].mt=Date.now()}}
    else addCatalogMachine(m,d);
    n++}
  save();render();appLog('data',`นำเข้ารายชื่อเครื่องจักร ${n} เครื่อง จาก ${file.name}`);toast(`นำเข้ารายชื่อเครื่องจักรแล้ว ${n} เครื่อง`);
}
