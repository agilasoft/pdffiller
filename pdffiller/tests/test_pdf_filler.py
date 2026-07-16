# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import fitz

from pdffiller.utils.pdf_filler import (
	build_field_preview,
	build_form_data,
	fill_pdf,
	fill_pdf_fields_only,
	list_acroform_fields,
	template_has_widgets,
)
from pdffiller.utils.pdf_designer import apply_field_layout


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

	def test_fill_pdf_marks_readonly_fields(self):
		pdf_bytes = fill_pdf(
			self.template_path,
			{"FieldA": "Hello", "FieldB": "World"},
			readonly_fields={"FieldA"},
		)
		output = fitz.open(stream=pdf_bytes, filetype="pdf")
		flags = {
			widget.field_name: widget.field_flags & fitz.PDF_FIELD_IS_READ_ONLY
			for widget in output[0].widgets() or []
		}
		output.close()
		self.assertTrue(flags.get("FieldA"))
		self.assertFalse(flags.get("FieldB"))

	def test_fill_pdf_fields_only_omits_background(self):
		template_doc = fitz.open(self.template_path)
		template_page = template_doc[0]
		template_page.insert_text((72, 50), "Background Label", fontsize=12)
		with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
			background_path = tmp.name
		template_doc.save(background_path)
		template_doc.close()

		pdf_bytes = fill_pdf_fields_only(background_path, {"FieldA": "Hello", "FieldB": "World"})
		output = fitz.open(stream=pdf_bytes, filetype="pdf")
		try:
			self.assertEqual(len(output), 1)
			page_text = output[0].get_text()
			self.assertIn("Hello", page_text)
			self.assertIn("World", page_text)
			self.assertNotIn("Background Label", page_text)
			self.assertEqual(list(output[0].widgets() or []), [])
		finally:
			output.close()
			os.unlink(background_path)

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
				),
				SimpleNamespace(
					pdf_field_name="FieldB",
					source_type="Field Path",
					source_field="",
					jinja_script="",
					default_value="Default",
					date_format="",
					editable=1,
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

	def test_fill_pdf_renders_barcode_image(self):
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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		output_path = os.path.join(self.tempdir, "barcode.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		filled = fill_pdf(output_path, {"item_barcode": "ITEM-001"}, barcode_fields={"item_barcode"})
		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
			widget = next(doc[0].widgets())
			self.assertEqual(widget.field_value, "")
		finally:
			doc.close()

	def test_fill_pdf_fields_only_renders_barcode_image(self):
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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		output_path = os.path.join(self.tempdir, "barcode_fields_only.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		filled = fill_pdf_fields_only(output_path, {"item_barcode": "ITEM-001"}, barcode_fields={"item_barcode"})
		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
			self.assertEqual(list(doc[0].widgets() or []), [])
		finally:
			doc.close()

	def test_fill_template_pdf_uses_barcode_field_type(self):
		from pdffiller.utils.pdf_filler import fill_template_pdf

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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		template_path = os.path.join(self.tempdir, "barcode_template.pdf")
		with open(template_path, "wb") as handle:
			handle.write(pdf_bytes)

		template_doc = SimpleNamespace(
			pdf_file="/files/barcode_template.pdf",
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="item_barcode",
					field_type="Barcode",
					source_type="Field Path",
					source_field="name",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
				)
			],
		)
		source_doc = SimpleNamespace(
			meta=SimpleNamespace(get_field=lambda _f: SimpleNamespace(fieldtype="Barcode")),
			name="ITEM-001",
		)

		with unittest.mock.patch("pdffiller.utils.pdf_filler.get_pdf_path", return_value=template_path):
			filled = fill_template_pdf(template_doc, source_doc, fields_only=True)

		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
		finally:
			doc.close()

	def _tiny_png_path(self) -> str:
		import base64

		png = base64.b64decode(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
		)
		path = os.path.join(self.tempdir, "tiny.png")
		with open(path, "wb") as handle:
			handle.write(png)
		return path

	def test_fill_pdf_renders_image_field(self):
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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		output_path = os.path.join(self.tempdir, "image.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		image_path = self._tiny_png_path()
		filled = fill_pdf(output_path, {"photo": image_path}, image_fields={"photo"})
		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
			widget = next(doc[0].widgets())
			self.assertEqual(widget.field_value, "")
		finally:
			doc.close()

	def test_fill_pdf_fields_only_renders_image_field(self):
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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		output_path = os.path.join(self.tempdir, "image_fields_only.pdf")
		with open(output_path, "wb") as handle:
			handle.write(pdf_bytes)

		image_path = self._tiny_png_path()
		filled = fill_pdf_fields_only(output_path, {"photo": image_path}, image_fields={"photo"})
		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
			self.assertEqual(list(doc[0].widgets() or []), [])
		finally:
			doc.close()

	def test_fill_template_pdf_uses_image_field_type(self):
		from pdffiller.utils.pdf_filler import fill_template_pdf

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
		pdf_bytes = apply_field_layout(self.template_path, fields)
		template_path = os.path.join(self.tempdir, "image_template.pdf")
		with open(template_path, "wb") as handle:
			handle.write(pdf_bytes)

		image_path = self._tiny_png_path()
		template_doc = SimpleNamespace(
			pdf_file="/files/image_template.pdf",
			field_mappings=[
				SimpleNamespace(
					pdf_field_name="photo",
					field_type="Image",
					source_type="Field Path",
					source_field="image",
					jinja_script="",
					default_value="",
					date_format="",
					editable=0,
				)
			],
		)
		source_doc = SimpleNamespace(
			meta=SimpleNamespace(get_field=lambda _f: SimpleNamespace(fieldtype="Attach Image")),
			image=image_path,
		)

		with unittest.mock.patch("pdffiller.utils.pdf_filler.get_pdf_path", return_value=template_path):
			filled = fill_template_pdf(template_doc, source_doc, fields_only=True)

		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertGreater(len(doc[0].get_images()), 0)
		finally:
			doc.close()


if __name__ == "__main__":
	unittest.main()
