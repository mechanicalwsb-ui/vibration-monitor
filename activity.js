// Activity log: one list of everything the page does - sensor connection, data added or removed, edits to
// machines/sensors/notes, settings, sync and errors. Shown in the log dock with a filter per category and
// kept in this browser (localStorage, newest 1500 lines). Never holds secrets (the Gemini key is logged
// only as "changed"). Loaded after store.js; uses the dashboard's globals at call time.

const ACT_KEY='vibmon-activity',ACT_MAX=1500;
const ACT_CAT={conn:['เชื่อมต่อ','#2563eb'],data:['ข้อมูล','#16a34a'],edit:['แก้ไข','#ea580c'],set:['ตั้งค่า','#9333ea'],sync:['ซิงก์','#0891b2'],err:['ผิดพลาด','#dc2626'],sys:['ระบบ','#64748b']};
let ACT=[];try{ACT=JSON.parse(localStorage.getItem(ACT_KEY)||'[]')||[]}catch(e){ACT=[]}
let actSaveT=null,actFilter='all';try{actFilter=localStorage.getItem(ACT_KEY+'-f')||'all'}catch(e){}

function appLog(cat,msg){
  const e={t:Date.now(),c:ACT_CAT[cat]?cat:'sys',m:String(msg)};
  ACT.push(e);if(ACT.length>ACT_MAX)ACT.splice(0,ACT.length-ACT_MAX);
  clearTimeout(actSaveT);
  actSaveT=setTimeout(()=>{try{localStorage.setItem(ACT_KEY,JSON.stringify(ACT))}catch(err){ACT.splice(0,ACT.length>>1)}},600);
  actPrepend(e);
}
const actTime=t=>new Date(t).toLocaleTimeString('th-TH',{hour12:false});
const actDay=t=>new Date(t).toLocaleDateString('th-TH',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
function actRow(e){
  const d=document.createElement('div');d.dataset.c=e.c;d.title=new Date(e.t).toLocaleString('th-TH');
  const tag=document.createElement('span');tag.className='act-tag';tag.textContent=ACT_CAT[e.c][0];tag.style.color=ACT_CAT[e.c][1];tag.style.borderColor=ACT_CAT[e.c][1];
  d.append(tag,document.createTextNode(' '+actTime(e.t)+'  '+e.m));return d;
}
function actDayRow(t){const d=document.createElement('div');d.className='act-day';d.dataset.day=new Date(t).toDateString();d.textContent=actDay(t);return d}
function actPrepend(e){
  const el=$('#dockLog');
  if(el){
    const top=el.querySelector('.act-day');
    if(!top||top.dataset.day!==new Date(e.t).toDateString())el.prepend(actDayRow(e.t));
    el.querySelector('.act-day').after(actRow(e));
    while(el.children.length>600)el.lastChild.remove();
  }
  const last=$('#ldLast');if(last){last.textContent=`[${ACT_CAT[e.c][0]}] ${actTime(e.t)}  ${e.m}`;last.classList.remove('flash');void last.offsetWidth;last.classList.add('flash')}
  const dock=$('#logDock');if(dock)dock.classList.add('has-log');
}
// whole list, newest first, with a line per day
function actRenderAll(){
  const el=$('#dockLog');if(!el)return;el.innerHTML='';el.dataset.f=actFilter;
  let day=null;const rows=ACT.slice(-600).reverse();
  for(const e of rows){const dk=new Date(e.t).toDateString();if(dk!==day){el.append(actDayRow(e.t));day=dk}el.append(actRow(e))}
  const e=ACT.at(-1);if(e&&$('#ldLast'))$('#ldLast').textContent=`[${ACT_CAT[e.c][0]}] ${actTime(e.t)}  ${e.m}`;
  if(ACT.length&&$('#logDock'))$('#logDock').classList.add('has-log');
}
function actInit(){
  const head=$('#ldFilters');
  if(head){
    head.innerHTML=[['all','ทั้งหมด'],...Object.entries(ACT_CAT).map(([k,v])=>[k,v[0]])].map(([k,l])=>`<button type="button" data-af="${k}" class="${k===actFilter?'on':''}">${l}</button>`).join('');
    head.querySelectorAll('[data-af]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();actFilter=b.dataset.af;try{localStorage.setItem(ACT_KEY+'-f',actFilter)}catch(e){}
      head.querySelectorAll('[data-af]').forEach(x=>x.classList.toggle('on',x===b));$('#dockLog').dataset.f=actFilter;if(typeof setDockOpen==='function'&&!S.logOpen)setDockOpen(true)});
  }
  actRenderAll();
  appLog('sys',`เปิดหน้าเว็บ (v${typeof APP_VERSION!=='undefined'?APP_VERSION:''})`);
}
async function actCopy(){
  const rows=ACT.filter(e=>actFilter==='all'||e.c===actFilter);
  if(!rows.length)return toast('ยังไม่มีบันทึก');
  const head=[`Vibration Monitor ${$('#appVer')?$('#appVer').textContent:''}`,`บันทึกการทำงาน${actFilter==='all'?'':' · '+ACT_CAT[actFilter][0]} (${rows.length} บรรทัด)`,`คัดลอกเมื่อ: ${new Date().toLocaleString('th-TH')}`,''];
  const text=head.concat(rows.slice().reverse().map(e=>`${new Date(e.t).toLocaleString('th-TH')}  [${ACT_CAT[e.c][0]}]  ${e.m}`)).join('\n');
  try{await navigator.clipboard.writeText(text);toast(`คัดลอกบันทึกแล้ว (${rows.length} บรรทัด)`)}
  catch(e){download('vibmon-log.txt',new Blob([text],{type:'text/plain'}));toast('คัดลอกไม่ได้ จึงบันทึกเป็นไฟล์แทน')}
}
function actClear(){if(!confirm('ล้างบันทึกการทำงานทั้งหมดในเบราว์เซอร์นี้?'))return;ACT=[];try{localStorage.removeItem(ACT_KEY)}catch(e){}actRenderAll();appLog('sys','ล้างบันทึกการทำงาน')}

