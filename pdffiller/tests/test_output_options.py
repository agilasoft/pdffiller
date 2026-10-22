# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace

from pdffiller.utils.output_options import (
	apply_output_options,
	editable_field_names,
	flatten_pdf,
	merge_pdfs,
	should_stamp_draft,
	stamp_draft_watermark,
	zip_pdfs,
)


def _blank_pdf() -> bytes:
	import fitz

	doc = fitz.open()
	doc.new_page()
	data = doc.tobytes()
	doc.close()
	return data


def _widget_pdf() -> bytes:
	import fitz

	doc = fitz.open()
	page = doc.new_page()
	widget = fitz.Widget()
	widget.field_name = "Name"
	widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
	widget.rect = fitz.Rect(72, 72, 300, 96)
	widget.field_value = "Ada"
	page.add_widget(widget)
	data = doc.tobytes()
	doc.close()
	return data


def _locked_and_open_pdf() -> bytes:
	import fitz

	doc = fitz.open()
	page = doc.new_page()
	locked = fitz.Widget()
	locked.field_name = "Locked"
	locked.field_type = fitz.PDF_WIDGET_TYPE_TEXT
	locked.rect = fitz.Rect(72, 72, 280, 96)
	locked.field_value = "KEEP TEXT"
	locked.text_fontsize = 12
	page.add_widget(locked)

	opened = fitz.Widget()
	opened.field_name = "Open"
	opened.field_type = fitz.PDF_WIDGET_TYPE_TEXT
	opened.rect = fitz.Rect(72, 120, 280, 148)
	opened.field_value = "EDIT ME"
	opened.text_fontsize = 12
	opened.field_flags = fitz.PDF_FIELD_IS_READ_ONLY
	page.add_widget(opened)
	stored = next(widget for widget in page.widgets() if widget.field_name == "Open")
	doc.xref_set_key(stored.xref, "DA", "(0 0 0 rg /HeBo 12 Tf)")
	doc.xref_set_key(stored.xref, "Q", "1")
	doc.xref_set_key(stored.xref, "Ff", str(int(fitz.PDF_FIELD_IS_READ_ONLY)))
	data = doc.tobytes()
	doc.close()
	return data


