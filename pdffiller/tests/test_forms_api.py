# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pdffiller.api.forms import _filter_templates_for_doc, _parse_overrides, _safe_filename, get_templates


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

	def test_filter_templates_without_doc_name(self):
		templates = [
			{"name": "Always", "display_depends_on": ""},
			{"name": "Conditional", "display_depends_on": "eval:doc.docstatus==1"},
		]
		result = _filter_templates_for_doc(templates, "Payment Entry", None)
		self.assertEqual([template["name"] for template in result], ["Always"])

	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.should_display_template")
	def test_filter_templates_for_doc(self, mock_should_display, _mock_get_doc):
		templates = [
			{"name": "Form A", "display_depends_on": ""},
			{"name": "Form B", "display_depends_on": "eval:doc.docstatus==1"},
		]
		mock_should_display.side_effect = [True, False]
		result = _filter_templates_for_doc(templates, "Payment Entry", "PE-001")
		self.assertEqual([template["name"] for template in result], ["Form A"])


class TestValidateEditableOverrides(unittest.TestCase):
	@patch("pdffiller.api.forms.fill_template_pdf", return_value=b"pdf")
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_rejects_non_editable_override(self, _visible, _perm, mock_get_doc, mock_fill):
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

		mock_fill.assert_not_called()

	@patch("pdffiller.api.forms.fill_template_pdf", return_value=b"pdf")
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_passes_fields_only_flag(self, _visible, _perm, mock_get_doc, mock_fill):
		from pdffiller.api.forms import get_filled_pdf

		template_doc = SimpleNamespace(
			reference_doctype="Payment Entry",
			disabled=0,
			title="Test Form",
			field_mappings=[],
		)
		source_doc = SimpleNamespace()
		mock_get_doc.side_effect = [template_doc, source_doc]

		get_filled_pdf("Test Form", "Payment Entry", "PE-001", fields_only=1)
		mock_fill.assert_called_once_with(
			template_doc,
			source_doc,
			overrides={},
			fields_only=True,
		)


if __name__ == "__main__":
	unittest.main()
