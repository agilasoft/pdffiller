# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace

from pdffiller.utils.output_options import (
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