// ---------- what changed at each save (called by stampChanges in store.js) ----------
const ACT_FIELD={spec:'ตั้งค่าเครื่อง',machTpl:'แม่แบบเครื่อง',cls:'ประเภทเครื่อง (ISO)',z:'เกณฑ์ความสั่น',tw:'เกณฑ์อุณหภูมิเฝ้าระวัง',ta:'เกณฑ์อุณหภูมิอันตราย',rpm:'ความเร็วรอบ',vfd:'ใช้ VFD',vanes:'จำนวนใบพัด',
  bands:'แถบความถี่',baseline:'baseline',useBaseline:'ใช้ baseline',thrSrc:'แหล่งเกณฑ์',sensorThr:'เกณฑ์จากเซนเซอร์',profile:'ข้อมูลเครื่อง',drive:'มอเตอร์/เกียร์/สายพาน',
  bearing:'bearing',refFft:'ชุดอ้างอิง FFT',maskMul:'ตัวคูณเส้นอ้างอิง',machine:'กลุ่มเครื่อง',point:'จุดวัด',runMin:'เกณฑ์เครื่องหยุด',
  asset:'ชื่อเครื่อง',scale:'รุ่นเซนเซอร์',sched:'ตารางวัด FFT',cond:'วัด FFT เมื่อเข้าโซน C/D',auto:'ตั้งชื่ออัตโนมัติ',mac:'MAC',
  type:'ประเภท',text:'รายละเอียด',t:'วันที่',title:'หัวข้อ',status:'สถานะ',action:'การแก้ไข',photo:'รูป',chart:'ภาพกราฟ',name:'ชื่อ',assets:'รายการเครื่อง',
  unit:'หน่วยความสั่น',tunit:'หน่วยอุณหภูมิ',theme:'ธีม',fcDays:'ช่วงข้อมูลคาดการณ์',gw:'Gateway',dupIgnore:'คู่ชื่อซ้ำที่ซ่อนไว้',notify:'การแจ้งเตือน',fav:'ปักหมุด'};
