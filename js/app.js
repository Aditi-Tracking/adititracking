
// ═══════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════
let lLoaded=false,enLoaded=false,entsolLoaded=false;
// Pre-fetch data caches
let _tasksCache=null, _fmsCache=null;

function prefetchAllData(){
  const _isOwner = CURRENT_USER && CURRENT_USER.role === 'owner';
  const myEmail = CURRENT_USER ? encodeURIComponent(String(CURRENT_USER.email||'').trim().toLowerCase()) : '';
  const myName = CURRENT_USER ? encodeURIComponent(String(CURRENT_USER.name||'').trim().toLowerCase()) : '';

  if(!_tasksCache){
    // Supabase se prefetch — background mein loadTasks trigger karo
    Promise.resolve().then(()=>{
      _tasksAllReady=true;
      if(!tLoaded){
        tLoaded=true;
        setTimeout(()=>{ try{ loadTasks(); }catch(e){ } }, 0);
      }
    });
  }

  // SmartFleet — prefetch in background so the panel opens instantly (no loading screen) on click
  const _canViewLeads = _isOwner || (typeof PERMISSIONS!=='undefined' && PERMISSIONS.can_view_leads==='true');
  if(_canViewLeads && !lLoaded){
    lLoaded=true;
    setTimeout(()=>{ try{ loadLeads(); }catch(e){ } }, 0);
  }
}
function toggleUserPopup(e){
  if(e) e.stopPropagation();
  openUserSheet();
}
document.addEventListener('click',function(e){
  if(!e.target.closest('.bn-user-profile')){const p=document.getElementById('bnUserPopup');if(p)p.classList.remove('open');}
});

// ─── USER BOTTOM SHEET ───────────────────────────────────────────────────────
function _syncProfileUI(){
  if(typeof CURRENT_USER==='undefined' || !CURRENT_USER) return;
  const name     = CURRENT_USER.name || CURRENT_USER.email.split('@')[0] || 'User';
  const rawRole  = CURRENT_USER.rawRole || 'employee';
  const roleLabel= rawRole === 'owner' ? 'Managing Director' : rawRole.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  const roleIcon = rawRole === 'owner' ? '👑' : rawRole === 'mis' ? '📊' : rawRole === 'pc' ? '💼' : rawRole === 'executive assistant' || rawRole === 'ea' ? '🤝' : '👤';
  const initial  = name.charAt(0).toUpperCase();
  // Desktop sidebar
  const sbpAv=document.getElementById('sbpAvatar'); if(sbpAv) sbpAv.textContent=initial;
  const sbpNm=document.getElementById('sbpName');   if(sbpNm) sbpNm.textContent=name;
  const sbpRl=document.getElementById('sbpRole');   if(sbpRl) sbpRl.textContent=roleIcon+' '+roleLabel;
  // Mobile bottom nav
  const bnpAv=document.getElementById('bnpAvatar'); if(bnpAv) bnpAv.textContent=initial;
  const bnpNm=document.getElementById('bnpName');   if(bnpNm) bnpNm.textContent=name.split(' ')[0];
  // Mobile sheet header (pre-fill)
  const usAv=document.getElementById('usAvatar'); if(usAv) usAv.textContent=initial;
  const usNm=document.getElementById('usName');   if(usNm) usNm.textContent=name;
  const usRl=document.getElementById('usRole');   if(usRl) usRl.textContent=roleLabel;
}

// ─── USER BOTTOM SHEET (Mobile only) ─────────────────────────────────────────
function openUserSheet(){
  _syncProfileUI();
  const overlay=document.getElementById('userSheetOverlay');
  const sheet=document.getElementById('userSheet');
  if(!overlay||!sheet) return;
  overlay.style.display='block'; sheet.style.display='block';
  requestAnimationFrame(()=>{ sheet.style.transform='translateY(0)'; });
}
function closeUserSheet(){
  const sheet=document.getElementById('userSheet');
  if(sheet){
    sheet.style.transform='translateY(100%)';
    setTimeout(()=>{
      sheet.style.display='none';
      const ov=document.getElementById('userSheetOverlay'); if(ov) ov.style.display='none';
    },280);
  }
}

