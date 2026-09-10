# ═══════════════════════════════════════════════════════════════
# api.py — Aditi Portal Permission API
# A Flask web server that handles all permission-related requests
# from the frontend (index.html).
# Three endpoints:
#   GET  /api/permissions                  — called on login
#   POST /api/admin/permissions            — called when admin flips a toggle
#   GET  /api/admin/all-users-permissions  — called when admin opens panel
# ═══════════════════════════════════════════════════════════════

from flask import Flask, request, jsonify   # Flask web framework
from flask_cors import CORS                  # allows your frontend to call this server
from supabase import create_client, ClientOptions  # Supabase Python client
import httpx
import os                                   # to read environment variables
import time

# ── App setup ───────────────────────────────────────────────────
app = Flask(__name__)

# CORS = Cross-Origin Resource Sharing.
# Your frontend (index.html) is on one domain, this server is on another.
# Without CORS, the browser blocks the request. This line allows it.
CORS(app)

# ── Supabase connection ─────────────────────────────────────────
# IMPORTANT: This uses the SERVICE ROLE key, not the anon key.
# The service role key bypasses RLS and has full read/write access.
# NEVER put this key in your frontend HTML file.
# Store it as an environment variable on Railway.
SUPABASE_URL         = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Validate that service key is present before trying to connect.
# If missing, log a clear error but do NOT crash — Flask still starts.
# This means smartfleet_sync.py keeps running even if this key is missing.
#
# http2=False: postgrest-py (and storage3-py) hardcode http2=True on the
# httpx.Client they build internally when no http_client is supplied —
# confirmed by reading postgrest/_sync/client.py directly. In production
# this has been resetting mid-request (h2's ConnectionTerminated / httpx's
# "Server disconnected"), causing intermittent 500s on /api/permissions and
# /api/admin/all-users-permissions, and — since is_admin() below swallows
# the same exception into a plain `return False` — intermittent 403s too.
# Passing our own httpx.Client(http2=False, ...) via ClientOptions forces
# HTTP/1.1 for every Supabase call this service makes, sidestepping the
# whole class of bug. Verified locally: the default client's connection
# pool has _http2=True; this one has _http2=False.
sb = None
if SUPABASE_SERVICE_KEY:
    try:
        _http_client = httpx.Client(http2=False, timeout=30)
        sb = create_client(
            SUPABASE_URL,
            SUPABASE_SERVICE_KEY,
            options=ClientOptions(httpx_client=_http_client),
        )
        print("Supabase connected successfully (http2=False)")
    except Exception as e:
        print(f"Supabase connection failed: {e}")
        sb = None
else:
    print("WARNING: SUPABASE_SERVICE_KEY not set — database calls will fail but server will still start")

# ── Role mapping ────────────────────────────────────────────────
# Your Employee_details table stores roles as Employee_Dept values
# like "Managing Director", "MIS", "PC" etc.
# This maps those values to the short role keys used in role_defaults table.
# All keys are lowercase because we call .lower() before looking up.
ROLE_MAP = {
    "managing director":   "owner",
    "mis":                 "mis",
    "pc":                  "pc",
    "executive assistant": "executive assistant",
    "ea":                  "executive assistant",
    "admin":               "admin",
    # Added for home_content_manage (Home page HR content editor) — without
    # this, HR-dept staff fell into the "employee" bucket below and a
    # role_defaults row keyed role='hr' would never be read.
    "hr":                  "hr"
}

# The one permission key that has a side effect beyond user_permissions —
# toggling it also writes/deletes a row in pricing_admin_users (Cost Master's
# real RLS security boundary). See save_user_permission() and
# all_users_permissions() below for the two places this is used.
COST_MASTER_PERMISSION_KEY = "can_access_cost_master"

# ── Helper: check database is connected ────────────────────────
# Called at the top of every endpoint.
# If the Supabase client failed to initialise (missing key),
# this returns a clean 503 error instead of crashing with an AttributeError.
def db_check():
    if sb is None:
        return jsonify({
            "error": "Database not connected — SUPABASE_SERVICE_KEY is missing or invalid"
        }), 503
    return None   # None means all good, continue

