// ═══════════════════════════════════════════════════════════════════════
// DEAL PRICING CALCULATOR
// Tables:  pricing_products, pricing_state_costs, pricing_quotes,
//          pricing_quote_lines, pricing_admin_users, pricing_quote_counters
// RPCs:    is_pricing_admin(), get_pricing_catalog(state), submit_quote(...)
//
// Reps only ever see floor_price via get_pricing_catalog() — cost_price
// never leaves pricing_products/pricing_state_costs, which RLS locks down
// to is_pricing_admin() only. The Cost Master tab below is gated client-
// side too (dpCheckAdmin/_dpIsAdmin) purely for UX — RLS is the real wall.
// No direct writes to pricing_quotes/pricing_quote_lines from here; quotes
// only ever go through submit_quote() (server re-validates floor + totals).
// No Odoo/n8n push — intentionally out of scope; rep recreates the order
// in Odoo manually afterwards, same as today.
// ═══════════════════════════════════════════════════════════════════════

// Branch states this pricing model currently understands. This is org
// branch metadata, not product data — same kind of small hand-maintained
// list as RU_LOCATIONS in renewals.js. Add a line here (and have MD add its
// cost rows in Cost Master) whenever a new branch opens.
const DP_STATES = ['Maharashtra', 'Gujarat', 'Karnataka', 'Goa'];

// Defaults the Calculator's state picker to the rep's own branch, reusing
// the same crm_persons.location codes renewals.js already reads for its
// own location scoping (see _applyRenewalsNavVisibility in js/renewals.js).
const DP_LOCATION_TO_STATE = {
  original:  'Maharashtra', // Mumbai HO
  gujarat:   'Gujarat',
  bangalore: 'Karnataka',
  goa:       'Goa',
};

let _dpIsAdmin           = false;
let _dpState              = DP_STATES[0];
let _dpCatalog            = [];  // [{product_id,name,category,unit,gst_pct,default_margin_pct,floor_price}]
let _dpCategoryFilter     = '';
let _dpLines              = [];  // [{key,product_id,qty,floor_price,margin_pct,selling_price}]
let _dpLineSeq            = 0;
let _dpLoaded             = false;
let _dpCostMasterRows     = [];  // pricing_products rows (admin only — RLS returns [] otherwise)
let _dpOverridesByProduct = {};  // product_id -> [pricing_state_costs rows]
let _dpEditProductId      = null;

const DP_TABS = [
  { id: 'calc',       label: 'Calculator' },
  { id: 'costmaster', label: 'Cost Master' }, // only rendered when _dpIsAdmin
];

function _dpRound2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ═══════════════════════════════════════════════════════════════════════
// TAB BAR — same translucent-pill pattern as tdRenderTabBar in
// js/taskDelegation.js (var(--accent2) teal tint, not a solid fill).
// ═══════════════════════════════════════════════════════════════════════
function _dpTabBtnStyle(active) {
  return `padding:10px 18px;border-radius:10px;border:1.5px solid ${active ? 'var(--accent2)' : 'var(--border)'};background:${active ? 'rgba(0,212,170,0.12)' : 'var(--surface2)'};color:${active ? 'var(--accent2)' : 'var(--muted)'};font-weight:700;font-size:0.87rem;cursor:pointer;font-family:inherit;`;
}

// A tab exists in the DOM at all only if its own gate passes — mirrors
// ruRenderTabBar()'s "nothing to render if there's nothing to switch
// between" rule in js/renewals.js.
function _dpVisibleTabIds() {
  const ids = [];
  if (_dpCanAccessCalculator()) ids.push('calc');
  if (_dpIsAdmin) ids.push('costmaster');
  return ids;
}

function dpRenderTabBar() {
  const bar = document.getElementById('dpTabBar');
  if (!bar) return;
  const visible = _dpVisibleTabIds();
  bar.innerHTML = DP_TABS
    .filter(t => visible.includes(t.id))
    .map(t => `<button id="dpTabBtn-${t.id}" onclick="dpSwitchTab('${t.id}')" style="${_dpTabBtnStyle(false)}">${t.label}${t.id === 'costmaster' ? ' <span style="opacity:0.75;">(MD only)</span>' : ''}</button>`)
    .join('');
}

