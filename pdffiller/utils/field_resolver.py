# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

import frappe
from frappe.utils import cstr, flt, formatdate, getdate

JINJA_MARKERS = re.compile(r"(\{\{|\{%)")


class _JinjaFrappeProxy:
	"""Jinja `frappe` helper: utils (fmt_money, formatdate) plus app APIs (db, get_doc)."""

	def __getattr__(self, name: str):
		if hasattr(frappe.utils, name):
			return getattr(frappe.utils, name)
		return getattr(frappe, name)


def get_jinja_context(source_doc, extra: dict[str, Any] | None = None) -> dict[str, Any]:
	context = {
		"doc": source_doc,
		"frappe": _JinjaFrappeProxy(),
	}
	if extra:
		context.update(extra)
	return context


def is_jinja_template(value: str) -> bool:
	return bool(JINJA_MARKERS.search(value or ""))


def get_source_type(mapping_row) -> str:
	source_type = (getattr(mapping_row, "source_type", None) or "").strip()
	if source_type:
		return source_type

	if getattr(mapping_row, "jinja_script", None):
		return "Jinja Script"
	if is_jinja_template(getattr(mapping_row, "source_field", None)):
		return "Jinja Template"
	return "Field Path"


def render_jinja_template(template: str, source_doc, extra: dict[str, Any] | None = None) -> str:
	template = (template or "").strip()
	if not template:
		return ""

	try:
		return cstr(frappe.render_template(template, get_jinja_context(source_doc, extra))).strip()
	except Exception:
		frappe.log_error(
			title="PDF Form Template Jinja Error",
			message=frappe.get_traceback(),
		)
		return ""


def resolve_mapping_value(source_doc, mapping_row, extra: dict[str, Any] | None = None) -> str:
	from pdffiller.utils.page_planner import SYSTEM_SOURCE_FIELDS, mapping_get

	value = ""
	raw_dates = bool(mapping_row.date_format)
	source_type = get_source_type(mapping_row)
	extra = extra or {}
	child_row = extra.get("row")

	source_field = (mapping_get(mapping_row, "source_field") or "").strip()
	repeat_field = (mapping_get(mapping_row, "repeat_field") or "").strip()
	system_name = source_field if source_field in SYSTEM_SOURCE_FIELDS else ""
	if not system_name and repeat_field in SYSTEM_SOURCE_FIELDS:
		system_name = repeat_field
	if system_name and "page_n" in extra:
		from pdffiller.utils.page_planner import OutputPage, system_field_value

		page = extra.get("output_page")
		if isinstance(page, OutputPage):
			return system_field_value(system_name, page)
		return cstr(extra.get(system_name) or "")

	if source_type == "Jinja Script":
		value = render_jinja_template(mapping_row.jinja_script, source_doc, extra)
	elif source_type == "Jinja Template":
		value = render_jinja_template(mapping_row.source_field, source_doc, extra)
	elif mapping_get(mapping_row, "repeat_table"):
		target = child_row
		fieldname = repeat_field or source_field
		if target is not None and fieldname:
			value = resolve_field_path(target, fieldname, raw_dates=raw_dates)
	elif mapping_row.source_field:
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

	meta = getattr(doc, "meta", None)
	field = meta.get_field(fieldname) if meta else None
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
