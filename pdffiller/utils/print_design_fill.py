# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe
from frappe import _

from pdffiller.utils.image_renderer import resolve_image_bytes
from pdffiller.utils.looping_fill import _value_for_field
from pdffiller.utils.page_planner import (
	OutputPage,
	PagePlanError,
	count_slots_by_page,
	detect_repeat_table,
	get_child_rows,
	mapping_get,
	parse_page_roles,
	plan_output_pages,
)
from pdffiller.utils.pdf_filler import (
	_draw_checkbox,
	_draw_special_field,
	_draw_text_field,
	_get_barcode_fields,
	_get_image_fields,
	_is_truthy_checkbox_value,
)
from pdffiller.utils.print_layout import (
	FIELD_KIND,
	field_elements_as_layout,
	parse_color,
	parse_layout,
	roles_from_layout,
)


def fill_print_design(design_doc, source_doc, overrides: dict[str, str] | None = None) -> bytes:
	import fitz

	overrides = overrides or {}
	layout = parse_layout(
		mapping_get(design_doc, "layout_json", None),
		mapping_get(design_doc, "page_width", None),
		mapping_get(design_doc, "page_height", None),
	)
	field_layout = field_elements_as_layout(layout)
	mappings = {
		row.pdf_field_name: row
		for row in (mapping_get(design_doc, "field_mappings", []) or [])
		if mapping_get(row, "pdf_field_name")
	}
	page_count = len(layout["pages"])
	roles = parse_page_roles(roles_from_layout(layout), page_count)
	slots_by_page = count_slots_by_page(field_layout, mappings)
	always_last = bool(int(mapping_get(design_doc, "always_print_last", 0) or 0))

	try:
		repeat_table = detect_repeat_table(mappings.values())
		child_rows = get_child_rows(source_doc, repeat_table)
		plan = plan_output_pages(
			page_count=page_count,
			roles=roles,
			slots_by_page=slots_by_page,
			item_count=len(child_rows),
			always_print_last=always_last,
		)
	except PagePlanError as exc:
		frappe.throw(_(str(exc) or "Line items do not fit this template. Add a Loop page."))

	barcode_fields = _get_barcode_fields(design_doc)
	image_fields = _get_image_fields(design_doc)
	fields_by_page = _fields_by_page(field_layout)
	page_width = float(layout["page_width"])
	page_height = float(layout["page_height"])

	output = fitz.open()
	try:
		for page_spec in plan:
			page_def = layout["pages"][page_spec.template_page]
			out_page = output.new_page(width=page_width, height=page_height)
			_draw_static_elements(out_page, page_def.get("elements") or [])
			_draw_bound_fields(
				out_page,
				fields_by_page.get(page_spec.template_page, []),
				mappings,
				source_doc,
				child_rows,
				overrides,
				page_spec,
				barcode_fields,
				image_fields,
			)
		return output.tobytes()
	finally:
		output.close()


def _fields_by_page(layout: list[dict]) -> dict[int, list[dict]]:
	pages: dict[int, list[dict]] = {}
	for field in layout:
		pages.setdefault(int(field.get("page") or 0), []).append(field)
	return pages


def _fitted_fontsize(rect, requested: float) -> float:
	height = max(float(rect.height), 1.0)
	return max(6.0, min(float(requested or 10), height / 1.85))


def _draw_static_elements(page, elements: list[dict]) -> None:
	import fitz

	for element in elements:
		kind = element.get("kind")
		if kind == FIELD_KIND:
			continue
		x = float(element.get("x") or 0)
		y = float(element.get("y") or 0)
		width = float(element.get("width") or 0)
		height = float(element.get("height") or 0)

		if kind == "text":
			text = str(element.get("text") or "")
			if not text.strip():
				continue
			rect = fitz.Rect(x, y, x + max(width, 4), y + max(height, 4))
			align_name = (element.get("align") or "left").lower()
			align = {
				"center": fitz.TEXT_ALIGN_CENTER,
				"right": fitz.TEXT_ALIGN_RIGHT,
			}.get(align_name, fitz.TEXT_ALIGN_LEFT)
			page.insert_textbox(
				rect,
				text,
				fontname="helv",
				fontsize=_fitted_fontsize(rect, float(element.get("font_size") or 10)),
				color=parse_color(element.get("color")),
				align=align,
			)
			continue

		if kind == "rect":
			rect = fitz.Rect(x, y, x + max(width, 1), y + max(height, 1))
			fill = (element.get("fill") or "").strip()
			page.draw_rect(
				rect,
				color=parse_color(element.get("stroke")),
				fill=parse_color(fill) if fill else None,
				width=max(float(element.get("line_width") or 1), 0.25),
			)
			continue

		if kind == "line":
			dashed = (element.get("line_style") or "solid") == "dashed"
			page.draw_line(
				fitz.Point(x, y),
				fitz.Point(x + width, y + height),
				color=parse_color(element.get("stroke") or element.get("color")),
				width=max(float(element.get("line_width") or 1), 0.25),
				dashes="[3 2]" if dashed else None,
			)
			continue

		if kind == "image":
			url = (element.get("image_url") or "").strip()
			if not url:
				continue
			data = resolve_image_bytes(url)
			if not data:
				continue
			rect = fitz.Rect(x, y, x + max(width, 4), y + max(height, 4))
			page.insert_image(rect, stream=data, keep_proportion=True)


def _draw_bound_fields(
	page,
	fields: list[dict],
	mappings: dict,
	source_doc,
	child_rows: list,
	overrides: dict[str, str],
	page_spec: OutputPage,
	barcode_fields,
	image_fields,
) -> None:
	import fitz

	for field in fields:
		name = field.get("field_name")
		if not name:
			continue
		value = _value_for_field(
			field,
			mappings.get(name),
			source_doc,
			child_rows,
			page_spec,
			overrides,
		)
		rect = fitz.Rect(
			float(field.get("x") or 0),
			float(field.get("y") or 0),
			float(field.get("x") or 0) + max(float(field.get("width") or 0), 4),
			float(field.get("y") or 0) + max(float(field.get("height") or 0), 4),
		)
		if _draw_special_field(page, rect, value, name, barcode_fields, image_fields):
			continue
		field_type = (field.get("field_type") or mapping_get(mappings.get(name), "field_type", "Data") or "Data")
		if field_type in ("Check", "Checkbox"):
			_draw_checkbox(page, rect, _is_truthy_checkbox_value(value))
			continue
		if (value or "").strip():
			_draw_text_field(
				page,
				rect,
				value,
				_fitted_fontsize(rect, float(field.get("font_size") or 10)),
			)