const ACT_QUIET={s:['schedLog','tsAuto','schedFail','names','mt','auto','sysRaw'],a:['mt','sensorThr'],m:['mt'],r:['mt'],b:['mt'],f:['mt'],n:['mt']};
const actVal=v=>v==null||v===''?'(ว่าง)':typeof v==='boolean'?(v?'เปิด':'ปิด'):typeof v==='number'?String(+v.toFixed(3)):typeof v==='string'?(v.length>40?v.slice(0,40)+'…':v):Array.isArray(v)&&v.length<=4&&v.every(x=>typeof x==='number')?v.map(x=>+x.toFixed(2)).join(' / '):null;
function actChanges(kind,prev,cur){
  const keys=new Set([...Object.keys(prev||{}),...Object.keys(cur||{})]),out=[];
  for(const k of keys){if((ACT_QUIET[kind]||[]).includes(k))continue;const a=prev?prev[k]:undefined,b=cur?cur[k]:undefined;
    if(JSON.stringify(a)===JSON.stringify(b))continue;
    if(k==='spec'&&a&&b&&typeof a==='object'&&typeof b==='object'){out.push(...actSpecChanges(a,b));continue}
    const va=actVal(a),vb=actVal(b),lbl=ACT_FIELD[k]||k;out.push(va!=null&&vb!=null&&k!=='photo'&&k!=='chart'?`${lbl} ${va} → ${vb}`:lbl)}
  return out;
}
const ACT_SPEC={crit:'ความสำคัญ',standby:'เครื่องสำรอง',hoursDay:'ชม.เดินต่อวัน',note:'หมายเหตุ',motor:'ข้อมูลมอเตอร์',driven:'เครื่องถูกขับ',trans:'การส่งกำลัง',sensorOn:'เซนเซอร์ติดที่',
  brg2:'bearing เครื่องถูกขับ',lube:'การหล่อลื่น',axes:'ทิศแกนเซนเซอร์',axesOk:'ยืนยันทิศแกน',mountType:'วิธีติดเซนเซอร์',alarm:'กฎการเตือน',pm:'แผน PM',parts:'อะไหล่',docs:'เอกสาร',vertical:'เพลาตั้ง',lubeTemp:'อุณหภูมิ bearing'};
const ACT_SUB={persist:'เกินติดกัน',risePct:'เพิ่มขึ้นเกิน %',riseRef:'เทียบกับ',notify:'แจ้งเตือน',quietFrom:'ไม่แจ้งตั้งแต่',quietTo:'ถึง',fft:'เตือนจาก FFT',make:'ยี่ห้อ',model:'รุ่น',serial:'serial',volt:'V',amp:'A',rpm:'รอบ',frame:'frame',ie:'IE',hzMin:'Hz ต่ำสุด',hzMax:'Hz สูงสุด',
  kind:'ชนิด',stages:'จำนวน stage/ชั้นเกียร์',flow:'อัตราไหล',head:'เฮด',npsh:'NPSHr',fluid:'ของเหลว',ftype:'ชนิดพัดลม',overhung:'overhung',ctype:'ชนิด',male:'กลีบ male',female:'กลีบ female',desc:'รายละเอียด',
  d1:'Ø พูลเลย์ขับ',d2:'Ø พูลเลย์ตาม',len:'ความยาวสายพาน',n:'จำนวนเส้น',coupling:'คัปปลิ้ง',x:'แกน X',y:'แกน Y',z:'แกน Z'};
