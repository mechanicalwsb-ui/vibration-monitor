// Machine-level tools added after comparing with Adash DDS: bearing database import, machines with
// several measuring points, copying settings, failure reports, machine wizard, favourites and the
// video motion-amplification tool. Read-only towards the sensor. Uses dashboard globals at call time.

// ---------- bearing database (A5) ----------
// S.brgDb = { CODE: {n,d,D,ang,src} | {fac:{BPFO,BPFI,BSF,FTF},src} }
const _bearingGeomBuiltin=bearingGeom;
bearingGeom=function(code){
  const k=String(code||'').trim().toUpperCase().replace(/[-\s].*$/,'');
  const db=S.brgDb||{},hit=db[k]||db[String(code||'').trim().toUpperCase()];
  if(hit)return{...hit,code:k,src:hit.src||'ฐานข้อมูลที่นำเข้า'};
  return _bearingGeomBuiltin(code);
};
function brgDbImport(file){
  return file.text().then(t=>{
    const rows=parseCSV(t);if(rows.length<2)throw new Error('ไฟล์ว่าง');
    const h=rows[0].map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,'')),ix=n=>h.findIndex(x=>x===n||x.startsWith(n));
    const iC=ix('code')>=0?ix('code'):ix('bearing')>=0?ix('bearing'):0;
    const iBPFO=ix('bpfo'),iBPFI=ix('bpfi'),iBSF=ix('bsf'),iFTF=ix('ftf'),iN=ix('n')>=0?ix('n'):ix('balls'),iD=h.findIndex(x=>/^(d|balld|balldia)/.test(x)&&!/pitch/.test(x)),iP=h.findIndex(x=>/pitch|^dp|^bigd/.test(x)),iA=ix('ang')>=0?ix('ang'):ix('contact');
    const db=S.brgDb||(S.brgDb={});let n=0;const num=(r,i)=>i>=0?parseFloat(String(r[i]).replace(',','.')):NaN;
    for(const r of rows.slice(1)){const code=String(r[iC]||'').trim().toUpperCase();if(!code)continue;
      if(iBPFO>=0&&num(r,iBPFO)>0){db[code]={fac:{BPFO:num(r,iBPFO),BPFI:num(r,iBPFI),BSF:num(r,iBSF),FTF:num(r,iFTF)},src:'ตัวคูณจาก '+file.name};n++}
      else if(num(r,iN)>0&&num(r,iD)>0&&num(r,iP)>0){db[code]={n:num(r,iN),d:num(r,iD),D:num(r,iP),ang:num(r,iA)||0,src:'ขนาดจาก '+file.name};n++}}
    save();return n;
  });
}
function brgDbTemplate(){
  const csv='code,BPFO,BPFI,BSF,FTF\n6309,3.06,4.94,1.99,0.38\n\n# หรือใช้แบบขนาด:\n# code,n,d,pitch,angle\n# 6205,9,7.94,39.04,0\n';
  download('bearing-template.csv',new Blob(['\uFEFF'+csv],{type:'text/csv'}));
}

// ---------- machines with several measuring points (B1) ----------
// Each data series (asset) is one measuring point; c.machine groups points into one machine.
const machineOf=a=>(cfg(a).machine||'').trim()||a;
const pointLabel=a=>(cfg(a).point||'').trim()||a;
function pointsOf(m){return names().filter(a=>machineOf(a)===m)}
const zRank={D:4,C:3,B:2,A:1};
function worstZone(list){let w=null;for(const a of list){const z=status(lastOf(a),cfg(a));if(z&&(!w||zRank[z]>zRank[w]))w=z}return w}
function pointsStripHtml(a){
  const m=machineOf(a),pts=pointsOf(m);if(pts.length<2)return'';
  return`<div class="pstrip"><span class="muted" style="font-size:12.5px;align-self:center">จุดวัดของ <b>${esc(m)}</b>:</span>${pts.map(p=>{const z=status(lastOf(p),cfg(p));
    return`<button class="tag ${z?'z'+z:''}" style="cursor:pointer;${p===a?'outline:2px solid var(--accent)':''}" onclick="S.sel='${esc(p).replace(/'/g,"\\'")}';save();render()"><span class="dot z${z||''}"></span>${esc(pointLabel(p))} ${fv(overall(lastOf(p)))}</button>`}).join('')}
    <button class="btn sm" onclick="S.cmp={assets:${esc(JSON.stringify(pts))},mode:'assets'};setView('stats')">เปรียบเทียบจุดวัด</button></div>`;
}

// ---------- favourites (B5) ----------
const isFav=a=>(S.fav||[]).includes(a);
function toggleFav(a){S.fav=S.fav||[];S.fav=isFav(a)?S.fav.filter(x=>x!==a):[...S.fav,a];save();render()}
const favBtn=a=>`<button class="star ${isFav(a)?'on':''}" title="ปักหมุด" onclick="event.stopPropagation();toggleFav('${esc(a).replace(/'/g,"\\'")}')">${isFav(a)?'★':'☆'}</button>`;

