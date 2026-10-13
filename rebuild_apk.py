import filecmp
import os
import re
import shutil
import zipfile

# ============================================================
# TEXNO PARK N1 — APK qayta yig'ish
# ============================================================
# MUHIM (audit xatosi): ilgari bu skript APK'ga FAQAT
# `android/app/src/main/assets/` papkasidagi fayllarni solardi, ildizdagi
# frontend fayllarini esa hech qachon ko'chirmasdi. Natijada ikki nusxa
# ajralib ketgan edi:
#   • ModalSheet (mobil sheet), debounce va shopSearch tuzatishlari APK'da
#     umuman yo'q edi — ya'ni mobil ilova eski UI bilan qurilardi;
#   • boss.js va boss.css assets papkasida YO'Q edi, index.html esa ularga
#     havola qiladi → mobil ilovada Boshliq paneli ochilmasdi (404).
# Endi build oldidan ildiz fayllari avtomatik sinxronlanadi va havolalar
# tekshiriladi (pastda `check_local_assets`).
# ============================================================

apk = "Texno-Park-N1-debug.apk"
assets = os.path.abspath(r"android\app\src\main\assets")
out = "Texno-Park-N1-unsigned.apk"

FRONTEND_FILES = (
    "index.html", "scripts.js", "style.css", "boss.css", "boss.js",
    "tour.js", "qrcode.min.js", "favicon.png",
)
FRONTEND_DIRS = ("assets",)


def sync_frontend():
    """Ildizdagi frontend fayllarini android assets papkasiga ko'chiradi.

    Qaytaradi: (tekshirilgan_fayllar, o'zgarganlar ro'yxati).
    Faqat o'zgargan fayllar nusxalanadi (vaqt va mtime saqlanadi).
    """
    checked, changed = 0, []
    for name in FRONTEND_FILES:
        if not os.path.isfile(name):
            raise SystemExit(f"XATO: ildizda '{name}' topilmadi.")
        target = os.path.join(assets, name)
        if not (os.path.isfile(target) and filecmp.cmp(name, target, shallow=False)):
            shutil.copy2(name, target)
            changed.append(name)
        checked += 1

    for folder in FRONTEND_DIRS:
        if not os.path.isdir(folder):
            continue
        for root, _dirs, files in os.walk(folder):
            for name in files:
                # Vaqtinchalik/probe fayllar APK ichiga kirmasin
                if name.startswith(("_", ".")):
                    continue
                src_path = os.path.join(root, name)
                target = os.path.join(assets, os.path.relpath(src_path, "."))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if not (os.path.isfile(target)
                        and filecmp.cmp(src_path, target, shallow=False)):
                    shutil.copy2(src_path, target)
                    changed.append(os.path.relpath(src_path, "."))
                checked += 1
    return checked, changed


def check_local_assets():
    """index.html havola qilgan MAHALLIY fayllar assets'da bormi?

    Aynan shu tekshiruv boss.js/boss.css yo'qolganini ushlab qolardi.
    """
    index = os.path.join(assets, "index.html")
    html = open(index, encoding="utf-8", errors="replace").read()
    refs = set()
    for attr in ("src", "href"):
        # Atribut nomi oldidan bo'sh joy shart — `data-boss-audit-src="..."`
        # kabi maxsus atributlarga tushib qolmaslik uchun.
        for match in re.finditer(r'\s' + attr + r'="([^"]+)"', html):
            value = match.group(1).split("?")[0].split("#")[0].strip()
            if (not value or "://" in value or value.startswith("//")
                    or value.startswith(("javascript:", "mailto:", "tel:", "data:", "#", "+"))):
                continue
            refs.add(value)
    missing = sorted(ref for ref in refs if not os.path.isfile(os.path.join(assets, ref)))
    return missing, sorted(refs)


if not os.path.isfile(apk):
    raise SystemExit("XATO: Eski APK topilmadi.")
if not os.path.isdir(assets):
    raise SystemExit("XATO: Android assets papkasi topilmadi.")

# ── 1) Frontend sinxronizatsiyasi ────────────────────────────
checked, changed = sync_frontend()
print(f"Frontend sinxronlandi: {checked} fayl tekshirildi, {len(changed)} yangilandi")
for name in changed:
    print(f"  - yangilandi: {name}")

missing, refs = check_local_assets()
if missing:
    print("DIQQAT: index.html havola qilgan fayllar assets'da yo'q:")
    for name in missing:
        print(f"  - YO'Q: {name}")
    raise SystemExit("XATO: yetishmayotgan fayllar APK ichida 404 beradi — build to'xtatildi.")
print(f"Havola tekshiruvi: {len(refs)} mahalliy fayl, hammasi joyida")

new_assets = {}
for root, _, files in os.walk(assets):
    for name in files:
        full = os.path.join(root, name)
        rel = os.path.relpath(full, assets).replace("\\", "/")
        new_assets["assets/" + rel] = full

if "assets/index.html" not in new_assets:
    raise SystemExit("XATO: assets/index.html topilmadi.")

with zipfile.ZipFile(apk, "r") as src, \
     zipfile.ZipFile(out, "w") as dst:
    existing = set()

    for item in src.infolist():
        name = item.filename
        upper = name.upper()

        if upper.startswith("META-INF/") and (
            upper.endswith((".RSA", ".DSA", ".EC", ".SF"))
            or upper.endswith("/MANIFEST.MF")
            or upper == "META-INF/MANIFEST.MF"
            or os.path.basename(upper).startswith("SIG-")
        ):
            continue

        if name in new_assets:
            with open(new_assets[name], "rb") as f:
                data = f.read()
            dst.writestr(item, data)
            existing.add(name)
        else:
            dst.writestr(item, src.read(name))

    for name, full in new_assets.items():
        if name not in existing:
            dst.write(full, name)

print("Tayyor:", out)
print("Yangilangan asset fayllari:", len(new_assets))
