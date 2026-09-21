# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Any

PAGE_ROLES = ("Once", "First", "Loop", "Last")
PAGING_ROLES = ("First", "Loop", "Last")
SYSTEM_SOURCE_FIELDS = frozenset({"page_n", "page_count", "continued"})


class PagePlanError(ValueError):
	"""Raised when items cannot fit the template page roles."""

	def __init__(self, code: str, message: str = ""):
		self.code = code
		super().__init__(message or code)


@dataclass(frozen=True)
class OutputPage:
	role: str
	template_page: int
	row_start: int
	row_end: int
	page_n: int = 0
	page_count: int = 0
	continued: bool = False

	@property
	def row_count(self) -> int:
		return max(0, self.row_end - self.row_start)


def mapping_get(row: Any, key: str, default: Any = "") -> Any:
	if row is None:
		return default
	if isinstance(row, dict):
		value = row.get(key, default)
	else:
		value = getattr(row, key, default)
	if value is None:
		return default
	return value


def parse_page_roles(raw: Any, page_count: int) -> dict[int, str]:
	data: Any = raw
	if isinstance(raw, str) and raw.strip():
		try:
			data = json.loads(raw)
		except json.JSONDecodeError:
			data = {}
	if not data:
		data = {}
	if isinstance(data, list):
		data = {index: value for index, value in enumerate(data)}

	roles: dict[int, str] = {}
	for index in range(max(0, page_count)):
		value = data.get(index, data.get(str(index), "Once")) or "Once"
		if value not in PAGE_ROLES:
			value = "Once"
		roles[index] = value
	return roles


def dump_page_roles(roles: dict[int, str]) -> dict[str, str]:
	return {str(index): role for index, role in sorted(roles.items())}


def template_uses_looping(template_doc: Any, page_count: int = 0) -> bool:
	for row in mapping_get(template_doc, "field_mappings", []) or []:
		if mapping_get(row, "repeat_table"):
			return True

	raw = mapping_get(template_doc, "page_roles", None)
	roles = parse_page_roles(raw, page_count or _infer_role_page_count(raw))
	return any(role in PAGING_ROLES for role in roles.values())


def _infer_role_page_count(raw: Any) -> int:
	data = raw
	if isinstance(raw, str) and raw.strip():
		try:
			data = json.loads(raw)
		except json.JSONDecodeError:
			return 0
	if isinstance(data, dict) and data:
		keys = []
		for key in data:
			try:
				keys.append(int(key))
			except (TypeError, ValueError):
				continue
		return max(keys) + 1 if keys else 0
	if isinstance(data, list):
		return len(data)
	return 0


def detect_repeat_table(mappings: Any) -> str:
	tables: list[str] = []
	for row in mappings or []:
		table = (mapping_get(row, "repeat_table") or "").strip()
		if table and table not in tables:
			tables.append(table)
	if len(tables) > 1:
		raise PagePlanError(
			"multiple_tables",
			"A template can only repeat one child table",
		)
	return tables[0] if tables else ""


def count_slots_by_page(layout: list[dict], mappings: dict[str, Any]) -> dict[int, int]:
	slots: dict[int, set[int]] = {}
	for field in layout or []:
		name = field.get("field_name")
		row = mappings.get(name) if name else None
		if not mapping_get(row, "repeat_table"):
			continue
		page = int(field.get("page") or 0)
		slot = int(mapping_get(row, "repeat_slot", 0) or 0)
		slots.setdefault(page, set()).add(slot)
	return {page: len(values) for page, values in slots.items()}


def get_child_rows(source_doc: Any, table_field: str) -> list[Any]:
	if not table_field:
		return []
	rows = mapping_get(source_doc, table_field, None)
	if rows is None:
		return []
	return list(rows)


