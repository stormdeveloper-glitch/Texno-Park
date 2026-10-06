# -*- coding: utf-8 -*-
"""index.html ga Boshliq integratsiyasini qo'shadi (bosqichma-bosqich)."""
import io
import sys

P = 'index.html'


def read():
    return io.open(P, encoding='utf-8').read()


def write(text):
    io.open(P, 'w', encoding='utf-8', newline='').write(text)


def sub(text, old, new, label):
    if new in text and old not in text:
        print(f'[skip] {label} — allaqon qo\'shilgan')
        return text
    if old not in text:
        print(f'[FAIL] {label} — topilmadi: {old[:60]!r}')
        sys.exit(1)
    print(f'[ok]   {label}')
    return text.replace(old, new, 1)


html = read()

# 1) boss.css — mavjud dizayn tizimi ustiga qo'shimcha uslublar
html = sub(html,
           '<link rel="stylesheet" href="style.css?v=5.10.1">',
           '<link rel="stylesheet" href="style.css?v=5.10.1">\n'
           '  <link rel="stylesheet" href="boss.css?v=1.0.0">',
           'boss.css ulanmoqda')

# 2) boss.js — Boshliq moduli (scripts.js dan KEYIN yuklanadi)
html = sub(html,
           '<script src="scripts.js?v=1.4.6-navfix"></script>',
           '<script src="scripts.js?v=1.4.6-navfix"></script>\n'
           '  <script src="boss.js?v=1.0.0"></script>',
           'boss.js ulanmoqda')

# ── 3) SIDEBAR: Boshliq bo'limlari ──────────────────────────────
# Boshliq eng yuqori rol — uning bo'limlari `data-role="boss"` bilan
#faqat unga ko'rinadi. Boshqa rollar uchun hech narsa o'zgarmaydi.
BOSS_NAV = '''
        <!-- ===== BOSHLIQ (faqat Boshliq roli) ===== -->
        <div class="nav-section boss-only" data-role="boss"><span class="nav-section-label">Boshliq</span></div>
        <div class="nav-item boss-only" onclick="goTo('page-boss',this)" id="nav-boss" data-role="boss">
          <i class="fas fa-crown"></i><span>Boshliq Dashboard</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossStaff',this)" id="nav-bossStaff" data-role="boss">
          <i class="fas fa-users-gear"></i><span>Xodimlar</span>
          <span class="nav-badge" id="navBossStaffBadge">0</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossStaffSales',this)" id="nav-bossStaffSales" data-role="boss">
          <i class="fas fa-receipt"></i><span>Xodim savdosi</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossProducts',this)" id="nav-bossProducts" data-role="boss">
          <i class="fas fa-boxes-stacked"></i><span>Mahsulotlar</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossBranches',this)" id="nav-bossBranches" data-role="boss">
          <i class="fas fa-chart-column"></i><span>Filiallar</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossFinance',this)" id="nav-bossFinance" data-role="boss">
          <i class="fas fa-sack-dollar"></i><span>Moliya</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossReports',this)" id="nav-bossReports" data-role="boss">
          <i class="fas fa-file-invoice-dollar"></i><span>Hisobotlar</span>
        </div>
        <div class="nav-item boss-only" onclick="goTo('page-bossAudit',this)" id="nav-bossAudit" data-role="boss">
          <i class="fas fa-clipboard-list"></i><span>Amallar jurnali</span>
        </div>
'''

html = sub(html,
           '      </nav>\n      <div class="sidebar-footer">',
           BOSS_NAV + '      </nav>\n      <div class="sidebar-footer">',
           'Boshliq sidebar bo\'limlari')

write(html)
print('sidebar tayyor')