# ── Helper: retry a Supabase query a few times on a transient transport
# failure (the ConnectionTerminated / "Server disconnected" class of error —
# see the http2=False comment on client setup above). This is specifically
# for recovering from a dropped connection, not for retrying a real data/
# query error — a genuine PostgREST error (bad filter, missing table, RLS
# denial, etc.) fails immediately on the first attempt via the same
# .execute() call and isn't worth retrying, but we don't try to distinguish
# that here: 2 extra attempts at ~150ms apart cost nothing on the rare
# genuine-error path either, since the caller's own try/except still runs
# once every attempt is exhausted.
def _execute_with_retry(query_fn, attempts=3, base_delay=0.15):
    last_exc = None
    for attempt in range(attempts):
        try:
            return query_fn()
        except Exception as e:
            last_exc = e
            if attempt < attempts - 1:
                print(f"[retry] transient error on attempt {attempt + 1}/{attempts}: {e}")
                time.sleep(base_delay * (attempt + 1))
    raise last_exc

# ── Helper: check if a caller is an admin (MIS or Managing Director) ────
# Broad "is this person MD-office-level staff" check. Used by
# /api/admin/generate-checklist-tasks (Task Scheduler) — NOT by the Access
# Control endpoints any more, see is_access_control_admin() below, which is
# a deliberately narrower, separate business rule. Do not merge these two
# back together: MD/owner must keep passing this one.
# Reads the X-User-Email header that the frontend sends with every request.
def is_admin(caller_email):
    if not caller_email:
        return False
    if sb is None:
        return False
    try:
        res = _execute_with_retry(lambda: sb.table("Employee_details")
            .select("Employee_Dept")
            .ilike("Email_Id", caller_email)
            .limit(1)
            .execute())
        if not res.data:
            return False
        dept = str(res.data[0].get("Employee_Dept", "")).strip().lower()
        return dept in ["mis", "managing director"]
    except Exception as e:
        # This is exactly where a transient ConnectionTerminated used to turn
        # into a silent "not an admin" — now logged, and only reached once
        # _execute_with_retry has already exhausted its attempts.
        print(f"is_admin() failed after retries for {caller_email}: {e}")
        return False

# ── Helper: check if a caller may use the Access Control panel ─────────
# Deliberately narrower than is_admin() above — MIS ONLY, not Managing
# Director/owner. This is a business-rule restriction on who may view/edit
# other people's permissions, decided separately from (and later than) the
# general "is this person MD-office staff" check — is_admin() itself is
# untouched and still authorizes MD for Task Scheduler generation and any
# other MD-specific feature.
# Used by POST /api/admin/permissions and GET /api/admin/all-users-permissions.
def is_access_control_admin(caller_email):
    if not caller_email:
        return False
    if sb is None:
        return False
    try:
        res = _execute_with_retry(lambda: sb.table("Employee_details")
            .select("Employee_Dept")
            .ilike("Email_Id", caller_email)
            .limit(1)
            .execute())
        if not res.data:
            return False
        dept = str(res.data[0].get("Employee_Dept", "")).strip().lower()
        return dept == "mis"
    except Exception as e:
        print(f"is_access_control_admin() failed after retries for {caller_email}: {e}")
        return False

# ── Helper: build merged permissions for one user ───────────────
# Step 1: Load role defaults (what everyone with this role gets)
# Step 2: Load user-specific overrides (what this person gets differently)
# Step 3: Merge — user overrides always win over role defaults
def get_permissions(email, role):
    permissions = {}

    # Step 1: role defaults
    try:
        defaults_res = _execute_with_retry(lambda: sb.table("role_defaults")
            .select("permission, value")
            .eq("role", role)
            .execute())
        for row in (defaults_res.data or []):
            permissions[row["permission"]] = row["value"]
    except Exception as e:
        print(f"Error fetching role defaults (after retries): {e}")

    # Step 2: user-specific overrides
    try:
        overrides_res = _execute_with_retry(lambda: sb.table("user_permissions")
            .select("permission, value")
            .eq("user_email", email.lower())
            .execute())
        for row in (overrides_res.data or []):
            permissions[row["permission"]] = row["value"]   # override wins
    except Exception as e:
        print(f"Error fetching user overrides (after retries): {e}")

    return permissions