function dpSwitchTab(tabId) {
  if (!_dpVisibleTabIds().includes(tabId)) return; // client-side gate only — RLS/can_view_pricing checks are the real ones
  DP_TABS.forEach(t => {
    const content = document.getElementById(`dpTab-${t.id}`);
    if (content) content.style.display = (t.id === tabId) ? 'block' : 'none';
    const btn = document.getElementById(`dpTabBtn-${t.id}`);
    if (btn) btn.setAttribute('style', _dpTabBtnStyle(t.id === tabId));
  });
  if (tabId === 'costmaster') dpLoadCostMaster();
}

// ═══════════════════════════════════════════════════════════════════════
// ACCESS — two independent gates, deliberately not folded into one:
//   - Calculator tab: PERMISSIONS.can_view_pricing — a plain manual toggle
//     in the Access Control admin panel (js/adminperms.js), backed by
//     user_permissions like any other module there. NOT Employee_Dept-based
//     — an earlier one-time department bulk-grant seeded the initial rows,
//     but this key carries no ongoing department logic of its own.
//   - Cost Master tab: is_pricing_admin() ONLY — an MD/designated senior
//     user must never be locked out of it based on can_view_pricing.
// Both _dpCanAccessCalculator() and _dpFetchIsPricingAdmin() are also used
// by js/sales.js to decide whether the "Deal Calculator" card shows on the
// Sales landing page (its only entry point — there is no sidebar nav item).
// ═══════════════════════════════════════════════════════════════════════
function _dpCanAccessCalculator() {
  if (!CURRENT_USER) return false;
  return (PERMISSIONS.can_view_pricing || 'false') !== 'false';
}

async function _dpFetchIsPricingAdmin() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_pricing_admin`, {
      method: 'POST', headers: SB_HDRS_JSON(), body: JSON.stringify({}),
    });
    return res.ok ? (await res.json()) === true : false;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════
// ENTRY POINT — switchDB('dealpricing') hook in js/app.js
// ═══════════════════════════════════════════════════════════════════════
async function loadDealPricing() {
  if (_dpLoaded) return;
  await dpCheckAdmin(); // sets _dpIsAdmin — needed up front to decide which tab(s) exist at all
  if (!_dpCanAccessCalculator() && !_dpIsAdmin) return; // fails closed — nav item would be hidden anyway
  _dpLoaded = true;
  dpRenderTabBar();
  // Land on Calculator if this user has it; a Cost-Master-only admin
  // (is_pricing_admin but no can_view_pricing) lands on Cost Master instead.
  dpSwitchTab(_dpCanAccessCalculator() ? 'calc' : 'costmaster');
  if (_dpCanAccessCalculator()) {
    await dpDefaultState();
    await dpLoadCatalog();
    if (!_dpLines.length) dpAddLine();
  }
}

async function dpCheckAdmin() {
  _dpIsAdmin = await _dpFetchIsPricingAdmin();
}

// ── Default state — reuse the rep's own branch (crm_persons.location),
// same lookup renewals.js already does for its own location scoping. ─────
async function dpDefaultState() {
  _dpState = DP_STATES[0];
  try {
    if (typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.email) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/crm_persons?email=ilike.${encodeURIComponent(CURRENT_USER.email)}&is_active=eq.true&select=location&limit=1`,
        { headers: SB_HDRS() }
      );
      const rows = res.ok ? await res.json() : [];
      const loc = rows && rows[0] && rows[0].location;
      if (loc && DP_LOCATION_TO_STATE[loc]) _dpState = DP_LOCATION_TO_STATE[loc];
    }
  } catch (e) { /* keep default */ }
  const sel = document.getElementById('dpStateSelect');
  if (sel) sel.innerHTML = DP_STATES.map(s => `<option value="${s}" ${s === _dpState ? 'selected' : ''}>${s}</option>`).join('');
}

