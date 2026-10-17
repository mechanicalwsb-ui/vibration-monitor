// Google sign-in, Google Drive sync and the screen lock.
// - Sign-in uses Google Identity Services (token flow) with scopes openid/email/profile + drive.file:
//   the page can only see files it created itself, in a "Vibration Monitor" folder of the user's Drive.
// - Sync = download the other devices' data, merge it (mergeState, deletes/renames respected), upload.
// - Lock = PIN or Google sign-in required before the page opens on this device. It is a lock on this
//   browser's screen; the data in the cloud is protected by the Google account itself.
// Settings live in localStorage, outside the dashboard state (never in backups).

const GD_KEY='vibmon-gdrive',GD_SCOPE='openid email profile https://www.googleapis.com/auth/drive.file';
const GD_API='https://www.googleapis.com/drive/v3/',GD_UP='https://www.googleapis.com/upload/drive/v3/';
const GD_FILES={state:'vibmon-state.json',fft:'vibmon-fft.json'};
// SITE (site-config.js) can make sign-in mandatory for everyone: its Client ID and allow-list win
const siteGate=()=>typeof SITE!=='undefined'&&!!SITE.clientId;
function gdCfg(){let c={};try{c=JSON.parse(localStorage.getItem(GD_KEY)||'{}')}catch(e){}
  c=Object.assign({clientId:'',auto:true,allow:'',lock:'none'},c);
  if(siteGate()){c.clientId=SITE.clientId;c.lock='google';if(SITE.allow&&SITE.allow.length)c.allow=SITE.allow.join(', ')}
  return c}
const AUTH_KEY='vibmon-auth';
function authOk(){
  try{const a=JSON.parse(localStorage.getItem(AUTH_KEY)||'null');const c=gdCfg();
    return!!(a&&a.until>Date.now()&&c.email&&a.email===c.email&&allowedEmail(c,a.email))}catch(e){return false}
}
function setAuth(email){const d=(typeof SITE!=='undefined'&&SITE.rememberDays)||30;try{localStorage.setItem(AUTH_KEY,JSON.stringify({email,until:Date.now()+d*864e5}))}catch(e){}}
function gdSave(c){try{localStorage.setItem(GD_KEY,JSON.stringify(c))}catch(e){}}
const GD={tok:null,exp:0,busy:false,status:'',err:''};
const gdSignedIn=()=>!!gdCfg().email;
const gdTokenOk=()=>GD.tok&&Date.now()<GD.exp-60000;

