import os
import sys
import tempfile
import unittest


_test_db_dir = tempfile.TemporaryDirectory(prefix='texno-staff-delete-')
os.environ['DB_PATH'] = os.path.join(_test_db_dir.name, 'test.db')
os.environ['API_AUTH_SECRET'] = 'staff-delete-test-secret'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as tp


class StaffDeleteTests(unittest.TestCase):
    def setUp(self):
        self._reset_fixture()

    def _reset_fixture(self):
        self.boss = {
            'id': 1, 'login': 'testboss', 'name': 'Test Boss',
            'role': 'boss', 'status': 'active',
        }
        self.admin = {
            'id': 2, 'login': 'testadmin', 'name': 'Test Admin',
            'role': 'admin', 'status': 'active',
        }
        self.manager = {
            'id': 3, 'login': 'testmanager', 'name': 'Test Manager',
            'role': 'manager', 'status': 'active',
        }
        self.cashier = {
            'id': 4, 'login': 'testcashier', 'name': 'Test Cashier',
            'role': 'cashier', 'status': 'active',
        }
        self.store = {
            'staff_users': [self.boss.copy(), self.admin.copy(),
                            self.manager.copy(), self.cashier.copy()],
            'sales': [],
            'salaryHistory': [],
            'salaryRecords': [],
            'staffSalaryHistory': [],
            'cashFlow': [],
            'expenses': [],
            'contracts': [],
            'audit_log': [],
            'serverSecurityLog': [],
            'active_sessions': [],
            'branches': [],
            'products': [],
        }
        tp.db_manager.save_keys(self.store)
        self.tokens = {}
        for user in (self.boss, self.admin, self.manager, self.cashier):
            token, payload = tp.create_token(user)
            self.tokens[user['role']] = token
            self.store['active_sessions'].append({
                'jti': payload['jti'], 'login': user['login'], 'exp': payload['exp'],
            })
        tp.db_manager.save_keys({'active_sessions': self.store['active_sessions']})
        self.client = tp.app.test_client()

    def headers(self, role):
        return {'Authorization': 'Bearer ' + self.tokens[role]}

    def delete_cashier(self, role='boss'):
        return self.client.delete('/api/boss/staff/4', headers=self.headers(role))

    def test_unlinked_staff_is_deleted_and_count_refreshes(self):
        response = self.delete_cashier()
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body['action'], 'deleted')
        self.assertNotIn(4, [user['id'] for user in tp.load_staff()])

        listing = self.client.get('/api/boss/staff', headers=self.headers('boss'))
        data = listing.get_json()
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(data['totalAll'], 3)
        self.assertNotIn(4, [user['id'] for user in data['staff']])
        self.assertIn('staff-delete', {
            event['action'] for event in tp.db_manager.get_all()['audit_log']
        })

        repeated = self.delete_cashier()
        self.assertEqual(repeated.status_code, 404)

    def test_any_historical_reference_archives_without_losing_records(self):
        scenarios = (
            ('sales', [{'cashierId': 4, 'cashier': 'Test Cashier'}]),
            ('salaryHistory', [{'staffId': 4, 'amount': 500000}]),
            ('salaryRecords', [{'empId': 4, 'amount': 500000}]),
            ('staffSalaryHistory', [{'staffId': 4, 'newSalary': 500000}]),
            ('cashFlow', [{'staffId': 4, 'amount': 500000}]),
            ('expenses', [{'employeeId': 4, 'amount': 500000}]),
            ('contracts', [{'createdByStaffId': 4, 'number': 'TEST-1'}]),
        )
        for key, records in scenarios:
            with self.subTest(history=key):
                self._reset_fixture()
                self.store[key] = records
                tp.db_manager.save_keys({key: records})

                response = self.delete_cashier()
                data = response.get_json()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(data['action'], 'archived')
                stored = tp.db_manager.get_all()
                target = next(user for user in stored['staff_users']
                              if user['id'] == 4)
                self.assertEqual(target['status'], 'inactive')
                for record in records:
                    self.assertIn(record, stored[key])
                self.assertNotIn('testcashier', {
                    session['login'] for session in stored['active_sessions']
                })

                listing = self.client.get(
                    '/api/boss/staff?q=Test+Cashier', headers=self.headers('boss'))
                payload = listing.get_json()
                self.assertEqual(payload['totalAll'], 4)
                self.assertEqual(payload['statusCounts']['active'], 3)
                self.assertNotIn(4, [user['id'] for user in payload['staff']])
                archived = self.client.get(
                    '/api/boss/staff?status=inactive&q=Test+Cashier',
                    headers=self.headers('boss'))
                self.assertEqual(archived.get_json()['total'], 1)
                all_staff = self.client.get(
                    '/api/boss/staff?status=all', headers=self.headers('boss'))
                self.assertIn(4, [user['id'] for user in all_staff.get_json()['staff']])

    def test_audit_trail_does_not_prevent_profile_deletion(self):
        audit_rows = [
            {'action': 'staff-create', 'target': 'Test Cashier', 'actor': 'Test Boss'},
            {'action': 'staff-update', 'target': 'Test Cashier', 'actor': 'Test Boss'},
        ]
        security_rows = [{'type': 'login', 'user': 'Test Cashier'}]
        tp.db_manager.save_keys({
            'audit_log': audit_rows,
            'serverSecurityLog': security_rows,
        })

        response = self.delete_cashier()
        stored = tp.db_manager.get_all()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['action'], 'deleted')
        self.assertNotIn(4, [user['id'] for user in stored['staff_users']])
        for event in audit_rows:
            self.assertIn(event, stored['audit_log'])
        for event in security_rows:
            self.assertIn(event, stored['serverSecurityLog'])

    def test_role_authentication_and_target_guards(self):
        self.assertEqual(self.delete_cashier('manager').status_code, 403)
        self.assertEqual(self.delete_cashier('cashier').status_code, 403)
        self.assertEqual(self.client.delete('/api/boss/staff/4').status_code, 401)
        self.assertEqual(
            self.client.delete('/api/boss/staff/1', headers=self.headers('boss')).status_code,
            403,
        )
        self.assertEqual(
            self.client.delete('/api/boss/staff/999', headers=self.headers('boss')).status_code,
            404,
        )

    def test_only_active_admin_cannot_be_removed(self):
        response = self.client.delete(
            '/api/boss/staff/2', headers=self.headers('boss'))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['status'], 'error')
        self.assertIn(2, [user['id'] for user in tp.load_staff()])

    def test_soft_delete_rejects_second_inactive_request(self):
        self.store['sales'] = [{'staffId': 4}]
        tp.db_manager.save_keys({'sales': self.store['sales']})
        self.assertEqual(self.delete_cashier().status_code, 200)
        repeated = self.delete_cashier()
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual(tp.db_manager.get_all()['sales'], [{'staffId': 4}])


if __name__ == '__main__':
    unittest.main()
