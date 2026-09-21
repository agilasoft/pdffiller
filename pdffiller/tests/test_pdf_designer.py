# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import fitz

from pdffiller.utils.pdf_designer import (
	apply_field_layout,
	create_exclusive_template_pdf,
	get_page_previews,
	is_template_pdf_shared,
	list_field_layout,
	merge_fields_with_mappings,
	save_template_pdf,
	sync_field_mappings,
)
from pdffiller.utils.pdf_filler import _checkbox_is_checked, fill_pdf, list_acroform_fields


def _make_plain_pdf(path: str) -> None:
	doc = fitz.open()
	doc.new_page(width=595, height=842)
	doc.save(path)
	doc.close()


class TestPdfDesigner(unittest.TestCase):
	def setUp(self):
		self.tempdir = tempfile.mkdtemp()
		self.plain_path = os.path.join(self.tempdir, "plain.pdf")
		_make_plain_pdf(self.plain_path)

	def test_get_page_previews(self):
		pages = get_page_previews(self.plain_path, zoom=1)
		self.assertEqual(len(pages), 1)
		self.assertEqual(pages[0]["page_no"], 0)
		self.assertGreater(pages[0]["width_pt"], 0)
		self.assertTrue(pages[0]["image_data_uri"].startswith("data:image/png;base64,"))

	def test_apply_field_layout_creates_widgets(self):
		fields = [
			{
				"field_name": "customer_name",
				"field_type": "Data",
				"page": 0,
				"x": 72,
				"y": 100,
				"width": 200,
				"height": 20,
				"font_size": 10,
			},
			{
				"field_name": "agree_terms",
				"field_type": "Check",
				"page": 0,
				"x": 72,
				"y": 140,
				"width": 14,
				"height": 14,
				"font_size": 10,
			},
		]
		pdf_bytes = apply_field_layout(self.plain_path, fields)
		output_path = os.path.join(self.tempdir, "designed.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		self.assertEqual(list_acroform_fields(output_path), ["agree_terms", "customer_name"])

		layout = list_field_layout(output_path)
		by_name = {field["field_name"]: field for field in layout}
		self.assertAlmostEqual(by_name["customer_name"]["x"], 72, places=1)
		self.assertEqual(by_name["customer_name"]["field_type"], "Data")
		self.assertEqual(by_name["agree_terms"]["field_type"], "Check")

	def test_apply_field_layout_select_and_multiline(self):
		fields = [
			{
				"field_name": "status",
				"field_type": "Select",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 120,
				"height": 20,
				"font_size": 10,
				"options": "Draft\nSubmitted",
			},
			{
				"field_name": "remarks",
				"field_type": "Small Text",
				"page": 0,
				"x": 72,
				"y": 100,
				"width": 200,
				"height": 40,
				"font_size": 10,
			},
		]
		pdf_bytes = apply_field_layout(self.plain_path, fields)
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		widgets = {widget.field_name: widget for widget in doc[0].widgets() or []}
		doc.close()
		self.assertEqual(_widget_type_label_from_widget(widgets["status"]), "Select")
		self.assertEqual(_widget_type_label_from_widget(widgets["remarks"]), "Small Text")

	def test_apply_field_layout_barcode_widget(self):
		fields = [
			{
				"field_name": "item_barcode",
				"field_type": "Barcode",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 180,
				"height": 48,
				"font_size": 10,
			}
		]
		pdf_bytes = apply_field_layout(self.plain_path, fields)
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		widgets = {widget.field_name: widget for widget in doc[0].widgets() or []}
		doc.close()
		self.assertIn("item_barcode", widgets)
		self.assertEqual(_widget_type_label_from_widget(widgets["item_barcode"]), "Data")

	def test_apply_field_layout_image_widget(self):
		fields = [
			{
				"field_name": "photo",
				"field_type": "Image",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 120,
				"height": 120,
				"font_size": 10,
			}
		]
		pdf_bytes = apply_field_layout(self.plain_path, fields)
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		widgets = {widget.field_name: widget for widget in doc[0].widgets() or []}
		doc.close()
		self.assertIn("photo", widgets)
		self.assertEqual(_widget_type_label_from_widget(widgets["photo"]), "Data")

	def test_fill_pdf_checkbox_values(self):
		fields = [
			{
				"field_name": "agree_terms",
				"field_type": "Check",
				"page": 0,
				"x": 72,
				"y": 140,
				"width": 14,
				"height": 14,
				"font_size": 10,
			}
		]
		pdf_bytes = apply_field_layout(self.plain_path, fields)
		output_path = os.path.join(self.tempdir, "checkbox.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		filled_yes = fill_pdf(output_path, {"agree_terms": "Yes"})
		doc_yes = fitz.open(stream=filled_yes, filetype="pdf")
		widget_yes = next(doc_yes[0].widgets())
		self.assertTrue(_checkbox_is_checked(widget_yes.field_value))
		doc_yes.close()

	def test_merge_fields_with_mappings(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="customer_name",
					source_type="Field Path",
					source_field="supplier_name",
					jinja_script="",
					default_value="",
					date_format="",
					editable=1,
				)
			]
		)
		pdf_fields = [
			{
				"field_name": "customer_name",
				"field_type": "Data",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 150,
				"height": 20,
				"font_size": 10,
				"options": "",
			}
		]
		merged = merge_fields_with_mappings(pdf_fields, template_doc)
		self.assertEqual(merged[0]["source_field"], "supplier_name")
		self.assertEqual(merged[0]["editable"], 1)
		self.assertEqual(merged[0].get("repeat_table", ""), "")

	def test_merge_fields_with_mappings_preserves_field_type(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="item_barcode",
					field_type="Barcode",
					source_type="Field Path",
					source_field="barcode",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
				)
			]
		)
		pdf_fields = [
			{
				"field_name": "item_barcode",
				"field_type": "Data",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 180,
				"height": 48,
				"font_size": 10,
				"options": "",
			}
		]
		merged = merge_fields_with_mappings(pdf_fields, template_doc)
		self.assertEqual(merged[0]["field_type"], "Barcode")
		self.assertEqual(merged[0]["source_field"], "barcode")

	def test_merge_fields_with_repeat_mapping(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="item_0",
					field_type="Data",
					source_type="Field Path",
					source_field="item_code",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
					repeat_table="items",
					repeat_field="item_code",
					repeat_slot=0,
				)
			]
		)
		pdf_fields = [
			{
				"field_name": "item_0",
				"field_type": "Data",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 150,
				"height": 20,
				"font_size": 10,
				"options": "",
			}
		]
		merged = merge_fields_with_mappings(pdf_fields, template_doc)
		self.assertEqual(merged[0]["repeat_table"], "items")
		self.assertEqual(merged[0]["repeat_slot"], 0)

	def test_sync_field_mappings_with_mapping_data(self):
		template_doc = SimpleNamespace(field_mappings=[])
		template_doc.set = lambda fieldname, rows: setattr(template_doc, fieldname, rows)

		fields = [
			{
				"field_name": "amount",
				"field_type": "Currency",
				"source_type": "Field Path",
				"source_field": "grand_total",
				"jinja_script": "",
				"default_value": "0",
				"date_format": "",
				"editable": 0,
			}
		]
		added, removed = sync_field_mappings(template_doc, fields)
		self.assertEqual(added, 1)
		self.assertEqual(removed, 0)
		row = template_doc.field_mappings[0]
		self.assertEqual(row["source_field"], "grand_total")
		self.assertEqual(row["default_value"], "0")
		self.assertEqual(row["field_type"], "Currency")
		self.assertEqual(row["repeat_table"], "")
		self.assertEqual(row["repeat_slot"], 0)

	def test_save_template_pdf_overwrites_attached_path(self):
		"""Design save must update the exact file_url path print reads."""
		attached_path = os.path.join(self.tempdir, "template-abc123.pdf")
		_make_plain_pdf(attached_path)

		fields = [
			{
				"field_name": "customer_name",
				"field_type": "Data",
				"page": 0,
				"x": 120,
				"y": 200,
				"width": 180,
				"height": 22,
				"font_size": 10,
			}
		]
		pdf_bytes = apply_field_layout(attached_path, fields)
		template_doc = SimpleNamespace(pdf_file="/files/template-abc123.pdf")
		mock_db = MagicMock()
		mock_db.get_value.return_value = "FILE-001"

		with patch(
			"pdffiller.utils.pdf_designer.is_template_pdf_shared", return_value=False
		), patch("pdffiller.utils.pdf_designer.frappe.db", mock_db), patch(
			"pdffiller.utils.pdf_designer.get_pdf_path", return_value=attached_path
		), patch("frappe.utils.file_manager.get_content_hash", return_value="deadbeef"):
			save_template_pdf(template_doc, pdf_bytes)

		layout = list_field_layout(attached_path)
		self.assertEqual(len(layout), 1)
		self.assertEqual(layout[0]["field_name"], "customer_name")
		self.assertAlmostEqual(layout[0]["x"], 120, places=1)
		self.assertAlmostEqual(layout[0]["y"], 200, places=1)
		mock_db.set_value.assert_called_once()
		args = mock_db.set_value.call_args
		self.assertEqual(args.args[0], "File")
		self.assertEqual(args.args[1], "FILE-001")
		self.assertEqual(args.args[2]["file_size"], len(pdf_bytes))
		self.assertEqual(args.args[2]["content_hash"], "deadbeef")

	def test_is_template_pdf_shared(self):
		self.assertFalse(is_template_pdf_shared(""))
		self.assertFalse(is_template_pdf_shared(None))
		with patch(
			"pdffiller.utils.pdf_designer.frappe.get_all",
			return_value=["Airway Bill PROT", "MAWB PROT"],
		):
			self.assertTrue(is_template_pdf_shared("/private/files/x.pdf", "MAWB PROT"))
			self.assertTrue(is_template_pdf_shared("/private/files/x.pdf", None))
		with patch(
			"pdffiller.utils.pdf_designer.frappe.get_all",
			return_value=["MAWB PROT"],
		):
			self.assertFalse(is_template_pdf_shared("/private/files/x.pdf", "MAWB PROT"))
			self.assertTrue(is_template_pdf_shared("/private/files/x.pdf", None))
		with patch("pdffiller.utils.pdf_designer.frappe.get_all", return_value=[]):
			self.assertFalse(is_template_pdf_shared("/private/files/x.pdf", "MAWB PROT"))

	def test_save_template_pdf_clones_when_shared(self):
		"""Shared file_url: write a new copy and leave the original bytes unchanged."""
		original_path = os.path.join(self.tempdir, "shared.pdf")
		exclusive_path = os.path.join(self.tempdir, "exclusive.pdf")
		_make_plain_pdf(original_path)
		with open(original_path, "rb") as handle:
			original_bytes = handle.read()

		fields = [
			{
				"field_name": "customer_name",
				"field_type": "Data",
				"page": 0,
				"x": 120,
				"y": 200,
				"width": 180,
				"height": 22,
				"font_size": 10,
			}
		]
		pdf_bytes = apply_field_layout(original_path, fields)
		template_doc = SimpleNamespace(name="MAWB PROT", pdf_file="/files/shared.pdf")

		def fake_clone(doc, _bytes):
			doc.pdf_file = "/files/exclusive.pdf"
			return doc.pdf_file

		def fake_get_pdf_path(file_url):
			if str(file_url).endswith("exclusive.pdf"):
				return exclusive_path
			return original_path

		mock_db = MagicMock()
		mock_db.get_value.return_value = "FILE-MAWB"

		with patch(
			"pdffiller.utils.pdf_designer.is_template_pdf_shared", return_value=True
		), patch(
			"pdffiller.utils.pdf_designer.create_exclusive_template_pdf", side_effect=fake_clone
		), patch(
			"pdffiller.utils.pdf_designer.get_pdf_path", side_effect=fake_get_pdf_path
		), patch(
			"pdffiller.utils.pdf_designer.frappe.db", mock_db
		), patch(
			"frappe.utils.file_manager.get_content_hash", return_value="newhash"
		):
			save_template_pdf(template_doc, pdf_bytes)

		with open(original_path, "rb") as handle:
			self.assertEqual(handle.read(), original_bytes)
		self.assertEqual(template_doc.pdf_file, "/files/exclusive.pdf")
		layout = list_field_layout(exclusive_path)
		self.assertEqual(len(layout), 1)
		self.assertEqual(layout[0]["field_name"], "customer_name")
		mock_db.set_value.assert_called_once()
		self.assertEqual(mock_db.set_value.call_args.args[1], "FILE-MAWB")

	def test_create_exclusive_template_pdf_writes_new_path(self):
		pdf_bytes = b"%PDF-1.4 exclusive"
		template_doc = SimpleNamespace(
			name="MAWB PROT",
			title="MAWB PROT",
			pdf_file="/private/files/shared.pdf",
		)
		exclusive_path = os.path.join(self.tempdir, "MAWB_PROT.pdf")
		inserted = {}

		class FakeFile:
			def __init__(self):
				self.flags = SimpleNamespace()

			def insert(self, ignore_permissions=True):
				inserted["ok"] = True

		with patch(
			"pdffiller.utils.pdf_designer._unique_private_file_target",
			return_value=("/private/files/MAWB_PROT.pdf", exclusive_path),
		), patch("pdffiller.utils.pdf_designer.frappe.get_doc", return_value=FakeFile()), patch(
			"frappe.utils.file_manager.get_content_hash", return_value="abc"
		):
			url = create_exclusive_template_pdf(template_doc, pdf_bytes)

		self.assertEqual(url, "/private/files/MAWB_PROT.pdf")
		self.assertEqual(template_doc.pdf_file, url)
		with open(exclusive_path, "rb") as handle:
			self.assertEqual(handle.read(), pdf_bytes)
		self.assertTrue(inserted["ok"])

	@patch("pdffiller.api.designer.save_template_pdf")
	@patch("pdffiller.api.designer.apply_field_layout")
	def test_save_design_api_syncs_mappings(self, mock_apply, mock_save_file):
		mock_apply.return_value = b"%PDF-1.4 test"

		template_doc = SimpleNamespace(
			name="Test Template",
			pdf_file="/files/test.pdf",
			reference_doctype="User",
			field_mappings=[],
		)
		template_doc.set = lambda fieldname, rows: setattr(template_doc, fieldname, rows)
		template_doc.save = unittest.mock.Mock()

		fields = [
			{
				"field_name": "existing_field",
				"field_type": "Data",
				"page": 0,
				"x": 72,
				"y": 72,
				"width": 150,
				"height": 20,
				"font_size": 10,
				"source_type": "Jinja Template",
				"source_field": "{{ doc.name }}",
				"jinja_script": "",
				"default_value": "",
				"date_format": "",
				"editable": 1,
				"options": "",
			}
		]

		with patch("pdffiller.api.designer._get_template", return_value=template_doc), patch(
			"pdffiller.api.designer.get_pdf_path", return_value=self.plain_path
		), patch("pdffiller.api.designer.frappe.has_permission", return_value=True), patch(
			"pdffiller.api.designer.frappe.clear_cache"
		):
			from pdffiller.api.designer import save_design

			result = save_design("Test Template", fields)

		self.assertEqual(result["added"], 1)
		self.assertEqual(template_doc.field_mappings[0]["source_type"], "Jinja Template")


def _widget_type_label_from_widget(widget):
	from pdffiller.utils.pdf_designer import _widget_type_label

	return _widget_type_label(widget)


if __name__ == "__main__":
	unittest.main()
