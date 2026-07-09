# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import os

import frappe
from frappe.utils import cstr
from frappe.utils.file_manager import get_file_path


def get_pdf_path(file_url: str) -> str:
	if not file_url:
		frappe.throw(frappe._("PDF file is not attached"))

	path = get_file_path(file_url)
	if not path or not os.path.exists(path):
		frappe.throw(frappe._("PDF file not found on disk"))
	return path


def template_has_widgets(pdf_path: str) -> bool:
	import fitz

	doc = fitz.open(pdf_path)
	try:
		for page in doc:
			if list(page.widgets() or []):
				return True
		return False
	finally:
		doc.close()


def list_acroform_fields(pdf_path: str) -> list[str]:
	import fitz

	fields: set[str] = set()
	doc = fitz.open(pdf_path)
	try:
		for page in doc:
			for widget in page.widgets() or []:
				if widget.field_name:
					fields.add(widget.field_name)
	finally:
		doc.close()
	return sorted(fields)


def _is_truthy_checkbox_value(value: str) -> bool:
	return (value or "").strip().lower() in ("yes", "true", "1", "on")


def _checkbox_is_checked(value) -> bool:
	if value is True:
		return True
	if value is False:
		return False
	return (str(value or "").strip().lower()) not in ("", "off", "no", "false", "0")


def _set_widget_value(widget, value: str) -> None:
	if widget.field_type_string in ("CheckBox", "Checkbox"):
		widget.field_value = _is_truthy_checkbox_value(value)
	else:
		widget.field_value = value or ""


def _draw_text_field(page, rect, text: str, fontsize: float) -> None:
	import fitz

	fontsize = max(fontsize, 6)
	page.insert_textbox(
		rect,
		text,
		fontname="helv",
		fontsize=fontsize,
		color=(0, 0, 0),
		align=fitz.TEXT_ALIGN_LEFT,
	)


def _draw_checkbox(page, rect, checked: bool) -> None:
	import fitz

	size = min(rect.width, rect.height)
	if size <= 0:
		return
	center_x = (rect.x0 + rect.x1) / 2
	center_y = (rect.y0 + rect.y1) / 2
	half = size / 2
	box = fitz.Rect(center_x - half, center_y - half, center_x + half, center_y + half)
	page.draw_rect(box, color=(0, 0, 0), width=0.75)
	if checked:
		inset = size * 0.2
		page.draw_line(
			fitz.Point(box.x0 + inset, box.y0 + size * 0.5),
			fitz.Point(box.x0 + size * 0.4, box.y1 - inset),
			color=(0, 0, 0),
			width=1,
		)
		page.draw_line(
			fitz.Point(box.x0 + size * 0.4, box.y1 - inset),
			fitz.Point(box.x1 - inset, box.y0 + inset),
			color=(0, 0, 0),
			width=1,
		)


def _get_mapped_fields(template_doc) -> set[str]:
	return {row.pdf_field_name for row in template_doc.field_mappings if row.pdf_field_name}


def fill_pdf_fields_only(
	template_path: str,
	form_data: dict[str, str],
	mapped_fields: set[str] | None = None,
	readonly_fields: set[str] | None = None,
) -> bytes:
	import fitz

	mapped_fields = mapped_fields or set(form_data.keys())
	readonly_fields = readonly_fields or set()
	filled_bytes = fill_pdf(template_path, form_data, readonly_fields=readonly_fields)
	filled_doc = fitz.open(stream=filled_bytes, filetype="pdf")
	output_doc = fitz.open()
	try:
		for page_num in range(len(filled_doc)):
			filled_page = filled_doc[page_num]
			rect = filled_page.rect
			output_page = output_doc.new_page(width=rect.width, height=rect.height)

			for widget in filled_page.widgets() or []:
				field_name = widget.field_name
				if not field_name or field_name not in mapped_fields:
					continue
				if widget.field_type_string == "RadioButton":
					continue

				widget_rect = widget.rect
				if widget.field_type_string in ("CheckBox", "Checkbox"):
					_draw_checkbox(output_page, widget_rect, _checkbox_is_checked(widget.field_value))
					continue

				value = cstr(widget.field_value or form_data.get(field_name, ""))
				if field_name not in readonly_fields and not value.strip():
					continue
				fontsize = float(getattr(widget, "text_fontsize", 0) or 10)
				_draw_text_field(output_page, widget_rect, value, fontsize)

		return output_doc.tobytes(garbage=4, deflate=True)
	finally:
		filled_doc.close()
		output_doc.close()


def fill_pdf(
	template_path: str,
	form_data: dict[str, str],
	readonly_fields: set[str] | None = None,
) -> bytes:
	import fitz

	readonly_fields = readonly_fields or set()
	doc = fitz.open(template_path)
	try:
		for page in doc:
			widgets = {widget.field_name: widget for widget in (page.widgets() or [])}
			for field_name, value in form_data.items():
				widget = widgets.get(field_name)
				if not widget or widget.field_type_string == "RadioButton":
					continue
				_set_widget_value(widget, value)
				if field_name in readonly_fields:
					widget.field_flags = widget.field_flags | fitz.PDF_FIELD_IS_READ_ONLY
				widget.update()
		return doc.tobytes(garbage=4, deflate=True)
	finally:
		doc.close()


def build_form_data(template_doc, source_doc, overrides: dict[str, str] | None = None) -> dict[str, str]:
	from pdffiller.utils.field_resolver import resolve_mapping_value

	overrides = overrides or {}
	form_data: dict[str, str] = {}
	for row in template_doc.field_mappings:
		if not row.pdf_field_name:
			continue
		if row.pdf_field_name in overrides:
			form_data[row.pdf_field_name] = overrides[row.pdf_field_name] or ""
		else:
			form_data[row.pdf_field_name] = resolve_mapping_value(source_doc, row)
	return form_data


def build_field_preview(template_doc, source_doc) -> list[dict]:
	from pdffiller.utils.field_resolver import resolve_mapping_value

	fields = []
	for row in template_doc.field_mappings:
		if not row.pdf_field_name:
			continue
		fields.append(
			{
				"pdf_field_name": row.pdf_field_name,
				"value": resolve_mapping_value(source_doc, row),
				"editable": bool(row.editable),
				"source_type": row.source_type or "Field Path",
			}
		)
	return fields


def _get_readonly_fields(template_doc) -> set[str]:
	return {
		row.pdf_field_name
		for row in template_doc.field_mappings
		if row.pdf_field_name and not row.editable
	}


def fill_template_pdf(
	template_doc,
	source_doc,
	overrides: dict[str, str] | None = None,
	fields_only: bool = False,
) -> bytes:
	if not template_doc.pdf_file:
		frappe.throw(frappe._("PDF Form Template has no PDF file attached"))

	pdf_path = get_pdf_path(template_doc.pdf_file)
	form_data = build_form_data(template_doc, source_doc, overrides=overrides)
	mapped_fields = _get_mapped_fields(template_doc)
	readonly_fields = _get_readonly_fields(template_doc)
	if fields_only:
		return fill_pdf_fields_only(
			pdf_path,
			form_data,
			mapped_fields=mapped_fields,
			readonly_fields=readonly_fields,
		)

	return fill_pdf(pdf_path, form_data, readonly_fields=readonly_fields)