// ─── PROFILE DETAILS MODAL ───────────────────────────────────────────────────
function showProfileDetails(){
  closeUserSheet();
  const overlay=document.getElementById('profileModalOverlay');
  const modal=document.getElementById('profileModal');
  if(!overlay||!modal) return;
  overlay.style.display='block'; modal.style.display='block';

  const loadMsg=document.getElementById('pmLoadingMsg');
  const grid=document.getElementById('pmDetailsGrid');
  const errMsg=document.getElementById('pmErrorMsg');
  if(loadMsg) loadMsg.style.display='block';
  if(grid)    grid.style.display='none';
  if(errMsg)  errMsg.style.display='none';

  const name   =(typeof CURRENT_USER!=='undefined'&&CURRENT_USER&&CURRENT_USER.name)    ? CURRENT_USER.name    : 'User';
  const email  =(typeof CURRENT_USER!=='undefined'&&CURRENT_USER&&CURRENT_USER.email)   ? String(CURRENT_USER.email).trim() : '';
  const rawRole=(typeof CURRENT_USER!=='undefined'&&CURRENT_USER&&CURRENT_USER.rawRole) ? CURRENT_USER.rawRole : '';

  // Photo wrap reset karo — _fillProfileModal previous run mein innerHTML replace kar deta hai
  // jisse pmAvatarLetter span destroy ho jata hai. Yahan dobara create karo.
  const photoWrap=document.getElementById('pmPhotoWrap');
  if(photoWrap) photoWrap.innerHTML='<span id="pmAvatarLetter">'+name.charAt(0).toUpperCase()+'</span>';
  const upStatus=document.getElementById('pmUploadStatus'); if(upStatus) upStatus.textContent='';

  // Safe DOM updates — element null ho toh skip
  const _set=(id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=val; };
  _set('pmName', name);
  _set('pmDept', rawRole ? rawRole.charAt(0).toUpperCase()+rawRole.slice(1) : 'Employee');
  _set('pmAvatarLetter', name.charAt(0).toUpperCase());

  const _hdrs = SB_HDRS();

  // DEBUG: console mein dikhao kya search ho raha hai

  // Step 1 – Email_Id se match karo (most reliable — email unique hota hai)
  const tryEmailLookup = email
    ? fetch(`${SUPABASE_URL}/rest/v1/Employee_details?select=*&Email_Id=ilike.${encodeURIComponent(email)}&limit=1`,{headers:_hdrs}).then(r=>r.json())
    : Promise.resolve([]);

  tryEmailLookup
  .then(rows=>{
    if(rows&&rows.length>0){ _fillProfileModal(rows[0],name,rawRole,grid,errMsg,loadMsg); return null; }
    // Step 2 – Employee_name exact match fallback
    const encodedName=encodeURIComponent(name.trim());
    return fetch(`${SUPABASE_URL}/rest/v1/Employee_details?select=*&Employee_name=ilike.${encodedName}&limit=1`,{headers:_hdrs}).then(r=>r.json());
  })
  .then(rows=>{
    if(rows===null) return null; // already filled in step 1
    if(rows&&rows.length>0){ _fillProfileModal(rows[0],name,rawRole,grid,errMsg,loadMsg); return null; }
    // Step 3 – first name only fallback
    const firstName=name.trim().split(/\s+/)[0];
    if(firstName&&firstName.toLowerCase()!==name.toLowerCase()){
      return fetch(`${SUPABASE_URL}/rest/v1/Employee_details?select=*&Employee_name=ilike.${encodeURIComponent(firstName)}&limit=1`,{headers:_hdrs}).then(r=>r.json()).then(rows2=>{
        if(rows2&&rows2.length>0){ _fillProfileModal(rows2[0],name,rawRole,grid,errMsg,loadMsg); return null; }
        _profileNotFound(name,loadMsg,errMsg);
        return null;
      });
    }
    _profileNotFound(name,loadMsg,errMsg);
    return null;
  })
  .catch(err=>{ if(loadMsg)loadMsg.style.display='none'; if(errMsg){errMsg.style.display='block';errMsg.textContent='⚠️ Network error.';} });
}
function _profileNotFound(name,loadMsg,errMsg){
  if(loadMsg) loadMsg.style.display='none';
  const _em=(typeof CURRENT_USER!=='undefined'&&CURRENT_USER&&CURRENT_USER.email)?CURRENT_USER.email:'';
  if(errMsg){ errMsg.style.display='block'; errMsg.textContent='⚠️ Record not found. (Name: "'+name+'"'+(_em?', Email: '+_em:'')+') — Please contact MIS.'; }
}
function _fillProfileModal(row,name,rawRole,grid,errMsg,loadMsg){
  if(loadMsg) loadMsg.style.display='none';
  const _set=(id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=val; };
  const photoUrl=row['avatar_url']||row['Link']||row['link']||row['Photo']||null;
  const photoWrap=document.getElementById('pmPhotoWrap');
  if(photoWrap) {
    if(photoUrl) {
      photoWrap.innerHTML=`<img src="${photoUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.innerHTML='<span id=&quot;pmAvatarLetter&quot;>'+(this.alt||'?').charAt(0).toUpperCase()+'</span>'" alt="${(row['Employee_name']||name)}">`;
    } else {
      photoWrap.innerHTML=`<span id="pmAvatarLetter">${(row['Employee_name']||name).charAt(0).toUpperCase()}</span>`;
    }
  }
  // Agar avatar_url hai toh CURRENT_USER mein bhi save karo aur UI sync karo
  if(row['avatar_url'] && typeof CURRENT_USER !== 'undefined' && CURRENT_USER) {
    CURRENT_USER.avatar_url = row['avatar_url'];
    localStorage.setItem('aditiUser', JSON.stringify(CURRENT_USER));
    _syncProfileUI();
    // Update sidebar avatar with actual photo
    const sbAv = document.getElementById('sidebarUserAvatar');
    if (sbAv) sbAv.innerHTML = `<img src="${row['avatar_url']}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.textContent='${(CURRENT_USER.name||'?')[0].toUpperCase()}'">`;
  }
  const dbName=row['Employee_name']||name;
  const dbDept=row['Employee_Dept']||row['Emp_Dept']||rawRole||'—';
  _set('pmName', dbName);
  _set('pmDept', dbDept.charAt(0).toUpperCase()+dbDept.slice(1));
  _set('pmAvatarLetter', dbName.charAt(0).toUpperCase());
  function fmtDate(d){ if(!d)return'—'; try{return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});}catch{return d;} }
  _set('pmEmail',    row['Email_Id']||row['Email']||'—');
  _set('pmPhone',    row['Phone Number']||row['Phone_Number']||'—');
  _set('pmLocation', row['Location']||row['location']||'—');
  _set('pmDOJ',      fmtDate(row['Date Of Joining']||row['Date_Of_Joining']));
  _set('pmDOB',      fmtDate(row['Date of Birth']||row['Date_of_Birth']));
  if(grid) grid.style.display='grid';
}
function closeProfileModal(){
  const ov=document.getElementById('profileModalOverlay'); if(ov) ov.style.display='none';
  const md=document.getElementById('profileModal');        if(md) md.style.display='none';
}

