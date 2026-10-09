"""CHEGIRMA + PROMO-KOD tizimini qo'shadi (scripts.js + index.html).

MUAMMO (aniqlangan): chegirmalar sahifasida yaratish UI umuman yo'q edi,
BUNDAN TASHQARI saqlash yo'li ham yo'q edi — `buildSyncPayload()` chegirmalarni
localStorage'dagi `tp_discounts` dan o'qiydi, lekin `tp_discounts` ni hech kim
yozmasdi. Shu sababli chegirma hech qachon bazaga tushmasdi.

QO'SHILADI:
  1. Kampaniya CRUD (yaratish / tahrirlash / o'chirish) — promo kod, foiz, holat;
  2. Saqlash yo'li: localStorage `tp_discounts` + /api/sync;
  3. Kassada promo kodni qo'llash (mavjud chegirma mexanizmidan foydalanadi);
  4. Yagona validatsiya: kod formati, takrorlanmaslik, foiz chegarasi.

Ishlayotgan kod buzilmaydi: mavjud `#discountInput`/`posSetDiscount`,
render va sync mexanizmlari o'z holida qoladi. CRLF saqlanadi.
"""
import re
import sys

JS = 'scripts.js'
HTML = 'index.html'
NEW_VER = 'scripts.js?v=1.4.13'
OLD_VER = 'scripts.js?v=1.4.12'

# ─────────────────────────── scripts.js ───────────────────────────

JS_DECL_OLD = (
    "let discountCampaigns = safeJsonParse(localStorage.getItem('tp_discounts') || '[]', []);\r\n"
    "if (!Array.isArray(discountCampaigns)) discountCampaigns = [];\r\n"
)
JS_DECL_NEW = (
    "let discountCampaigns = safeJsonParse(localStorage.getItem('tp_discounts') || '[]', []);\r\n"
    "if (!Array.isArray(discountCampaigns)) discountCampaigns = [];\r\n"
    "// Saqlangan yozuvlarni xavfsiz shaklga keltiramiz (yaroqsizlari tashlanadi).\r\n"
    "discountCampaigns = discountCampaigns.map(normalizeDiscount).filter(Boolean);\r\n"
)