# ── 4) BOSHLIQ SAHIFALARI (1-qism: dashboard, xodimlar, savdo) ──
# Barcha kontent `boss.js` orqali `/api/boss/*` dan chiziladi, shuning
# uchun bu yerda faqat skelet (konteynerlar + filterlar) bor.
BOSS_PAGES = '''
      <!-- ===== BOSH.LIQ BO'LIMLARI (faqat boshlq roli) ===== -->
      <div class="page" id="page-boss">
        <div id="boss-dashboard"></div>
      </div>

      <div class="page" id="page-bossStaff">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-users-gear"></i> Xodimlar nazorati</h2>
            <p>Barcha xodimlar, reytingi va boshqaruvi</p></div>
          <div class="boss-period" id="boss-staff-period"></div>
        </div>
        <div class="boss-toolbar">
          <input type="search" class="form-control boss-search" id="boss-staff-search"
            placeholder="🔍 Ism, telefon yoki rol bo'yicha qidirish..." autocomplete="off">
          <select class="form-control" id="boss-staff-role" aria-label="Rol filtri">
            <option value="">Barcha rollar</option>
            <option value="boss">Boshliq</option>
            <option value="admin">Admin</option>
            <option value="manager">Menejer</option>
            <option value="cashier">Kassa</option>
          </select>
          <select class="form-control" id="boss-staff-sort" aria-label="Saralash">
            <option value="total">Savdo summasi</option>
            <option value="sales">Savdo soni</option>
            <option value="units">Sotilgan dona</option>
            <option value="profit">Foyda</option>
            <option value="avgCheck">O'rtacha chek</option>
            <option value="name">Ism</option>
          </select>
          <span class="boss-count" id="boss-staff-count"></span>
          <button class="btn btn-outline" data-boss-refresh><i class="fas fa-rotate"></i></button>
          <button class="btn btn-outline" data-boss-ownpass><i class="fas fa-key"></i> Parolimni o'zgartirish</button>
          <button class="btn btn-primary" data-boss-add><i class="fas fa-user-plus"></i> Xodim qo'shish</button>
        </div>
        <div class="boss-panel">
          <div class="table-wrap">
            <table class="boss-table">
              <thead><tr>
                <th>#</th><th>Xodim</th><th>Telefon</th><th>Rol</th><th>Filial</th>
                <th>Sotuvlar</th><th>Savdo summasi</th><th>Holat</th><th>Amallar</th>
              </tr></thead>
              <tbody id="boss-staff-table"></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="page" id="page-bossStaffSales">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-receipt"></i> <span id="boss-sales-title">Xodim savdosi</span></h2>
            <p>Kim qancha va nima sotganini ko'rsatadi</p></div>
          <button class="btn btn-outline" onclick="goTo('page-bossStaff',document.getElementById('nav-bossStaff'))">
            <i class="fas fa-arrow-left"></i> Xodimlar</button>
        </div>
        <div id="boss-sales-box"></div>
      </div>
'''

BOSS_PAGES2 = '''
      <div class="page" id="page-bossProducts">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-boxes-stacked"></i> Mahsulotlar nazorati</h2>
            <p>Mahsulotlar, top sotuvchilar va kam qoldiqlar</p></div>
          <div class="boss-period" id="boss-products-period"></div>
        </div>
        <div class="boss-toolbar">
          <input type="search" class="form-control boss-search" id="boss-product-search"
            placeholder="🔍 Mahsulot nomi, brend yoki barkod..." autocomplete="off">
          <select class="form-control" id="boss-product-cat" aria-label="Kategoriya"></select>
          <div class="boss-view-chips">
            <button class="boss-chip active" data-boss-view="all">Barchasi</button>
            <button class="boss-chip" data-boss-view="top">Top mahsulotlar</button>
            <button class="boss-chip" data-boss-view="low">Kam qolganlar</button>
          </div>
          <span class="boss-count" id="boss-products-count"></span>
        </div>
        <div id="boss-products-box"></div>
      </div>

      <div class="page" id="page-bossBranches">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-chart-column"></i> Filiallar solishtirish</h2>
            <p>Qaysi filial yaxshi ishlayapti?</p></div>
          <div class="boss-period" id="boss-branches-period"></div>
        </div>
        <div id="boss-branches-box"></div>
      </div>

      <div class="page" id="page-bossFinance">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-sack-dollar"></i> Moliyaviy nazorat</h2>
            <p>Savdo, kirim, chiqim, xarajat va sof natija</p></div>
          <div class="boss-period" id="boss-finance-period"></div>
        </div>
        <div id="boss-finance-box"></div>
      </div>

      <div class="page" id="page-bossReports">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-file-invoice-dollar"></i> Boshliq hisobotlari</h2>
            <p>Sana, filial, xodim, mahsulot va kategoriya filtrlari</p></div>
          <div class="boss-period" id="boss-reports-period"></div>
        </div>
        <div class="boss-toolbar">
          <input type="search" class="form-control boss-search" id="boss-report-staff"
            placeholder="Xodim ismi..." autocomplete="off">
          <input type="search" class="form-control boss-search" id="boss-report-product"
            placeholder="Mahsulot nomi..." autocomplete="off">
          <select class="form-control" id="boss-report-branch"><option value="">Barcha filiallar</option></select>
          <select class="form-control" id="boss-report-cat"><option value="">Barcha kategoriyalar</option></select>
          <button class="btn btn-outline" data-boss-export><i class="fas fa-file-csv"></i> CSV eksport</button>
        </div>
        <div id="boss-reports-box"></div>
      </div>

      <div class="page" id="page-bossAudit">
        <div class="boss-page-head">
          <div><h2><i class="fas fa-clipboard-list"></i> Amallar jurnali</h2>
            <p>Boshliq tomonidan qilingan muhim amallar (parol yozilmaydi)</p></div>
          <button class="btn btn-outline" data-boss-refresh><i class="fas fa-rotate"></i> Yangilash</button>
        </div>
        <div id="boss-audit-box"></div>
      </div>
'''
BOSS_PAGES += BOSS_PAGES2

