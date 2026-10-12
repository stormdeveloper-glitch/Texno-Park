import os
import zipfile

apk = "Texno-Park-N1-debug.apk"
assets = os.path.abspath(r"android\app\src\main\assets")
out = "Texno-Park-N1-unsigned.apk"

if not os.path.isfile(apk):
    raise SystemExit("XATO: Eski APK topilmadi.")
if not os.path.isdir(assets):
    raise SystemExit("XATO: Android assets papkasi topilmadi.")

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
