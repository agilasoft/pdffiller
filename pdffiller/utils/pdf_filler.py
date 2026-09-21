# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import os

import frappe
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


def _widget_matches_radio(widget, field_name: str, export_value: str) -> bool:
	if widget.field_name != field_name:
		return False
	states = (widget.button_states() or {}).get("normal", [])
	return bool(export_value) and export_value in states and export_value != "Off"


def _set_radio_field(page, field_name: str, export_value: str) -> bool:
	"""Select the radio widget whose on-state matches export_value."""
	export_value = (export_value or "").strip()
	if not export_value:
		return False
	for widget in page.widgets() or []:
		if not _widget_matches_radio(widget, field_name, export_value):
			continue
		widget.field_value = export_value
		widget.update()
		return True
	return False


def _draw_radio_selection(page, widgets, field_name: str, export_value: str) -> None:
	"""Stamp an X on the selected radio option (fields-only / flattened output)."""
	import fitz

	export_value = (export_value or "").strip()
	if not export_value:
		return
	for widget in widgets:
		if not _widget_matches_radio(widget, field_name, export_value):
			continue
		page.insert_textbox(
			widget.rect,
			"X",
			fontname="hebo",
			fontsize=max(min(widget.rect.height, widget.rect.width) - 1, 6),
			color=(0, 0, 0),
			align=fitz.TEXT_ALIGN_CENTER,
		)
		return


def _draw_text_field(
	page,
	rect,
	text: str,
	fontsize: float,
	*,
	comb_slots: int = 0,
) -> None:
	import fitz

	text = str(text or "")
	if not text.strip():
		return

	fontsize = max(fontsize, 6)
	if comb_slots and comb_slots > 0:
		slot_w = rect.width / comb_slots
		chars = list(text[:comb_slots])
		for idx, char in enumerate(chars):
			if not str(char).strip():
				continue
			slot = fitz.Rect(rect.x0 + idx * slot_w, rect.y0, rect.x0 + (idx + 1) * slot_w, rect.y1)
			page.insert_textbox(
				slot,
				char,
				fontname="helv",
				fontsize=min(fontsize, max(slot.height - 2, 6)),
				color=(0, 0, 0),
				align=fitz.TEXT_ALIGN_CENTER,
			)
		return

	align = fitz.TEXT_ALIGN_CENTER if len(text.strip()) <= 8 else fitz.TEXT_ALIGN_LEFT
	page.insert_textbox(
		rect,
		text,
		fontname="helv",
		fontsize=fontsize,
		color=(0, 0, 0),
		align=align,
	)


def _widget_comb_slots(widget) -> int:
	import fitz

	flags = int(getattr(widget, "field_flags", 0) or 0)
	maxlen = int(getattr(widget, "text_maxlen", 0) or 0)
	if maxlen > 0 and flags & fitz.PDF_TX_FIELD_IS_COMB:
		return maxlen
	return 0


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


def _draw_barcode(page, rect, value: str) -> None:
	from pdffiller.utils.barcode_renderer import generate_barcode_png

	png_bytes = generate_barcode_png(value)
	if not png_bytes:
		return

	page.insert_image(rect, stream=png_bytes, keep_proportion=True)


def _draw_image(page, rect, value: str) -> None:
	from pdffiller.utils.image_renderer import resolve_image_bytes

	image_bytes = resolve_image_bytes(value)
	if not image_bytes:
		return

	page.insert_image(rect, stream=image_bytes, keep_proportion=True)


def _get_fields_by_type(template_doc, field_type: str) -> set[str]:
	return {
		row.pdf_field_name
		for row in getattr(template_doc, "field_mappings", []) or []
		if row.pdf_field_name and (getattr(row, "field_type", None) or "") == field_type
	}


def _get_barcode_fields(template_doc) -> set[str]:
	return _get_fields_by_type(template_doc, "Barcode")


def _get_image_fields(template_doc) -> set[str]:
	return _get_fields_by_type(template_doc, "Image")


def _draw_special_field(page, rect, value: str, field_name: str, barcode_fields, image_fields) -> bool:
	if field_name in barcode_fields:
		if (value or "").strip():
			_draw_barcode(page, rect, value)
		return True
	if field_name in image_fields:
		if (value or "").strip():
			_draw_image(page, rect, value)
		return True
	return False


