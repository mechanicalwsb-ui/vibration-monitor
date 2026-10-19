// Storage for the dashboard: small settings in localStorage, large collections in IndexedDB,
// plus full backup/restore (including FFT captures). Loaded before the dashboard script; uses its
// globals at call time (S, KEY, FFTDB, toast, render, APP_VERSION, esc).

// Collections that grow without limit live in IndexedDB (localStorage holds ~5 MB in total)
const BIGKEYS=['readings','maint','health','ai','failures'];
const VDB={
  db:null,
  open(){return this.db||(this.db=new Promise((res,rej)=>{
    const q=indexedDB.open('vibmon-data',1);
    q.onupgradeneeded=()=>q.result.createObjectStore('kv');
    q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)}))},
  async get(k){const db=await this.open();return new Promise((res,rej)=>{
    const q=db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})},
  async put(k,v){const db=await this.open();return new Promise((res,rej)=>{
    const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('บันทึกไม่สำเร็จ (พื้นที่เก็บข้อมูลอาจเต็ม)'))})}
};
const store={idb:false,timer:null,writing:null,err:null};

// Small part: everything except BIGKEYS (and anything starting with "_", which is runtime-only)
function smallState(){const o={};for(const k in S)if(!BIGKEYS.includes(k)&&k[0]!=='_')o[k]=S[k];return o}
function persistBig(now){
  clearTimeout(store.timer);
  const run=async()=>{
    try{for(const k of BIGKEYS)await VDB.put(k,S[k]);store.err=null}
    catch(e){store.err=e;console.error(e);toast('บันทึกข้อมูลลงเครื่องไม่สำเร็จ: '+e.message)}
  };
  if(now)return store.writing=run();
  store.timer=setTimeout(()=>{store.writing=run()},400);
}
// Edit times (mt) for records that can be changed on any device, so a sync keeps the newest version
// instead of whichever device happened to have it first. Records are compared with how they looked at the
// last save, which catches every edit without touching each settings form.
const STAMP=new Map();
// The same comparison feeds the activity log (activity.js): new / edited / deleted records at each save.
function stampChanges(mark){
  if(typeof machineShareSync==='function')try{machineShareSync(mark,STAMP)}catch(e){console.warn(e)} // shared machine settings to every point
  const now=Date.now(),evs=[],seen=new Set();
  const one=(k,o)=>{if(!o||typeof o!=='object')return;seen.add(k);const{mt,...rest}=o;let h;try{h=JSON.stringify(rest)}catch(e){return}
    const p=STAMP.get(k);
    if(mark&&(p===undefined?o.mt==null:p!==h))o.mt=now;
    if(mark&&p!==h)evs.push({kind:k[0],act:p===undefined?'new':'edit',id:k.slice(2),prev:p===undefined?null:JSON.parse(p),cur:rest});
    STAMP.set(k,h)};
  for(const[a,o]of Object.entries(S.assets||{}))one('a|'+a,o);
  for(const[id,o]of Object.entries(S.sensors||{}))one('s|'+id,o);
  for(const m of S.maint||[])one('m|'+m.id,m);
  for(const r of S.routes||[])one('r|'+r.id,r);
  for(const[k,o]of Object.entries(S.brgDb||{}))one('b|'+k,o);
  for(const f of S.failures||[])one('f|'+f.id,f);
  for(const[k,o]of Object.entries(S.fftNotes||{}))one('n|'+k,o);
  for(const[k,h]of STAMP)if(!seen.has(k)){if(mark)evs.push({kind:k[0],act:'del',id:k.slice(2),prev:JSON.parse(h),cur:null});STAMP.delete(k)}
  try{if(mark&&typeof actRecords==='function')actRecords(evs);if(typeof actSnapshot==='function')actSnapshot(mark)}catch(e){console.warn(e)}
}
function saveState(){
  if(typeof idxDirty==='function')idxDirty();
  try{stampChanges(true)}catch(e){console.warn(e)}
  if(typeof gdMarkDirty==='function')try{gdMarkDirty()}catch(e){}
  if(typeof tabSaved==='function')tabSaved();
  if(!store.idb){ // IndexedDB unavailable (e.g. some private modes): everything in localStorage as before
    const all=smallState();for(const k of BIGKEYS)all[k]=S[k];
    try{localStorage.setItem(KEY,JSON.stringify(all))}
    catch(e){toast('บันทึกในเบราว์เซอร์ไม่ได้ (พื้นที่เต็ม) ควรสำรองข้อมูลและเปิดในเบราว์เซอร์ปกติ')}
    return;
  }
  try{localStorage.setItem(KEY,JSON.stringify(smallState()))}catch(e){toast('บันทึกค่าตั้งค่าไม่ได้: '+e.message)}
  persistBig();
}
// Flush pending writes when the tab is hidden or closed (tablets often kill background tabs)
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&store.idb&&store.timer)persistBig(true)});

