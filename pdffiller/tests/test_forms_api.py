# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest

from pdffiller.api.forms import _safe_filename, get_templates


class TestFormsApi(unittest.TestCase):
	def test_safe_filename(self):
		self.assertTrue(_safe_filename("BDO Form", "PE-001").endswith(".pdf"))
		self.assertNotIn("/", _safe_filename("BDO/Form", "PE/001"))

	def test_get_templates_empty(self):
		self.assertEqual(get_templates(""), [])


if __name__ == "__main__":
	unittest.main()