# ── Helper: check if a caller has Field Service "view all" access ──
# Unlike is_admin() (role-based), this is a manually-granted permission —
# no role_defaults row implies it, so it's only ever true via a
# user_permissions override (see get_permissions above).
def _has_field_service_view_all(caller_email):
    if not caller_email or sb is None:
        return False
    try:
        emp_res = sb.table("Employee_details") \
            .select("Employee_Dept") \
            .ilike("Email_Id", caller_email) \
            .limit(1) \
            .execute()
        raw_role = str(emp_res.data[0].get("Employee_Dept", "")).strip().lower() if emp_res.data else ""
        role = ROLE_MAP.get(raw_role, "employee")
        perms = get_permissions(caller_email, role)
        return perms.get("field_service_view_all") == "true"
    except Exception:
        return False

# ── Helper: check if a caller has Task Scheduler access ─────────
# Same shape as _has_field_service_view_all above — a manually-granted
# permission (via the Access Control panel), not tied to role. Lets MIS
# give one specific non-MIS employee access to the Task Scheduler tab
# without changing their Employee_Dept/role.
def _has_task_scheduler_access(caller_email):
    if not caller_email or sb is None:
        return False
    try:
        emp_res = sb.table("Employee_details") \
            .select("Employee_Dept") \
            .ilike("Email_Id", caller_email) \
            .limit(1) \
            .execute()
        raw_role = str(emp_res.data[0].get("Employee_Dept", "")).strip().lower() if emp_res.data else ""
        role = ROLE_MAP.get(raw_role, "employee")
        perms = get_permissions(caller_email, role)
        return perms.get("can_use_task_scheduler") == "true"
    except Exception:
        return False

# ── Helper: {auth uuid: email} for every Supabase Auth user ─────
# Only the service-role key (held here, never in the browser) can call
# the Admin Auth API — this is what lets us resolve field_service_entries.
# engineer_id (a raw auth.users uuid, required so the insert RLS policy
# can check engineer_id = auth.uid()) back to an email, mirroring the
# email -> Employee_details.Employee_name lookup every other module
# already does client-side (fmsEmpName, _vrNameMap etc).
def _list_all_auth_users():
    id_to_email = {}
    page = 1
    per_page = 200
    while True:
        try:
            res = sb.auth.admin.list_users(page=page, per_page=per_page)
        except Exception as e:
            print(f"Error listing auth users: {e}")
            break
        users = res if isinstance(res, list) else getattr(res, "users", None) or []
        if not users:
            break
        for u in users:
            uid   = getattr(u, "id", None)
            email = getattr(u, "email", None)
            if uid and email:
                id_to_email[uid] = email.strip().lower()
        if len(users) < per_page:
            break
        page += 1
    return id_to_email


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 1: GET /api/permissions?email=someone@adititracking.com
#
# Called by index.html right after Supabase Auth login.
# Returns the merged permissions object for that user.
#
# Example response:
# {
#   "role": "mis",
#   "rawRole": "mis",
#   "permissions": {
#     "can_view_ims": "true",
#     "can_upload_files": "true",
#     "checklist_scope": "all",
#     ...
#   }
# }
# ══════════════════════════════════════════════════════════════════
@app.route("/api/permissions", methods=["GET"])
def fetch_user_permissions():
    # Check database is connected — return 503 if not
    err = db_check()
    if err:
        return err

    # Read the email from the URL query string: /api/permissions?email=...
    email = request.args.get("email", "").strip().lower()

    if not email:
        return jsonify({"error": "email is required"}), 400

    # Look up this person in Employee_details to find their department/role
    try:
        emp_res = sb.table("Employee_details") \
            .select("Employee_Dept") \
            .ilike("Email_Id", email) \
            .limit(1) \
            .execute()
    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500

    # If employee not found, treat as regular employee
    raw_role = ""
    if emp_res.data:
        raw_role = str(emp_res.data[0].get("Employee_Dept", "")).strip().lower()

    # Convert department name to role key using ROLE_MAP
    role = ROLE_MAP.get(raw_role, "employee")

    # Build merged permissions (role defaults + user overrides)
    permissions = get_permissions(email, role)

    return jsonify({
        "role":        role,
        "rawRole":     raw_role,
        "permissions": permissions
    })


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 2: POST /api/admin/permissions
#
# Called when an admin flips a toggle in the Access Control panel.
# Saves one permission change for one user.
#
# Request body (JSON):
# {
#   "user_email":  "employee@adititracking.com",
#   "permission":  "can_view_ims",
#   "value":       "true"
# }
#
# Response: { "ok": true }
# ══════════════════════════════════════════════════════════════════
@app.route("/api/admin/permissions", methods=["POST"])
def save_user_permission():
    # Check database is connected — return 503 if not
    err = db_check()
    if err:
        return err

    # The frontend sends the admin's email in this header
    caller_email = request.headers.get("X-User-Email", "").strip().lower()

    # Block non-admins — Access Control is MIS-only (see is_access_control_admin)
    if not is_access_control_admin(caller_email):
        return jsonify({"error": "Forbidden — only MIS can change permissions"}), 403

    # Read the request body
    body       = request.get_json() or {}
    user_email = str(body.get("user_email", "")).strip().lower()
    permission = str(body.get("permission", "")).strip()
    value      = str(body.get("value", "")).strip()

    # Validate all three fields are present
    if not user_email or not permission or not value:
        return jsonify({"error": "user_email, permission, and value are all required"}), 400

    # Upsert = insert if this row doesn't exist, update if it does.
    # on_conflict means: if user_email + permission already exists, update the value.
    try:
        sb.table("user_permissions").upsert(
            {
                "user_email": user_email,
                "permission": permission,
                "value":      value,
            },
            on_conflict="user_email,permission"
        ).execute()
    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500

    # Cost Master's REAL security boundary is pricing_admin_users (a Supabase
    # table checked by is_pricing_admin(), which gates RLS on cost_price) —
    # a completely separate table from this permission system. This toggle
    # is the one place that keeps both in sync, using the service-role
    # client (bypasses RLS, same as every other privileged write in this
    # file) so MIS only ever has to flip one switch instead of also running
    # SQL. The user_permissions write above already succeeded by this
    # point; if this second write fails, we deliberately return an error
    # here (not the "ok" below) so MIS knows to retry — silently reporting
    # success while the RLS grant and the UI toggle disagree is exactly the
    # drift this feature exists to prevent.
    if permission == COST_MASTER_PERMISSION_KEY:
        try:
            if value == "true":
                _execute_with_retry(lambda: sb.table("pricing_admin_users")
                    .upsert({"email": user_email}, on_conflict="email")
                    .execute())
            else:
                _execute_with_retry(lambda: sb.table("pricing_admin_users")
                    .delete()
                    .eq("email", user_email)
                    .execute())
        except Exception as e:
            return jsonify({
                "error": ("Permission saved, but syncing Cost Master access failed: "
                          f"{e}. The toggle and actual Cost Master access may now be "
                          "out of sync — please retry.")
            }), 500

    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 3: GET /api/admin/all-users-permissions
