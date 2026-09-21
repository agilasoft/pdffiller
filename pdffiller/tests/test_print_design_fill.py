# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json
import unittest
from types import SimpleNamespace

import fitz

from pdffiller.utils.print_design_fill import fill_print_design


def _mapping(name, **kwargs):
	data = dict(
		pdf_field_name=name,
		field_type=kwargs.get("field_type", "Data"),
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


def _field_element(name, y, slot=None, table=""):
	el = {
		"id": name,
		"kind": "field",
		"field_name": name,
		"field_type": "Data",
		"x": 72,
		"y": y,
		"width": 200,
		"height": 16,
		"font_size": 10,
		"source_field": "item_code" if table else name,
		"repeat_table": table,
		"repeat_field": "item_code" if table else "",
		"repeat_slot": slot or 0,
	}
	return el


class TestPrintDesignFill(unittest.TestCase):
	def test_blank_page_draws_label_and_bound_field(self):
		layout = {
			"page_width": 595,
			"page_height": 842,
			"pages": [
				{
					"role": "Once",
					"elements": [
						{
							"id": "label",
							"kind": "text",
							"x": 72,
							"y": 72,
							"width": 200,
							"height": 18,
							"text": "Customer",
							"font_size": 12,
						},
						{
							"id": "field",
							"kind": "field",
							"field_name": "customer",
							"field_type": "Data",
							"x": 72,
							"y": 100,
							"width": 220,
							"height": 18,
							"font_size": 10,
							"source_field": "customer_name",
						},
					],
				}
			],
		}
		design = SimpleNamespace(
			layout_json=json.dumps(layout),
			page_width=595,
			page_height=842,
			page_roles={"0": "Once"},
			always_print_last=0,
			field_mappings=[_mapping("customer", source_field="customer_name")],
		)
		source = SimpleNamespace(customer_name="Acme Corp")
		pdf_bytes = fill_print_design(design, source)
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		try:
			self.assertEqual(doc.page_count, 1)
			self.assertEqual(round(doc[0].rect.width), 595)
			self.assertEqual(round(doc[0].rect.height), 842)
			text = doc[0].get_text()
			self.assertIn("Customer", text)
			self.assertIn("Acme Corp", text)
			self.assertEqual(list(doc[0].widgets() or []), [])
		finally:
			doc.close()

	def test_first_plus_loop_clones_for_overflow_rows(self):
		item_slots = [_field_element(f"item_{i}", 80 + i * 18, slot=i, table="items") for i in range(10)]
		layout = {
			"page_width": 595,
			"page_height": 842,
			"pages": [
				{
					"role": "First",
					"elements": [
						{
							"id": "title",
							"kind": "text",
							"x": 72,
							"y": 40,
							"width": 200,
							"height": 18,
							"text": "Quote",
							"font_size": 14,
						},
						{
							"id": "quote_no",
							"kind": "field",
							"field_name": "quote_no",
							"field_type": "Data",
							"x": 72,
							"y": 58,
							"width": 160,
							"height": 16,
							"source_field": "name",
						},
					]
					+ item_slots,
				},
				{
					"role": "Loop",
					"elements": [_field_element(f"loop_item_{i}", 80 + i * 18, slot=i, table="items") for i in range(10)],
				},
			],
		}
		mappings = [_mapping("quote_no", source_field="name")]
		for i in range(10):
			mappings.append(
				_mapping(f"item_{i}", repeat_table="items", repeat_field="item_code", repeat_slot=i)
			)
			mappings.append(
				_mapping(f"loop_item_{i}", repeat_table="items", repeat_field="item_code", repeat_slot=i)
			)
		design = SimpleNamespace(
			layout_json=json.dumps(layout),
			page_width=595,
			page_height=842,
			page_roles={"0": "First", "1": "Loop"},
			always_print_last=0,
			field_mappings=mappings,
		)
		codes = [f"ITEM-{i:02d}" for i in range(50)]
		source = SimpleNamespace(
			name="QTN-50",
			items=[SimpleNamespace(item_code=code) for code in codes],
		)
		pdf_bytes = fill_print_design(design, source)
		doc = fitz.open(stream=pdf_bytes, filetype="pdf")
		try:
			self.assertEqual(doc.page_count, 5)
			first_text = doc[0].get_text()
			self.assertIn("Quote", first_text)
			self.assertIn("QTN-50", first_text)
			self.assertIn("ITEM-00", first_text)
			self.assertIn("ITEM-09", first_text)
			self.assertNotIn("ITEM-10", first_text)
			loop_text = doc[1].get_text()
			self.assertIn("ITEM-10", loop_text)
			self.assertIn("ITEM-19", loop_text)
			last_text = doc[4].get_text()
			self.assertIn("ITEM-40", last_text)
			self.assertIn("ITEM-49", last_text)
		finally:
			doc.close()


if __name__ == "__main__":
	unittest.main()