async function dpOnStateChange(state) {
  _dpState = state;
  await dpLoadCatalog();
}

// ═══════════════════════════════════════════════════════════════════════
// CALCULATOR — catalog + line items
// ═══════════════════════════════════════════════════════════════════════
async function dpLoadCatalog() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_pricing_catalog`, {
      method: 'POST', headers: SB_HDRS_JSON(), body: JSON.stringify({ p_state: _dpState }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _dpCatalog = await res.json();
  } catch (e) {
    _dpCatalog = [];
    alert('⚠️ Could not load pricing catalog: ' + e.message);
  }
  dpRenderCategoryFilter();
  // Re-price every existing line against the newly selected state's floor.
  _dpLines.forEach(line => {
    const item = _dpCatalog.find(p => p.product_id === line.product_id);
    if (item) {
      line.floor_price = item.floor_price;
      line.selling_price = _dpRound2(item.floor_price * (1 + line.margin_pct / 100));
    }
  });
  dpRenderLines();
}

function dpRenderCategoryFilter() {
  const sel = document.getElementById('dpCategoryFilter');
  if (!sel) return;
  const cats = [...new Set(_dpCatalog.map(p => p.category))].sort();
  if (_dpCategoryFilter && !cats.includes(_dpCategoryFilter)) _dpCategoryFilter = '';
  sel.innerHTML = '<option value="">All Categories</option>' +
    cats.map(c => `<option value="${c}" ${c === _dpCategoryFilter ? 'selected' : ''}>${c}</option>`).join('');
}

function dpOnCategoryFilterChange(cat) {
  _dpCategoryFilter = cat;
  dpRenderProductOptions();
}

function dpFilteredCatalog() {
  return _dpCategoryFilter ? _dpCatalog.filter(p => p.category === _dpCategoryFilter) : _dpCatalog;
}

// Re-populates every line's product <select>, keeping each line's own
// already-picked product selected even if it now falls outside the active
// category filter — switching the filter never silently drops a line.
function dpRenderProductOptions() {
  document.querySelectorAll('.dp-line-product').forEach(sel => {
    const line = _dpLines.find(l => String(l.key) === sel.dataset.lineKey);
    const list = dpFilteredCatalog();
    const extra = line && line.product_id && !list.some(p => p.product_id === line.product_id)
      ? _dpCatalog.filter(p => p.product_id === line.product_id) : [];
    const options = [...list, ...extra];
    sel.innerHTML = '<option value="">Select product…</option>' +
      options.map(p => `<option value="${p.product_id}" ${line && line.product_id === p.product_id ? 'selected' : ''}>${p.name} (${p.category})</option>`).join('');
  });
}

function dpAddLine() {
  _dpLineSeq += 1;
  _dpLines.push({ key: _dpLineSeq, product_id: '', qty: 1, floor_price: 0, margin_pct: 0, selling_price: 0 });
  dpRenderLines();
}

function dpRemoveLine(key) {
  _dpLines = _dpLines.filter(l => l.key !== key);
  dpRenderLines();
}

function dpLineProductChange(key, productId) {
  const line = _dpLines.find(l => l.key === key);
  if (!line) return;
  line.product_id = productId;
  const item = _dpCatalog.find(p => p.product_id === productId);
  line.floor_price   = item ? item.floor_price : 0;
  line.margin_pct    = 0;
  line.selling_price = item ? item.floor_price : 0; // margin 0% => selling = floor by default
  dpRenderLines();
}

function dpLineQtyChange(key, qty) {
  const line = _dpLines.find(l => l.key === key);
  if (!line) return;
  line.qty = Math.max(1, parseInt(qty, 10) || 1);
  dpRenderTotals();
}

// Margin % here mirrors submit_quote's own definition (margin over floor,
// not over cost — reps never see cost) so what's previewed client-side
// always matches what the server stores: (selling/floor - 1) * 100.
function dpLineMarginChange(key, marginPct) {
  const line = _dpLines.find(l => l.key === key);
  if (!line) return;
  line.margin_pct = parseFloat(marginPct);
  if (isNaN(line.margin_pct)) line.margin_pct = 0;
  line.selling_price = _dpRound2(line.floor_price * (1 + line.margin_pct / 100));
  dpRenderLines();
}

function dpLinePriceChange(key, sellingPrice) {
  const line = _dpLines.find(l => l.key === key);
  if (!line) return;
  line.selling_price = parseFloat(sellingPrice);
  if (isNaN(line.selling_price)) line.selling_price = 0;
  line.margin_pct = line.floor_price > 0 ? _dpRound2(((line.selling_price / line.floor_price) - 1) * 100) : 0;
  dpRenderLines();
}

function dpHasBelowFloor() {
  return _dpLines.some(l => l.product_id && l.selling_price < l.floor_price);
}

function dpRenderLines() {
  const body  = document.getElementById('dpLinesBody');
  const empty = document.getElementById('dpLinesEmpty');
  if (!body) return;

  if (!_dpLines.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    dpRenderTotals();
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = _dpLines.map(line => {
    const belowFloor = line.product_id && line.selling_price < line.floor_price;
    const lineTotal  = _dpRound2(line.qty * line.selling_price);
    return `
    <tr style="${belowFloor ? 'background:rgba(255,92,124,0.08);' : ''}">
      <td><select class="dp-line-product filter-select" data-line-key="${line.key}" onchange="dpLineProductChange(${line.key}, this.value)" style="width:220px;"></select></td>
      <td><input type="number" class="fms-form-input dp-no-spinner" min="1" step="1" value="${line.qty}" style="width:70px;" onchange="dpLineQtyChange(${line.key}, this.value)"></td>
      <td>₹${line.floor_price.toFixed(2)}</td>
      <td><input type="number" class="fms-form-input dp-no-spinner" step="0.1" value="${line.margin_pct}" style="width:90px;" onchange="dpLineMarginChange(${line.key}, this.value)"></td>
      <td><input type="number" class="fms-form-input dp-no-spinner" step="1" value="${line.selling_price}" style="width:110px;" onchange="dpLinePriceChange(${line.key}, this.value)"></td>
      <td>₹${lineTotal.toFixed(2)} ${belowFloor ? '<span class="badge badge-below">Below floor</span>' : ''}</td>
      <td><button onclick="dpRemoveLine(${line.key})" title="Remove line" style="background:none;border:none;color:var(--accent3);cursor:pointer;font-size:1.1rem;">✕</button></td>
    </tr>`;
  }).join('');
  dpRenderProductOptions();
  dpRenderTotals();
}

function dpRenderTotals() {
  let subtotal = 0, gst = 0;
  _dpLines.forEach(line => {
    if (!line.product_id) return;
    const item = _dpCatalog.find(p => p.product_id === line.product_id);
    const gstPct = item ? item.gst_pct : 0;
    subtotal += line.qty * line.selling_price;
    gst      += line.qty * line.selling_price * gstPct / 100;
  });
  subtotal = _dpRound2(subtotal); gst = _dpRound2(gst);
  const grand = _dpRound2(subtotal + gst);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = '₹' + val.toFixed(2); };
  set('dpSubtotal', subtotal); set('dpGst', gst); set('dpGrandTotal', grand);

  const belowFloor = dpHasBelowFloor();
  const warn = document.getElementById('dpFloorWarning');
  if (warn) warn.style.display = belowFloor ? 'block' : 'none';
  const btn = document.getElementById('dpGenerateBtn');
  if (btn) {
    const disabled = belowFloor || !_dpLines.some(l => l.product_id);
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.5' : '1';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GENERATE QUOTATION — submit_quote RPC (server re-validates floor, never
// trusts the client's numbers), then a client-side PDF via jsPDF.
// ═══════════════════════════════════════════════════════════════════════
async function dpGenerateQuote() {
  const msgEl  = document.getElementById('dpQuoteMsg');
  const nameEl = document.getElementById('dpCustomerName');
  const customerName = nameEl ? nameEl.value.trim() : '';
  if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; }

  if (!customerName) {
    if (msgEl) { msgEl.textContent = '⚠️ Enter a customer name first.'; msgEl.style.color = 'var(--accent3)'; }
    return;
  }
  const validLines = _dpLines.filter(l => l.product_id);
  if (!validLines.length) {
    if (msgEl) { msgEl.textContent = '⚠️ Add at least one product line.'; msgEl.style.color = 'var(--accent3)'; }
    return;
  }
  if (dpHasBelowFloor()) {
    if (msgEl) { msgEl.textContent = '⚠️ Fix the line(s) below floor price before generating.'; msgEl.style.color = 'var(--accent3)'; }
    return;
  }

  const btn = document.getElementById('dpGenerateBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; btn.textContent = 'Generating…'; }

  try {
    const payload = {
      p_state: _dpState,
      p_customer_name: customerName,
      p_lines: validLines.map(l => ({ product_id: l.product_id, qty: l.qty, selling_price: l.selling_price })),
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_quote`, {
      method: 'POST', headers: SB_HDRS_JSON(), body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message || ('HTTP ' + res.status));
    }
    const result = await res.json();
    if (msgEl) { msgEl.textContent = `✅ Quote ${result.quote_ref} saved to the log.`; msgEl.style.color = 'var(--accent2)'; }

    await dpDownloadQuotePdf(result, customerName, validLines);

    _dpLines = [];
    dpAddLine();
    if (nameEl) nameEl.value = '';
  } catch (e) {
    if (msgEl) { msgEl.textContent = '❌ ' + e.message; msgEl.style.color = 'var(--accent3)'; }
  } finally {
    if (btn) btn.textContent = 'Generate Quotation';
    dpRenderTotals(); // re-evaluates disabled state for the reset form
  }
}

