# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import fitz

from pdffiller.utils.pdf_filler import build_field_preview, build_form_data, fill_pdf, list_acroform_fields, template_has_widgets


def _make_fillable_pdf(path: str, fields: dict[str, str]) -> None:
	doc = fitz.open()
	page = doc.new_page(width=595, height=842)
	for idx, (name, value) in enumerate(fields.items()):
		rect = fitz.Rect(72, 72 + (idx * 28), 300, 92 + (idx * 28))
		widget = fitz.Widget()
		widget.field_name = name
		widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
		widget.field_value = value
		widget.rect = rect
		widget.text_fontsize = 10
		page.add_widget(widget)
	doc.save(path)
	doc.close()


class TestPdfFiller(unittest.TestCase):
	def setUp(self):
		self.tempdir = tempfile.mkdtemp()
		self.template_path = os.path.join(self.tempdir, "template.pdf")
		_make_fillable_pdf(self.template_path, {"FieldA": "", "FieldB": ""})

	def test_template_has_widgets(self):
		self.assertTrue(template_has_widgets(self.template_path))

	def test_list_acroform_fields(self):
		self.assertEqual(list_acroform_fields(self.template_path), ["FieldA", "FieldB"])

	def test_fill_pdf(self):
		pdf_bytes = fill_pdf(self.template_path, {"FieldA": "Hello", "FieldB": "World"})
		output = fitz.open(stream=pdf_bytes, filetype="pdf")
		fields = {widget.field_name: widget.field_value for widget in output[0].widgets() or []}
		output.close()
		self.assertEqual(fields.get("FieldA"), "Hello")
		self.assertEqual(fields.get("FieldB"), "World")

	def test_build_form_data_with_overrides(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="FieldA",
					source_type="Field Path",
					source_field="name",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
					display_depends_on="",
				),
				SimpleNamespace(
					pdf_field_name="FieldB",
					source_type="Field Path",
					source_field="",
					jinja_script="",
					default_value="Default",
					date_format="",
					editable=1,
					display_depends_on="",
				),
			]
		)
		source_doc = SimpleNamespace(
			meta=SimpleNamespace(get_field=lambda _f: SimpleNamespace(fieldtype="Data")),
			name="DOC-001",
		)
		form_data = build_form_data(template_doc, source_doc, overrides={"FieldB": "Override"})
		self.assertEqual(form_data["FieldA"], "DOC-001")
		self.assertEqual(form_data["FieldB"], "Override")

	def test_build_field_preview(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="FieldA",
					source_type="Field Path",
					source_field="name",
					jinja_script="",
					default_value="",
					date_format="",
					editable=1,
					display_depends_on="",
				)
			]
		)
		source_doc = SimpleNamespace(
			meta=SimpleNamespace(get_field=lambda _f: SimpleNamespace(fieldtype="Data")),
			name="DOC-001",
		)
		preview = build_field_preview(template_doc, source_doc)
		self.assertEqual(len(preview), 1)
		self.assertEqual(preview[0]["pdf_field_name"], "FieldA")
		self.assertEqual(preview[0]["value"], "DOC-001")
		self.assertTrue(preview[0]["editable"])

	def test_build_form_data_skips_hidden_fields(self):
		template_doc = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="FieldA",
					source_type="Field Path",
					source_field="name",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
					display_depends_on="eval:doc.docstatus==1",
				),
				SimpleNamespace(
					pdf_field_name="FieldB",
					source_type="Field Path",
					source_field="",
					jinja_script="",
					default_value="Visible",
					date_format="",
					editable=0,
					display_depends_on="",
				),
			]
		)
		source_doc = SimpleNamespace(
			meta=SimpleNamespace(get_field=lambda _f: SimpleNamespace(fieldtype="Data")),
			name="DOC-001",
			docstatus=0,
		)

		with patch(
			"pdffiller.utils.display_condition.frappe.safe_eval",
			side_effect=lambda expr, _globals, _locals: _locals["doc"].docstatus == 1,
		):
			form_data = build_form_data(template_doc, source_doc)

		self.assertNotIn("FieldA", form_data)
		self.assertEqual(form_data["FieldB"], "Visible")


if __name__ == "__main__":
	unittest.main()
