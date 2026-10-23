/* ============================================================
   BOSHLIQ BOSHQARUV MODULI (boss.js)
   ============================================================
   Boshliq — loyihaning eng yuqori roli:
       BOSHLIQ > ADMIN > MANAGER > CASHIER

   Bu modul FAQAT `/api/boss/*` endpoint'laridan ma'lumot oladi (ular serverda
   BOSHLIQ ruxsati bilan himoyalangan) va hech qanday demo/namuna qiymat
   yaratmaydi — ma'lumot bo'lmasa 0 yoki bo'sh holat ko'rsatiladi.
   Parol hech qayerda saqlanmaydi: faqat so'rov tanasida yuboriladi.
   ============================================================ */

const Boss = (() => {
    'use strict';

    const state = {
        period: 'all',
        customActive: false,
        staffQuery: '', staffRole: '', staffSort: 'total', staffBranch: '', staffStatus: '',
        productView: 'all', productQuery: '', productCat: '',
        reportBranch: '', reportStaff: '', reportProduct: '', reportCat: '',
        reportFrom: '', reportTo: '',
        salesBranch: '', salesQuery: '', salesFrom: '', salesTo: '',
        financeBranch: '', financeFrom: '', financeTo: '',
        auditQuery: '', auditSource: '',
        activeStaffId: null,
        passSubmitting: false,     // parol modalida takroriy so'rovdan himoya
        passWasGenerated: false,   // parol «Vaqtinchalik parol» tugmasi bilan yaratildi
        generatedStaffPassword: '',// faqat natija oynasi ochiq turganda xotirada
        editingStaffId: null,      // tahrir rejimi (bossStaffModal)
        editingStaffOrig: null,    // tahrir ochilgandagi asl qiymatlar
        staffSaving: false,        // takroriy yuborishdan himoya (dublikat yo'q)
        staffMenuId: null,         // ochiq uch nuqtali menyu (mobil)
        staffMenuBtn: null,
        staffMode: null,           // oxirgi chizilgan rejim: 'card' | 'table'
        mqStaff: null,             // (max-width:768px) MediaQueryList — GC'dan himoya
        roStaff: null,             // ResizeObserver — layout zaxira sinxronizatsiyasi
        cache: {}
    };

    function canManageStaff() {
        return isBoss() || !!(currentUser
            && ['admin', 'manager'].includes(currentUser.role));
    }

    function isAdminStaffView() {
        return !!(currentUser && currentUser.role === 'admin');
    }

    function isManagerStaffView() {
        return !!(currentUser && currentUser.role === 'manager');
    }

    function canManageStaffRow(row) {
        if (!row) return false;
        if (isBoss()) return String(row.role || '').toLowerCase() !== 'boss';
        return isAdminStaffView()
            && ['manager', 'cashier'].includes(String(row.role || '').toLowerCase())
            && !(currentUser && (String(row.id) === String(currentUser.id)
                || row.login === currentUser.login));
    }

    function canViewStaffSales(row) {
        if (isManagerStaffView()) return false;
        return isBoss() || (isAdminStaffView() && !!row
            && ['manager', 'cashier'].includes(String(row.role || '').toLowerCase()));
    }

    /* ── Yordamchilar ───────────────────────────────── */

    async function api(path) {
        if (!staffToken) { showNotif('error', 'Sessiya yo\'q', 'Qayta kiring'); return null; }
        let res;
        try {
            res = await fetch(path, { headers: authHeaders() });
        } catch (e) {
            console.warn('[Boss] Serverga ulanishda xatolik:', e);
            showNotif('error', 'Serverga ulanib bo\'lmadi', 'Internet yoki server holatini tekshiring');
            return null;
        }
        if (res.status === 401) {
            // Sessiya hali yopilmagan bo'lsa — `handleSessionExpired` o'zi
            // "Sessiya tugadi" bildirishnomasini ko'rsatadi va login ekranga
            // qaytaradi. Parallel so'rovlar (dashboard5 ta so'rov bir vaqtda)
            // ketma-ket401 qaytarganda HAR BIRI uchun alohida xabar chiqmasligi
            // uchun qo'shimcha notif faqat sessiya yopilmagan bo'lsa chiqadi.
            const hadSession = !!staffToken;
            if (typeof handleSessionExpired === 'function') handleSessionExpired();
            if (hadSession && staffToken) showNotif('error', 'Sessiya tugadi', 'Qayta kiring');
            return null;
        }
        if (res.status === 403) {
            showNotif('error', 'Ruxsat yo\'q', 'Bu amal uchun huquq yetarli emas');
            return null;
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const msg = body?.message || (
                res.status === 409 ? 'Bu ma\'lumot allaqachon mavjud'
                    : res.status >= 500 ? 'Ma\'lumotni yuklab bo\'lmadi'
                    : 'Ma\'lumotni olib bo\'lmadi');
            showNotif('error', 'Xatolik', msg);
            return null;
        }
        return res.json().catch(() => null);
    }

    /** Bo'sh natija — fake ma'lumot o'rniga aniq holat. */
    function emptyState(text) {
        return `<div class="boss-empty"><i class="fas fa-inbox"></i><p>${escapeHTML(text)}</p></div>`;
    }

    function periodChips() {
        const opts = [['day', 'Kun'], ['7d', '7 kun'], ['30d', '30 kun'],
            ['month', 'Oy'], ['all', 'Umumiy']];
        const active = state.customActive ? '' : state.period;
        return opts.map(([v, l]) => `<button class="boss-chip${active === v ? ' active' : ''}"
            data-boss-period="${v}">${l}</button>`).join('');
    }

    function roleBadge(role) {
        const labels = { boss: 'Boshliq', admin: 'Admin', manager: 'Menejer', cashier: 'Kassa' };
        return `<span class="boss-role role-${escapeHTML(role || '')}">`
            + `${escapeHTML(labels[role] || role || '—')}</span>`;
    }

    function statusBadge(status) {
        const s = String(status || 'active').toLowerCase();
        if (s === 'blocked') return '<span class="boss-badge blocked">Bloklangan</span>';
        if (s === 'inactive') return '<span class="boss-badge inactive">Nofaol</span>';
        return '<span class="boss-badge active">Faol</span>';
    }

    /**
 * Davrni o'zgartiradi (kun / hafta / oy / umumiy).
 * Joriy bo'lim qayta chiziladi — bosh sahifada esa barcha panellar.
 */
function setPeriod(value) {
        state.period = value;
        state.customActive = false;
        ['boss-sales-from', 'boss-sales-to', 'boss-finance-from', 'boss-finance-to',
            'boss-report-from', 'boss-report-to'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        state.salesFrom = state.salesTo = '';
        state.financeFrom = state.financeTo = '';
        state.reportFrom = state.reportTo = '';
        state.cache = {};
        const key = currentBossPage();
        if (key === 'boss') {
            render();
            load();
            return;
        }
        onPageOpen(key);
    }

    /* ── Sahifa ochilishida ──────────────────────────── */

    function onPageOpen(key) {
        // Davr filtrlari har bo'limda bir xil ishlaydi.
        paintPeriodChips();
        document.querySelectorAll('[data-boss-ownpass]').forEach(button => {
            button.hidden = isAdminStaffView() || isManagerStaffView();
        });
        if (key === 'boss') load();
        if (key === 'bossStaff') {
            loadStaff();
            loadBranchOptions();
            const subtitle = document.getElementById('boss-staff-subtitle');
            if (subtitle) subtitle.textContent = isManagerStaffView()
                ? 'Faqat biriktirilgan filialingiz kassirlari ko\'rsatiladi'
                : 'Barcha xodimlar, reytingi va boshqaruvi';
            // Oylik maosh moduli (ilgari alohida «Xodimlar» sahifasida edi)
            // endi shu bo'lim ichida — sahifa har ochilganda qayta chiziladi.
            const salaryModule = document.getElementById('boss-salary-module');
            if (salaryModule) salaryModule.hidden = isAdminStaffView() || isManagerStaffView();
            const salaryHead = document.getElementById('boss-staff-salary-head');
            if (salaryHead) salaryHead.hidden = isAdminStaffView() || isManagerStaffView();
            if (!isAdminStaffView() && !isManagerStaffView()
                && typeof SalaryModule !== 'undefined' && typeof SalaryModule.render === 'function') {
                SalaryModule.render();
            }
        }
        if (key === 'bossStaffSales') {
            // Sahifa har ochilganda — umumiy ko'rinish (chiplar va filtrlar bilan).
            showSalesOverview();
            loadBranchOptions();
            loadStaffSalesOverview();
        }
        if (key === 'bossProducts') loadProducts();
        if (key === 'bossBranches') loadBranches();
        if (key === 'bossFinance') { loadBranchOptions(); loadFinance(); }
        if (key === 'bossReports') { loadBranchOptions(); loadReportOptions(); loadReports(); }
        if (key === 'bossAudit') loadAudit();
    }

    /** Hisobot filtrlaridagi filial/kategoriya variantlarini to'ldiradi. */
    async function loadBranchOptions() {
        const data = await api(isAdminStaffView() || isManagerStaffView()
            ? '/api/branches' : '/api/boss/branches?period=all');
        if (!data) return;
        const ownBranchId = String(currentUser && currentUser.branchId || '');
        const branches = (data.branches || []).filter(branch =>
            !isManagerStaffView() || String(branch.id) === ownBranchId);
        const fill = (id, emptyLabel) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            const current = sel.value;
            sel.innerHTML = `<option value="">${emptyLabel}</option>`
                + branches.map(b => `<option value="${escapeHTML(String(b.id))}"`
                    + ` ${String(b.id) === String(current) ? 'selected' : ''}>`
                    + `${escapeHTML(b.name)}</option>`).join('');
        };
        fill('boss-report-branch', 'Barcha filiallar');
        fill('boss-sales-branch', 'Barcha filiallar');
        fill('boss-finance-branch', 'Barcha filiallar');
        fill('boss-staff-branch', 'Barcha filiallar');
        fill('boss-staff-branch-m', 'Barcha filiallar');
        fill('boss-new-branch', 'Filialsiz');
        if (isManagerStaffView()) {
            const branchSelect = document.getElementById('boss-new-branch');
            if (branchSelect) {
                branchSelect.value = ownBranchId;
                branchSelect.disabled = true;
            }
        }
    }

    /** Hisobot kategoriya filtri variantlarini to'ldiradi. */
    async function loadReportOptions() {
        const data = await api('/api/boss/products?view=all&limit=1');
        if (!data) return;
        const sel = document.getElementById('boss-report-cat');
        if (sel) {
            sel.innerHTML = '<option value="">Barcha kategoriyalar</option>'
                + (data.categories || []).map(c => `<option value="${escapeHTML(c)}">`
                    + `${escapeHTML(c)}</option>`).join('');
        }
    }

    async function load() {
        if (!isBoss()) return;
        const data = await api('/api/boss/overview');
        if (data) { state.cache.overview = data; render(); }
        // Kirishda sidebar'dagi xodimlar badge'i ham haqiqiy sonni ko'rsatsin
        // (faqat Xodimlar sahifasi ochilda yangilanishi avvalgi kamchilik edi).
        const navBadge = document.getElementById('navBossStaffBadge');
        if (navBadge && data && data.kpi) navBadge.textContent = String(data.kpi.staff || 0);
    }

    function render() {
        const overview = state.cache.overview;
        const board = document.getElementById('boss-dashboard');
        if (board) {
            board.innerHTML = overview ? dashboardHtml(overview)
                : '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i>'
                  + ' Ma\'lumot yuklanmoqda...</div>';
        }
        if (!overview) return;
        // Dashboard ichidagi reyting va top mahsulotlar panelini yuklaymiz.
        renderRankingPanel();
        renderTopProductsPanel();
        renderBranchBriefFromCache();
        // REAL diagrammalar: kunlik savdo, to'lov turlari, filiallar.
        renderCharts();
    }

    /** Bosh sahifadagi filiallar qisqachasi (cache'dan, qayta so'rovsiz). */
    async function renderBranchBriefFromCache() {
        const box = document.getElementById('boss-branch-brief');
        if (!box) return;
        const data = await api('/api/boss/branches?period=' + state.period);
        if (data) renderBranchBrief(data.branches || []);
    }

    /**
     * Sahifalardagi bo'sh davr-filtr konteynerlarini to'ldiradi.
     * Har bir bo'limda (xodimlar, mahsulotlar, filiallar, ...) chip'lar
     * ko'rinadi va bir xil `setPeriod` orqali ishlaydi.
     */
    function paintPeriodChips() {
        ['boss-staff-period', 'boss-products-period', 'boss-branches-period',
            'boss-finance-period', 'boss-reports-period', 'boss-sales-period'].forEach(id => {
            const box = document.getElementById(id);
            if (box) box.innerHTML = periodChips();
        });
    }

    function kpiCard(label, value, hint, icon, tone) {
        return `<div class="boss-kpi tone-${tone}">
            <div class="boss-kpi-top"><span class="boss-kpi-label">${escapeHTML(label)}</span>
                <i class="fas ${icon}"></i></div>
            <div class="boss-kpi-value">${escapeHTML(value)}</div>
            <div class="boss-kpi-hint">${hint}</div></div>`;
    }

    function dashboardHtml(data) {
        const k = data.kpi || {};
        const s = data.signals || {};

        const cards = [
            kpiCard('Bugungi savdo', fmt(k.todaySales || 0) + " so'm",
                `<i class="fas fa-receipt"></i> ${k.todayOrders || 0} ta buyurtma · ${k.todayUnits || 0} dona`,
                'fa-cash-register', 'primary'),
            kpiCard('Bugungi buyurtmalar', String(k.todayOrders || 0),
                `<i class="fas fa-box"></i> ${k.todayUnits || 0} ta mahsulot`,
                'fa-receipt', 'info'),
            kpiCard('Umumiy savdo', fmt(k.totalSales || 0) + " so'm",
                `<i class="fas fa-layer-group"></i> ${k.totalOrders || 0} ta chek`,
                'fa-chart-line', 'success'),
            kpiCard('Umumiy foyda', fmt(k.totalProfit || 0) + " so'm",
                '<i class="fas fa-circle-info"></i> Tan narx kiritilmagan bo\'lsa 0',
                'fa-sack-dollar', 'success'),
            kpiCard('Jami mahsulotlar', String(k.products || 0),
                `<i class="fas fa-triangle-exclamation"></i> Kam qolgan: ${k.lowStock || 0} ta`,
                'fa-box', k.lowStock ? 'warning' : 'info'),
            kpiCard('Jami mijozlar', String(k.customers || 0),
                '<i class="fas fa-user-check"></i> Bazadagi ro\'yxat',
                'fa-users', 'info'),
            kpiCard('Jami xodimlar', String(k.staff || 0),
                `<i class="fas fa-user-clock"></i> Faol: ${k.staffActive || 0}`,
                'fa-id-badge', 'primary'),
            kpiCard('Filiallar', String(k.branches || 0),
                `<i class="fas fa-store"></i> Faol: ${k.branchesActive || 0}`,
                'fa-map-location-dot', 'info')
        ].join('');

        return `
        <div class="boss-page-head">
            <div><h2><i class="fas fa-crown"></i> Boshliq Dashboard</h2>
                <p>Butun biznes holati · ${escapeHTML(data.generatedAt || '')}</p></div>
            <div class="boss-period">${periodChips()}</div>
        </div>
        <div class="boss-kpi-grid">${cards}</div>
        <div class="boss-charts-grid">
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-chart-line"></i> Savdo dinamikasi (14 kun)</h3></div>
                <div class="boss-panel-body boss-chart-body"><canvas id="bossDailyChart"></canvas></div>
            </div>
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-chart-pie"></i> To'lov turlari</h3></div>
                <div class="boss-panel-body boss-chart-body"><canvas id="bossPayChart"></canvas></div>
            </div>
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-store"></i> Filiallar bo'yicha savdo</h3></div>
                <div class="boss-panel-body boss-chart-body"><canvas id="bossDashBranchChart"></canvas></div>
            </div>
        </div>
        <div class="boss-grid-2">
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-id-badge"></i> Xodimlar reytingi</h3>
                    <button class="btn btn-outline btn-sm" data-boss-goto="page-bossStaff">Barchasi <i class="fas fa-arrow-right"></i></button></div>
                <div class="boss-panel-body" id="boss-ranking"><i class="fas fa-spinner fa-spin"></i></div>
            </div>
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-fire"></i> Top mahsulotlar</h3>
                    <button class="btn btn-outline btn-sm" data-boss-goto="page-bossProducts">Barchasi <i class="fas fa-arrow-right"></i></button></div>
                <div class="boss-panel-body" id="boss-top-products"><i class="fas fa-spinner fa-spin"></i></div>
            </div>
        </div>
        <div class="boss-grid-2">
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-store"></i> Filiallar holati</h3>
                    <button class="btn btn-outline btn-sm" data-boss-goto="page-bossBranches">Taqqoslash <i class="fas fa-arrow-right"></i></button></div>
                <div class="boss-panel-body" id="boss-branch-brief"><i class="fas fa-spinner fa-spin"></i></div>
            </div>
            <div class="boss-panel">
                <div class="boss-panel-head"><h3><i class="fas fa-bell"></i> Keyingi muhim signal</h3></div>
                <div class="boss-panel-body">${signalsHtml(data)}</div>
            </div>
        </div>
        ${(!s.hasSales || !s.hasProducts) ? `<div class="boss-note"><i class="fas fa-database"></i>
            <div><strong>Bazada ma'lumot yetarli emas.</strong>
            ${!s.hasSales ? ' Hali savdo yozuvi yo\'q — savdo ko\'rsatkichlari 0 bo\'lib ko\'rinadi.' : ''}
            ${!s.hasProducts ? ' Mahsulotlar ro\'yxati bo\'sh.' : ''}
            Ma'lumot kiritilgach ko\'rsatkichlar avtomatik hisoblanadi.</div></div>` : ''}`;
    }

    function signalsHtml(data) {
        const s = data.signals || {};
        const k = data.kpi || {};
        const items = [];
        if (k.lowStock > 0) {
            items.push(['warning', 'fa-triangle-exclamation',
                `<strong>${k.lowStock} ta mahsulot</strong> kam qoldi` +
                (s.lowStockNames && s.lowStockNames.length
                    ? `: ${s.lowStockNames.map(escapeHTML).join(', ')}` : '')]);
        } else {
            items.push(['success', 'fa-circle-check', 'Kam qolgan mahsulotlar <strong>yo\'q</strong>']);
        }
        if (!s.hasSales) items.push(['info', 'fa-receipt', 'Hali savdo yozuvi <strong>yo\'q</strong>']);
        items.push(['info', 'fa-users',
            `<strong>${k.staffActive || 0}/${k.staff || 0}</strong> xodim faol`]);
        if ((k.branchesActive || 0) < (k.branches || 0)) {
            items.push(['warning', 'fa-store',
                `${(k.branches || 0) - (k.branchesActive || 0)} ta filial nofaol`]);
        }
        return '<ul class="boss-signals">' + items.map(([tone, icon, text]) =>
            `<li class="tone-${tone}"><i class="fas ${icon}"></i><span>${text}</span></li>`).join('') + '</ul>';
    }
/* ── 2) Xodimlar: reyting, qidiruv, boshqaruv ───── */

    function staffParams() {
        const p = new URLSearchParams();
        p.set('period', state.period);
        p.set('sort', state.staffSort);
        p.set('limit', '200');
        if (state.staffQuery) p.set('q', state.staffQuery);
        if (state.staffRole) p.set('role', state.staffRole);
        if (state.staffBranch) p.set('branchId', state.staffBranch);
        if (state.staffStatus) p.set('status', state.staffStatus);
        return p.toString();
    }

    /**
     * Yangi xodim qo'shilgach faol qidiruv/filtrlarni tozalaydi — aks holda
     * yangi qator jadvalda ko'rinmay qolishi mumkin edi.
     */
    function clearStaffFilters() {
        state.staffQuery = ''; state.staffRole = '';
        state.staffStatus = ''; state.staffBranch = '';
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        };
        setVal('boss-staff-search', '');
        setVal('boss-staff-search-m', '');
        setVal('boss-staff-role', '');
        setVal('boss-staff-role-m', '');
        setVal('boss-staff-branch', '');
        setVal('boss-staff-branch-m', '');
        setVal('boss-staff-status', '');
        document.querySelectorAll('[data-staff-status]').forEach(p =>
            p.classList.toggle('active', (p.dataset.staffStatus || '') === ''));
    }

    async function loadStaff() {
        if (!canManageStaff()) return;
        const data = await api('/api/boss/staff?' + staffParams());
        if (!data) return;
        state.cache.staff = data;
        renderStaffList();
        const head = document.getElementById('boss-staff-count');
        if (head) head.textContent = `${data.total || 0} ta xodim`;
        // Sidebar'dagi xodimlar badge'i ham shu ma'lumotdan yangilanadi
        // (oldingi versiyada HTMLda doimiy "0" qolgan — hech kim yangilamagan).
        const navBadge = document.getElementById('navBossStaffBadge');
        if (navBadge) navBadge.textContent = String(data.totalAll || data.total
            || (data.staff || []).length || 0);
        // Statistika serverdan kelgan yagona manbadan olinadi. Ilgari
        // "Faol = jami − bloklangan" hisoblanardi — arxivlangan (inactive)
        // xodimlar ham "faol" bo'lib ko'rinardi. Endi uch holat alohida.
        const counts = data.statusCounts || {};
        const totalAll = Number(data.totalAll || 0) || (data.staff || []).length;
        const active = Number(counts.active || 0);
        const blocked = Number(counts.blocked || 0);
        const inactive = Number(counts.inactive || 0);
        setStaffStats(totalAll, active, blocked, inactive);
    }

    /** Joriy ekran turini aniqlaydi: telefonda kartochka, desktopda jadval. */
    function isStaffMobile() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 768px)').matches;
    }

    /** Statistika panelidagi raqamlarni yagona hisob natijasidan to'ldiradi. */
    function setStaffStats(total, active, blocked, inactive) {
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(value);
        };
        set('boss-staff-m-total', total);
        set('boss-staff-m-active', active);
        set('boss-staff-m-blocked', blocked);
        set('boss-staff-m-inactive', inactive);
        set('boss-pill-all', total);
        set('boss-pill-active', active);
        set('boss-pill-blocked', blocked);
        set('boss-pill-inactive', inactive);
    }

    /** Ro'yxatni joriy ekranga ko'ra chizadi (kartochka yoki jadval). */
    function renderStaffList() {
        const data = state.cache.staff || {};
        // Filtrlash SERVERDA bajariladi (qidiruv, rol, filial, holat).
        // Shu sababli bu yerda qo'shimcha "soxta" filtr yo'q — kelgan
        // qatorlar aynan so'ralgan natijadir.
        const rows = data.staff || [];
        const mobile = isStaffMobile();
        state.staffMode = mobile ? 'card' : 'table'; // nima chizilgani eslab qolinadi
        const tableBox = document.getElementById('boss-staff-table');
        const cardBox = document.getElementById('boss-staff-cards');
        if (mobile) {
            if (tableBox) tableBox.innerHTML = '';
            if (cardBox) cardBox.innerHTML = staffCardsHtml(rows);
        } else {
            if (cardBox) cardBox.innerHTML = '';
            if (tableBox) tableBox.innerHTML = staffRowsHtml(rows);
        }
    }

    /**
     * Ko'rinish rejimini real ekranga moslaydi. Faqat rejim HAQIQATAN
     * o'zgarganda qayta chizadi (matchMedia change ham, resize zaxirasi ham
     * shu funksiyanik chaqiradi — ikkalasi birga ishonchli natija beradi).
     */
    function syncStaffMode() {
        const mode = isStaffMobile() ? 'card' : 'table';
        if (state.staffMode === mode) return;
        closeStaffMenu();
        renderStaffList();
    }

    /** Xodimning holatiga mos qisqa izoh (oxirgi faollik / arxiv sanasi). */
    function staffStatusHint(s) {
        const status = String(s.status || 'active').toLowerCase();
        if (status === 'inactive' && s.deletedAt) return 'Arxiv: ' + s.deletedAt;
        return s.lastSeen || s.updatedAt || '—';
    }

    // ── OYLIK MAOSH (belgilangan ish haqi) ────────────────────────
    // Backenddagi `parse_staff_salary` bilan bir xil qoidalar.
    const STAFF_SALARY_MAX = 999999999999;

    /** 4000000 → "4 000 000" (input uchun minglik ajratgich). */
    function formatSalaryInput(value) {
        const digits = String(value == null ? '' : value).replace(/\D/g, '');
        return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    /**
     * Input qiymatini butun so'mga aylantiradi.
     * Qaytaradi: { value } | { empty: true } | { error }.
     */
    function parseSalaryInput(raw) {
        let text = String(raw == null ? '' : raw)
            .replace(/[\s\u00a0\u202f'’‘]/g, '')
            .replace(/so['`ʻ‘’]?m$/i, '');
        if (!text) return { empty: true };
        if (!/^\d+$/.test(text)) {
            return { error: 'Oylik maosh faqat raqamlardan iborat bo\'lishi kerak' };
        }
        const value = Number(text);
        if (!Number.isSafeInteger(value) || value > STAFF_SALARY_MAX) {
            return { error: 'Oylik maosh juda katta' };
        }
        return { value };
    }

    /** Jadval/karta uchun maosh matni. null/yo'q = "Belgilanmagan", 0 — haqiqiy 0. */
    function salaryLabel(value) {
        if (value === null || value === undefined || value === '') return 'Belgilanmagan';
        const num = Number(value);
        if (!Number.isFinite(num)) return 'Belgilanmagan';
        // Jadvalda ham "4 000 000 so'm" ko'rinishi (input bilan bir xil).
        const grouped = String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return grouped + " so'm";
    }

    function salaryHtml(value) {
        const text = salaryLabel(value);
        return text === 'Belgilanmagan'
            ? '<span class="boss-salary-unset">Belgilanmagan</span>'
            : `<strong>${text}</strong>`;
    }

    /**
     * Parol holati katakchasi — FAQAT holat ("o'rnatilgan"/"o'rnatilmagan").
     * Xesh, salt yoki parol qiymati HECH QACHON bu yerga chiqmaydi:
     * server `staff_public_view()` orqali faqat `hasPassword` (mavjudlik)
     * va audit sanasini yuboradi.
     */
    function passStateCellHtml(s) {
        const has = !!s.hasPassword;
        const meta = (has && s.passChangedAt)
            ? `<small class="boss-pass-meta">${escapeHTML(s.passChangedAt)}`
                + `${s.passChangedBy ? ' · ' + escapeHTML(s.passChangedBy) : ''}</small>`
            : '';
        return `<span class="boss-pass-state ${has ? 'set' : 'unset'}"
            title="${has ? 'Parol o\'rnatilgan (serverda xesh sifatida saqlanadi)'
                : 'Parol hali o\'rnatilmagan'}">
            <i class="fas ${has ? 'fa-lock' : 'fa-lock-open'}" aria-hidden="true"></i>
            ${has ? "O'rnatilgan" : "O'rnatilmagan"}</span>${meta}`;
    }

    function staffRowsHtml(rows) {
        const restrictedView = isAdminStaffView() || isManagerStaffView();
        const colSpan = restrictedView ? 10 : 11;
        if (!rows.length) return `<tr><td colspan="${colSpan}">${emptyState('Xodim topilmadi')}</td></tr>`;
        return rows.map(s => {
            const status = String(s.status || 'active').toLowerCase();
            const blocked = status === 'blocked';
            const inactive = status === 'inactive';
            const role = String(s.role || '').toLowerCase();
            const isBossRow = role === 'boss';
            const me = !!(currentUser && (
                String(s.id) === String(currentUser.id)
                || s.login === currentUser.login));
            const canManage = canManageStaffRow(s);
            const canEdit = isBoss()
                ? (!isBossRow || me)
                : canManage;
            const money = Number(s.total || 0);
            return `<tr data-id="${escapeHTML(String(s.id))}">
                <td data-label="№"><span class="boss-rank r${Math.min(3, s.rank || 99)}"
                    title="Xodim ID: ${escapeHTML(String(s.id))}">${s.rank || '—'}</span></td>
                <td data-label="Xodim"><div class="boss-who">
                    <div class="boss-avatar">${escapeHTML((s.name || '?')[0])}</div>
                    <div class="boss-staff-name"><strong title="${escapeHTML(s.name || '')}">${escapeHTML(s.name || '—')}</strong>
                        ${me ? '<span class="boss-me">siz</span>' : ''}
                        <small>ID: ${escapeHTML(String(s.id))}</small></div></div></td>
                <td data-label="Login (telefon)"><div class="boss-login-cell boss-login-wrap">
                    <code title="${escapeHTML(s.phone || '')}">${escapeHTML(s.phone || '—')}</code>
                    ${s.phone ? `<button type="button" class="boss-icon-btn" data-boss-copy="${escapeHTML(s.phone)}"
                        title="Telefon/login nusxalash" aria-label="Telefon/login nusxalash"><i class="fas fa-copy"></i></button>` : ''}
                    ${s.login && s.login !== s.phone ? `<small class="boss-login-id">ID: ${escapeHTML(s.login)}</small>` : ''}
                    ${s.phoneChangedAt ? `<i class="fas fa-pen-to-square boss-phone-changed"
                        title="Login o'zgartirilgan${s.phoneChangedBy ? ': ' + escapeHTML(s.phoneChangedBy) : ''} · ${escapeHTML(s.phoneChangedAt)}${s.phonePrev ? ' (eski: ' + escapeHTML(s.phonePrev) + ')' : ''}"></i>` : ''}
                </div></td>
                <td data-label="Rol">${roleBadge(s.role)}</td>
                <td data-label="Filial"><span class="boss-branch-name" title="${escapeHTML(s.branchName || '')}">${escapeHTML(s.branchName || '—')}</span></td>
                <td data-label="Sotuvlar"><strong>${Number(s.sales || 0)}</strong> ta
                    <small>${Number(s.units || 0)} dona</small></td>
                <td data-label="Savdo summasi"><strong class="boss-money"
                    title="${fmt(money)} so'm">${fmt(money)}</strong> so'm
                    <small>o'rtacha: ${fmt(s.avgCheck || 0)}</small></td>
                ${restrictedView ? '' : `<td data-label="Oylik maosh">${salaryHtml(s.salary)}</td>`}
                <td data-label="Holat">${statusBadge(s.status)}
                    <small>${escapeHTML(staffStatusHint(s))}</small></td>
                <td data-label="Parol">${passStateCellHtml(s)}</td>
                <td data-label="Amallar" class="boss-actions-cell">
                    <div class="boss-actions-group" role="group"
                        aria-label="${escapeHTML(s.name || 'Xodim')} amallari">
                    ${canEdit ? `<button type="button" class="boss-action-btn"
                        data-boss-edit="${escapeHTML(String(s.id))}"
                        title="Tahrirlash" aria-label="Tahrirlash: ${escapeHTML(s.name || '')}">
                        <i class="fas fa-pen-to-square" aria-hidden="true"></i></button>` : ''}
                    ${canViewStaffSales(s)
                    ? `<button type="button" class="boss-action-btn" data-boss-sale="${escapeHTML(String(s.id))}"
                        title="Savdo statistikasi" aria-label="Savdo statistikasi: ${escapeHTML(s.name || '')}">
                        <i class="fas fa-chart-line" aria-hidden="true"></i></button>` : ''}
                    ${!isBossRow ? (me && !isAdminStaffView() && !isManagerStaffView() ? `<button type="button" class="boss-action-btn" data-boss-ownpass=""
                        title="O'z parolimni o'zgartirish" aria-label="O'z parolimni o'zgartirish">
                        <i class="fas fa-key" aria-hidden="true"></i></button>`
                        : canManage ? `<button type="button" class="boss-action-btn" data-boss-pass="${escapeHTML(String(s.id))}"
                        title="${s.hasPassword ? "Parolni almashtirish (parol o'rnatilgan)"
                            : "Parol o'rnatish (parol hali o'rnatilmagan)"}"
                        aria-label="Parolni boshqarish: ${escapeHTML(s.name || '')}">
                        <i class="fas fa-key" aria-hidden="true"></i></button>` : '') : ''}
                    ${canManage ? `<button type="button" class="boss-action-btn ${blocked ? 'ok' : inactive ? 'ok' : 'warn'}"
                        data-boss-block="${escapeHTML(String(s.id))}"
                        title="${blocked ? 'Blokdan chiqarish' : inactive ? 'Faollashtirish' : 'Bloklash'}"
                        aria-label="${blocked ? 'Blokdan chiqarish' : inactive ? 'Faollashtirish' : 'Bloklash'}: ${escapeHTML(s.name || '')}">
                        <i class="fas ${blocked ? 'fa-unlock' : inactive ? 'fa-rotate-left' : 'fa-ban'}" aria-hidden="true"></i></button>` : ''}
                    ${canManage ? `<button type="button" class="boss-action-btn danger"
                        data-boss-del="${escapeHTML(String(s.id))}"
                        title="Arxivlash (savdo tarixi saqlanadi)"
                        aria-label="Arxivlash: ${escapeHTML(s.name || '')}">
                        <i class="fas fa-box-archive" aria-hidden="true"></i></button>` : ''}
                    </div>
                </td></tr>`;
        }).join('');
    }

    /**
     * MOBIL kartochka (faqat ≤768px): avatar, ism, rol, telefon, filial,
     * holat, uch nuqtali menyu va «Batafsil». Ma'lumotlar — shu jadval
     * qatorlaridagi HAQIQIY qiymatlar (qayta hisoblanmaydi, yangi so'rov yo'q).
     */
    function staffCardsHtml(rows) {
        if (!rows.length) {
            return `<div class="boss-empty"><i class="fas fa-user-slash"></i>`
                + `<p>Xodim topilmadi</p></div>`;
        }
        return rows.map(s => {
            const status = String(s.status || 'active').toLowerCase();
            const blocked = status === 'blocked';
            const inactive = status === 'inactive';
            const role = String(s.role || '').trim().toLowerCase();
            const me = !!(currentUser && (String(s.id) === String(currentUser.id)
                || s.login === currentUser.login));
            const canEdit = isBoss()
                ? !(role === 'boss' && !me)
                : canManageStaffRow(s);
            const initial = escapeHTML(((s.name || '?').trim())[0] || '?');
            return `<article class="bsc" data-id="${escapeHTML(String(s.id))}">
                <div class="bsc-top">
                    <div class="bsc-avatar tone-${escapeHTML(role || 'other')}">${initial}</div>
                    <div class="bsc-id">
                        <div class="bsc-name">
                            <span class="bsc-name-txt" title="${escapeHTML(s.name || '')}">${escapeHTML(s.name || '—')}</span>
                            ${me ? '<span class="boss-me">siz</span>' : ''}
                            ${roleBadge(s.role)}
                        </div>
                    </div>
                    ${canEdit ? `<button type="button" class="bsc-edit-btn" data-boss-edit="${escapeHTML(String(s.id))}"
                        aria-label="Tahrirlash: ${escapeHTML(s.name || '')}" title="Tahrirlash"><i class="fas fa-pen" aria-hidden="true"></i></button>` : ''}
                    ${isManagerStaffView() ? '' : `<button type="button" class="bsc-menu-btn" data-boss-menu="${escapeHTML(String(s.id))}"
                        aria-haspopup="menu" aria-expanded="false" aria-label="Boshqaruv menyusi">
                        <i class="fas fa-ellipsis-vertical"></i></button>`}
                </div>
                <div class="bsc-rows">
                    <div class="bsc-row"><i class="fas fa-phone"></i><span>${escapeHTML(s.phone || '—')}</span></div>
                    <div class="bsc-row"><i class="fas fa-store"></i><span>${escapeHTML(s.branchName || '—')}</span></div>
                    ${isAdminStaffView() || isManagerStaffView() ? '' : `<div class="bsc-row"><i class="fas fa-money-bill-wave"></i><span>${escapeHTML(salaryLabel(s.salary))}</span></div>`}
                    <div class="bsc-row bsc-row-pass ${s.hasPassword ? 'set' : 'unset'}">
                        <i class="fas ${s.hasPassword ? 'fa-lock' : 'fa-lock-open'}"></i>
                        <span>Parol ${s.hasPassword ? "o'rnatilgan" : "o'rnatilmagan"}</span></div>
                </div>
                <div class="bsc-metrics">
                    <span><strong>${Number(s.sales || 0)}</strong> savdo · ${Number(s.units || 0)} dona</span>
                    <span class="bsc-money" title="${fmt(s.total || 0)} so'm">${fmt(s.total || 0)} so'm</span>
                    <small>o'rtacha chek: ${fmt(s.avgCheck || 0)} so'm</small>
                </div>
                <div class="bsc-foot">
                    <span class="bsc-status ${blocked ? 'blocked' : inactive ? 'inactive' : 'active'}"><i class="fas fa-circle"></i>${blocked ? 'Bloklangan' : inactive ? 'Nofaol' : 'Faol'}</span>
                    ${canViewStaffSales(s)
                    ? `<button type="button" class="bsc-detail" data-boss-sale="${escapeHTML(String(s.id))}">Batafsil <i class="fas fa-chevron-right"></i></button>` : ''}
                </div>
            </article>`;
        }).join('');
    }

    /**
     * «Batafsil» sarlavhasidagi shaxsiy blok — MOBIL uchun (desktop'da yashirin).
     * identifikator maydonlari keshdan, savdo raqamlari esa allaqachon
     * ochilgan savdo javobidan olinadi — qo'shimcha API so'rovi YO'Q.
     */
    function staffProfileHtml(p) {
        if (!p || !p.name) return '';
        const role = String(p.role || '').trim().toLowerCase();
        const initial = escapeHTML(((p.name || '?').trim())[0] || '?');
        const showLogin = p.login && p.login !== p.phone;
        const field = (label, value) => `<div><span>${label}</span><strong>${escapeHTML(value || '—')}</strong></div>`;
        return `<div class="boss-staff-profile">
            <div class="bsp-top">
                <div class="bsc-avatar tone-${escapeHTML(role || 'other')}">${initial}</div>
                <div class="bsp-id">
                    <div class="bsp-name">${escapeHTML(p.name)}</div>
                    <div class="bsp-badges">${roleBadge(p.role)}${statusBadge(p.status)}</div>
                </div>
            </div>
            <div class="boss-detail-grid">
                ${field('Telefon', p.phone)}
                ${showLogin ? field('Login identifikatori', p.login) : ''}
                ${field('Filial', p.branchName)}
                ${isAdminStaffView() ? '' : field('Oylik maosh', salaryLabel(p.salary))}
                ${field('Ro\'yxatdan o\'tgan', p.createdAt)}
                ${field('Oxirgi faollik', p.lastSeen || p.updatedAt)}
            </div>
        </div>`;
    }

    /** Joriy kesh bo'yicha xodimlar ro'yxatini qayta chizadi (sahifa almashmasdan). */
    function rerenderStaffTable() {
        renderStaffList();
    }

    /** Boshliq dashboardidagi qisqa reyting. */
    async function renderRankingPanel() {
        const box = document.getElementById('boss-ranking');
        if (!box) return;
        const data = await api('/api/boss/staff?period=' + state.period + '&sort=total&limit=5');
        if (!data) { box.innerHTML = emptyState('Reytingni olib bo\'lmadi'); return; }
        const rows = (data.staff || []).filter(s => (s.sales || 0) > 0 || (s.total || 0) > 0);
        if (!rows.length) { box.innerHTML = emptyState('Hali savdo yozuvi yo\'q'); return; }
        const max = Math.max(...rows.map(r => r.total || 0), 1);
        box.innerHTML = rows.map((s, i) => `<div class="boss-rank-row">
            <span class="boss-rank r${i + 1}">${i + 1}</span>
            <div class="boss-rank-main">
                <div class="boss-rank-top"><strong>${escapeHTML(s.name)}</strong>
                    ${roleBadge(s.role)}
                    <span class="boss-rank-val">${fmt(s.total || 0)} so'm</span></div>
                <div class="boss-bar"><div class="boss-bar-fill"
                    style="width:${Math.round((s.total || 0) / max * 100)}%"></div></div>
                <small>${s.sales || 0} ta savdo · ${s.units || 0} dona ·
                    o'rtacha ${fmt(s.avgCheck || 0)} so'm</small>
            </div></div>`).join('');
    }

    /** Boshliq dashboardidagi top mahsulotlar. */
    async function renderTopProductsPanel() {
        const box = document.getElementById('boss-top-products');
        if (!box) return;
        const data = await api('/api/boss/products?period=' + state.period
            + '&view=top&limit=5');
        if (!data) { box.innerHTML = emptyState('Mahsulotlarni olib bo\'lmadi'); return; }
        const rows = (data.products || []).filter(r => (r.soldUnits || 0) > 0);
        if (!rows.length) { box.innerHTML = emptyState('Bu davrda sotilgan mahsulot yo\'q'); return; }
        const max = Math.max(...rows.map(r => r.soldAmount || 0), 1);
        box.innerHTML = rows.map((p, i) => `<div class="boss-rank-row">
            <span class="boss-rank r${i + 1}">${i + 1}</span>
            <div class="boss-rank-main">
                <div class="boss-rank-top"><strong>${escapeHTML(p.name || 'Mahsulot')}</strong>
                    <span class="boss-rank-val">${fmt(p.soldAmount || 0)} so'm</span></div>
                <div class="boss-bar"><div class="boss-bar-fill"
                    style="width:${Math.round((p.soldAmount || 0) / max * 100)}%"></div></div>
                <small>${p.soldUnits || 0} dona · ${escapeHTML(p.cat || 'Kategoriya yo\'q')}</small>
            </div></div>`).join('');
    }

    /* ── 2b) Diagrammalar (Chart.js, REAL agregatsiya) ──────── */

    const chartStore = {};

    function cssVar(name, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }

    /** Katta summalarni ixcham ko'rsatish (oson o'qish uchun). */
    function shortNum(v) {
        const n = Number(v) || 0;
        const a = Math.abs(n);
        if (a >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' mlrd';
        if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' mln';
        if (a >= 1e3) return Math.round(n / 1e3) + " ming";
        return String(n);
    }

    /** Eski diagrammani yiqitadi (qayta chizishda takrorlanmasin). */
    function killChart(id) {
        const old = chartStore[id];
        if (old && typeof old.destroy === 'function') { try { old.destroy(); } catch (e) { } }
        delete chartStore[id];
    }

    /**
     * Faqat KO'rinib turgan canvas bilan ishlaydi — yashirin sahifadagi
     * canvas'ga chizish Chart.js da nol o'lcham muammosini beradi.
     */
    function visibleCanvas(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return null;
        killChart(id);
        return el;
    }

    /** Umumiy diagramma sozlamalari (dizayn tizimidagi ranglar bilan). */
    function chartOpts(withScales, money) {
        const muted = cssVar('--text-muted', '#8b8f98');
        const border = cssVar('--border', 'rgba(255,255,255,.08)');
        const opts = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: muted, boxWidth: 12, font: { size: 11 } } },
                tooltip: {
                    callbacks: money ? { label: ctx => ' ' + fmt(ctx.parsed.y ?? ctx.parsed) + " so'm" } : {}
                }
            }
        };
        if (withScales) {
            opts.scales = {
                x: { ticks: { color: muted, font: { size: 10 } }, grid: { color: border } },
                y: { ticks: { color: muted, font: { size: 10 }, callback: shortNum },
                     grid: { color: border } }
            };
        }
        return opts;
    }

    /** Diagrammani xavfsiz chizadi (xatolik butun sahifani buzmaydi). */
    function makeChart(id, cfg) {
        const el = visibleCanvas(id);
        if (!el || typeof Chart === 'undefined') return;
        try { chartStore[id] = new Chart(el.getContext('2d'), cfg); }
        catch (e) { console.warn('[Boss] Chart chizilmadi (' + id + '):', e); }
    }

    /**
     * `/api/boss/charts` javobidagi qatorlarni chizadi.
     * Qaysi canvas DOM'da va ko'rinayotgan bo'lsa — o'sha chiziladi
     * (dashboard va moliya sahifalari bitta funksiyadan foydalanadi).
     */
    function paintCharts(data) {
        if (!data || typeof Chart === 'undefined') return;
        const primary = cssVar('--primary', '#c81e3a');
        const success = cssVar('--success', '#16a34a');
        const warning = cssVar('--warning', '#f59e0b');
        const info = cssVar('--info', '#3b82f6');

        const daily = data.daily || [];
        if (daily.length) {
            makeChart('bossDailyChart', {
                type: 'line',
                data: {
                    labels: daily.map(d => d.label),
                    datasets: [{
                        label: "Savdo (so'm)",
                        data: daily.map(d => d.revenue),
                        borderColor: primary,
                        backgroundColor: 'rgba(200,30,58,.14)',
                        fill: true, tension: .35,
                        pointRadius: 3, pointBackgroundColor: primary
                    }]
                },
                options: chartOpts(true, true)
            });
        }

        const pay = data.payments || {};
        const payLabels = pay.labels || [];
        if (payLabels.length) {
            const palette = [primary, info, success, warning, '#A78BFA', '#34D399'];
            makeChart('bossPayChart', {
                type: 'doughnut',
                data: {
                    labels: payLabels,
                    datasets: [{
                        data: pay.amounts || [],
                        backgroundColor: payLabels.map((_, i) => palette[i % palette.length]),
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '62%',
                    plugins: {
                        legend: { position: 'bottom',
                            labels: { color: cssVar('--text-muted', '#8b8f98'),
                                boxWidth: 12, font: { size: 11 } } },
                        tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.parsed) + " so'm" } }
                    }
                }
            });
        } else { killChart('bossPayChart'); }

        const br = data.branchSales || {};
        const brLabels = br.labels || [];
        if (brLabels.length) {
            makeChart('bossDashBranchChart', {
                type: 'bar',
                data: {
                    labels: brLabels,
                    datasets: [{
                        label: "Savdo (so'm)",
                        data: br.values || [],
                        backgroundColor: primary, borderRadius: 6, maxBarThickness: 34
                    }]
                },
                options: chartOpts(true, true)
            });
        } else { killChart('bossDashBranchChart'); }

        // Moliya sahifasi diagrammalari (faqat o'sha sahifada ko'rinadi).
        const flow = data.flow || {};
        if ((flow.labels || []).length) {
            makeChart('bossFlowChart', {
                type: 'bar',
                data: {
                    labels: flow.labels || [],
                    datasets: [
                        { label: 'Kirim', data: flow.kirim || [], backgroundColor: success, borderRadius: 5 },
                        { label: 'Chiqim', data: flow.chiqim || [], backgroundColor: warning, borderRadius: 5 }
                    ]
                },
                options: chartOpts(true, true)
            });
        }

        const monthly = data.monthly || [];
        if (monthly.length) {
            makeChart('bossMonthlyChart', {
                type: 'line',
                data: {
                    labels: monthly.map(m => m.label),
                    datasets: [
                        { label: 'Savdo', data: monthly.map(m => m.revenue),
                          borderColor: primary, backgroundColor: 'rgba(200,30,58,.12)',
                          fill: true, tension: .35 },
                        { label: 'Foyda', data: monthly.map(m => m.profit),
                          borderColor: success, backgroundColor: 'rgba(22,163,74,.12)',
                          fill: true, tension: .35 }
                    ]
                },
                options: chartOpts(true, true)
            });
        }
    }

    /** Dashboard diagrammalari — davr chip'i bilan. */
    async function renderCharts() {
        const data = await api('/api/boss/charts?period=' + encodeURIComponent(state.period));
        if (data) { state.cache.charts = data; paintCharts(data); }
    }

    /* ── 3) Xodim savdosi (kim nima sotgani) ─── */

    /** Savdo sahifasi filtrlari: davr + custom sana + filial + qidiruv. */
    function salesParams() {
        const p = new URLSearchParams();
        p.set('period', state.period);
        p.set('sort', 'total');
        p.set('limit', '200');
        if (state.salesFrom) p.set('from', state.salesFrom);
        if (state.salesTo) p.set('to', state.salesTo);
        if (state.salesBranch) p.set('branchId', state.salesBranch);
        if (state.salesQuery) p.set('q', state.salesQuery);
        return p.toString();
    }

    /** Umumiy ko'rinishni ko'rsatadi (ro'yxat). */
    function showSalesOverview() {
        state.activeStaffId = null;
        const ov = document.getElementById('boss-sales-overview');
        const dt = document.getElementById('boss-sales-detail');
        if (ov) ov.style.display = '';
        if (dt) dt.style.display = 'none';
    }

    /** Bitta xodimning savdo tafsilotlarini ko'rsatadi. */
    function showSalesDetail(staffId) {
        state.activeStaffId = staffId;
        const ov = document.getElementById('boss-sales-overview');
        const dt = document.getElementById('boss-sales-detail');
        if (ov) ov.style.display = 'none';
        if (dt) dt.style.display = '';
        const row = findStaffAnywhere(staffId);
        const title = document.getElementById('boss-sales-title');
        if (title && row && row.name) title.textContent = row.name + ' — savdolari';
    }

    /**
     * Xodim savdosi umumiy ko'rinishi: kim qancha sotgan (real savdodan).
     * Filtr: chip'dagi davr, sanalar, filial, ism qidiruvi.
     */
    async function loadStaffSalesOverview() {
        if (!canManageStaff()) return;
        const box = document.getElementById('boss-sales-overview');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i>'
            + ' Savdo ma\'lumotlari yuklanmoqda...</div>';
        const data = await api('/api/boss/staff?' + salesParams());
        if (!data) { box.innerHTML = emptyState("Ma'lumotni olib bo'lmadi"); return; }
        state.cache.salesOverview = data;
        const rows = data.staff || [];
        box.innerHTML = `<div class="boss-panel">
            <div class="boss-panel-head">
                <h3><i class="fas fa-ranking-star"></i> Xodimlar savdosi</h3>
                <span class="boss-count">${data.total || 0} ta xodim</span>
            </div>
            <div class="table-wrap"><table class="boss-table">
            <thead><tr><th>#</th><th>Xodim</th><th>Rol</th><th>Filial</th>
                <th>Savdolar</th><th>Sotilgan dona</th><th>Savdo summasi</th>
                <th>O'rtacha chek</th><th>Amallar</th></tr></thead>
            <tbody>${rows.length ? rows.map(s => `<tr>
                <td data-label="Reyting"><span class="boss-rank r${Math.min(3, s.rank || 99)}">${s.rank || '—'}</span></td>
                <td data-label="Xodim"><div class="boss-who">
                    <div class="boss-avatar">${escapeHTML((s.name || '?')[0])}</div>
                    <div><strong>${escapeHTML(s.name)}</strong>
                        <small>${escapeHTML(s.login || '')}</small></div></div></td>
                <td data-label="Rol">${roleBadge(s.role)}</td>
                <td data-label="Filial">${escapeHTML(s.branchName || '—')}</td>
                <td data-label="Savdolar"><strong>${s.sales || 0}</strong> ta</td>
                <td data-label="Dona">${s.units || 0}</td>
                <td data-label="Summa"><strong>${fmt(s.total || 0)}</strong> so'm</td>
                <td data-label="O'rtacha">${fmt(s.avgCheck || 0)} so'm</td>
                <td data-label="Amallar" class="boss-actions">
                    ${canViewStaffSales(s)
                    ? `<button class="btn btn-outline btn-sm"
                        data-boss-sale="${escapeHTML(String(s.id))}">Cheklari</button>` : ''}
                </td></tr>`).join('')
                : `<tr><td colspan="9">${emptyState('Xodim topilmadi')}</td></tr>`}
            </tbody></table></div></div>`;
    }

    async function loadStaffSales(staffId) {
        const target = findStaffAnywhere(staffId);
        if (!canViewStaffSales(target)) {
            showNotif('error', 'Ruxsat yo\'q', isManagerStaffView()
                ? 'Menejer xodimlar savdosi tafsilotlarini ko\'ra olmaydi'
                : 'Bu xodimning savdo tafsilotlarini ko\'rish mumkin emas');
            return;
        }
        state.activeStaffId = staffId;
        const box = document.getElementById('boss-sales-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const p = new URLSearchParams();
        p.set('period', state.period);
        p.set('limit', '200');
        if (state.salesFrom) p.set('from', state.salesFrom);
        if (state.salesTo) p.set('to', state.salesTo);
        if (state.salesBranch) p.set('branchId', state.salesBranch);
        const data = await api(`/api/boss/staff/${encodeURIComponent(staffId)}/sales`
            + `?` + p.toString());
        if (!data) { box.innerHTML = emptyState('Savdo ma\'lumotini olib bo\'lmadi'); return; }
        const s = data.staff || {};
        const receipts = data.receipts || [];
        // Modal ochilganda shu cheklar ko'rsatiladi (qayta so'rovsiz).
        state.cache.lastReceipts = receipts;
        state.cache.lastReceiptsStaff = s.name || '';
        const title = document.getElementById('boss-sales-title');
        if (title && s.name) title.textContent = `${s.name} — savdolari`;
        // «Batafsil» uchun shaxsiy blok (mobil CSS bilan — desktop ko'rinishi
        // o'zgarmaydi). Yangi so'rov yo'q: identifikator keshdan, savdo — shu javobdan.
        const cachedRow = findStaffAnywhere(staffId);
        const profile = Object.assign({}, cachedRow || {}, s);
        box.innerHTML = staffProfileHtml(profile) + `
            <div class="boss-sales-kpis">
                <div><span>Savdo soni</span><strong>${s.sales || 0}</strong></div>
                <div><span>Sotilgan dona</span><strong>${s.units || 0}</strong></div>
                <div><span>Savdo summasi</span><strong>${fmt(s.total || 0)} so'm</strong></div>
                <div><span>O'rtacha chek</span><strong>${fmt(s.avgCheck || 0)} so'm</strong></div>
            </div>
            ${receipts.length ? receipts.map(r => `<div class="boss-receipt">
                <div class="boss-receipt-head">
                    <span class="boss-chek">#${escapeHTML(String(r.saleId))}</span>
                    <span>${escapeHTML(r.date)} ${escapeHTML(r.time)}</span>
                    ${r.branchName ? `<span class="boss-chip-mini">${escapeHTML(r.branchName)}</span>` : ''}
                    <span class="boss-pay">${escapeHTML(r.pay || '')}</span>
                    <button class="btn btn-outline btn-sm" data-boss-receipt="${escapeHTML(String(r.saleId))}">
                        <i class="fas fa-file-lines"></i> To'liq</button>
                    <strong>${fmt(r.total)} so'm</strong>
                </div>
                <div class="boss-lines"><table><thead><tr>
                    <th>Mahsulot</th><th>Soni</th><th>Narxi</th><th>Jami</th>
                </tr></thead><tbody>
                ${(r.items || []).map(i => `<tr>
                    <td data-label="Mahsulot">${escapeHTML(i.name)}</td><td data-label="Soni">${i.qty}</td>
                    <td data-label="Narxi">${fmt(i.price)} so'm</td><td data-label="Jami">${fmt(i.total)} so'm</td></tr>`).join('')}
                </tbody></table></div></div>`).join('')
                : emptyState('Bu davrda savdo yozuvi yo\'q')}`;
    }
/* ── 4) Mahsulotlar, top mahsulotlar, kam qoldiq ─── */

    async function loadProducts() {
        const box = document.getElementById('boss-products-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const p = new URLSearchParams();
        p.set('period', state.period);
        p.set('view', state.productView);
        p.set('limit', '200');
        if (state.productQuery) p.set('q', state.productQuery);
        if (state.productCat) p.set('cat', state.productCat);
        const data = await api('/api/boss/products?' + p.toString());
        if (!data) { box.innerHTML = emptyState('Mahsulotlarni olib bo\'lmadi'); return; }
        // Modal uchun oxirgi ro'yxatni saqlaymiz (qayta so'rovsiz ochiladi).
        state.cache.productsData = data;
        renderProductsPage(data);
    }

    function renderProductsPage(data) {
        const rows = data.products || [];
        const catSel = document.getElementById('boss-product-cat');
        if (catSel) {
            catSel.innerHTML = '<option value="">Barcha kategoriyalar</option>'
                + (data.categories || []).map(c => `<option value="${escapeHTML(c)}"
                    ${state.productCat === c ? 'selected' : ''}>${escapeHTML(c)}</option>`).join('');
        }
        const view = data.view || 'all';
        const count = document.getElementById('boss-products-count');
        if (count) count.textContent = `${data.total || 0} ta`;
        const box = document.getElementById('boss-products-box');
        if (!rows.length) {
            box.innerHTML = emptyState(view === 'low' ? 'Kam qolgan mahsulot yo\'q'
                : view === 'top' ? 'Bu davrda sotilgan mahsulot yo\'q' : 'Mahsulot topilmadi');
            return;
        }
        box.innerHTML = `<div class="boss-cards">${rows.map((r, i) => `<div class="boss-card"
            data-boss-product="${i}" role="button" tabindex="0"
            aria-label="${escapeHTML(r.name)} tafsiloti">
            <div class="boss-card-head"><strong>${escapeHTML(r.name)}</strong>
                ${view === 'low' ? `<span class="boss-badge ${r.stock <= 0 ? 'blocked' : 'warn'}">
                    Qoldiq: ${r.stock}</span>` : `<span class="boss-rank r${Math.min(3, i + 1)}">${i + 1}</span>`}
            </div>
            <div class="boss-card-meta">
                <span><i class="fas fa-tag"></i> ${escapeHTML(r.cat || '—')}</span>
                ${r.brand ? `<span><i class="fas fa-industry"></i> ${escapeHTML(r.brand)}</span>` : ''}
                ${r.branchName ? `<span><i class="fas fa-store"></i> ${escapeHTML(r.branchName)}</span>` : ''}
            </div>
            <div class="boss-card-stats">
                <div><span>Narxi</span><strong>${fmt(r.price)} so'm</strong></div>
                <div><span>Qoldiq</span><strong>${r.stock}</strong></div>
                <div><span>Sotilgan</span><strong>${r.soldUnits}</strong></div>
                <div><span>Tushum</span><strong>${fmt(r.soldAmount)} so'm</strong></div>
            </div>
            ${(r.soldBy || []).length ? `<div class="boss-card-foot">
                <i class="fas fa-user-tie"></i> ${r.soldBy.slice(0, 4).map(x =>
                    `${escapeHTML(x.staff)} (${x.units})`).join(', ')}</div>` : ''}
        </div>`).join('')}</div>`;
    }

/* ── 5) Filiallar solishtirish ────────────────────── */

    async function loadBranches() {
        const box = document.getElementById('boss-branches-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const data = await api('/api/boss/branches?period=' + state.period);
        if (!data) { box.innerHTML = emptyState('Filiallarni olib bo\'lmadi'); return; }
        // Filial modali uchun oxirgi ro'yxatni saqlaymiz.
        state.cache.branchesData = data;
        renderBranches(data.branches || []);
        renderBranchBrief(data.branches || []);
    }

    function branchRowHtml(b) {
        return `<tr data-boss-branch="${escapeHTML(String(b.id))}" role="button" tabindex="0">
            <td data-label="Reyting"><span class="boss-rank r${Math.min(3, b.rank || 99)}">${b.rank || '—'}</span></td>
            <td data-label="Filial"><strong>${escapeHTML(b.name)}</strong>
                ${b.address ? `<small>${escapeHTML(b.address)}</small>` : ''}</td>
            <td data-label="Holat">${statusBadge(b.status)}</td>
            <td data-label="Xodimlar">${b.staffActive || 0}<small>faol / ${b.staffCount || 0}</small></td>
            <td data-label="Mahsulotlar">${b.productCount || 0}
                <small>${fmt(b.stockValue || 0)} so'm</small></td>
            <td data-label="Savdo"><strong>${fmt(b.revenue || 0)}</strong> so'm
                <small>${b.sales || 0} ta chek · o'rtacha ${fmt(b.avgCheck || 0)}</small></td>
            <td data-label="Foyda"><strong>${fmt(b.profit || 0)}</strong> so'm</td>
        </tr>`;
    }

    function renderBranches(rows) {
        const box = document.getElementById('boss-branches-box');
        if (!box) return;
        box.innerHTML = `<div class="table-wrap"><table class="boss-table">
            <thead><tr><th>#</th><th>Filial</th><th>Holat</th><th>Xodimlar</th>
            <th>Mahsulotlar</th><th>Savdo</th><th>Foyda</th></tr></thead>
            <tbody>${rows.length ? rows.map(branchRowHtml).join('')
                : `<tr><td colspan="7">${emptyState('Filial ro\'yxati bo\'sh')}</td></tr>`}
            </tbody></table></div>`;
    }

    async function renderBranchBrief(rows) {
        const box = document.getElementById('boss-branch-brief');
        if (!box) return;
        if (!rows.length) { box.innerHTML = emptyState('Filial ro\'yxati bo\'sh'); return; }
        const max = Math.max(...rows.map(r => r.revenue || 0), 1);
        box.innerHTML = rows.slice(0, 4).map((r, i) => `<div class="boss-rank-row">
            <span class="boss-rank r${i + 1}">${i + 1}</span>
            <div class="boss-rank-main">
                <div class="boss-rank-top"><strong>${escapeHTML(r.name)}</strong>
                    <span class="boss-rank-val">${fmt(r.revenue || 0)} so'm</span></div>
                <div class="boss-bar"><div class="boss-bar-fill" style="width:${Math.round((r.revenue || 0) / max * 100)}%"></div></div>
                <small>${r.staffActive || 0} xodim · ${r.productCount || 0} mahsulot · ${r.sales || 0} chek</small>
            </div></div>`).join('');
    }

    /* ── 6) Moliyaviy nazorat ────────────────────────── */

    /** Moliya filtrlari bo'yicha diagramma so'rovi (sana + filial). */
    async function loadFinanceCharts() {
        const p = new URLSearchParams();
        p.set('period', state.period);
        if (state.financeFrom) p.set('from', state.financeFrom);
        if (state.financeTo) p.set('to', state.financeTo);
        if (state.financeBranch) p.set('branchId', state.financeBranch);
        const data = await api('/api/boss/charts?' + p.toString());
        if (data) paintCharts(data);
    }

    async function loadFinance() {
        const box = document.getElementById('boss-finance-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const p = new URLSearchParams();
        p.set('period', state.period);
        if (state.financeFrom) p.set('from', state.financeFrom);
        if (state.financeTo) p.set('to', state.financeTo);
        if (state.financeBranch) p.set('branchId', state.financeBranch);
        const data = await api('/api/boss/finance?' + p.toString());
        if (!data) { box.innerHTML = emptyState('Moliyaviy ma\'lumotni olib bo\'lmadi'); return; }
        const f = data.finance || {};
        const items = [
['Jami savdo', f.revenue, 'fa-cash-register', 'primary'],
            ['Kirim', f.kirim, 'fa-arrow-down-long', 'success'],
            ['Chiqim', f.chiqim, 'fa-arrow-up-long', 'warning'],
            ['Xarajat', f.harajat, 'fa-receipt', 'warning'],
            ['Yalpi foyda', f.grossProfit, 'fa-sack-dollar', 'success'],
            ['Sof natija', f.net, 'fa-scale-balanced', (f.net || 0) >= 0 ? 'success' : 'warning']
        ];
        box.innerHTML = '<div class="boss-kpi-grid">'
            + items.map(([label, value, icon, tone]) =>
                kpiCard(label, fmt(value || 0) + " so'm", '', icon, tone)).join('')
            + '</div>'
            + '<div class="boss-finance-note"><i class="fas fa-circle-info"></i> '
            + (f.hasCostData
                ? 'Foyda mahsulotlarning tan narxi (cost) asosida hisoblandi.'
                : 'Foyda <strong>0</strong> ko\'rinadi: mahsulotlarda tan narx (cost) '
                  + 'kiritilmagan. Ma\'lumot yo\'q — taxmin qilinmaydi.')
            + ' Kirim/chiqim/xarajat — mavjud kirim-chiqim qaydlaridan ('
            + (f.flowRecords || 0) + ' ta yozuv).</div>';
        // Pastdagi diagrammalar: kirim/chiqim va oylik savdo/foyda.
        loadFinanceCharts();
    }

    /* ── 7) Hisobotlar + CSV eksport ──────────────────── */

    function reportParams() {
        const p = new URLSearchParams();
        p.set('period', state.period);
        p.set('limit', '300');
        if (state.reportFrom) p.set('from', state.reportFrom);
        if (state.reportTo) p.set('to', state.reportTo);
        if (state.reportBranch) p.set('branchId', state.reportBranch);
        if (state.reportStaff) p.set('staffName', state.reportStaff);
        if (state.reportProduct) p.set('productName', state.reportProduct);
        if (state.reportCat) p.set('cat', state.reportCat);
        return p;
    }

    async function loadReports() {
        const box = document.getElementById('boss-reports-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const data = await api('/api/boss/reports?' + reportParams().toString());
        if (!data) { box.innerHTML = emptyState('Hisobotni olib bo\'lmadi'); return; }
        const s = data.summary || {};
        const rows = data.rows || [];
        box.innerHTML = `
            <div class="boss-kpi-grid">
                ${kpiCard('Savdo', fmt(s.revenue || 0) + " so'm", '', 'fa-cash-register', 'primary')}
                ${kpiCard('Foyda', fmt(s.profit || 0) + " so'm", '', 'fa-sack-dollar', 'success')}
                ${kpiCard('Mahsulot soni', String(s.units || 0), '', 'fa-box', 'info')}
                ${kpiCard('Cheklar', String(s.orders || 0), '', 'fa-receipt', 'info')}
            </div>
            <div class="table-wrap"><table class="boss-table"><thead><tr>
                <th>Chek</th><th>Sana</th><th>Xodim</th><th>Filial</th>
                <th>Mijoz</th><th>Dona</th><th>Savdo</th><th>Foyda</th></tr></thead>
                <tbody>${rows.length ? rows.map(r => `<tr>
                    <td data-label="Chek">#${escapeHTML(String(r.saleId))}</td>
                    <td data-label="Sana">${escapeHTML(r.date)} <small>${escapeHTML(r.time)}</small></td>
                    <td data-label="Xodim">${escapeHTML(r.staff)}</td>
                    <td data-label="Filial">${escapeHTML(r.branchName || '—')}</td>
                    <td data-label="Mijoz">${escapeHTML(r.customer || '—')}</td>
                    <td data-label="Dona">${r.items}</td>
                    <td data-label="Savdo"><strong>${fmt(r.total)}</strong></td>
                    <td data-label="Foyda">${fmt(r.profit)}</td></tr>`).join('')
                    : `<tr><td colspan="8">${emptyState('Bu filtrlar bo\'yicha savdo yo\'q')}</td></tr>`}
                </tbody></table></div>`;
    }

    /** CSV eksport — mavjud backend eksportidan foydalanadi. */
    async function exportReportsCsv() {
        if (!staffToken) { showNotif('error', 'Sessiya yo\'q', 'Qayta kiring'); return; }
        const params = reportParams();
        params.set('format', 'csv');
        showNotif('info', 'Eksport', 'Fayl tayyorlanmoqda...');
        try {
            const res = await fetch('/api/boss/reports?' + params.toString(),
                { headers: authHeaders() });
            if (!res.ok) { showNotif('error', 'Xatolik', 'Eksport bajarilmadi'); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `boshlik-hisobot-${state.period}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showNotif('success', 'Yuklab olindi', 'CSV fayl saqlandi');
        } catch (e) {
            showNotif('error', 'Xatolik', 'Faylni saqlab bo\'lmadi');
        }
    }

    /* ── 8) Audit log ────────────────────────────────── */

    async function loadAudit() {
        const box = document.getElementById('boss-audit-box');
        if (!box) return;
        box.innerHTML = '<div class="boss-loading"><i class="fas fa-spinner fa-spin"></i></div>';
        const p = new URLSearchParams();
        p.set('limit', '200');
        if (state.auditQuery) p.set('q', state.auditQuery);
        if (state.auditSource) p.set('source', state.auditSource);
        const data = await api('/api/boss/audit?' + p.toString());
        if (!data) { box.innerHTML = emptyState('Jurnalni olib bo\'lmadi'); return; }
        const events = data.events || [];
        const labels = {
            'staff-create': "Xodim qo'shildi", 'staff-update': 'Xodim yangilandi',
            'staff-phone-change': "Login (telefon) o'zgartirildi",
            'phone-changed': "Login (telefon) o'zgartirildi",
            'staff-delete': "Xodim o'chirildi", 'password-change-own': 'Parol yangilandi',
            'password-change': 'Parol almashtirildi', 'login': 'Tizimga kirildi',
            'login-failed': 'Muvaffaqiyatsiz kirish', 'logout': 'Chiqildi',
            'logout-all': 'Barcha sessiyalar yopildi',
            'sale-create': 'Savdo qayd etildi', 'sale-delete': "Savdo o'chirildi",
            'product-create': "Mahsulot qo'shildi", 'product-update': 'Mahsulot yangilandi',
            'product-delete': "Mahsulot o'chirildi", 'branch-create': "Filial qo'shildi",
            'branch-update': 'Filial yangilandi', 'branch-delete': "Filial o'chirildi",
            'session-revoke': 'Sessiya bekor qilindi', 'storage-check': 'Xotira tekshiruvi'
        };
        const srcName = s => s === 'security' ? 'Xavfsizlik' : 'Boshliq';
        const summary = `<div class="boss-audit-info"><i class="fas fa-circle-info"></i> `
            + `${events.length} ta yozuv`
            + `${state.auditSource ? ` · manba: ${srcName(state.auditSource)}` : ''}`
            + `${state.auditQuery ? ` · qidiruv: "${escapeHTML(state.auditQuery)}"` : ''}</div>`;
        box.innerHTML = events.length
            ? summary + '<div class="boss-audit">' + events.map(e => `<div class="boss-audit-row">
                <span class="boss-audit-time">${escapeHTML(e.time || '')}</span>
                <span class="boss-audit-act">${escapeHTML(labels[e.action] || e.action)}
                    <span class="boss-chip-mini">${srcName(e.source)}</span></span>
                <span class="boss-audit-target">${escapeHTML(e.target || '')}</span>
                <span class="boss-audit-detail">${escapeHTML(e.detail || '')}</span>
                <span class="boss-audit-actor">${escapeHTML(e.actor || '')}</span>
            </div>`).join('') + '</div>'
            : summary + emptyState(state.auditQuery || state.auditSource
                ? 'Qidiruvga mos yozuv topilmadi' : 'Hali amal qilinmagan');
    }
/* ── 9) Xodim boshqaruvi ─────────────────────────── */

    function findStaffRow(id) {
        const rows = (state.cache.staff || {}).staff || [];
        return rows.find(s => String(s.id) === String(id));
    }

    /** Matnni xavfsiz nusxalaydi (clipboard API + zaxira yo'l). */
    function copyText(text, okLabel) {
        const value = String(text || '');
        if (!value) return;
        const done = () => showNotif('success', 'Nusxalandi', okLabel || 'Buferga nusxalandi');
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = value;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                done();
            } catch (e) {
                showNotif('error', 'Xatolik', 'Nusxalab bo\'lmadi — qo\'lda ko\'chiring');
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(done).catch(fallback);
        } else {
            fallback();
        }
    }

    /** Forma ichidagi xatoni ko'rsatadi (modal YOPILMAYDI). */
    function staffFormError(message, fieldId) {
        const box = document.getElementById('boss-form-error');
        if (box) {
            box.hidden = false;
            box.innerHTML = '<i class="fas fa-circle-exclamation"></i> ' + escapeHTML(message);
        }
        if (fieldId) {
            const field = document.getElementById(fieldId);
            if (field) {
                field.setAttribute('aria-invalid', 'true');
                field.focus();
            }
        }
        playError();
    }

    /** Forma xatosini tozalaydi. */
    function clearStaffFormError() {
        const box = document.getElementById('boss-form-error');
        if (box) { box.hidden = true; box.textContent = ''; }
        document.querySelectorAll('#bossStaffModal [aria-invalid="true"]').forEach(el => {
            el.removeAttribute('aria-invalid');
        });
    }

    function formatStaffPhoneInput(input) {
        if (!input || typeof phoneDigitsUz !== 'function'
            || typeof formatPhoneMaskUz !== 'function') return;
        const raw = input.value;
        const caret = input.selectionStart ?? raw.length;
        let digits = raw.replace(/\D/g, '');
        let strippedPrefixDigits = 0;
        while (digits.startsWith('998') && digits.length > 9) {
            digits = digits.slice(3);
            strippedPrefixDigits += 3;
        }
        const digitsBeforeCaret = (raw.slice(0, caret).match(/\d/g) || []).length;
        const localDigitsBeforeCaret = Math.max(
            0, Math.min(9, digitsBeforeCaret - Math.min(strippedPrefixDigits, digitsBeforeCaret))
        );
        const formatted = formatPhoneMaskUz(raw);
        if (input.value === formatted) return;
        input.value = formatted;

        let seen = 0;
        let nextCaret = formatted.length;
        if (localDigitsBeforeCaret === 0) {
            nextCaret = 0;
        } else {
            for (let i = 0; i < formatted.length; i++) {
                if (/\d/.test(formatted[i])) seen++;
                if (seen === localDigitsBeforeCaret) {
                    nextCaret = i + 1;
                    if (formatted[nextCaret] === ' ') nextCaret++;
                    break;
                }
            }
        }
        try { input.setSelectionRange(nextCaret, nextCaret); } catch (e) { }
    }

    /** Yaratilgan xodimning kirish ma'lumotlarini formadan keyin ko'rsatadi. */
    function showNewStaffCredentials(info) {
        const form = document.getElementById('boss-new-form');
        const box = document.getElementById('boss-new-credentials');
        if (form) form.hidden = true;
        if (box) box.hidden = false;
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        set('boss-cred-login', info.login || '—');
        set('boss-cred-pass', info.password || '—');
        set('boss-cred-role', ROLES[info.role] || info.role || '—');
        const saveBtn = document.getElementById('boss-new-save');
        if (saveBtn) saveBtn.hidden = true;
    }

    /** Yangi xodim qo'shish oynasini ochadi. Maosh modulidan ham
        chaqiriladi — xodim qo'shish FAQAT shu yagona forma orqali. */
    function openAddStaff() {
        if (!canManageStaff()) return;
        if (isManagerStaffView() && !String(currentUser.branchId || '').trim()) {
            showNotif('error', 'Filial biriktirilmagan',
                'Xodim qo\'shishdan oldin rahbariyat menejerga filial biriktirishi kerak');
            return;
        }
        resetNewStaffForm();
        openModal('bossStaffModal');
    }

    /** Xodim ma'lumotlari (jumladan oylik maosh) o'zgargach, maosh rejasini
        ham yangilaydi — ikkala ko'rinish bir xil manbadan bo'lib qolsin. */
    function refreshSalaryPlan() {
        if (isBoss() && typeof SalaryModule !== 'undefined'
            && typeof SalaryModule.render === 'function') {
            SalaryModule.render();
        }
    }

    /** Formani tozalab, «yana xodim qo'shish» holatiga qaytaradi. */
    function resetNewStaffForm() {
        ['boss-new-name', 'boss-new-phone', 'boss-new-salary', 'boss-new-password',
            'boss-new-password-confirm'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = '';
            if (id === 'boss-new-password') el.type = 'password';
            el.removeAttribute('aria-invalid');
        });
        const salaryHint = document.getElementById('boss-new-salary-hint');
        if (salaryHint) {
            salaryHint.textContent = 'Faqat raqam kiriting — minglik ajratgich avtomatik '
                + 'qo\'shiladi. Manfiy va bo\'sh qiymat qabul qilinmaydi.';
        }
        const eye = document.getElementById('boss-new-pass-eye');
        if (eye) eye.className = 'fas fa-eye';
        const hint = document.getElementById('boss-new-pass-hint');
        if (hint) hint.textContent = 'Kamida 6 belgi. Parol tizimda faqat xesh ko\'rinishida saqlanadi.';
        const pwInput = document.getElementById('boss-new-password');
        const pwGroup = pwInput ? pwInput.closest('.form-group') : null;
        if (pwGroup) pwGroup.hidden = false;
        const confirmInput = document.getElementById('boss-new-password-confirm');
        const confirmGroup = confirmInput ? confirmInput.closest('.form-group') : null;
        if (confirmGroup) confirmGroup.hidden = false;
        // Tahrir holati yopiladi — forma yana «qo'shish» rejimida ochiladi.
        state.editingStaffId = null;
        state.editingStaffOrig = null;
        state.staffSaving = false;
        clearStaffFormError();
        const title = document.getElementById('boss-staff-modal-title');
        if (title) title.innerHTML = '<i class="fas fa-user-plus"></i> Xodim qo\'shish';
        const passLabel = document.getElementById('boss-new-pass-label');
        if (passLabel) passLabel.innerHTML = 'Parol <b>*</b>';
        const pw = document.getElementById('boss-new-password');
        if (pw) pw.setAttribute('placeholder', 'Kamida 6 belgi');
        const roleSel = document.getElementById('boss-new-role');
        if (roleSel) {
            roleSel.disabled = false;
            roleSel.value = 'cashier';
            roleSel.querySelectorAll('option').forEach(option => {
                option.hidden = isAdminStaffView() && option.value === 'admin'
                    || isManagerStaffView() && option.value !== 'cashier';
            });
            roleSel.disabled = isManagerStaffView();
        }
        const salaryGroup = document.querySelector('#boss-new-salary')?.closest('.boss-salary-group');
        if (salaryGroup) salaryGroup.hidden = isAdminStaffView() || isManagerStaffView();
        const statusSel = document.getElementById('boss-new-status');
        if (statusSel) {
            statusSel.disabled = isManagerStaffView();
            statusSel.value = 'active';
        }
        const branchSel = document.getElementById('boss-new-branch');
        if (branchSel) {
            branchSel.value = isManagerStaffView()
                ? String(currentUser.branchId || '') : '';
            branchSel.disabled = isManagerStaffView();
        }
        const saveBtn = document.getElementById('boss-new-save');
        if (saveBtn) {
            saveBtn.hidden = false;
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Saqlash';
        }
        const form = document.getElementById('boss-new-form');
        const box = document.getElementById('boss-new-credentials');
        if (form) form.hidden = false;
        if (box) box.hidden = true;
        // Bir martalik ko'rsatilgan parol DOM'da qolib ketmasin.
        ['boss-cred-login', 'boss-cred-pass', 'boss-cred-role'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });
    }

    /** Parol maydonini ko'rsatish/yashirish. */
    function toggleNewPassword() {
        const input = document.getElementById('boss-new-password');
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        const eye = document.getElementById('boss-new-pass-eye');
        if (eye) eye.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
    }

    /**
     * O'z parolini o'zgartirish modali: ko'rsatilgan maydon parolini
     * ko'rsatish/yashirish. Har bir maydon mustaqil (id orqali);
     * faqat input type va ko'z ikonkasini o'zgartiradi — hech qanday
     * saqlash yoki formani yuborish harakati yo'q.
     */
    function toggleOwnPassField(inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        setPassFieldVisibility(inputId, input.type === 'password');
    }

    /**
     * Kriptografik tasodifiy son (0..max-1). `Math.random()` xavfsizlik
     * maqsadida ISHLATILMAYDI; mavjud bo'lmasa chaqiruvchi xato beradi.
     */
    function secureRandomIndex(max) {
        const n = Math.max(1, Math.floor(Number(max) || 1));
        const buf = new Uint32Array(1);
        const limit = Math.floor(0x100000000 / n) * n;
        do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
        return buf[0] % n;
    }

    /**
     * 16 belgili kuchli parol: katta/kichik harf, raqam va belgi.
     * Adashtiruvchi I, l, O, 0, 1 belgilari ataylab ishlatilmaydi.
     */
    function generateStrongPassword(length = 16) {
        if (typeof crypto === 'undefined' || !crypto.getRandomValues) return '';
        const sets = [
            'ABCDEFGHJKLMNPQRSTUVWXYZ',
            'abcdefghijkmnopqrstuvwxyz',
            '23456789',
            '!@#$%&*'
        ];
        const all = sets.join('');
        const chars = sets.map(set => set[secureRandomIndex(set.length)]);
        while (chars.length < length) chars.push(all[secureRandomIndex(all.length)]);
        for (let i = chars.length - 1; i > 0; i--) {
            const j = secureRandomIndex(i + 1);
            const tmp = chars[i];
            chars[i] = chars[j];
            chars[j] = tmp;
        }
        return chars.join('');
    }

    /** Yangi xodim formasi uchun kuchli parol yaratadi (asosiy + tasdiq). */
    function generatePassword() {
        const input = document.getElementById('boss-new-password');
        if (!input) return;
        const pass = generateStrongPassword(16);
        if (!pass) {
            showNotif('error', 'Xatolik', 'Brauzer xavfsiz parol yaratishni qo\'llab-quvvatlamaydi');
            return;
        }
        input.value = pass;
        const confirm = document.getElementById('boss-new-password-confirm');
        if (confirm) confirm.value = pass;
        input.type = 'text';
        const eye = document.getElementById('boss-new-pass-eye');
        if (eye) eye.className = 'fas fa-eye-slash';
        const hint = document.getElementById('boss-new-pass-hint');
        if (hint) hint.textContent = 'Kuchli parol yaratildi - xodimga shu parolni bering.';
    }

    /**
     * Tahrirlash rejimi: mavjud `bossStaffModal` formasi SHU ID'lar bilan
     * to'ldiriladi, saqlashda esa PUT /api/boss/staff/<id> ga faqat
     * o'zgargan maydonlar yuboriladi (backend PUT ushbu maydonlarni
     * mustaqil qabul qiladi — yangi endpoint yaratilmaydi).
     */
    async function openEditStaff(id) {
        if (!canManageStaff()) return;
        const row = findStaffRow(id);
        if (!row) {
            showNotif('error', 'Xodim topilmadi', 'Ro\'yxatni yangilang va qayta urinib ko\'ring');
            return;
        }
        if (!isBoss() && !canManageStaffRow(row)) {
            showNotif('error', 'Ruxsat yo\'q', 'Admin faqat Menejer va Kassa xodimlarini tahrirlay oladi');
            return;
        }
        // Filial variantlari hali yuklanmagan bo'lsa — shu yerda to'ldiriladi.
        await loadBranchOptions();

        state.editingStaffId = String(id);
        state.editingStaffOrig = {
            name: String(row.name || ''),
            login: String(row.login || ''),
            phone: String(row.phone || ''),
            role: String(row.role || 'cashier'),
            branch: String(row.branchId || ''),
            status: String(row.status || 'active'),
            salary: (row.salary === null || row.salary === undefined || row.salary === '')
                ? null : Number(row.salary)
        };
        const role = state.editingStaffOrig.role.toLowerCase();
        const isBossRow = role === 'boss';
        const me = !!(currentUser && (String(row.id) === String(currentUser.id)
            || row.login === currentUser.login));
        const set = (elId, value) => {
            const el = document.getElementById(elId);
            if (el) el.value = value;
        };
        clearStaffFormError();
        set('boss-new-name', row.name || '');
        set('boss-new-phone', (typeof formatPhoneMaskUz === 'function')
            ? formatPhoneMaskUz(row.phone || '') : '');
        set('boss-new-status', state.editingStaffOrig.status);
        set('boss-new-branch', state.editingStaffOrig.branch);
        // Maosh belgilanmagan bo'lsa maydon BO'SH qoladi — 0 bilan boshlanmaydi.
        set('boss-new-salary', state.editingStaffOrig.salary === null
            ? '' : formatSalaryInput(state.editingStaffOrig.salary));
        const salaryInput = document.getElementById('boss-new-salary');
        if (salaryInput) salaryInput.removeAttribute('aria-invalid');
        const salaryHint = document.getElementById('boss-new-salary-hint');
        if (salaryHint) {
            salaryHint.textContent = state.editingStaffOrig.salary === null
                ? 'Bu xodimga maosh hali belgilanmagan. Yangi qiymat kiritsangiz — saqlanadi.'
                : 'Joriy maosh. O\'zgartirsangiz, eski qiymat tarixga yoziladi.';
        }
        const roleSel = document.getElementById('boss-new-role');
        if (roleSel) {
            // Boshliq roli tayinlanmaydi. Boshliq qatorida select o'chiriladi
            // va joriy rol vizual ko'rsatiladi (patch'ga yuborilmaydi).
            const adminRole = roleSel.querySelector('option[value="admin"]');
            if (adminRole) adminRole.hidden = isAdminStaffView();
            roleSel.disabled = isBossRow || isAdminStaffView();
            roleSel.value = isBossRow ? 'boss' : state.editingStaffOrig.role;
        }
        const salaryGroup = document.querySelector('#boss-new-salary')?.closest('.boss-salary-group');
        if (salaryGroup) salaryGroup.hidden = isAdminStaffView();
        const statusSel = document.getElementById('boss-new-status');
        if (statusSel) {
            // O'zini bloklash va Boshliq holatini o'zgartirish serverda ham
            // taqiqlangan — formada ham o'chirib qo'yamiz.
            statusSel.disabled = isBossRow || me;
            statusSel.value = state.editingStaffOrig.status;
        }
        const branchSel = document.getElementById('boss-new-branch');
        if (branchSel) branchSel.disabled = false;
        const pw = document.getElementById('boss-new-password');
        const pwGroup = pw ? pw.closest('.form-group') : null;
        if (pw) {
            pw.value = '';
            pw.type = 'password';
            pw.setAttribute('placeholder', me ? 'O\'z parolingizni alohida oynada yangilang'
                : 'O\'zgartirmaslik uchun bo\'sh qoldiring');
        }
        if (pwGroup) pwGroup.hidden = me;
        const pwConfirm = document.getElementById('boss-new-password-confirm');
        const pwConfirmGroup = pwConfirm ? pwConfirm.closest('.form-group') : null;
        if (pwConfirm) pwConfirm.value = '';
        if (pwConfirmGroup) pwConfirmGroup.hidden = me;
        const eye = document.getElementById('boss-new-pass-eye');
        if (eye) eye.className = 'fas fa-eye';
        const hint = document.getElementById('boss-new-pass-hint');
        if (hint) hint.textContent = me
            ? 'O\'z parolingizni «Parolimni o\'zgartirish» oynasi orqali yangilang.'
            : 'Ixtiyoriy: bo\'sh qoldirsangiz parol o\'zgarmaydi (yangi parol kamida 6 belgi).';
        const passLabel = document.getElementById('boss-new-pass-label');
        if (passLabel) passLabel.innerHTML = 'Yangi parol <b>(ixtiyoriy)</b>';
        const title = document.getElementById('boss-staff-modal-title');
        if (title) title.innerHTML = '<i class="fas fa-user-pen"></i> Xodimni tahrirlash';
        const saveBtn = document.getElementById('boss-new-save');
        if (saveBtn) { saveBtn.hidden = false; saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> O\'zgarishlarni saqlash'; }
        const form = document.getElementById('boss-new-form');
        const box = document.getElementById('boss-new-credentials');
        if (form) form.hidden = false;
        if (box) box.hidden = true;
        openModal('bossStaffModal');
        setTimeout(() => document.getElementById('boss-new-name')?.focus(), 60);
    }

    /** Server xabariga qarab qaysi maydonni belgilash (umumiy qoida). */
    function staffErrorField(message) {
        const text = String(message || '').toLowerCase();
        if (text.includes('telefon') || text.includes('login')) return 'boss-new-phone';
        if (text.includes('parol')) return 'boss-new-password';
        if (text.includes('ism')) return 'boss-new-name';
        if (text.includes('maosh') || text.includes('so\'m') || text.includes('sum')) {
            return 'boss-new-salary';
        }
        if (text.includes('filial')) return 'boss-new-branch';
        if (text.includes('rol')) return 'boss-new-role';
        return '';
    }

    async function createStaff() {
        if (!canManageStaff()) return;
        clearStaffFormError();
        const name = (document.getElementById('boss-new-name')?.value || '').trim();
        const phoneRaw = (document.getElementById('boss-new-phone')?.value || '').trim();
        const role = document.getElementById('boss-new-role')?.value || 'cashier';
        const branch = document.getElementById('boss-new-branch')?.value || '';
        const status = document.getElementById('boss-new-status')?.value || 'active';
        const password = document.getElementById('boss-new-password')?.value || '';
        const confirm = document.getElementById('boss-new-password-confirm')?.value || '';
        const salaryRaw = document.getElementById('boss-new-salary')?.value || '';

        if (name.length < 2) {
            staffFormError('Xodim ismini kiriting (kamida 2 belgi)', 'boss-new-name');
            return;
        }
        // Login TELEFON raqami bo'lgani uchun raqam majburiy — aks holda
        // xodim tizimga kira olmaydi (login maydoni telefon uchun).
        const phone = (typeof normalizePhoneUz === 'function') ? normalizePhoneUz(phoneRaw) : '';
        if (!phone) {
            staffFormError('Telefon raqamini to\'liq kiriting: +998 90 123 45 67',
                'boss-new-phone');
            return;
        }
        const allowedRoles = isManagerStaffView() ? ['cashier']
            : isAdminStaffView() ? ['cashier', 'manager']
                : ['cashier', 'manager', 'admin'];
        if (!allowedRoles.includes(role)
            && !(state.editingStaffId && role === 'boss')) {
            staffFormError('Rol noto\'g\'ri tanlangan', 'boss-new-role');
            return;
        }
        if (!['active', 'blocked', 'inactive'].includes(status)) {
            staffFormError('Holat noto\'g\'ri tanlangan', 'boss-new-status');
            return;
        }
        // ── Oylik maosh: majburiy, butun son (so'm) ────────────────────
        const noSalaryAccess = isAdminStaffView() || isManagerStaffView();
        const salaryParsed = noSalaryAccess ? { empty: true } : parseSalaryInput(salaryRaw);
        const origSalary = state.editingStaffId && state.editingStaffOrig
            ? state.editingStaffOrig.salary : null;
        if (noSalaryAccess) {
            // Admin va Menejer uchun maosh/payroll maydonlari backendda yopiq.
        } else if (state.editingStaffId) {
            // Tahrirda mavjud maoshni bo'sh maydon bilan o'chirib bo'lmaydi;
            // belgilanmagan bo'lsa — bo'sh qoldirish mumkin (o'zgarish yo'q).
            if (salaryParsed.empty && origSalary !== null) {
                staffFormError('Oylik maoshni kiriting (mavjud qiymatni o\'chirib bo\'lmaydi)',
                    'boss-new-salary');
                return;
            }
        } else if (salaryParsed.empty) {
            staffFormError('Oylik maoshni kiriting — masalan: 4 000 000', 'boss-new-salary');
            return;
        }
        if (salaryParsed.error) {
            staffFormError(salaryParsed.error, 'boss-new-salary');
            return;
        }
        // Takroriy yuborish: so'rov davom etayotganda qayta bosish e'tiborsiz.
        if (state.staffSaving) return;

        // ── Tahrir rejimi: faqat o'zgargan maydonlar PUT qilinadi ──────
        if (state.editingStaffId) {
            const orig = state.editingStaffOrig || {};
            const patch = {};
            if (name !== (orig.name || '')) patch.name = name;
            if (phone !== (orig.phone || '')) patch.phone = phone;
            const roleSel = document.getElementById('boss-new-role');
            if (roleSel && !roleSel.disabled && role !== (orig.role || '')) patch.role = role;
            const statusSel = document.getElementById('boss-new-status');
            if (statusSel && !statusSel.disabled && status !== (orig.status || '')) patch.status = status;
            if (branch !== (orig.branch || '')) patch.branchId = branch;
            if (!noSalaryAccess && !salaryParsed.empty && salaryParsed.value !== origSalary) {
                patch.salary = salaryParsed.value;
            }
            if (password) {
                if (password.length < 6) {
                    staffFormError('Parol kamida 6 belgidan iborat bo\'lsin', 'boss-new-password');
                    return;
                }
                if (confirm && confirm !== password) {
                    staffFormError('Parollar mos kelmadi', 'boss-new-password-confirm');
                    return;
                }
                // O'z parolini o'zgartirish hozirgi sessiyani bekor qiladi —
                // o'zini shu formadan emas, «Parolimni o'zgartirish» oynasidan
                // o'zgartirish taklif qilinadi.
                const selfLogin = String(currentUser && currentUser.login || '').trim().toLowerCase();
                const targetLogin = String(orig.login || '').trim().toLowerCase();
                if (selfLogin && targetLogin && selfLogin === targetLogin) {
                    staffFormError('O\'z parolingizni «Parolimni o\'zgartirish» tugmasi orqali yangilang',
                        'boss-new-password');
                    return;
                }
                patch.password = password;
            }
            if (!Object.keys(patch).length) {
                showNotif('success', 'O\'zgarish yo\'q', 'Hech qanday maydon o\'zgartirilmadi');
                closeModal('bossStaffModal');
                resetNewStaffForm();
                return;
            }
            const eSaveBtn = document.getElementById('boss-new-save');
            const eOldLabel = eSaveBtn ? eSaveBtn.innerHTML : '';
            state.staffSaving = true;
            if (eSaveBtn) {
                eSaveBtn.disabled = true;
                eSaveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saqlanmoqda...';
            }
            try {
                const res = await fetch('/api/boss/staff/' + encodeURIComponent(state.editingStaffId), {
                    method: 'PUT',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(patch)
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok || body.status !== 'success' || !body.staff) {
                    staffFormError(body.message || 'Xodimni yangilab bo\'lmadi',
                        staffErrorField(body.message));
                    return;   // modal OCHIQ qoladi — kiritilgan qiymatlar yo'qolmaydi
                }
                // O'z ismini/telefonini o'zgartirgan bo'lsa — sarlavhadagi
                // joriy foydalanuvchi ma'lumotini ham yangilaymiz.
                if (currentUser && (String(state.editingStaffId) === String(currentUser.id)
                    || String(orig.login || '') === String(currentUser.login || ''))) {
                    if (body.staff) {
                        currentUser.name = body.staff.name || currentUser.name;
                        currentUser.phone = body.staff.phone || currentUser.phone;
                    }
                }
                showNotif('success', 'Xodim yangilandi', name + ' ma\'lumotlari saqlandi');
                closeModal('bossStaffModal');
                resetNewStaffForm();
                await loadStaff();
                refreshSalaryPlan();
            } catch (err) {
                // Tarmoq/server uzilishi: modal ochiq, kiritilgan qiymatlar saqlanadi.
                staffFormError('Server bilan aloqa uzildi. O\'zgarishlar saqlanmadi — '
                    + 'internetni tekshirib, qayta urinib ko\'ring');
            } finally {
                state.staffSaving = false;
                if (eSaveBtn) {
                    eSaveBtn.disabled = false;
                    eSaveBtn.innerHTML = eOldLabel;
                }
            }
            return;
        }

        if (password.length < 6) {
            staffFormError('Parol kamida 6 belgidan iborat bo\'lsin', 'boss-new-password');
            return;
        }
        if (confirm !== password) {
            staffFormError('Parollar mos kelmadi', 'boss-new-password-confirm');
            return;
        }

        const saveBtn = document.getElementById('boss-new-save');
        const oldLabel = saveBtn ? saveBtn.innerHTML : '';
        state.staffSaving = true;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saqlanmoqda...';
        }
        let body = null;
        try {
            const res = await fetch('/api/boss/staff', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    name, phone, role, branchId: branch, status, password,
                    salary: salaryParsed.value
                })
            });
            body = await res.json().catch(() => ({}));
            // HTTP status bilan birga biznes natijasini ham tekshiramiz:
            // 2xx kelib, `status: error` bo'lsa modal YOPILMAYDI.
            if (!res.ok || body.status !== 'success' || !body.staff) {
                staffFormError(body.message || 'Xodimni qo\'shib bo\'lmadi',
                    staffErrorField(body.message));
                return;   // modal OCHIQ qoladi — forma tozalanmaydi
            }
        } catch (err) {
            // Tarmoq/server uzilishi: ma'lumot yo'qolmaydi, modal ochiq qoladi.
            staffFormError('Server bilan aloqa uzildi. Ma\'lumotlar saqlanmadi — '
                + 'internetni tekshirib, qayta urinib ko\'ring');
            return;
        } finally {
            state.staffSaving = false;
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = oldLabel;
            }
        }

        // ── MUVAFFAQIYAT (backend haqiqatan saqladi) ────────────────
        const created = body.staff || {};
        // Avval modal yopiladi, keyin ro'yxat yangilanadi.
        // Kirish ma'lumotlari alohida «credentials» ekranida QOLMAYDI —
        // parolni Boshliq formada o'zi kiritgan (kerak bo'lsa nusxalab oladi).
        closeModal('bossStaffModal');
        resetNewStaffForm();
        // Faol qidiruv/filtr yangi xodimni yashirib qo'ymasin.
        clearStaffFilters();
        try {
            await loadStaff();
        } catch (refreshError) {
            // Xodim allaqachon saqlangan — xato xabarini «saqlanmadi» deb bermaymiz.
            console.warn('Xodim saqlandi, lekin jadvalni yangilab bo\'lmadi:', refreshError);
        }
        showNotif('success', 'Xodim qo\'shildi',
            (created.name || name) + ' ro\'yxatga qo\'shildi. Login: '
            + (created.phone || phone));
        refreshSalaryPlan();
    }

    /** Yaratilgan xodimning kirish ma'lumotlarini buferga nusxalaydi. */
    function copyCredentials() {
        const login = (document.getElementById('boss-cred-login')?.textContent || '').trim();
        if (!login || login === '—') return;
        const pass = (document.getElementById('boss-cred-pass')?.textContent || '').trim();
        copyText(`Texno Park N1 POS\nLogin (telefon): ${login}\nParol: ${pass}`,
            'Kirish ma\'lumotlari nusxalandi');
    }

    async function putStaff(id, patch, okMessage) {
        const res = await fetch('/api/boss/staff/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(patch)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            showNotif('error', 'Xatolik', body.message || 'Amal bajarilmadi');
            return false;
        }
        showNotif('success', 'Yangilandi', okMessage || body.message || 'Saqlandi');
        await loadStaff();
        return true;
    }

    /** Bloklash / blokdan chiqarish / arxivdan faollashtirish. */
    async function toggleBlock(id) {
        const row = findStaffRow(id);
        if (!row) return;
        const status = String(row.status || 'active').toLowerCase();
        const isBossRow = String(row.role || '').toLowerCase() === 'boss';
        const me = !!(currentUser && (String(row.id) === String(currentUser.id)
            || row.login === currentUser.login));
        if (isBossRow || me) {
            showNotif('error', "Ruxsat yo'q", "O'z yoki Boshliq akountini bloklab bo'lmaydi");
            return;
        }
        const target = status === 'blocked' || status === 'inactive' ? 'active' : 'blocked';
        const blocking = target === 'blocked';
        const msg = blocking
            ? `"${row.name}" bloklanmoqchimisiz?\n\nBloklangan xodim tizimga kira olmaydi.\n`
              + `Uning barcha ochiq sessiyalari darhol yopiladi.\nParol va savdo tarixi saqlanadi.`
            : status === 'inactive'
                ? `"${row.name}" arxivdan faollashtirilsinmi?\n\nXodim yana tizimga kira oladi.`
                : `"${row.name}" blokdan chiqarilsinmi?\n\nXodim yana tizimga kira oladi.`;
        if (!confirm(msg)) return;
        await putStaff(id, { status: target },
            blocking ? 'Xodim bloklandi, sessiyalari yopildi'
                : status === 'inactive' ? 'Xodim faollashtirildi'
                    : 'Xodim blokdan chiqarildi');
    }

    /** ArxIVLASH (soft delete) — tasdiqlash va server himoyasi. */
    async function deleteStaff(id) {
        const row = findStaffRow(id);
        if (!row) return;
        const isBossRow = String(row.role || '').toLowerCase() === 'boss';
        const me = !!(currentUser && (String(row.id) === String(currentUser.id)
            || row.login === currentUser.login));
        if (isBossRow || me) {
            showNotif('error', "Ruxsat yo'q", "O'z yoki Boshliq akountini arxivlab bo'lmaydi");
            return;
        }
        if (!confirm(`"${row.name}" xodimini arxivlashni tasdiqlaysizmi?\n\n`
            + 'Xodim tizimga kira olmaydi va ro\'yxatda «Nofaol» bo\'lib qoladi.\n'
            + 'Savdo tarixi, moliya va audit jurnali SAQLANADI.')) return;
        const res = await fetch('/api/boss/staff/' + encodeURIComponent(id),
            { method: 'DELETE', headers: authHeaders() });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { showNotif('error', 'Xatolik', body.message || "Arxivlab bo'lmadi"); return; }
        showNotif('success', 'Arxivlandi', body.message || 'Xodim nofaol qilindi');
        await loadStaff();
    }
/* ── 10) Parol modallari ─────────────────────────── */

    /** Parol maydonining ko'rinishini va ko'zcha holatini sinxronlaydi. */
    function setPassFieldVisibility(inputId, show) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.type = show ? 'text' : 'password';
        const eye = document.getElementById(inputId + '-eye');
        if (eye) eye.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
        const btn = input.closest('.boss-pass-inline')?.querySelector('.pass-toggle');
        if (btn) {
            btn.setAttribute('aria-pressed', show ? 'true' : 'false');
            const base = btn.dataset.eyeLabel || 'Parolni';
            btn.setAttribute('aria-label', base + (show ? ' yashirish' : " ko'rsatish"));
            btn.title = show ? 'Parolni yashirish' : "Parolni ko'rsatish";
        }
    }

    /** Parol oynasidagi barcha maxfiy qiymatlarni DOM va xotiradan tozalaydi. */
    function clearStaffPassSensitive() {
        ['boss-pass-new', 'boss-pass-confirm'].forEach(inputId => {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.value = '';
            input.type = 'password';
            input.removeAttribute('aria-invalid');
            const eye = document.getElementById(inputId + '-eye');
            if (eye) eye.className = 'fas fa-eye';
            const btn = input.closest('.boss-pass-inline')?.querySelector('.pass-toggle');
            if (btn) {
                btn.setAttribute('aria-pressed', 'false');
                const base = btn.dataset.eyeLabel || 'Parolni';
                btn.setAttribute('aria-label', base + " ko'rsatish");
                btn.title = "Parolni ko'rsatish";
            }
        });
        const result = document.getElementById('boss-pass-result');
        if (result) result.hidden = true;
        const resultValue = document.getElementById('boss-pass-result-value');
        if (resultValue) {
            resultValue.textContent = '';
            resultValue.classList.remove('masked');   // keyingi ochilishda toza holat
        }
        const resultEye = document.getElementById('boss-pass-result-eye');
        if (resultEye) resultEye.className = 'fas fa-eye-slash';
        const formView = document.getElementById('boss-pass-form-view');
        if (formView) formView.hidden = false;
        const foot = document.getElementById('boss-pass-form-foot');
        if (foot) foot.hidden = false;
        const err = document.getElementById('boss-pass-error');
        if (err) { err.hidden = true; err.textContent = ''; }
        const policy = document.getElementById('boss-pass-policy');
        if (policy) policy.innerHTML = '<i class="fas fa-circle-info" aria-hidden="true"></i> '
            + 'Kamida 6 belgi';
        state.generatedStaffPassword = '';
        state.passWasGenerated = false;
        state.passSubmitting = false;
        state.activeStaffId = null;
        setPassSubmitLoading(false);
    }

    /** Parol oynasini yopadi (so'rov ketayotganda yopilishni bloklaydi). */
    function closeStaffPassModal() {
        if (state.passSubmitting) {
            showNotif('info', 'Kuting', 'Parol saqlanmoqda - jarayon tugashini kuting');
            return;
        }
        const modal = document.getElementById('bossPassModal');
        if (modal && modal.classList.contains('open')) closeModal('bossPassModal');
        clearStaffPassSensitive();
    }

    function setPassSubmitLoading(loading) {
        const btn = document.getElementById('boss-pass-submit');
        if (btn) {
            btn.disabled = !!loading;
            btn.innerHTML = loading
                ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Saqlanmoqda...'
                : '<i class="fas fa-key" aria-hidden="true"></i> Parolni almashtirish';
        }
        const generateBtn = document.getElementById('boss-pass-generate');
        if (generateBtn) generateBtn.disabled = !!loading;
    }

    function showStaffPassError(message, fieldId) {
        const err = document.getElementById('boss-pass-error');
        ['boss-pass-new', 'boss-pass-confirm'].forEach(id => {
            document.getElementById(id)?.removeAttribute('aria-invalid');
        });
        if (err) {
            err.hidden = false;
            err.innerHTML = '<i class="fas fa-circle-exclamation" aria-hidden="true"></i> '
                + escapeHTML(message);
        }
        if (fieldId) {
            const input = document.getElementById(fieldId);
            if (input) {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
            }
        }
        playError();
    }

    function clearStaffPassError() {
        const err = document.getElementById('boss-pass-error');
        if (err) { err.hidden = true; err.textContent = ''; }
        ['boss-pass-new', 'boss-pass-confirm'].forEach(id => {
            document.getElementById(id)?.removeAttribute('aria-invalid');
        });
    }

    /** Xodimga yangi parol o'rnatish oynasi (joriy parol KO'RSATILMAYDI). */
    function openPassModal(id) {
        const row = findStaffRow(id);
        if (!row) return;
        const me = !!(currentUser && (String(row.id) === String(currentUser.id)
            || row.login === currentUser.login));
        if (me) { openOwnPasswordModal(); return; }
        if (String(row.role || '').toLowerCase() === 'boss') {
            showNotif('error', "Ruxsat yo'q", "Boshliq parolini bu oynadan o'zgartirib bo'lmaydi");
            return;
        }
        clearStaffPassSensitive();
        state.activeStaffId = id;

        const setText = (targetId, value) => {
            const el = document.getElementById(targetId);
            if (el) el.textContent = value;
        };
        setText('boss-pass-name', row.name || 'Xodim');
        setText('boss-pass-phone', row.phone || row.login || '—');
        const roleKey = String(row.role || '').toLowerCase();
        const roleText = (typeof ROLES !== 'undefined' && ROLES[roleKey])
            || String(row.role || '').toUpperCase() || '—';
        setText('boss-pass-role', roleText);
        const avatar = document.getElementById('boss-pass-avatar');
        if (avatar) avatar.textContent = ((row.name || '?').trim()[0] || '?').toUpperCase();
        const statusEl = document.getElementById('boss-pass-status');
        if (statusEl) {
            const status = String(row.status || 'active').toLowerCase();
            const blocked = status === 'blocked';
            const inactive = status === 'inactive';
            statusEl.textContent = blocked ? 'Bloklangan' : inactive ? 'Nofaol' : 'Faol';
            statusEl.className = 'boss-pass-status'
                + (blocked ? ' blocked' : inactive ? ' inactive' : '');
        }
        const extra = document.getElementById('boss-pass-login-extra');
        if (extra) {
            const login = String(row.login || '');
            const phone = String(row.phone || '');
            const differs = login && login !== phone;
            extra.hidden = !differs;
            extra.textContent = differs ? 'Login ID: ' + login : '';
        }

        // Parol holati: faqat O'RNATILGAN/O'RNATILMAGAN + audit sanasi.
        // Parol qiymati, xesh yoki salt bu yerga HECH QACHON chiqmaydi.
        const passState = document.getElementById('boss-pass-passstate');
        const passStateText = document.getElementById('boss-pass-passstate-text');
        const passStateMeta = document.getElementById('boss-pass-passstate-meta');
        if (passStateText) {
            const has = !!row.hasPassword;
            passStateText.textContent = has ? "Parol o'rnatilgan" : "Parol o'rnatilmagan";
            if (passState) passState.classList.toggle('unset', !has);
            if (passStateMeta) {
                passStateMeta.textContent = (has && row.passChangedAt)
                    ? "Oxirgi o'zgarish: " + row.passChangedAt
                        + (row.passChangedBy ? ' · ' + row.passChangedBy : '')
                    : (has ? '' : 'Bu xodim uchun hali parol belgilanmagan');
            }
        }

        openModal('bossPassModal');
        setTimeout(() => document.getElementById('boss-pass-new')?.focus(), 60);
    }

    /** Vaqtinchalik kuchli parol yaratib, ikkala maydonga yozadi. */
    function generateStaffPassword() {
        if (state.passSubmitting) return;
        const pass = generateStrongPassword(16);
        if (!pass) {
            showStaffPassError('Brauzer xavfsiz parol yaratishni qo\'llab-quvvatlamaydi');
            return;
        }
        clearStaffPassError();
        const input = document.getElementById('boss-pass-new');
        const confirm = document.getElementById('boss-pass-confirm');
        if (input) input.value = pass;
        if (confirm) confirm.value = pass;
        setPassFieldVisibility('boss-pass-new', true);
        setPassFieldVisibility('boss-pass-confirm', true);
        state.passWasGenerated = true;
        const policy = document.getElementById('boss-pass-policy');
        if (policy) policy.innerHTML = '<i class="fas fa-shield-halved" aria-hidden="true"></i> '
            + '16 belgi · kuchli vaqtinchalik parol';
        (input || confirm)?.focus();
    }

    /**
     * Natija oynasidagi vaqtinchalik parolni ko'rsatish/yashirish.
     * YASHIRILGANDA DOM'dagi qiymat o'chiriladi (nuqtalar bilan almashadi) —
     * parol faqat `state.generatedStaffPassword` xotirasida qoladi va
     * localStorage/sessionStorage/log'ga yozilmaydi.
     */
    function setResultPasswordVisible(visible) {
        const code = document.getElementById('boss-pass-result-value');
        const eye = document.getElementById('boss-pass-result-eye');
        const btn = document.querySelector('.boss-pass-result-toggle');
        if (code) {
            code.textContent = visible
                ? (state.generatedStaffPassword || '')
                : '••••••••••••••••';
            code.classList.toggle('masked', !visible);
        }
        if (eye) eye.className = visible ? 'fas fa-eye-slash' : 'fas fa-eye';
        if (btn) {
            btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
            btn.title = visible ? 'Parolni yashirish' : "Parolni ko'rsatish";
            btn.setAttribute('aria-label', visible
                ? 'Vaqtinchalik parolni yashirish' : "Vaqtinchalik parolni ko'rsatish");
        }
    }

    /** Natija oynasidagi parolni ko'rsatish/yashirishni almashtiradi. */
    function toggleResultPassword() {
        const code = document.getElementById('boss-pass-result-value');
        if (!code) return;
        setResultPasswordVisible(code.classList.contains('masked'));
    }

    /** Vaqtinchalik parolni faqat shu oynada bir marta ko'rsatadi. */
    function showStaffPassResult(password) {
        const result = document.getElementById('boss-pass-result');
        const formView = document.getElementById('boss-pass-form-view');
        const foot = document.getElementById('boss-pass-form-foot');
        state.generatedStaffPassword = String(password || '');
        setResultPasswordVisible(true);   // boshida ko'rinadi, ko'zcha bilan yashiriladi
        const inputs = ['boss-pass-new', 'boss-pass-confirm'];
        inputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) input.value = '';
        });
        if (formView) formView.hidden = true;
        if (foot) foot.hidden = true;
        if (result) {
            result.hidden = false;
            result.querySelector('.boss-pass-result-close')?.focus();
        }
    }

    function copyGeneratedStaffPassword() {
        if (!state.generatedStaffPassword) return;
        copyText(state.generatedStaffPassword, 'Vaqtinchalik parol nusxalandi');
    }

    async function submitStaffPassword() {
        if (state.passSubmitting) return;   // takroriy bosish / double-submit
        const modal = document.getElementById('bossPassModal');
        if (!modal || !modal.classList.contains('open')) return;
        const pass = document.getElementById('boss-pass-new')?.value || '';
        const confirmPass = document.getElementById('boss-pass-confirm')?.value || '';
        if (pass.length < 6) {
            showStaffPassError('Parol kamida 6 belgidan iborat bo\'lsin', 'boss-pass-new');
            return;
        }
        if (pass.length > 200) {
            showStaffPassError('Parol juda uzun (200 belgidan oshmasin)', 'boss-pass-new');
            return;
        }
        if (pass !== confirmPass) {
            showStaffPassError('Parollar mos kelmadi', 'boss-pass-confirm');
            return;
        }
        const staffId = state.activeStaffId;
        if (!staffId) {
            showStaffPassError('Xodim tanlanmagan - oynani qayta oching');
            return;
        }
        if (!staffToken) {
            showStaffPassError('Sessiya topilmadi - qaytadan kiring');
            return;
        }
        const temporary = !!state.passWasGenerated;
        state.passSubmitting = true;
        setPassSubmitLoading(true);
        clearStaffPassError();
        try {
            const res = await fetch('/api/boss/staff/' + encodeURIComponent(staffId), {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    password: pass,
                    requirePasswordChange: temporary
                })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || (body.status && body.status !== 'success')) {
                showStaffPassError(body.message || 'Parolni yangilab bo\'lmadi');
                return;   // modal OCHIQ qoladi, kiritilgan qiymatlar saqlanadi
            }
            state.passSubmitting = false;   // endi yopish ruxsat etiladi
            if (temporary) {
                showStaffPassResult(pass);
                showNotif('success', 'Parol o\'rnatildi',
                    'Vaqtinchalik parolni xodimga xavfsiz yetkazing');
            } else {
                closeStaffPassModal();
                showNotif('success', 'Parol yangilandi',
                    'Xodimning barcha sessiyalari yopildi - yangi parol bilan kiring');
            }
            await loadStaff();
        } catch (e) {
            // Tarmoq/server uzilishi: modal va kiritilgan qiymatlar saqlanadi.
            showStaffPassError('Server bilan aloqa uzildi. O\'zgarish saqlanmagan '
                + 'bo\'lishi mumkin - qayta urinib ko\'ring');
        } finally {
            state.passSubmitting = false;
            setPassSubmitLoading(false);
        }
    }

    function openOwnPasswordModal() {
        ['boss-own-current', 'boss-own-new', 'boss-own-confirm'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = '';
            // Har qanday ochiq holatdan keyin qayta ochilganda yashirin (nuqtalar) boshlanadi
            el.type = 'password';
            const eye = document.getElementById(id + '-eye');
            if (eye) eye.className = 'fas fa-eye';
        });
        openModal('bossOwnPassModal');
    }

    async function submitOwnPassword() {
        const current = document.getElementById('boss-own-current')?.value || '';
        const next = document.getElementById('boss-own-new')?.value || '';
        const confirmPass = document.getElementById('boss-own-confirm')?.value || '';
        if (next.length < 6) { showNotif('error', 'Xatolik', 'Parol kamida 6 belgi'); return; }
        if (next !== confirmPass) { showNotif('error', 'Xatolik', 'Parollar mos kelmadi'); return; }
        const res = await fetch('/api/boss/password', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                currentPassword: current, newPassword: next, confirmPassword: confirmPass
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            showNotif('error', 'Xatolik', body.message || 'Parolni yangilab bo\'lmadi');
            return;
        }
        closeModal('bossOwnPassModal');
        showNotif('success', 'Yangilandi', body.message || 'Parol yangilandi');
        // Parol o'zgargani uchun sessiya yopiladi — qayta kiritish kerak.
        setTimeout(() => doLogout(), 1200);
    }

    /* ── 9b) Uch nuqtali boshqaruv menyusi (mobil kartochka) ── */

    /** Menyuni yopadi (element va holatni tozalaydi). */
    function closeStaffMenu() {
        const menu = document.getElementById('boss-staff-menu');
        if (menu) menu.hidden = true;
        if (state.staffMenuBtn) state.staffMenuBtn.setAttribute('aria-expanded', 'false');
        state.staffMenuId = null;
        state.staffMenuBtn = null;
    }

    /**
     * Kartochkadagi uch nuqtali menyu: amallar mavjud `data-boss-*`
     * attributlari orqali ishlaydi — yangi amal logikasi yaratilmaydi.
     * Ruxsat yetmaydigan amallar (o'zini bloklash/o'chirish, teng roldagi
     * akountni o'chirish) menyuda umuman ko'rsatilmaydi.
     * Menyu `position: fixed` bilan ekran chegarasi ichida joylashtiriladi.
     */
    function openStaffMenu(id, btn) {
        const menu = document.getElementById('boss-staff-menu');
        if (!menu || !btn) return;
        if (state.staffMenuId === String(id)) { closeStaffMenu(); return; } // qayta bosish — yopadi
        const row = findStaffRow(id);
        if (!row) return;
        const me = !!(currentUser && (String(row.id) === String(currentUser.id)
            || row.login === currentUser.login));
        const status = String(row.status || 'active').toLowerCase();
        const blocked = status === 'blocked';
        const inactive = status === 'inactive';
        const bossRole = String(row.role || '').toLowerCase() === 'boss';
        const canManage = canManageStaffRow(row);
        const items = [];
        if (canViewStaffSales(row)) {
        items.push(['data-boss-sale', 'fa-chart-line', 'Savdo statistikasi', '']);
        }
        if (isBoss() ? (!bossRole || me) : canManage) {
            items.unshift(['data-boss-edit', 'fa-pen-to-square', 'Tahrirlash', '']);
        }
        if (me && !isAdminStaffView() && !isManagerStaffView()) {
            items.push(['data-boss-ownpass', 'fa-key', 'O\'z parolimni o\'zgartirish', '']);
        } else if (canManage) {
            items.push(['data-boss-pass', 'fa-key',
                row.hasPassword ? 'Parolni almashtirish' : "Parol o'rnatish", '']);
            items.push(['data-boss-block', blocked ? 'fa-unlock' : inactive ? 'fa-rotate-left' : 'fa-ban',
                blocked ? 'Blokdan chiqarish' : inactive ? 'Faollashtirish' : 'Bloklash',
                blocked || inactive ? 'ok' : 'warn']);
            items.push(['data-boss-del', 'fa-box-archive', 'Arxivlash', 'danger']);
        }
        menu.innerHTML = items.map(([attr, icon, label, cls]) =>
            `<button type="button" role="menuitem" class="${cls}" ${attr}="${escapeHTML(String(id))}">`
            + `<i class="fas ${icon}"></i>${label}</button>`).join('');
        // Avvalgi holatni tozalab, ochamiz va joylashtiramiz.
        if (state.staffMenuBtn) state.staffMenuBtn.setAttribute('aria-expanded', 'false');
        state.staffMenuId = null;
        state.staffMenuBtn = null;
        menu.hidden = false;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        const edge = 10, gap = 8;
        let left = rect.right - mw;                       // tugmaning o'ng chetiga tekis
        if (left + mw > window.innerWidth - edge) left = window.innerWidth - mw - edge;
        if (left < edge) left = edge;
        let top = rect.bottom + gap;
        if (top + mh > window.innerHeight - edge) top = rect.top - mh - gap; // pastda joy yo'q — yuqoriga
        if (top < edge) top = Math.max(edge, window.innerHeight - mh - edge);
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
        state.staffMenuId = String(id);
        state.staffMenuBtn = btn;
        btn.setAttribute('aria-expanded', 'true');
    }

    /* ── 10b) Xodim savdolari sahifasiga o'tish ─────── */

    /** Xodimni joriy keshdagi ro'yxatlardan topadi (savdo bo'limi uchun). */
    function findStaffAnywhere(id) {
        const pools = [(state.cache.staff || {}).staff,
            (state.cache.salesOverview || {}).staff];
        for (const rows of pools) {
            const row = (rows || []).find(s => String(s.id) === String(id));
            if (row) return row;
        }
        return null;
    }

    /**
     * "Cheklari" tugmasi: savdo sahifasiga o'tib, tafsilot rejimini ochadi.
     * Xodimlar sahifasidan chaqirilsa — avvalo sahifaga o'tiladi.
     */
    function openStaffSales(staffId) {
        if (!staffId) return;
        if (isManagerStaffView()) {
            showNotif('error', 'Ruxsat yo\'q', 'Menejer xodimlar savdosi tafsilotlarini ko\'ra olmaydi');
            return;
        }
        const target = findStaffAnywhere(staffId);
        if (!canViewStaffSales(target)) {
            showNotif('error', 'Ruxsat yo\'q', isManagerStaffView()
                ? 'Menejer xodimlar savdosi tafsilotlarini ko\'ra olmaydi'
                : 'Bu xodimning savdo tafsilotlarini ko\'rish mumkin emas');
            return;
        }
        if (currentBossPage() !== 'bossStaffSales') {
            goTo('page-bossStaffSales', document.getElementById('nav-bossStaff'));
        }
        showSalesDetail(staffId);
        loadStaffSales(staffId);
    }

    /* ── 10c) Tafsilot modallari (chek / mahsulot / filial) ── */

    /** Ochiq chek — oxirgi xodim savdolaridan (qayta so'rovsiz). */
    function openReceiptModal(saleId) {
        const receipts = state.cache.lastReceipts || [];
        const r = receipts.find(x => String(x.saleId) === String(saleId));
        const title = document.getElementById('boss-receipts-title');
        const body = document.getElementById('boss-receipts-body');
        if (title) title.textContent = r ? `Chek #${r.saleId}` : 'Chek';
        if (!r) {
            if (body) body.innerHTML = emptyState('Chek topilmadi (sahifani yangilang)');
        } else {
            if (title) {
                title.textContent = `Chek #${r.saleId} — ${r.date || ''} ${r.time || ''}`;
            }
            if (body) body.innerHTML = `
                <div class="boss-sales-kpis">
                    <div><span>Xodim</span><strong>${escapeHTML(state.cache.lastReceiptsStaff || '—')}</strong></div>
                    <div><span>Filial</span><strong>${escapeHTML(r.branchName || '—')}</strong></div>
                    <div><span>To'lov</span><strong>${escapeHTML(r.pay || '—')}</strong></div>
                    <div><span>Mijoz</span><strong>${escapeHTML(r.customer || '—')}</strong></div>
                    <div><span>Jami</span><strong>${fmt(r.total || 0)} so'm</strong></div>
                    <div><span>Foyda</span><strong>${fmt(r.profit || 0)} so'm</strong></div>
                </div>
                <div class="boss-lines"><table><thead><tr>
                    <th>Mahsulot</th><th>Soni</th><th>Narxi</th><th>Jami</th>
                </tr></thead><tbody>
                ${(r.items || []).map(i => `<tr>
                    <td data-label="Mahsulot">${escapeHTML(i.name)}</td><td data-label="Soni">${i.qty}</td>
                    <td data-label="Narxi">${fmt(i.price)} so'm</td><td data-label="Jami">${fmt(i.total)} so'm</td></tr>`).join('')
                || `<tr><td colspan="4">${emptyState('Mahsulot qatorlari yo\'q')}</td></tr>`}
                </tbody></table></div>`;
        }
        openModal('bossReceiptsModal');
    }

    /** Mahsulot kartasidan ochiladigan tafsilot. */
    function openProductModal(index) {
        const rows = (state.cache.productsData || {}).products || [];
        const r = rows[Number(index)];
        const body = document.getElementById('boss-product-body');
        if (!body) return;
        if (!r) {
            body.innerHTML = emptyState('Mahsulot topilmadi');
            openModal('bossProductModal');
            return;
        }
        body.innerHTML = `
            <div class="boss-modal-note" style="margin:0 0 12px"><strong>${escapeHTML(r.name)}</strong>
                ${r.brand ? ` · ${escapeHTML(r.brand)}` : ''}</div>
            <div class="boss-detail-grid">
                <div><span>Kategoriya</span><strong>${escapeHTML(r.cat || '—')}</strong></div>
                <div><span>Narxi</span><strong>${fmt(r.price || 0)} so'm</strong></div>
                <div><span>Qoldiq</span><strong>${r.stock || 0} dona</strong></div>
                <div><span>Filial</span><strong>${escapeHTML(r.branchName || '—')}</strong></div>
                <div><span>Sotilgan</span><strong>${r.soldUnits || 0} dona</strong></div>
                <div><span>Tushum</span><strong>${fmt(r.soldAmount || 0)} so'm</strong></div>
            </div>
            ${(r.soldBy || []).length ? `<div class="boss-modal-note">
                <i class="fas fa-users"></i> Sotgan xodimlar:
                ${r.soldBy.map(x => `${escapeHTML(x.staff)} (${x.units} dona)`).join(', ')}</div>`
                : '<div class="boss-modal-note">Bu davrda sotilgan yozuv yo\'q.</div>'}`;
        openModal('bossProductModal');
    }

    /** Filial qatoridan ochiladigan tafsilot + uning mahsulotlari. */
    async function openBranchModal(branchId) {
        const rows = (state.cache.branchesData || {}).branches || [];
        const b = rows.find(x => String(x.id) === String(branchId));
        const title = document.getElementById('boss-branch-modal-title');
        const body = document.getElementById('boss-branch-body');
        if (!body) return;
        if (title) title.textContent = b ? b.name : "Filial ma'lumoti";
        if (!b) { body.innerHTML = emptyState('Filial topilmadi'); openModal('bossBranchModal'); return; }
        body.innerHTML = `
            <div class="boss-detail-grid">
                <div><span>Holat</span><strong>${statusBadge(b.status)}</strong></div>
                <div><span>Xodimlar</span><strong>${b.staffActive || 0} / ${b.staffCount || 0}</strong></div>
                <div><span>Mahsulotlar</span><strong>${b.productCount || 0} ta</strong></div>
                <div><span>Ombor qiymati</span><strong>${fmt(b.stockValue || 0)} so'm</strong></div>
                <div><span>Bugungi savdo</span><strong>${fmt(b.todaySales || 0)} so'm</strong></div>
                <div><span>Oylik savdo</span><strong>${fmt(b.monthSales || 0)} so'm</strong></div>
                <div><span>Davr savdosi</span><strong>${fmt(b.revenue || 0)} so'm</strong></div>
                <div><span>Foyda</span><strong>${fmt(b.profit || 0)} so'm</strong></div>
            </div>
            ${b.address ? `<div class="boss-modal-note"><i class="fas fa-location-dot"></i>
                ${escapeHTML(b.address)}</div>` : ''}
            ${b.phone ? `<div class="boss-modal-note"><i class="fas fa-phone"></i>
                ${escapeHTML(b.phone)}</div>` : ''}
            <div class="boss-modal-note" id="boss-branch-products">
                <i class="fas fa-spinner fa-spin"></i> Filial mahsulotlari yuklanmoqda...</div>`;
        openModal('bossBranchModal');

        // Filialning eng ko'p sotilgan mahsulotlari — real API'dan.
        const data = await api('/api/boss/products?period=' + encodeURIComponent(state.period)
            + '&branchId=' + encodeURIComponent(String(branchId))
            + '&view=top&limit=8');
        const box = document.getElementById('boss-branch-products');
        if (!box) return;
        if (!data) { box.innerHTML = "Mahsulotlarni olib bo'lmadi."; return; }
        const items = (data.products || []).filter(p => (p.soldUnits || 0) > 0);
        box.innerHTML = items.length
            ? `<i class="fas fa-box-open"></i> <strong>Top mahsulotlar:</strong> `
              + items.map(p => `${escapeHTML(p.name)} (${p.soldUnits} dona — `
                  + `${fmt(p.soldAmount || 0)} so'm)`).join(' · ')
            : '<i class="fas fa-box"></i> Bu davrda sotilgan mahsulot yo\'q.';
    }

    /* ── 11) Hodisa boshqaruvi ───────────────────────── */

    function bind() {
        if (bind.done) return;
        bind.done = true;

        // Parol oynasi yopilganda maxfiy qiymat DOM'da qolmasin. Bu har qanday
        // yopilish yo'lini (tugma, Escape, tashqi closeModal) qamrab oladi.
        const passModal = document.getElementById('bossPassModal');
        if (passModal && typeof MutationObserver === 'function') {
            const passObserver = new MutationObserver(() => {
                if (!passModal.classList.contains('open')) clearStaffPassSensitive();
            });
            passObserver.observe(passModal, { attributes: true, attributeFilter: ['class'] });
        }
        ['boss-pass-new', 'boss-pass-confirm'].forEach(id => {
            const input = document.getElementById(id);
            if (!input) return;
            input.addEventListener('input', () => {
                // Qo'lda kiritilgan parol «vaqtinchalik» hisoblanmaydi.
                if (state.passWasGenerated) {
                    state.passWasGenerated = false;
                    const policy = document.getElementById('boss-pass-policy');
                    if (policy) policy.innerHTML =
                        '<i class="fas fa-circle-info" aria-hidden="true"></i> Kamida 6 belgi';
                }
            });
        });
        passModal?.addEventListener('click', ev => {
            if (ev.target === passModal) closeStaffPassModal();
        });

        document.addEventListener('keydown', ev => {
            if (ev.target.id === 'boss-new-phone' && ev.target.selectionStart === ev.target.selectionEnd) {
                const input = ev.target;
                const caret = input.selectionStart;
                if (ev.key === 'Backspace' && caret > 1 && input.value[caret - 1] === ' ') {
                    input.setSelectionRange(caret - 2, caret - 1);
                } else if (ev.key === 'Delete' && caret < input.value.length - 1
                    && input.value[caret] === ' ') {
                    input.setSelectionRange(caret + 1, caret + 2);
                }
            }
            if (ev.key !== 'Escape') return;
            if (passModal?.classList.contains('open')) {
                closeStaffPassModal();
                return;
            }
            if (state.staffMenuId) closeStaffMenu();
        });

        document.addEventListener('click', async (ev) => {
            // ── Uch nuqtali menyu boshqaruvi ─────────────────────────
            const menuBtn = ev.target.closest('[data-boss-menu]');
            if (ev.target.closest('#boss-staff-menu')) {
                closeStaffMenu();   // menyudagi bosish: avval yopiladi, keyin amal ishlaydi
            } else if (!menuBtn && state.staffMenuId) {
                closeStaffMenu();   // tashqaridagi har qanday bosish — menyu yopiladi
            }
            if (menuBtn) { openStaffMenu(menuBtn.dataset.bossMenu, menuBtn); return; }

            const edit = ev.target.closest('[data-boss-edit]');
            if (edit) { await openEditStaff(edit.dataset.bossEdit); return; }

            // Holat filtri (Barchasi / Faol / Bloklangan / Nofaol) — SERVERDA.
            const pill = ev.target.closest('[data-staff-status]');
            if (pill) {
                state.staffStatus = pill.dataset.staffStatus || '';
                document.querySelectorAll('[data-staff-status]').forEach(p =>
                    p.classList.toggle('active', p === pill));
                const desktopStatus = document.getElementById('boss-staff-status');
                if (desktopStatus) desktopStatus.value = state.staffStatus;
                loadStaff();
                return;
            }

            // Qo'shimcha filtrlar paneli (mobil slayder tugmasi).
            const advBtn = ev.target.closest('[data-boss-staff-adv]');
            if (advBtn) {
                const adv = document.getElementById('boss-staff-m-adv');
                const show = !!adv && adv.hidden;
                if (adv) adv.hidden = !show;
                advBtn.classList.toggle('on', show);
                advBtn.setAttribute('aria-expanded', String(show));
                return;
            }

            const chip = ev.target.closest('[data-boss-period]');
            if (chip) { setPeriod(chip.dataset.bossPeriod); return; }

            const nav = ev.target.closest('[data-boss-goto]');
            if (nav) { goTo(nav.dataset.bossGoto, nav); return; }

            const sale = ev.target.closest('[data-boss-sale]');
            if (sale) { openStaffSales(sale.dataset.bossSale); return; }

            // Savdo sahifasi: umumiy ko'rinishga qaytish.
            if (ev.target.closest('#boss-sales-back')) {
                showSalesOverview();
                loadStaffSalesOverview();
                return;
            }

            // Tafsilot modallari: chek, mahsulot, filial.
            const rec = ev.target.closest('[data-boss-receipt]');
            if (rec) { openReceiptModal(rec.dataset.bossReceipt); return; }

            const prod = ev.target.closest('[data-boss-product]');
            if (prod) { openProductModal(prod.dataset.bossProduct); return; }

            const brRow = ev.target.closest('[data-boss-branch]');
            if (brRow) { openBranchModal(brRow.dataset.bossBranch); return; }

            // Audit manba chip'lari (Barchasi / Boshliq / Xavfsizlik).
            const src = ev.target.closest('[data-boss-audit-src]');
            if (src) {
                state.auditSource = src.dataset.bossAuditSrc || '';
                (src.parentElement || document).querySelectorAll('.boss-chip')
                    .forEach(c => c.classList.remove('active'));
                src.classList.add('active');
                loadAudit();
                return;
            }

            const pass = ev.target.closest('[data-boss-pass]');
            if (pass) { openPassModal(pass.dataset.bossPass); return; }

            const block = ev.target.closest('[data-boss-block]');
            if (block) { await toggleBlock(block.dataset.bossBlock); return; }

            const del = ev.target.closest('[data-boss-del]');
            if (del) { await deleteStaff(del.dataset.bossDel); return; }

            const view = ev.target.closest('[data-boss-view]');
            if (view) {
                state.productView = view.dataset.bossView;
                (view.parentElement || document).querySelectorAll('.boss-chip')
                    .forEach(c => c.classList.remove('active'));
                view.classList.add('active');
                loadProducts();
                return;
            }

            const copyBtn = ev.target.closest('[data-boss-copy]');
            if (copyBtn) {
                copyText(copyBtn.dataset.bossCopy,
                    copyBtn.dataset.bossCopyLabel || 'Login nusxalandi');
                return;
            }

            if (ev.target.closest('[data-boss-export]')) { await exportReportsCsv(); return; }
            if (ev.target.closest('[data-boss-add]')) { openAddStaff(); return; }
            if (ev.target.closest('[data-boss-ownpass]')) { openOwnPasswordModal(); return; }
            if (ev.target.closest('[data-boss-refresh]')) { refreshCurrent(); return; }
        });

        // Real-time qidiruv (debounce bilan).
        document.addEventListener('input', (ev) => {
            if (ev.target.id === 'boss-new-phone') {
                formatStaffPhoneInput(ev.target);
                return;
            }
            // Oylik maosh: faqat raqamlar + avtomatik minglik ajratgich.
            if (ev.target.id === 'boss-new-salary') {
                const el = ev.target;
                const end = el.selectionEnd === null || el.selectionEnd === undefined;
                el.value = formatSalaryInput(el.value);
                if (!end) {
                    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { }
                }
                return;
            }
            if (ev.target.id === 'boss-staff-search' || ev.target.id === 'boss-staff-search-m') {
                state.staffQuery = ev.target.value || '';
                // desktop/mobil qidiruv maydonlari bir xil holatda qoladi.
                const otherId = ev.target.id === 'boss-staff-search'
                    ? 'boss-staff-search-m' : 'boss-staff-search';
                const other = document.getElementById(otherId);
                if (other && other.value !== state.staffQuery) other.value = state.staffQuery;
                clearTimeout(bind.t1);
                bind.t1 = setTimeout(loadStaff, 300);
            }
            if (ev.target.id === 'boss-product-search') {
                state.productQuery = ev.target.value || '';
                clearTimeout(bind.t2);
                bind.t2 = setTimeout(loadProducts, 300);
            }
            if (ev.target.id === 'boss-sales-search') {
                state.salesQuery = ev.target.value || '';
                clearTimeout(bind.t3);
                bind.t3 = setTimeout(loadStaffSalesOverview, 300);
            }
            if (ev.target.id === 'boss-audit-search') {
                state.auditQuery = ev.target.value || '';
                clearTimeout(bind.t4);
                bind.t4 = setTimeout(loadAudit, 300);
            }
            if (ev.target.id === 'boss-report-staff') {
                state.reportStaff = ev.target.value || '';
                clearTimeout(bind.t5);
                bind.t5 = setTimeout(loadReports, 350);
            }
            if (ev.target.id === 'boss-report-product') {
                state.reportProduct = ev.target.value || '';
                clearTimeout(bind.t6);
                bind.t6 = setTimeout(loadReports, 350);
            }
        });

        document.addEventListener('change', (ev) => {
            const id = ev.target.id;
            if (id === 'boss-staff-role' || id === 'boss-staff-role-m') {
                state.staffRole = ev.target.value;
                const other = document.getElementById(id === 'boss-staff-role' ? 'boss-staff-role-m' : 'boss-staff-role');
                if (other && other.value !== state.staffRole) other.value = state.staffRole;
                loadStaff();
            }
            if (id === 'boss-staff-sort' || id === 'boss-staff-sort-m') {
                state.staffSort = ev.target.value;
                const other = document.getElementById(id === 'boss-staff-sort' ? 'boss-staff-sort-m' : 'boss-staff-sort');
                if (other && other.value !== state.staffSort) other.value = state.staffSort;
                loadStaff();
            }
            if (id === 'boss-staff-branch' || id === 'boss-staff-branch-m') {
                state.staffBranch = ev.target.value;
                const other = document.getElementById(id === 'boss-staff-branch'
                    ? 'boss-staff-branch-m' : 'boss-staff-branch');
                if (other && other.value !== state.staffBranch) other.value = state.staffBranch;
                loadStaff();
            }
            if (id === 'boss-staff-status') {
                state.staffStatus = ev.target.value;
                document.querySelectorAll('[data-staff-status]').forEach(p =>
                    p.classList.toggle('active', (p.dataset.staffStatus || '') === state.staffStatus));
                loadStaff();
            }
            if (id === 'boss-product-cat') { state.productCat = ev.target.value; loadProducts(); }
            if (id === 'boss-report-branch') { state.reportBranch = ev.target.value; loadReports(); }
            if (id === 'boss-report-cat') { state.reportCat = ev.target.value; loadReports(); }
            if (id === 'boss-sales-branch') { state.salesBranch = ev.target.value; loadStaffSalesOverview(); }
            if (id === 'boss-finance-branch') { state.financeBranch = ev.target.value; loadFinance(); }

            // Maxsus sana filtrlari (dan–gacha): chip'lar befaol bo'ladi.
            if (id === 'boss-sales-from' || id === 'boss-sales-to'
                || id === 'boss-finance-from' || id === 'boss-finance-to'
                || id === 'boss-report-from' || id === 'boss-report-to') {
                syncCustomDates();
                if (id.startsWith('boss-sales')) loadStaffSalesOverview();
                else if (id.startsWith('boss-finance')) loadFinance();
                else loadReports();
            }
        });

        // Ekran o'lchami o'zgarganda (kartochka ↔ jadval) ro'yxat qayta chiziladi.
        // MediaQueryList state'da doimiy saqlanadi (GC uchun); resize hodisasi
        // ham, ResizeObserver ham syncStaffMode'ni chaqiradi — u rejim
        // o'zgarmagan bo'lsa hech narsa qilmaydi.
        if (typeof window.matchMedia === 'function') {
            state.mqStaff = window.matchMedia('(max-width: 768px)');
            const onStaffMq = () => syncStaffMode();
            if (state.mqStaff.addEventListener) state.mqStaff.addEventListener('change', onStaffMq);
            else if (state.mqStaff.addListener) state.mqStaff.addListener(onStaffMq);
        }
        // Menyu ochiq turganda scroll/resize'da joyidan chiqmasligi uchun yopiladi.
        // Resize → darhol + 150ms dan keyin yana bir marta sinxronizatsiya:
        // ba'zi muhitlarda resize hodisasi layout yangilanishidan OLDIN keladi —
        // kechikgan zaxira chaqiruvi shunday holatda ham rejimni to'g'rilaydi.
        // syncStaffMode rejim o'zgarmagan bo'lsa hech narsa qilmaydi.
        window.addEventListener('resize', () => {
            closeStaffMenu();
            syncStaffMode();
            clearTimeout(bind.tMode);
            bind.tMode = setTimeout(syncStaffMode, 150);
        });
        // Eng ishonchli zaxira: haqiqiy layout o'zgarishini ResizeObserver
        // kuzatadi (window resize hodisasi birinchi o'zgarishga yetib kelmasa
        // ham RO layoutdan keyin chaqiriladi va rejimni to'g'rilaydi).
        if (typeof ResizeObserver === 'function') {
            state.roStaff = new ResizeObserver(() => syncStaffMode());
            state.roStaff.observe(document.documentElement);
        }
        document.addEventListener('scroll', () => closeStaffMenu(), true);
    }

    function readDate(id) {
        const el = document.getElementById(id);
        return el ? (el.value || '') : '';
    }

    /**
     * Barcha sana kiritishlarini keshga oladi va `customActive` holatini
     * yangilaydi — period chip'lari shu holatda faol emas.
     */
    function syncCustomDates() {
        state.salesFrom = readDate('boss-sales-from');
        state.salesTo = readDate('boss-sales-to');
        state.financeFrom = readDate('boss-finance-from');
        state.financeTo = readDate('boss-finance-to');
        state.reportFrom = readDate('boss-report-from');
        state.reportTo = readDate('boss-report-to');
        state.customActive = !!(state.salesFrom || state.salesTo
            || state.financeFrom || state.financeTo
            || state.reportFrom || state.reportTo);
        paintPeriodChips();
    }

    function refreshCurrent() {
        state.cache = {};
        onPageOpen(currentBossPage());
    }

    function currentBossPage() {
        const active = document.querySelector('.page.active');
        return active ? active.id.replace(/^page-/, '') : 'boss';
    }

    bind();

    return {
        state, api, onPageOpen, load, render, setPeriod, refreshCurrent,
        loadStaff, renderRankingPanel, openStaffSales, loadStaffSales,
        loadStaffSalesOverview, showSalesOverview, showSalesDetail,
        loadProducts, loadBranches, loadFinance, loadReports, loadAudit,
        loadFinanceCharts, renderCharts, paintCharts,
        openReceiptModal, openProductModal, openBranchModal,
        createStaff, deleteStaff, toggleBlock, submitStaffPassword, openPassModal,
        closeStaffPassModal, generateStaffPassword, copyGeneratedStaffPassword,
        toggleResultPassword,
        rerenderStaffTable,
        openEditStaff, openStaffMenu, closeStaffMenu, renderStaffList,
        openAddStaff, refreshSalaryPlan,
        toggleNewPassword, generatePassword, copyCredentials, resetNewStaffForm,
        showNewStaffCredentials, copyText, toggleOwnPassField,
        submitOwnPassword, openOwnPasswordModal, exportReportsCsv,
        paintPeriodChips, periodChips, syncCustomDates
    };
})();
