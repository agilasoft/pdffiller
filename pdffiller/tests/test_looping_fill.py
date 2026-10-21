# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import fitz

from pdffiller.utils.pdf_filler import fill_template_pdf


def _add_text_widget(page, name, y, x=72, width=200, height=18):
	widget = fitz.Widget()
	widget.field_name = name
	widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
	widget.rect = fitz.Rect(x, y, x + width, y + height)
	widget.text_fontsize = 10
	widget.field_value = ""
	page.add_widget(widget)


def _mapping(name, **kwargs):
	data = dict(
		pdf_field_name=name,
		field_type="Data",
		source_type="Field Path",
		source_field=kwargs.get("source_field", ""),
		jinja_script="",
		default_value="",
		date_format="",
		editable=0,
		repeat_table=kwargs.get("repeat_table", ""),
		repeat_field=kwargs.get("repeat_field", ""),
		repeat_slot=kwargs.get("repeat_slot", 0),
	)
	data.update(kwargs)
	return SimpleNamespace(**data)


class TestLoopingFill(unittest.TestCase):
	def setUp(self):
		self.tempdir = tempfile.mkdtemp()
		self.template_path = os.path.join(self.tempdir, "loop.pdf")
		doc = fitz.open()
		doc.new_page(width=595, height=842)
		doc.new_page(width=595, height=842)
		first = doc[0]
		loop = doc[1]
		_add_text_widget(first, "quote_no", 40)
		_add_text_widget(first, "item_0", 100)
		_add_text_widget(first, "item_1", 130)
		_add_text_widget(first, "page_n", 800)
		_add_text_widget(loop, "quote_no", 40)
		_add_text_widget(loop, "item_0", 80)
		_add_text_widget(loop, "item_1", 110)
		_add_text_widget(loop, "page_n", 800)
		doc.save(self.template_path)
		doc.close()

	def _template(self, always_print_last=0):
		return SimpleNamespace(
			pdf_file="/files/loop.pdf",
			page_roles={"0": "First", "1": "Loop"},
			always_print_last=always_print_last,
			field_mappings=[
				_mapping("quote_no", source_field="name"),
				_mapping("item_0", repeat_table="items", repeat_field="item_code", repeat_slot=0),
				_mapping("item_1", repeat_table="items", repeat_field="item_code", repeat_slot=1),
				_mapping("page_n", source_field="page_n"),
			],
		)

	def _source(self, codes):
		return SimpleNamespace(
			name="QTN-1",
			items=[SimpleNamespace(item_code=code) for code in codes],
		)

	def _values_by_page(self, pdf_bytes):
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		try:
			pages = []
			for page in doc:
				values = {}
				for widget in page.widgets() or []:
					name = (widget.field_name or "").split("__p")[0]
					values[name] = widget.field_value
				pages.append(values)
			return pages
		finally:
			doc.close()

	def test_clones_loop_pages_and_binds_child_rows(self):
		template_doc = self._template()
		source_doc = self._source(["A", "B", "C", "D", "E"])
		with patch("pdffiller.utils.pdf_filler.get_pdf_path", return_value=self.template_path):
			filled = fill_template_pdf(template_doc, source_doc)

		pages = self._values_by_page(filled)
		self.assertEqual(len(pages), 3)
		self.assertEqual(pages[0]["quote_no"], "QTN-1")
		self.assertEqual(pages[0]["item_0"], "A")
		self.assertEqual(pages[0]["item_1"], "B")
		self.assertEqual(pages[1]["item_0"], "C")
		self.assertEqual(pages[1]["item_1"], "D")
		self.assertEqual(pages[2]["item_0"], "E")
		self.assertEqual(pages[2]["item_1"], "")
		self.assertEqual(pages[0]["page_n"], "1")
		self.assertEqual(pages[2]["page_n"], "3")
		self.assertEqual(pages[1]["quote_no"], "QTN-1")

		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			names = [widget.field_name for page in doc for widget in page.widgets() or []]
			self.assertEqual(len(names), len(set(names)))
		finally:
			doc.close()

	def test_fields_only_looping(self):
		template_doc = self._template()
		source_doc = self._source(["A", "B", "C"])
		with patch("pdffiller.utils.pdf_filler.get_pdf_path", return_value=self.template_path):
			filled = fill_template_pdf(template_doc, source_doc, fields_only=True)

		doc = fitz.open(stream=filled, filetype="pdf")
		try:
			self.assertEqual(doc.page_count, 2)
			self.assertEqual(list(doc[0].widgets() or []), [])
		finally:
			doc.close()

	def test_overflow_without_loop_throws(self):
		template_doc = SimpleNamespace(
			pdf_file="/files/loop.pdf",
			page_roles={"0": "First"},
			always_print_last=0,
			field_mappings=[
				_mapping("item_0", repeat_table="items", repeat_field="item_code", repeat_slot=0),
				_mapping("item_1", repeat_table="items", repeat_field="item_code", repeat_slot=1),
			],
		)
		# Single-page extract: copy first page only
		one = fitz.open()
		src = fitz.open(self.template_path)
		one.insert_pdf(src, from_page=0, to_page=0)
		src.close()
		one_path = os.path.join(self.tempdir, "first_only.pdf")
		one.save(one_path)
		one.close()

		source_doc = self._source(["A", "B", "C", "D", "E"])
		with patch("pdffiller.utils.pdf_filler.get_pdf_path", return_value=one_path):
			with self.assertRaises(Exception):
				fill_template_pdf(template_doc, source_doc)


if __name__ == "__main__":
	unittest.main()