def fill_pdf_fields_only(
	template_path: str,
	form_data: dict[str, str],
	barcode_fields: set[str] | None = None,
	image_fields: set[str] | None = None,
) -> bytes:
	import fitz

	barcode_fields = barcode_fields or set()
	image_fields = image_fields or set()
	template_doc = fitz.open(template_path)
	output_doc = fitz.open()
	try:
		for page_num in range(len(template_doc)):
			template_page = template_doc[page_num]
			rect = template_page.rect
			output_page = output_doc.new_page(width=rect.width, height=rect.height)

			page_widgets = list(template_page.widgets() or [])
			widgets = {widget.field_name: widget for widget in page_widgets}
			radio_done: set[str] = set()
			for field_name, value in form_data.items():
				if field_name in radio_done:
					continue
				# Radio groups share a field name across multiple widgets.
				radio_widgets = [w for w in page_widgets if w.field_name == field_name and w.field_type_string == "RadioButton"]
				if radio_widgets:
					_draw_radio_selection(output_page, radio_widgets, field_name, value)
					radio_done.add(field_name)
					continue

				widget = widgets.get(field_name)
				if not widget:
					continue

				widget_rect = widget.rect
				if _draw_special_field(
					output_page, widget_rect, value, field_name, barcode_fields, image_fields
				):
					continue
				if widget.field_type_string in ("CheckBox", "Checkbox"):
					_draw_checkbox(output_page, widget_rect, _is_truthy_checkbox_value(value))
				elif (value or "").strip():
					fontsize = float(getattr(widget, "text_fontsize", 0) or 10)
					_draw_text_field(
						output_page,
						widget_rect,
						value,
						fontsize,
						comb_slots=_widget_comb_slots(widget),
					)

		# Skip garbage=4: it takes seconds on BIR face PDFs and barely shrinks them.
		return output_doc.tobytes()
	finally:
		template_doc.close()
		output_doc.close()


def fill_pdf(
	template_path: str,
	form_data: dict[str, str],
	readonly_fields: set[str] | None = None,
	barcode_fields: set[str] | None = None,
	image_fields: set[str] | None = None,
) -> bytes:
	import fitz

	readonly_fields = readonly_fields or set()
	barcode_fields = barcode_fields or set()
	image_fields = image_fields or set()
	doc = fitz.open(template_path)
	try:
		for page in doc:
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
						# Set flags on the whole group, but only update() the selected
						# widget. Updating Off siblings can re-select them in PyMuPDF.
						export_value = (value or "").strip()
						selected = None
						for widget in radio_widgets:
							widget.field_flags = widget.field_flags | fitz.PDF_FIELD_IS_READ_ONLY
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
					_draw_special_field(
						page, widget.rect, value, field_name, barcode_fields, image_fields
					)
				else:
					_set_widget_value(widget, value)
				if field_name in readonly_fields:
					widget.field_flags = widget.field_flags | fitz.PDF_FIELD_IS_READ_ONLY
				widget.update()
		# Skip garbage=4: it takes seconds on BIR face PDFs and barely shrinks them.
		return doc.tobytes()
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
	from pdffiller.utils.looping_fill import fill_looping_template, should_use_looping_fill

	if should_use_looping_fill(template_doc, pdf_path):
		return fill_looping_template(
			template_doc,
			source_doc,
			pdf_path,
			overrides=overrides,
			fields_only=fields_only,
		)

	form_data = build_form_data(template_doc, source_doc, overrides=overrides)
	barcode_fields = _get_barcode_fields(template_doc)
	image_fields = _get_image_fields(template_doc)
	if fields_only:
		return fill_pdf_fields_only(
			pdf_path,
			form_data,
			barcode_fields=barcode_fields,
			image_fields=image_fields,
		)

	readonly_fields = _get_readonly_fields(template_doc)
	return fill_pdf(
		pdf_path,
		form_data,
		readonly_fields=readonly_fields,
		barcode_fields=barcode_fields,
		image_fields=image_fields,
	)
