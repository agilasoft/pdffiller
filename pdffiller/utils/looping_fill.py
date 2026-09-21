# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from pdffiller.utils.field_resolver import resolve_mapping_value
from pdffiller.utils.page_planner import (
	OutputPage,
	PagePlanError,
	count_slots_by_page,
	detect_repeat_table,
	get_child_rows,
	mapping_get,
	parse_page_roles,
	plan_output_pages,
	template_uses_looping,
)
from pdffiller.utils.pdf_designer import list_field_layout
from pdffiller.utils.pdf_filler import (
	_draw_checkbox,
	_draw_radio_selection,
	_draw_special_field,
	_draw_text_field,
	_get_barcode_fields,
	_get_image_fields,
	_get_readonly_fields,
	_is_truthy_checkbox_value,
	_set_radio_field,
	_set_widget_value,
	_widget_comb_slots,
)


def fill_looping_template(
	template_doc,
	source_doc,
	pdf_path: str,
	overrides: dict[str, str] | None = None,
	fields_only: bool = False,
) -> bytes:
	import fitz

	overrides = overrides or {}
	layout = list_field_layout(pdf_path)
	mappings = {
		row.pdf_field_name: row
		for row in (template_doc.field_mappings or [])
		if mapping_get(row, "pdf_field_name")
	}

	template_pdf = fitz.open(pdf_path)
	try:
		page_count = template_pdf.page_count
		roles = parse_page_roles(mapping_get(template_doc, "page_roles", None), page_count)
		slots_by_page = count_slots_by_page(layout, mappings)
		always_last = bool(int(mapping_get(template_doc, "always_print_last", 0) or 0))

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

		barcode_fields = _get_barcode_fields(template_doc)
		image_fields = _get_image_fields(template_doc)
		readonly_fields = _get_readonly_fields(template_doc)
		layout_by_page = _layout_by_page(layout)

		output = fitz.open()
		try:
			for page_spec in plan:
				if fields_only:
					_append_fields_only_page(
						template_pdf,
						output,
						page_spec,
						layout_by_page.get(page_spec.template_page, []),
						mappings,
						source_doc,
						child_rows,
						overrides,
						barcode_fields,
						image_fields,
					)
				else:
					_append_widget_page(
						template_pdf,
						output,
						page_spec,
						layout_by_page.get(page_spec.template_page, []),
						mappings,
						source_doc,
						child_rows,
						overrides,
						barcode_fields,
						image_fields,
						readonly_fields,
					)
			return output.tobytes()
		finally:
			output.close()
	finally:
		template_pdf.close()


def _layout_by_page(layout: list[dict]) -> dict[int, list[dict]]:
	pages: dict[int, list[dict]] = {}
	for field in layout:
		pages.setdefault(int(field.get("page") or 0), []).append(field)
	return pages


def _page_extra(page_spec: OutputPage, child_row=None) -> dict[str, Any]:
	return {
		"row": child_row,
		"page_n": page_spec.page_n,
		"page_count": page_spec.page_count,
		"continued": "1" if page_spec.continued else "",
		"output_page": page_spec,
	}


def _value_for_field(
	field: dict,
	mapping,
	source_doc,
	child_rows: list,
	page_spec: OutputPage,
	overrides: dict[str, str],
) -> str:
	name = field.get("field_name") or ""
	if name in overrides:
		return overrides[name] or ""
	if not mapping:
		return ""

	child_row = None
	if mapping_get(mapping, "repeat_table"):
		slot = int(mapping_get(mapping, "repeat_slot", 0) or 0)
		index = page_spec.row_start + slot
		if page_spec.row_start <= index < page_spec.row_end and index < len(child_rows):
			child_row = child_rows[index]
		elif index >= page_spec.row_end or index >= len(child_rows):
			return mapping_get(mapping, "default_value") or ""

	return resolve_mapping_value(
		source_doc,
		mapping,
		extra=_page_extra(page_spec, child_row),
	)


