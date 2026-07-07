# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pdffiller.api.forms import _parse_overrides, _safe_filename, get_templates


class TestFormsApi(unittest.TestCase):
	def test_safe_filename(self):
		self.assertTrue(_safe_filename("BDO Form", "PE-001").endswith(".pdf"))
		self.assertNotIn("/", _safe_filename("BDO/Form", "PE/001"))

	def test_get_templates_empty(self):
		self.assertEqual(get_templates(""), [])

	def test_parse_overrides_dict(self):
		self.assertEqual(_parse_overrides({"FieldA": "Value"}), {"FieldA": "Value"})

	def test_parse_overrides_json_string(self):
		payload = json.dumps({"FieldA": "Value"})
		self.assertEqual(_parse_overrides(payload), {"FieldA": "Value"})

	def test_parse_overrides_empty(self):
		self.assertEqual(_parse_overrides(None), {})
		self.assertEqual(_parse_overrides(""), {})


class TestValidateEditableOverrides(unittest.TestCase):
	@patch("pdffiller.api.forms.fill_template_pdf", return_value=b"pdf")
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	def test_rejects_non_editable_override(self, _perm, mock_get_doc, _fill):
		from pdffiller.api.forms import get_filled_pdf

		template_doc = SimpleNamespace(
			reference_doctype="Payment Entry",
			disabled=0,
			title="Test Form",
			field_mappings=[
				SimpleNamespace(pdf_field_name="FieldA", editable=0),
				SimpleNamespace(pdf_field_name="FieldB", editable=1),
			],
		)
		source_doc = SimpleNamespace()
		mock_get_doc.side_effect = [template_doc, source_doc]

		with self.assertRaises(Exception):
			get_filled_pdf("Test Form", "Payment Entry", "PE-001", field_overrides={"FieldA": "Changed"})


if __name__ == "__main__":
	unittest.main()