function _canDownloadVideo() {
  if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return false;
  return PERMISSIONS.can_download_video === 'true';
}

// ─── PROFILE PHOTO UPLOAD ────────────────────────────────────────────────────
function handleProfilePhotoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  // Sirf image allow karo
  if (!file.type.startsWith('image/')) {
    _pmUploadMsg('❌ Please select an image file only.', '#ff5c7c');
    return;
  }
  // 5MB limit
  if (file.size > 5 * 1024 * 1024) {
    _pmUploadMsg('❌ File must be smaller than 5MB.', '#ff5c7c');
    return;
  }
  uploadProfilePhoto(file);
  // Reset input so same file dobara select ho sake
  input.value = '';
}

function _pmUploadMsg(msg, color) {
  const el = document.getElementById('pmUploadStatus');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--muted)'; }
}

async function uploadProfilePhoto(file) {
  if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return;
  const email = String(CURRENT_USER.email || '').trim().toLowerCase();
  if (!email) { _pmUploadMsg('❌ Email not found.', '#ff5c7c'); return; }

  _pmUploadMsg('⏳ Uploading...', '#f0a500');

  try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const filePath = `avatars/${email}.${ext}`;
    const bucket   = 'Employee_Photos';
    const hdrs = {
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${_currentToken}`,
      'Content-Type': file.type,
      'Cache-Control': '3600',
      'x-upsert': 'true'   // agar file already hai toh overwrite karo
    };

    // 1. Storage mein upload
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${filePath}`,
      { method: 'POST', headers: hdrs, body: file }
    );

    if (!uploadRes.ok) {
      const errTxt = await uploadRes.text();
      throw new Error('Upload failed: ' + errTxt);
    }

    // 2. Public URL banao
    // Cache bust ke liye timestamp add karo
    const ts = Date.now();
    const avatarUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filePath}?t=${ts}`;

    // 3. Employee_details table mein avatar_url update karo
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/Employee_details?Email_Id=ilike.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${_currentToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ avatar_url: avatarUrl })
      }
    );

    if (!patchRes.ok) {
      const errTxt2 = await patchRes.text();
      throw new Error('DB update failed: ' + errTxt2);
    }

    // 4. CURRENT_USER mein save karo + localStorage update
    CURRENT_USER.avatar_url = avatarUrl;
    localStorage.setItem('aditiUser', JSON.stringify(CURRENT_USER));

    // 5. Profile modal photo update karo
    const photoWrap = document.getElementById('pmPhotoWrap');
    if (photoWrap) {
      photoWrap.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
    }

    // 6. Home page banner photo bhi update karo (live)
    const homeBanner = document.getElementById('empProfileBanner');
    if (homeBanner) {
      // Koi bhi purana photo element dhundho — wrap, loading, ya placeholder
      const targetEl = homeBanner.querySelector('.emp-photo-wrap')
                    || homeBanner.querySelector('.emp-photo-loading')
                    || homeBanner.querySelector('.emp-photo-placeholder');
      if (targetEl) {
        const newWrap = document.createElement('div');
        newWrap.className = 'emp-photo-wrap';
        const newImg = document.createElement('img');
        newImg.src = avatarUrl;
        newImg.alt = CURRENT_USER.name || 'Profile';
        newImg.style.cssText = 'width:90px;height:90px;object-fit:cover;border-radius:50%;';
        newWrap.appendChild(newImg);
        targetEl.replaceWith(newWrap);
      }
      // Banner visible karo agar hidden hai
      homeBanner.style.display = 'flex';
    }

    // 7. Sidebar, bottom nav, user sheet — sab update karo
    _syncProfileUI();

    _pmUploadMsg('✅ Photo updated successfully!', '#00d4aa');

  } catch(err) {
    _pmUploadMsg('❌ ' + (err.message || 'Upload failed. Please try again.'), '#ff5c7c');
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── Dashboards Hub — Odoo-style icon grid, one tile per dashboard ─────────
// Pure presentation layer: a tile shows iff its sidebar nav-{id} item is
// currently visible (display !== 'none'). Visibility itself is still decided
// entirely by each dashboard's own _apply*NavVisibility()/_tRevealTasksNav()/
// _applyRenewalsNavVisibility() function (see js/auth.js, js/tasks.js,
// js/renewals.js, etc.) — this function never re-implements or duplicates
// those checks, it only reads their result off the DOM.
const DASHBOARD_HUB_TILES = [
  // Pinned first — visible only to MD or an active delegation_assignees row (see
  // _applyTaskDelegationNavVisibility in js/taskDelegation.js); everyone else's grid is
  // unaffected since .filter() below never reorders, it only drops invisible tiles.
  { id:'taskdelegation', label:'Task Delegation',      color:'#f43f5e', icon:'<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M9 12h6"/><path d="M12 9l3 3-3 3"/>' },
  { id:'leads',        label:'SmartFleet',            color:'#00d4aa', icon:'<polyline points="3 12 9 12 11 6 15 18 17 12 21 12"/>' },
  { id:'entsol',       label:'Enterprise Solutions',   color:'#a78bfa', icon:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  { id:'enterprise',   label:'Enterprise Lead',        color:'#f0a500', icon:'<path d="M3 4h18l-7 8v6l-4 2v-8z"/>' },
  { id:'renewals',     label:'Renewals & Collections', color:'#06b6d4', icon:'<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/>' },
  { id:'fms',          label:'FMS O2D',                color:'#34d399', icon:'<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>' },
  { id:'tasks',        label:'Task Checklist',         color:'#fb923c', icon:'<rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><path d="M9 14l2 2 4-4"/>' },
  { id:'ims',          label:'IMS',                    color:'#f5a623', icon:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  { id:'mapping',      label:'Customer Mapping',       color:'#10b981', icon:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>' },
  { id:'crm',          label:'CRM Vehicle',            color:'#3b82f6', icon:'<path d="M3 13l2-5a2 2 0 012-1h10a2 2 0 012 1l2 5"/><rect x="2" y="13" width="20" height="5" rx="1"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>' },
  { id:'fieldservice', label:'Field Service',          color:'#818cf8', icon:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"/>' },
  { id:'hremployee',   label:'HR Employee Master',     color:'#a855f7', icon:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
];

function _renderDashboardsHub(){
  const grid  = document.getElementById('dashboardsHubGrid');
  const empty = document.getElementById('dashboardsHubEmpty');
  if(!grid) return; // panel not in the DOM yet (e.g. called before portal render)
  const visible = DASHBOARD_HUB_TILES.filter(t=>{
    const nav = document.getElementById('nav-'+t.id);
    return nav && nav.style.display !== 'none';
  });
  if(!visible.length){
    grid.style.display='none';
    grid.innerHTML='';
    if(empty) empty.style.display='block';
    return;
  }
  if(empty) empty.style.display='none';
  grid.style.display='grid';
  grid.innerHTML = visible.map(t=>`
    <div class="dash-hub-tile" onclick="switchDB('${t.id}')" title="${t.label}">
      <div class="dash-hub-icon" style="background:${t.color}40;">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${t.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
      </div>
      <div class="dash-hub-label">${t.label}</div>
    </div>
  `).join('');
}

function resourcesShowDocs(){
  document.getElementById('resources-main').style.display='none';
  document.getElementById('resources-docs').style.display='block';
  window.scrollTo({top:0,behavior:'smooth'});
}
function resourcesShowMain(){
  document.getElementById('resources-docs').style.display='none';
  document.getElementById('resources-main').style.display='block';
  window.scrollTo({top:0,behavior:'smooth'});
}


// ═══════════════════════════════════════════════════════════
// GLOBAL VIDEO MANAGER — Ek waqt mein sirf ek video
// Jab koi naya video play hota hai, baaki sab automatically pause
// ═══════════════════════════════════════════════════════════
function pauseAllVideosExcept(exceptId) {
  document.querySelectorAll('video').forEach(function(v) {
    if (v.id !== exceptId && !v.paused) {
      v.pause();
    }
  });
}

function switchDB(id, fromPopState){
  _actOnPageSwitch(id); // ACTIVITY TRACKING: log previous page time, start new page timer
  document.querySelectorAll('.dashboard-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.bn-item').forEach(n=>n.classList.remove('active'));
  // Highlight the Dashboards hub trigger whenever a sub-dashboard is active
  var dashPanels=['leads','enterprise','entsol','fms','tasks','ims','crm','mapping','renewals','fieldservice','hremployee','taskdelegation'];
  if(dashPanels.indexOf(id)>=0){
    var hubTrigger=document.getElementById('nav-dashboardshub');
    if(hubTrigger){hubTrigger.classList.add('active');}
  }
  // Reset Resources sub-view when switching away
  if(id!=='resources'){
    var rm=document.getElementById('resources-main');
    var rd=document.getElementById('resources-docs');
    if(rm){rm.style.display='block';}
    if(rd){rd.style.display='none';}
  }
  var panel=document.getElementById('panel-'+id);
  if(!panel){
    // Fallback for coming-soon panels — show home
    document.getElementById('panel-home').classList.add('active');
    document.getElementById('nav-home').classList.add('active');
    return;
  }
  panel.classList.add('active');
  if(document.getElementById('nav-'+id)) document.getElementById('nav-'+id).classList.add('active');
  if(document.getElementById('bn-'+id)) document.getElementById('bn-'+id).classList.add('active');
  // Scroll to top on mobile
  window.scrollTo({top:0,behavior:'smooth'});
  const _up=document.getElementById('bnUserPopup');if(_up)_up.classList.remove('open');
  if(id==='leads'&&!lLoaded){lLoaded=true;loadLeads();}
  if(id==='enterprise'&&!enLoaded){enLoaded=true;loadEnterprise();}
  if(id==='entsol'&&!entsolLoaded){entsolLoaded=true;loadEnterpriseSolutions();}
  if(id==='tasks'&&!tLoaded){tLoaded=true;loadTasks();}
  if(id==='hr'){loadHRSection();}
  if(id==='sales'&&!salesDocsLoaded){loadSalesDocs();}
  if(id==='aftersales'&&!afterSalesLoaded){loadAfterSales();}
  if(id==='products'&&!prodLoaded){loadProducts();}
  if(id==='training'){loadTrainingSection();}
  if(id==='marketing'){loadMarketingCounts();}
  if(id==='ims')      { loadIMSDashboard(); }
  if(id==='crm')      { loadCRMDashboard(); }
  if(id==='mapping')   { loadMappingDashboard(); }
  if(id==='adminperms') { loadAdminPermsPanel(); }
  if(id==='renewals')   { loadRenewals(); }
  if(id==='finance')    { loadSimpleCNPanel('finance',    'Finance').then(()=>_injectPurchaseCard()); }
  if(id==='referral')   { initReferralProgramme(); }
  if(id==='fieldservice') { loadFieldService(); }
  if(id==='hremployee')  { loadHREmployeeMaster(); }
  if(id==='taskdelegation') { loadTaskDelegation(); }
  if(id==='dealpricing') { loadDealPricing(); }
  if(id==='announcements') { /* handled by override below */ }
  if(id==='activitylog') { loadActivityLog(); }
  if(id==='itadmin')    { loadSimpleCNPanel('itadmin',    'IT Admin');   }
  if(id==='resources')  { loadResourcesUploads(); }
  // Training panel needs no data loading — just shows static links
  // Push history state so back button returns to home
  if(!fromPopState){
    if(id==='home'){
      history.replaceState({panel:'home'},'','');
    } else {
      history.pushState({panel:id},'','');
    }
  }
}

// Handle browser/phone back button — always go to home
window.addEventListener('popstate', function(e){
  const panel = (e.state && e.state.panel) ? e.state.panel : 'home';
  switchDB(panel==='home' ? 'home' : 'home', true);
});

// On portal load, set initial history state
function initHistory(){
  history.replaceState({panel:'home'},'','');
}

// ╔══════════════════════════════════════════════════════════════════════════
// ║  [SUPABASE SETUP] — Database connection constants
// ║  SUPABASE_URL  = Supabase project ka URL (kabhi change mat karo)
// ║  SUPABASE_ANON = Public anon key (safe to expose — RLS protect karta hai)
// ║  _currentToken = Login ke baad user's JWT replace karta hai anon key ko
// ║  SB_HDRS()     = Har API call mein yahi headers lagao
// ║  IMPORTANT: Agar Supabase project change karo toh DONO URL + ANON update karo
// ╚══════════════════════════════════════════════════════════════════════════
// ── Supabase constants + header helpers (defined early — used throughout) ──
const SUPABASE_URL  = 'https://rramdtpabwjsndgkohbi.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyYW1kdHBhYndqc25kZ2tvaGJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MDQ4ODUsImV4cCI6MjA5MTQ4MDg4NX0.hpdTOkhRrbqmbPM6VJWEtz2oEjkeXAjYJQS9rgzheec';
// ── Auth token — login ke baad user JWT yahan save hota hai ──
let _currentToken = SUPABASE_ANON; // default: anon; login hone pe user JWT set hoga

// SB_HDRS ab _currentToken use karta hai — authenticated RLS policies kaam karengi
// SB_HDRS_JSON / SB_HDRS_REPR / SB_HDRS_MIN sab inhi se extend hote hain — auto-fix!
const SB_HDRS      = () => ({ 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${_currentToken}`, 'Accept': 'application/json' });
const SB_HDRS_JSON = () => ({ ...SB_HDRS(), 'Content-Type': 'application/json' });
const SB_HDRS_REPR = () => ({ ...SB_HDRS_JSON(), 'Prefer': 'return=representation' });
const SB_HDRS_MIN  = () => ({ ...SB_HDRS_JSON(), 'Prefer': 'return=minimal' });

