# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest

import fitz

from pdffiller.utils.pdf_filler import fill_pdf, list_acroform_fields, template_has_widgets


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


if __name__ == "__main__":
	unittest.main()
