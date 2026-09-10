// Section: Access Control (loadAdminPermsPanel, permission toggles per user)
// ╔══════════════════════════════════════════════════════════════════════════
// ║  [ACCESS CONTROL JS] — Permission panel logic (MIS ONLY)
// ║  _PAPI = Flask API URL on Railway (for /api/permissions endpoint)
// ║  _permLabels = Har permission key ka display name
// ║  loadAdminPermsPanel() = Supabase se sab users + permissions load karo
// ║  acpSave()             = Toggle change hone pe save karo
// ║  Agar naya permission add karna ho (koi column add karne ki zaroorat NAHI —
// ║  role_defaults/user_permissions dono key-value tables hain):
// ║    1. Supabase role_defaults table mein rows insert karo — jis role ko
// ║       access dena hai uske liye ek row: (role, permission, 'true')
// ║    2. _permLabels object mein label add karo yahan (frontend display name)
// ║    Flask api.py mein KUCH change nahi karna — teeno endpoints already
// ║    generic hain, naya permission key automatically pick ho jaata hai.
// ╚══════════════════════════════════════════════════════════════════════════
let _acpUsers = [], _acpAllKeys = [], _acpLoaded = false;

const _permLabels = {
  can_view_leads:         '📊 SmartFleet Dashboard',
  can_view_enterprise:    '🏢 Enterprise Lead Dashboard',
  can_view_entsol:        '🏢 Enterprise Solutions Dashboard',
  can_view_fms:           '🔧 FMS Installation Tracker',
      fms_create:             '📋 FMS Create Order',
      fms_support:            '👷 FMS Support Actions',
      fms_config:             '⚙️ FMS Config (Device Configuration)',
      fms_view_all:           '👁 FMS View All Orders',
      fms_override:           '🔑 FMS Override (MIS)',
  can_view_ims:           '📦 IMS Dashboard',
  can_view_mapping:             '🗺️ Customer Mapping — View',
  can_edit_mapping:             '🗺️ Customer Mapping — Edit',
  mapping_region_headoffice:    '🗺️ Mapping Region — HeadOffice',
  mapping_region_goa:           '🗺️ Mapping Region — Goa',
  mapping_region_bangalore:     '🗺️ Mapping Region — Bangalore',
  mapping_region_gujarat:       '🗺️ Mapping Region — Gujarat',
  can_view_crm:           '🚗 CRM Vehicle Dashboard',
  crm_server_premium:     '🚗 CRM — Premium Server',
  crm_server_pro:         '🚗 CRM — PRO Server',
  crm_server_goa:         '🚗 CRM — Goa Server',
  crm_server_bangalore:   '🚗 CRM — Bangalore Server',
  crm_server_gujarat:     '🚗 CRM — Gujarat Server',
  can_view_crm_changes:   '🔄 CRM — Vehicle Changes',
  can_view_activitylog:   '📋 Activity Log',
  can_view_announcements: '🔔 View Announcements',
  can_post_announcements: '📢 Post Announcements',
  can_upload_files:       '📤 Upload & Delete Files',
  can_upload_quiz:        '🎯 Create & Manage Quizzes',
  can_download_video:     '⬇️ Download Training Videos',
  checklist_scope:        '✅ Task Checklist Scope',
  can_delete_tasks:       '🗑️ Task Checklist — Delete Tasks',
  can_use_task_scheduler: '🗓️ Task Checklist — Task Scheduler',
  can_view_open_roles:        '📋 Referral — Open Roles',
  can_view_my_referrals:      '🧾 Referral — My Referrals',
  can_view_referral_pipeline: '📊 Referral — Pipeline (HR)',
  can_post_referral_role:     '➕ Referral — Post a Role (HR)',
  field_service_view_all:     '🛠️ Field Service — View All Entries',
  hr_employee_view:           '🧑‍💼 HR Employee Master — View',
  hr_employee_edit:           '🧑‍💼 HR Employee Master — Edit',
  home_content_manage:        '🏠 Home Content — Manage Sections & Cards',
  can_view_pricing:           '💰 Deal Calculator',
  // Toggling this ALSO writes/deletes a row in pricing_admin_users on the
  // backend (Cost Master's real RLS boundary) — see save_user_permission()
  // in backend/api.py. The value shown here always mirrors that table
  // directly (not a plain user_permissions read) so it can never drift.
  can_access_cost_master:     '🔐 Cost Master (Pricing Admin)',
};

