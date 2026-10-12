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

	@patch("pdffiller.api.forms._safe_doctype_exists", return_value=False)
	@patch("pdffiller.api.forms._doctype_available", return_value=True)
	@patch("pdffiller.api.forms.frappe.get_all")
	def test_get_templates_lists_both_kinds(self, mock_get_all, _available, _packet_exists):
		def fake_get_all(doctype, **kwargs):
			if doctype == "PDF Form Template":
				return [
					{
						"name": "Overlay Quote",
						"title": "Overlay Quote",
						"show_on_draft": 1,
						"group": "",
						"display_depends_on": "",
					}
				]
			if doctype == "PDF Print Design":
				return [
					{
						"name": "Blank Quote",
						"title": "Blank Quote",
						"show_on_draft": 1,
						"group": "Quotes",
						"display_depends_on": "",
					}
				]
			return []

		mock_get_all.side_effect = fake_get_all
		result = get_templates("Sales Quotation")
		by_name = {row["name"]: row for row in result}
		self.assertEqual(by_name["Overlay Quote"]["source"], "form_template")
		self.assertEqual(by_name["Blank Quote"]["source"], "print_design")
		self.assertEqual([row["name"] for row in result], ["Overlay Quote", "Blank Quote"])

	@patch("pdffiller.api.forms._doctype_available")
	@patch("pdffiller.api.forms.frappe.get_all")
	def test_get_templates_skips_missing_print_design_doctype(self, mock_get_all, mock_available):
		mock_available.side_effect = lambda doctype: doctype == "PDF Form Template"
		mock_get_all.return_value = [
			{
				"name": "Overlay Quote",
				"title": "Overlay Quote",
				"show_on_draft": 1,
				"group": "",
				"display_depends_on": "",
			}
		]
		result = get_templates("Sales Quotation")
		self.assertEqual([row["name"] for row in result], ["Overlay Quote"])
		self.assertEqual(result[0]["source"], "form_template")
		mock_get_all.assert_called_once()

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
			fields_only=0,
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
			fields_only=0,
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

	@patch("pdffiller.api.forms.fill_template_pdf", return_value=b"pdf")
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_uses_template_fields_only_default(self, _visible, _perm, mock_get_doc, mock_fill):
		from pdffiller.api.forms import get_filled_pdf

		template_doc = SimpleNamespace(
			reference_doctype="Payment Entry",
			disabled=0,
			title="Test Form",
			fields_only=1,
			field_mappings=[],
		)
		source_doc = SimpleNamespace()
		mock_get_doc.side_effect = [template_doc, source_doc]

		get_filled_pdf("Test Form", "Payment Entry", "PE-001")
		mock_fill.assert_called_once_with(
			template_doc,
			source_doc,
			overrides={},
			fields_only=True,
		)

	@patch("pdffiller.api.forms.build_field_preview", return_value=[])
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_form_preview_returns_fields_only(self, _visible, _perm, mock_get_doc, _preview):
		from pdffiller.api.forms import get_form_preview

		template_doc = SimpleNamespace(
			name="Test Form",
			title="Test Form",
			reference_doctype="Payment Entry",
			disabled=0,
			fields_only=1,
		)
		source_doc = SimpleNamespace()
		mock_get_doc.side_effect = [template_doc, source_doc]

		result = get_form_preview("Test Form", "Payment Entry", "PE-001")
		self.assertTrue(result["fields_only"])

	@patch("pdffiller.utils.print_design_fill.fill_print_design", return_value=b"pdf")
	@patch("pdffiller.api.forms.fill_template_pdf", return_value=b"overlay")
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_filled_pdf_print_design_uses_blank_fill(
		self, _visible, _perm, mock_get_doc, mock_overlay, mock_blank
	):
		from pdffiller.api.forms import get_filled_pdf

		design_doc = SimpleNamespace(
			reference_doctype="Sales Quotation",
			disabled=0,
			title="Blank Quote",
			field_mappings=[],
		)
		source_doc = SimpleNamespace()
		mock_get_doc.side_effect = [design_doc, source_doc]

		result = get_filled_pdf("Blank Quote", "Sales Quotation", "QTN-1", source="print_design")
		self.assertTrue(result["data_uri"].startswith("data:application/pdf;base64,"))
		mock_blank.assert_called_once_with(design_doc, source_doc, overrides={})
		mock_overlay.assert_not_called()