def plan_output_pages(
	*,
	page_count: int,
	roles: dict[int, str],
	slots_by_page: dict[int, int],
	item_count: int,
	always_print_last: bool = False,
) -> list[OutputPage]:
	if page_count <= 0:
		raise PagePlanError("no_pages", "PDF has no pages")

	roles = parse_page_roles(roles, page_count)
	paging = [index for index, role in roles.items() if role in PAGING_ROLES]
	if not paging:
		return _plan_sequential_pages(page_count, roles, slots_by_page, item_count)

	first_idx = _first_index(roles, "First")
	loop_idx = _first_index(roles, "Loop")
	last_idx = _first_index(roles, "Last")

	first_slots = slots_by_page.get(first_idx, 0) if first_idx is not None else 0
	loop_slots = slots_by_page.get(loop_idx, 0) if loop_idx is not None else 0
	last_slots = slots_by_page.get(last_idx, 0) if last_idx is not None else 0

	if loop_idx is not None and loop_slots <= 0 and item_count > first_slots + last_slots:
		raise PagePlanError("empty_loop", "Loop page has no repeating item rows")

	prefix = [index for index, role in roles.items() if role == "Once" and index < min(paging)]
	suffix = [index for index, role in roles.items() if role == "Once" and index not in prefix]

	pages: list[OutputPage] = [
		OutputPage(role="Once", template_page=index, row_start=0, row_end=0) for index in prefix
	]

	remaining = max(0, int(item_count))
	cursor = 0

	if first_idx is not None:
		take = min(first_slots, remaining) if first_slots else 0
		pages.append(
			OutputPage(
				role="First",
				template_page=first_idx,
				row_start=cursor,
				row_end=cursor + take,
			)
		)
		cursor += take
		remaining -= take

	reserve_last = last_slots if last_idx is not None else 0
	totals_only_last = last_idx is not None and last_slots <= 0
	emit_last = last_idx is not None and (always_print_last or totals_only_last or remaining > 0)

	if loop_idx is not None and loop_slots > 0:
		while remaining > (reserve_last if emit_last and not totals_only_last else 0):
			leave = reserve_last if emit_last and not totals_only_last else 0
			take = min(loop_slots, remaining - leave)
			if take <= 0:
				break
			pages.append(
				OutputPage(
					role="Loop",
					template_page=loop_idx,
					row_start=cursor,
					row_end=cursor + take,
				)
			)
			cursor += take
			remaining -= take

	if emit_last and last_idx is not None:
		take = min(last_slots, remaining) if last_slots else 0
		pages.append(
			OutputPage(
				role="Last",
				template_page=last_idx,
				row_start=cursor,
				row_end=cursor + take,
			)
		)
		cursor += take
		remaining -= take

	if remaining > 0:
		raise PagePlanError(
			"no_loop",
			"Line items do not fit this template. Add a Loop page.",
		)

	pages.extend(
		OutputPage(role="Once", template_page=index, row_start=0, row_end=0) for index in suffix
	)
	return _finalize(pages)


def _plan_sequential_pages(
	page_count: int,
	roles: dict[int, str],
	slots_by_page: dict[int, int],
	item_count: int,
) -> list[OutputPage]:
	if not any(slots_by_page.values()) or item_count <= 0:
		return _finalize(
			[
				OutputPage(role=roles[index], template_page=index, row_start=0, row_end=0)
				for index in range(page_count)
			]
		)

	remaining = max(0, int(item_count))
	cursor = 0
	pages: list[OutputPage] = []
	for index in range(page_count):
		cap = slots_by_page.get(index, 0)
		take = min(cap, remaining) if cap else 0
		pages.append(
			OutputPage(
				role=roles[index],
				template_page=index,
				row_start=cursor,
				row_end=cursor + take,
			)
		)
		cursor += take
		remaining -= take

	if remaining > 0:
		raise PagePlanError(
			"no_loop",
			"Line items do not fit this template. Add a Loop page.",
		)
	return _finalize(pages)


def _first_index(roles: dict[int, str], role: str) -> int | None:
	for index in sorted(roles):
		if roles[index] == role:
			return index
	return None


def _finalize(pages: list[OutputPage]) -> list[OutputPage]:
	count = len(pages)
	return [
		replace(
			page,
			page_n=index + 1,
			page_count=count,
			continued=index < count - 1,
		)
		for index, page in enumerate(pages)
	]


def system_field_value(field_name: str, page: OutputPage) -> str:
	if field_name == "page_n":
		return str(page.page_n)
	if field_name == "page_count":
		return str(page.page_count)
	if field_name == "continued":
		return "1" if page.continued else ""
	return ""