class TestOutputOptions(unittest.TestCase):
	def test_flatten_removes_widgets_and_keeps_text(self):
		import fitz

		flattened = flatten_pdf(_widget_pdf())
		doc = fitz.open(stream=flattened, filetype="pdf")
		try:
			widgets = list(doc[0].widgets() or [])
			self.assertEqual(widgets, [])
			self.assertIn("Ada", doc[0].get_text())
		finally:
			doc.close()

	def test_flatten_keeps_editable_widgets_and_burns_the_rest(self):
		import fitz

		flattened = flatten_pdf(_locked_and_open_pdf(), keep_fields={"Open"})
		doc = fitz.open(stream=flattened, filetype="pdf")
		try:
			widgets = {widget.field_name: widget for widget in doc[0].widgets() or []}
			self.assertEqual(set(widgets), {"Open"})
			self.assertEqual(widgets["Open"].field_value, "EDIT ME")
			self.assertFalse(widgets["Open"].field_flags & fitz.PDF_FIELD_IS_READ_ONLY)
			self.assertIn("HeBo", doc.xref_get_key(widgets["Open"].xref, "DA")[1])
			self.assertEqual(doc.xref_get_key(widgets["Open"].xref, "Q")[1], "1")
			text = doc[0].get_text()
			self.assertEqual(text.count("KEEP TEXT"), 1)
			self.assertNotIn("Locked", widgets)
		finally:
			doc.close()

	def test_flatten_keeps_loop_page_suffix(self):
		import fitz

		doc = fitz.open()
		page = doc.new_page()
		widget = fitz.Widget()
		widget.field_name = "Open__p2"
		widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
		widget.rect = fitz.Rect(72, 72, 280, 96)
		widget.field_value = "ROW"
		page.add_widget(widget)
		raw = doc.tobytes()
		doc.close()

		flattened = flatten_pdf(raw, keep_fields={"Open"})
		doc = fitz.open(stream=flattened, filetype="pdf")
		try:
			widgets = list(doc[0].widgets() or [])
			self.assertEqual([widget.field_name for widget in widgets], ["Open__p2"])
			self.assertEqual(widgets[0].field_value, "ROW")
		finally:
			doc.close()

	def test_editable_field_names_reads_the_check_flag(self):
		template = SimpleNamespace(
			field_mappings=[
				SimpleNamespace(pdf_field_name="Open", editable=1),
				SimpleNamespace(pdf_field_name="Also", editable="1"),
				SimpleNamespace(pdf_field_name="Locked", editable=0),
				SimpleNamespace(pdf_field_name="", editable=1),
			]
		)
		self.assertEqual(editable_field_names(template), {"Open", "Also"})

	def test_apply_output_options_keeps_editable_fields_under_draft_stamp(self):
		import fitz

		template = SimpleNamespace(
			flatten=1,
			skip_draft_watermark=0,
			field_mappings=[
				SimpleNamespace(pdf_field_name="Open", editable=1),
				SimpleNamespace(pdf_field_name="Locked", editable=0),
			],
		)
		source = SimpleNamespace(meta=SimpleNamespace(is_submittable=1), docstatus=0)
		result = apply_output_options(_locked_and_open_pdf(), template, source)
		doc = fitz.open(stream=result, filetype="pdf")
		try:
			widgets = {widget.field_name: widget for widget in doc[0].widgets() or []}
			self.assertEqual(set(widgets), {"Open"})
			self.assertEqual(widgets["Open"].field_value, "EDIT ME")
			self.assertFalse(widgets["Open"].field_flags & fitz.PDF_FIELD_IS_READ_ONLY)
			self.assertIn("KEEP TEXT", doc[0].get_text())
			self.assertIn("DRAFT", doc[0].get_text())
			_kind, appearances = doc.xref_get_key(doc.pdf_catalog(), "AcroForm/NeedAppearances")
			self.assertIn("true", str(appearances).lower())
		finally:
			doc.close()

	def test_draft_watermark_is_readable(self):
		import fitz

		stamped = stamp_draft_watermark(_blank_pdf())
		doc = fitz.open(stream=stamped, filetype="pdf")
		try:
			self.assertIn("DRAFT", doc[0].get_text())
		finally:
			doc.close()

	def test_merge_pdfs_keeps_both_pages(self):
		import fitz

		merged = merge_pdfs([_blank_pdf(), _blank_pdf()])
		doc = fitz.open(stream=merged, filetype="pdf")
		try:
			self.assertEqual(len(doc), 2)
		finally:
			doc.close()

	def test_zip_pdfs_contains_named_entries(self):
		import io
		import zipfile

		payload = zip_pdfs([("a.pdf", b"one"), ("a.pdf", b"two")])
		with zipfile.ZipFile(io.BytesIO(payload)) as archive:
			names = archive.namelist()
		self.assertEqual(len(names), 2)
		self.assertIn("a.pdf", names)

	def test_should_stamp_draft_only_for_unsubmitted_submittable_docs(self):
		template = SimpleNamespace(skip_draft_watermark=0)
		draft = SimpleNamespace(meta=SimpleNamespace(is_submittable=1), docstatus=0)
		submitted = SimpleNamespace(meta=SimpleNamespace(is_submittable=1), docstatus=1)
		plain = SimpleNamespace(meta=SimpleNamespace(is_submittable=0), docstatus=0)
		self.assertTrue(should_stamp_draft(template, draft))
		self.assertFalse(should_stamp_draft(template, submitted))
		self.assertFalse(should_stamp_draft(template, plain))
		self.assertFalse(should_stamp_draft(SimpleNamespace(skip_draft_watermark=1), draft))


if __name__ == "__main__":
	unittest.main()
