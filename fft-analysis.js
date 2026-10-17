// "วิเคราะห์ FFT" page: spectrum tools on the FFT captures stored by the dashboard (FFTDB).
// Loaded before the dashboard script; uses its globals at call time (S, $, esc, cfg, FFTDB, decodeRec,
// specPoints, twfPoints, diagnose, diagHtml, opts, css, cv, uv, fv, dFull, ble, toast, KIND_LABEL).

const FA={keyA:null,keyB:'',mode:'spectrum',axis:'all',qty:'vel',band:'low',logY:false,fmin:null,fmax:null,
  marks:{harm:true,bearing:false,vane:false,line:false,drive:true},cur:{mode:'off',pts:[]},xu:'hz'};
let faCharts=[];
const faDecCache=new Map();
function faDecode(r){
  if(r.dec)return r.dec; // imported spectrum/time signal (CSV)
  if(!faDecCache.has(r.key)){try{faDecCache.set(r.key,decodeRec(r))}catch(e){faDecCache.set(r.key,null)}}
  return faDecCache.get(r.key);
}
const AXES=[['x','X (Vertical)'],['y','Y (Axial)'],['z','Z (Horizontal)']];

// Vertical marker lines with rotated labels (harmonics, bearing, vane pass, line frequency)
const faVlines={id:'faVlines',afterDatasetsDraw(chart,args,o){
  const L=o&&o.lines;if(!L||!L.length)return;
  const{ctx,chartArea:a,scales:{x}}=chart;ctx.save();ctx.font='10px "IBM Plex Sans Thai",sans-serif';
  for(const l of L){const px=x.getPixelForValue(l.x);if(px<a.left||px>a.right)continue;
    ctx.strokeStyle=l.color;ctx.globalAlpha=.75;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(px,a.top);ctx.lineTo(px,a.bottom);ctx.stroke();
    ctx.setLineDash([]);ctx.globalAlpha=1;ctx.fillStyle=l.color;ctx.save();ctx.translate(px+3,a.top+3);ctx.rotate(Math.PI/2);ctx.fillText(l.label,0,0);ctx.restore()}
  ctx.restore()}};

// Running speed (Hz): sensor RPM when live, else the RPM saved for this machine, else estimated from the spectrum
function faRunSpeed(dec,c,rec){
  const s=ble.live&&ble.cfg&&ble.cfg.asset===S.sel?ble.live.sys:null;
  if(c.vfd){ // variable speed: each capture has its own speed
    if(rec&&rec.rpm)return{f1:rec.rpm/60,src:'RPM ตอนวัดชุดนี้'};
    const d=dec?diagnose(dec,null,null,{}):null;if(d&&d.f1)return{f1:d.f1,src:'ประมาณจากชุดนี้ (VFD)'};
  }
  if(c.rpm)return{f1:c.rpm/60,src:'ตั้งค่าเอง'};
  if(rec&&rec.rpm)return{f1:rec.rpm/60,src:'RPM ตอนวัดชุดนี้'};
  if(s&&s.rpm)return{f1:s.rpm/60,src:'RPM จากเซนเซอร์'};
  const d=dec?diagnose(dec,null,null,{}):null;
  return d&&d.f1?{f1:d.f1,src:'ประมาณจากสเปกตรัม'}:{f1:null,src:''};
}
// Bearing defect frequencies from geometry: balls n, ball dia d, pitch dia D (same unit), contact angle deg
function bearingFreqs(f1,b){
  if(f1&&b&&b.fac&&b.fac.BPFO)return{FTF:b.fac.FTF*f1,BPFO:b.fac.BPFO*f1,BPFI:b.fac.BPFI*f1,BSF:b.fac.BSF*f1}; // catalogue factors (× RPM)
  if(!f1||!b||!(b.n>0&&b.d>0&&b.D>0))return null;
  const r=b.d/b.D*Math.cos((b.ang||0)*Math.PI/180);
  return{FTF:f1/2*(1-r),BPFO:b.n*f1/2*(1-r),BPFI:b.n*f1/2*(1+r),BSF:b.D/(2*b.d)*f1*(1-r*r)};
}
function faMarkers(f1,c,fmax){
  const k=css(),L=[];
  if(FA.marks.harm&&f1)for(let n=1;n<=10&&n*f1<=fmax;n++)L.push({x:n*f1,label:n+'X',color:k.muted});
  if(FA.marks.vane&&f1&&c.vanes>0)L.push({x:c.vanes*f1,label:`vane ${c.vanes}X`,color:k.r});
  if(FA.marks.line){L.push({x:50,label:'50 Hz',color:k.t});L.push({x:100,label:'100 Hz',color:k.t})}
  const bf=FA.marks.bearing?bearingFreqs(f1,c.bearing):null;
  if(bf)for(const[name,f]of Object.entries(bf))for(let h=1;h<=3&&h*f<=fmax;h++)L.push({x:h*f,label:h>1?`${h}×${name}`:name,color:k.zd});
  if(FA.marks.drive)L.push(...machineMarks(f1,c,fmax,k));
  L.push(...cursorLines(k));
  return L;
}
// Velocity = g / (2*pi*f): near 0 Hz this blows the noise floor up into large, meaningless values,
// so velocity views start at VEL_MIN_HZ (peaks, bands and the default zoom all respect it)
const VEL_MIN_HZ=2;
const faLowCut=()=>FA.qty==='vel'?VEL_MIN_HZ:0;
const faSpec=(dec,a,band=FA.band)=>specPoints(dec,band,FA.qty,a).filter(p=>p.x>=faLowCut());
// Combined spectrum envelope (max over shown axes) for peak search and band sums
function faEnvelope(dec,axes){
  const per=axes.map(a=>faSpec(dec,a));
  if(!per.length||!per[0].length)return[];
  return per[0].map((p,i)=>{let y=-1,ax=axes[0];per.forEach((s,j)=>{const v=s[i]&&s[i].y;if(Number.isFinite(v)&&v>y){y=v;ax=axes[j]}});return{x:p.x,y,ax}});
}
function faPeaks(pts,n=10){
  const cand=[];
  for(let i=2;i<pts.length-2;i++){const y=pts[i].y;
    if(y>0&&y>=pts[i-1].y&&y>=pts[i+1].y&&y>=pts[i-2].y&&y>=pts[i+2].y)cand.push(pts[i])}
  cand.sort((a,b)=>b.y-a.y);
  const sep=pts.length>1?(pts[1].x-pts[0].x)*4:1,out=[];
  for(const p of cand){if(out.every(q=>Math.abs(q.x-p.x)>sep))out.push(p);if(out.length>=n)break}
  return out;
}
const faRss=(pts,lo,hi)=>{let q=0;for(const p of pts)if(p.x>=lo&&p.x<hi&&Number.isFinite(p.y))q+=p.y*p.y;return Math.sqrt(q)};
function faWaveStats(a){
  const n=a.length;if(!n)return null;let m=0;for(const v of a)m+=v;m/=n;
  let s2=0,s4=0,pk=0,mx=-Infinity,mn=Infinity;
  for(const v of a){const d=v-m;s2+=d*d;s4+=d*d*d*d;pk=Math.max(pk,Math.abs(d));mx=Math.max(mx,v);mn=Math.min(mn,v)}
  const rms=Math.sqrt(s2/n);
  return{peak:pk,rms,crest:rms?pk/rms:0,p2p:mx-mn,kurt:s2?(s4/n)/((s2/n)**2):0};
}
function faBandOf(dec){return dec.single||(FA.band==='high'?dec.high:dec.low)||dec.low}
function faFreqRange(dec){
  const pts=faSpec(dec,'x');
  const lo=pts.length?pts[0].x:0,hi=pts.length?pts[pts.length-1].x:1;
  return{lo,hi,min:FA.fmin!=null?FA.fmin:lo,max:FA.fmax!=null?FA.fmax:hi};
}