async function loadState(){
  let j=null;try{j=JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){}
  if(j)Object.assign(S,j);
  try{
    await VDB.open();store.idb=true;
    const legacy=j&&Array.isArray(j.readings)&&j.readings.length; // data saved by v1.11 and older
    if(legacy){
      // Move readings to IndexedDB; only drop them from localStorage once the copy reads back complete
      await persistBig(true);
      const back=await VDB.get('readings');
      if(back&&back.length===S.readings.length){localStorage.setItem(KEY,JSON.stringify(smallState()));console.info('moved',back.length,'readings to IndexedDB')}
      else throw new Error('ตรวจสอบการย้ายข้อมูลไม่ผ่าน');
    }else{
      for(const k of BIGKEYS){const v=await VDB.get(k);if(v!=null)S[k]=v}
    }
  }catch(e){store.idb=false;console.warn('IndexedDB unavailable, using localStorage',e)}
  for(const k of BIGKEYS)if(S[k]==null)S[k]=k==='health'||k==='ai'?{}:[];
  delete S.streamOpen; // B1: left by an old version; nothing may send the stream command any more
  stampChanges(false);
  // Ask the browser not to evict our data when the device runs low on space
  try{if(navigator.storage&&navigator.storage.persist&&!(await navigator.storage.persisted()))store.persisted=await navigator.storage.persist();else store.persisted=true}catch(e){}
}
async function storageInfo(){
  try{const e=await navigator.storage.estimate();return{used:e.usage,quota:e.quota}}catch(e){return null}
}
const fmtBytes=b=>b==null?'–':b>=1e9?(b/1e9).toFixed(1)+' GB':b>=1e6?(b/1e6).toFixed(1)+' MB':Math.max(1,Math.round(b/1e3))+' KB';