# renderDiscountsPage() o'rniga: yangi render + CRUD funksiyalari
JS_NEW_BLOCK = """let editingDiscountId = null;

/** Promo kodni yagona ko'rinishga keltiradi: katta harf, faqat A-Z 0-9 _ - */
function discountNormalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

/** Yaroqli holat qiymatlari (funksiya — yuklanish paytida ham xavfsiz). */
function discountStatusList() {
    return ['Faol', 'Nofaol'];
}

/** Kampaniyani saqlash uchun xavfsiz shaklga keltiradi. */
function normalizeDiscount(d) {
    if (!d || typeof d !== 'object') return null;
    const name = cleanText(d.name, 80).trim();
    const code = discountNormalizeCode(d.code);
    const rawPct = Number(d.pct);
    if (!name || !code || !Number.isFinite(rawPct)) return null;
    return {
        id: String(d.id || ('dc-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))).slice(0, 60),
        name,
        code,
        pct: Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100)),
        status: discountStatusList().includes(String(d.status)) ? String(d.status) : 'Faol',
        createdAt: cleanText(d.createdAt, 30) || new Date().toLocaleString('uz-UZ'),
        createdBy: cleanText(d.createdBy, 120),
    };
}

/**
 * Chegirmani saqlaydi: localStorage + server.
 * MUHIM: buildSyncPayload() `tp_discounts` kalitini AYNAN localStorage dan
 * o'qiydi — shuning uchun avval localStorage yoziladi, keyin sinxronlanadi.
 */
function persistDiscounts() {
    try {
        localStorage.setItem('tp_discounts', JSON.stringify(discountCampaigns));
    } catch (e) {
        console.warn('Chegirmani saqlab bo\\'lmadi:', e);
    }
    if (typeof saveToStorage === 'function') saveToStorage();
}

/** Yangi yoki tahrirlash uchun modalni ochadi (id berilmasa — yangi). */
function openDiscountModal(id) {
    if (!requireRole('admin', 'manager')) return;
    const editing = (id === undefined || id === null || id === '')
        ? null
        : discountCampaigns.find(d => String(d.id) === String(id)) || null;
    editingDiscountId = editing ? editing.id : null;
    const title = document.getElementById('discountModalTitle');
    if (title) {
        title.innerHTML = editing
            ? '<i class="fas fa-pen"></i> Chegirmani tahrirlash'
            : '<i class="fas fa-gift"></i> Yangi chegirma / promo-kod';
    }
    setVal('dc-name', editing ? editing.name : '');
    setVal('dc-code', editing ? editing.code : '');
    setVal('dc-pct', editing ? String(editing.pct) : '10');
    setVal('dc-status', editing ? editing.status : 'Faol');
    openModal('discountModal');
}

function saveDiscountCampaign() {
    if (!requireRole('admin', 'manager')) return;
    const name = cleanText(document.getElementById('dc-name')?.value || '', 80).trim();
    const code = discountNormalizeCode(document.getElementById('dc-code')?.value);
    const pct = Number(String(document.getElementById('dc-pct')?.value ?? '').replace(',', '.'));
    const statusRaw = document.getElementById('dc-status')?.value;
    const status = discountStatusList().includes(String(statusRaw)) ? String(statusRaw) : 'Faol';

    if (!name) {
        playError(); showNotif('error', 'Xato!', 'Kampaniya nomini kiriting'); return;
    }
    if (code.length < 3) {
        playError();
        showNotif('error', 'Promo kod xato',
            'Promo kod kamida 3 belgidan iborat bo\\'lsin (A-Z, 0-9, -)');
        return;
    }
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        playError();
        showNotif('error', 'Chegirma xato',
            'Chegirma foizi 0 dan katta va 100 dan oshmasligi kerak');
        return;
    }
    const clash = discountCampaigns.find(d => d.code === code && String(d.id) !== String(editingDiscountId));
    if (clash) {
        playError();
        showNotif('error', 'Promo kod band',
            `"${code}" kodi "${clash.name}" kampaniyasida ishlatilgan`);
        return;
    }

    if (editingDiscountId != null) {
        discountCampaigns = discountCampaigns.map(d => String(d.id) === String(editingDiscountId)
            ? { ...d, name, code, pct, status } : d);
        addLog('Chegirma', `"${name}" kampaniyasi tahrirlandi — ${code} (${pct}%)`);
    } else {
        const payload = normalizeDiscount({
            name, code, pct, status,
            createdBy: (currentUser && currentUser.name) || '—',
        });
        if (!payload) {
            playError(); showNotif('error', 'Xato!', 'Ma\\'lumotlar yaroqsiz'); return;
        }
        discountCampaigns = [payload, ...discountCampaigns];
        addLog('Chegirma', `Yangi promo-kod: ${code} — ${pct}% (${name})`);
    }
    editingDiscountId = null;
    persistDiscounts();
    renderDiscountsPage();
    closeModal('discountModal');
    playSuccess();
    showNotif('success', 'Saqlandi!', `${name} — ${pct}% (promo kod: ${code})`);
}

function deleteDiscountCampaign(id) {
    if (!requireRole('admin', 'manager')) return;
    const camp = discountCampaigns.find(d => String(d.id) === String(id));
    if (!camp) return;
    if (!confirm(`"${camp.name}" kampaniyasini o'chirasizmi? (promo kod: ${camp.code})`)) return;
    discountCampaigns = discountCampaigns.filter(d => String(d.id) !== String(id));
    persistDiscounts();
    renderDiscountsPage();
    addLog('Chegirma', `"${camp.name}" kampaniyasi o'chirildi`);
    showNotif('info', 'O\\'chirildi', 'Chegirma kampaniyasi o\\'chirildi');
}

/**
 * Kassada promo kodni qo'llaydi.
 * Mavjud chegirma mexanizmidan foydalanadi (`posSetDiscount`) — savdo
 * hisob-kitobi va chek mantig'i o'zgarmaydi.
 */
function posApplyPromoCode() {
    const input = document.getElementById('posPromoCode');
    const code = discountNormalizeCode(input ? input.value : '');
    if (!code) { showNotif('warning', 'Promo kod', 'Promo kodni kiriting'); return; }
    const camp = discountCampaigns.find(d => d.code === code && d.status === 'Faol');
    if (!camp) {
        const exists = discountCampaigns.some(d => d.code === code);
        playError();
        showNotif('error', exists ? 'Kampaniya faol emas' : 'Promo kod topilmadi',
            exists ? `"${code}" kampaniyasi hozir faol emas` : `"${code}" kodi bo'yicha chegirma yo'q`);
        return;
    }
    posSetDiscount(camp.pct);
    if (input) input.value = camp.code;
    playSuccess();
    showNotif('success', 'Promo kod qo\\'llandi', `${camp.name} — ${camp.pct}% chegirma`);
}

function renderDiscountsPage() {
    const tbody = document.getElementById('discountsTableBody');
    if (!tbody) return;
    if (discountCampaigns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Hali chegirma kampaniyalari yo\\'q — "Yangi chegirma" tugmasini bosing</td></tr>';
        return;
    }
    tbody.innerHTML = discountCampaigns.map((d, i) => `
        <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHTML(d.name)}</strong></td>
            <td><code style="padding:4px 8px;background:var(--bg);border-radius:6px;font-weight:700;color:var(--primary)">${escapeHTML(d.code)}</code></td>
            <td style="font-weight:700;color:var(--accent)">${Number(d.pct) || 0}%</td>
            <td><span class="badge ${d.status === 'Faol' ? 'badge-green' : 'badge-red'}">${escapeHTML(d.status)}</span></td>
            <td style="white-space:nowrap">
                <button class="btn btn-sm btn-outline" onclick="openDiscountModal('${escapeHTML(String(d.id))}')" title="Tahrirlash"><i class="fas fa-pen"></i></button>
                <button class="btn btn-sm btn-outline" onclick="deleteDiscountCampaign('${escapeHTML(String(d.id))}')" title="O'chirish"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
"""

