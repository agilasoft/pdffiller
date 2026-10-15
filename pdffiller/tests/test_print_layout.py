# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json
import unittest

from pdffiller.utils.print_layout import (
	PAPER_SIZES,
	default_layout,
	field_elements_as_layout,
	parse_layout,
	roles_from_layout,
	validate_layout,
)


class TestPrintLayout(unittest.TestCase):
	def test_default_layout_is_a4_once_page(self):
		layout = default_layout()
		self.assertEqual(layout["page_width"], PAPER_SIZES["A4"][0])
		self.assertEqual(layout["page_height"], PAPER_SIZES["A4"][1])
		self.assertEqual(layout["pages"][0]["role"], "Once")
		self.assertEqual(layout["pages"][0]["elements"], [])

	def test_parse_layout_keeps_static_and_field_elements(self):
		raw = {
			"page_width": 595,
			"page_height": 842,
			"pages": [
				{
					"role": "First",
					"elements": [
						{"id": "t1", "kind": "text", "x": 72, "y": 72, "width": 120, "height": 18, "text": "Quote"},
						{
							"id": "f1",
							"kind": "field",
							"field_name": "customer",
							"field_type": "Data",
							"x": 72,
							"y": 100,
							"width": 200,
							"height": 18,
							"source_field": "customer_name",
						},
					],
				}
			],
		}
		layout = parse_layout(json.dumps(raw))
		self.assertEqual(layout["pages"][0]["role"], "First")
		self.assertEqual(len(layout["pages"][0]["elements"]), 2)
		fields = field_elements_as_layout(layout)
		self.assertEqual(fields[0]["field_name"], "customer")
		self.assertEqual(fields[0]["page"], 0)
		self.assertEqual(fields[0]["font_family"], "Helvetica")
		self.assertEqual(fields[0]["align"], "left")
		self.assertEqual(fields[0]["word_wrap"], 0)
		text = layout["pages"][0]["elements"][0]
		self.assertEqual(text["word_wrap"], 1)
		self.assertEqual(text["font_family"], "Helvetica")
		self.assertEqual(roles_from_layout(layout), {0: "First"})

	def test_parse_layout_keeps_text_style(self):
		raw = {
			"page_width": 595,
			"page_height": 842,
			"pages": [
				{
					"role": "Once",
					"elements": [
						{
							"id": "t1",
							"kind": "text",
							"x": 10,
							"y": 10,
							"width": 200,
							"height": 40,
							"text": "Title",
							"font_family": "Times",
							"bold": 1,
							"italic": 0,
							"color": "#112233",
							"align": "center",
							"word_wrap": 0,
						},
						{
							"id": "f1",
							"kind": "field",
							"field_name": "notes",
							"field_type": "Long Text",
							"x": 10,
							"y": 60,
							"width": 200,
							"height": 40,
							"font_family": "Courier",
							"bold": 1,
							"italic": 1,
							"color": "#abcdef",
							"align": "right",
						},
					],
				}
			],
		}
		layout = parse_layout(raw)
		label = layout["pages"][0]["elements"][0]
		self.assertEqual(label["font_family"], "Times")
		self.assertEqual(label["bold"], 1)
		self.assertEqual(label["align"], "center")
		self.assertEqual(label["word_wrap"], 0)
		self.assertEqual(label["color"], "#112233")
		field = field_elements_as_layout(layout)[0]
		self.assertEqual(field["font_family"], "Courier")
		self.assertEqual(field["bold"], 1)
		self.assertEqual(field["italic"], 1)
		self.assertEqual(field["align"], "right")
		self.assertEqual(field["color"], "#abcdef")
		self.assertEqual(field["word_wrap"], 1)

	def test_validate_layout_rejects_duplicate_field_names(self):
		layout = {
			"page_width": 595,
			"page_height": 842,
			"pages": [
				{
					"role": "Once",
					"elements": [
						{
							"id": "a",
							"kind": "field",
							"field_name": "customer",
							"field_type": "Data",
							"x": 10,
							"y": 10,
							"width": 80,
							"height": 18,
						},
						{
							"id": "b",
							"kind": "field",
							"field_name": "customer",
							"field_type": "Data",
							"x": 10,
							"y": 40,
							"width": 80,
							"height": 18,
						},
					],
				}
			],
		}
		with self.assertRaises(Exception):
			validate_layout(layout)


if __name__ == "__main__":
	unittest.main()