#
# Called when admin opens the Access Control panel in the portal.
# Returns every employee + their current merged permissions.
# Also returns the list of all possible permission keys.
#
# Response:
# {
#   "users": [
#     {
#       "name": "Hemant",
#       "email": "mis@adititracking.com",
#       "role": "mis",
#       "permissions": { "can_view_ims": "true", ... }
#     },
#     ...
#   ],
#   "all_permission_keys": ["can_view_ims", "can_view_leads", ...]
# }
# ══════════════════════════════════════════════════════════════════
@app.route("/api/admin/all-users-permissions", methods=["GET"])
def all_users_permissions():
    # Check database is connected — return 503 if not
    err = db_check()
    if err:
        return err

    # Block non-admins — Access Control is MIS-only (see is_access_control_admin)
    caller_email = request.headers.get("X-User-Email", "").strip().lower()
    if not is_access_control_admin(caller_email):
        return jsonify({"error": "Forbidden"}), 403

    # Get all employees from Employee_details
    try:
        emps_res = _execute_with_retry(lambda: sb.table("Employee_details")
            .select("Employee_name, Email_Id, Employee_Dept")
            .execute())
    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500

    # Get all possible permission keys from role_defaults
    # (so the admin panel knows what toggles to show)
    try:
        keys_res = _execute_with_retry(lambda: sb.table("role_defaults").select("permission").execute())
        all_keys = sorted(list({r["permission"] for r in (keys_res.data or [])}))
    except Exception as e:
        print(f"Error fetching permission keys (after retries): {e}")
        all_keys = []

    # Get ALL role defaults in one query (more efficient than one query per user)
    try:
        all_defaults_res = _execute_with_retry(lambda: sb.table("role_defaults")
            .select("role, permission, value")
            .execute())
        # Build a nested dict: defaults_map["mis"]["can_view_ims"] = "true"
        defaults_map = {}
        for row in (all_defaults_res.data or []):
            defaults_map.setdefault(row["role"], {})[row["permission"]] = row["value"]
    except Exception as e:
        print(f"Error fetching all role defaults (after retries): {e}")
        defaults_map = {}

    # Get ALL user overrides in one query
    try:
        all_overrides_res = _execute_with_retry(lambda: sb.table("user_permissions")
            .select("user_email, permission, value")
            .execute())
        # Build a nested dict: overrides_map["email"]["can_view_ims"] = "true"
        overrides_map = {}
        for row in (all_overrides_res.data or []):
            overrides_map.setdefault(row["user_email"], {})[row["permission"]] = row["value"]
    except Exception as e:
        print(f"Error fetching all user overrides (after retries): {e}")
        overrides_map = {}

    # Cost Master toggle display: pricing_admin_users (not user_permissions)
    # is the REAL security boundary — is_pricing_admin() checks this table
    # directly, RLS on cost_price is keyed off it. Reading it fresh here
    # means the panel always shows the toggle matching actual Cost Master
    # access, even for rows inserted by hand before this feature existed
    # (chirag@/mis@/mis1@ etc from the original seed) — no reconciliation
    # migration needed, this makes drift self-correcting on every load.
    try:
        pau_res = _execute_with_retry(lambda: sb.table("pricing_admin_users").select("email").execute())
        pricing_admin_emails = {str(r["email"]).strip().lower() for r in (pau_res.data or [])}
    except Exception as e:
        print(f"Error fetching pricing_admin_users (after retries): {e}")
        # Fail closed on the DISPLAY only: if we can't confirm real membership,
        # show the toggle off rather than risk showing "on" when we don't
        # actually know. The real RLS check (is_pricing_admin()) is unaffected
        # either way — this only controls what the panel renders.
        pricing_admin_emails = set()

    # Build the result — one entry per employee
    result = []
    for emp in (emps_res.data or []):
        email = str(emp.get("Email_Id", "")).strip().lower()
        if not email:
            continue   # skip rows with no email

        raw_role = str(emp.get("Employee_Dept", "")).strip().lower()
        role     = ROLE_MAP.get(raw_role, "employee")

        # Merge: role defaults first, then user overrides on top
        perms = {}
        perms.update(defaults_map.get(role, {}))      # base: role defaults
        perms.update(overrides_map.get(email, {}))    # override: user-specific
        # Cost Master: always overridden by actual pricing_admin_users
        # membership — see comment above. This key is the one exception to
        # "user_permissions is the source of truth" in this endpoint.
        if COST_MASTER_PERMISSION_KEY in all_keys:
            perms[COST_MASTER_PERMISSION_KEY] = "true" if email in pricing_admin_emails else "false"

        result.append({
            "name":        emp.get("Employee_name", ""),
            "email":       email,
            "role":        role,
            "permissions": perms
        })

    return jsonify({
        "users":               result,
        "all_permission_keys": all_keys
    })
    