html = sub(html,
           '      <!-- ===== EMPLOYEES ===== -->',
           BOSS_PAGES + '\n      <!-- ===== EMPLOYEES ===== -->',
           'Boshliq sahifalari')

write(html)
# ── 5) BOSHLIQ MODALLARI ────────────────────────────────────────
# Parol maydonlari `type="password"` — qiymat hech qayerda saqlanmaydi.
BOSS_MODALS = '''
  <!-- ===== BOSH.LIQ MODALLARI (faqat boshlq roli) ===== -->
  <div class="modal" id="bossStaffModal">
    <div class="modal-box">
      <div class="modal-head">
        <h3><i class="fas fa-user-plus"></i> Xodim qo'shish</h3>
        <button class="modal-close" onclick="closeModal('bossStaffModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="boss-form">
          <label class="form-group"><span>Ism <b>*</b></span>
            <input type="text" class="form-control" id="boss-new-name" maxlength="120" autocomplete="off"></label>
          <label class="form-group"><span>Telefon</span>
            <input type="tel" class="form-control" id="boss-new-phone" placeholder="+998 90 123 45 67" autocomplete="off"></label>
          <label class="form-group"><span>Rol <b>*</b></span>
            <select class="form-control" id="boss-new-role">
              <option value="cashier">CASHIER</option>
              <option value="manager">MANAGER</option>
              <option value="admin">ADMIN</option>
            </select>
            <small>Boshliq roli bu yo'l bilan tayinlanmaydi.</small></label>
          <label class="form-group"><span>Filial</span>
            <select class="form-control" id="boss-new-branch"><option value="">Filialsiz</option></select></label>
          <label class="form-group"><span>Status</span>
            <select class="form-control" id="boss-new-status">
              <option value="active">Faol</option>
              <option value="blocked">Bloklangan</option>
            </select></label>
          <label class="form-group"><span>Parol <b>*</b></span>
            <input type="password" class="form-control" id="boss-new-password" minlength="6"
              autocomplete="new-password" placeholder="Kamida 6 belgi"></label>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" onclick="closeModal('bossStaffModal')">Bekor qilish</button>
        <button class="btn btn-primary" onclick="Boss.createStaff()">Saqlash</button>
      </div>
    </div>
  </div>

  <div class="modal" id="bossPassModal">
    <div class="modal-box">
      <div class="modal-head">
        <h3><i class="fas fa-key"></i> Parolni o'zgartirish</h3>
        <button class="modal-close" onclick="closeModal('bossPassModal')">&times;</button>
      </div>
      <div class="modal-body">
        <p class="boss-modal-note">Xodim: <strong id="boss-pass-name"></strong></p>
        <label class="form-group"><span>Yangi parol <b>*</b></span>
          <input type="password" class="form-control" id="boss-pass-new" minlength="6"
            autocomplete="new-password" placeholder="Kamida 6 belgi"></label>
        <p class="boss-modal-note">Parol serverda xeshlanib saqlanadi. Xodimning sessiyalari yopiladi.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" onclick="closeModal('bossPassModal')">Bekor qilish</button>
        <button class="btn btn-primary" onclick="Boss.submitStaffPassword()">Saqlash</button>
      </div>
    </div>
  </div>

  <div class="modal" id="bossOwnPassModal">
    <div class="modal-box">
      <div class="modal-head">
        <h3><i class="fas fa-shield-halved"></i> O'z parolini o'zgartirish</h3>
        <button class="modal-close" onclick="closeModal('bossOwnPassModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="boss-form">
          <label class="form-group"><span>Joriy parol <b>*</b></span>
            <input type="password" class="form-control" id="boss-own-current" autocomplete="current-password"></label>
          <label class="form-group"><span>Yangi parol <b>*</b></span>
            <input type="password" class="form-control" id="boss-own-new" minlength="6" autocomplete="new-password"></label>
          <label class="form-group"><span>Tasdiqlash <b>*</b></span>
            <input type="password" class="form-control" id="boss-own-confirm" minlength="6" autocomplete="new-password"></label>
        </div>
        <p class="boss-modal-note">Parol o'zgargach barcha sessiyalar yopiladi — qayta kiring.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" onclick="closeModal('bossOwnPassModal')">Bekor qilish</button>
        <button class="btn btn-primary" onclick="Boss.submitOwnPassword()">Saqlash</button>
      </div>
    </div>
  </div>
'''

html = sub(html, '  <!-- ===== REPORT MODAL ===== -->',
           BOSS_MODALS + '\n  <!-- ===== REPORT MODAL ===== -->',
           'Boshliq modallari')

write(html)
print('modallar tayyor')
print('sahifalar tayyor')