# ─────────────────────────── index.html ───────────────────────────

HTML_HEADER_OLD = '            <h3>Chegirma kampaniyalari</h3>\r\n          </div>\r\n'
HTML_HEADER_NEW = (
    '            <h3>Chegirma kampaniyalari</h3>\r\n'
    '            <button type="button" class="btn btn-primary btn-sm" onclick="openDiscountModal()"\r\n'
    '              id="addDiscountBtn"><i class="fas fa-plus"></i> Yangi chegirma</button>\r\n'
    '          </div>\r\n'
)

HTML_TH_OLD = ('                    <th>Promo Kod</th>\r\n'
               '                    <th>Chegirma foizi</th>\r\n'
               '                    <th>Holat</th>\r\n')
HTML_TH_NEW = ('                    <th>Promo Kod</th>\r\n'
               '                    <th>Chegirma foizi</th>\r\n'
               '                    <th>Holat</th>\r\n'
               '                    <th>Amallar</th>\r\n')

HTML_MODAL = """  <!-- ===== YANGI CHEGIRMA / PROMO-KOD ===== -->
  <div class="modal-overlay" id="discountModal">
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <h3 id="discountModalTitle"><i class="fas fa-gift"></i> Yangi chegirma / promo-kod</h3>
        <button class="modal-close" onclick="closeModal('discountModal')">✕</button>
      </div>
      <div class="form-col" style="margin-bottom:14px">
        <label>Kampaniya nomi *</label>
        <input class="form-control" id="dc-name" maxlength="80" autocomplete="off"
          placeholder="Masalan: Yozgi aksiya"
          onkeydown="if(event.key==='Enter'){event.preventDefault();saveDiscountCampaign();}">
      </div>
      <div class="form-row">
        <div class="form-col">
          <label>Promo kod *</label>
          <input class="form-control" id="dc-code" maxlength="24" autocomplete="off" placeholder="SALE10"
            style="text-transform:uppercase" onkeydown="if(event.key==='Enter'){event.preventDefault();saveDiscountCampaign();}">
        </div>
        <div class="form-col">
          <label>Chegirma foizi (%) *</label>
          <input type="number" class="form-control" id="dc-pct" min="1" max="100" step="1" placeholder="10"
            onkeydown="if(event.key==='Enter'){event.preventDefault();saveDiscountCampaign();}">
        </div>
      </div>
      <div class="form-col" style="margin-bottom:14px">
        <label>Holat</label>
        <select class="form-control" id="dc-status">
          <option value="Faol" selected>Faol</option>
          <option value="Nofaol">Nofaol</option>
        </select>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 14px">Promo kodni kassadagi «Promo kod»
        maydoniga kiritib qo'llash mumkin — u faqat holati «Faol» bo'lganda ishlaydi.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-outline" onclick="closeModal('discountModal')">Bekor</button>
        <button class="btn btn-primary" onclick="saveDiscountCampaign()"><i class="fas fa-save"></i> Saqlash</button>
      </div>
    </div>
  </div>

"""