class TestFormPermissions(unittest.TestCase):
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=False)
	def test_list_pdf_fields_requires_template_read(self, _perm):
		from pdffiller.api.forms import list_pdf_fields

		with self.assertRaises(Exception):
			list_pdf_fields("Test Form")

	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=False)
	def test_preview_requires_document_read(self, _perm, mock_get_doc):
		from pdffiller.api.forms import get_form_preview

		mock_get_doc.return_value = SimpleNamespace(
			name="Test Form",
			title="Test Form",
			reference_doctype="Payment Entry",
			disabled=0,
			fields_only=0,
		)
		with self.assertRaises(Exception):
			get_form_preview("Test Form", "Payment Entry", "PE-001")

	@patch("pdffiller.utils.form_access.frappe.get_roles", return_value=["Guest"])
	@patch("pdffiller.api.forms.frappe.get_doc")
	@patch("pdffiller.api.forms.frappe.has_permission", return_value=True)
	@patch("pdffiller.api.forms.should_display_template", return_value=True)
	def test_preview_rejects_user_without_allowed_role(self, _visible, _perm, mock_get_doc, _roles):
		from pdffiller.api.forms import get_form_preview

		template_doc = SimpleNamespace(
			name="Payroll Form",
			title="Payroll Form",
			reference_doctype="Payment Entry",
			disabled=0,
			fields_only=0,
			allowed_roles=[SimpleNamespace(role="HR User")],
		)
		mock_get_doc.return_value = template_doc
		with self.assertRaises(Exception):
			get_form_preview("Payroll Form", "Payment Entry", "PE-001")

	@patch("pdffiller.api.forms.frappe.get_roles", return_value=["Accounts User"])
	@patch("pdffiller.api.forms._safe_doctype_exists", return_value=True)
	@patch("pdffiller.api.forms._doctype_available", return_value=True)
	@patch("pdffiller.api.forms.frappe.get_all")
	def test_get_templates_hides_forms_for_other_roles(self, mock_get_all, _available, _exists, _roles):
		def fake_get_all(doctype, **kwargs):
			if doctype == "PDF Form Template":
				return [
					{
						"name": "Secret",
						"title": "Secret",
						"show_on_draft": 1,
						"group": "",
						"display_depends_on": "",
					},
					{
						"name": "Public",
						"title": "Public",
						"show_on_draft": 1,
						"group": "",
						"display_depends_on": "",
					},
				]
			if doctype == "PDF Form Allowed Role":
				parent = (kwargs.get("filters") or {}).get("parenttype")
				if parent == "PDF Form Template":
					return [{"parent": "Secret", "role": "HR User"}]
			return []

		mock_get_all.side_effect = fake_get_all
		result = get_templates("Payment Entry")
		self.assertEqual([row["name"] for row in result], ["Public"])

	def test_preview_returns_mapping_warnings(self):
		from pdffiller.utils.fill_warnings import add_warning

		def fake_preview(_template, _source):
			add_warning("Payee", "Could not render barcode")
			return []

		with (
			patch("pdffiller.api.forms.build_field_preview", side_effect=fake_preview),
			patch("pdffiller.api.forms.frappe.get_doc") as mock_get_doc,
			patch("pdffiller.api.forms.frappe.has_permission", return_value=True),
			patch("pdffiller.api.forms.should_display_template", return_value=True),
		):
			from pdffiller.api.forms import get_form_preview

			template_doc = SimpleNamespace(
				name="Test Form",
				title="Test Form",
				reference_doctype="Payment Entry",
				disabled=0,
				fields_only=0,
			)
			mock_get_doc.side_effect = [template_doc, SimpleNamespace()]
			result = get_form_preview("Test Form", "Payment Entry", "PE-001")
		self.assertEqual(result["warnings"][0]["field"], "Payee")

	@patch("pdffiller.api.forms.frappe.has_permission")
	def test_attach_requires_document_write(self, mock_perm):
		from pdffiller.api.forms import attach_filled_pdf

		def allow(doctype, action, name=None):
			return action != "write"

		mock_perm.side_effect = allow
		with self.assertRaises(Exception):
			attach_filled_pdf("Test Form", "Payment Entry", "PE-001")


if __name__ == "__main__":
	unittest.main()