// ---------- copy settings to other machines (template, B1) ----------
const COPY_PARTS={thr:'เกณฑ์ (ISO/แหล่งเกณฑ์/อุณหภูมิ)',bands:'แถบความถี่และเกณฑ์',drive:'มอเตอร์/เกียร์/สายพาน + RPM + ใบพัด',bearing:'bearing',run:'เกณฑ์เครื่องหยุด',profile:'ประเภท/kW/ฐาน/พื้นที่'};
function copySettings(from,targets,parts){
  const s=cfg(from),clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
  for(const t of targets){if(t===from)continue;const c=cfg(t);
    if(parts.thr)Object.assign(c,{cls:s.cls,z:clone(s.z),tw:s.tw,ta:s.ta,thrSrc:s.thrSrc==='sensor'&&c.sensorThr?'sensor':c.thrSrc==='sensor'?c.thrSrc:s.thrSrc==='sensor'?'iso':s.thrSrc});
    if(parts.bands)c.bands=clone(s.bands);
    if(parts.drive)Object.assign(c,{drive:clone(s.drive),rpm:s.rpm,vanes:s.vanes,vfd:s.vfd});
    if(parts.bearing){c.bearing=clone(s.bearing);c.profile=c.profile||{};if(s.profile){c.profile.brg=clone(s.profile.brg);c.profile.brgUse=s.profile.brgUse}}
    if(parts.run)c.runMin=s.runMin;
    if(parts.profile){c.profile=c.profile||{};const p=s.profile||{};Object.assign(c.profile,{type:p.type,kw:p.kw,found:p.found,area:p.area})}}
  save();
}
function copySettingsHtml(ns){
  if(ns.length<2)return'';
  return`<div class="panel span"><div class="ph"><h3>คัดลอกการตั้งค่าไปเครื่องอื่น</h3></div><div class="pbody">
    <div class="row"><label class="check">จากเครื่อง <select id="cpFrom">${ns.map(n=>`<option ${n===S.sel?'selected':''}>${esc(n)}</option>`).join('')}</select></label></div>
    <div class="row" style="margin-top:6px">${Object.entries(COPY_PARTS).map(([k,l])=>`<label class="check" style="font-size:13px"><input type="checkbox" data-cp="${k}" ${k==='thr'||k==='bands'?'checked':''}> ${l}</label>`).join('')}</div>
    <div class="sub-h" style="margin-top:8px">ไปที่เครื่อง</div><div class="row">${ns.map(n=>`<label class="check" style="font-size:13px"><input type="checkbox" data-cpt="${esc(n)}"> ${esc(n)}</label>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="cpGo">คัดลอก</button></div></div></div>`;
}
function bindCopySettings(){
  if(!$('#cpGo'))return;
  $('#cpGo').onclick=()=>{const from=$('#cpFrom').value,parts={},tg=[...document.querySelectorAll('[data-cpt]:checked')].map(i=>i.dataset.cpt).filter(t=>t!==from);
    document.querySelectorAll('[data-cp]').forEach(i=>parts[i.dataset.cp]=i.checked);
    if(!tg.length)return toast('เลือกเครื่องปลายทาง');if(!Object.values(parts).some(Boolean))return toast('เลือกสิ่งที่จะคัดลอก');
    if(!confirm(`คัดลอก ${Object.keys(parts).filter(k=>parts[k]).map(k=>COPY_PARTS[k]).join(', ')}\nจาก "${from}" ไปยัง ${tg.length} เครื่อง?`))return;
    copySettings(from,tg,parts);render();toast(`คัดลอกไป ${tg.length} เครื่องแล้ว`)};
}

// ---------- failure reports (B4) ----------
// S.failures = [{id,asset,t,title,symptom,evidence,cause,action,priority,owner,due,status,closedAt,photo,chart}]
const FR_PRIO={urgent:'ด่วน (หยุดตรวจ)',week:'ภายใน 1 สัปดาห์',month:'ภายใน 1 เดือน',watch:'เฝ้าติดตาม'};
const FR_ST={open:'เปิด',progress:'กำลังแก้',closed:'ปิดแล้ว'};
function openFailures(a){return(S.failures||[]).filter(f=>(!a||f.asset===a)&&f.status!=='closed')}
function failuresHtml(a){
  const list=(S.failures||[]).filter(f=>f.asset===a).sort((x,y)=>(x.status==='closed')-(y.status==='closed')||y.t-x.t);
  return`<div class="panel span"><div class="ph"><h3>รายงานความผิดปกติ (${openFailures(a).length} เรื่องที่ยังไม่ปิด)</h3><button class="btn sm primary" onclick="editFailure(null,'${esc(a).replace(/'/g,"\\'")}')">+ สร้างรายงาน</button></div>
    <div class="tablewrap"><table><thead><tr><th>วันที่</th><th>เรื่อง</th><th>ความเร่งด่วน</th><th>ผู้รับผิดชอบ</th><th>กำหนดเสร็จ</th><th>สถานะ</th><th></th></tr></thead><tbody>
    ${list.map(f=>`<tr><td>${dFull(f.t)}</td><td style="white-space:normal;text-align:left">${esc(f.title)}</td><td>${FR_PRIO[f.priority]||''}</td><td>${esc(f.owner||'')}</td>
      <td class="${f.status!=='closed'&&f.due&&new Date(f.due)<new Date()?'up':''}">${f.due?new Date(f.due).toLocaleDateString('th-TH'):''}</td><td><span class="fr-st ${f.status}">${FR_ST[f.status]}</span></td>
      <td><button class="btn sm" onclick="editFailure('${f.id}')">แก้ไข</button> <button class="btn sm" onclick="printFailure('${f.id}')">พิมพ์</button></td></tr>`).join('')||'<tr><td colspan="7" class="muted">ยังไม่มี</td></tr>'}</tbody></table></div>
    <p class="muted live-note">ใช้บันทึกปัญหาที่พบ หลักฐาน สาเหตุ และสิ่งที่ต้องทำ แล้วติดตามจนปิดงาน · สร้างจากผลวิเคราะห์ AI ได้ในเมนู "วิเคราะห์ด้วย AI"</p></div>`;
}
async function chartSnapshot(){ // the overview velocity chart or the FFT chart, whichever is on screen
  const c=document.querySelector('#faChart')||document.querySelector('#cV');try{return c?c.toDataURL('image/png'):null}catch(e){return null}
}
function editFailure(id,asset,prefill){
  S.failures=S.failures||[];
  const f=id?S.failures.find(x=>x.id===id):Object.assign({id:uid(),asset,t:Date.now(),status:'open',priority:'week',title:'',symptom:'',evidence:'',cause:'',action:'',owner:S.lastBy||''},prefill||{});
  const v=k=>esc(f[k]||'');
  infoDialog((id?'แก้ไข':'สร้าง')+'รายงานความผิดปกติ · '+esc(f.asset),`<form id="frForm" class="form" style="padding:0" onsubmit="return false">
    <label class="full">หัวข้อ<input name="title" value="${v('title')}" placeholder="เช่น Bearing DE ปั๊ม P-101 เริ่มเสียหาย"></label>
    <label class="full">อาการที่พบ<textarea name="symptom" rows="2">${v('symptom')}</textarea></label>
    <label class="full">หลักฐาน (ค่าที่วัด กราฟ FFT ผล envelope ฯลฯ)<textarea name="evidence" rows="3">${v('evidence')}</textarea></label>
    <label class="full">สาเหตุที่คาด<textarea name="cause" rows="2">${v('cause')}</textarea></label>
    <label class="full">สิ่งที่ต้องทำ<textarea name="action" rows="3">${v('action')}</textarea></label>
    <label>ความเร่งด่วน<select name="priority">${Object.entries(FR_PRIO).map(([k,l])=>`<option value="${k}" ${f.priority===k?'selected':''}>${l}</option>`).join('')}</select></label>
    <label>สถานะ<select name="status">${Object.entries(FR_ST).map(([k,l])=>`<option value="${k}" ${f.status===k?'selected':''}>${l}</option>`).join('')}</select></label>
    <label>ผู้รับผิดชอบ<input name="owner" value="${v('owner')}"></label>
    <label>กำหนดเสร็จ<input type="date" name="due" value="${v('due')}"></label>
    <label class="full check"><input type="checkbox" name="snap" ${f.chart?'checked':''}> แนบภาพกราฟที่เปิดอยู่ตอนนี้</label>
    <label class="full">รูปถ่าย<input type="file" accept="image/*" capture="environment" name="photo"></label>
    ${f.photo?`<img src="${f.photo}" class="full" style="max-height:160px;object-fit:contain">`:''}
    <div class="full row" style="justify-content:space-between">${id?'<button class="btn danger" id="frDel">ลบ</button>':'<span></span>'}<button class="btn primary" id="frSave">บันทึก</button></div></form>`);
  const fm=$('#frForm');
  $('#frSave').onclick=async()=>{
    ['title','symptom','evidence','cause','action','priority','status','owner','due'].forEach(k=>f[k]=fm[k].value.trim?fm[k].value.trim():fm[k].value);
    if(!f.title)return toast('ใส่หัวข้อ');
    f.mt=Date.now();
    if(f.status==='closed'&&!f.closedAt)f.closedAt=Date.now();if(f.status!=='closed')f.closedAt=null;
    if(fm.snap.checked&&!f.chart)f.chart=await chartSnapshot();if(!fm.snap.checked)f.chart=null;
    if(fm.photo.files[0])f.photo=await shrinkImage(fm.photo.files[0]);
    if(!S.failures.includes(f))S.failures.push(f);S.lastBy=f.owner||S.lastBy;save();$('#infoDlg').close();render();toast('บันทึกรายงานแล้ว')};
  if($('#frDel'))$('#frDel').onclick=()=>{if(!confirm('ลบรายงานนี้?'))return;tomb().failures.push(f.id);S.failures=S.failures.filter(x=>x!==f);save();$('#infoDlg').close();render()};
}
function failureHtml(f){
  const row=(l,t)=>t?`<tr><th style="width:28%">${l}</th><td style="white-space:pre-wrap">${esc(t)}</td></tr>`:'';
  return`<div class="rp-head"><div><h1>รายงานความผิดปกติของเครื่องจักร</h1><p>${esc((S.rep&&S.rep.org)||'')}</p></div><div class="rp-meta">เลขที่ ${f.id}<br>วันที่ ${new Date(f.t).toLocaleString('th-TH')}</div></div>
    <table class="rp">${row('เครื่องจักร',f.asset)}${row('หัวข้อ',f.title)}${row('อาการที่พบ',f.symptom)}${row('หลักฐาน',f.evidence)}${row('สาเหตุที่คาด',f.cause)}${row('สิ่งที่ต้องทำ',f.action)}
    ${row('ความเร่งด่วน',FR_PRIO[f.priority])}${row('ผู้รับผิดชอบ',f.owner)}${row('กำหนดเสร็จ',f.due?new Date(f.due).toLocaleDateString('th-TH'):'')}${row('สถานะ',FR_ST[f.status]+(f.closedAt?' ('+new Date(f.closedAt).toLocaleDateString('th-TH')+')':''))}</table>
    ${f.chart?`<img class="rp-chart" src="${f.chart}" style="background:#fff">`:''}${f.photo?`<img src="${f.photo}" style="max-width:60%;margin-top:8px">`:''}
    <div class="rp-sign"><div>ผู้รายงาน<br><br>.............................................<br>(.............................................)</div><div>ผู้อนุมัติ<br><br>.............................................<br>(.............................................)</div></div>`;
}
function printFailure(id){const f=(S.failures||[]).find(x=>x.id===id);if(f)printHtml(failureHtml(f))}
// From an AI answer: first heading/line becomes the title, the rest goes to evidence/action
function failureFromAI(asset,text){
  const lines=text.split('\n').map(l=>l.replace(/^#+\s*/,'').trim()).filter(Boolean);
  const pick=re=>{const i=lines.findIndex(l=>re.test(l));if(i<0)return'';const out=[];for(let j=i+1;j<lines.length&&!/^(สรุป|สิ่งที่พบ|สาเหตุ|สิ่งที่ควรทำ|ข้อมูลที่ควร)/.test(lines[j]);j++)out.push(lines[j]);return out.join('\n').replace(/\*\*/g,'')};
  editFailure(null,asset,{title:(pick(/^สรุป/)||lines[0]||'').split('\n')[0].replace(/\*\*/g,'').slice(0,120),evidence:pick(/^สิ่งที่พบ/),cause:pick(/^สาเหตุ/),action:pick(/^สิ่งที่ควรทำ/)});
}

// ---------- create-machine wizard (B5) ----------
function openWizard(asset){
  const W={step:0,d:asset?{name:asset,...JSON.parse(JSON.stringify(cfg(asset)))}:{name:'',profile:{},drive:{}}};
  W.d.profile=W.d.profile||{};W.d.drive=W.d.drive||{};
  const steps=['ชื่อและจุดวัด','ประเภทเครื่อง','ต้นกำลัง','bearing / ใบพัด','เกณฑ์','สรุป'];
  const draw=()=>{const d=W.d,p=d.profile,dr=d.drive;let body='';
    if(W.step===0)body=`<label class="full">ชื่อจุดวัด/เครื่อง (ชื่อที่ใช้เก็บข้อมูล)<input id="wName" value="${esc(d.name)}" ${asset?'disabled':''} placeholder="เช่น P-101 Motor DE"></label>
      <label>เครื่องจักร (กลุ่ม)<input id="wMach" value="${esc(d.machine||'')}" placeholder="เช่น P-101"></label><label>ชื่อจุดวัด<input id="wPoint" value="${esc(d.point||'')}" placeholder="เช่น Motor DE"></label>`;
    if(W.step===1)body=`<label>ประเภท<select id="wType">${['ปั๊ม','มอเตอร์','พัดลม/โบลเวอร์','เกียร์','คอมเพรสเซอร์','อื่น ๆ'].map(x=>`<option ${p.type===x?'selected':''}>${x}</option>`).join('')}</select></label>
      <label>กำลัง (kW)<input type="number" id="wKw" value="${p.kw??''}"></label><label>ฐาน<select id="wFound"><option value="rigid">แข็ง</option><option value="flexible" ${p.found==='flexible'?'selected':''}>ยืดหยุ่น</option></select></label>
      <label>พื้นที่<input id="wArea" value="${esc(p.area||'')}"></label>`;
    if(W.step===2)body=`<label>RPM ที่เซนเซอร์วัด<input type="number" id="wRpm" value="${d.rpm??''}"></label><label class="check" style="align-self:end"><input type="checkbox" id="wVfd" ${d.vfd?'checked':''}> ใช้ inverter (VFD)</label>
      <label>จำนวนขั้วมอเตอร์<select id="wPoles"><option value="">ไม่ทราบ/ไม่ใช่มอเตอร์</option>${[2,4,6,8].map(n=>`<option ${+dr.poles===n?'selected':''}>${n}</option>`).join('')}</select></label>
      <label>ความถี่ไฟ (Hz)<input type="number" id="wLf" value="${dr.lineHz||50}"></label><label>จำนวน rotor bar (ถ้าทราบ)<input type="number" id="wBars" value="${dr.bars??''}"></label>
      <label>ฟันเฟืองบนเพลานี้ (ถ้ามีเกียร์)<input type="number" id="wTeeth" value="${dr.teeth??''}"></label><label>อัตราทดสายพาน/เกียร์ (รอบตัวตาม ÷ รอบเพลานี้)<input type="number" step="any" id="wBelt" value="${dr.beltRatio??''}"></label>`;
    if(W.step===3)body=`<label>เบอร์ bearing (DE)<input id="wBrg" list="brgList2" value="${esc((p.brg&&p.brg.de&&p.brg.de.code)||'')}"><datalist id="brgList2">${BRG_LIST.concat(Object.keys(S.brgDb||{})).map(x=>`<option value="${x}">`).join('')}</datalist></label>
      <label>จำนวนใบพัด<input type="number" id="wVanes" value="${d.vanes??''}"></label>`;
    if(W.step===4){const k=isoClassFor(p);body=`<label class="full">เกณฑ์ ISO<select id="wCls">${Object.entries(CLASSES).filter(([x])=>x!=='custom').map(([x,v])=>`<option value="${x}" ${(d.cls||k)===x?'selected':''}>${v.n}${x===k?' (แนะนำ)':''}</option>`).join('')}</select></label>
      <label class="full check"><input type="checkbox" id="wBands" checked> สร้างแถบความถี่มาตรฐาน (1X, 2X, 3–10X, HF …)</label>`}
    if(W.step===5)body=`<div class="full" style="font-size:13px;line-height:1.8">ชื่อ: <b>${esc(d.name)}</b>${d.machine?` · เครื่อง ${esc(d.machine)} / ${esc(d.point||'')}`:''}<br>
      ${esc(p.type||'')} ${p.kw?p.kw+' kW':''} · ${d.rpm?d.rpm+' RPM':'ไม่ทราบรอบ'}${d.vfd?' (VFD)':''}<br>
      ${dr.poles?`มอเตอร์ ${dr.poles} ขั้ว ${dr.lineHz||50} Hz`:''} ${dr.teeth?`· เฟือง ${dr.teeth} ฟัน`:''} ${dr.beltRatio?`· ทด ${dr.beltRatio}`:''}<br>
      bearing: ${esc((p.brg&&p.brg.de&&p.brg.de.code)||'-')} · ใบพัด ${d.vanes||'-'} · เกณฑ์ ${esc((CLASSES[d.cls]||{}).n||'')}</div>
      ${asset?'':'<p class="full muted" style="font-size:12px;margin:0">กด "เสร็จ" แล้วไปเชื่อมต่อเซนเซอร์ ระบบจะใช้ชื่อนี้กับเซนเซอร์ตัวถัดไปที่เชื่อม</p>'}`;
    infoDialog(asset?'ตั้งค่าเครื่องด้วยตัวช่วย':'สร้างเครื่องจักรใหม่',`<div class="wiz-steps">${steps.map((s,i)=>`<span class="${i===W.step?'on':''}">${i+1}. ${s}</span>`).join('')}</div>
      <div class="form" style="padding:0">${body}</div><div class="row" style="justify-content:space-between;margin-top:12px">
      <button class="btn" id="wBack" ${W.step?'':'disabled'}>ย้อนกลับ</button><button class="btn primary" id="wNext">${W.step===steps.length-1?'เสร็จ':'ถัดไป'}</button></div>`);
    $('#wBack').onclick=()=>{read();W.step--;draw()};
    $('#wNext').onclick=()=>{read();if(W.step===0&&!W.d.name)return toast('ใส่ชื่อ');if(W.step<steps.length-1){W.step++;draw()}else finish()}};
  const val=id=>{const e=$('#'+id);return e?e.type==='checkbox'?e.checked:e.value.trim():undefined};
  const nz=v=>v===''||v==null?null:+v;
  const read=()=>{const d=W.d,p=d.profile,dr=d.drive;
    if(W.step===0){if(!asset)d.name=val('wName');d.machine=val('wMach');d.point=val('wPoint')}
    if(W.step===1){p.type=val('wType');p.kw=nz(val('wKw'));p.found=val('wFound');p.area=val('wArea')}
    if(W.step===2){d.rpm=nz(val('wRpm'));d.vfd=val('wVfd');dr.poles=nz(val('wPoles'));dr.lineHz=nz(val('wLf'))||50;dr.bars=nz(val('wBars'));dr.teeth=nz(val('wTeeth'));dr.beltRatio=nz(val('wBelt'))}
    if(W.step===3){const code=val('wBrg'),g=code&&bearingGeom(code);p.brg=p.brg||{};if(code)p.brg.de={code,...(g||{})};p.brgUse='de';d.vanes=nz(val('wVanes'))}
    if(W.step===4){d.cls=val('wCls');d._bands=val('wBands')}};
  const finish=()=>{const d=W.d,c=cfg(d.name);
    Object.assign(c,{machine:d.machine||'',point:d.point||'',profile:d.profile,drive:d.drive,rpm:d.rpm,vfd:!!d.vfd,vanes:d.vanes});
    if(d.cls&&CLASSES[d.cls]&&CLASSES[d.cls].z){c.cls=d.cls;c.z=[...CLASSES[d.cls].z]}
    const b=d.profile.brg&&d.profile.brg.de;if(b&&(b.fac||(b.n&&b.d&&b.D)))c.bearing=b.fac?{fac:b.fac}:{n:b.n,d:b.d,D:b.D,ang:b.ang||0};
    if(d._bands&&!c.bands)c.bands=defaultBands();
    save();$('#infoDlg').close();
    if(asset){render();toast('บันทึกการตั้งค่าเครื่องแล้ว')}
    else{$('#bleForm').asset.value=d.name;setView('sensor');toast(`สร้าง "${d.name}" แล้ว — เชื่อมต่อเซนเซอร์ของเครื่องนี้ได้เลย`)}};
  draw();
}

// ---------- video motion amplification (C3) ----------
// Eulerian linear magnification: per pixel temporal band-pass (difference of two first-order
// low-pass filters) amplified and added back. Works on a short clip taken from a tripod.
const VID={frames:null,w:0,h:0,fps:30,playing:false,sig:null};
function renderVideoPage(){
  const p=$('#videoPage');
  p.innerHTML=`<div class="mainhead"><h2>ขยายการสั่นจากวิดีโอ (ทดลอง)</h2></div>
  <div class="panel pbody"><ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.8">
    <li>ตั้งแท็บเล็ต/มือถือบนขาตั้งให้นิ่งที่สุด ถ่ายเครื่องขณะเดิน 3–8 วินาที (แสงสว่างพอ ไม่ซูมดิจิทัล)</li>
    <li>เลือกไฟล์วิดีโอ เลือกช่วงความถี่ที่สนใจ (เช่น รอบเพลา ${S.sel&&cfg(S.sel).rpm?'≈ '+(cfg(S.sel).rpm/60).toFixed(1)+' Hz':''}) และกำลังขยาย แล้วกด "ประมวลผล"</li>
    <li>ดูส่วนที่ขยับมากผิดปกติ เช่น ฐานโยก น็อตหลวม ท่อสั่น</li></ol>
    <div class="form" style="padding:10px 0 0;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <label>ไฟล์วิดีโอ<input type="file" accept="video/*" capture="environment" id="vFile"></label>
      <label>ความถี่ต่ำสุด (Hz)<input type="number" step="any" id="vLo" value="${S.vidLo??0.5}"></label>
      <label>ความถี่สูงสุด (Hz)<input type="number" step="any" id="vHi" value="${S.vidHi??5}"></label>
      <label>กำลังขยาย ×<input type="number" id="vAmp" value="${S.vidAmp??20}"></label>
      <label>ความละเอียด<select id="vRes"><option value="240">240 px (เร็ว)</option><option value="360" ${S.vidRes==360?'selected':''}>360 px</option></select></label>
      <div style="align-self:end"><button class="btn primary" id="vGo">ประมวลผล</button></div></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">กล้องมือถือถ่าย ~30 ภาพ/วินาที จึงเห็นการสั่นได้ไม่เกิน ~15 Hz (รอบเพลา 900 RPM) การสั่นที่เร็วกว่านั้นจะแสดงเป็นความถี่ต่ำปลอม (aliasing) · ประมวลผลในเครื่องนี้ ไม่อัปโหลดวิดีโอ</p></div>
  <div class="vid-wrap" style="margin-top:12px"><div class="panel pbody"><div class="sub-h">ต้นฉบับ</div><video id="vSrc" muted playsinline controls></video></div>
    <div class="panel pbody"><div class="sub-h">ขยายการสั่น <span id="vInfo" class="muted"></span></div><canvas id="vOut"></canvas>
      <div class="row" style="margin-top:6px"><button class="btn sm" id="vPlay" disabled>▶ เล่น/หยุด</button></div></div>
    <div class="panel"><div class="ph"><h3>ความถี่การเคลื่อนที่ในภาพ</h3></div><div class="cbox"><canvas id="vSpec"></canvas></div></div></div>`;
  const f=$('#vFile');f.onchange=()=>{if(f.files[0]){$('#vSrc').src=URL.createObjectURL(f.files[0])}};
  $('#vGo').onclick=()=>{S.vidLo=+$('#vLo').value;S.vidHi=+$('#vHi').value;S.vidAmp=+$('#vAmp').value;S.vidRes=+$('#vRes').value;save();processVideo()};
  $('#vPlay').onclick=()=>{VID.playing=!VID.playing;if(VID.playing)playVideoOut()};
}
async function processVideo(){
  const v=$('#vSrc');if(!v.src)return toast('เลือกไฟล์วิดีโอก่อน');
  await new Promise(r=>{if(v.readyState>=1)r();else v.onloadedmetadata=r});
  if(!isFinite(v.duration)){ // some recorders (WebM) write no duration: seek far to make the browser scan it
    v.currentTime=1e7;await new Promise(r=>{const t=setTimeout(r,3000);v.ondurationchange=()=>{if(isFinite(v.duration)){clearTimeout(t);r()}}});v.currentTime=0}
  const W=S.vidRes||240,H=Math.round(W*v.videoHeight/v.videoWidth/2)*2,fps=30,dur=Math.min(v.duration||0,8),N=Math.floor(dur*fps);
  if(N<30)return toast('วิดีโอสั้นเกินไป (ต้องอย่างน้อย 1 วินาที)');
  const cv_=document.createElement('canvas');cv_.width=W;cv_.height=H;const g=cv_.getContext('2d',{willReadFrequently:true});
  const lo=Math.max(0.05,S.vidLo||0.5),hi=Math.min(fps/2-0.1,S.vidHi||5),amp=S.vidAmp||20;
  const a1=1-Math.exp(-2*Math.PI*hi/fps),a2=1-Math.exp(-2*Math.PI*lo/fps); // first-order low-pass coefficients
  const n=W*H,l1=new Float32Array(n),l2=new Float32Array(n),frames=[],sig=new Float32Array(N);
  v.pause();$('#vInfo').textContent='กำลังอ่านภาพ…';
  for(let i=0;i<N;i++){
    v.currentTime=i/fps;await new Promise(r=>{v.onseeked=r});
    g.drawImage(v,0,0,W,H);const im=g.getImageData(0,0,W,H),d=im.data;let s=0;
    for(let p=0,q=0;p<n;p++,q+=4){const y=0.299*d[q]+0.587*d[q+1]+0.114*d[q+2];
      if(i===0){l1[p]=l2[p]=y}else{l1[p]+=a1*(y-l1[p]);l2[p]+=a2*(y-l2[p])}
      const b=(l1[p]-l2[p])*amp;s+=l1[p]-l2[p];d[q]+=b;d[q+1]+=b;d[q+2]+=b}
    sig[i]=s/n;frames.push(im);
    if(i%10===0)$('#vInfo').textContent=`ประมวลผล ${Math.round(i/N*100)}%`;
  }
  Object.assign(VID,{frames,w:W,h:H,fps,sig});
  const out=$('#vOut');out.width=W;out.height=H;$('#vPlay').disabled=false;$('#vInfo').textContent=`${N} ภาพ · ${lo}–${hi} Hz · ×${amp}`;
  VID.playing=true;playVideoOut();
  // frequency content of the mean motion signal
  const m=pow2(N),{re,im}=fftReal(Array.from(sig).map((x,i)=>x*(0.5-0.5*Math.cos(2*Math.PI*i/(N-1)))),m),pts=[];
  for(let k=1;k<m/2;k++)pts.push({x:k*fps/m,y:Math.hypot(re[k],im[k])});
  pCharts.forEach(c=>c.destroy());pCharts=[];const k=css(),o=opts('ขนาด (สัมพัทธ์)');o.scales.x={type:'linear',min:0,max:fps/2,title:{display:true,text:'Hz',color:k.muted},ticks:{color:k.muted},grid:{color:k.line}};
  pCharts.push(new Chart($('#vSpec'),{type:'line',data:{datasets:[{label:'การเปลี่ยนแปลงของภาพ',data:pts,borderColor:k.x,backgroundColor:k.x,borderWidth:1.4,pointRadius:0}]},options:o}));
}
function playVideoOut(){
  const out=$('#vOut');if(!out||!VID.frames)return;const g=out.getContext('2d');let i=0,last=0;
  const step=t=>{if(!VID.playing||!document.body.contains(out))return;if(t-last>=1000/VID.fps){g.putImageData(VID.frames[i],0,0);i=(i+1)%VID.frames.length;last=t}requestAnimationFrame(step)};
  requestAnimationFrame(step);
}

// ---------- one sensor = one machine: find duplicates and merge them under one chosen name ----------
// A sensor ends up under two machine names when it is renamed, or seen again under a new browser id.
// Evidence used: the sensor's own name history, the same MAC, and identical readings at the same times.
function noteSensorName(sv,name){if(!sv||!name)return;sv.names=sv.names||[];if(!sv.names.includes(name))sv.names.push(name)}
function findDuplicateAssets(){
  const ns=names(),groups=[],seen=new Set(),dismissed=S.dupIgnore||[];
  const add=(list,why,mac)=>{list=[...new Set(list)].filter(a=>ns.includes(a));if(list.length<2)return;
    const key=list.slice().sort().join('|');if(seen.has(key)||dismissed.includes(key))return;seen.add(key);groups.push({assets:list,why,mac})};
  // 1. name history and MAC of each remembered sensor
  const byMac={};
  for(const sv of Object.values(S.sensors||{})){
    add([sv.asset,...(sv.names||[])],'เซนเซอร์ตัวนี้เคยใช้ชื่อเหล่านี้',sv.mac);
    if(sv.mac)(byMac[sv.mac]=byMac[sv.mac]||[]).push(sv.asset,...(sv.names||[]));
  }
  for(const[mac,list]of Object.entries(byMac))add(list,'MAC เดียวกัน '+mac,mac);
  // 2. names that differ only in upper/lower case or spacing ("i-ALERT3 another" / "i-ALERT3 Another")
  const norm=a=>a.toLowerCase().replace(/\s+/g,' ').trim(),byNorm={};
  for(const a of ns)(byNorm[norm(a)]=byNorm[norm(a)]||[]).push(a);
  for(const list of Object.values(byNorm))if(list.length>1){const sv=Object.values(S.sensors||{}).find(v=>list.includes(v.asset)&&v.mac);
    add(list,'ชื่อเหมือนกัน ต่างแค่ตัวพิมพ์เล็ก/ใหญ่หรือช่องว่าง',sv&&sv.mac)}
  // 3. identical readings at identical timestamps (same sensor downloaded under two names)
  const idx=new Map();for(const a of ns){const m=new Map();for(const r of series(a))if(!r.live&&r.vx!=null)m.set(r.t,r);idx.set(a,m)}
  for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++){
    const A=idx.get(ns[i]),B=idx.get(ns[j]);let same=0;
    for(const[t,r]of A){const q=B.get(t);if(q&&q.vx===r.vx&&q.vy===r.vy&&q.vz===r.vz)same++}
    if(same>=10&&same>=0.3*Math.min(A.size,B.size)){const sv=Object.values(S.sensors).find(v=>v.asset===ns[i]||v.asset===ns[j]);
      add([ns[i],ns[j]],`ค่าที่วัดตรงกันทุกตัว ${same} ค่า (เวลาเดียวกัน)`,sv&&sv.mac)}
  }
  // groups sharing a machine name are the same sensor: join them so the user picks one name once
  const out=[];
  for(const g of groups){const hit=out.find(o=>o.assets.some(x=>g.assets.includes(x)));
    if(hit){hit.assets=[...new Set([...hit.assets,...g.assets])];if(!hit.why.includes(g.why))hit.why+=' · '+g.why;hit.mac=hit.mac||g.mac}else out.push({...g,assets:[...g.assets]})}
  return out.filter(o=>!dismissed.includes(o.assets.slice().sort().join('|')));
}
function dupBannerHtml(){
  const g=findDuplicateAssets();if(!g.length)return'';
  return g.map((d,i)=>`<div class="panel banner warn" data-dup="${i}"><span>พบเครื่องจักร ${d.assets.length} ชื่อที่น่าจะเป็น<b>เซนเซอร์ตัวเดียวกัน</b>${d.mac?` (MAC ${esc(d.mac)})`:''}: ${d.assets.map(a=>`<b>${esc(a)}</b> (${series(a).length} ค่า)`).join(', ')} · ${esc(d.why)}</span>
    <span class="row"><button class="btn primary" onclick="askMerge(${i})">เลือก 1 ชื่อแล้วรวมข้อมูล</button><button class="btn sm" onclick="ignoreDup(${i})">ไม่ใช่ตัวเดียวกัน</button></span></div>`).join('');
}
function ignoreDup(i){const d=findDuplicateAssets()[i];if(!d)return;S.dupIgnore=[...(S.dupIgnore||[]),d.assets.slice().sort().join('|')];save();render()}
function askMerge(i,assetsIn){
  const d=assetsIn?{assets:assetsIn}:findDuplicateAssets()[i];if(!d)return;
  const def=d.assets.slice().sort((a,b)=>series(b).at(-1).t-series(a).at(-1).t)[0];
  infoDialog('รวมเป็นเครื่องเดียว — เลือกชื่อที่จะใช้',`<div class="form" style="padding:0">
    ${d.assets.map(a=>{const s=series(a);return`<label class="full check" style="font-size:14px"><input type="radio" name="mgName" value="${esc(a)}" ${a===def?'checked':''}> <b>${esc(a)}</b> <span class="muted">· ${s.length} ค่า · ${dShort(s[0].t)} – ${dShort(s.at(-1).t)}</span></label>`}).join('')}
    <label class="full check" style="font-size:14px"><input type="radio" name="mgName" value="__new"> ชื่อใหม่: <input id="mgNew" placeholder="เช่น P-101 ปั๊มน้ำดิบ" style="flex:1"></label>
    <p class="full muted" style="margin:0;font-size:12px">ข้อมูลทั้งหมด (trend, FFT, บันทึกซ่อม, รายงานความผิดปกติ, ผล AI, การตั้งค่า) จะย้ายมาอยู่ในชื่อที่เลือก ค่าที่ซ้ำเวลาเดียวกันจะเก็บไว้ค่าเดียว เซนเซอร์จะใช้ชื่อนี้ต่อไป · แนะนำให้กด "สำรองข้อมูล" ก่อน</p>
    <div class="full row" style="justify-content:flex-end"><button class="btn" onclick="exportBackup()">สำรองข้อมูลก่อน</button><button class="btn primary" id="mgGo">รวมข้อมูล</button></div></div>`);
  $('#mgGo').onclick=async()=>{let to=(document.querySelector('input[name=mgName]:checked')||{}).value;
    if(to==='__new'){to=$('#mgNew').value.trim();if(!to)return toast('ใส่ชื่อใหม่')}
    $('#mgGo').disabled=true;const n=await mergeAssets(d.assets.filter(a=>a!==to),to);$('#infoDlg').close();render();toast(`รวมเป็น "${to}" แล้ว (${n} ค่า)`)};
}
// Move everything stored under `froms` to `to`
async function mergeAssets(froms,to){
  froms=froms.filter(a=>a!==to);if(!froms.length)return series(to).length;
  S.renames=S.renames||{};for(const f of froms)S.renames[f]=to;delete S.renames[to];
  const keep=new Map();for(const r of S.readings)if(r.asset===to)keep.set(r.t,r);
  S.readings=S.readings.filter(r=>{
    if(!froms.includes(r.asset))return true;
    const ex=keep.get(r.t);if(ex){if(ex.live&&!r.live){Object.assign(ex,r,{asset:to});delete ex.live}return false}
    r.asset=to;keep.set(r.t,r);return true});
  const tc=cfg(to);
  for(const f of froms){const fc=S.assets[f];if(fc){for(const[k,v]of Object.entries(fc))if(tc[k]==null||(k==='profile'&&!Object.keys(tc.profile||{}).length))tc[k]=v;delete S.assets[f]}}
  const ren=list=>(list||[]).forEach(x=>{if(froms.includes(x.asset))x.asset=to});
  ren(S.maint);ren(S.failures);
  if(S.ai)for(const f of froms)if(S.ai[f]){S.ai[to]=[...(S.ai[to]||[]),...S.ai[f]];delete S.ai[f]}
  for(const sv of Object.values(S.sensors||{}))if(froms.includes(sv.asset)||sv.asset===to){froms.forEach(f=>noteSensorName(sv,f));sv.asset=to;sv.auto=false;noteSensorName(sv,to)}
  if(ble.cfg&&froms.includes(ble.cfg.asset))ble.cfg.asset=to;
  (S.routes||[]).forEach(r=>{r.assets=[...new Set(r.assets.map(a=>froms.includes(a)?to:a))]});
  S.fav=[...new Set((S.fav||[]).map(a=>froms.includes(a)?to:a))];
  if(froms.includes(S.sel)||!S.sel)S.sel=to;
  // FFT captures: the key starts with the machine name, so re-store them under the new key
  try{const all=await FFTDB.all(),have=new Set(all.map(r=>r.key));const db=await FFTDB.open();
    for(const r of all)if(froms.includes(r.asset)){const old=r.key,nk=to+old.slice(r.asset.length);r.asset=to;r.key=nk;
      if(!have.has(nk))await FFTDB.put(r);await new Promise(res=>{const t=db.transaction('rec','readwrite');t.objectStore('rec').delete(old);t.oncomplete=res;t.onerror=res})}
    if(S.assets[to]&&froms.some(f=>String(S.assets[to].refFft||'').startsWith(f+'|')))S.assets[to].refFft=to+S.assets[to].refFft.slice(S.assets[to].refFft.indexOf('|'))}catch(e){console.warn(e)}
  faDecCache.clear();save();persistBig(true);
  return series(to).length;
}
function mergeToolHtml(ns){
  if(ns.length<2)return'';
  return`<div class="panel span"><div class="ph"><h3>รวมเครื่องจักร (ชื่อซ้ำของเซนเซอร์เดียวกัน)</h3></div><div class="pbody">
    <div class="row">${ns.map(n=>`<label class="check" style="font-size:13px"><input type="checkbox" data-mg="${esc(n)}"> ${esc(n)} <span class="muted">(${series(n).length})</span></label>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn" id="mgPick">รวมที่เลือก…</button></div>
    <p class="muted" style="margin:6px 0 0;font-size:12px">ใช้เมื่อเครื่องเดียวกันถูกเก็บเป็นหลายชื่อ เลือก 2 ชื่อขึ้นไป แล้วเลือกชื่อที่จะใช้ต่อ${(S.dupIgnore||[]).length?` · ซ่อนคู่ที่กด "ไม่ใช่ตัวเดียวกัน" ไว้ ${S.dupIgnore.length} คู่ <a href="#" onclick="S.dupIgnore=[];save();render();return false">แสดงอีกครั้ง</a>`:''}</p></div></div>`;
}
function bindMergeTool(){if(!$('#mgPick'))return;$('#mgPick').onclick=()=>{const sel=[...document.querySelectorAll('[data-mg]:checked')].map(i=>i.dataset.mg);if(sel.length<2)return toast('เลือกอย่างน้อย 2 เครื่อง');askMerge(null,sel)}}