async function gdToken(interactive){
  if(gdTokenOk())return GD.tok;
  if(!interactive)return null;
  const c=gdCfg();if(!c.clientId)throw new Error('ยังไม่ได้ใส่ Google Client ID (ตั้งค่า → บัญชีและการซิงก์)');
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((res,rej)=>{
    const tc=google.accounts.oauth2.initTokenClient({client_id:c.clientId,scope:GD_SCOPE,
      callback:r=>{if(r.error)return rej(new Error(r.error_description||r.error));GD.tok=r.access_token;GD.exp=Date.now()+(+r.expires_in||3600)*1000;res(GD.tok)},
      error_callback:e=>rej(new Error(e&&e.type==='popup_closed'?'ปิดหน้าต่างล็อกอินก่อนเสร็จ':e&&(e.message||e.type)||'ล็อกอินไม่สำเร็จ'))});
    tc.requestAccessToken({prompt:c.email?'':'select_account',login_hint:c.email||undefined});
  });
}
async function gdFetch(url,opt={}){
  const tok=await gdToken(false);if(!tok)throw new Error('ต้องล็อกอินใหม่');
  const r=await fetch(url,{...opt,headers:{...(opt.headers||{}),Authorization:'Bearer '+tok}});
  if(r.status===401){GD.tok=null;throw new Error('สิทธิ์หมดอายุ กดซิงก์อีกครั้ง')}
  if(!r.ok){let m='';try{m=(await r.json()).error.message}catch(e){}throw new Error(`Google Drive ${r.status}${m?': '+m:''}`)}
  return r;
}
const allowedEmail=(c,email)=>{const L=(c.allow||'').split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);return!L.length||L.includes(String(email).toLowerCase())};
async function gdLogin(){
  try{
    await gdToken(true);
    const u=await (await gdFetch('https://www.googleapis.com/oauth2/v3/userinfo')).json(),c=gdCfg();
    if(!allowedEmail(c,u.email)){try{google.accounts.oauth2.revoke(GD.tok,()=>{})}catch(e){}GD.tok=null;throw new Error(`บัญชี ${u.email} ไม่ได้รับอนุญาตให้ใช้งานเว็บนี้`)}
    Object.assign(c,{email:u.email,name:u.name||u.email,picture:u.picture||''});gdSave(c);setAuth(u.email);
    try{sessionStorage.setItem('vibmon-unlocked','1')}catch(e){}
    toast('ล็อกอินแล้ว: '+(u.name||u.email));hideLock();render();
    if(c.clientId)gdSync(false);
  }catch(e){toast(e.message);GD.err=e.message;render()}
}
function gdLogout(){
  const c=gdCfg();
  try{if(GD.tok&&window.google)google.accounts.oauth2.revoke(GD.tok,()=>{})}catch(e){}
  GD.tok=null;delete c.email;delete c.name;delete c.picture;gdSave(c);try{localStorage.removeItem(AUTH_KEY)}catch(e){}
  try{sessionStorage.removeItem('vibmon-unlocked')}catch(e){}
  toast('ออกจากระบบแล้ว');render();checkLock();
}
// ---- Drive files ----
async function gdFolder(){
  const c=gdCfg();
  if(c.folderId){try{const r=await gdFetch(`${GD_API}files/${c.folderId}?fields=id,trashed`);const j=await r.json();if(!j.trashed)return c.folderId}catch(e){}}
  const q=encodeURIComponent("name='Vibration Monitor' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const j=await (await gdFetch(`${GD_API}files?q=${q}&fields=files(id)&spaces=drive`)).json();
  let id=j.files&&j.files[0]&&j.files[0].id;
  if(!id)id=(await (await gdFetch(`${GD_API}files?fields=id`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Vibration Monitor',mimeType:'application/vnd.google-apps.folder'})})).json()).id;
  c.folderId=id;gdSave(c);return id;
}
async function gdFind(folder,name){
  const q=encodeURIComponent(`name='${name}' and '${folder}' in parents and trashed=false`);
  const j=await (await gdFetch(`${GD_API}files?q=${q}&fields=files(id,modifiedTime,size)&orderBy=modifiedTime desc`)).json();
  return j.files&&j.files[0]||null;
}
async function gdUpload(folder,name,obj,file){
  const body=JSON.stringify(obj);
  if(file){await gdFetch(`${GD_UP}files/${file.id}?uploadType=media&fields=id,modifiedTime`,{method:'PATCH',headers:{'Content-Type':'application/json'},body});return}
  const b='vibmon'+Date.now(),meta=JSON.stringify({name,parents:[folder],mimeType:'application/json'});
  await gdFetch(`${GD_UP}files?uploadType=multipart&fields=id`,{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+b},
    body:`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`});
}
function syncState(){const st={};for(const k in S)if(k[0]!=='_'&&!['view','sel','range','unit','tunit','theme','fleetF','fleetSort','stPer','cmp','rep','showFc'].includes(k))st[k]=S[k];return st}
// ---- sync ----
async function gdSync(interactive){
  const c=gdCfg();if(GD.busy||!c.clientId||!c.email)return;
  try{if(!(await gdToken(interactive))){GD.status='need';renderGdChip();return}}catch(e){GD.err=e.message;renderGdChip();return toast(e.message)}
  GD.busy=true;GD.err='';GD.status='busy';renderGdChip();
  try{
    const folder=await gdFolder();
    const [fs,ff]=await Promise.all([gdFind(folder,GD_FILES.state),gdFind(folder,GD_FILES.fft)]);
    let got=0,gotF=0;
    if(fs){const d=await (await gdFetch(`${GD_API}files/${fs.id}?alt=media`)).json();if(d&&d.state){const r=await mergeState(d.state,null);got=r.nR}}
    if(ff&&ff.modifiedTime!==c.fftMt){const d=await (await gdFetch(`${GD_API}files/${ff.id}?alt=media`)).json();
      if(d&&d.fft){const r=await mergeState({},d.fft.map(x=>({...x,bytes:unb64(x.bytes)})));gotF=r.nF}}
    await gdUpload(folder,GD_FILES.state,{format:'vibmon-backup',version:1,exportedAt:new Date().toISOString(),app:APP_VERSION,by:c.email,state:syncState(),fft:[]},fs);
    // FFT captures are large: upload only when this device has captures the cloud copy lacks
    const all=await FFTDB.all(),sig=all.map(r=>r.key).sort().join('|').length+':'+all.length;
    if(!ff||sig!==c.fftSig||gotF){
      await gdUpload(folder,GD_FILES.fft,{format:'vibmon-fft',version:1,exportedAt:new Date().toISOString(),fft:all.map(r=>({...r,bytes:b64(r.bytes||new Uint8Array(0))}))},ff);
      const nf=await gdFind(folder,GD_FILES.fft);c.fftMt=nf&&nf.modifiedTime;c.fftSig=sig}
    else c.fftMt=ff.modifiedTime;
    c.lastSync=Date.now();gdSave(c);save();persistBig(true);
    GD.status='ok';if(got||gotF){toast(`ซิงก์แล้ว: ได้ข้อมูลจากเครื่องอื่น ${got} ค่า${gotF?` · FFT ${gotF} ชุด`:''}`);render()}
  }catch(e){GD.err=e.message;GD.status='err';console.warn(e);if(interactive)toast('ซิงก์ไม่สำเร็จ: '+e.message)}
  finally{GD.busy=false;renderGdChip();if(S.view==='settings'&&$('#gdInfo'))$('#gdInfo').innerHTML=gdInfoHtml()}
}
setInterval(()=>{if(gdCfg().auto&&gdTokenOk())gdSync(false)},10*60000);
// ---- sidebar chip ----
function renderGdChip(){
  const el=$('#gdChip');if(!el)return;const c=gdCfg();
  if(!c.email){el.innerHTML=`<button class="btn sm" style="width:100%" onclick="${c.clientId?'gdLogin()':"S._setFocus='gd';setView('settings')"}">👤 ล็อกอินด้วย Google</button>`;return}
  const st=GD.busy?'กำลังซิงก์…':GD.status==='err'?'ซิงก์ไม่สำเร็จ — กดลองใหม่':!gdTokenOk()?'กดเพื่อซิงก์':c.lastSync?'ซิงก์ล่าสุด '+new Date(c.lastSync).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}):'กดเพื่อซิงก์';
  el.innerHTML=`<button class="gd-user" onclick="gdSync(true)" title="${esc(c.email)} — กดเพื่อซิงก์ Google Drive">
    ${c.picture?`<img src="${esc(c.picture)}" alt="" referrerpolicy="no-referrer">`:'<span class="gd-av">'+esc((c.name||'?')[0])+'</span>'}
    <span><b>${esc(c.name||c.email)}</b><small class="${GD.status==='err'?'up':''}">☁ ${st}</small></span></button>`;
}
// ---- settings panel ----
function gdInfoHtml(){const c=gdCfg();return c.email?`ล็อกอินเป็น <b>${esc(c.email)}</b> · ${c.lastSync?'ซิงก์ล่าสุด '+dFull(c.lastSync):'ยังไม่เคยซิงก์'}${GD.err?` · <span class="up">${esc(GD.err)}</span>`:''}`:'ยังไม่ได้ล็อกอิน'}
function gdSettingsHtml(){
  const c=gdCfg(),origin=location.origin;
  return`<div class="panel span" id="gdPanel"><div class="ph"><h3>บัญชีและการซิงก์ (Google Drive)</h3></div><div class="form">
    ${siteGate()?'<p class="full" style="margin:0;font-size:13px">🔒 เว็บนี้<b>บังคับล็อกอิน</b>ด้วย Google ก่อนใช้งาน (ตั้งโดยผู้ดูแลใน site-config.js) · เครื่องนี้จะจำการล็อกอินไว้ '+((typeof SITE!=="undefined"&&SITE.rememberDays)||30)+' วัน</p>':''}
    <label class="full" ${siteGate()?'hidden':''}>Google OAuth Client ID<input id="gdCid" value="${esc(c.clientId)}" placeholder="xxxxxxxx.apps.googleusercontent.com" autocomplete="off"></label>
    <div class="full row">${c.email?`<button class="btn primary" id="gdSyncBtn">☁ ซิงก์ตอนนี้</button><button class="btn" id="gdOut">ออกจากระบบ</button>`:`<button class="btn primary" id="gdIn">👤 ล็อกอินด้วย Google</button>`}
      <label class="check"><input type="checkbox" id="gdAuto" ${c.auto?'checked':''}> ซิงก์อัตโนมัติ (หลังดึงข้อมูล และทุก 10 นาที)</label></div>
    <p class="full" id="gdInfo" style="margin:0;font-size:13px">${gdInfoHtml()}</p>
    <label class="full" ${siteGate()?'hidden':''}>อีเมลที่อนุญาตให้ล็อกอิน (เว้นว่าง = ทุกบัญชีที่เพิ่มใน Google Cloud)<input id="gdAllow" value="${esc(c.allow)}" placeholder="เช่น a@company.com, b@gmail.com"></label>
    <label class="full" ${siteGate()?'hidden':''}>ล็อกหน้าเว็บบนเครื่องนี้<select id="gdLock"><option value="none" ${c.lock==='none'?'selected':''}>ไม่ล็อก</option><option value="pin" ${c.lock==='pin'?'selected':''}>ต้องใส่ PIN ก่อนใช้งาน</option><option value="google" ${c.lock==='google'?'selected':''}>ต้องล็อกอิน Google ก่อนใช้งาน (ต้องมีอินเทอร์เน็ต)</option></select></label>
    <p class="full muted" style="margin:0;font-size:12px">ข้อมูลเก็บเป็นไฟล์ในโฟลเดอร์ "Vibration Monitor" ใน Google Drive ของบัญชีที่ล็อกอิน (หน้าเว็บเห็นเฉพาะไฟล์ที่สร้างเอง) · ทุกเครื่องที่ล็อกอินบัญชีเดียวกันจะเห็นข้อมูลชุดเดียวกัน · ถ้าจะให้หลายคนใช้ข้อมูลชุดเดียว ให้ทุกคนล็อกอินบัญชีเดียวกัน · การล็อกหน้าเว็บกันคนเปิดเครื่องนี้ แต่ไม่ได้เข้ารหัสข้อมูลในเบราว์เซอร์</p>
    <details class="full gd-help"><summary>วิธีสร้าง Client ID (ฟรี ทำครั้งเดียว ~10 นาที)</summary><ol>
      <li>เปิด <b>console.cloud.google.com</b> ล็อกอิน Google → สร้างโปรเจกต์ใหม่ ตั้งชื่อเช่น "Vibration Monitor"</li>
      <li>เมนู <b>APIs &amp; Services → Library</b> ค้นหา <b>Google Drive API</b> → กด <b>Enable</b></li>
      <li>เมนู <b>Google Auth Platform</b> (หรือ OAuth consent screen) → Get started: ใส่ชื่อแอปและอีเมล → Audience: <b>External</b> → สร้าง</li>
      <li>หัวข้อ <b>Audience → Test users</b> เพิ่มอีเมลทุกคนที่จะใช้ (สูงสุด 100 คน ไม่ต้องรอ Google ตรวจ)</li>
      <li>หัวข้อ <b>Clients → Create client</b> → ประเภท <b>Web application</b> → ช่อง <b>Authorized JavaScript origins</b> ใส่ <code>${esc(origin)}</code>${origin.includes('github.io')?'':' และ <code>https://mechanicalwsb-ui.github.io</code>'} → Create</li>
      <li>คัดลอก <b>Client ID</b> (ลงท้าย .apps.googleusercontent.com) มาวางช่องด้านบน แล้วกด "ล็อกอินด้วย Google"</li>
      <li>หน้าขออนุญาตของ Google จะเตือนว่าแอปยังไม่ผ่านการตรวจ (เพราะเป็นแอปของเราเอง) กด <b>Continue</b> ได้</li></ol>
      <p class="muted" style="font-size:12px;margin:4px 0 0">Client ID ไม่ใช่รหัสลับ ใส่ซ้ำได้ในทุกเครื่อง · สิทธิ์ที่ขอ: ชื่อ/อีเมล และไฟล์ที่แอปนี้สร้างใน Drive เท่านั้น</p></details>
  </div></div>`;
}
function gdBindSettings(){
  if(!$('#gdPanel'))return;
  const upd=()=>{const c=gdCfg();c.clientId=$('#gdCid').value.trim();c.auto=$('#gdAuto').checked;c.allow=$('#gdAllow').value.trim();gdSave(c)};
  ['gdCid','gdAuto','gdAllow'].forEach(id=>$('#'+id).onchange=upd);
  $('#gdLock').onchange=async e=>{const c=gdCfg(),v=e.target.value;
    if(v==='pin'){const p1=prompt('ตั้ง PIN (ตัวเลข 4–8 หลัก)');if(!p1||!/^\d{4,8}$/.test(p1)){e.target.value=c.lock;return toast('PIN ต้องเป็นตัวเลข 4–8 หลัก')}
      if(prompt('ใส่ PIN อีกครั้งเพื่อยืนยัน')!==p1){e.target.value=c.lock;return toast('PIN ไม่ตรงกัน')}
      c.salt=Math.random().toString(36).slice(2);c.pinHash=await sha256(c.salt+p1)}
    if(v==='google'&&!c.email){e.target.value=c.lock;return toast('ล็อกอิน Google ก่อน แล้วค่อยเปิดการล็อกแบบนี้')}
    c.lock=v;gdSave(c);try{sessionStorage.setItem('vibmon-unlocked','1')}catch(err){}toast(v==='none'?'ปิดการล็อกแล้ว':'เปิดการล็อกแล้ว — มีผลครั้งถัดไปที่เปิดหน้าเว็บ')};
  if($('#gdIn'))$('#gdIn').onclick=()=>{upd();gdLogin()};
  if($('#gdOut'))$('#gdOut').onclick=gdLogout;
  if($('#gdSyncBtn'))$('#gdSyncBtn').onclick=()=>gdSync(true);
  if(S._setFocus==='gd'){S._setFocus=null;$('#gdPanel').scrollIntoView({behavior:'smooth'});$('#gdCid').focus()}
}
// ---- screen lock ----
async function sha256(t){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function hideLock(){const o=$('#lockScr');if(o)o.remove()}
function checkLock(){
  const c=gdCfg();let ok=false;try{ok=sessionStorage.getItem('vibmon-unlocked')==='1'}catch(e){}
  if(siteGate()){if(authOk())return hideLock();ok=false}
  else{if(c.lock==='none'||ok)return hideLock();
    if(c.lock==='google'&&c.email&&(gdTokenOk()||authOk()))return hideLock()}
  hideLock();const o=document.createElement('div');o.id='lockScr';
  o.innerHTML=`<div class="lock-box panel"><img src="icon-192.png" alt="" width="56" height="56"><h2>Vibration Monitor</h2>
    ${c.lock==='pin'?`<p class="muted">ใส่ PIN เพื่อใช้งาน</p><input type="password" inputmode="numeric" id="lockPin" maxlength="8" autocomplete="off"><button class="btn primary" id="lockGo">เข้าใช้งาน</button>`
      :`<p class="muted">ต้องล็อกอินด้วยบัญชี Google ที่ได้รับอนุญาตก่อนใช้งาน</p><button class="btn primary" id="lockG">👤 ล็อกอินด้วย Google</button>${navigator.onLine?'':'<p class="up" style="font-size:12px">ไม่มีอินเทอร์เน็ต — ต้องต่ออินเทอร์เน็ตเพื่อล็อกอินครั้งแรก</p>'}`}
    <p class="muted" id="lockMsg" style="font-size:12px;min-height:16px"></p></div>`;
  document.body.appendChild(o);
  if(c.lock==='pin'){const go=async()=>{const v=$('#lockPin').value;if(await sha256(c.salt+v)===c.pinHash){try{sessionStorage.setItem('vibmon-unlocked','1')}catch(e){}hideLock()}else{$('#lockMsg').textContent='PIN ไม่ถูกต้อง';$('#lockPin').value=''}};
    $('#lockGo').onclick=go;$('#lockPin').onkeydown=e=>{if(e.key==='Enter')go()};setTimeout(()=>$('#lockPin').focus(),50)}
  else $('#lockG').onclick=()=>gdLogin().then(()=>{if(authOk()||(!siteGate()&&gdTokenOk()))hideLock();else $('#lockMsg').textContent=GD.err||'ล็อกอินไม่สำเร็จ'});
}
