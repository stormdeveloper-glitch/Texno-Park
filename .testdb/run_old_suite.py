#!/usr/bin/env python3
"""Yordamchi: _tp_boss_test.py ni bitta jarayonda, `mustChange` tosig'isiz ishga tushiradi.

Sabab: `known_default_passwords()` env dagi `BOSS_DEFAULT_PASSWORD` ni "standart
parol" deb biladi va akountga `mustChange=True` qo'yadi — natijada test logini
keyingi so'rovlarda 403 (password_change_required) oladi. Bu muhit sharti
(mening o'zgartirishlarimdan mustaqil), shuning uchun avval mustChange o'chiriladi.
"""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))   # .testdb
PROJ = os.path.dirname(BASE)                       # Texno-Park
sys.path.insert(0, PROJ)

import app as tp  # noqa: E402

tp.ensure_boss_account()
staff = tp.load_staff()
boss = next((u for u in staff if str(u.get('role')) == 'boss'), None)
if boss:
    boss['mustChange'] = False
    tp.db_manager.save_keys({'staff_users': staff})

import _tp_boss_test as T  # noqa: E402

client, boss_token, tokens = T.main()
T.crud_tests(client, boss_token, tokens)
print(f"\n=== NATIJA: {T._passed} o'tgan, {T._failed} yiqilgan ===")
sys.exit(1 if T._failed else 0)
