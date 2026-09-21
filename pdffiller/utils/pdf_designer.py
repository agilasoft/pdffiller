# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import base64
import os
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
		"Barcode",
		"Image",
		# Legacy aliases
		"Text",
		"Checkbox",
	}
)

DEFAULT_MAPPING = {
	"field_type": "",
	"source_type": "Field Path",
	"source_field": "",
	"jinja_script": "",
	"default_value": "",
	"date_format": "",
	"editable": 0,
	"options": "",
	"text_maxlen": 0,
	"comb": 0,
	"repeat_table": "",
	"repeat_field": "",
	"repeat_slot": 0,
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
				flags = int(getattr(widget, "field_flags", 0) or 0)
				fields.append(
					{
						**DEFAULT_MAPPING,
						"field_name": widget.field_name,
						"field_type": field_type,
						"page": page.number,
						"x": round(rect.x0, 2),
						"y": round(rect.y0, 2),
						"width": round(rect.width, 2),
						"height": round(rect.height, 2),
						"font_size": float(getattr(widget, "text_fontsize", 0) or 10),
						"options": _widget_options(widget) if field_type == "Select" else "",
						"text_maxlen": int(getattr(widget, "text_maxlen", 0) or 0),
						"comb": 1 if flags & fitz.PDF_TX_FIELD_IS_COMB else 0,
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
					"repeat_table": getattr(row, "repeat_table", None) or "",
					"repeat_field": getattr(row, "repeat_field", None) or "",
					"repeat_slot": int(getattr(row, "repeat_slot", 0) or 0),
				}
			)
			if getattr(row, "field_type", None):
				merged_field["field_type"] = _normalize_field_type(row.field_type)
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
			repeat_slot = int(field.get("repeat_slot") or 0)
		except (TypeError, ValueError):
			frappe.throw(_("Invalid numeric value in field {0}").format(field_name))

		if page < 0:
			frappe.throw(_("Invalid page number for field {0}").format(field_name))
		min_height = 10 if field_type == "Check" else 12
		# Allow character-box widgets (BIR comb fields are ~12pt wide).
		min_width = 12 if field_type == "Check" else 10
		if width < min_width or height < min_height:
			frappe.throw(_("Field {0} is too small").format(field_name))

		try:
			text_maxlen = int(field.get("text_maxlen") or 0)
			comb = int(field.get("comb") or 0)
		except (TypeError, ValueError):
			frappe.throw(_("Invalid text_maxlen/comb value in field {0}").format(field_name))
		if text_maxlen < 0:
			frappe.throw(_("text_maxlen cannot be negative for field {0}").format(field_name))
		if comb and not text_maxlen:
			frappe.throw(_("Comb fields require text_maxlen for field {0}").format(field_name))

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
				"text_maxlen": text_maxlen,
				"comb": 1 if comb else 0,
				"repeat_table": (field.get("repeat_table") or "").strip(),
				"repeat_field": (field.get("repeat_field") or "").strip(),
				"repeat_slot": max(0, repeat_slot),
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
		text_maxlen = int(field.get("text_maxlen") or 0)
		if text_maxlen > 0:
			widget.text_maxlen = text_maxlen
		if int(field.get("comb") or 0) and text_maxlen > 0:
			widget.field_flags = int(widget.field_flags or 0) | fitz.PDF_TX_FIELD_IS_COMB

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


def is_template_pdf_shared(file_url: str | None, template_name: str | None = None) -> bool:
	"""True when another PDF Form Template points at the same file_url."""
	if not file_url:
		return False
	names = frappe.get_all(
		"PDF Form Template",
		filters={"pdf_file": file_url},
		pluck="name",
	)
	return any(name != template_name for name in names)


def _template_pdf_basename(template_doc) -> str:
	title = (
		getattr(template_doc, "title", None)
		or getattr(template_doc, "name", None)
		or "template"
	)
	safe_name = re.sub(r"[^\w\-]+", "_", str(title).strip(), flags=re.UNICODE)
	return (safe_name.strip("_")[:60] or "template") + ".pdf"


def _template_attachment_name(template_doc) -> str | None:
	name = getattr(template_doc, "name", None)
	if not name or str(name).startswith("new-"):
		return None
	return str(name)


def _unique_private_file_target(file_name: str) -> tuple[str, str]:
	"""Return (file_url, abs_path) that is unused on disk and in File."""
	from frappe.utils import get_files_path

	base, ext = os.path.splitext(file_name)
	candidate = file_name
	index = 0
	while True:
		file_url = f"/private/files/{candidate}"
		path = get_files_path(candidate, is_private=1)
		if not os.path.exists(path) and not frappe.db.exists("File", {"file_url": file_url}):
			return file_url, path
		index += 1
		candidate = f"{base}_{index}{ext}"


def _write_pdf_bytes(path: str, pdf_bytes: bytes) -> None:
	os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
	with open(path, "wb") as handle:
		handle.write(pdf_bytes)
		handle.flush()
		os.fsync(handle.fileno())


def _attached_file_name(template_doc, file_url: str) -> str | None:
	attached_name = _template_attachment_name(template_doc)
	if attached_name:
		file_name = frappe.db.get_value(
			"File",
			{
				"file_url": file_url,
				"attached_to_doctype": "PDF Form Template",
				"attached_to_name": attached_name,
			},
			"name",
		)
		if file_name:
			return file_name
	return frappe.db.get_value("File", {"file_url": file_url}, "name")


def create_exclusive_template_pdf(template_doc, pdf_bytes: bytes) -> str:
	"""Write a private PDF used only by this template and point pdf_file at it.

	Bypasses Frappe content-hash reuse so two templates never share a path.
	"""
	from frappe.utils.file_manager import get_content_hash

	file_url, pdf_path = _unique_private_file_target(_template_pdf_basename(template_doc))
	_write_pdf_bytes(pdf_path, pdf_bytes)

	attached_name = _template_attachment_name(template_doc)
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": os.path.basename(file_url),
			"file_url": file_url,
			"is_private": 1,
			"folder": "Home/Attachments",
			"attached_to_doctype": "PDF Form Template" if attached_name else None,
			"attached_to_name": attached_name,
			"attached_to_field": "pdf_file" if attached_name else None,
			"content_hash": get_content_hash(pdf_bytes),
			"file_size": len(pdf_bytes),
		}
	)
	file_doc.flags.copy_from_existing_file = True
	file_doc.flags.ignore_duplicate_entry_error = True
	file_doc.insert(ignore_permissions=True)

	template_doc.pdf_file = file_url
	return file_url


