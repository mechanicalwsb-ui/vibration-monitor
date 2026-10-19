// Machine setup: one page with every parameter of a machine (P1), per-machine alarm rules and criticality (P2),
// lubrication / PM tasks / spare parts / documents (P3), templates, registry CSV and a completeness check (P4).
// Fields the rest of the app already uses (profile.*, rpm, vfd, vanes, drive.*, bearing, cls/z) are read and
// written in place, so every page keeps working; new parameters live in cfg(a).spec. Nothing is written to sensors.
// Loaded after machine.js; uses the dashboard's globals at call time.

const MS={tab:'gen'};
const specOf=c=>c.spec||(c.spec={});
const getPath=(o,p)=>p.split('.').reduce((x,k)=>x==null?undefined:x[k],o);
function setPath(o,p,v){const ks=p.split('.'),last=ks.pop();let x=o;for(const k of ks){if(x[k]==null||typeof x[k]!=='object')x[k]={};x=x[k]}if(v===null||v===''||v===undefined)delete x[last];else x[last]=v}

// ---------- bearings at four positions ----------
// motor DE/NDE are the existing profile.brg.de/nde; the driven machine's are spec.brg2.de/nde
const BPOS=[['m_nde','มอเตอร์ NDE'],['m_de','มอเตอร์ DE'],['d_de','เครื่องถูกขับ DE'],['d_nde','เครื่องถูกขับ NDE']];
const USE2POS={de:'m_de',nde:'m_nde',dde:'d_de',dnde:'d_nde'},POS2USE={m_de:'de',m_nde:'nde',d_de:'dde',d_nde:'dnde'};
function brgAt(c,pos){const pr=c.profile||{};return pos[0]==='m'?(pr.brg||{})[pos==='m_de'?'de':'nde']:((specOf(c).brg2||{})[pos==='d_de'?'de':'nde'])}
function setBrgAt(c,pos,b){
  if(pos[0]==='m'){c.profile=c.profile||{};c.profile.brg=c.profile.brg||{};if(b)c.profile.brg[pos==='m_de'?'de':'nde']=b;else delete c.profile.brg[pos==='m_de'?'de':'nde']}
  else{const s=specOf(c);s.brg2=s.brg2||{};if(b)s.brg2[pos==='d_de'?'de':'nde']=b;else delete s.brg2[pos==='d_de'?'de':'nde']}
}
const brgGeom=b=>!b?null:b.fac&&b.fac.BPFO?{fac:b.fac}:b.n>0&&b.d>0&&b.D>0?{n:b.n,d:b.d,D:b.D,ang:b.ang||0}:null;
function measPos(c){return USE2POS[(c.profile||{}).brgUse||'de']||'m_de'}
function syncMeasured(c){const g=brgGeom(brgAt(c,measPos(c)));if(g)c.bearing=g;else delete c.bearing}
// Standard dimensions (bore, outer diameter, width in mm) for common series: 60/62/63 deep groove, NU/NJ 2/3,
// 222/223 spherical roller. Rough values to size grease; check against the bearing maker's catalogue.
const BRG_DIM={62:[[30,9],[32,10],[35,11],[40,12],[47,14],[52,15],[62,16],[72,17],[80,18],[85,19],[90,20],[100,21],[110,22],[120,23],[125,24],[130,25],[140,26],[150,28],[160,30],[170,32],[180,34]],
  63:[[35,11],[37,12],[42,13],[47,14],[52,15],[62,17],[72,19],[80,21],[90,23],[100,25],[110,27],[120,29],[130,31],[140,33],[150,35],[160,37],[170,39],[180,41],[190,43],[200,45],[215,47]],
  60:[[26,8],[28,8],[32,9],[35,10],[42,12],[47,12],[55,13],[62,14],[68,15],[75,16],[80,16],[90,18],[95,18],[100,18],[110,20],[115,20],[125,22],[130,22],[140,24],[145,24],[150,24]]};
const W222={5:18,6:20,7:23,8:23,9:23,10:23,11:25,12:28,13:31,14:31,15:31,16:33,17:36,18:40,19:43,20:46},W223={8:33,9:36,10:40,11:43,12:46,13:48,14:51,15:55,16:58,17:60,18:64,19:67,20:73};
function brgInfo(code){
  const s=String(code||'').toUpperCase().replace(/[\s-]/g,'');let m,kind,ser,idx,fam='';
  if((m=s.match(/^(NUP|NU|NJ|N)([23])(\d{2})/))){kind='roller';ser=m[2]==='3'?63:62;idx=+m[3]}
  else if((m=s.match(/^22([23])(\d{2})/))){kind='spherical';ser=m[1]==='3'?63:62;idx=+m[2];fam='22'+m[1]}
  else if((m=s.match(/^7([23])(\d{2})/))){kind='ball';ser=m[1]==='3'?63:62;idx=+m[2]}
  else if((m=s.match(/^6([023])(\d{2})/))){kind='ball';ser={0:60,2:62,3:63}[m[1]];idx=+m[2]}
  else return null;
  const bore=idx===0?10:idx===1?12:idx===2?15:idx===3?17:idx*5,odw=(BRG_DIM[ser]||[])[idx];
  if(!odw)return{bore,kind};
  let width=odw[1];if(fam==='222'&&W222[idx])width=W222[idx];if(fam==='223'&&W223[idx])width=W223[idx];
  return{bore,od:odw[0],width,kind};
}
// Relubrication interval (operating hours) and quantity, the usual catalogue rule of thumb:
// tf = K * (14e6 / (n*sqrt(d)) - 4d), K = 10 ball, 5 cylindrical roller, 1 spherical/taper; halved per 15 °C above 70 °C
// and for vertical shafts. Quantity G = 0.005 * D * B grams (D outer diameter, B width, mm).
function relube(b,rpm,tempC,vertical){
  if(!b||!rpm)return null;const inf=Object.assign({},brgInfo(b.code)||{},b.bore?{bore:b.bore}:{},b.od?{od:b.od}:{},b.width?{width:b.width}:{},b.kind?{kind:b.kind}:{});
  if(!inf.bore)return null;const K={ball:10,roller:5,spherical:1}[inf.kind||'ball']||10;
  let h=K*(14e6/(rpm*Math.sqrt(inf.bore))-4*inf.bore);if(!(h>0))h=100;
  if(tempC>70)h/=Math.pow(2,(tempC-70)/15);if(vertical)h/=2;
  return{h:Math.round(Math.min(h,30000)),g:inf.od&&inf.width?+(0.005*inf.od*inf.width).toFixed(1):null,inf};
}

