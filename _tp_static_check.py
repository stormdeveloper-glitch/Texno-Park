# -*- coding: utf-8 -*-
"""
app.py ni statik tekshiruv: har bir route dekoratori o'zidan KEYIN
to'g'ri `def` bilan bog'langanmi? (insert_line buzilishlarini ushlash uchun)
"""
import ast
import sys

src = open('app.py', encoding='utf-8').read()
tree = ast.parse(src)
lines = src.split('\n')

bad = 0
routes = 0
for node in ast.walk(tree):
    if not isinstance(node, ast.FunctionDef):
        continue
    for dec in node.decorator_list:
        # @app.route('...') dekoratorlari
        if (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                and dec.func.attr == 'route'):
            routes += 1
            continue
    # require_staff bilan bezorangan funksiyalar route'siz qolmasin

# 2) route dekoratori bilan funksiya orasida boshqa kod bo'lmasin
stack = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        first = node.body[0]
        # require_staff / require_* dekoratorlari to'g'ridan keyin bo'lishi kerak
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
                if dec.func.attr == 'route':
                    stack.append((node.lineno, node.name))

print(f'route dekoratorlari: {len(stack)}')

# 3) Har bir modul darajasidagi top-level funksiya oxirida ACCESSIBLE?
# Unreachable kod bormi?
class V(ast.NodeVisitor):
    def __init__(self):
        self.unreachable = []
    def visit_FunctionDef(self, node):
        for i, st in enumerate(node.body[:-1]):
            if isinstance(st, ast.Return):
                self.unreachable.append((st.lineno, node.name))
        self.generic_visit(node)

v = V()
v.visit(tree)
if v.unreachable:
    print('\nERISHIB BO\'LMAYDI (defoltdan keyingi kod):')
    for ln, fn in v.unreachable:
        print(f'  qator {ln}: {fn}')
    bad += len(v.unreachable)

# 4) Modul darajasida return/try (sintaksis o'tmadi lekin mantiqan xato)
for st in tree.body:
    if isinstance(st, ast.Return):
        print(f'\nMODUL DARAJASIDA return: qator {st.lineno}')
        bad += 1

print(f'\n=== MUAMMO: {bad} ===')
sys.exit(1 if bad else 0)