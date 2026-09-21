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
		self.assertEqual(roles_from_layout(layout), {0: "First"})

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