// ---------- shaft speeds and the machine's own frequencies ----------
function shaftSpeeds(c,f1){
  const s=specOf(c),t=s.trans||{};let ratio=1;
  if(t.kind==='belt'){if(t.d1>0&&t.d2>0)ratio=t.d1/t.d2;else if(c.drive&&c.drive.beltRatio)ratio=c.drive.beltRatio}
  else if(t.kind==='gear'&&(t.stages||[]).length)ratio=t.stages.reduce((r,g)=>g.z1>0&&g.z2>0?r*g.z1/g.z2:r,1);
  const onD=s.sensorOn==='driven';return{fM:onD?f1/ratio:f1,fD:onD?f1:f1*ratio,ratio};
}
function machineFreqs(c,f1){
  if(!(f1>0))return[];const s=specOf(c),t=s.trans||{},d=s.driven||{},out=[];
  const add=(grp,name,hz,short)=>{if(hz>0&&Number.isFinite(hz))out.push({grp,name,hz,short:short||name})};
  const{fM,fD,ratio}=shaftSpeeds(c,f1);
  add('เพลา','1X มอเตอร์',fM,'1X M');add('เพลา','2X มอเตอร์',2*fM,'2X M');
  if(Math.abs(ratio-1)>1e-3){add('เพลา','1X เครื่องถูกขับ',fD,'1X D');add('เพลา','2X เครื่องถูกขับ',2*fD,'2X D')}
  const lf=(c.drive&&c.drive.lineHz)||50,m=motorFreqs(fM,c);add('ไฟฟ้า','ความถี่ไฟ (LF)',lf,'LF');add('ไฟฟ้า','2×LF',2*lf);
  if(m){if(m.slip>0)add('ไฟฟ้า','Slip',m.slip);if(m.ppf>0.01)add('ไฟฟ้า','Pole pass (PPF)',m.ppf,'PPF');if(m.rbpf)add('ไฟฟ้า','Rotor bar pass',m.rbpf,'RBPF')}
  if(t.kind==='belt'&&t.d1>0&&t.len>0)add('ส่งกำลัง','Belt pass',fM*Math.PI*t.d1/t.len,'Belt');
  if(t.kind==='gear'){let fin=fM;(t.stages||[]).forEach((g,i)=>{if(!(g.z1>0&&g.z2>0))return;add('ส่งกำลัง',`GMF ชั้น ${i+1}`,fin*g.z1,`GMF${i+1}`);const fo=fin*g.z1/g.z2;add('เพลา',`เพลาออกชั้น ${i+1}`,fo,`S${i+1}`);fin=fo})}
  const blades=c.vanes>0?c.vanes:null;
  if(blades&&['pump','fan',undefined,''].includes(d.kind)){const nm=d.kind==='fan'?'Blade pass':'Vane pass';add('เครื่องถูกขับ',nm,blades*fD,d.kind==='fan'?'BPF':'VPF');add('เครื่องถูกขับ','2×'+nm,2*blades*fD)}
  if(d.kind==='compressor'&&d.male>0)add('เครื่องถูกขับ','Lobe pass (male)',d.male*fD,'Lobe');
  for(const[pos,label]of BPOS){const b=brgAt(c,pos),g=brgGeom(b);if(!g)continue;const bf=bearingFreqs(pos[0]==='m'?fM:fD,g);if(!bf)continue;
    for(const[k,v]of Object.entries(bf))add('bearing',`${label}${b.code?' '+b.code:''} ${k}`,v,`${k} ${pos.replace('_','').toUpperCase()}`)}
  return out.sort((a,b)=>a.hz-b.hz);
}
// FFT marker lines from the table (shaft 1X/2X and line frequency are drawn by the other marker options)
function machineSetupMarks(f1,c,fmax,k){
  const col={'ไฟฟ้า':k.t,'ส่งกำลัง':k.y,'เครื่องถูกขับ':k.r,'bearing':k.zd,'เพลา':k.z};
  return machineFreqs(c,f1).filter(r=>r.hz<=fmax&&!/^(1X M|2X M|LF|2×LF)$/.test(r.short)).map(r=>({x:r.hz,label:r.short,color:col[r.grp]||k.muted}));
}

// ---------- sensor axes ----------
const AXN={V:'Vertical',H:'Horizontal',A:'Axial'};
function sensorAxesOf(c){const a=(c&&c.spec&&c.spec.axes)||{};return{x:a.x||'V',y:a.y||'A',z:a.z||'H'}}
function applyAxisNames(c){const o=sensorAxesOf(c);AXES.forEach(r=>{r[1]=r[0].toUpperCase()+' ('+AXN[o[r[0]]]+')'})}

// ---------- alarm rules (P2) ----------
const critOf=c=>(c.spec&&c.spec.crit)||'';
function alarmPersist(c){const al=(c.spec&&c.spec.alarm)||{};return al.persist>0?al.persist:({A:1,B:2,C:3}[critOf(c)]||1)}
function quietNow(c){const al=(c&&c.spec&&c.spec.alarm)||{};if(!al.quietFrom||!al.quietTo)return false;
  const hm=d=>{const[h,m]=String(d).split(':').map(Number);return h*60+(m||0)},n=new Date(),now=n.getHours()*60+n.getMinutes(),a=hm(al.quietFrom),b=hm(al.quietTo);
  return a<=b?now>=a&&now<b:now>=a||now<b}

// ---------- PM tasks (P3) ----------
function runHoursSince(a,t){const c=cfg(a),rs=series(a).filter(r=>r.t>=t),days=(Date.now()-t)/864e5;
  if(rs.length<5)return days*((c.spec&&c.spec.hoursDay)||24);
  const ri=runInfo(rs,c);const span=(rs.at(-1).t-rs[0].t)/36e5||1;return ri.runH/span*(Date.now()-t)/36e5}
function pmStatus(a){
  const c=cfg(a),s=specOf(c);return(s.pm||[]).map(t=>{const last=t.last||t.created||Date.now();
    const used=t.unit==='runh'?runHoursSince(a,last):(Date.now()-last)/864e5,left=t.every-used;
    return{a,t,left,used,due:left<=0,soon:left>0&&left<=t.every*0.1,u:t.unit==='runh'?'ชม.เดิน':'วัน'}})}
