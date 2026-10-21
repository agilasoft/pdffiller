# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest

from pdffiller.utils.page_planner import (
	PagePlanError,
	count_slots_by_page,
	detect_repeat_table,
	parse_page_roles,
	plan_output_pages,
	template_uses_looping,
)


QUOTE = {"first": 8, "loop": 16, "last": 6}
JOB = {"first": 14, "loop": 22, "last": 0}


def _roles(*names):
	return {index: name for index, name in enumerate(names)}


def _slots(first=0, loop=0, last=0, extra=None):
	slots = {}
	if first:
		slots[0] = first
	if loop:
		slots[1] = loop
	if last:
		slots[2] = last
	if extra:
		slots.update(extra)
	return slots


def _plan(items, spec, always_last=False, has_last=True, has_loop=True):
	if has_last:
		roles = _roles("First", "Loop", "Last")
		page_count = 3
		slots = _slots(spec["first"], spec["loop"] if has_loop else 0, spec["last"])
		if not has_loop:
			roles = _roles("First", "Once", "Last")
	else:
		roles = _roles("First", "Loop")
		page_count = 2
		slots = _slots(spec["first"], spec["loop"])
	return plan_output_pages(
		page_count=page_count,
		roles=roles,
		slots_by_page=slots,
		item_count=items,
		always_print_last=always_last,
	)


class TestPagePlanner(unittest.TestCase):
	def test_parse_page_roles_defaults_once(self):
		self.assertEqual(parse_page_roles(None, 2), {0: "Once", 1: "Once"})
		self.assertEqual(parse_page_roles({"0": "First", "1": "Loop"}, 2), {0: "First", 1: "Loop"})

	def test_quote_short_fits_first(self):
		pages = _plan(8, QUOTE)
		self.assertEqual([page.role for page in pages], ["First"])
		self.assertEqual(pages[0].row_count, 8)

	def test_quote_always_print_last(self):
		pages = _plan(8, QUOTE, always_last=True)
		self.assertEqual([page.role for page in pages], ["First", "Last"])
		self.assertEqual(pages[1].row_count, 0)

	def test_quote_skips_loop_when_last_fits(self):
		pages = _plan(12, QUOTE)
		self.assertEqual([page.role for page in pages], ["First", "Last"])
		self.assertEqual(pages[0].row_count, 8)
		self.assertEqual(pages[1].row_count, 4)

	def test_quote_fifty_lines(self):
		pages = _plan(50, QUOTE)
		self.assertEqual([page.role for page in pages], ["First", "Loop", "Loop", "Loop", "Last"])
		self.assertEqual([page.row_count for page in pages], [8, 16, 16, 4, 6])
		self.assertEqual(pages[-1].page_n, 5)
		self.assertEqual(pages[-1].page_count, 5)
		self.assertTrue(pages[0].continued)
		self.assertFalse(pages[-1].continued)

	def test_quote_eighty_seven_lines(self):
		pages = _plan(87, QUOTE)
		self.assertEqual(sum(page.row_count for page in pages), 87)
		self.assertEqual(pages[0].role, "First")
		self.assertEqual(pages[-1].role, "Last")
		self.assertGreater(sum(1 for page in pages if page.role == "Loop"), 1)

	def test_job_no_last_layout(self):
		pages = _plan(50, JOB, has_last=False)
		self.assertEqual([page.role for page in pages], ["First", "Loop", "Loop"])
		self.assertEqual([page.row_count for page in pages], [14, 22, 14])

	def test_job_short(self):
		pages = _plan(8, JOB, has_last=False)
		self.assertEqual([page.role for page in pages], ["First"])
		self.assertEqual(pages[0].row_count, 8)

	def test_overflow_without_loop_raises(self):
		with self.assertRaises(PagePlanError) as ctx:
			_plan(50, QUOTE, has_loop=False)
		self.assertEqual(ctx.exception.code, "no_loop")

	def test_totals_only_last_drains_items(self):
		pages = plan_output_pages(
			page_count=3,
			roles=_roles("First", "Loop", "Last"),
			slots_by_page={0: 8, 1: 16, 2: 0},
			item_count=20,
			always_print_last=False,
		)
		self.assertEqual([page.role for page in pages], ["First", "Loop", "Last"])
		self.assertEqual([page.row_count for page in pages], [8, 12, 0])

	def test_once_prefix_and_suffix(self):
		pages = plan_output_pages(
			page_count=4,
			roles=_roles("Once", "First", "Loop", "Once"),
			slots_by_page={1: 2, 2: 2},
			item_count=5,
		)
		self.assertEqual([page.role for page in pages], ["Once", "First", "Loop", "Loop", "Once"])
		self.assertEqual(pages[0].template_page, 0)
		self.assertEqual(pages[-1].template_page, 3)

	def test_untagged_repeat_slots_fill_then_error(self):
		pages = plan_output_pages(
			page_count=1,
			roles={0: "Once"},
			slots_by_page={0: 8},
			item_count=5,
		)
		self.assertEqual(pages[0].row_count, 5)
		with self.assertRaises(PagePlanError):
			plan_output_pages(
				page_count=1,
				roles={0: "Once"},
				slots_by_page={0: 8},
				item_count=50,
			)

	def test_no_roles_no_slots_is_identity(self):
		pages = plan_output_pages(
			page_count=2,
			roles={},
			slots_by_page={},
			item_count=50,
		)
		self.assertEqual([page.role for page in pages], ["Once", "Once"])
		self.assertEqual(pages[0].row_count, 0)

	def test_detect_repeat_table(self):
		from types import SimpleNamespace

		self.assertEqual(
			detect_repeat_table([SimpleNamespace(repeat_table="items"), SimpleNamespace(repeat_table="items")]),
			"items",
		)
		with self.assertRaises(PagePlanError):
			detect_repeat_table(
				[SimpleNamespace(repeat_table="items"), SimpleNamespace(repeat_table="taxes")]
			)

	def test_count_slots_by_page(self):
		from types import SimpleNamespace

		layout = [
			{"field_name": "a0", "page": 0},
			{"field_name": "a1", "page": 0},
			{"field_name": "b0", "page": 1},
		]
		mappings = {
			"a0": SimpleNamespace(repeat_table="items", repeat_slot=0),
			"a1": SimpleNamespace(repeat_table="items", repeat_slot=1),
			"b0": SimpleNamespace(repeat_table="items", repeat_slot=0),
		}
		self.assertEqual(count_slots_by_page(layout, mappings), {0: 2, 1: 1})

	def test_template_uses_looping(self):
		from types import SimpleNamespace

		plain = SimpleNamespace(field_mappings=[SimpleNamespace(repeat_table="")], page_roles=None)
		self.assertFalse(template_uses_looping(plain))
		repeating = SimpleNamespace(
			field_mappings=[SimpleNamespace(repeat_table="items")],
			page_roles=None,
		)
		self.assertTrue(template_uses_looping(repeating))
		roles = SimpleNamespace(field_mappings=[], page_roles={"0": "First"})
		self.assertTrue(template_uses_looping(roles))


if __name__ == "__main__":
	unittest.main()