async function renderFFTPage(){
  const el=$('#fftPage');if(!el||el.hidden)return;
  let list=[];try{list=await FFTDB.list(S.sel)}catch(e){}
  if($('#fftPage').hidden)return;
  faCharts.forEach(c=>c.destroy());faCharts=[];
  if(!S.sel||!list.length){
    el.innerHTML=`<div class="panel empty"><h2>ยังไม่มีข้อมูล FFT${S.sel?' ของ '+esc(S.sel):''}</h2>
      <p>ไปที่เมนู "ภาพรวม" เชื่อมต่อเซนเซอร์ แล้วในแผงค่าสดกด "สั่งวัด FFT ใหม่", "ดึง FFT manual ล่าสุด" หรือ "ดึง FFT ตอน alarm" ข้อมูลที่ได้จะมาแสดงในเมนูนี้</p>
      <button class="btn primary" onclick="setView('overview')">ไปที่ภาพรวม</button></div>`;
    return;
  }
  const recA=list.find(r=>r.key===FA.keyA)||list[0];FA.keyA=recA.key;
  const recB=FA.keyB?list.find(r=>r.key===FA.keyB&&r.key!==recA.key):null;
  const decA=faDecode(recA),decB=recB?faDecode(recB):null;
  if(!decA){el.innerHTML='<div class="panel empty"><h2>ถอดข้อมูล FFT ชุดนี้ไม่ได้</h2></div>';return}
  const hasHigh=!!(decA.high&&decA.high.startBin!=null);
  if(decA.single||(!hasHigh&&FA.band!=='low'))FA.band='low';
  const c=cfg(S.sel),{f1,src}=faRunSpeed(decA,c,recA),range=faFreqRange(decA);
  const opt=(v,l,cur)=>`<option value="${esc(v)}" ${v===cur?'selected':''}>${esc(l)}</option>`;
  const seg=(id,items,cur)=>`<div class="seg" id="${id}">${items.map(([v,l])=>`<button data-v="${v}" class="${v===cur?'on':''}">${l}</button>`).join('')}</div>`;
  const recLabel=(r,i)=>`${r.key===c.refFft?'★ ':''}${KIND_LABEL[r.kind||'alarm']||r.kind}${r.tag==='bump'?' (bump test)':''}${r.src?' '+r.src:''} · ${dFull(r.ts*1000)}${i===0?' (ล่าสุด)':''}`;
  const b=c.bearing||{};
  el.innerHTML=`
  <div class="mainhead"><h2>วิเคราะห์ FFT · ${esc(S.sel)}</h2>
    ${seg('faMode',FA_MODES,FA.mode)}</div>
  <div class="panel fa-ctl">
    <label>ชุดข้อมูล<span class="row" style="flex-wrap:nowrap;gap:6px"><select id="faA" style="flex:1;min-width:0">${list.map((r,i)=>opt(r.key,recLabel(r,i),recA.key)).join('')}</select><button type="button" class="btn sm" id="faDel" title="ลบชุดข้อมูล FFT ที่ไม่ต้องการ">🗑 ลบ…</button></span></label>
    <label>เปรียบเทียบกับ<select id="faB"><option value="">— ไม่เทียบ —</option>${list.filter(r=>r.key!==recA.key).map(r=>opt(r.key,recLabel(r,list.indexOf(r)),FA.keyB)).join('')}</select></label>
    <label>แกน${seg('faAxis',[['all','ทุกแกน'],['x','X'],['y','Y'],['z','Z']],FA.axis)}</label>
    <label>ปริมาณ${seg('faQty',[['vel','Velocity'],['acc','Acceleration']],FA.qty)}</label>
    ${decA.single?'':`<label>ช่วงความถี่ของข้อมูล<select id="faBand">${opt('low','ต่ำ (ละเอียด)',FA.band)}${hasHigh?opt('high','สูง',FA.band)+opt('combined','รวม',FA.band):''}</select></label>`}
    <label>สเกลแกนตั้ง${seg('faLog',[['lin','Linear'],['log','Log']],FA.logY?'log':'lin')}</label>
    <label class="fa-range">ซูมความถี่ (Hz)<span><input type="number" id="faMin" placeholder="${Math.round(range.lo)}" value="${FA.fmin??''}"> – <input type="number" id="faMax" placeholder="${Math.round(range.hi)}" value="${FA.fmax??''}"></span>
      <span class="fa-presets">${f1?`<button class="btn sm" data-r="0,${Math.ceil(f1*5)}">0–5X</button><button class="btn sm" data-r="0,${Math.ceil(f1*12)}">0–12X</button>`:''}<button class="btn sm" data-r="0,1000">0–1 kHz</button><button class="btn sm" data-r="">ทั้งหมด</button></span></label>
    <label>ความเร็วรอบ 1X<span class="fa-rpm"><input type="number" id="faRpm" value="${f1?Math.round(f1*60):''}" placeholder="RPM"> RPM <small class="muted">${f1?`= ${f1.toFixed(2)} Hz · ${src}`:'ไม่ทราบ'}</small></span></label>
  </div>
  <div class="panel fa-ctl fa-marks">
    <span class="sub-h">เส้นบอกความถี่</span>
    <label class="check"><input type="checkbox" data-m="harm" ${FA.marks.harm?'checked':''}> Harmonics 1X–10X</label>
    <label class="check"><input type="checkbox" data-m="line" ${FA.marks.line?'checked':''}> ไฟฟ้า 50/100 Hz</label>
    <label class="check"><input type="checkbox" data-m="vane" ${FA.marks.vane?'checked':''}> Vane pass ใบพัด <input type="number" id="faVanes" value="${c.vanes||''}" placeholder="จำนวนใบ" style="width:80px"></label>
    <label class="check"><input type="checkbox" data-m="drive" ${FA.marks.drive?'checked':''}> มอเตอร์/เกียร์/สายพาน ${c.drive&&(c.drive.poles||c.drive.teeth||c.drive.beltRatio)?'':'<small class="muted">(ตั้งในหน้าข้อมูลเครื่อง)</small>'}</label>
    <label class="check"><input type="checkbox" data-m="bearing" ${FA.marks.bearing?'checked':''}> Bearing: ลูก <input type="number" id="faBn" value="${b.n||''}" style="width:56px"> Ø ลูก <input type="number" step="any" id="faBd" value="${b.d||''}" style="width:64px"> Ø pitch <input type="number" step="any" id="faBD" value="${b.D||''}" style="width:64px"> มุม° <input type="number" step="any" id="faBa" value="${b.ang??0}" style="width:52px"></label>
  </div>
  <div class="panel fa-ctl fa-tools">
    <label>Cursor${seg('faCur',[['off','ปิด'],['harm','Harmonic'],['side','Sideband'],['delta','Delta']],FA.cur.mode)}</label>
    <span class="row"><button class="btn sm" id="faFindH">หา harmonics</button><button class="btn sm" id="faFindS">หา sidebands</button></span>
    <label>แกนนอน${seg('faXu',[['hz','Hz'],['cpm','CPM'],['order','× รอบ']],FA.xu)}</label>
    <span class="row"><button class="btn sm" id="faRef">${c.refFft===recA.key?'★ ชุดอ้างอิงอยู่แล้ว':'ตั้งชุดนี้เป็นอ้างอิง'}</button>${c.refFft?'<label class="check" style="font-size:12px">เส้นอ้างอิง ×<input type="number" step="0.5" id="faMaskMul" value="'+(c.maskMul||2)+'" style="width:56px"></label>':''}</span>
    <span class="row"><button class="btn sm" id="faPlay" title="เล่น waveform เป็นเสียง">▶ ฟังเสียง</button><button class="btn sm" id="faImp">นำเข้า FFT/Time CSV</button></span>
    <span class="muted" id="faCurInfo" style="font-size:12px;flex-basis:100%">${cursorInfo(f1)}</span>
  </div>
  <div class="panel"><div class="cbox fa-main"><canvas id="faChart"></canvas></div><p class="muted fa-note" id="faNote"></p></div>
  <div class="fa-grid" id="faSide"></div>`;
  faBind(list);
  (FA_FN()[FA.mode]||faSpectrum)(decA,decB,recA,recB,list,f1,c,range);
  faAfterRender(decA,recA,list,f1,c);
}