async function loadAdminPermsPanel() {
  if (_acpLoaded) return;
  const loading = document.getElementById('acpLoading');
  const error   = document.getElementById('acpError');
  const table   = document.getElementById('acpTable');
  try {
    const res  = await fetch(`${_PAPI}/api/admin/all-users-permissions`, {
      headers: { 'X-User-Email': CURRENT_USER.email }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data  = await res.json();
    _acpUsers   = data.users || [];
    // field_service_create is no longer permission-gated anywhere (frontend or RLS —
    // see the Field Service permission-removal decision). all_permission_keys is
    // sourced from role_defaults in the DB (backend/api.py), which still has an
    // inert row for it, so it's filtered out here rather than left to render as a
    // dead toggle that would confuse MIS admins.
    _acpAllKeys = (data.all_permission_keys || []).filter(k => k !== 'field_service_create');
    _acpLoaded  = true;
    if (loading) loading.style.display = 'none';
    if (table)   table.style.display   = 'block';
    acpRender(_acpUsers);
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (error) { error.style.display = 'block'; error.textContent = '❌ ' + e.message; }
  }
}

function acpFilter() {
  const q = (document.getElementById('acpSearch').value || '').toLowerCase();
  acpRender(_acpUsers.filter(u => (u.name||'').toLowerCase().includes(q) || (u.email||'').includes(q)));
}

function acpRender(users) {
  const rows = document.getElementById('acpRows');
  if (!rows) return;
  if (!users.length) { rows.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">No employees found</div>'; return; }
  rows.innerHTML = users.map(u => {
    const perms = u.permissions || {};
    const permHtml = _acpAllKeys.map(key => {
      const label = _permLabels[key] || key;
      const val   = perms[key] || 'false';
      if (key === 'checklist_scope') {
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:0.82rem;color:var(--text2);">${label}</span>
          <select onchange="acpSave('${u.email}','${key}',this.value)"
            style="padding:5px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.80rem;font-family:inherit;cursor:pointer;outline:none;">
            <option value="own" ${val==='own'?'selected':''}>Own data only</option>
            <option value="all" ${val==='all'?'selected':''}>All employees</option>
          </select></div>`;
      }
      const isOn = val === 'true';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:0.82rem;color:var(--text2);">${label}</span>
        <label style="position:relative;display:inline-block;width:38px;height:22px;cursor:pointer;flex-shrink:0;">
          <input type="checkbox" ${isOn?'checked':''} style="opacity:0;width:0;height:0;position:absolute;"
            onchange="acpSave('${u.email}','${key}',this.checked?'true':'false');
                      this.parentElement.querySelector('span').style.background=this.checked?'#00d4aa':'var(--border)';
                      this.parentElement.querySelector('span span').style.left=this.checked?'18px':'2px';">
          <span style="position:absolute;inset:0;border-radius:22px;background:${isOn?'#00d4aa':'var(--border)'};transition:background 0.2s;">
            <span style="position:absolute;left:${isOn?'18px':'2px'};top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 4px rgba(0,0,0,0.25);"></span>
          </span>
        </label></div>`;
    }).join('');
    const rc = u.role==='owner'?'#f0a500':u.role==='mis'?'#00d4aa':u.role==='pc'?'#a855f7':'#6b7280';
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:38px;height:38px;border-radius:50%;background:${rc}22;color:${rc};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;flex-shrink:0;border:1.5px solid ${rc}44;">${(u.name||'?')[0].toUpperCase()}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.92rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${u.name}</div>
          <div style="font-size:0.74rem;color:var(--muted);">${u.email}</div>
        </div>
        <span style="font-size:0.72rem;padding:3px 10px;border-radius:20px;background:${rc}18;color:${rc};font-weight:700;border:1px solid ${rc}33;">${u.role}</span>
      </div>
      ${permHtml}</div>`;
  }).join('');
}

async function acpSave(email, permission, value) {
  if (!CURRENT_USER || !CURRENT_USER.email) { alert('❌ Session expired. Please logout and login again.'); return; }
  if (!email) return;
  try {
    const res = await fetch(`${_PAPI}/api/admin/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Email': CURRENT_USER.email },
      body: JSON.stringify({ user_email: email, permission, value })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (typeof showToast === 'function') showToast('✅ Permission saved!', 'success', 2000);
    const user = _acpUsers.find(u => u.email === email);
    if (user) user.permissions[permission] = value;
  } catch(e) { alert('❌ Failed to save: ' + e.message); }
}