HTML_PROMO = """              <div class="form-col" style="margin-bottom:12px">
                <label>Promo kod</label>
                <div style="display:flex;gap:8px">
                  <input class="form-control" id="posPromoCode" placeholder="Masalan: SALE10" maxlength="24"
                    autocomplete="off" style="text-transform:uppercase"
                    onkeydown="if(event.key==='Enter'){event.preventDefault();posApplyPromoCode();}">
                  <button type="button" class="btn btn-outline btn-sm" onclick="posApplyPromoCode()"><i
                      class="fas fa-tag"></i> Qo'llash</button>
                </div>
              </div>
"""


def edit_js():
    raw = open(JS, 'rb').read().decode('utf-8')
    if 'function renderDiscountsPage() {' not in raw:
        print('XATO: scripts.js da renderDiscountsPage topilmadi'); return None
    if 'function saveDiscountCampaign()' in raw:
        print('scripts.js: ALLAQACHON tuzatilgan'); return raw

    assert raw.count(JS_DECL_OLD) == 1, f'decl mosligi: {raw.count(JS_DECL_OLD)}'
    raw = raw.replace(JS_DECL_OLD, JS_DECL_NEW)

    # renderDiscountsPage ni butunlay almashtiramiz (birinchi ustun-0 "}" gacha)
    pattern = re.compile(r"function renderDiscountsPage\(\) \{.*?^\}\r?$", re.S | re.M)
    matches = pattern.findall(raw)
    assert len(matches) == 1, f'render mosligi: {len(matches)}'
    raw = pattern.sub(lambda _m: JS_NEW_BLOCK.replace('\n', '\r\n').rstrip('\r\n'), raw, count=1)
    return raw


def edit_html():
    raw = open(HTML, 'rb').read().decode('utf-8')
    if 'id="discountModal"' in raw:
        print('index.html: ALLAQACHON tuzatilgan'); return raw

    for old, new, label in ((HTML_HEADER_OLD, HTML_HEADER_NEW, 'panel-header'),
                            (HTML_TH_OLD, HTML_TH_NEW, 'thead')):
        assert raw.count(old) == 1, f'{label} mosligi: {raw.count(old)}'
        raw = raw.replace(old, new)

    # modalni yagona categoryModal oldiga qo'yamiz
    anchor = '  <div class="modal-overlay" id="categoryModal">\r\n'
    assert raw.count(anchor) == 1, f'categoryModal anchor: {raw.count(anchor)}'
    raw = raw.replace(anchor, HTML_MODAL.replace('\n', '\r\n') + anchor, 1)

    # POS: promo kod maydonini "To'lov tizimi" dan oldin qo'yamiz
    lines = raw.split('\r\n')
    idx = next((i for i, l in enumerate(lines) if "<label>To'lov tizimi</label>" in l), None)
    assert idx is not None, "To'lov tizimi label topilmadi"
    insert_at = idx - 1  # uning ustidagi <div class="form-col">
    assert 'form-col' in lines[insert_at], f'kutilgan form-col: {lines[insert_at]!r}'
    lines[insert_at:insert_at] = HTML_PROMO.replace('\n', '\r\n').rstrip('\r\n').split('\r\n')
    raw = '\r\n'.join(lines)

    assert raw.count(OLD_VER) == 1, f'versiya anchor: {raw.count(OLD_VER)}'
    raw = raw.replace(OLD_VER, NEW_VER)
    return raw


def main():
    js = edit_js()
    if js is None:
        return 1
    html = edit_html()
    if html is None:
        return 1
    open(JS, 'wb').write(js.encode('utf-8'))
    open(HTML, 'wb').write(html.encode('utf-8'))
    print('TUZATILDI: chegirma/promo-kod CRUD + saqlash yo\'li + kassa promo kodi.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
