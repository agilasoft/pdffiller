# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pdffiller.utils.display_condition import evaluate_depends_on, should_display_field


class TestDisplayCondition(unittest.TestCase):
	def test_empty_condition_is_true(self):
		doc = SimpleNamespace(party_type="Customer")
		self.assertTrue(should_display_field(SimpleNamespace(display_depends_on=""), doc))

	def test_truthy_fieldname(self):
		doc = SimpleNamespace(party_type="Customer")
		self.assertTrue(evaluate_depends_on(doc, "party_type"))

	def test_falsy_fieldname(self):
		doc = SimpleNamespace(party_type="")
		self.assertFalse(evaluate_depends_on(doc, "party_type"))

	def test_negated_fieldname(self):
		doc = SimpleNamespace(party_type="")
		self.assertTrue(evaluate_depends_on(doc, "!party_type"))

	@patch("pdffiller.utils.display_condition.frappe.safe_eval", return_value=True)
	def test_eval_expression(self, mock_safe_eval):
		doc = SimpleNamespace(party_type="Customer")
		self.assertTrue(evaluate_depends_on(doc, "eval:doc.party_type=='Customer'"))
		mock_safe_eval.assert_called_once_with("doc.party_type=='Customer'", None, {"doc": doc})

	@patch("pdffiller.utils.display_condition.frappe.safe_eval", return_value=False)
	def test_should_display_field_respects_eval(self, _mock_safe_eval):
		doc = SimpleNamespace(docstatus=0)
		row = SimpleNamespace(display_depends_on="eval:doc.docstatus==1")
		self.assertFalse(should_display_field(row, doc))


if __name__ == "__main__":
	unittest.main()