function actSpecChanges(a,b){const out=[];for(const k of new Set([...Object.keys(a),...Object.keys(b)])){if(JSON.stringify(a[k])===JSON.stringify(b[k]))continue;
  const A=a[k],B=b[k],lbl=ACT_SPEC[k]||k;
  if((A==null||typeof A==='object'&&!Array.isArray(A))&&(B==null||typeof B==='object'&&!Array.isArray(B))&&(A||B)){ // one level deeper: which fields
    const sub=[];for(const s of new Set([...Object.keys(A||{}),...Object.keys(B||{})])){const x=(A||{})[s],y=(B||{})[s];if(JSON.stringify(x)===JSON.stringify(y))continue;const vx=actVal(x),vy=actVal(y);sub.push(vx!=null&&vy!=null?`${ACT_SUB[s]||s} ${vx} → ${vy}`:(ACT_SUB[s]||s))}
    out.push(`${lbl}: ${sub.join(', ')}`);continue}
  if(Array.isArray(A)||Array.isArray(B)){const na=(A||[]).length,nb=(B||[]).length;out.push(nb>na?`${lbl} +${nb-na}`:nb<na?`${lbl} −${na-nb}`:lbl);continue}
  const va=actVal(A),vb=actVal(B);out.push(va!=null&&vb!=null?`${lbl} ${va} → ${vb}`:lbl)}return out}
// ev: {kind, act:'new'|'edit'|'del', id, prev, cur}; several of the same kind at once are summed up
function actRecords(evs){
  const groups=new Map();for(const e of evs){const g=e.kind+'|'+e.act;if(!groups.has(g))groups.set(g,[]);groups.get(g).push(e)}
  const KN={a:'ค่าตั้งเครื่อง',s:'เซนเซอร์',m:'บันทึกซ่อม',r:'เส้นทางตรวจ',b:'bearing ในฐานข้อมูล',f:'รายงานความผิดปกติ',n:'โน้ต FFT'};
  for(const list of groups.values()){
    const{kind,act}=list[0];
    if(list.length>3){appLog(act==='edit'?'edit':'data',`${act==='new'?'เพิ่ม':act==='del'?'ลบ':'แก้ไข'}${KN[kind]} ${list.length} รายการ`);continue}
    for(const e of list){const o=e.cur||e.prev||{},who=kind==='a'?e.id:o.asset?o.asset:'';
      if(kind==='a'){
        if(act==='new')appLog('edit',`เพิ่มเครื่อง "${e.id}"`);else if(act==='del')appLog('edit',`ลบค่าตั้งของเครื่อง "${e.id}"`);
        else{const ch=actChanges('a',e.prev,e.cur);if(ch.length)appLog('edit',`แก้ไข "${e.id}": ${ch.join(' · ')}`)}}
      else if(kind==='s'){
        if(act==='new')appLog('conn',`จำเซนเซอร์ใหม่ → เครื่อง "${o.asset||''}"`);else if(act==='del')appLog('edit',`ลืมเซนเซอร์ของ "${o.asset||''}"`);
        else{const ch=actChanges('s',e.prev,e.cur);if(ch.length)appLog('edit',`เซนเซอร์ของ "${o.asset||''}": ${ch.join(' · ')}`)}}
      else if(kind==='m'){const d=`${o.type||'บันทึก'}${o.text?': '+String(o.text).slice(0,50):''}`;
        if(act==='new')appLog('data',`เพิ่มบันทึกซ่อม · ${who} · ${d}`);else if(act==='del')appLog('data',`ลบบันทึกซ่อม · ${who} · ${d}`);
        else{const ch=actChanges('m',e.prev,e.cur);if(ch.length)appLog('edit',`แก้ไขบันทึกซ่อม · ${who}: ${ch.join(' · ')}`)}}
      else if(kind==='f'){const d=String(o.title||'').slice(0,50);
        if(act==='new')appLog('data',`เพิ่มรายงานความผิดปกติ · ${who} · ${d}`);else if(act==='del')appLog('data',`ลบรายงานความผิดปกติ · ${who} · ${d}`);
        else{const ch=actChanges('f',e.prev,e.cur);if(ch.length)appLog('edit',`แก้ไขรายงาน "${d}": ${ch.join(' · ')}`)}}
      else if(kind==='r'){if(act==='new')appLog('edit',`เพิ่มเส้นทางตรวจ "${o.name||''}"`);else if(act==='del')appLog('edit',`ลบเส้นทางตรวจ "${o.name||''}"`);
        else{const ch=actChanges('r',e.prev,e.cur);if(ch.length)appLog('edit',`แก้ไขเส้นทาง "${o.name||''}": ${ch.join(' · ')}`)}}
      else if(kind==='b'){appLog('edit',`${act==='new'?'เพิ่ม':act==='del'?'ลบ':'แก้ไข'} bearing ${e.id} ในฐานข้อมูล`)}
      else if(kind==='n'){appLog('edit',o.text?`โน้ต FFT · ${o.asset||''}: "${String(o.text).slice(0,60)}"`:`ลบโน้ต FFT · ${o.asset||''}`)}
    }
  }
}
// readings per machine and the page-wide settings, compared with the last save
let actSnap=null;
const ACT_SKIP=new Set(['view','sel','range','logOpen','fleetF','fleetSort','stPer','cmp','rep','showFc','wfSel','wfCollapsed','lastBackup','lastMeasure','tomb','renames','favT',
  'assets','sensors','routes','brgDb','fftNotes','routeRun','readings','maint','health','ai','failures','gw','machines']);