// ---- backup / restore ----
function b64(u8){let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s)}
function unb64(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
// Every saved file is named "YYMMDD name.ext" (e.g. 261019 vibmon-backup.json); characters Windows does not allow are replaced
const yymmdd=(d=new Date())=>String(d.getFullYear()%100).padStart(2,'0')+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
const datedName=name=>`${yymmdd()} ${String(name).replace(/[\\/:*?"<>|]+/g,'-').trim()}`;
function download(name,blob){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=datedName(name);a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
async function exportBackup(){
  let fft=[];try{fft=await FFTDB.all()}catch(e){}
  const state={};for(const k in S)if(k[0]!=='_')state[k]=S[k];
  const data={format:'vibmon-backup',version:1,exportedAt:new Date().toISOString(),app:APP_VERSION,
    state,fft:fft.map(r=>({...r,bytes:b64(r.bytes)}))};
  download('vibmon-backup.json',new Blob([JSON.stringify(data)],{type:'application/json'}));
  S.lastBackup=Date.now();save();
  if(typeof appLog==='function')appLog('data',`สำรองข้อมูลเป็นไฟล์ (${S.readings.length} ค่า · FFT ${fft.length} ชุด)`);
  toast(`สำรองข้อมูลแล้ว: ${S.readings.length.toLocaleString('th-TH')} ค่า · FFT ${fft.length} ชุด`);
  if(S.view==='settings')render();
}
// mode 'merge' = add what is missing; 'replace' = this backup becomes the whole state
async function importBackup(file,mode){
  let data;
  try{data=JSON.parse(await file.text())}catch(e){return toast('ไฟล์นี้ไม่ใช่ไฟล์สำรอง (อ่าน JSON ไม่ได้)')}
  if(!data||data.format!=='vibmon-backup'||!data.state)return toast('ไฟล์นี้ไม่ใช่ไฟล์สำรองของ Vibration Monitor');
  const st=data.state,fft=(data.fft||[]).map(r=>({...r,bytes:unb64(r.bytes)}));
  if(mode==='replace'){
    if(!confirm(`แทนที่ข้อมูลทั้งหมดในเครื่องนี้ด้วยไฟล์สำรอง?\n\nไฟล์: ${(st.readings||[]).length} ค่า · FFT ${fft.length} ชุด (สำรองเมื่อ ${new Date(data.exportedAt).toLocaleString('th-TH')})\nข้อมูลปัจจุบัน: ${S.readings.length} ค่า จะถูกลบ`))return;
    for(const k of Object.keys(S))delete S[k];
    Object.assign(S,{readings:[],assets:{},unit:'mm',tunit:'C',sel:null,range:30,sensors:{},maint:[],health:{},ai:{},failures:[]},st);
    delete S.streamOpen;for(const sv of Object.values(S.sensors||{}))delete sv.schedFail;
    if(typeof appLog==='function')appLog('data',`กู้คืนจากไฟล์สำรองแบบแทนที่ (${S.readings.length} ค่า · FFT ${fft.length} ชุด)`);
    await FFTDB.clear();for(const r of fft)await FFTDB.put(r);
    save();persistBig(true);render();
    toast(`กู้คืนแล้ว ${S.readings.length.toLocaleString('th-TH')} ค่า · FFT ${fft.length} ชุด`);
    // Without this the next Drive sync would merge the old cloud copy back in
    if(typeof gdSignedIn==='function'&&gdSignedIn()){
      if(confirm('ใช้ข้อมูลที่กู้คืนนี้เป็นชุดหลักบน Google Drive ด้วยไหม?\n\n• OK = อัปทับไฟล์บน Drive (เครื่องอื่นจะได้ข้อมูลชุดนี้)\n• Cancel = ไม่อัปทับ แต่การซิงก์ครั้งถัดไปจะดึงข้อมูลเดิมจาก Drive กลับมารวม')){GD.forcePush=true;gdSync(true)}
    }
    return;
  }
  const{nR,nF}=await mergeState(st,fft);
  if(typeof appLog==='function')appLog(file.name==='gateway.json'?'sync':'data',`${file.name==='gateway.json'?'รวมข้อมูลจาก Gateway':'รวมข้อมูลจากไฟล์สำรอง'}: เพิ่ม ${nR} ค่า · FFT ${nF} ชุด`);
  save();persistBig(true);render();
  toast(`รวมข้อมูลแล้ว: เพิ่ม ${nR.toLocaleString('th-TH')} ค่า · FFT ${nF} ชุด`);
}
function pickBackupFile(mode){
  const i=document.createElement('input');i.type='file';i.accept='.json,application/json';
  i.onchange=()=>{if(i.files[0])importBackup(i.files[0],mode)};i.click();
}
const backupDue=()=>S.readings.length>0&&Date.now()-(S.lastBackup||0)>7*864e5;

// Move readings of one machine in a time range to another name (to separate data from two sensors
// that were saved under the same machine name)
function moveReadings(from,to,t0,t1){
  if(typeof appLog==='function')appLog('edit',`ย้ายค่าที่วัดจาก "${from}" ไป "${to}" (${new Date(t0).toLocaleString('th-TH')} – ${new Date(t1).toLocaleString('th-TH')})`);
  tombList('moves').push({id:uid(),from,to,t0,t1,at:Date.now()});
  let n=0;const have=new Set(S.readings.filter(r=>r.asset===to).map(r=>r.t));
  S.readings=S.readings.filter(r=>{
    if(r.asset!==from||r.t<t0||r.t>t1)return true;
    n++;if(have.has(r.t))return false;r.asset=to;return true});
  if(n){cfg(to);save()}
  return n;
}

// ---- Raspberry Pi gateway (gateway/ia3-gateway.js): pull its data and merge ----
// The gateway serves this page itself (http://<pi>:8080/), so the default address is this page's own
// folder. A page opened over https (GitHub Pages) cannot read an http:// gateway (browser blocks it).
const gwBase=()=>{const u=(S.gw&&S.gw.url)||'';return u?u.replace(/\/?$/,'/'):''};
async function gatewayStatus(base){
  try{const r=await fetch(base+'api/status',{cache:'no-store'});if(!r.ok)return null;const j=await r.json();return j&&j.gateway?j:null}catch(e){return null}
}
async function gatewaySync(quiet){
  const base=gwBase();
  if(location.protocol==='https:'&&/^http:/.test(base)){if(!quiet)toast('หน้าเว็บ https เปิดข้อมูลจาก Gateway แบบ http ไม่ได้ ให้เปิดหน้าเว็บจาก Gateway โดยตรง');return}
  try{
    const r=await fetch(base+'api/backup',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);
    const text=await r.text();
    S.gw=Object.assign(S.gw||{},{last:Date.now()});
    await importBackup(new File([text],'gateway.json'),'merge');
  }catch(e){if(!quiet)toast('ดึงข้อมูลจาก Gateway ไม่ได้: '+e.message)}
}

// ---- merging state from another device (backup file, gateway, Google Drive) ----
// Deletes, moves and renames are remembered as tombstones, so data removed or merged on one device does not
// come back from another: S.tomb = {assets:{name:deletedAt}, maint/failures/routes/ai/sensors:[ids],
// fft:[capture keys], moves:[{from,to,t0,t1,at}]}, S.renames = {from:{to,t}} (to null = cancelled), S.favT = {name:changedAt}.
// Records edited on several devices carry mt (stampChanges) and the newest version wins.
const TOMB_LISTS=['maint','failures','routes','ai','sensors','fft'];
function tomb(){const tb=S.tomb||(S.tomb={assets:{}});tb.assets=tb.assets||{};return tb}
function tombList(k){const tb=tomb();return tb[k]||(tb[k]=[])}
// Everything stored for one machine, on this device (used by delete and when another device's delete arrives)
function purgeAsset(a,until=Infinity){
  const old=x=>(x||0)<=until;
  S.readings=S.readings.filter(r=>!(r.asset===a&&old(r.t)));
  if(S.assets[a]&&old(S.assets[a].mt))delete S.assets[a];
  S.maint=(S.maint||[]).filter(m=>!(m.asset===a&&old(m.t)));
  S.failures=(S.failures||[]).filter(f=>!(f.asset===a&&old(f.t)));
  if(S.ai&&S.ai[a]){S.ai[a]=S.ai[a].filter(h=>!old(h.t));if(!S.ai[a].length)delete S.ai[a]}
  S.fav=(S.fav||[]).filter(x=>x!==a||until!==Infinity);
  FFTDB.list(a).then(list=>{const keys=list.filter(r=>old(r.ts*1000)).map(r=>r.key);if(keys.length)return FFTDB.del(keys)}).catch(()=>{});
}
// renames: {from:{to,t}} (older files: {from:"to"}, treated as oldest). Applied oldest first, and renaming
// X→Y drops any earlier Y→… so merging back and forth on two devices never leaves a loop that keeps both names.
// {to:null} cancels a rename (the user chose the old name again for a machine of its own).
function normRenames(...lists){
  const all=[];for(const l of lists)for(const[f,v]of Object.entries(l||{}))all.push([f,typeof v==='string'?v:v.to,typeof v==='string'?0:(v.t||0)]);
  all.sort((a,b)=>a[2]-b[2]);const out={};
  for(const[f,to,t]of all){if(f===to)continue;if(to)delete out[to];out[f]={to:to||null,t}}
  return out;
}
function finalName(a,ren){const seen=new Set();while(ren[a]&&!seen.has(a)){const v=ren[a],to=typeof v==='string'?v:v.to;if(!to)break;seen.add(a);a=to}return a}
// The user deliberately gave a machine this name: an old "merged into another machine" must not capture it
function cancelRename(name){const v=S.renames&&S.renames[name];if(v&&(typeof v==='string'||v.to))S.renames=normRenames(S.renames,{[name]:{to:null,t:Date.now()}})}
async function mergeState(st,fft){
  const ren=normRenames(st.renames,S.renames);S.renames=ren;
  const tb=tomb(),rt=st.tomb||{};
  for(const[a,t]of Object.entries(rt.assets||{}))tb.assets[a]=Math.max(tb.assets[a]||0,t);
  for(const k of TOMB_LISTS)if(tb[k]||rt[k])tb[k]=[...new Set([...(tb[k]||[]),...(rt[k]||[])])];
  {const ids=new Set((tb.moves||[]).map(m=>m.id));tb.moves=[...(tb.moves||[]),...(rt.moves||[]).filter(m=>!ids.has(m.id))].sort((a,b)=>a.at-b.at)}
  const fix=a=>finalName(a,ren),dead=(a,t)=>tb.assets[a]!=null&&(t||0)<=tb.assets[a];
  const T=k=>new Set(tb[k]||[]),newer=(x,y)=>(x&&x.mt||0)>(y&&y.mt||0);
  // where a reading belongs now: renames, then moves made on any device, then renames again
  const place=r=>{let a=fix(r.asset);for(const m of tb.moves)if(a===m.from&&r.t>=m.t0&&r.t<=m.t1)a=fix(m.to);r.asset=a;return r};
  // local data first (renames/moves/deletes from the other device), dropping duplicates this creates
  const idx=new Map();
  S.readings=S.readings.filter(r=>{place(r);if(dead(r.asset,r.t))return false;const k=r.asset+'|'+r.t,ex=idx.get(k);
    if(ex){if(ex.live&&!r.live){Object.assign(ex,r);delete ex.live}return false}idx.set(k,r);return true});
  let nR=0;
  for(const r0 of st.readings||[]){const r=place({...r0});if(dead(r.asset,r.t))continue;const k=r.asset+'|'+r.t,ex=idx.get(k);
    if(!ex){idx.set(k,r);S.readings.push(r);nR++}else if(ex.live&&!r.live){Object.assign(ex,r);delete ex.live}}
  // machine settings: newest edit wins; a delete wins over older settings
  for(const k of Object.keys(S.assets))if(fix(k)!==k){const t=fix(k);S.assets[t]=Object.assign({},S.assets[k],S.assets[t]||{});delete S.assets[k]}
  for(const[a0,c]of Object.entries(st.assets||{})){const a=fix(a0);if(dead(a,c.mt))continue;const l=S.assets[a];
    if(!l)S.assets[a]=c;else if(newer(c,l))S.assets[a]=Object.assign({},l,c);else for(const[k,v]of Object.entries(c))if(l[k]==null)l[k]=v}
  for(const a of Object.keys(tb.assets))purgeAsset(a,tb.assets[a]);
  // sensors (by browser device id)
  const deadS=T('sensors');
  for(const[id,sv]of Object.entries(st.sensors||{})){if(deadS.has(id))continue;const m=S.sensors[id];
    if(!m){S.sensors[id]=sv;continue}
    const names=[...new Set([...(m.names||[]),...(sv.names||[])])],mac=m.mac||sv.mac;
    if(newer(sv,m))S.sensors[id]=Object.assign({},m,sv);
    Object.assign(S.sensors[id],{names},mac?{mac}:{})}
  for(const id of deadS)delete S.sensors[id];
  for(const sv of Object.values(S.sensors))sv.asset=fix(sv.asset);
  // records by id: newest edit wins, deleted ids stay deleted
  const byId=(local,remote,deadSet,fixAsset)=>{const out=(local||[]).filter(x=>!deadSet.has(x.id)),m=new Map(out.map(x=>[x.id,x]));
    for(const x of remote||[]){if(deadSet.has(x.id))continue;const ex=m.get(x.id);if(!ex){const y={...x};out.push(y);m.set(y.id,y)}else if(newer(x,ex))Object.assign(ex,x)}
    if(fixAsset)for(const x of out)x.asset=fix(x.asset);return out};
  S.maint=byId(S.maint,st.maint,T('maint'),true).filter(m=>!dead(m.asset,m.t));
  S.failures=byId(S.failures,st.failures,T('failures'),true).filter(f=>!dead(f.asset,f.t));
  if(st.routes||S.routes)S.routes=byId(S.routes,st.routes,T('routes'),false);
  for(const[k,list]of Object.entries(st.health||{})){
    const cur=S.health[k]||(S.health[k]=[]),ts=new Set(cur.map(h=>h.t));
    for(const h of list)if(!ts.has(h.t))cur.push(h);cur.sort((a,b)=>a.t-b.t);
  }
  {S.ai=S.ai||{};const deadA=T('ai');
    for(const[a0,list]of Object.entries(st.ai||{})){const a=fix(a0),cur=S.ai[a]||(S.ai[a]=[]),ids=new Set(cur.map(h=>h.id));for(const h of list)if(!ids.has(h.id)&&!dead(a,h.t))cur.push(h)}
    for(const[a,list]of Object.entries(S.ai)){if(fix(a)!==a){S.ai[fix(a)]=[...(S.ai[fix(a)]||[]),...list];delete S.ai[a];continue}S.ai[a]=list.filter(h=>!deadA.has(h.id))}}
  if(st.machines){S.machines=S.machines||{};for(const[k,v]of Object.entries(st.machines))if(!S.machines[k]||newer(v,S.machines[k]))S.machines[k]=v}
  if(st.machTpl){S.machTpl=S.machTpl||{};for(const[k,v]of Object.entries(st.machTpl))if(!S.machTpl[k]||newer(v,S.machTpl[k]))S.machTpl[k]=v}
  if(st.brgDb){S.brgDb=S.brgDb||{};for(const[k,v]of Object.entries(st.brgDb))if(!S.brgDb[k]||newer(v,S.brgDb[k]))S.brgDb[k]=v}
  // favourites: the later star/unstar wins (equal or unknown times: kept if either device has it)
  if(st.fav||st.favT){const lt=S.favT||{},rtT=st.favT||{},lf=new Set(S.fav||[]),rf=new Set(st.fav||[]),out=new Set(),FT={};
    for(const n of new Set([...lf,...rf,...Object.keys(lt),...Object.keys(rtT)])){const a=lt[n]||0,b=rtT[n]||0;
      if(b>a?rf.has(n):a>b?lf.has(n):(lf.has(n)||rf.has(n)))out.add(fix(n));if(a||b)FT[n]=Math.max(a,b)}
    S.fav=[...out];S.favT=FT}
  let nF=0;const deadF=T('fft');
  if(deadF.size){const gone=(await FFTDB.keys()).filter(k=>deadF.has(k));if(gone.length){await FFTDB.del(gone);gone.forEach(k=>faDecCache.delete(k))}}
  if(fft&&fft.length){const have=new Set(await FFTDB.keys());
    for(const r of fft){const a=fix(r.asset);if(dead(a,r.ts*1000)||deadF.has(r.key))continue;const key=a===r.asset?r.key:a+r.key.slice(r.asset.length);if(deadF.has(key))continue;
      if(!have.has(key)){await FFTDB.put({...r,asset:a,key});have.add(key);nF++}}}
  {S.fftNotes=S.fftNotes||{};const deadF2=T('fft');
    for(const[k,n]of Object.entries(st.fftNotes||{}))if(!S.fftNotes[k]||newer(n,S.fftNotes[k]))S.fftNotes[k]=n;
    for(const[k,n]of Object.entries(S.fftNotes)){if(deadF2.has(k)){delete S.fftNotes[k];continue}
      const a=n.asset&&fix(n.asset);if(a&&a!==n.asset&&k.startsWith(n.asset+'|')){const nk=a+k.slice(n.asset.length);if(!S.fftNotes[nk]||newer(n,S.fftNotes[nk]))S.fftNotes[nk]={...n,asset:a};delete S.fftNotes[k]}}}
  if(S.sel)S.sel=fix(S.sel);
  stampChanges(false); // what came in keeps its own edit time; only later local edits get a new one
  if(typeof idxDirty==='function')idxDirty();
  return{nR,nF};
}

// ---- several tabs of this page on one device (S8) ----
// Each tab keeps the data in memory and writes all of it, so a tab left open would overwrite what another
// tab downloaded. After every save a tab tells the others, and they merge the stored copy into theirs.
const TAB_BC=typeof BroadcastChannel==='function'?new BroadcastChannel('vibmon-tabs'):null;
let tabMsgT=null;
function tabSaved(){if(!TAB_BC||store.merging)return;clearTimeout(tabMsgT);tabMsgT=setTimeout(async()=>{try{await store.writing}catch(e){}TAB_BC.postMessage({saved:Date.now()})},700)}
if(TAB_BC)TAB_BC.onmessage=async()=>{
  if(store.merging||!store.idb)return;store.merging=true;
  try{
    let small={};try{small=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
    const st={...small};for(const k of BIGKEYS){const v=await VDB.get(k);if(v!=null)st[k]=v}
    const r=await mergeState(st,null);
    if(r.nR||S.view!=='ai')render();
  }catch(e){console.warn(e)}finally{store.merging=false}
};