# ══════════════════════════════════════════════════════════════════
# ENDPOINT 4: GET /api/mapping-data?region=Goa
#
# Returns GPS companies + their current mapping status for a region.
# ══════════════════════════════════════════════════════════════════
@app.route("/api/mapping-data", methods=["GET"])
def get_mapping_data():
    err = db_check()
    if err:
        return err

    region = request.args.get("region", "").strip()
    page_size = 1000

    try:
        all_gps_rows = []
        start = 0
        while True:
            q = sb.table("customer_gps_aliases").select("id,gps_name,region,customer_id")
            if region and region != "All":
                q = q.eq("region", region)
            res = q.order("gps_name").range(start, start + page_size - 1).execute()
            rows = res.data or []
            all_gps_rows.extend(rows)
            if len(rows) < page_size:
                break
            start += page_size

        crm_all = []
        start = 0
        while True:
            res = sb.table("customer_crm").select("company_name,tier,total_vehicles").range(start, start+page_size-1).execute()
            rows = res.data or []
            crm_all.extend(rows)
            if len(rows) < page_size:
                break
            start += page_size
        crm_map = {r["company_name"]: r for r in crm_all}

        master_res = sb.table("customer_master").select("*").execute()
        master_map = {r["customer_id"]: r for r in (master_res.data or [])}

        result = []
        for g in all_gps_rows:
            crm = crm_map.get(g["gps_name"], {})
            master = master_map.get(g["customer_id"], {}) if g["customer_id"] else {}
            result.append({
                "gps_alias_id":  g["id"],
                "gps_name":      g["gps_name"],
                "region":        g["region"],
                "customer_id":   g["customer_id"],
                "canonical_name":master.get("canonical_name", ""),
                "tier":          crm.get("tier", ""),
                "total_vehicles":crm.get("total_vehicles", 0),
                "is_mapped":     g["customer_id"] is not None,
            })

        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 5: GET /api/odoo-search?q=sai ganesh
