# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import base64
import re

import frappe
from frappe import _

from pdffiller.utils.pdf_filler import get_pdf_path

FRAPPE_FIELD_TYPES = frozenset(
	{
		"Data",
		"Link",
		"Date",
		"Int",
		"Float",
		"Currency",
		"Check",
		"Select",
		"Small Text",
		"Long Text",
		# Legacy aliases
		"Text",
		"Checkbox",
	}
)

DEFAULT_MAPPING = {
	"source_type": "Field Path",
	"source_field": "",
	"jinja_script": "",
	"default_value": "",
	"date_format": "",
	"editable": 0,
	"options": "",
}

DATE_FORMATS = ["", "%d-%m-%Y", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"]
SOURCE_TYPES = ["Field Path", "Jinja Template", "Jinja Script"]


def _normalize_field_type(field_type: str | None) -> str:
	field_type = (field_type or "Data").strip()
	aliases = {"Text": "Data", "Checkbox": "Check"}
	return aliases.get(field_type, field_type)


def _parse_options(options: str) -> list[str]:
	if not options:
		return ["Option 1", "Option 2"]
	values = [line.strip() for line in re.split(r"[\n,]", options) if line.strip()]
	return values or ["Option 1", "Option 2"]


def get_page_previews(pdf_path: str, zoom: float = 2.0) -> list[dict]:
	import fitz

	pages: list[dict] = []
	doc = fitz.open(pdf_path)
	try:
		matrix = fitz.Matrix(zoom, zoom)
		for page in doc:
			rect = page.rect
			pix = page.get_pixmap(matrix=matrix, alpha=False)
			png_bytes = pix.tobytes("png")
			encoded = base64.b64encode(png_bytes).decode("ascii")
			pages.append(
				{
					"page_no": page.number,
					"width_pt": rect.width,
					"height_pt": rect.height,
					"image_data_uri": f"data:image/png;base64,{encoded}",
				}
			)
	finally:
		doc.close()
	return pages


def _widget_type_label(widget) -> str:
	import fitz

	if widget.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
		return "Check"
	if widget.field_type == fitz.PDF_WIDGET_TYPE_COMBOBOX:
		return "Select"
	if widget.field_type == fitz.PDF_WIDGET_TYPE_TEXT:
		flags = getattr(widget, "field_flags", 0) or 0
		if flags & fitz.PDF_TX_FIELD_IS_MULTILINE:
			height = widget.rect.height if widget.rect else 0
			return "Long Text" if height >= 50 else "Small Text"
		return "Data"
	return _normalize_field_type(widget.field_type_string or "Data")


def _widget_options(widget) -> str:
	choices = getattr(widget, "choice_values", None) or []
	return "\n".join(str(choice) for choice in choices if choice)


def list_field_layout(pdf_path: str) -> list[dict]:
	import fitz

	fields: list[dict] = []
	doc = fitz.open(pdf_path)
	try:
		for page in doc:
			for widget in page.widgets() or []:
				if not widget.field_name:
					continue
				rect = widget.rect
				field_type = _widget_type_label(widget)
				fields.append(
					{
						"field_name": widget.field_name,
						"field_type": field_type,
						"page": page.number,
						"x": round(rect.x0, 2),
						"y": round(rect.y0, 2),
						"width": round(rect.width, 2),
						"height": round(rect.height, 2),
						"font_size": float(getattr(widget, "text_fontsize", 0) or 10),
						"options": _widget_options(widget) if field_type == "Select" else "",
						**DEFAULT_MAPPING,
					}
				)
	finally:
		doc.close()
	return fields


def merge_fields_with_mappings(pdf_fields: list[dict], template_doc) -> list[dict]:
	mappings = {
		row.pdf_field_name: row for row in template_doc.field_mappings if row.pdf_field_name
	}
	merged: list[dict] = []

	for field in pdf_fields:
		row = mappings.get(field["field_name"])
		merged_field = {**DEFAULT_MAPPING, **field}
		if row:
			merged_field.update(
				{
					"source_type": row.source_type or "Field Path",
					"source_field": row.source_field or "",
					"jinja_script": row.jinja_script or "",
					"default_value": row.default_value or "",
					"date_format": row.date_format or "",
					"editable": int(row.editable or 0),
				}
			)
		if merged_field["field_type"] == "Date" and not merged_field["date_format"]:
			merged_field["date_format"] = "%d-%m-%Y"
		merged.append(merged_field)

	return merged


def _validate_field_layout(fields: list[dict]) -> list[dict]:
	if not isinstance(fields, list):
		frappe.throw(_("Field layout must be a list"))

	validated: list[dict] = []
	seen_names: set[str] = set()

	for idx, field in enumerate(fields):
		if not isinstance(field, dict):
			frappe.throw(_("Invalid field at index {0}").format(idx))

		field_name = (field.get("field_name") or "").strip()
		if not field_name:
			frappe.throw(_("Field name is required at index {0}").format(idx))
		if field_name in seen_names:
			frappe.throw(_("Duplicate field name: {0}").format(field_name))
		if not re.match(r"^[A-Za-z][A-Za-z0-9_]*$", field_name):
			frappe.throw(
				_(
					"Field name {0} must start with a letter and contain only letters, numbers, and underscores"
				).format(field_name)
			)
		seen_names.add(field_name)

		field_type = _normalize_field_type(field.get("field_type"))
		if field_type not in FRAPPE_FIELD_TYPES:
			frappe.throw(_("Unsupported field type: {0}").format(field_type))

		source_type = field.get("source_type") or "Field Path"
		if source_type not in SOURCE_TYPES:
			frappe.throw(_("Unsupported source type for field {0}").format(field_name))

		date_format = field.get("date_format") or ""
		if date_format and date_format not in DATE_FORMATS:
			frappe.throw(_("Unsupported date format for field {0}").format(field_name))

		try:
			page = int(field.get("page", 0))
			x = float(field.get("x", 0))
			y = float(field.get("y", 0))
			width = float(field.get("width", 0))
			height = float(field.get("height", 0))
			font_size = float(field.get("font_size") or 10)
			editable = int(field.get("editable") or 0)
		except (TypeError, ValueError):
			frappe.throw(_("Invalid numeric value in field {0}").format(field_name))

		if page < 0:
			frappe.throw(_("Invalid page number for field {0}").format(field_name))
		min_height = 10 if field_type == "Check" else 12
		min_width = 12 if field_type == "Check" else 20
		if width < min_width or height < min_height:
			frappe.throw(_("Field {0} is too small").format(field_name))

		validated.append(
			{
				"field_name": field_name,
				"field_type": field_type,
				"page": page,
				"x": x,
				"y": y,
				"width": width,
				"height": height,
				"font_size": font_size,
				"source_type": source_type,
				"source_field": field.get("source_field") or "",
				"jinja_script": field.get("jinja_script") or "",
				"default_value": field.get("default_value") or "",
				"date_format": date_format,
				"editable": editable,
				"options": field.get("options") or "",
			}
		)

	return validated


def _apply_widget(field: dict, page) -> None:
	import fitz

	widget = fitz.Widget()
	widget.field_name = field["field_name"]
	x0 = field["x"]
	y0 = field["y"]
	x1 = x0 + field["width"]
	y1 = y0 + field["height"]
	widget.rect = fitz.Rect(x0, y0, x1, y1)

	field_type = field["field_type"]
	if field_type == "Check":
		widget.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
		widget.field_value = False
	elif field_type == "Select":
		widget.field_type = fitz.PDF_WIDGET_TYPE_COMBOBOX
		widget.choice_values = _parse_options(field.get("options") or "")
		widget.field_value = widget.choice_values[0]
	elif field_type in ("Small Text", "Long Text"):
		widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
		widget.text_fontsize = field["font_size"]
		widget.field_flags = fitz.PDF_TX_FIELD_IS_MULTILINE
		widget.field_value = ""
	else:
		widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
		widget.text_fontsize = field["font_size"]
		widget.field_value = ""

	page.add_widget(widget)


def apply_field_layout(pdf_path: str, fields: list[dict]) -> bytes:
	import fitz

	validated = _validate_field_layout(fields)
	doc = fitz.open(pdf_path)
	try:
		if doc.page_count == 0:
			frappe.throw(_("PDF has no pages"))

		for page in doc:
			for widget in list(page.widgets() or []):
				page.delete_widget(widget)

		for field in validated:
			page_no = field["page"]
			if page_no >= doc.page_count:
				frappe.throw(_("Field {0} references invalid page {1}").format(field["field_name"], page_no + 1))
			_apply_widget(field, doc[page_no])

		return doc.tobytes(garbage=4, deflate=True)
	finally:
		doc.close()


def save_template_pdf(template_doc, pdf_bytes: bytes) -> None:
	file_url = template_doc.pdf_file
	if not file_url:
		frappe.throw(_("PDF file is not attached"))

	file_name = frappe.db.get_value("File", {"file_url": file_url}, "name")
	if not file_name:
		frappe.throw(_("Attached PDF file record not found"))

	file_doc = frappe.get_doc("File", file_name)
	file_doc.save_file(content=pdf_bytes, overwrite=True)


def sync_field_mappings(template_doc, fields: list[dict]) -> tuple[int, int]:
	existing = {
		row.pdf_field_name: row
		for row in template_doc.field_mappings
		if row.pdf_field_name
	}
	new_names = [field["field_name"] for field in fields]
	new_name_set = set(new_names)
	old_name_set = set(existing.keys())

	added = len(new_name_set - old_name_set)
	removed = len(old_name_set - new_name_set)

	rows = []
	for field in fields:
		name = field["field_name"]
		prev = existing.get(name)
		rows.append(
			{
				"pdf_field_name": name,
				"source_type": field.get("source_type") or "Field Path",
				"source_field": field.get("source_field") or "",
				"jinja_script": field.get("jinja_script") or "",
				"default_value": field.get("default_value") or "",
				"date_format": field.get("date_format") or "",
				"editable": int(field.get("editable") or 0),
			}
		)

	template_doc.set("field_mappings", rows)
	return added, removed
