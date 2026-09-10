// Section: Sales (loadSalesDocs, SOP documents)
let salesDocsLoaded = false;

const SALES_CAT_THEME = {
  'SOP':                { color:'#00d4aa', bg:'rgba(0,212,170,0.12)',  border:'rgba(0,212,170,0.3)',
    desc:'Standard Operating Procedures — step-by-step documented processes for the Sales team.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>` },
  'Target Audience':    { color:'#4e9af1', bg:'rgba(78,154,241,0.12)', border:'rgba(78,154,241,0.3)',
    desc:'Customer profiles and segmentation — understand who to target and how to approach them effectively.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>` },
  'Qualify Leads':      { color:'#f0a500', bg:'rgba(240,165,0,0.12)',  border:'rgba(240,165,0,0.3)',
    desc:'Lead qualification framework and SQL criteria — know when a prospect is truly ready to buy.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>` },
  'Sales Pitch':        { color:'#a855f7', bg:'rgba(168,85,247,0.12)', border:'rgba(168,85,247,0.3)',
    desc:'Ready-to-use pitch scripts and decks — present Aditi Tracking value proposition with confidence.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>` },
  'Objection Handling': { color:'#ff5c7c', bg:'rgba(255,92,124,0.12)', border:'rgba(255,92,124,0.3)',
    desc:'Common objections and proven responses — turn hesitations into opportunities.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>` },
  'Intro & Follow-up':  { color:'#00d4ff', bg:'rgba(0,212,255,0.12)',  border:'rgba(0,212,255,0.3)',
    desc:'Email and message templates for introductions and follow-ups — make the right first impression.',
    icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>` },
};
const SALES_FALLBACK_COLORS = [
  { color:'#f0a500', bg:'rgba(240,165,0,0.12)',  border:'rgba(240,165,0,0.3)'  },
  { color:'#a855f7', bg:'rgba(168,85,247,0.12)', border:'rgba(168,85,247,0.3)' },
  { color:'#00d4aa', bg:'rgba(0,212,170,0.12)',  border:'rgba(0,212,170,0.3)'  },
  { color:'#4e9af1', bg:'rgba(78,154,241,0.12)', border:'rgba(78,154,241,0.3)' },
  { color:'#ff5c7c', bg:'rgba(255,92,124,0.12)', border:'rgba(255,92,124,0.3)' },
  { color:'#00d4ff', bg:'rgba(0,212,255,0.12)',  border:'rgba(0,212,255,0.3)'  },
];
function getSalesCatTheme(cat, idx) {
  // exact match
  if (SALES_CAT_THEME[cat]) return SALES_CAT_THEME[cat];
  // fuzzy match
  for (const key of Object.keys(SALES_CAT_THEME)) {
    if (cat.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(cat.toLowerCase()))
      return SALES_CAT_THEME[key];
  }
  const fb = SALES_FALLBACK_COLORS[(idx||0) % SALES_FALLBACK_COLORS.length];
  return { ...fb, desc: 'Sales resources for ' + cat + '.', icon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` };
}

async function loadSalesDocs(force) {
  if (salesDocsLoaded && !force) return;
  const loading = document.getElementById('sales-loading');
  const errEl   = document.getElementById('sales-error');
  const grid    = document.getElementById('sales-cat-grid');
  if (loading) { loading.style.display = 'block'; }
  if (grid)    grid.style.display = 'none';
  if (errEl)   errEl.style.display = 'none';
  try {
    await CN.load();
    const section = CN.getSection('Sales');
    if (!section) throw new Error('Sales section not found in content_nodes');
    const cats = CN.getCategories(section.id);
    salesDocsLoaded = true;
    cnRenderCatGrid(grid, cats, loading, errEl, 'cnOpenSalesOverlay');
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (errEl)   { errEl.style.display = 'block'; errEl.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--muted);">⚠️ ' + e.message + '</div>'; }
  }
  // Deal Calculator — not a content_nodes document category, so it's injected
  // as a manually-authored first card rather than coming from cnRenderCatGrid.
  // Independent of the CN try/catch above: a CN load failure shouldn't hide
  // this unrelated tool card. See js/dealPricing.js for the two access gates.
  await _salesInjectDealCalculatorCard(grid);
}

async function _salesInjectDealCalculatorCard(grid) {
  if (!grid || grid.querySelector('.sales-dealcalc-card')) return;
  let show = (typeof _dpCanAccessCalculator === 'function') && _dpCanAccessCalculator();
  if (!show && typeof _dpFetchIsPricingAdmin === 'function') show = await _dpFetchIsPricingAdmin();
  if (!show) return;

  const th = cnTheme(0);
  const html = `
  <div class="sales-dealcalc-card" style="position:relative;">
    <div class="home-card" style="--card-top:${th.color};cursor:pointer;"
      onclick="switchDB('dealpricing')"
      onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 12px 36px rgba(0,0,0,0.3)';this.style.borderColor='${th.color}'"
      onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor=''">
      <div class="hc-icon" style="background:${th.bg};border-color:${th.border};color:${th.color};">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
      </div>
      <div class="hc-name">Deal Calculator</div>
      <div class="hc-desc" style="font-size:0.88rem;line-height:1.55;color:var(--muted);">Price deals above the system-enforced floor and generate customer quotations.</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;">
        <span class="hc-status live" style="background:${th.bg};color:${th.color};border:1px solid ${th.border};">⚡ Tool</span>
        <span style="font-size:0.78rem;font-weight:600;color:${th.color};">Open →</span>
      </div>
    </div>
  </div>`;
  grid.insertAdjacentHTML('afterbegin', html);
  grid.style.display = 'grid';
}

function cnOpenSalesOverlay(nodeId, catName) {
  cnOpenOverlay(nodeId, catName, 'salesDocsOverlay', 'salesOverlayTitle', 'salesOverlaySub',
                'salesOverlayGrid', 'salesOverlayLoader', 'salesOverlayEmpty');
}

function closeSalesOverlay() {
  _actOnCardClose(); // ACTIVITY TRACKING
  document.getElementById('salesDocsOverlay').style.display = 'none';
  document.body.style.overflow = '';
}