function actSnapshot(mark){
  const cnt=new Map();for(const r of S.readings||[])cnt.set(r.asset,(cnt.get(r.asset)||0)+1);
  const set={};for(const k in S)if(!ACT_SKIP.has(k)&&k[0]!=='_'){try{set[k]=JSON.stringify(S[k])}catch(e){}}
  const ai=new Map();for(const[a,l]of Object.entries(S.ai||{}))ai.set(a,(l||[]).length);
  if(mark&&actSnap){
    for(const[a,n]of cnt){const p=actSnap.cnt.get(a)||0;if(n>p)appLog('data',`เพิ่มข้อมูล ${n-p} ค่า · ${a}${p?'':' (เครื่องใหม่)'}`);else if(n<p)appLog('data',`ลบข้อมูล ${p-n} ค่า · ${a}`)}
    for(const[a,p]of actSnap.cnt)if(!cnt.has(a))appLog('data',`ลบข้อมูลทั้งหมด ${p} ค่า · ${a}`);
    for(const[a,n]of ai){const p=actSnap.ai.get(a)||0;if(n>p)appLog('data',`บันทึกผลวิเคราะห์ AI · ${a}`);else if(n<p)appLog('data',`ลบผลวิเคราะห์ AI · ${a}`)}
    for(const k of new Set([...Object.keys(set),...Object.keys(actSnap.set)])){if(set[k]===actSnap.set[k])continue;
      let a,b;try{a=actSnap.set[k]!=null?JSON.parse(actSnap.set[k]):undefined;b=set[k]!=null?JSON.parse(set[k]):undefined}catch(e){}
      if(k==='fav'){const A=new Set(a||[]),B=new Set(b||[]);for(const x of B)if(!A.has(x))appLog('set',`ปักหมุด "${x}"`);for(const x of A)if(!B.has(x))appLog('set',`เลิกปักหมุด "${x}"`);continue}
      const va=actVal(a),vb=actVal(b);appLog('set',`${ACT_FIELD[k]||k}${va!=null&&vb!=null?`: ${va} → ${vb}`:' เปลี่ยน'}`)}
  }
  actSnap={cnt,set,ai};
}
// errors anywhere on the page
window.addEventListener('error',e=>{try{appLog('err',(e.message||'ข้อผิดพลาด')+(e.filename?` (${String(e.filename).split('/').pop().split('?')[0]}:${e.lineno})`:''))}catch(x){}});
window.addEventListener('unhandledrejection',e=>{try{appLog('err',(e.reason&&e.reason.message)||String(e.reason))}catch(x){}});
