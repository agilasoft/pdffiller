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


def fill_pdf(template_path: str, form_data: dict[str, str]) -> bytes:
	import fitz

	doc = fitz.open(template_path)
	try:
		for page in doc:
			widgets = {widget.field_name: widget for widget in (page.widgets() or [])}
			for field_name, value in form_data.items():
				widget = widgets.get(field_name)
				if not widget or widget.field_type_string == "RadioButton":
					continue
				widget.field_value = value or ""
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


def fill_template_pdf(template_doc, source_doc, overrides: dict[str, str] | None = None) -> bytes:
	if not template_doc.pdf_file:
		frappe.throw(frappe._("PDF Form Template has no PDF file attached"))

	pdf_path = get_pdf_path(template_doc.pdf_file)
	form_data = build_form_data(template_doc, source_doc, overrides=overrides)
	return fill_pdf(pdf_path, form_data)
