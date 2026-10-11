# -*- coding: utf-8 -*-
"""HOSTING QAYTA TIKLASH — ADMIN va BOSHLIQ parollarini o'rnatadi (offline).

Vazifa: saytga kiradigan ADMIN parolini bilmasangiz va BOSHLIQ akounti
bo'lmasa — serverdagi bazani shu yerda tuzatib, qayta yuklaysiz.

Ish tartibi:
  1) Hosting fayl menejeridan `Data/database.db` ni kompyuterga yuklab oling;
  2) Quyidagicha ishga tushiring (parollar ekranga CHIQMAYDI — yashirin kiritiladi):
         python _tp_hosting_fix.py "C:\\path\\to\\database.db"
  3) Tuzatilgan bazani hostingdagi joyiga (o'rniga) yuklab qo'ying;
  4) Paneldan ilovani qayta ishga tushiring (agar imkoni bo'lsa).

Xavfsizlik:
  • Parollar bazada faqat SHA-256 xesh + (imkoni bo'lsa) xazinada saqlanadi,
    ochiq matn qolmaydi;
  • skript faqat BERILGAN baza faylini o'zgartiradi, serverga tegmaydi;
  • parollar hech qayerga yozilmaydi (faqat terminalda yashirin kiritiladi).

Agar hostingda `.env` da `BOSS_DEFAULT_PASSWORD` yozilgan bo'lsa — DB
tegmasdan ham boss bilan kirib, Boshliq panelidan ADMIN parolini ko'rish
mumkin (xazina funksiyasi). Bu — eng xavfsiz yo'l.
"""
import getpass
import os
import sys

ADMIN_PHONE = '+998908480921'
BOSS_PHONE = '+998901234554'


def main():
    if len(sys.argv) < 2:
        print('Ishlatish:  python _tp_hosting_fix.py "<database.db yoli>"')
        sys.exit(1)

    db_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(db_path):
        print('Baza topilmadi:', db_path)
        sys.exit(1)

    admin_pw = getpass.getpass('Yangi ADMIN paroli (kamida 6 belgi): ')
    boss_pw = getpass.getpass('Yangi BOSHLIQ paroli (kamida 6 belgi): ')
    if len(admin_pw) < 6 or len(boss_pw) < 6:
        print('Har ikki parol kamida 6 ta belgidan iborat bo\'lishi kerak.')
        sys.exit(1)

    os.environ['DB_PATH'] = db_path
    os.environ['FLASK_DEBUG'] = 'false'
    # ensure_boss_account() boss yo'q bo'lsa shu qiymat bilan yaratadi
    os.environ['BOSS_DEFAULT_PASSWORD'] = boss_pw
    os.environ.setdefault('BOSS_DISPLAY_NAME', 'Boshliq')
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    import app as tp  # noqa: E402

    staff = tp.load_staff()  # boss yetak bo'lmasa shu yerda yaratiladi
    admin = next((u for u in staff
                  if str(u.get('phone', '')).strip() == ADMIN_PHONE
                  or str(u.get('login', '')).strip() == 'admin'), None)
    boss = next((u for u in staff
                 if str(u.get('phone', '')).strip() == BOSS_PHONE
                 or str(u.get('login', '')).strip() == 'boss'), None)

    if not admin:
        print('ADMIN topilmadi (login=admin, telefon=%s).' % ADMIN_PHONE)
        sys.exit(2)
    if not boss:
        print('BOSHLIQ yaratilmadi — .env muhitini tekshiring.')
        sys.exit(3)

    boss_existed = str(boss.get('passChangedAt') or '') != ''
    tp.apply_staff_password(admin, admin_pw, 'Offline tiklash (hosting)')
    tp.apply_staff_password(boss, boss_pw, 'Offline tiklash (hosting)')
    tp.db_manager.save_keys({'staff_users': staff})

    print()
    print('TAYYOR — baza yangilandi:', os.path.basename(db_path))
    print('  ADMIN   %s — yangi parol o\'rnatildi' % ADMIN_PHONE)
    print('  BOSHLIQ %s — %s, yangi parol o\'rnatildi'
          % (BOSS_PHONE, 'mavjud edi' if boss_existed else 'yaratildi'))
    print('  Menejer/Kassir (agar 123456 bo\'lsa) — keyin Boshliq panelidan')
    print('  Xodimlar bo\'limidan o\'zgartirasiz.')
    print()
    print('Keyingi qadam: shu faylni hostingdagi Data/database.db o\'rniga')
    print('yuklang va ilovani qayta ishga tushiring.')


if __name__ == '__main__':
    main()
