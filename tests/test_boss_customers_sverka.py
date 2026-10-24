import os
import sys
import tempfile
import unittest
from datetime import date, timedelta


_test_db_dir = tempfile.TemporaryDirectory(prefix='texno-boss-customers-')
os.environ['DB_PATH'] = os.path.join(_test_db_dir.name, 'test.db')
os.environ['API_AUTH_SECRET'] = 'boss-customers-sverka-test-secret'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as tp


TODAY = date.today()
TODAY_STR = TODAY.strftime('%d.%m.%Y')
TODAY_ISO = TODAY.isoformat()
YESTERDAY_STR = (TODAY - timedelta(days=1)).strftime('%d.%m.%Y')


def sale(sale_id, customer, total, provider, pay, customer_id=None, day=TODAY_STR,
         branch='b1', qty=1):
    row = {
        'id': sale_id,
        'items': [{'id': 1, 'name': 'TV', 'qty': qty, 'price': total / qty,
                   'cost': (total / qty) * 0.8}],
        'cashier': 'Test Boss',
        'customer': customer,
        'branchId': branch,
        'provider': provider,
        'pay': pay,
        'total': total,
        'discAmt': 0,
        'status': 'paid',
        'date': day,
        'time': '10:00:00',
    }
    if customer_id is not None:
        row['customerId'] = customer_id
    return row