// SB_HDRS_AUTH alias — purana code jo SB_HDRS_AUTH() use karta hai vo bhi kaam kare
const SB_HDRS_AUTH      = SB_HDRS;
const SB_HDRS_AUTH_JSON = SB_HDRS_JSON;

// ═══════════════════════════════════
// SMARTFLEET DASHBOARD (Supabase leads_normalized view — see js/leads.js)
// ═══════════════════════════════════
const REP_MAP={'supportmum@adititracking.com':{name:'Support MUM',color:'#f0a500',bg:'rgba(240,165,0,0.2)'},'salesmumbai@adititracking.com':{name:'Sales Mumbai',color:'#00d4aa',bg:'rgba(0,212,170,0.2)'},'salesgoa@adititracking.com':{name:'Sales Goa',color:'#ff5c7c',bg:'rgba(255,92,124,0.2)'},'salesgujarat@adititracking.com':{name:'Sales Gujarat',color:'#a78bfa',bg:'rgba(167,139,250,0.2)'},'coolbus.enterprise@adititracking.com':{name:'CoolBus',color:'#4e9af1',bg:'rgba(78,154,241,0.2)'}};
const rN=e=>REP_MAP[e]?.name||(String(e||'')).split('@')[0];
const rC=e=>REP_MAP[e]?.color||'#888';
const rB=e=>REP_MAP[e]?.bg||'rgba(128,128,128,0.2)';
const rI=e=>rN(e).charAt(0).toUpperCase();
// Set Chart.js global defaults based on current theme on initial load
(function(){
  const isLight = document.body.classList.contains('light-mode');
  const tc = isLight ? '#000000' : '#ffffff';
  const gc = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
  if(typeof Chart !== 'undefined'){
    Chart.defaults.color = tc;
    Chart.defaults.borderColor = gc;
    Chart.defaults.font.family = 'DM Sans';
  }
})();