// jsPDF is only needed once a quote is actually generated — lazy-load it
// rather than paying its cost on every portal load for every user.
let _dpJsPdfLoading = null;
function _dpLoadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_dpJsPdfLoading) return _dpJsPdfLoading;
  _dpJsPdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load PDF library'));
    document.head.appendChild(s);
  });
  return _dpJsPdfLoading;
}

async function dpDownloadQuotePdf(result, customerName, lines) {
  try {
    await _dpLoadJsPdf();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;

    doc.setFontSize(16); doc.text('Aditi Tracking — Quotation', 14, y); y += 10;
    doc.setFontSize(10);
    doc.text(`Quote Ref: ${result.quote_ref}`, 14, y); y += 6;
    doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 14, y); y += 6;
    doc.text(`Customer: ${customerName}`, 14, y); y += 6;
    doc.text(`State: ${_dpState}`, 14, y); y += 6;
    doc.text(`Rep: ${(typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.name) || ''}`, 14, y); y += 10;

    doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text('Product', 14, y); doc.text('Qty', 118, y); doc.text('Price', 140, y); doc.text('Total', 170, y);
    doc.setFont(undefined, 'normal'); y += 5;
    doc.line(14, y, 196, y); y += 6;

    lines.forEach(line => {
      const item  = _dpCatalog.find(p => p.product_id === line.product_id);
      const name  = item ? item.name : line.product_id;
      const total = _dpRound2(line.qty * line.selling_price);
      if (y > 270) { doc.addPage(); y = 20; }
      doc.text(String(name).slice(0, 55), 14, y);
      doc.text(String(line.qty), 118, y);
      doc.text(line.selling_price.toFixed(2), 140, y);
      doc.text(total.toFixed(2), 170, y);
      y += 6;
    });

    y += 4; doc.line(14, y, 196, y); y += 8;
    doc.text(`Subtotal: Rs ${result.subtotal.toFixed(2)}`, 140, y); y += 6;
    doc.text(`GST: Rs ${result.gst_amount.toFixed(2)}`, 140, y); y += 6;
    doc.setFont(undefined, 'bold');
    doc.text(`Grand Total: Rs ${result.grand_total.toFixed(2)}`, 140, y);

    doc.save(`${result.quote_ref}.pdf`);
  } catch (e) {
    const msgEl = document.getElementById('dpQuoteMsg');
    if (msgEl) msgEl.textContent += ' (PDF download failed: ' + e.message + ')';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// COST MASTER — MD-office only. Reads/writes pricing_products and
// pricing_state_costs directly (no RPC) — RLS on both tables already
// restricts this to is_pricing_admin() users, per the brief.
// ═══════════════════════════════════════════════════════════════════════
async function dpLoadCostMaster() {
  if (!_dpIsAdmin) return;
  const body  = document.getElementById('dpCostMasterBody');
  const empty = document.getElementById('dpCostMasterEmpty');
  try {
    const [prodRes, overridesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/pricing_products?select=*&order=category.asc,name.asc`, { headers: SB_HDRS() }),
      fetch(`${SUPABASE_URL}/rest/v1/pricing_state_costs?select=*`, { headers: SB_HDRS() }),
    ]);
    if (!prodRes.ok) throw new Error('HTTP ' + prodRes.status);
    _dpCostMasterRows = await prodRes.json();
    const overrides = overridesRes.ok ? await overridesRes.json() : [];
    _dpOverridesByProduct = {};
    overrides.forEach(o => { (_dpOverridesByProduct[o.product_id] = _dpOverridesByProduct[o.product_id] || []).push(o); });
  } catch (e) {
    if (body) body.innerHTML = '';
    if (empty) { empty.style.display = 'block'; empty.textContent = '⚠️ ' + e.message; }
    return;
  }
  dpRenderCostMasterTable();
}

function dpRenderCostMasterTable() {
  const body  = document.getElementById('dpCostMasterBody');
  const empty = document.getElementById('dpCostMasterEmpty');
  if (!body) return;

  if (!_dpCostMasterRows.length) {
    body.innerHTML = '';
    if (empty) { empty.style.display = 'block'; empty.textContent = 'No products yet — click "+ Add Product" to create the first one.'; }
    return;
  }
  if (empty) empty.style.display = 'none';

  body.innerHTML = _dpCostMasterRows.map(p => {
    const baseFloor = _dpRound2(p.cost_price * (1 + p.default_margin_pct / 100));
    const overrides = _dpOverridesByProduct[p.id] || [];
    const overrideChips = overrides.length
      ? overrides.map(o => `<span class="badge badge-open" style="margin-right:4px;">${o.state}: ₹${Number(o.cost_price).toFixed(2)}</span>`).join('')
      : '<span style="color:var(--muted);font-size:0.78rem;">Base cost only</span>';
    return `
    <tr style="${p.is_active ? '' : 'opacity:0.5;'}">
      <td>${p.name}</td>
      <td>${p.category}</td>
      <td>${p.unit}</td>
      <td>₹${Number(p.cost_price).toFixed(2)}</td>
      <td>${Number(p.default_margin_pct).toFixed(1)}%</td>
      <td>₹${baseFloor.toFixed(2)}</td>
      <td>${Number(p.gst_pct).toFixed(1)}%</td>
      <td>${overrideChips}</td>
      <td>${p.is_active ? '<span class="badge badge-won">Active</span>' : '<span class="badge badge-zero">Inactive</span>'}</td>
      <td style="white-space:nowrap;">
        <button onclick="dpOpenProductModal('${p.id}')" style="background:none;border:none;color:var(--accent2);cursor:pointer;font-weight:600;">Edit</button>
        <button onclick="dpToggleProductActive('${p.id}', ${!p.is_active})" style="background:none;border:none;cursor:pointer;font-weight:600;color:${p.is_active ? 'var(--accent3)' : 'var(--accent2)'};">${p.is_active ? 'Deactivate' : 'Reactivate'}</button>
      </td>
    </tr>`;
  }).join('');
}

// Soft-delete only — never a hard DELETE, so old quotes' floor_price
// snapshots stay meaningful for audit even after a product is retired.
async function dpToggleProductActive(productId, newActive) {
  if (!newActive && !confirm('Deactivate this product? It will disappear from the Calculator (existing quotes are unaffected).')) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_products?id=eq.${productId}`, {
      method: 'PATCH', headers: SB_HDRS_MIN(), body: JSON.stringify({ is_active: newActive, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = _dpCostMasterRows.find(r => r.id === productId);
    if (p) p.is_active = newActive;
    dpRenderCostMasterTable();
  } catch (e) {
    alert('❌ Could not update: ' + e.message);
  }
}

// ── Add / edit product modal ─────────────────────────────────────────────
function dpOpenProductModal(productId) {
  _dpEditProductId = productId || null;
  const p = productId ? _dpCostMasterRows.find(r => r.id === productId) : null;

  document.getElementById('dpProductErr').style.display = 'none';
  document.getElementById('dpProductModalTitle').textContent = p ? 'Edit Product' : 'Add Product';
  document.getElementById('dpProductModalSub').textContent = p ? p.name : 'New pricing product';
  document.getElementById('dpPName').value     = p ? p.name : '';
  document.getElementById('dpPCategory').value = p ? p.category : 'Hardware';
  document.getElementById('dpPUnit').value     = p ? p.unit : '';
  document.getElementById('dpPCost').value     = p ? p.cost_price : '';
  document.getElementById('dpPMargin').value   = p ? p.default_margin_pct : 20;
  document.getElementById('dpPGst').value      = p ? p.gst_pct : 18;
  document.getElementById('dpPActive').value   = p ? String(p.is_active) : 'true';

  const overridesSection = document.getElementById('dpStateOverridesSection');
  overridesSection.style.display = p ? 'block' : 'none';
  if (p) dpRenderOverridesTable(p.id);

  dpUpdateFloorPreview();
  document.getElementById('dpProductOverlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function dpCloseProductModal() {
  document.getElementById('dpProductOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

function dpUpdateFloorPreview() {
  const cost   = parseFloat(document.getElementById('dpPCost').value) || 0;
  const margin = parseFloat(document.getElementById('dpPMargin').value) || 0;
  document.getElementById('dpPFloorPreview').textContent = '₹' + _dpRound2(cost * (1 + margin / 100)).toFixed(2);
}
document.addEventListener('input', function(e) {
  if (e.target && (e.target.id === 'dpPCost' || e.target.id === 'dpPMargin')) dpUpdateFloorPreview();
});

async function dpSaveProduct() {
  const errEl = document.getElementById('dpProductErr');
  errEl.style.display = 'none';

  const payload = {
    name:               document.getElementById('dpPName').value.trim(),
    category:           document.getElementById('dpPCategory').value,
    unit:               document.getElementById('dpPUnit').value.trim(),
    cost_price:         parseFloat(document.getElementById('dpPCost').value),
    default_margin_pct: parseFloat(document.getElementById('dpPMargin').value),
    gst_pct:            parseFloat(document.getElementById('dpPGst').value),
    is_active:          document.getElementById('dpPActive').value === 'true',
  };

  if (!payload.name || !payload.unit || isNaN(payload.cost_price) || isNaN(payload.default_margin_pct) || isNaN(payload.gst_pct)) {
    errEl.textContent = 'Please fill in all fields with valid values.';
    errEl.style.display = 'block';
    return;
  }

  try {
    if (_dpEditProductId) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_products?id=eq.${_dpEditProductId}`, {
        method: 'PATCH', headers: SB_HDRS_MIN(),
        body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      Object.assign(_dpCostMasterRows.find(r => r.id === _dpEditProductId), payload);
      dpRenderCostMasterTable();
      dpCloseProductModal();
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_products`, {
        method: 'POST', headers: SB_HDRS_REPR(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const [created] = await res.json();
      _dpCostMasterRows.push(created);
      dpRenderCostMasterTable();
      // Switch the modal into edit mode for the new product so overrides
      // can be added immediately without closing and reopening it.
      dpOpenProductModal(created.id);
    }
  } catch (e) {
    errEl.textContent = '❌ ' + e.message;
    errEl.style.display = 'block';
  }
}

// ── State overrides — each row commits to pricing_state_costs immediately,
// independent of the base product's own Save button. ─────────────────────
function dpRenderOverridesTable(productId) {
  const body = document.getElementById('dpOverridesBody');
  if (!body) return;
  const overrides = _dpOverridesByProduct[productId] || [];
  if (!overrides.length) {
    body.innerHTML = '<tr><td colspan="4" style="color:var(--muted);">No state overrides — this product uses its base cost everywhere.</td></tr>';
    return;
  }
  const p = _dpCostMasterRows.find(r => r.id === productId);
  body.innerHTML = overrides.map(o => {
    const floor = p ? _dpRound2(o.cost_price * (1 + p.default_margin_pct / 100)) : 0;
    return `
    <tr>
      <td>${o.state}</td>
      <td><input type="number" class="fms-form-input" value="${o.cost_price}" step="0.01" style="width:120px;" onchange="dpUpdateOverride('${o.id}', this.value)"></td>
      <td>₹${floor.toFixed(2)}</td>
      <td><button onclick="dpDeleteOverride('${o.id}', '${productId}')" title="Remove override" style="background:none;border:none;color:var(--accent3);cursor:pointer;">✕</button></td>
    </tr>`;
  }).join('');
}

async function dpAddOverride() {
  if (!_dpEditProductId) return;
  const stateEl = document.getElementById('dpNewOverrideState');
  const costEl  = document.getElementById('dpNewOverrideCost');
  const state = stateEl.value.trim();
  const cost  = parseFloat(costEl.value);
  if (!state || isNaN(cost)) { alert('Enter a state and a valid cost price.'); return; }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_state_costs`, {
      method: 'POST', headers: SB_HDRS_REPR(),
      body: JSON.stringify({ product_id: _dpEditProductId, state, cost_price: cost }),
    });
    if (!res.ok) throw new Error(await res.text());
    const [created] = await res.json();
    (_dpOverridesByProduct[_dpEditProductId] = _dpOverridesByProduct[_dpEditProductId] || []).push(created);
    dpRenderOverridesTable(_dpEditProductId);
    dpRenderCostMasterTable();
    stateEl.value = ''; costEl.value = '';
  } catch (e) {
    alert('❌ Could not add override (this product may already have one for that state — edit it below instead): ' + e.message);
  }
}

async function dpUpdateOverride(overrideId, costPrice) {
  const cost = parseFloat(costPrice);
  if (isNaN(cost)) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_state_costs?id=eq.${overrideId}`, {
      method: 'PATCH', headers: SB_HDRS_MIN(), body: JSON.stringify({ cost_price: cost }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const row = (_dpOverridesByProduct[_dpEditProductId] || []).find(o => o.id === overrideId);
    if (row) row.cost_price = cost;
    dpRenderOverridesTable(_dpEditProductId);
    dpRenderCostMasterTable();
  } catch (e) {
    alert('❌ Could not update override: ' + e.message);
  }
}

async function dpDeleteOverride(overrideId, productId) {
  if (!confirm('Remove this state override? The product will fall back to its base cost for that state.')) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_state_costs?id=eq.${overrideId}`, { method: 'DELETE', headers: SB_HDRS() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _dpOverridesByProduct[productId] = (_dpOverridesByProduct[productId] || []).filter(o => o.id !== overrideId);
    dpRenderOverridesTable(productId);
    dpRenderCostMasterTable();
  } catch (e) {
    alert('❌ Could not delete override: ' + e.message);
  }
}