class BossCustomersSverkaTests(unittest.TestCase):
    def setUp(self):
        self.boss = {'id': 1, 'login': 'testboss', 'name': 'Test Boss',
                     'role': 'boss', 'status': 'active'}
        self.cashier = {'id': 2, 'login': 'testcashier', 'name': 'Test Cashier',
                        'role': 'cashier', 'status': 'active'}
        self.customers = [
            {'id': 1, 'name': 'Ali Valiyev', 'phone': '+998901112233',
             'email': 'ali@mail.uz', 'bonus': 15000, 'status': 'vip'},
            {'id': 2, 'name': 'Olim Karimov', 'phone': '+998909998877',
             'email': '', 'bonus': 0, 'status': 'active'},
            {'id': 3, 'name': 'Xaridsiz Mijoz', 'phone': '+998907776655',
             'email': '', 'bonus': 0, 'status': 'active'},
        ]
        self.sales = [
            sale(101, 'Ali Valiyev', 2_000_000, 'cash', 'Naqd',
                 customer_id=1, qty=2),
            sale(102, 'Olim Karimov', 500_000, 'card', 'Karta'),
            sale(103, 'Begona Xaridor', 100_000, 'cash', 'Naqd'),
            sale(104, 'Ali Valiyev', 300_000, 'cash', 'Naqd',
                 customer_id=1, day=YESTERDAY_STR),
        ]
        self.cash_flow = [
            {'id': 'cf1', 'type': 'kirim', 'amount': 100_000, 'branchId': 'b1',
             'date': TODAY_ISO},
            {'id': 'cf2', 'type': 'chiqim', 'amount': 50_000, 'branchId': 'b1',
             'date': TODAY_ISO},
            {'id': 'cf3', 'type': 'harajat', 'amount': 20_000, 'branchId': 'b1',
             'date': TODAY_ISO},
            # Boshqa filial — sverkaga kirmaydi.
            {'id': 'cf4', 'type': 'chiqim', 'amount': 999_000, 'branchId': 'b2',
             'date': TODAY_ISO},
            # Boshqa kun — sverkaga kirmaydi.
            {'id': 'cf5', 'type': 'kirim', 'amount': 700_000, 'branchId': 'b1',
             'date': (TODAY - timedelta(days=1)).isoformat()},
        ]
        self.store = {
            'staff_users': [self.boss.copy(), self.cashier.copy()],
            'customers': self.customers,
            'sales': self.sales,
            'cashFlow': self.cash_flow,
            'expenses': [],
            'cashSverka': [],
            'branches': [
                {'id': 'b1', 'name': 'Markaziy filial', 'status': 'active'},
                {'id': 'b2', 'name': 'Ikkinchi filial', 'status': 'active'},
            ],
            'products': [],
            'salaryHistory': [],
            'salaryRecords': [],
            'staffSalaryHistory': [],
            'contracts': [],
            'audit_log': [],
            'serverSecurityLog': [],
            'active_sessions': [],
        }
        tp.db_manager.save_keys(self.store)
        self.tokens = {}
        sessions = []
        for user in (self.boss, self.cashier):
            token, payload = tp.create_token(user)
            self.tokens[user['role']] = token
            sessions.append({'jti': payload['jti'], 'login': user['login'],
                             'exp': payload['exp']})
        tp.db_manager.save_keys({'active_sessions': sessions})
        self.client = tp.app.test_client()

    def headers(self, role='boss'):
        return {'Authorization': 'Bearer ' + self.tokens[role]}

    # ── Mijozlar ────────────────────────────────────────────────

    def test_customers_stats_are_computed_from_real_sales(self):
        response = self.client.get('/api/boss/customers?period=all',
                                   headers=self.headers())
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['status'], 'success')
        by_id = {row['id']: row for row in data['customers']}

        self.assertEqual(by_id[1]['orders'], 2)
        self.assertEqual(by_id[1]['total'], 2_300_000)
        self.assertEqual(by_id[1]['units'], 3)
        self.assertEqual(by_id[1]['avgCheck'], 1_150_000)
        self.assertEqual(by_id[1]['lastPurchase'], TODAY_STR + ' 10:00:00')

        # Telefon/ID bo'lmagan eski savdo ism bo'yicha bog'lanadi.
        self.assertEqual(by_id[2]['orders'], 1)
        self.assertEqual(by_id[2]['total'], 500_000)

        # Xarid qilmagan mijoz ham ro'yxatda qoladi.
        self.assertEqual(by_id[3]['orders'], 0)
        self.assertEqual(data['summary']['count'], 3)
        self.assertEqual(data['summary']['vip'], 1)
        self.assertEqual(data['summary']['orders'], 3)
        self.assertEqual(data['summary']['revenue'], 2_800_000)

    def test_customers_period_filter_and_search(self):
        today = self.client.get('/api/boss/customers?period=day',
                                headers=self.headers()).get_json()
        ali = next(row for row in today['customers'] if row['id'] == 1)
        self.assertEqual(ali['orders'], 1)
        self.assertEqual(ali['total'], 2_000_000)

        found = self.client.get('/api/boss/customers?q=olim',
                                headers=self.headers()).get_json()
        self.assertEqual([row['id'] for row in found['customers']], [2])

    def test_customers_requires_boss(self):
        response = self.client.get('/api/boss/customers',
                                   headers=self.headers('cashier'))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get('/api/boss/customers').status_code, 401)

    # ── Kassa sverkasi ─────────────────────────────────────────

    def test_cash_sverka_expected_cash_and_payment_split(self):
        response = self.client.get(
            f'/api/boss/cash-sverka?date={TODAY_ISO}&branchId=b1',
            headers=self.headers())
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        # Naqd savdo: 2 000 000 + 100 000 (kechagi 300 000 kirmaydi).
        self.assertEqual(data['sales']['cash'], 2_100_000)
        self.assertEqual(data['sales']['card'], 500_000)
        self.assertEqual(data['sales']['orders'], 3)
        # Kirim 100 000 − chiqim 50 000 − xarajat 20 000.
        self.assertEqual(data['expectedCash'], 2_130_000)
        self.assertEqual(data['flow']['kirim'], 100_000)
        self.assertEqual(data['flow']['chiqim'], 50_000)
        self.assertEqual(data['flow']['harajat'], 20_000)
        self.assertIsNone(data['record'])

    def test_cash_sverka_saves_and_updates_one_record_per_day(self):
        payload = {'date': TODAY_ISO, 'branchId': 'b1',
                   'counted': 2_120_000, 'note': 'Kassa sanaldi'}
        first = self.client.post('/api/boss/cash-sverka', headers=self.headers(),
                                 json=payload)
        self.assertEqual(first.status_code, 200)
        record = first.get_json()['record']
        self.assertEqual(record['expected'], 2_130_000)
        self.assertEqual(record['difference'], -10_000)

        payload['counted'] = 2_130_000
        second = self.client.post('/api/boss/cash-sverka', headers=self.headers(),
                                  json=payload)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.get_json()['record']['difference'], 0)
        self.assertEqual(len(tp.db_manager.get_all()['cashSverka']), 1)

        listing = self.client.get(
            f'/api/boss/cash-sverka?date={TODAY_ISO}&branchId=b1',
            headers=self.headers()).get_json()
        self.assertEqual(listing['record']['counted'], 2_130_000)
        self.assertEqual(len(listing['recent']), 1)
        self.assertIn('cash-sverka', {
            event['action'] for event in tp.db_manager.get_all()['audit_log']
        })

    def test_cash_sverka_validation_and_permissions(self):
        bad = self.client.post('/api/boss/cash-sverka', headers=self.headers(),
                               json={'date': TODAY_ISO, 'counted': -5})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.post(
            '/api/boss/cash-sverka', headers=self.headers(),
            json={'date': 'not-a-date', 'counted': 100}).status_code, 400)
        self.assertEqual(self.client.post(
            '/api/boss/cash-sverka', headers=self.headers(),
            json={'date': TODAY_ISO, 'branchId': 'nope',
                  'counted': 100}).status_code, 404)
        self.assertEqual(self.client.post(
            '/api/boss/cash-sverka', headers=self.headers('cashier'),
            json={'date': TODAY_ISO, 'counted': 100}).status_code, 403)


if __name__ == '__main__':
    unittest.main()