// ── Generic CN panel loader (Finance / Referral) ─────────────
// Loads content_nodes cards for a section name into a standard panel layout.
const _simplePanelLoaded = {};

// --- Shared: renders a single content_nodes category as a home-card ───────
function _renderCNCard(cat, i) {
  const th    = cnTheme(i);
  const name  = cat.name || 'Category';
  const count = CN.totalFiles(cat.id);
  const safe  = name.replace(/'/g,"\\'").replace(/"/g,'&quot;');
  return `
  <div style="position:relative;">
    ${_isMIS() ? `        <button onclick="event.stopPropagation();confirmDeleteCard(${cat.id},'${safe}')" title="Delete"
      style="position:absolute;top:10px;right:10px;z-index:3;width:28px;height:28px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444;cursor:pointer;display:flex;align-items:center;justify-content:center;"
      onmouseover="this.style.background='rgba(239,68,68,0.25)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
    </button>` : ''}
    <div class="home-card" style="--card-top:${th.color};cursor:pointer;"
      onclick="_hideAssessmentTab();switchMktTab('videos');cnOpenOverlay(${cat.id},'${safe}','marketingOverlay','mktOverlayTitle','mktOverlaySub','mktOverlayGrid','mktOverlayLoader','mktOverlayEmpty')"
      onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 12px 36px rgba(0,0,0,0.3)';this.style.borderColor='${th.color}'"
      onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor=''">
      <div class="hc-icon" style="background:${th.bg};border-color:${th.border};color:${th.color};">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="hc-name">${name}</div>
      <div class="hc-desc" style="font-size:0.88rem;line-height:1.55;color:var(--muted);">${getCNCardDesc(name)}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;">
        <span class="hc-status live" style="background:${th.bg};color:${th.color};border:1px solid ${th.border};">📂 ${count} file${count===1?'':'s'}</span>
        <span style="font-size:0.78rem;font-weight:600;color:${th.color};">View →</span>
      </div>
    </div>
  </div>`;
}