#
# Search Odoo customer names from customer_odoo_aliases table.
# ══════════════════════════════════════════════════════════════════
@app.route("/api/odoo-search", methods=["GET"])
def odoo_search():
    err = db_check()
    if err:
        return err

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    try:
        res = sb.table("customer_odoo_aliases") \
            .select("id,odoo_name,customer_id") \
            .ilike("odoo_name", f"%{query}%") \
            .order("odoo_name") \
            .limit(25) \
            .execute()
        rows = res.data or []
        # Names jo query se SHURU hote hain unhe top par lao (zyada relevant)
        q_lower = query.lower()
        rows.sort(key=lambda r: 0 if str(r.get("odoo_name","")).lower().startswith(q_lower) else 1)
        return jsonify(rows[:15])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 6: POST /api/save-mapping
#
# Save GPS company → Odoo customer mapping.
# Creates customer_master entry if needed.
# ══════════════════════════════════════════════════════════════════
@app.route("/api/save-mapping", methods=["POST"])
def save_mapping():
    err = db_check()
    if err:
        return err

    caller_email = request.headers.get("X-User-Email", "").strip().lower()
    body = request.get_json() or {}

    gps_alias_id   = body.get("gps_alias_id")
    gps_name       = body.get("gps_name", "").strip()
    odoo_alias_ids = body.get("odoo_alias_ids", [])  # list of odoo alias IDs
    canonical_name = body.get("canonical_name", "").strip()
    tier           = body.get("tier", "").strip()

    if not gps_name or not canonical_name:
        return jsonify({"error": "gps_name and canonical_name required"}), 400

    try:
        # Step 1: customer_master mein insert/update karo
        master_res = sb.table("customer_master").upsert({
            "canonical_name": canonical_name,
            "tier":           tier,
            "mapped_by":      caller_email,
        }, on_conflict="canonical_name").execute()

        customer_id = master_res.data[0]["customer_id"]

        # Step 2: GPS alias ko customer_id se link karo
        sb.table("customer_gps_aliases").update({
            "customer_id": customer_id
        }).eq("id", gps_alias_id).execute()

        # Step 3: Odoo aliases ko customer_id se link karo
        for odoo_id in odoo_alias_ids:
            sb.table("customer_odoo_aliases").update({
                "customer_id": customer_id
            }).eq("id", odoo_id).execute()

        return jsonify({"ok": True, "customer_id": customer_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ══════════════════════════════════════════════════════════════════
# ENDPOINT 7: POST /api/clear-mapping
# Removes customer_id link from GPS alias (clears mapping)
# ══════════════════════════════════════════════════════════════════
@app.route("/api/clear-mapping", methods=["POST"])
def clear_mapping():
    err = db_check()
    if err:
        return err
    body         = request.get_json() or {}
    gps_alias_id = body.get("gps_alias_id")
    if not gps_alias_id:
        return jsonify({"error": "gps_alias_id required"}), 400
    try:
        sb.table("customer_gps_aliases").update({
            "customer_id": None
        }).eq("id", gps_alias_id).execute()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 8: GET /api/field-service/engineer-names
#
# Called by the Field Service "All Entries" tab (field_service_view_all
# users only) to resolve each distinct engineer_id that has actually
# submitted an entry into a display name. Read-only — no schema/RLS
# changes; see _list_all_auth_users / _has_field_service_view_all above.
#
# Response:
# { "engineers": [ { "engineer_id": "...", "email": "...", "name": "..." }, ... ] }
# ══════════════════════════════════════════════════════════════════
@app.route("/api/field-service/engineer-names", methods=["GET"])
def field_service_engineer_names():
    err = db_check()
    if err:
        return err

    caller_email = request.headers.get("X-User-Email", "").strip().lower()
    if not _has_field_service_view_all(caller_email):
        return jsonify({"error": "Forbidden"}), 403

    # Distinct engineers who have actually submitted at least one entry
    try:
        entries_res = sb.table("field_service_entries").select("engineer_id").execute()
        engineer_ids = sorted({r["engineer_id"] for r in (entries_res.data or []) if r.get("engineer_id")})
    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500

    id_to_email = _list_all_auth_users()
    # TEMP DEBUG — remove once engineer-name resolution is confirmed working.
    print(f"[field-service] engineer_ids from entries ({len(engineer_ids)}): {engineer_ids}")
    print(f"[field-service] auth users resolved via admin API: {len(id_to_email)}")
    for _uid in engineer_ids:
        if _uid not in id_to_email:
            print(f"[field-service] WARNING: engineer_id {_uid} has no matching auth.users entry in id_to_email")

    # email -> display name, via the same Employee_details table every
    # other module already uses for this
    email_to_name = {}
    try:
        names_res = sb.table("Employee_details").select("Employee_name, Email_Id").execute()
        for row in (names_res.data or []):
            em = str(row.get("Email_Id", "")).strip().lower()
            if em:
                email_to_name[em] = row.get("Employee_name") or em
    except Exception as e:
        # Was a bare `except Exception: pass` — silently swallowed with no
        # trace of why the Employee_details lookup failed. Now logged.
        print(f"[field-service] Employee_details lookup failed: {e}")

    print(f"[field-service] Employee_details names resolved: {len(email_to_name)}")

    engineers = []
    for uid in engineer_ids:
        email = id_to_email.get(uid)
        name  = (email_to_name.get(email) if email else None) or email or uid
        # TEMP DEBUG — remove once engineer-name resolution is confirmed working.
        if name == uid:
            print(f"[field-service] WARNING: falling back to raw uid for {uid} (resolved_email={email!r})")
        engineers.append({
            "engineer_id": uid,
            "email":       email,
            "name":        name
        })

    return jsonify({"engineers": engineers})


# ══════════════════════════════════════════════════════════════════
# ENDPOINT 9: POST /api/admin/generate-checklist-tasks
#
# Called by the Task Scheduler tab (Task Checklist dashboard, MIS/owner
# only — see js/taskScheduler.js:tsConfirmInsert). The frontend has already
# computed the planned_date list (frequency math + Sunday/holiday shifting)
# and shown it to the MIS user for review in the Preview step — this
# endpoint does NOT recompute or re-validate those dates. Its only two
# jobs are:
#   1. Re-check server-side that the caller is actually MIS/owner. The
#      frontend hiding the tab for other roles is UX only, not security —
#      this is the real gate, same as every other /api/admin/* endpoint.
#   2. Bulk-insert the rows using the service-role key, so the write isn't
#      subject to whatever RLS policy (if any) governs employee_checklists
#      for a normal logged-in user's JWT.
#
# sheet_task_id: existing data proved this column is NOT unique (the same
# value repeats across unrelated rows) and nothing in the app uses it for
# lookups any more (tasks.js keys everything off the real `id` column) — so
# new rows simply mirror their own `id` into sheet_task_id after insert,
# which trivially guarantees uniqueness without inventing a new counter.
#
# One employee + branch is shared across the whole batch; `tasks` is a
# list because a single "Generate" click can create several DIFFERENT
# recurring tasks (each with its own name/frequency/dates) for that one
# person in one shot.
#
# Request body:
# {
#   "emp_id": 4,
#   "branch_id": 1,
#   "tasks": [
#     { "task_name": "Weekly Review Call", "frequency": "W", "planned_dates": ["2026-10-01", "2026-10-08", ...] },
#     { "task_name": "Monthly Report",     "frequency": "M", "planned_dates": ["2026-10-01", "2026-11-01", ...] }
#   ]
# }
#
# Response: { "ok": true, "inserted": 12 }
# ══════════════════════════════════════════════════════════════════
@app.route("/api/admin/generate-checklist-tasks", methods=["POST"])
def generate_checklist_tasks():
    # Check database is connected — return 503 if not
    err = db_check()
    if err:
        return err

    # Block non-admins — the real security boundary (see comment above).
    # Also allow anyone specifically granted can_use_task_scheduler via the
    # Access Control panel (_has_task_scheduler_access), same pattern as
    # Field Service's "view all" override — a role check alone would lock
    # out a non-MIS employee the MIS team explicitly granted this to.
    caller_email = request.headers.get("X-User-Email", "").strip().lower()
    if not (is_admin(caller_email) or _has_task_scheduler_access(caller_email)):
        return jsonify({"error": "Forbidden — only MIS/Managing Director, or someone granted Task Scheduler access, can generate tasks"}), 403

    # Read + validate the request body. The frontend already validated more
    # thoroughly (frequency codes, date math, duplicate warnings) but a
    # server endpoint never trusts the client alone.
    body      = request.get_json() or {}
    emp_id    = body.get("emp_id")
    branch_id = body.get("branch_id")
    tasks     = body.get("tasks") or []

    if not emp_id:
        return jsonify({"error": "emp_id is required"}), 400
    if not isinstance(tasks, list) or not tasks:
        return jsonify({"error": "tasks must be a non-empty list"}), 400

    # Validate every task entry and build one combined row list — each row
    # remembers which task it belongs to (task_name/frequency) so a single
    # bulk insert can cover the whole batch instead of one round-trip per task.
    rows = []
    for i, task in enumerate(tasks):
        task_name     = str((task or {}).get("task_name", "")).strip()
        frequency     = str((task or {}).get("frequency", "")).strip()
        planned_dates = (task or {}).get("planned_dates") or []

        if not task_name or not frequency:
            return jsonify({"error": f"Task #{i + 1}: task_name and frequency are both required"}), 400
        if not isinstance(planned_dates, list) or not planned_dates:
            return jsonify({"error": f"Task #{i + 1} ('{task_name}'): planned_dates must be a non-empty list"}), 400

        rows.extend([{
            "emp_id":           emp_id,
            "branch_id":        branch_id,
            "task_name":        task_name,
            "frequency":        frequency,
            "planned_date":     d,
            "actual_timestamp": None,
            "remarks":          None,
            "ongoing":          None,
            "upload":           None,
        } for d in planned_dates])

    if len(rows) > 1000:
        # Sanity cap — a single "Generate" click should never need more
        # than this many rows across every task combined. Guards against a
        # malformed/runaway request rather than a real use case.
        return jsonify({"error": f"Too many rows in one batch ({len(rows)}, max 1000) — narrow the date ranges"}), 400

    # Step 1: bulk-insert every row (across every task) WITHOUT sheet_task_id
    # first — we need each row's real auto-generated `id` back before we can
    # mirror it. One insert call regardless of how many tasks were in this batch.
    try:
        insert_res = sb.table("employee_checklists").insert(rows).execute()
    except Exception as e:
        return jsonify({"error": f"Database error during insert: {str(e)}"}), 500

    inserted_rows = insert_res.data or []

    # Step 2: mirror each row's own id into sheet_task_id. One bulk upsert
    # (keyed on the primary key `id`) rather than a separate UPDATE per row.
    try:
        mirror_rows = [{"id": r["id"], "sheet_task_id": r["id"]} for r in inserted_rows]
        if mirror_rows:
            sb.table("employee_checklists").upsert(mirror_rows, on_conflict="id").execute()
    except Exception as e:
        # The rows themselves are already inserted at this point — a NULL
        # sheet_task_id is cosmetic only (nothing reads it for lookups any
        # more), so this is reported as a partial success, not a failure.
        return jsonify({
            "ok":       True,
            "inserted": len(inserted_rows),
            "warning":  f"Rows inserted but sheet_task_id mirroring failed: {str(e)}"
        })

    return jsonify({"ok": True, "inserted": len(inserted_rows)})


# ── Health check endpoint ───────────────────────────────────────
# Visit /health in your browser to confirm the server is running.
# Also shows whether the database is connected.
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":   "ok",
        "service":  "Aditi Permissions API",
        "database": "connected" if sb is not None else "NOT connected — check SUPABASE_SERVICE_KEY"
    })


# ── Start the server ────────────────────────────────────────────
# Railway sets a PORT environment variable. We read it.
# Default 5001 is for local testing (5000 is often taken).
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Aditi Permissions API starting on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