function faBind(list){
  const re=()=>renderFFTPage();
  const segBind=(id,fn)=>document.querySelectorAll('#'+id+' button').forEach(b=>b.onclick=()=>{fn(b.dataset.v);re()});
  segBind('faMode',v=>{FA.mode=v;cancelAnimationFrame(motionAnim)});segBind('faCur',v=>{FA.cur={mode:v,pts:[]}});segBind('faXu',v=>FA.xu=v);segBind('faAxis',v=>FA.axis=v);segBind('faQty',v=>FA.qty=v);segBind('faLog',v=>FA.logY=v==='log');
  $('#faA').onchange=e=>{FA.keyA=e.target.value;if(FA.keyB===FA.keyA)FA.keyB='';re()};
  $('#faDel').onclick=()=>faManageDelete(list,FA.keyA);
  $('#faB').onchange=e=>{FA.keyB=e.target.value;re()};
  if($('#faBand'))$('#faBand').onchange=e=>{FA.band=e.target.value;FA.fmin=FA.fmax=null;re()};
  const num=v=>v===''?null:+v;
  $('#faMin').onchange=e=>{FA.fmin=num(e.target.value);re()};
  $('#faMax').onchange=e=>{FA.fmax=num(e.target.value);re()};
  document.querySelectorAll('.fa-presets button').forEach(b=>b.onclick=()=>{const[a,z]=b.dataset.r?b.dataset.r.split(',').map(Number):[null,null];FA.fmin=a;FA.fmax=z;re()});
  const c=cfg(S.sel);
  $('#faRpm').onchange=e=>{c.rpm=num(e.target.value)||null;save();re()};
  document.querySelectorAll('.fa-marks input[data-m]').forEach(i=>i.onchange=()=>{FA.marks[i.dataset.m]=i.checked;re()});
  $('#faVanes').onchange=e=>{c.vanes=num(e.target.value);if(c.vanes)FA.marks.vane=true;save();re()};
  ['faBn','faBd','faBD','faBa'].forEach(id=>$('#'+id).onchange=()=>{
    c.bearing={n:num($('#faBn').value),d:num($('#faBd').value),D:num($('#faBD').value),ang:num($('#faBa').value)||0};
    if(bearingFreqs(1,c.bearing))FA.marks.bearing=true;save();re()});
}
function faAxes(){return FA.axis==='all'?['x','y','z']:[FA.axis]}
function faChartOpts(yTitle,range){
  const k=css(),o=opts(yTitle),f1=FA._f1;
  const xu=FA.xu==='order'&&!f1?'hz':FA.xu,tick=v=>xu==='cpm'?Math.round(v*60).toLocaleString():xu==='order'?(v/f1).toFixed(1)+'X':v;
  o.scales.x={type:'linear',min:range.min,max:range.max,title:{display:true,text:xu==='cpm'?'ความถี่ (CPM)':xu==='order'?'เท่าของรอบ (order)':'ความถี่ (Hz)',color:k.muted},ticks:{color:k.muted,callback:tick},grid:{color:k.line}};
  if(FA.logY){o.scales.y.type='logarithmic';o.scales.y.beginAtZero=false}
  o.plugins.tooltip.callbacks.title=it=>{if(!it.length)return'';const x=it[0].parsed.x;return x.toFixed(2)+' Hz · '+Math.round(x*60)+' CPM'+(f1?' · '+(x/f1).toFixed(2)+'X':'')};
  return o;
}
const faUnit=()=>FA.qty==='acc'?'g':uv();
const faFmt=v=>FA.qty==='acc'?(+v).toFixed(4):(+v).toFixed(3);
const faLogSafe=pts=>FA.logY?pts.map(p=>({x:p.x,y:p.y>0?p.y:null})):pts;