function pmAll(){const seen=new Set();return names().filter(a=>{const m=(cfg(a).machine||'').trim();if(!m)return true;if(seen.has(m))return false;seen.add(m);return true}).flatMap(pmStatus)} // a machine's shared tasks once
function pmDone(a,id){
  const c=cfg(a),s=specOf(c),t=(s.pm||[]).find(x=>x.id===id);if(!t)return;
  t.last=Date.now();if(t.lube){s.lube=s.lube||{};s.lube[t.lube]=Object.assign(s.lube[t.lube]||{},{last:Date.now()})}
  S.maint.push({id:uid(),asset:a,t:Date.now(),type:t.lube?'อัดจาระบี':'PM',text:t.name+' (ทำตามแผน PM)'});
  save();render();toast('บันทึกงาน "'+t.name+'" แล้ว');
}
setInterval(()=>{try{for(const p of pmAll())if(p.due)notify('pm|'+p.a+'|'+p.t.id,'🔧 งานบำรุงรักษาถึงกำหนด: '+p.a,p.t.name,p.a)}catch(e){}},30*60000);
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-pmdone]');if(!b)return;const[a,id]=JSON.parse(b.dataset.pmdone);pmDone(a,id)});
function pmPanelHtml(){
  const L=pmAll().filter(p=>p.due||p.soon).sort((x,y)=>x.left-y.left);if(!L.length)return'';
  return`<div class="panel"><div class="ph"><h3>🔧 งานบำรุงรักษาถึงกำหนด (${L.filter(p=>p.due).length}) · ใกล้ถึง (${L.filter(p=>!p.due).length})</h3></div><div class="tablewrap"><table>
    <thead><tr><th>เครื่อง</th><th>งาน</th><th>สถานะ</th><th></th></tr></thead><tbody>${L.map(p=>`<tr><td>${esc(p.a)}</td><td>${esc(p.t.name)}</td>
    <td class="${p.due?'up':''}">${p.due?`เกินกำหนด ${Math.round(-p.left)} ${p.u}`:`อีก ${Math.round(p.left)} ${p.u}`}</td>
    <td><button type="button" class="btn sm" data-pmdone='${esc(JSON.stringify([p.a,p.t.id]))}'>ทำแล้ว</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

// ---------- completeness (P4) ----------
function completeness(a){
  const c=cfg(a),pr=c.profile||{},s=c.spec||{},t=s.trans||{},d=s.driven||{};
  const chk=[[!!pr.type,'ประเภทเครื่อง'],[c.rpm>0||(s.motor&&s.motor.rpm>0),'ความเร็วรอบ'],[pr.kw>0&&!!pr.found,'kW และฐาน (ใช้เลือกเกณฑ์ ISO)'],
    [!!brgGeom(brgAt(c,measPos(c))),'bearing ตรงจุดวัด (ใช้หา BPFO/BPFI)'],[!!(c.drive&&c.drive.poles),'จำนวนขั้วมอเตอร์ (ใช้หา pole pass)'],
    [!!t.kind,'ชนิดการส่งกำลัง'],[!['pump','fan'].includes(d.kind)||c.vanes>0,'จำนวนใบพัด/ใบพัดลม'],[!!d.kind,'ชนิดเครื่องถูกขับ'],
    [!!s.crit,'ความสำคัญของเครื่อง (A/B/C)'],[!!s.axesOk,'ยืนยันทิศแกนเซนเซอร์'],[(s.pm||[]).length>0,'แผนบำรุงรักษาอย่างน้อย 1 งาน']];
  const ok=chk.filter(x=>x[0]).length;return{pct:Math.round(ok/chk.length*100),missing:chk.filter(x=>!x[0]).map(x=>x[1])};
}

// ---------- templates (P4) ----------
function tplData(c){const o=JSON.parse(JSON.stringify(c));['baseline','refFft','sensorThr','mt','useBaseline'].forEach(k=>delete o[k]);
  if(o.profile){['tag','area','loc','photo','mount'].forEach(k=>delete o.profile[k])}delete o.machine;delete o.point;
  if(o.spec){delete o.spec.parts;delete o.spec.docs;delete o.spec.lube;delete o.spec.note;(o.spec.pm||[]).forEach(t=>{delete t.last;delete t.created;t.id=uid()});if(o.spec.motor)delete o.spec.motor.serial}
  return o}
function deepMerge(dst,src){for(const[k,v]of Object.entries(src)){if(v&&typeof v==='object'&&!Array.isArray(v)){if(!dst[k]||typeof dst[k]!=='object')dst[k]={};deepMerge(dst[k],v)}else dst[k]=JSON.parse(JSON.stringify(v))}return dst}

// ---------- registry CSV (P4) ----------
const REG_COLS=[['name','ชื่อเครื่อง'],['tag','profile.tag'],['area','profile.area'],['location','profile.loc'],['type','profile.type'],['kw','profile.kw'],['foundation','profile.found'],
  ['rpm','rpm'],['vfd','vfd'],['poles','drive.poles'],['line_hz','drive.lineHz'],['rotor_bars','drive.bars'],['vanes','vanes'],['criticality','spec.crit'],['standby','spec.standby'],['hours_per_day','spec.hoursDay'],
  ['motor_make','spec.motor.make'],['motor_model','spec.motor.model'],['motor_volt','spec.motor.volt'],['motor_amp','spec.motor.amp'],['motor_rpm','spec.motor.rpm'],['motor_frame','spec.motor.frame'],
  ['driven_kind','spec.driven.kind'],['pump_stages','spec.driven.stages'],['trans_kind','spec.trans.kind'],['belt_d1','spec.trans.d1'],['belt_d2','spec.trans.d2'],['belt_len','spec.trans.len'],
  ['gear_stages',null],['sensor_on','spec.sensorOn'],['brg_motor_de',null],['brg_motor_nde',null],['brg_driven_de',null],['brg_driven_nde',null],['axes',null],['iso_class','cls']];
const NUMF=new Set(['profile.kw','rpm','drive.poles','drive.lineHz','drive.bars','vanes','spec.hoursDay','spec.motor.volt','spec.motor.amp','spec.motor.rpm','spec.driven.stages','spec.trans.d1','spec.trans.d2','spec.trans.len']);
function regExport(){
  const q=v=>v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':String(v);
  const rows=names().map(a=>{const c=cfg(a),s=c.spec||{},ax=sensorAxesOf(c);return REG_COLS.map(([k,p])=>{
    if(k==='name')return a;if(k==='gear_stages')return((s.trans||{}).stages||[]).map(g=>`${g.z1||''}:${g.z2||''}`).join(';');
    if(k.startsWith('brg_')){const pos={brg_motor_de:'m_de',brg_motor_nde:'m_nde',brg_driven_de:'d_de',brg_driven_nde:'d_nde'}[k];return(brgAt(c,pos)||{}).code||''}
    if(k==='axes')return`${ax.x}/${ax.y}/${ax.z}`;const v=getPath(c,p);return typeof v==='boolean'?(v?'1':'0'):v}).map(q).join(',')});
  download(`machine-registry-${new Date().toISOString().slice(0,10)}.csv`,new Blob(['﻿'+[REG_COLS.map(x=>x[0]).join(','),...rows].join('\n')],{type:'text/csv'}));
  appLog('data',`ส่งออกทะเบียนเครื่องจักร ${rows.length} เครื่อง`);
}
async function regImport(file){
  const rows=parseCSV(await file.text());if(rows.length<2)return toast('ไฟล์ว่าง');
  const h=rows[0].map(x=>String(x).trim().toLowerCase().replace(/^﻿/,'')),col=k=>h.indexOf(k);if(col('name')<0)return toast('ไม่พบคอลัมน์ name');
  let n=0;
  for(const r of rows.slice(1)){const a=String(r[col('name')]||'').trim();if(!a)continue;const c=cfg(a);n++;
    for(const[k,p]of REG_COLS){const i=col(k);if(i<0||k==='name')continue;const raw=String(r[i]??'').trim();if(raw==='')continue;
      if(k==='gear_stages'){specOf(c).trans=specOf(c).trans||{};c.spec.trans.stages=raw.split(';').map(x=>{const[z1,z2]=x.split(':').map(Number);return{z1,z2}}).filter(g=>g.z1>0&&g.z2>0);continue}
      if(k.startsWith('brg_')){const pos={brg_motor_de:'m_de',brg_motor_nde:'m_nde',brg_driven_de:'d_de',brg_driven_nde:'d_nde'}[k];setBrgAt(c,pos,Object.assign({code:raw.toUpperCase()},bearingGeom(raw)||{}));continue}
      if(k==='axes'){const[x,y,z]=raw.toUpperCase().split('/');if(x&&y&&z)specOf(c).axes={x,y,z};continue}
      if(k==='iso_class'){if(CLASSES[raw]&&CLASSES[raw].z){c.cls=raw;c.z=[...CLASSES[raw].z]}continue}
      setPath(c,p,p==='vfd'||p==='spec.standby'?/^(1|true|yes|ใช่)$/i.test(raw):NUMF.has(p)?+raw:raw)}
    syncTrans(c);syncMeasured(c)}
  save();render();appLog('data',`นำเข้าทะเบียนเครื่องจักร ${n} เครื่อง จาก ${file.name}`);toast(`นำเข้าทะเบียนแล้ว ${n} เครื่อง`);
}
// legacy single-gear / belt fields used by the older FFT markers and diagnosis
function syncTrans(c){const t=specOf(c).trans||{};c.drive=c.drive||{};
  if(t.kind==='belt'&&t.d1>0&&t.d2>0)c.drive.beltRatio=+(t.d1/t.d2).toFixed(4);else if(t.kind&&t.kind!=='belt')delete c.drive.beltRatio;
  if(t.kind==='gear'&&t.stages&&t.stages[0]&&t.stages[0].z1>0&&specOf(c).sensorOn!=='driven')c.drive.teeth=t.stages[0].z1;else if(t.kind&&t.kind!=='gear')delete c.drive.teeth}

// ---------- the page ----------
const MS_TABS=[['gen','ทั่วไป'],['motor','มอเตอร์'],['driven','เครื่องถูกขับ'],['trans','ส่งกำลัง'],['brg','ตลับลูกปืน'],['sensor','จุดวัด/เซนเซอร์'],['alarm','เกณฑ์/การเตือน'],['pm','บำรุงรักษา'],['freq','ความถี่'],['reg','ทะเบียน/แม่แบบ']];
const DRIVEN=[['','— เลือก —'],['pump','ปั๊มหอยโข่ง'],['fan','พัดลม/โบลเวอร์'],['compressor','คอมเพรสเซอร์'],['mill','หีบอ้อย'],['centrifuge','เครื่องเหวี่ยง'],['conveyor','สายพานลำเลียง'],['other','อื่น ๆ']];
function renderSetupPage(){
  const p=$('#setupPage'),ns=names(),a=S.sel;
  if(!a||!ns.includes(a)){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีเครื่องจักร</h2><p>เลือกเครื่องจากเมนูซ้าย หรือเชื่อมต่อเซนเซอร์/นำเข้าข้อมูลก่อน</p></div>';return}
  const c=cfg(a),s=specOf(c),pr=c.profile||(c.profile={}),cp=completeness(a);
  const v=pth=>{const x=getPath(c,pth);return x==null?'':esc(x)};
  const F=(label,pth,o={})=>{const x=getPath(c,pth),xs=x===false?'off':String(x??'');
    if(o.sel)return`<label${o.full?' class="full"':''}>${label}<select data-f="${pth}" ${o.rr?'data-rr="1"':''}>${o.sel.map(([k,l])=>`<option value="${esc(k)}" ${xs===String(k)?'selected':''}>${esc(l)}</option>`).join('')}</select>${o.hint?`<small class="muted">${o.hint}</small>`:''}</label>`;
    if(o.check)return`<label class="check${o.full?' full':''}"><input type="checkbox" data-f="${pth}" data-t="bool" ${x?'checked':''} ${o.rr?'data-rr="1"':''}> ${label}</label>`;
    return`<label${o.full?' class="full"':''}>${label}<span class="ms-in"><input ${o.num?'type="number" step="any" data-t="num"':'type="text"'} data-f="${pth}" value="${v(pth)}" placeholder="${esc(o.ph||'')}" ${o.rr?'data-rr="1"':''}>${o.unit?`<em>${o.unit}</em>`:''}</span>${o.hint?`<small class="muted">${o.hint}</small>`:''}</label>`};
  const f1=(c.rpm||(s.motor&&s.motor.rpm)||0)/60,lf=(c.drive&&c.drive.lineHz)||50;
  let body='';
  if(MS.tab==='gen')body=`<div class="form">
    ${F('ประเภท','profile.type',{sel:[['',''],...['ปั๊ม','มอเตอร์','พัดลม/โบลเวอร์','เกียร์','คอมเพรสเซอร์','อื่น ๆ'].map(x=>[x,x])]})}
    ${F('หมายเลขเครื่อง (Tag)','profile.tag')}${F('พื้นที่ / อาคาร','profile.area')}${F('ตำแหน่งติดตั้ง','profile.loc')}
    ${F('เครื่องจักร (กลุ่มจุดวัด)','machine',{ph:'เช่น P-101'})}${F('ชื่อจุดวัด','point',{ph:'เช่น Motor DE'})}
    ${F('ความสำคัญ','spec.crit',{sel:[['','— เลือก —'],['A','A · สำคัญมาก (หยุดแล้วกระทบการผลิต)'],['B','B · สำคัญ'],['C','C · ทั่วไป / มีสำรอง']],rr:1})}
    ${F('ชั่วโมงเดินต่อวัน','spec.hoursDay',{num:1,unit:'ชม.',ph:'24'})}
    ${F('มีเครื่องสำรอง (standby)','spec.standby',{check:1})}
    ${F('หมายเหตุ','spec.note',{full:1})}
    <label class="full">รูปเครื่อง<input type="file" accept="image/*" capture="environment" id="msPhoto"></label>
    ${pr.photo?`<img src="${imgSrc(pr.photo)}" class="full" style="max-width:100%;max-height:200px;object-fit:contain;border-radius:8px">`:''}</div>`;
  else if(MS.tab==='motor'){const m=s.motor||{},guess=m.rpm>0?Math.max(2,Math.round(120*lf/m.rpm/2)*2):null;
    body=`<div class="form">
    ${F('ยี่ห้อ','spec.motor.make')}${F('รุ่น','spec.motor.model')}${F('Serial','spec.motor.serial')}${F('Frame','spec.motor.frame')}
    ${F('กำลัง','profile.kw',{num:1,unit:'kW'})}${F('แรงดัน','spec.motor.volt',{num:1,unit:'V'})}${F('กระแส (FLA)','spec.motor.amp',{num:1,unit:'A'})}
    ${F('รอบตามป้าย','spec.motor.rpm',{num:1,unit:'RPM',rr:1})}
    ${F('จำนวนขั้ว','drive.poles',{sel:[['','ไม่ทราบ'],...[2,4,6,8,10,12].map(n=>[n,n+' ขั้ว'])],hint:guess&&+(c.drive||{}).poles!==guess?`ตามรอบป้ายน่าจะเป็น ${guess} ขั้ว`:'',rr:1})}
    ${F('ความถี่ไฟ','drive.lineHz',{num:1,unit:'Hz',ph:'50'})}${F('จำนวน rotor bar','drive.bars',{num:1})}
    ${F('ประสิทธิภาพ','spec.motor.ie',{sel:[['',''],['IE1','IE1'],['IE2','IE2'],['IE3','IE3'],['IE4','IE4']]})}
    ${F('ใช้ inverter (VFD)','vfd',{check:1,rr:1})}
    ${c.vfd?F('VFD ต่ำสุด','spec.motor.hzMin',{num:1,unit:'Hz'})+F('VFD สูงสุด','spec.motor.hzMax',{num:1,unit:'Hz'}):''}</div>`}
  else if(MS.tab==='driven'){const d=s.driven||{};
    body=`<div class="form">${F('ชนิดเครื่องถูกขับ','spec.driven.kind',{sel:DRIVEN,rr:1})}
    ${d.kind==='pump'?F('จำนวนใบพัด (vanes)','vanes',{num:1})+F('จำนวน stage','spec.driven.stages',{num:1})+F('อัตราไหลออกแบบ','spec.driven.flow',{num:1,unit:'m³/h'})+F('เฮดออกแบบ','spec.driven.head',{num:1,unit:'m'})+F('NPSHr','spec.driven.npsh',{num:1,unit:'m'})+F('ของเหลว','spec.driven.fluid',{ph:'เช่น น้ำดิบ, น้ำอ้อย'}):''}
    ${d.kind==='fan'?F('จำนวนใบพัดลม','vanes',{num:1})+F('ชนิด','spec.driven.ftype',{sel:[['',''],['centrifugal','Centrifugal'],['axial','Axial']]})+F('ใบพัดยื่นนอก bearing (overhung)','spec.driven.overhung',{check:1}):''}
    ${d.kind==='compressor'?F('ชนิด','spec.driven.ctype',{sel:[['',''],['screw','Screw'],['recip','ลูกสูบ'],['centrifugal','Centrifugal']]})+F('จำนวนกลีบ male','spec.driven.male',{num:1})+F('จำนวนกลีบ female','spec.driven.female',{num:1}):''}
    ${['mill','centrifuge','conveyor','other'].includes(d.kind)?F('รายละเอียด','spec.driven.desc',{full:1})+F('จำนวนใบ/ซี่/ลูกกลิ้งที่ทำให้เกิดความถี่ซ้ำ (ถ้ามี)','vanes',{num:1}):''}
    ${!d.kind?'<p class="full muted">เลือกชนิดเครื่องแล้วจะมีช่องเฉพาะชนิดนั้น</p>':''}</div>`}
  else if(MS.tab==='trans'){const t=s.trans||{},sp=f1?shaftSpeeds(c,f1):null;
    body=`<div class="form">${F('การส่งกำลัง','spec.trans.kind',{sel:[['','— เลือก —'],['direct','ต่อตรง'],['coupling','คัปปลิ้ง'],['belt','สายพาน'],['gear','เกียร์']],rr:1})}
    ${F('เซนเซอร์ติดอยู่ที่','spec.sensorOn',{sel:[['','มอเตอร์ (ฝั่งขับ)'],['driven','เครื่องถูกขับ']],rr:1})}
    ${F('รอบเพลาที่จุดวัด','rpm',{num:1,unit:'RPM',rr:1,hint:'ใช้เป็น 1X ในหน้า FFT (เครื่อง VFD ใช้รอบของแต่ละชุดที่วัด)'})}
    ${t.kind==='coupling'?F('ชนิดคัปปลิ้ง','spec.trans.coupling',{ph:'เช่น jaw, grid, disc, gear'}):''}
    ${t.kind==='belt'?F('Ø พูลเลย์ขับ (มอเตอร์)','spec.trans.d1',{num:1,unit:'mm',rr:1})+F('Ø พูลเลย์ตาม','spec.trans.d2',{num:1,unit:'mm',rr:1})+F('ความยาวสายพาน','spec.trans.len',{num:1,unit:'mm',rr:1})+F('จำนวนเส้น','spec.trans.n',{num:1}):''}
    ${t.kind==='gear'?`<div class="full"><b style="font-size:13px">ชั้นเกียร์ (นับจากฝั่งมอเตอร์)</b><table class="ms-t"><thead><tr><th>ชั้น</th><th>ฟันเฟืองขับ</th><th>ฟันเฟืองตาม</th><th>อัตราทด</th><th></th></tr></thead><tbody>
      ${(t.stages||[]).map((g,i)=>`<tr><td>${i+1}</td><td><input type="number" data-gs="${i}" data-k="z1" value="${g.z1||''}"></td><td><input type="number" data-gs="${i}" data-k="z2" value="${g.z2||''}"></td><td class="num">${g.z1&&g.z2?(g.z2/g.z1).toFixed(3)+' : 1':'–'}</td><td><button type="button" class="btn sm" data-gdel="${i}">×</button></td></tr>`).join('')}
      </tbody></table><button type="button" class="btn sm" id="msGAdd">+ เพิ่มชั้น</button></div>`:''}
    ${sp?`<p class="full muted" style="margin:0">รอบมอเตอร์ ${Math.round(sp.fM*60)} RPM · รอบเครื่องถูกขับ ${Math.round(sp.fD*60)} RPM${Math.abs(sp.ratio-1)>1e-3?` (อัตรา ${sp.ratio.toFixed(3)})`:''}</p>`:'<p class="full muted" style="margin:0">ใส่รอบเพลาที่จุดวัด หรือรอบตามป้ายมอเตอร์ เพื่อคำนวณรอบแต่ละเพลา</p>'}</div>`}
  else if(MS.tab==='brg'){const T=(c.spec&&c.spec.lubeTemp)||((lastOf(a)||{}).temp)||null,sp=f1?shaftSpeeds(c,f1):null;
    body=`<datalist id="msBrgList">${BRG_LIST.concat(Object.keys(S.brgDb||{})).map(x=>`<option value="${esc(x)}">`).join('')}</datalist>
    <p class="muted" style="margin:0 0 8px;font-size:12.5px">พิมพ์เบอร์แล้วระบบเติมขนาดให้ (ใช้คำนวณ BPFO/BPFI/BSF/FTF และปริมาณจาระบี) · เลือก "จุดวัด" = bearing ที่ติดเซนเซอร์ (ใช้ในหน้า FFT)</p>
    <div class="ms-brg">${BPOS.map(([pos,label])=>{const b=brgAt(c,pos)||{},inf=brgInfo(b.code)||{},L=(s.lube||{})[pos]||{},rpm=sp?(pos[0]==='m'?sp.fM:sp.fD)*60:0,rl=relube(Object.assign({},b,L),rpm,T,s.vertical);
      return`<div class="panel ms-bcard" data-pos="${pos}"><div class="ph"><h3>${label}</h3><label class="check" style="font-size:12px"><input type="radio" name="msUse" value="${pos}" ${measPos(c)===pos?'checked':''}> จุดวัด</label></div><div class="form">
        <label>เบอร์ bearing<input class="bC" list="msBrgList" value="${esc(b.code||'')}" placeholder="เช่น 6309, 22216"></label>
        <label>ชนิด<select class="bK"><option value="">${inf.kind?'อัตโนมัติ ('+({ball:'ball',roller:'roller',spherical:'spherical'}[inf.kind])+')':'—'}</option><option value="ball" ${L.kind==='ball'?'selected':''}>Ball</option><option value="roller" ${L.kind==='roller'?'selected':''}>Cylindrical roller</option><option value="spherical" ${L.kind==='spherical'?'selected':''}>Spherical/Taper</option></select></label>
        <label>ลูก (n)<input type="number" class="bN" value="${b.n??''}"></label><label>Ø ลูก (mm)<input type="number" step="any" class="bD" value="${b.d??''}"></label>
        <label>Ø pitch (mm)<input type="number" step="any" class="bP" value="${b.D??''}"></label><label>มุมสัมผัส°<input type="number" step="any" class="bA" value="${b.ang??0}"></label>
        <label>รูใน/นอก/กว้าง (mm)<span class="ms-in"><input type="number" class="lB" value="${L.bore??''}" placeholder="${inf.bore||''}"><input type="number" class="lO" value="${L.od??''}" placeholder="${inf.od||''}"><input type="number" class="lW" value="${L.width??''}" placeholder="${inf.width||''}"></span></label>
        <label>สารหล่อลื่น<span class="ms-in"><select class="lT"><option value="grease" ${L.type!=='oil'?'selected':''}>จาระบี</option><option value="oil" ${L.type==='oil'?'selected':''}>น้ำมัน</option></select><input class="lG" value="${esc(L.grease||'')}" placeholder="ยี่ห้อ/เบอร์"></span></label>
        <label>เติมล่าสุด<input type="date" class="lL" value="${L.last?new Date(L.last-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10):''}"></label>
        <p class="full muted ms-rl">${rl?`ควรเติมทุก ~${rl.h.toLocaleString()} ชม.เดิน${rl.g?` · ครั้งละ ~${rl.g} g`:''} (${Math.round(rpm)} RPM${T?`, ${Math.round(T)} °C`:''}) <button type="button" class="btn sm" data-mkpm="${pos}" data-h="${rl.h}" data-g="${rl.g||''}">+ สร้างงานเติมจาระบี</button>`:b.code?'ใส่รอบเพลาและขนาดรูใน เพื่อคำนวณรอบเติมจาระบี':''}</p>
      </div></div>`}).join('')}</div>
    <div class="form" style="padding:0">${F('เพลาตั้ง (vertical)','spec.vertical',{check:1,rr:1})}${F('อุณหภูมิ bearing ที่ใช้คำนวณ','spec.lubeTemp',{num:1,unit:'°C',ph:T?String(Math.round(T)):'',rr:1})}</div>
    <p class="muted" style="font-size:11.5px">รอบเติมจาระบีใช้สูตรทั่วไปของผู้ผลิต (K × (14×10⁶/(n·√d) − 4d), ลดครึ่งทุก 15 °C เหนือ 70 °C) ปริมาณ G = 0.005·D·B กรัม · เป็นค่าประมาณ ควรเทียบกับคู่มือผู้ผลิตเครื่อง/bearing</p>`}
  else if(MS.tab==='sensor'){const ax=sensorAxesOf(c),sens=Object.entries(S.sensors||{}).filter(([,x])=>x.asset===a);
    const axSel=k=>`<label>แกน ${k.toUpperCase()} ของเซนเซอร์<select data-ax="${k}">${Object.entries(AXN).map(([v,l])=>`<option value="${v}" ${ax[k]===v?'selected':''}>${l}${v==='V'?' (แนวตั้ง)':v==='H'?' (แนวนอน)':' (แนวเพลา)'}</option>`).join('')}</select></label>`;
    body=`<div class="form">${axSel('x')}${axSel('y')}${axSel('z')}
    ${F('ตรวจทิศแกนกับของจริงแล้ว','spec.axesOk',{check:1})}
    <p class="full muted" style="margin:0;font-size:12px">ค่าเริ่มต้นของ i-ALERT3: X = Vertical, Y = Axial, Z = Horizontal (ติดบนฝาครอบ bearing แนวตั้ง) ถ้าติดด้านข้างหรือแนวเพลา ให้เปลี่ยนตามจริง ชื่อแกนในกราฟจะเปลี่ยนตาม</p>
    ${F('ตำแหน่งติดเซนเซอร์','profile.mount',{full:1,ph:'เช่น ฝาครอบ bearing มอเตอร์ DE ด้านบน'})}
    ${F('วิธีติด','spec.mountType',{sel:[['',''],['stud','สกรู (stud)'],['magnet','แม่เหล็ก'],['adhesive','กาว/epoxy']]})}
    ${F('ฐานติดตั้ง','profile.found',{sel:[['rigid','แข็ง (rigid)'],['flexible','ยืดหยุ่น (flexible)']],rr:1})}
    <div class="full"><b style="font-size:13px">เซนเซอร์ที่จับคู่กับเครื่องนี้</b>${sens.length?`<ul style="margin:4px 0 0;padding-left:18px;font-size:13px">${sens.map(([id,x])=>`<li>${x.mac?'MAC '+esc(x.mac):esc(id.slice(0,12))}${x.via?' · ผ่าน '+esc(x.via):''}</li>`).join('')}</ul>`:'<p class="muted" style="margin:4px 0 0">ยังไม่มี (เชื่อมต่อจากเมนูเซนเซอร์)</p>'}</div></div>`}
  else if(MS.tab==='alarm'){const iso=isoClassFor(pr),al=s.alarm||{},k=S.unit==='in'?1/25.4:1;
    body=`<div class="form">
    <div class="full ms-box"><b>เกณฑ์ปัจจุบัน:</b> ${useSensorThr(c)?'ตามที่ตั้งในเซนเซอร์':esc((CLASSES[c.cls]||{}).n||'กำหนดเอง')} · โซน B/C/D เริ่มที่ ${(c.z||[]).map(x=>fv(x)).join(' / ')} ${uv()} · อุณหภูมิ ${tempLimits(c).tw??'–'} / ${tempLimits(c).ta??'–'} °C
      ${iso?`<br>ตาม kW ${pr.kw} และฐาน${pr.found==='flexible'?'ยืดหยุ่น':'แข็ง'} ISO 10816-3 แนะนำ <b>${esc(CLASSES[iso].n)}</b> (${CLASSES[iso].z.map(x=>fv(x)).join(' / ')} ${uv()}) ${c.cls===iso&&!useSensorThr(c)?'✓ ใช้อยู่แล้ว':'<button type="button" class="btn sm" id="msIso">ใช้ค่าแนะนำ</button>'}`:'<br><span class="muted">ใส่ kW (แท็บมอเตอร์) และฐานติดตั้ง (แท็บจุดวัด) เพื่อให้แนะนำกลุ่ม ISO</span>'}
      <br><button type="button" class="btn sm" onclick="setView('settings')">แก้เกณฑ์โซน/อุณหภูมิละเอียด (หน้าตั้งค่า)</button></div>
    <b class="full" style="font-size:13px">กฎการแจ้งเตือนของเครื่องนี้</b>
    ${F('แจ้งเตือนเครื่องนี้','spec.alarm.notify',{sel:[['','เปิด'],['off','ปิด']]})}
    ${F('เตือนเมื่อเกินติดกัน','spec.alarm.persist',{num:1,unit:'ค่า',ph:String(alarmPersist(c)),hint:'ว่าง = ตามความสำคัญ (A=1, B=2, C=3) กัน spike หลอก'})}
    ${F('เตือนเมื่อเพิ่มขึ้นเกิน','spec.alarm.risePct',{num:1,unit:'%',ph:'เช่น 25'})}
    ${F('เทียบกับ','spec.alarm.riseRef',{sel:[['','ค่าเฉลี่ย 7 วันก่อนหน้า'],['baseline','baseline']]})}
    ${F('ช่วงไม่แจ้งเตือน ตั้งแต่','spec.alarm.quietFrom',{ph:'22:00'})}${F('ถึง','spec.alarm.quietTo',{ph:'06:00'})}
    ${F('เตือนจากแถบความถี่/FASIT ใน FFT','spec.alarm.fft',{sel:[['','เปิด'],['off','ปิด']]})}
    <p class="full muted" style="margin:0;font-size:12px">ช่วงไม่แจ้งเตือน: ยังบันทึกใน Log และขึ้นข้อความในหน้าเว็บ แต่ไม่ส่งการแจ้งเตือน/เสียง</p></div>`}
  else if(MS.tab==='pm'){const st=pmStatus(a);
    body=`<b style="font-size:13px">งานบำรุงรักษาตามรอบ</b>
    <div class="tablewrap"><table class="ms-t"><thead><tr><th>งาน</th><th>ทุก</th><th>ทำล่าสุด</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${st.map(p=>`<tr><td>${esc(p.t.name)}</td><td class="num">${p.t.every} ${p.u}</td><td>${p.t.last?dShort(p.t.last):'ยังไม่เคย'}</td><td class="${p.due?'up':''}">${p.due?`เกิน ${Math.round(-p.left)} ${p.u}`:`อีก ${Math.round(p.left)} ${p.u}`}</td>
        <td class="row" style="flex-wrap:nowrap"><button type="button" class="btn sm" data-pmdone='${esc(JSON.stringify([a,p.t.id]))}'>ทำแล้ว</button><button type="button" class="btn sm" data-pmdel="${esc(p.t.id)}">×</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">ยังไม่มีงาน</td></tr>'}
    </tbody></table></div>
    <div class="row" style="margin-top:6px"><input id="pmName" placeholder="ชื่องาน เช่น ตรวจตั้งศูนย์, เปลี่ยนน้ำมันเกียร์" style="flex:1;min-width:180px"><input type="number" id="pmEvery" placeholder="ทุก" style="width:80px">
      <select id="pmUnit"><option value="day">วัน</option><option value="runh">ชม.เดิน</option></select><button type="button" class="btn sm primary" id="pmAdd">+ เพิ่มงาน</button></div>
    <p class="muted" style="font-size:12px">ชม.เดิน นับจากข้อมูลการสั่น (เครื่องหยุด = ไม่นับ) · กด "ทำแล้ว" จะลงบันทึกซ่อมให้อัตโนมัติ · งานที่ถึงกำหนดขึ้นในหน้าทุกเครื่องและแจ้งเตือน</p>
    <b style="font-size:13px">อะไหล่</b>${msListHtml('parts',[['name','ชื่อ',''],['pn','Part no.',''],['qty','จำนวน','num'],['note','หมายเหตุ','']])}
    <b style="font-size:13px">เอกสาร / คู่มือ</b>${msListHtml('docs',[['name','ชื่อเอกสาร',''],['url','ลิงก์ (https://…)','']])}`}
  else if(MS.tab==='freq'){const rows=machineFreqs(c,f1);
    body=`${f1?`<p class="muted" style="margin:0 0 8px;font-size:12.5px">คำนวณที่ 1X = ${(f1*60).toFixed(0)} RPM (${f1.toFixed(2)} Hz)${c.vfd?' · เครื่อง VFD: หน้า FFT จะคำนวณใหม่ตามรอบของแต่ละชุดที่วัด':''} · ใช้เป็นเส้นบอกความถี่ในหน้า FFT (ตัวเลือก "ความถี่จากตั้งค่าเครื่อง") และส่งให้ AI</p>`:'<p class="muted">ใส่รอบเพลา (แท็บส่งกำลัง) หรือรอบตามป้ายมอเตอร์ก่อน</p>'}
    ${rows.length?`<div class="tablewrap"><table class="ms-t"><thead><tr><th>กลุ่ม</th><th>ความถี่</th><th class="num">Hz</th><th class="num">CPM</th><th class="num">× 1X</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td class="muted">${r.grp}</td><td>${esc(r.name)}</td><td class="num">${r.hz.toFixed(2)}</td><td class="num">${Math.round(r.hz*60).toLocaleString()}</td><td class="num">${(r.hz/f1).toFixed(2)}</td></tr>`).join('')}</tbody></table></div>`:''}`}
  else if(MS.tab==='reg'){const tpl=S.machTpl||{};
    body=`<b style="font-size:13px">ทะเบียนเครื่องจักร (${ns.length})</b>
    <div class="tablewrap"><table class="ms-t"><thead><tr><th>เครื่อง</th><th>Tag</th><th>พื้นที่</th><th>ชนิด</th><th class="num">kW</th><th class="num">RPM</th><th>สำคัญ</th><th>ความครบ</th><th>PM</th></tr></thead><tbody>
      ${ns.map(n=>{const cc=cfg(n),q=completeness(n),pm=pmStatus(n).filter(x=>x.due).length;return`<tr data-reg="${esc(n)}" style="cursor:pointer"><td>${esc(n)}</td><td>${esc((cc.profile||{}).tag||'')}</td><td>${esc((cc.profile||{}).area||'')}</td><td>${esc((cc.profile||{}).type||'')}</td><td class="num">${(cc.profile||{}).kw??''}</td><td class="num">${cc.rpm??''}</td><td>${critOf(cc)}</td><td><span class="ms-bar"><i style="width:${q.pct}%"></i></span> ${q.pct}%</td><td class="${pm?'up':''}">${pm?pm+' งาน':''}</td></tr>`}).join('')}
    </tbody></table></div>
    <div class="row" style="margin:6px 0 14px"><button type="button" class="btn sm" id="regExp">ส่งออก CSV (เปิดใน Excel)</button><button type="button" class="btn sm" id="regImp">นำเข้า CSV</button><span class="muted" style="font-size:12px">แก้ไฟล์ใน Excel แล้วนำเข้ากลับ จับคู่ด้วยชื่อเครื่อง</span></div>
    <b style="font-size:13px">แม่แบบเครื่อง</b>
    <div class="row" style="margin:4px 0"><input id="tplName" placeholder="ชื่อแม่แบบ เช่น ปั๊มน้ำ 30 kW 2 pole" style="flex:1;min-width:200px"><button type="button" class="btn sm primary" id="tplSave">บันทึก "${esc(a)}" เป็นแม่แบบ</button></div>
    <div class="tablewrap"><table class="ms-t"><tbody>${Object.entries(tpl).map(([id,t])=>`<tr><td>${esc(t.name)}</td><td class="muted">${t.mt?dShort(t.mt):''}</td><td class="row" style="flex-wrap:nowrap"><button type="button" class="btn sm" data-tplapply="${esc(id)}">ใช้กับ "${esc(a)}"</button><button type="button" class="btn sm" data-tpldel="${esc(id)}">×</button></td></tr>`).join('')||'<tr><td class="muted">ยังไม่มีแม่แบบ</td></tr>'}</tbody></table></div>
    <p class="muted" style="font-size:12px">แม่แบบเก็บประเภท มอเตอร์ เครื่องถูกขับ การส่งกำลัง bearing เกณฑ์ กฎเตือน และงาน PM (ไม่รวม tag พื้นที่ รูป อะไหล่ เอกสาร) · ซิงก์ไปทุกเครื่อง</p>`}
  p.innerHTML=`<div class="mainhead"><h2>${favBtn(a)}ตั้งค่าเครื่องจักร · ${esc(a)}</h2>
      <div class="ms-done" title="${esc(cp.missing.join(' · '))}"><span class="ms-bar"><i style="width:${cp.pct}%"></i></span> ข้อมูลครบ ${cp.pct}%</div></div>
    ${sharedWith(a).length?`<div class="panel banner ms-share"><span>🔗 ใช้ร่วมกับทุกจุดวัดของเครื่อง <b>${esc(c.machine)}</b> (${sharedWith(a).map(x=>esc(pointLabel(x))).join(', ')}): แก้ที่จุดไหนก็เปลี่ยนทุกจุด · <b>เฉพาะจุดนี้</b>: bearing ตรงจุดวัด, ทิศแกน/ตำแหน่ง/วิธีติดเซนเซอร์, รอบเพลาที่จุดวัด, เซนเซอร์ติดฝั่งไหน, เกณฑ์และ baseline</span></div>`:''}
    ${cp.missing.length&&MS.tab!=='reg'?`<div class="panel banner"><span>ยังขาด: ${cp.missing.map(esc).join(' · ')}</span></div>`:''}
    <div class="seg ms-tabs" id="msTabs">${MS_TABS.map(([k,l])=>`<button data-v="${k}" class="${MS.tab===k?'on':''}">${l}</button>`).join('')}</div>
    <div class="panel pbody ms-body">${body}</div>`;
  msBind(a,c);
}
function msListHtml(key,cols){
  const s=specOf(cfg(S.sel)),L=s[key]||[];
  return`<div class="tablewrap"><table class="ms-t"><thead><tr>${cols.map(x=>`<th>${x[1]}</th>`).join('')}<th></th></tr></thead><tbody>
    ${L.map(r=>`<tr>${cols.map(([k,,t])=>`<td>${k==='url'&&r[k]&&/^https?:\/\//i.test(r[k])?`<a href="${esc(r[k])}" target="_blank" rel="noopener">${esc(r[k].length>40?r[k].slice(0,40)+'…':r[k])}</a>`:esc(r[k]??'')}</td>`).join('')}<td><button type="button" class="btn sm" data-ldel="${key}|${esc(r.id)}">×</button></td></tr>`).join('')}
    <tr>${cols.map(([k,l,t])=>`<td><input data-lnew="${key}" data-k="${k}" ${t==='num'?'type="number"':''} placeholder="${l}"></td>`).join('')}<td><button type="button" class="btn sm" data-ladd="${key}">+</button></td></tr>
  </tbody></table></div>`;
}
function msBind(a,c){
  const p=$('#setupPage'),s=specOf(c),re=()=>renderSetupPage();
  p.querySelectorAll('#msTabs button').forEach(b=>b.onclick=()=>{MS.tab=b.dataset.v;re()});
  p.querySelectorAll('[data-f]').forEach(i=>i.onchange=()=>{
    let v=i.dataset.t==='bool'?i.checked:i.value;if(i.dataset.t==='num')v=v===''?null:+v;else if(typeof v==='string')v=v.trim();
    if(i.dataset.f==='spec.alarm.notify'||i.dataset.f==='spec.alarm.fft')v=v==='off'?false:null;
    if(i.dataset.f==='drive.poles')v=v===''?null:+v;
    setPath(c,i.dataset.f,v);
    if(i.dataset.f.startsWith('spec.trans')||i.dataset.f==='spec.sensorOn')syncTrans(c);
    if(i.dataset.f==='spec.motor.rpm'&&!c.rpm&&v)c.rpm=v; // the rated speed is a good first 1X
    save();if(i.dataset.rr)re();else{const d=p.querySelector('.ms-done');if(d){const q=completeness(a);d.lastChild.textContent=' ข้อมูลครบ '+q.pct+'%';d.querySelector('i').style.width=q.pct+'%'}}});
  if($('#msPhoto'))$('#msPhoto').onchange=async e=>{if(!e.target.files[0])return;c.profile.photo=await shrinkImage(e.target.files[0]);save();re()};
  // gear stages
  p.querySelectorAll('[data-gs]').forEach(i=>i.onchange=()=>{const st=s.trans.stages[+i.dataset.gs];st[i.dataset.k]=+i.value||null;syncTrans(c);save();re()});
  p.querySelectorAll('[data-gdel]').forEach(b=>b.onclick=()=>{s.trans.stages.splice(+b.dataset.gdel,1);syncTrans(c);save();re()});
  if($('#msGAdd'))$('#msGAdd').onclick=()=>{s.trans=s.trans||{};(s.trans.stages=s.trans.stages||[]).push({z1:null,z2:null});save();re()};
  // bearings
  p.querySelectorAll('.ms-bcard').forEach(card=>{const pos=card.dataset.pos,q=sel=>card.querySelector(sel),nz=x=>x===''?null:+x;
    const upd=()=>{const code=q('.bC').value.trim().toUpperCase();
      setBrgAt(c,pos,code||q('.bN').value?{code,n:nz(q('.bN').value),d:nz(q('.bD').value),D:nz(q('.bP').value),ang:nz(q('.bA').value)||0}:null);
      s.lube=s.lube||{};const L=Object.assign(s.lube[pos]||{},{kind:q('.bK').value||undefined,bore:nz(q('.lB').value),od:nz(q('.lO').value),width:nz(q('.lW').value),type:q('.lT').value,grease:q('.lG').value.trim()||undefined,
        last:q('.lL').value?new Date(q('.lL').value).getTime():undefined});Object.keys(L).forEach(k=>L[k]==null&&delete L[k]);s.lube[pos]=L;
      syncMeasured(c);save();re()};
    q('.bC').onchange=()=>{const g=bearingGeom(q('.bC').value);if(g){if(g.n)q('.bN').value=g.n;if(g.d)q('.bD').value=g.d;if(g.D)q('.bP').value=g.D;if(g.ang!=null)q('.bA').value=g.ang}upd()};
    card.querySelectorAll('input:not(.bC),select').forEach(i=>{if(i.name!=='msUse')i.onchange=upd})});
  p.querySelectorAll('input[name=msUse]').forEach(r=>r.onchange=()=>{c.profile.brgUse=POS2USE[r.value];syncMeasured(c);FA.marks.bearing=!!c.bearing;save();re()});
  p.querySelectorAll('[data-mkpm]').forEach(b=>b.onclick=()=>{const pos=b.dataset.mkpm,lbl=(BPOS.find(x=>x[0]===pos)||[])[1],code=(brgAt(c,pos)||{}).code||'';
    (s.pm=s.pm||[]).push({id:uid(),name:`เติมจาระบี ${lbl} ${code}${b.dataset.g?' · '+b.dataset.g+' g':''}`,every:+b.dataset.h,unit:'runh',lube:pos,created:((s.lube||{})[pos]||{}).last||Date.now()});
    save();MS.tab='pm';re();toast('สร้างงานเติมจาระบีแล้ว')});
  // axes
  p.querySelectorAll('[data-ax]').forEach(sl=>sl.onchange=()=>{s.axes=Object.assign(sensorAxesOf(c),{[sl.dataset.ax]:sl.value});const v=Object.values(s.axes);if(new Set(v).size<3)toast('แต่ละแกนควรเป็นคนละทิศ');applyAxisNames(c);save();re()});
  if($('#msIso'))$('#msIso').onclick=()=>{const k=isoClassFor(c.profile);c.cls=k;c.z=[...CLASSES[k].z];if(c.thrSrc==='sensor')c.thrSrc='iso';save();re();toast('ใช้เกณฑ์ '+CLASSES[k].n)};
  // PM, parts, docs
  if($('#pmAdd'))$('#pmAdd').onclick=()=>{const name=$('#pmName').value.trim(),every=+$('#pmEvery').value;if(!name||!(every>0))return toast('ใส่ชื่องานและรอบ');
    (s.pm=s.pm||[]).push({id:uid(),name,every,unit:$('#pmUnit').value,created:Date.now()});save();re()};
  p.querySelectorAll('[data-pmdel]').forEach(b=>b.onclick=()=>{if(!confirm('ลบงานนี้?'))return;s.pm=(s.pm||[]).filter(t=>t.id!==b.dataset.pmdel);save();re()});
  p.querySelectorAll('[data-ladd]').forEach(b=>b.onclick=()=>{const key=b.dataset.ladd,row={id:uid()};p.querySelectorAll(`[data-lnew="${key}"]`).forEach(i=>{if(i.value.trim())row[i.dataset.k]=i.type==='number'?+i.value:i.value.trim()});
    if(Object.keys(row).length<2)return toast('ใส่ข้อมูลก่อน');if(row.url&&!/^https?:\/\//i.test(row.url))return toast('ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://');(s[key]=s[key]||[]).push(row);save();re()});
  p.querySelectorAll('[data-ldel]').forEach(b=>b.onclick=()=>{const[key,id]=b.dataset.ldel.split('|');s[key]=(s[key]||[]).filter(r=>r.id!==id);save();re()});
  // registry and templates
  p.querySelectorAll('[data-reg]').forEach(tr=>tr.onclick=()=>{S.sel=tr.dataset.reg;MS.tab='gen';save();render()});
  if($('#regExp'))$('#regExp').onclick=regExport;
  if($('#regImp'))$('#regImp').onclick=()=>{const i=document.createElement('input');i.type='file';i.accept='.csv,text/csv';i.onchange=()=>{if(i.files[0])regImport(i.files[0])};i.click()};
  if($('#tplSave'))$('#tplSave').onclick=()=>{const name=$('#tplName').value.trim()||a;S.machTpl=S.machTpl||{};S.machTpl[uid()]={name,mt:Date.now(),data:tplData(c)};save();re();toast('บันทึกแม่แบบแล้ว')};
  p.querySelectorAll('[data-tplapply]').forEach(b=>b.onclick=()=>{const t=(S.machTpl||{})[b.dataset.tplapply];if(!t||!confirm(`ใช้แม่แบบ "${t.name}" กับ "${a}"?\nค่าในแม่แบบจะเขียนทับค่าเดิมของเครื่องนี้ (tag พื้นที่ รูป อะไหล่ เอกสาร คงเดิม)`))return;
    deepMerge(c,JSON.parse(JSON.stringify(t.data)));(c.spec.pm||[]).forEach(x=>{if(!x.created)x.created=Date.now()});syncTrans(c);syncMeasured(c);appLog('edit',`ใช้แม่แบบ "${t.name}" กับ "${a}"`);save();re()});
  p.querySelectorAll('[data-tpldel]').forEach(b=>b.onclick=()=>{if(!confirm('ลบแม่แบบนี้?'))return;delete S.machTpl[b.dataset.tpldel];save();re()});
}
// summary for the AI and the report
function machineSetupSummary(c,f1){
  const s=c.spec||{},pr=c.profile||{},t=s.trans||{},o={};
  if(s.crit)o.criticality=s.crit;if(s.standby)o.standby=true;if(s.hoursDay)o.hoursPerDay=s.hoursDay;
  if(s.motor)o.motor=Object.fromEntries(Object.entries(s.motor).filter(([k])=>k!=='serial'));
  if(c.drive&&c.drive.poles)o.motorPoles=c.drive.poles;
  if(s.driven&&s.driven.kind)o.driven=s.driven;
  if(t.kind)o.transmission=t;if(s.sensorOn)o.sensorOn=s.sensorOn;
  o.sensorAxes=Object.fromEntries(Object.entries(sensorAxesOf(c)).map(([k,v])=>[k.toUpperCase(),AXN[v]]));
  const br={};for(const[pos,l]of BPOS){const b=brgAt(c,pos);if(b&&b.code)br[l]=b.code}if(Object.keys(br).length)o.bearings=br;
  if(f1>0)o.frequenciesHz=machineFreqs(c,f1).slice(0,40).map(r=>({name:r.name,hz:+r.hz.toFixed(2)}));
  return o;
}