// --- Shared: loadSimpleCNPanel ---
async function loadSimpleCNPanel(panelKey, sectionName) {
  if (_simplePanelLoaded[panelKey]) return;
  _simplePanelLoaded[panelKey] = true;

  const loadingEl = document.getElementById(panelKey + '-loading');
  const gridEl    = document.getElementById(panelKey + '-grid');
  const emptyEl   = document.getElementById(panelKey + '-empty');

  try {
    await CN.load();
    const section = CN.getSection(sectionName);
    if (!section) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl)   emptyEl.style.display = 'block';
      return;
    }
    const cats = CN.getCategories(section.id);
    if (!cats.length) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl)   emptyEl.style.display = 'block';
      return;
    }
    if (loadingEl) loadingEl.style.display = 'none';
    gridEl.innerHTML = cats.map((cat, i) => _renderCNCard(cat, i)).join('');
    gridEl.style.display = 'grid';
  } catch(e) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (emptyEl)   { emptyEl.style.display = 'block'; emptyEl.textContent = '⚠️ ' + e.message; }
  }
}

// --- Resources (Documents tab) — uploaded doc cards go next to the static cards ---
async function loadResourcesUploads() {
  const gridEl = document.getElementById('resources-grid');
  if (!gridEl) return;

  // "Company Docs & Certifications" + "NDA's" — MD (owner) only.
  // MD sees ONLY these 2 static cards; everyone else sees ONLY uploaded/dynamic folders.
  const isMD   = CURRENT_USER && CURRENT_USER.role === 'owner';
  const mdOnly = document.getElementById('resources-md-only');
  if (mdOnly) mdOnly.style.display = isMD ? 'contents' : 'none';

  // Clear out any previously injected dynamic cards first
  gridEl.querySelectorAll('.res-dyn-card').forEach(el => el.remove());
  if (isMD) return; // MD never sees uploaded folders here

  try {
    await CN.load();
    const section = CN.getSection('Resources');
    if (!section) return;
    const cats = CN.getCategories(section.id);
    cats.forEach((cat, i) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = _renderCNCard(cat, i);
      const cardEl = wrap.firstElementChild;
      cardEl.classList.add('res-dyn-card');
      gridEl.appendChild(cardEl);
    });
  } catch(e) {}
}

function toggleTheme(){
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('aditiTheme', isLight ? 'light' : 'dark');
  const icon = isLight ? '☀️' : '🌙';
  const label = isLight ? 'Light Mode' : 'Dark Mode';
  const loginBtn = document.getElementById('loginThemeBtn');
  const sidebarBtn = document.getElementById('sidebarThemeBtn');
  const mobBtn = document.getElementById('mobThemeBtn');
  if(loginBtn) loginBtn.textContent = icon + ' ' + label;
  if(sidebarBtn) sidebarBtn.textContent = icon + ' ' + label;
  if(mobBtn) mobBtn.textContent = icon + ' ' + (isLight ? 'Light' : 'Dark');
  // Redraw all charts so axis/label colors update immediately
  // First destroy existing charts, then re-render with new colors
  try{
    if(typeof L!=='undefined'&&L.length){
      Object.values(Lch||{}).forEach(c=>c&&c.destroy&&c.destroy()); Lch={};
      if(typeof lRenderCharts==='function') lRenderCharts();
      if(typeof lRenderLB==='function') lRenderLB();
    }
  }catch(e){}
  try{
    if(typeof C!=='undefined'&&C.length){
      Object.values(Cch||{}).forEach(c=>c&&c.destroy&&c.destroy()); Cch={};
      const cD=typeof cGetFiltered==='function'?cGetFiltered():(C||[]);
      if(typeof cRenderCharts==='function') cRenderCharts(cD);
      if(typeof cRenderLB==='function') cRenderLB(cD);
    }
  }catch(e){}
  try{
    if(typeof fmsCharts!=='undefined'&&Object.keys(fmsCharts||{}).length){
      Object.values(fmsCharts).forEach(c=>c&&c.destroy&&c.destroy()); fmsCharts={};
      if(typeof fmsRenderCharts==='function') fmsRenderCharts();
    }
  }catch(e){}
  try{
    if(typeof tCharts!=='undefined'&&Object.keys(tCharts||{}).length){
      Object.values(tCharts).forEach(c=>c&&c.destroy&&c.destroy()); tCharts={};
      if(typeof tRenderCharts==='function') tRenderCharts();
    }
  }catch(e){}
}

// Apply saved theme on load
(function(){
  const saved = localStorage.getItem('aditiTheme');
  if(saved === 'dark'){
    // Dark mode only if explicitly saved as dark
  } else {
    // Default is light mode
    document.body.classList.add('light-mode');
    const loginBtn = document.getElementById('loginThemeBtn');
    if(loginBtn) loginBtn.textContent = '☀️ Light Mode';
    const mobBtn = document.getElementById('mobThemeBtn');
    if(mobBtn) mobBtn.textContent = '☀️ Light';
  }
})();