// ---- spectrum: main view with markers, peak table, band breakdown, waveform stats, diagnosis ----
function faSpectrum(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),col={x:k.x,y:k.y,z:k.z},axes=faAxes(),ds=[];
  axes.forEach(a=>ds.push({label:(decB?'A ':'')+AXES.find(x=>x[0]===a)[1],data:faLogSafe(faSpec(decA,a)),borderColor:col[a],backgroundColor:col[a],borderWidth:1.2,pointRadius:0,tension:0}));
  if(decB)axes.forEach(a=>ds.push({label:'B '+AXES.find(x=>x[0]===a)[1],data:faLogSafe(faSpec(decB,a)),borderColor:col[a],backgroundColor:col[a],borderWidth:1.2,borderDash:[5,4],pointRadius:0,tension:0}));
  // reference spectrum mask (velocity): line + points above it
  const refRec=c.refFft&&c.refFft!==recA.key?list.find(r=>r.key===c.refFft):null,refDec=refRec&&faDecode(refRec);
  const mask=refDec&&FA.qty==='vel'?refMask(refDec,c):null,ex=mask?maskExceed(decA,mask):[];
  if(mask){ds.push({label:`เส้นอ้างอิง ×${c.maskMul||2}`,data:faLogSafe(mask.map(p=>({x:p.x,y:cv(p.y)}))),borderColor:k.zd,backgroundColor:k.zd,borderWidth:1,borderDash:[3,3],pointRadius:0,tension:0,isRef:true});
    if(ex.length)ds.push({label:'เกินเส้นอ้างอิง',type:'scatter',data:ex.map(e=>({x:e.x,y:cv(e.y)})),borderColor:k.zd,backgroundColor:k.zd,pointRadius:5,pointStyle:'triangle'})}
  const o=faChartOpts(faUnit(),range);o.plugins.faVlines={lines:faMarkers(f1,c,range.max)};
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  $('#faNote').textContent=(mask?`เทียบกับชุดอ้างอิง ${dFull(refRec.ts*1000)}: ${ex.length?'เกิน '+ex.length+' ยอด':'ไม่มียอดเกิน'} · `:'')+(decB?`A = ${dFull(recA.ts*1000)} (เส้นทึบ) · B = ${dFull(recB.ts*1000)} (เส้นประ) · `:'')+'ซูมด้วยช่อง "ซูมความถี่" หรือปุ่มลัด · ชี้หรือแตะบนกราฟเพื่อดูค่า'+(FA.qty==='vel'?` · velocity แสดงตั้งแต่ ${VEL_MIN_HZ} Hz ขึ้นไป (ต่ำกว่านั้นเป็น noise ที่ถูกขยายจากการแปลงหน่วย)`:'');

  const env=faEnvelope(decA,axes).filter(p=>p.x>=range.min&&p.x<=range.max);
  const marks=faMarkers(f1,c,range.max*1.1);
  const nameOf=f=>{const bin=env.length>1?env[1].x-env[0].x:1;let best=null;
    for(const m of marks){const tol=Math.max(2*bin,m.x*0.02);if(Math.abs(m.x-f)<=tol&&(!best||Math.abs(m.x-f)<Math.abs(best.x-f)))best=m}
    return best?best.label:''};
  const peaks=faPeaks(env,10);
  const peakRows=peaks.map((p,i)=>`<tr><td>${i+1}</td><td class="num">${p.x.toFixed(2)}</td><td class="num">${faFmt(p.y)}</td><td>${p.ax.toUpperCase()}</td><td class="num">${f1?(p.x/f1).toFixed(2)+'X':'–'}</td><td>${nameOf(p.x)}</td></tr>`).join('');
  // Band breakdown in multiples of running speed (velocity bands mean most for low-frequency faults)
  const full=faEnvelope(decA,axes),bands=[];
  if(f1){bands.push(['Sub-sync (< 0.8X)',0,0.8*f1,'หลวมมาก / oil whirl / การไหล'],['1X',0.8*f1,1.2*f1,'ไม่สมดุล'],['2X',1.8*f1,2.2*f1,'แนวเพลาไม่ตรง'],
    ['3X–10X',2.8*f1,10.2*f1,'หลวม / vane pass'],['> 10X',10.2*f1,Infinity,'bearing / gear / การไหล'])}
  if(decA.high&&decA.high.startBin!=null)bands.push(['1–5 kHz (ช่วงสูง)',1000,5001,'ตลับลูกปืน / หล่อลื่น']);
  const tot=faRss(full,0,Infinity)||1e-12;
  const bandRows=bands.map(([n,lo,hi,m])=>{
    const src=n.startsWith('1–5')?faEnvelopeBand(decA,axes,'high'):full,v=faRss(src,lo,hi);
    return`<tr><td>${n}</td><td class="num">${faFmt(v)}</td><td class="num">${src===full?Math.round(v*v/(tot*tot)*100)+'%':'–'}</td><td class="muted">${m}</td></tr>`}).join('');
  const B=faBandOf(decA),stats=B&&B.twf?axes.map(a=>[a,faWaveStats(B.twf[a])]).filter(x=>x[1]):[];
  const statRows=stats.map(([a,s])=>`<tr><td>${a.toUpperCase()}</td><td class="num">${s.peak.toFixed(3)}</td><td class="num">${s.rms.toFixed(3)}</td><td class="num">${s.crest.toFixed(2)}</td><td class="num">${s.kurt.toFixed(2)}</td></tr>`).join('');
  const live=ble.live&&ble.cfg&&ble.cfg.asset===S.sel?ble.live.sys:null;
  $('#faSide').innerHTML=`
    <div class="panel"><div class="ph"><h3>ยอดสูงสุด 10 อันดับ (${faUnit()})</h3><button class="btn sm" id="faCsv">ส่งออก CSV</button></div>
      <div class="tablewrap"><table><thead><tr><th>#</th><th>Hz</th><th>ขนาด</th><th>แกน</th><th>เท่าของ 1X</th><th>ตรงกับ</th></tr></thead><tbody>${peakRows||'<tr><td colspan="6" class="muted">ไม่พบยอด</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="ph"><h3>พลังงานตามช่วงความถี่ (${faUnit()})</h3></div>
      <div class="tablewrap"><table><thead><tr><th>ช่วง</th><th>ค่ารวม</th><th>สัดส่วน</th><th>มักบ่งบอก</th></tr></thead><tbody>${bandRows||'<tr><td colspan="4" class="muted">ใส่ RPM เพื่อแบ่งช่วงตาม 1X</td></tr>'}</tbody></table></div>
      ${stats.length?`<div class="ph"><h3>Waveform (g) · ${FA.band==='high'?'ช่วงสูง':'ช่วงต่ำ'}</h3></div><div class="tablewrap"><table><thead><tr><th>แกน</th><th>Peak</th><th>RMS</th><th>Crest</th><th>Kurtosis</th></tr></thead><tbody>${statRows}</tbody></table></div>
      <p class="muted fa-note">Crest factor > 5 หรือ kurtosis > 4 มักบ่งบอกแรงกระแทก (bearing/การหลวม)</p>`:''}</div>
    <div class="panel fa-diag">${diagHtml(diagnose(decA,f1?f1*60:null,live?live.kurt:null,c))}</div>
    <div class="panel"><div class="ph"><h3>ดัชนีความผิดปกติ (แบบ FASIT)</h3></div><div class="pbody">${faultBarsHtml(faultIndices(decA,c,f1))}</div></div>
    ${mask?`<div class="panel"><div class="ph"><h3>ยอดที่เกินเส้นอ้างอิง (${ex.length})</h3></div><div class="tablewrap"><table><thead><tr><th>Hz</th><th>แกน</th><th>ค่า (mm/s)</th><th>เส้นอ้างอิง</th><th>เท่า</th><th>เท่าของรอบ</th></tr></thead><tbody>
      ${ex.map(e=>`<tr><td class="num">${e.x.toFixed(1)}</td><td>${e.ax.toUpperCase()}</td><td class="num">${e.y.toFixed(3)}</td><td class="num">${e.m.toFixed(3)}</td><td class="num up">${e.r.toFixed(1)}×</td><td class="num">${f1?(e.x/f1).toFixed(2)+'X':'–'}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">ไม่มียอดเกินเส้นอ้างอิง</td></tr>'}</tbody></table></div></div>`:''}`;
  $('#faCsv').onclick=()=>faExportCsv(decA,recA);
}
function faEnvelopeBand(dec,axes,band){const keep=FA.band;FA.band=band;const e=faEnvelope(dec,axes);FA.band=keep;return e}
function faExportCsv(dec,rec){
  const cols=['x','y','z'].map(a=>faSpec(dec,a));
  const lines=[`freq_hz,x_${FA.qty==='acc'?'g':uv().replace('/','_')},y,z`].concat(cols[0].map((p,i)=>[p.x.toFixed(3),...cols.map(cc=>cc[i]?cc[i].y:'')].join(',')));
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv'}));
  a.download=`fft-${S.sel}-${new Date(rec.ts*1000).toISOString().slice(0,16).replace(/[:T]/g,'')}.csv`;a.click();
}

// ---- waterfall: newest captures stacked with a vertical offset ----
function faWaterfall(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),recs=list.slice(0,12).reverse(),axes=faAxes(),series=[];
  for(const r of recs){const d=faDecode(r);if(!d)continue;series.push({r,pts:faEnvelope(d,axes)})}
  let top=0;series.forEach(s=>s.pts.forEach(p=>{if(p.x>=range.min&&p.x<=range.max&&p.y>top)top=p.y}));
  const step=top*0.6||1,palette=[k.x,k.z,k.y,k.r,k.t,k.zb];
  const ds=series.map((s,i)=>({label:dFull(s.r.ts*1000)+' · '+KIND_LABEL[s.r.kind||'alarm'],data:s.pts.map(p=>({x:p.x,y:p.y+i*step})),
    borderColor:palette[i%palette.length],backgroundColor:palette[i%palette.length],borderWidth:1.1,pointRadius:0,tension:0,raw:s.pts}));
  const o=faChartOpts(faUnit()+' (เลื่อนระดับตามลำดับเวลา)',range);o.scales.y.ticks.display=false;o.scales.y.type='linear';
  o.plugins.tooltip.callbacks.label=it=>`${it.dataset.label}: ${faFmt(it.dataset.raw[it.dataIndex].y)} ${faUnit()}`;
  o.plugins.faVlines={lines:faMarkers(f1,c,range.max)};
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  $('#faNote').textContent=`แสดง ${series.length} ชุดล่าสุด เก่าอยู่ล่าง ใหม่อยู่บน (ค่าสูงสุดของแกนที่เลือก) · ดูว่ายอดที่ความถี่เดิมสูงขึ้นเรื่อย ๆ หรือมียอดใหม่เกิดขึ้น`;
  $('#faSide').innerHTML='<div class="panel pbody" style="grid-column:1/-1"><div class="seg" id="wfMode"><button data-v="3d">3D</button><button data-v="2d" class="on">2D</button></div></div>';
  document.querySelectorAll('#wfMode button').forEach(b=>b.onclick=()=>{FA.wf2d=b.dataset.v==='2d';renderFFTPage()});
}

// ---- frequency trend: amplitude at 1X/2X/3X and high-frequency energy across captures ----
function faTrend(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),axes=faAxes(),recs=list.slice().reverse(),rows=[];
  for(const r of recs){const d=faDecode(r);if(!d)continue;const env=faEnvelope(d,axes);
    const at=h=>{if(!f1)return null;const f=h*f1,bin=env.length>1?env[1].x-env[0].x:1;let m=0;for(const p of env)if(Math.abs(p.x-f)<=Math.max(2*bin,f*0.02))m=Math.max(m,p.y);return m};
    const hi=d.high&&d.high.startBin!=null?faRss(faEnvelopeBand(d,axes,'high'),1000,5001):null;
    rows.push({t:r.ts*1000,r,x1:at(1),x2:at(2),x3:at(3),all:faRss(env,0,Infinity),hi})}
  const line=(label,color,key)=>({label,data:rows.filter(v=>v[key]!=null).map(v=>({x:v.t,y:v[key]})),borderColor:color,backgroundColor:color,borderWidth:1.6,pointRadius:3,tension:.2});
  const ds=[line('ค่ารวมทั้งช่วง',k.muted,'all')];
  if(f1)ds.unshift(line('1X',k.x,'x1'),line('2X',k.y,'x2'),line('3X',k.z,'x3'));
  if(rows.some(v=>v.hi!=null))ds.push(line('1–5 kHz',k.zd,'hi'));
  const o=opts(faUnit());
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o}));
  $('#faNote').textContent=f1?`ค่าที่ 1X/2X/3X ใช้ความเร็วรอบ ${Math.round(f1*60)} RPM กับทุกชุด · ค่า 1–5 kHz จากช่วงความถี่สูง (เพิ่มขึ้นต่อเนื่อง = สัญญาณ bearing)`:'ใส่ RPM เพื่อดูแนวโน้มที่ 1X/2X/3X';
  $('#faSide').innerHTML=`<div class="panel" style="grid-column:1/-1"><div class="ph"><h3>ตารางแนวโน้ม (${faUnit()})</h3></div><div class="tablewrap"><table>
    <thead><tr><th>วัดเมื่อ</th><th>ชนิด</th><th>1X</th><th>2X</th><th>3X</th><th>ทั้งช่วง</th><th>1–5 kHz</th></tr></thead><tbody>
    ${rows.slice().reverse().map(v=>`<tr><td>${dFull(v.t)}</td><td>${KIND_LABEL[v.r.kind||'alarm']}</td>${['x1','x2','x3','all','hi'].map(key=>`<td class="num">${v[key]==null?'–':faFmt(v[key])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---- waveform: time signal with statistics, optional overlay of the comparison capture ----
function faWave(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),col={x:k.x,y:k.y,z:k.z},axes=faAxes(),ds=[];
  axes.forEach(a=>ds.push({label:(decB?'A ':'')+AXES.find(x=>x[0]===a)[1],data:twfPoints(decA,FA.band,a),borderColor:col[a],backgroundColor:col[a],borderWidth:1,pointRadius:0,tension:0}));
  if(decB)axes.forEach(a=>ds.push({label:'B '+AXES.find(x=>x[0]===a)[1],data:twfPoints(decB,FA.band,a),borderColor:col[a],backgroundColor:col[a],borderWidth:1,borderDash:[4,3],pointRadius:0,tension:0}));
  const o=opts('g');o.scales.y.beginAtZero=false;
  o.scales.x={type:'linear',title:{display:true,text:'เวลา (ms)',color:k.muted},ticks:{color:k.muted},grid:{color:k.line}};
  if(f1){ // mark one revolution so impacts per turn are easy to count
    const rev=1000/f1;o.plugins.faVlines={lines:Array.from({length:8},(_,i)=>({x:(i+1)*rev,label:`รอบที่ ${i+1}`,color:k.muted}))};
  }
  o.plugins.tooltip.callbacks.title=it=>it.length?it[0].parsed.x.toFixed(2)+' ms':'';
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  const B=faBandOf(decA);
  $('#faNote').textContent=`Waveform ช่วง${FA.band==='high'?'สูง':'ต่ำ'} · ${B&&B.twfSampleRate?Math.round(B.twfSampleRate)+' ค่า/วินาที':''}${f1?' · เส้นประ = ทุก 1 รอบเพลา':''} · แรงกระแทกเป็นจังหวะ (ยอดแหลมซ้ำ ๆ) มักมาจาก bearing หรือการหลวม`;
  const stats=(d,tag)=>{const BB=faBandOf(d);return BB&&BB.twf?axes.map(a=>{const s=faWaveStats(BB.twf[a]);return s?`<tr><td>${tag}${a.toUpperCase()}</td><td class="num">${s.peak.toFixed(3)}</td><td class="num">${s.p2p.toFixed(3)}</td><td class="num">${s.rms.toFixed(3)}</td><td class="num">${s.crest.toFixed(2)}</td><td class="num">${s.kurt.toFixed(2)}</td></tr>`:''}).join(''):''};
  $('#faSide').innerHTML=`<div class="panel" style="grid-column:1/-1"><div class="ph"><h3>สถิติ waveform (g)</h3></div><div class="tablewrap"><table>
    <thead><tr><th>แกน</th><th>Peak</th><th>Peak-Peak</th><th>RMS</th><th>Crest factor</th><th>Kurtosis</th></tr></thead><tbody>${stats(decA,decB?'A ':'')}${decB?stats(decB,'B '):''}</tbody></table></div>
    <p class="muted fa-note">Crest factor = Peak/RMS (ปกติราว 3 สำหรับสัญญาณเรียบ) · Kurtosis ≈ 3 = ปกติ, > 4 = มีแรงกระแทก</p></div>`;
}

// ---- envelope (demodulation) spectrum for early bearing damage (#14) ----
// Band-pass the waveform around the structural resonance, take the Hilbert envelope (analytic signal
// built in the frequency domain), then the spectrum of that envelope. Repeating impacts from a bearing
// defect show up at BPFO/BPFI/BSF/FTF and their harmonics, long before they are visible in the normal FFT.
function fftC(re,im,inv){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
  for(let len=2;len<=n;len<<=1){const ang=2*Math.PI/len*(inv?1:-1),wr=Math.cos(ang),wi=Math.sin(ang),h=len>>1;
    for(let i=0;i<n;i+=len){let cr=1,ci=0;
      for(let k=0;k<h;k++){const a=i+k,b=a+h,tr=re[b]*cr-im[b]*ci,ti=re[b]*ci+im[b]*cr;
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t}}}
  if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n}
}
function envSpectrum(x,fs,lo,hi){
  let n=1;while(n*2<=x.length)n*=2;if(n<64)return null;
  const re=new Float64Array(n),im=new Float64Array(n);let m=0;
  for(let i=0;i<n;i++)m+=x[i];m/=n;for(let i=0;i<n;i++)re[i]=x[i]-m;
  fftC(re,im,false);
  const df=fs/n;
  for(let k=0;k<n;k++){const keep=k>0&&k<n/2&&k*df>=lo&&k*df<=hi;if(keep){re[k]*=2;im[k]*=2}else{re[k]=0;im[k]=0}}
  fftC(re,im,true);
  const env=new Float64Array(n);let em=0,es=0;
  for(let i=0;i<n;i++){env[i]=Math.hypot(re[i],im[i]);em+=env[i]}em/=n;
  for(let i=0;i<n;i++)es+=(env[i]-em)**2;
  const r2=new Float64Array(n),i2=new Float64Array(n);
  for(let i=0;i<n;i++)r2[i]=(env[i]-em)*(0.5-0.5*Math.cos(2*Math.PI*i/(n-1)));
  fftC(r2,i2,false);
  const pts=[];for(let k=1;k<n/2;k++)pts.push({x:k*df,y:4*Math.hypot(r2[k],i2[k])/n}); // x2 one-sided, /0.5 Hann gain
  return{pts,df,n,fs,mean:em,rms:Math.sqrt(es/n)};
}
const ENV_FAULT={BPFO:'รอยที่รางนอก (outer race)',BPFI:'รอยที่รางใน (inner race)',BSF:'ลูกปืน/ลูกกลิ้งเสีย (rolling element)',FTF:'รังลูกปืน (cage)'};
function faEnv(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),col={x:k.x,y:k.y,z:k.z},axes=faAxes();
  const B=decA.high&&decA.high.twf&&decA.high.twfSampleRate?decA.high:faBandOf(decA);
  if(!B||!B.twf||!B.twfSampleRate){$('#faNote').textContent='ชุดนี้ไม่มี waveform สำหรับทำ envelope';$('#faSide').innerHTML='';return}
  const fs=B.twfSampleRate,nyq=fs/2;
  if(FA.envLo==null||FA.envHi==null||FA.envHi>nyq){FA.envLo=Math.round(nyq*0.2);FA.envHi=Math.round(nyq*0.9)}
  const bf=bearingFreqs(f1,c.bearing),fmaxE=Math.min(nyq*0.5,Math.max(200,bf?bf.BPFI*4:f1?f1*12:400));
  const res=axes.map(a=>[a,envSpectrum(B.twf[a],fs,FA.envLo,FA.envHi)]).filter(x=>x[1]);
  if(!res.length){$('#faNote').textContent='waveform สั้นเกินไปสำหรับ envelope';return}
  const ds=res.map(([a,e])=>({label:AXES.find(x=>x[0]===a)[1],data:e.pts.filter(p=>p.x<=fmaxE),borderColor:col[a],backgroundColor:col[a],borderWidth:1.2,pointRadius:0,tension:0}));
  const L=[];
  if(f1)for(let n=1;n<=4&&n*f1<=fmaxE;n++)L.push({x:n*f1,label:n+'X',color:k.muted});
  if(bf)for(const[name,f]of Object.entries(bf))for(let h=1;h<=3&&h*f<=fmaxE;h++)L.push({x:h*f,label:h>1?`${h}×${name}`:name,color:k.zd});
  const o=opts('gE');o.scales.x={type:'linear',min:0,max:fmaxE,title:{display:true,text:'ความถี่ของ envelope (Hz)',color:k.muted},ticks:{color:k.muted},grid:{color:k.line}};
  o.plugins.tooltip.callbacks.title=it=>it.length?it[0].parsed.x.toFixed(2)+' Hz':'';o.plugins.faVlines={lines:L};
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  const df=res[0][1].df;
  $('#faNote').textContent=`กรองช่วง ${FA.envLo}–${FA.envHi} Hz จาก waveform ${B===decA.high?'ช่วงสูง':'ช่วงต่ำ'} (${Math.round(fs)} ค่า/วินาที, ${res[0][1].n} ค่า) · ความละเอียด ${df.toFixed(2)} Hz${bf?'':' · ใส่ข้อมูล bearing (ด้านบน หรือหน้าข้อมูลเครื่อง) เพื่อดูเส้น BPFO/BPFI'}`;
  // automatic check: energy at each defect frequency and its harmonics vs. the spectrum's median level
  const finds=[];
  if(bf)for(const[a,e]of res){
    const ys=e.pts.filter(p=>p.x<=fmaxE).map(p=>p.y).sort((x,y)=>x-y),med=ys[Math.floor(ys.length/2)]||1e-12;
    const at=f=>{let m=0;for(const p of e.pts)if(Math.abs(p.x-f)<=Math.max(2*e.df,f*0.03))m=Math.max(m,p.y);return m};
    for(const[name,f]of Object.entries(bf)){if(f>fmaxE)continue;
      const r=[1,2,3].map(h=>h*f<=nyq/2?at(h*f)/med:0),hits=r.filter(v=>v>=3).length;
      if(r[0]>=6||hits>=2)finds.push({a,name,f,r,level:r[0]>=10||hits>=3?'สูง':'ปานกลาง'})}
  }
  finds.sort((x,y)=>y.r[0]-x.r[0]);
  const best=new Map();finds.forEach(fd=>{if(!best.has(fd.name))best.set(fd.name,fd)});
  $('#faSide').innerHTML=`
    <div class="panel"><div class="ph"><h3>ตั้งค่า envelope</h3></div><div class="form">
      <label>กรองตั้งแต่ (Hz)<input type="number" id="envLo" value="${FA.envLo}"></label><label>ถึง (Hz)<input type="number" id="envHi" value="${FA.envHi}"></label>
      <p class="full muted" style="margin:0;font-size:12px">เลือกช่วงความถี่สูงที่แรงกระแทกไปกระตุ้น (มักเป็นช่วงกว้าง ๆ ใกล้ครึ่งบนของช่วงที่มี) waveform สูงสุด ${Math.round(nyq)} Hz</p>
      <p class="full" style="margin:0;font-size:13px">ระดับ envelope (RMS): ${res.map(([a,e])=>`${a.toUpperCase()} ${e.rms.toFixed(3)} gE`).join(' · ')}</p></div></div>
    <div class="panel fa-diag"><div class="diag"><div class="sub-h">ผลตรวจ bearing จาก envelope</div><ul>
      ${!bf?'<li><span class="tag">ข้อมูลไม่พอ</span> <span class="muted">ใส่ RPM และข้อมูล bearing ก่อน</span></li>'
        :best.size?[...best.values()].map(fd=>`<li><span class="tag ${fd.level==='สูง'?'zD':'zC'}">${fd.level}</span> <b>สงสัย${ENV_FAULT[fd.name]}</b><div class="muted">${fd.name} ${fd.f.toFixed(1)} Hz แกน ${fd.a.toUpperCase()} · สูงกว่าพื้น ${fd.r.map(v=>v.toFixed(1)+'×').join(' / ')} ที่ 1×/2×/3×</div></li>`).join('')
        :'<li><span class="tag zB">ไม่พบ</span> <span class="muted">ไม่มียอดเด่นที่ความถี่ bearing</span></li>'}
      </ul><p class="muted diag-note">ตรวจโดยเทียบยอดที่ความถี่ bearing (และ harmonic) กับระดับพื้นของสเปกตรัม ค่า bearing ที่ประมาณจากขนาดอาจคลาดเคลื่อน ±5–10% ควรยืนยันกับแคตตาล็อกและผู้เชี่ยวชาญ</p></div></div>`;
  const upd=()=>{const lo=+$('#envLo').value,hi=+$('#envHi').value;if(lo>0&&hi>lo){FA.envLo=lo;FA.envHi=Math.min(hi,nyq);renderFFTPage()}};
  $('#envLo').onchange=upd;$('#envHi').onchange=upd;
}

// ---- extra modes and shared controls (tools.js) ----
const FA_MODES=[['spectrum','สเปกตรัม'],['bands','แถบความถี่ + FASIT'],['waterfall','Waterfall 3D'],['sgram','Spectrograph'],['trend','แนวโน้มความถี่'],['wave','Waveform'],
  ['env','Envelope (bearing)'],['ceps','Cepstrum'],['acorr','Autocorrelation'],['circ','Circular'],['motion','3D / วงโคจร'],['bump','Bump test']];
const FA_FN=()=>({spectrum:faSpectrum,bands:faBands,waterfall:faWaterfallMode,sgram:faSgram,trend:faTrend,wave:faWave,env:faEnv,ceps:faCeps,acorr:faAcorr,circ:faCirc,motion:faMotion,bump:faBump});
function faAfterRender(decA,recA,list,f1,c){
  FA._f1=f1;
  const ch=faCharts[0];
  if(ch&&['spectrum','bump','env'].includes(FA.mode)){ // cursors: click on the spectrum
    ch.options.onClick=(e)=>{if(!FA.cur||FA.cur.mode==='off')return;const f=ch.scales.x.getValueForPixel(e.x);
      const pts=faEnvelope(decA,faAxes());if(cursorClick(f,pts)){ch.options.plugins.faVlines={lines:faMarkers(f1,c,ch.scales.x.max)};ch.update('none');$('#faCurInfo').textContent=cursorInfo(f1)}};
  }
  $('#faFindH').onclick=()=>{const fams=findHarmonics(faEnvelope(decA,faAxes()),f1);if(!fams.length)return toast('ไม่พบตระกูล harmonic ที่ชัดเจน');
    FA.cur={mode:'harm',pts:[fams[0].f0]};renderFFTPage().then(()=>{$('#faCurInfo').textContent=fams.map(F=>`${F.f0.toFixed(2)} Hz${f1?' ('+(F.f0/f1).toFixed(2)+'X)':''}: มี ${F.n} harmonic (${F.hits.join(',')})`).join(' · ')})};
  $('#faFindS').onclick=()=>{const sb=findSidebands(faEnvelope(decA,faAxes()),f1);if(!sb)return toast('ไม่พบ sideband ที่สมมาตร');
    FA.cur={mode:'side',pts:[sb.center,sb.center+sb.d]};
    const bf=bearingFreqs(f1,c.bearing),src=f1&&Math.abs(sb.d-f1)/f1<0.05?'= 1X (รอบเพลา)':bf&&Math.abs(sb.d-bf.FTF)/bf.FTF<0.05?'= FTF':f1&&Math.abs(sb.d-2*f1)/f1<0.1?'≈ 2X':'';
    renderFFTPage().then(()=>{$('#faCurInfo').textContent=`Sideband รอบ ${sb.center.toFixed(1)} Hz ระยะห่าง ${sb.d.toFixed(2)} Hz ${src} · พบ ${sb.pairs} คู่`})};
  $('#faRef').onclick=()=>{if(c.refFft===recA.key){if(!confirm('ยกเลิกชุดอ้างอิง?'))return;c.refFft=null}else c.refFft=recA.key;save();renderFFTPage()};
  if($('#faMaskMul'))$('#faMaskMul').onchange=e=>{c.maskMul=Math.max(1.1,+e.target.value||2);save();renderFFTPage()};
  $('#faPlay').onclick=()=>playTwf(decA,FA.band,FA.axis==='all'?'x':FA.axis);
  $('#faImp').onclick=()=>{const i=document.createElement('input');i.type='file';i.accept='.csv,.txt';
    i.onchange=async()=>{const f=i.files[0];if(!f)return;const u=prompt('หน่วยของค่าในไฟล์?\nพิมพ์: mms = mm/s, ips = in/s, g = g, ms2 = m/s²\n(ไฟล์ time signal ใช้ g หรือ ms2)','mms');if(!u)return;
      try{const r=await importFftCsv(f,S.sel,['mms','ips','g','ms2'].includes(u.trim())?u.trim():'mms');FA.keyA=r.key;toast('นำเข้าแล้ว: '+f.name);renderFFTPage()}catch(e){toast('นำเข้าไม่ได้: '+e.message)}};i.click()};
}

// ---------- delete unwanted FFT captures ----------
// Only the copy kept by this page (and its Drive sync) is removed; the sensor itself is never touched.
// Deleted keys are remembered (S.tomb.fft) so another device's sync does not bring them back.
function faManageDelete(list,curKey){
  const ref=cfg(S.sel).refFft,label=(r,i)=>`${r.key===ref?'★ ':''}${KIND_LABEL[r.kind||'alarm']||r.kind||''}${r.tag==='bump'?' (bump test)':''}${r.src?' '+r.src:''} · ${dFull(r.ts*1000)}${i===0?' (ล่าสุด)':''}`;
  infoDialog('ลบชุดข้อมูล FFT · '+esc(S.sel),`<p class="muted" style="margin:0 0 8px;font-size:12.5px">เลือกชุดที่ไม่ต้องการ แล้วกดลบ · ลบเฉพาะข้อมูลที่เก็บในหน้าเว็บนี้และใน Google Drive (ทุกเครื่องที่ซิงก์จะลบตาม) ไม่แตะข้อมูลในเซนเซอร์ · กู้คืนไม่ได้ ยกเว้นจากไฟล์สำรอง</p>
    <div class="row" style="margin-bottom:6px"><button type="button" class="btn sm" id="fdAll">เลือกทั้งหมด</button><button type="button" class="btn sm" id="fdNone">ไม่เลือก</button></div>
    ${list.map((r,i)=>`<label class="check" style="display:flex;font-size:13.5px;padding:3px 0"><input type="checkbox" data-fd="${esc(r.key)}" ${r.key===curKey?'checked':''}> ${esc(label(r,i))}</label>`).join('')}
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn" onclick="exportBackup()">สำรองข้อมูลก่อน</button><button type="button" class="btn danger" id="fdGo">ลบที่เลือก</button></div>`);
  const boxes=()=>[...document.querySelectorAll('[data-fd]')];
  $('#fdAll').onclick=()=>boxes().forEach(b=>b.checked=true);
  $('#fdNone').onclick=()=>boxes().forEach(b=>b.checked=false);
  $('#fdGo').onclick=async()=>{const keys=boxes().filter(b=>b.checked).map(b=>b.dataset.fd);
    if(!keys.length)return toast('ยังไม่ได้เลือก');
    if(!confirm(`ลบ FFT ${keys.length} ชุดของ "${S.sel}"?\n\nลบแล้วกู้คืนไม่ได้ (ยกเว้นจากไฟล์สำรอง) และเครื่องอื่นที่ซิงก์จะลบตาม`))return;
    $('#fdGo').disabled=true;
    try{await deleteFfts(keys);$('#infoDlg').close();toast(`ลบ FFT แล้ว ${keys.length} ชุด`)}
    catch(e){$('#fdGo').disabled=false;toast('ลบไม่สำเร็จ: '+e.message)}};
}
async function deleteFfts(keys){
  const tl=tombList('fft');for(const k of keys)if(!tl.includes(k))tl.push(k);
  await FFTDB.del(keys);
  for(const k of keys)faDecCache.delete(k);
  for(const c of Object.values(S.assets||{}))if(keys.includes(c.refFft))delete c.refFft; // reference capture gone
  if(keys.includes(FA.keyA))FA.keyA=null;if(keys.includes(FA.keyB))FA.keyB='';if(keys.includes(FUI.key))FUI.key=null;
  save();render();
}