def save_template_pdf(template_doc, pdf_bytes: bytes) -> None:
	"""Overwrite the exact PDF file the template (and print) reference.

	Do not use File.save_file(overwrite=True) alone: it rebuilds file_url from
	file_name, which often differs from the attached file_url after Frappe's
	content-hash dedupe. That writes the redesigned PDF to a different path
	while print keeps reading the old URL — so Design Fields appears to save
	but has no effect on actual output.

	If another template shares this file_url, clone first so the write cannot
	mutate the other form's layout.
	"""
	from frappe.utils.file_manager import get_content_hash

	file_url = template_doc.pdf_file
	if not file_url:
		frappe.throw(_("PDF file is not attached"))

	if is_template_pdf_shared(file_url, _template_attachment_name(template_doc)):
		file_url = create_exclusive_template_pdf(template_doc, pdf_bytes)

	file_name = _attached_file_name(template_doc, file_url)
	if not file_name:
		frappe.throw(_("Attached PDF file record not found"))

	_write_pdf_bytes(get_pdf_path(file_url), pdf_bytes)

	frappe.db.set_value(
		"File",
		file_name,
		{
			"file_size": len(pdf_bytes),
			"content_hash": get_content_hash(pdf_bytes),
		},
		update_modified=False,
	)


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
				"field_type": field.get("field_type") or "",
				"source_type": field.get("source_type") or "Field Path",
				"source_field": field.get("source_field") or "",
				"jinja_script": field.get("jinja_script") or "",
				"default_value": field.get("default_value") or "",
				"date_format": field.get("date_format") or "",
				"editable": int(field.get("editable") or 0),
				"repeat_table": (field.get("repeat_table") or "").strip(),
				"repeat_field": (field.get("repeat_field") or "").strip(),
				"repeat_slot": int(field.get("repeat_slot") or 0),
			}
		)

	template_doc.set("field_mappings", rows)
	return added, removed