/* ══ ABOUT ORGANISATION — tab switcher ══ */
function switchAbout(tab){
  document.querySelectorAll('.about-section').forEach(s=>s.style.display='none');
  document.querySelectorAll('#aboutTabs .about-tab').forEach(t=>t.classList.remove('active'));
  var el=document.getElementById('about-'+tab);
  if(el)el.style.display='block';
  var idx={'overview':0,'locations':1,'milestones':2,'certifications':3}[tab];
  if(idx===undefined)idx=0;
  var tabs=document.querySelectorAll('#aboutTabs .about-tab');
  if(tabs[idx])tabs[idx].classList.add('active');
}

/* ── MOBILE MENU SHEET ── */
function toggleMobMenu(){
  var sheet=document.getElementById('mobMenuSheet');
  var overlay=document.getElementById('mobMenuOverlay');
  if(sheet.style.display==='none'||sheet.style.display===''){
    sheet.style.display='block';
    overlay.style.display='block';
    requestAnimationFrame(function(){
      sheet.style.transform='translateY(0)';
    });
  } else {
    closeMobMenu();
  }
}
function closeMobMenu(){
  var sheet=document.getElementById('mobMenuSheet');
  var overlay=document.getElementById('mobMenuOverlay');
  sheet.style.transform='translateY(100%)';
  setTimeout(function(){
    sheet.style.display='none';
    overlay.style.display='none';
  },280);
}
function mobMenuGo(panel){
  // update active highlight in mobile menu
  document.querySelectorAll('.mm-nav-item').forEach(function(el){el.classList.remove('mm-active');});
  var target=document.getElementById('mm-'+panel);
  if(target) target.classList.add('mm-active');
  closeMobMenu();
  switchDB(panel);
}

// ============================================================


/* ────────────────────────────────────────────────────────────
   FILE VIEWER — opens Google Drive folders/files inside portal
   ──────────────────────────────────────────────────────────── */

// Convert any Google Drive URL to its embeddable form
// Office docs (doc/docx/xls/xlsx/ppt/pptx) hosted anywhere other than Google
// Drive/Docs (e.g. our own Supabase Storage public URLs) can't be rendered by
// the browser directly — an iframe pointed straight at the raw file just
// downloads it. Microsoft's Office Online viewer can embed any *publicly
// reachable* file URL, so route those through it instead.
function isOfficeDocUrl(url){
  if(!url) return false;
  var ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return ['doc','docx','xls','xlsx','ppt','pptx'].indexOf(ext) >= 0;
}
function toEmbeddableUrl(url){
  if(isOfficeDocUrl(url) && !/drive\.google\.com|docs\.google\.com/.test(url)){
    return 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url);
  }
  return toDriveEmbedUrl(url);
}
function toDriveEmbedUrl(url){
  if(!url) return url;
  try{
    // 1) Folder URL:  /drive/folders/FOLDER_ID  →  embeddedfolderview
    var folderMatch = url.match(/\/drive\/folders\/([a-zA-Z0-9_-]+)/);
    if(folderMatch){
      return 'https://drive.google.com/embeddedfolderview?id=' + folderMatch[1] + '#grid';
    }
    // 2) File URL:  /file/d/FILE_ID/...  →  /preview
    var fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if(fileMatch){
      return 'https://drive.google.com/file/d/' + fileMatch[1] + '/preview';
    }
    // 3) Google Docs / Sheets / Slides  →  /preview
    var docMatch = url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
    if(docMatch){
      return 'https://docs.google.com/' + docMatch[1] + '/d/' + docMatch[2] + '/preview';
    }
    // 4) open?id=ID  →  file preview
    var openMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if(openMatch && url.indexOf('drive.google.com')>=0){
      return 'https://drive.google.com/file/d/' + openMatch[1] + '/preview';
    }
  }catch(e){}
  return url; // fallback: raw URL
}

// Detect direct video file from URL
function isDirectVideoUrl(url){
  if(!url) return false;
  var ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return ['mp4','webm','mov','m4v','ogg','ogv'].indexOf(ext) >= 0;
}

// Open any URL inside the in-page viewer modal

