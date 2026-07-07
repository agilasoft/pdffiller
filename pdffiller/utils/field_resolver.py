# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import frappe
from frappe.utils import cstr, flt, formatdate, getdate


def resolve_mapping_value(source_doc, mapping_row) -> str:
	value = ""
	raw_dates = bool(mapping_row.date_format)
	if mapping_row.source_field:
		value = resolve_field_path(source_doc, mapping_row.source_field, raw_dates=raw_dates)

	if value in (None, ""):
		value = mapping_row.default_value or ""

	if mapping_row.date_format and value not in (None, ""):
		value = format_date_value(value, mapping_row.date_format)

	return cstr(value)


def resolve_field_path(doc, field_path: str, raw_dates: bool = False) -> Any:
	field_path = (field_path or "").strip()
	if not field_path:
		return ""

	if "." not in field_path:
		return format_doc_value(doc, field_path, getattr(doc, field_path, None), raw_dates=raw_dates)

	link_field, nested_field = field_path.split(".", 1)
	link_value = getattr(doc, link_field, None)
	if not link_value:
		return ""

	link_meta = frappe.get_meta(doc.meta.get_field(link_field).options)
	if link_meta.issingle:
		linked_doc = frappe.get_doc(link_meta.name)
	else:
		linked_doc = frappe.get_doc(link_meta.name, link_value)

	if "." in nested_field:
		return resolve_field_path(linked_doc, nested_field, raw_dates=raw_dates)

	return format_doc_value(linked_doc, nested_field, getattr(linked_doc, nested_field, None), raw_dates=raw_dates)


def format_doc_value(doc, fieldname: str, value: Any, raw_dates: bool = False) -> str:
	if value in (None, ""):
		return ""

	field = doc.meta.get_field(fieldname)
	if not field:
		return cstr(value)

	fieldtype = field.fieldtype
	if fieldtype in ("Date", "Datetime"):
		parsed = getdate(value)
		if raw_dates:
			return cstr(parsed)
		return formatdate(parsed)
	if fieldtype in ("Currency", "Float", "Int"):
		return cstr(flt(value, field.precision or 2) if fieldtype != "Int" else int(value))
	if fieldtype == "Check":
		return "Yes" if value else "No"
	return cstr(value)


def format_date_value(value: Any, date_format: str) -> str:
	try:
		parsed = getdate(value)
	except Exception:
		return cstr(value)

	if isinstance(parsed, datetime):
		parsed = parsed.date()
	if not isinstance(parsed, date):
		return cstr(value)

	return parsed.strftime(date_format)
