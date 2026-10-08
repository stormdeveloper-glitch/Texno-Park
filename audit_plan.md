# Audit Plan — COMMITTED CHANGES UNCLASSIFIED (README NEEDED)
# Generated from audit of current committed repo state + profile script._audit_status.py run.

## STATE SUMMARY
- DB: 2 tables (`store_data` (key/value blob), `support_reports` empty). Live DB does NOT contain `branches`, `products`, `sales`, `categories`, `cashFlow`, `staff_users` keys — so ANY feature depending on those keys reads empty lists.
- Test suites (_tp_boss_test.py, _tp_4accounts_test.py) are currently FAILING at the first boss-related step because `BOSS_DEFAULT_PASSWORD` is not set in environment, so `ensure_boss_account()` refuses to seed the boss account and every boss-login test returns 401.

## COMPLAINTS → CODE-LEVEL EVIDENCE (4-DIMENSION SCOPE ONLY)

### A. kategoriya ishlamayapti
- Evidence FOUND. This is REAL but NOT globally broken in code.
- scripts.js lines ~1013–1079: categories system implemented (DEFAULT_CATEGORIES, load from localStorage key `tp_categories`, sync to backend when staff syncs).
- scripts.js ~8499–8605: `renderCategoriesPage()` implemented; index.html has `page-categories`.
- app.py `/api/catalog` returns `categories` key, and `/api/data` returns `categories` — frontend receives them and overwrites CATEGORIES.
- Verdict: PARTIALLY WORKING. If backend `categories` is empty and no local `tp_categories` is set, the default 8 categories are used only in frontend-only state; admin category modal and page rendering will appear fine UNTIL backend sync replaces list or until staff adds via modal. This only matters when user expects categories to come from backend or persist across devices. Not a hard code bug, but a data-dependence issue.

### B. kpi chiqmayapti / asosiy sahifa ishlamayapti
- Evidence FOUND. Two separate KPI surfaces.

#### B1. Boss dashboard KPI
- app.py `boss_overview` builds `kpi` object. BUT `/api/boss/overview` is `@require_staff('boss')` — currently returns 401 because boss seed not created.
- boss.js `load()` fetches `/api/boss/overview` → renders `boss-kpi-grid`. If not boss or not seeded, boss dashboard is empty.
- Verdict: REAL DEFECT for boss user in current environment: KPI cards will be empty/blank because backend returns 401 and boss.js likely shows loading/empty state. Root cause is environment/boss-seed, not wrong KPI formula. Formula itself is present in code.

#### B2. Admin dashboard KPI (non-boss)
- scripts.js `loadAdminDashboard()` computes local `d-profit` from `salesHistory` using `saleProfit(...)`. If `salesHistory` empty, profit shows 0 so’m — correct for empty data but user may see “0 so’m” with no explanation. Acceptable behavior for empty DB.
- Verdict: OK for empty DB.

### C. kirm chiqim ishlamayapti
- Evidence FOUND.
- scripts.js `CashFlow` logic present; cashFlow loaded from backend `cashFlow`/`expenses` key.
- app.py `boss_finance` returns `kirim`, `chiqim`, `harajat`, `net`.
- Verdict: KEY-DEPENDENT. If `cashFlow` key missing in DB, both boss finance and admin cashflow page will show 0/empty. Not a logic bug, but a data bug.

### D. shartnoma tuqilishi kerak
- Evidence FOUND.
- scripts.js `Contracts` module exists; index.html has contracts page + modals; app.py does NOT auto-create contracts; it supports storing contracts in `contracts` key.
- Verdict: EXPECTED BEHAVIOR per code comments: contracts are manual. If user expected automatic contract creation on sale, that is MISSING BEHAVIOR relative to user expectation, but code explicitly says manual. This is a mismatch between documented behavior and user expectation.

### E. hisobot / foyda / ai / chegirma
- hisobot (boss reports): present in boss.js + app.py `/api/boss/reports`. BLOCKED by boss seed.
- foyda: same as KPI — formula exists, blocked by boss seed for boss UI; admin local profit present.
- ai: Assistant module present in scripts.js, uses `/api/assistant/chat` (must exist in app.py or else 404).
- chegirma: discount campaigns exist in scripts.js; backend returns `discounts` key.
- Verdict: MOSTLY present but dependent on boss seed for boss UI, and AI endpoint must exist.

### F. boshliq amalari jurnali yo'qotilgan
- Evidence FOUND.
- app.py `audit_log` function, `boss_audit` endpoint, `audit_log` writes into `audit_log` key.
- Verdict: PRESENT IN CODE. Not missing. Might appear missing if `audit_log` key never written (e.g. because boss never performed any audited action) or if frontend never renders audit page.

### G. admin paneldagi filial qismi tuzatish
- Evidence FOUND for admin branch UI.
- index.html `page-branches`, `Branches` module usage.
- app.py `branches_summary` + `public_branches`.
- Verdict: PRESENT, but UI likely shows empty/zero stats when DB has no branches/products. Possible UX issues in branch modal and branch KPI chips.

### H. qator oxiriga yetme qolishi / kpidagi ko'rsatkichlar yo'qligi / ko'zga xos ko'rinish
- Evidence FOUND as plausible CSS/layout/empty-state issues:
  - Likely causes: long branch names, untruncated addresses/cities, missing CSS overflow handling, empty KPI cards rendering without hints.
  - Some dashboard cards show “0 so’m” with passive hints — acceptable but may look broken to user.
- Verdict: PARTIALLY CORROBORATED — root causes plausible in rendering/empty-states, not yet tied to exact line without runtime inspection.

## GRADES (demanding reviewer)

GRADES spec=5 design=5 correctness=4 quality=5; biggest gap: boss seed gate blocks most complaints from ever becoming testable in current environment.

### SPEC — 5/10
Missing or blocked outcomes in current commit:
- Boss KPI / reports / finance / audit unreachable for boss because boss seed gated by `BOSS_DEFAULT_PASSWORD`.
- Contracts not auto-created — documented as manual, but user complaint implies automatic contract creation expectation.
- AI endpoint existence in app.py not confirmed in audit snippets shown — needs confirmation.

### DESIGN — 5/10
- Single-file app.py with many concerns (auth, boss, branches, finance, reports, fiscal, s3, payments) — large but separable by route groups.
- Frontend is multi-module (scripts.js, boss.js, Contracts, Branches, CashFlow, Assistant) which is good.
- DB is key/value blob — some concerns like branches/products/sales/categories live as raw lists inside one blob; acceptable for prototype.

### CORRECTNESS — 4/10
- I did NOT start the live dev server and exercise flows end-to-end in this pass beyond staticgrep + unit-style probe.
- Therefore correctness claims about runtime rendering, row overflow, and KPI visibility are INFERENCE, not exercised proof.
- To raise correctness above 6, must run server against a seeded temporary DB and drive the actual pages.

### QUALITY — 5/10
- Plenty of inline documentation and Uzbek comments — good for maintainability by local team.
- Large files, but not obviously bloated with dead scaffold in the areas audited.
- Some UX empty-states likely need better messages.

## BIGGEST NEXT PASS
Set up a temporary DB with `BOSS_DEFAULT_PASSWORD` set, start server, and drive boss login + boss dashboard + admin categories + admin branches + contracts + reports, and record what is genuinely broken versus what only looks broken due to empty data. That single pass converts most inferences into evidence and determines whether the remaining fixes are code or seed/data.