// ═══════════════════════════════════════════════════════════
// DIRECTORY DOC — Seedha Supabase se link fetch karke open karo
// ═══════════════════════════════════════════════════════════
async function openDirectoryDoc(module, displayName) {
  closeDirectoryOverlay();
  try {
    await CN.load();
    const hrSection = CN.getSection('HR');
    let fileData = null;
    if (hrSection) {
      const cats = CN.getCategories(hrSection.id);
      const dirCat = cats.find(c => (c.name||'').toLowerCase().includes('director'));
      if (dirCat) {
        const subCats = CN.getCategories(dirCat.id);
        const match = subCats.find(c => (c.name||'').toLowerCase().includes(module.trim().toLowerCase()));
        if (match) {
          const files = CN.getFiles(match.id);
          if (files.length) fileData = files[0];
        }
        // Also try direct files of directory node
        if (!fileData) {
          const direct = CN.getFiles(dirCat.id);
          if (direct.length) fileData = direct[0];
        }
      }
    }
    if (fileData && fileData.url) {
      openFileViewer(fileData.url, fileData.name || displayName || 'Document');
    } else {
      alert('No file found for ' + (displayName || module) + '. Please add files in the files table.');
    }
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

function openFileViewer(url, title){
  if(!url) return;

  // Track file/video open
  const _isYT  = /(?:youtube\.com|youtu\.be)/i.test(url);
  const _isVid = /\.(mp4|webm|mov)(\?|$)/i.test(url);
  const _isPdf = /\.pdf(\?|$)/i.test(url);
  const _evType = _isYT || _isVid ? 'video_play' : 'file_open';
  logActivity({
    event_type:   _evType,
    event_detail: (_isYT ? 'YouTube: ' : _isVid ? 'Video: ' : _isPdf ? 'PDF: ' : 'File: ') + (title||url),
    page_name:    _actPageName || 'unknown',
    card_name:    _actCardName || '',
    video_title:  (_isYT || _isVid) ? (title||url) : null,
    file_name:    (!_isYT && !_isVid) ? (title||url) : null,
  });

  // YouTube link → seedha new tab mein kholo (iframe mein nahi chalega)
  if(_isYT) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  var ov = document.getElementById('file-viewer-overlay');
  if(!ov) return;

  document.getElementById('file-viewer-title').textContent = title || 'Documents';

  var body    = document.getElementById('file-viewer-body');
  var frame   = document.getElementById('file-viewer-frame');
  var loading = document.getElementById('file-viewer-loading');
  var mask    = document.getElementById('file-viewer-dl-mask');
  var mask2   = document.getElementById('file-viewer-dl-mask2');

  // If it's a direct video file, render a <video> tag instead of iframe
  if(isDirectVideoUrl(url)){
    frame.src = 'about:blank';
    frame.style.display = 'none';
    loading.style.display = 'none';
    if(mask)  mask.style.display  = 'none';
    if(mask2) mask2.style.display = 'none';
    // Training video jaisa exact approach — static HTML element, direct src set, sirf load()
    var vid = document.getElementById('file-viewer-video');
    vid.style.display = 'block';
    pauseAllVideosExcept('file-viewer-video');
    vid.src = url;   // playModuleVideo jaisa — seedha src assign
    vid.load();      // sirf load — no autoplay (training video approach)
  } else {
    // Document / folder → iframe with embeddable URL
    var vid = document.getElementById('file-viewer-video');
    if(vid){ try{vid.pause();}catch(e){} vid.removeAttribute('src'); vid.load(); vid.style.display='none'; }

    // Mobile/PWA detect: Android Chrome iframe mein PDF "Open" button + pencil aata hai
    // Fix: mobile par seedha Google Drive preview new tab mein kholo
    // iPad bhi isi path se jaata hai — iPadOS Safari mein cropped/absolute-positioned
    // iframe ke andar Google Drive/PDF content left-pinned reh jaata hai aur vertically
    // scroll nahi hota, isliye tablets ko bhi "new tab" wale reliable path pe bhej dete hain.
    var isMobile = isMobileDevice() || isTabletDevice();

    if(isMobile){
      // Modal band karo aur Google Drive preview seedha new tab mein kholo
      ov.style.display = 'none';
      document.body.style.overflow = '';
      // Drive embed URL ki jagah original preview URL use karo
      var mobileUrl = toEmbeddableUrl(url);
      window.open(mobileUrl, '_blank');
      return;
    }

    frame.style.display = 'block';
    loading.style.display = 'flex';
    var embedUrl = toEmbeddableUrl(url);
    // Add #toolbar=0 hint (works on Chrome native PDF viewer; harmless otherwise)
    if(embedUrl.indexOf('#') === -1) embedUrl += '#toolbar=0';
    frame.src = embedUrl;

    var isGoogle = /drive\.google\.com|docs\.google\.com/.test(embedUrl);
    // Safari detect karo
    var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if(isGoogle){
      if(isSafari){
        // Safari fix: toolbar clip nahi karte — seedha normal size rakhte hain
        // Safari mein calc(100% + 128px) scroll tod deta hai
        frame.style.top    = '0';
        frame.style.height = '100%';
        if(mask)  mask.style.display  = 'none';
        if(mask2) mask2.style.display = 'none';
      } else {
        // 🔒 CLIP TOOLBAR: shift iframe UP by 64px so Google's toolbar is outside visible area.
        //     Parent has overflow:hidden so the shifted-off part is invisible & unclickable.
        frame.style.top    = '-64px';
        frame.style.height = 'calc(100% + 128px)'; // extend bottom too to hide any bottom bar
        if(mask)  mask.style.display  = 'block';   // backup mask in case clip fails
        if(mask2) mask2.style.display = 'block';
      }
    } else {
      frame.style.top    = '0';
      frame.style.height = '100%';
      if(mask)  mask.style.display  = 'none';
      if(mask2) mask2.style.display = 'none';
    }
  }

  ov.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeFileViewer(){
  var frame = document.getElementById('file-viewer-frame');
  if(frame) frame.src = 'about:blank';
  var vid = document.getElementById('file-viewer-video');
  if(vid){ try{vid.pause();}catch(e){} vid.removeAttribute('src'); vid.load(); vid.style.display='none'; }
  document.getElementById('file-viewer-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

// Click outside modal to close
document.getElementById('file-viewer-overlay').addEventListener('click', function(e){
  if(e.target === this) closeFileViewer();
});

// Escape key closes file viewer
document.addEventListener('keydown', function(e){
  var ov = document.getElementById('file-viewer-overlay');
  var isOpen = ov && ov.style.display === 'flex';
  if(e.key === 'Escape' && isOpen){ closeFileViewer(); return; }
});

/* Auto-intercept: any <a> tag pointing to drive.google.com or docs.google.com
   with a data-inline-view attribute (or matching folder/file pattern) opens
   inside the viewer instead of a new tab. This is a safety net — primary
   hookup is the onclick handler added on each link below. */
document.addEventListener('click', function(e){
  var a = e.target.closest && e.target.closest('a[data-inline-view]');
  if(!a) return;
  e.preventDefault();
  var title = a.getAttribute('data-title') ||
              (a.querySelector('.hc-name') ? a.querySelector('.hc-name').textContent.trim() : 'Documents');
  openFileViewer(a.href, title);
});
