#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================
# BOSHLIQ (RAHBARIYAT) AKOUNTINI YARATISH — CLI yordamchisi
# ============================================================
# Boshliq parolini kodga YOZMAYDI: parol shu skriptga argument sifatida
# beriladi va darhol xeshlanadi.
#
#   python _tp_create_boss.py "+998901234554" "parol" "Boshliq Ismi"
#
# Parol BAZAGA FAQAT SHA-256 XESH ko'rinishida yoziladi
# (sha256(salt + '::' + parol)) — xuddi /api/auth/change-password bilan bir xil.
# Alohida variant: `python _tp_create_boss.py` parolsiz — parol .env dagi
# BOSS_DEFAULT_PASSWORD dan olinadi (yoki interaktiv so'raydi).
# ============================================================
import os
import sys
import getpass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as tp  # noqa: E402  (ilova moduli — baza bilan bir xil ulanish)


def create(phone, password, name):
    staff = tp.load_staff()
    if any(isinstance(u, dict) and tp.phones_match(u.get('phone'), phone) for u in staff):
        print('[XATO] ' + phone + ' telefoniga ega xodim allaqachon mavjud.')
        return 1
    login = tp.BOSS_LOGIN
    n = 2
    while any(isinstance(u, dict) and str(u.get('login', '')).lower() == login for u in staff):
        login = tp.BOSS_LOGIN + str(n)
        n += 1
    salt = tp.make_salt('tp-bss-')
    account = {
        'id': tp._next_staff_id(staff),
        'login': login,
        'phone': phone,
        'salt': salt,
        'passHash': tp.hash_password(password, salt),
        'name': name,
        'role': 'boss',
        'status': 'active',
        'branchId': '',
        'mustChange': False,
        'createdAt': tp.datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
        'updatedAt': tp.datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
    }
    staff.append(account)
    tp.db_manager.save_keys({'staff_users': staff})
    print('[OK] Boshliq akounti yaratildi: ' + name + ' | ' + phone + ' | login=' + login)
    print("     Parol bazada SHA-256 xesh ko'rinishida saqlanadi (ochiq matn YO'Q).")
    return 0


def main():
    phone = tp.normalize_phone(sys.argv[1]) if len(sys.argv) > 1 else tp.BOSS_PHONE
    if not phone:
        print("[XATO] Telefon raqamini +998XXXXXXXXX ko'rinishida bering.")
        return 1
    if len(sys.argv) > 2:
        password = sys.argv[2]
    elif os.getenv('BOSS_DEFAULT_PASSWORD'):
        password = os.environ['BOSS_DEFAULT_PASSWORD']
        print('[ESLATMA] Parol .env dagi BOSS_DEFAULT_PASSWORD dan olinadi.')
    else:
        password = getpass.getpass('Boshliq uchun yangi parol: ')
    if len(password) < 6:
        print("[XATO] Parol kamida 6 belgidan iborat bo'lishi kerak.")
        return 1
    name = sys.argv[3] if len(sys.argv) > 3 else tp.BOSS_NAME
    return create(phone, password, name)


if __name__ == '__main__':
    sys.exit(main())