def _append_widget_page(
	template_pdf,
	output,
	page_spec: OutputPage,
	page_fields: list[dict],
	mappings: dict,
	source_doc,
	child_rows: list,
	overrides: dict[str, str],
	barcode_fields,
	image_fields,
	readonly_fields,
):
	import fitz

	one = fitz.open()
	try:
		one.insert_pdf(template_pdf, from_page=page_spec.template_page, to_page=page_spec.template_page)
		page = one[0]
		form_data = {
			field["field_name"]: _value_for_field(
				field,
				mappings.get(field["field_name"]),
				source_doc,
				child_rows,
				page_spec,
				overrides,
			)
			for field in page_fields
			if field.get("field_name")
		}
		_fill_page_widgets(
			page,
			form_data,
			readonly_fields,
			barcode_fields,
			image_fields,
		)
		_suffix_widget_names(page, page_spec.page_n)
		output.insert_pdf(one)
	finally:
		one.close()


def _append_fields_only_page(
	template_pdf,
	output,
	page_spec: OutputPage,
	page_fields: list[dict],
	mappings: dict,
	source_doc,
	child_rows: list,
	overrides: dict[str, str],
	barcode_fields,
	image_fields,
):
	import fitz

	src = template_pdf[page_spec.template_page]
	rect = src.rect
	page = output.new_page(width=rect.width, height=rect.height)
	page_widgets = list(src.widgets() or [])
	widgets = {widget.field_name: widget for widget in page_widgets}
	radio_done: set[str] = set()

	for field in page_fields:
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
		if name in radio_done:
			continue
		radio_widgets = [
			w for w in page_widgets if w.field_name == name and w.field_type_string == "RadioButton"
		]
		if radio_widgets:
			_draw_radio_selection(page, radio_widgets, name, value)
			radio_done.add(name)
			continue
		widget = widgets.get(name)
		if not widget:
			continue
		if _draw_special_field(page, widget.rect, value, name, barcode_fields, image_fields):
			continue
		if widget.field_type_string in ("CheckBox", "Checkbox"):
			_draw_checkbox(page, widget.rect, _is_truthy_checkbox_value(value))
		elif (value or "").strip():
			_draw_text_field(
				page,
				widget.rect,
				value,
				float(getattr(widget, "text_fontsize", 0) or 10),
				comb_slots=_widget_comb_slots(widget),
			)


def _fill_page_widgets(page, form_data, readonly_fields, barcode_fields, image_fields):
	import fitz

	page_widgets = list(page.widgets() or [])
	widgets = {widget.field_name: widget for widget in page_widgets}
	radio_done: set[str] = set()
	for field_name, value in form_data.items():
		if field_name in radio_done:
			continue
		radio_widgets = [
			w for w in page_widgets if w.field_name == field_name and w.field_type_string == "RadioButton"
		]
		if radio_widgets:
			_set_radio_field(page, field_name, value)
			if field_name in readonly_fields:
				export_value = (value or "").strip()
				selected = None
				for widget in radio_widgets:
					widget.field_flags = widget.field_flags | fitz.PDF_FIELD_IS_READ_ONLY
					from pdffiller.utils.pdf_filler import _widget_matches_radio

					if _widget_matches_radio(widget, field_name, export_value):
						selected = widget
				if selected:
					selected.field_value = export_value
					selected.update()
			radio_done.add(field_name)
			continue

		widget = widgets.get(field_name)
		if not widget:
			continue
		if field_name in barcode_fields or field_name in image_fields:
			_set_widget_value(widget, "")
			_draw_special_field(page, widget.rect, value, field_name, barcode_fields, image_fields)
		else:
			_set_widget_value(widget, value)
		if field_name in readonly_fields:
			widget.field_flags = widget.field_flags | fitz.PDF_FIELD_IS_READ_ONLY
		widget.update()


def _suffix_widget_names(page, page_n: int) -> None:
	for widget in page.widgets() or []:
		if not widget.field_name:
			continue
		widget.field_name = f"{widget.field_name}__p{page_n}"
		widget.update()


def should_use_looping_fill(template_doc, pdf_path: str | None = None) -> bool:
	return template_uses_looping(template_doc)
