# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _

from pdffiller.utils.page_planner import PAGE_ROLES
from pdffiller.utils.pdf_designer import DATE_FORMATS, FRAPPE_FIELD_TYPES, SOURCE_TYPES, _normalize_field_type

PAPER_SIZES = {
	"A4": (595.0, 842.0),
	"Letter": (612.0, 792.0),
	"Legal": (612.0, 1008.0),
}

STATIC_KINDS = ("text", "rect", "line", "image")
FIELD_KIND = "field"
ELEMENT_KINDS = STATIC_KINDS + (FIELD_KIND,)

DEFAULT_PAGE_WIDTH = 595.0
DEFAULT_PAGE_HEIGHT = 842.0


def apply_paper_size(doc: Any) -> None:
	size = (getattr(doc, "paper_size", None) or "A4").strip() or "A4"
	if size != "Custom" and size in PAPER_SIZES:
		width, height = PAPER_SIZES[size]
		doc.page_width = width
		doc.page_height = height
	if not getattr(doc, "page_width", None):
		doc.page_width = DEFAULT_PAGE_WIDTH
	if not getattr(doc, "page_height", None):
		doc.page_height = DEFAULT_PAGE_HEIGHT


def default_layout(page_width: float | None = None, page_height: float | None = None) -> dict:
	return {
		"page_width": float(page_width or DEFAULT_PAGE_WIDTH),
		"page_height": float(page_height or DEFAULT_PAGE_HEIGHT),
		"pages": [{"role": "Once", "elements": []}],
	}


def dump_layout(layout: dict) -> str:
	return json.dumps(layout, separators=(",", ":"))


def parse_layout(raw: Any, page_width: float | None = None, page_height: float | None = None) -> dict:
	data = raw
	if isinstance(raw, str) and raw.strip():
		try:
			data = json.loads(raw)
		except json.JSONDecodeError:
			data = {}
	if not isinstance(data, dict) or not data:
		return default_layout(page_width, page_height)

	width = _as_float(data.get("page_width"), page_width or DEFAULT_PAGE_WIDTH)
	height = _as_float(data.get("page_height"), page_height or DEFAULT_PAGE_HEIGHT)
	pages_in = data.get("pages")
	if not isinstance(pages_in, list) or not pages_in:
		return default_layout(width, height)

	pages = []
	for page in pages_in:
		if not isinstance(page, dict):
			continue
		role = page.get("role") or "Once"
		if role not in PAGE_ROLES:
			role = "Once"
		elements = []
		for element in page.get("elements") or []:
			normalized = _normalize_element(element)
			if normalized:
				elements.append(normalized)
		pages.append({"role": role, "elements": elements})

	if not pages:
		return default_layout(width, height)
	return {"page_width": width, "page_height": height, "pages": pages}


def roles_from_layout(layout: dict) -> dict[int, str]:
	roles: dict[int, str] = {}
	for index, page in enumerate(layout.get("pages") or []):
		role = page.get("role") or "Once"
		if role not in PAGE_ROLES:
			role = "Once"
		roles[index] = role
	return roles


def field_elements_as_layout(layout: dict) -> list[dict]:
	fields: list[dict] = []
	for page_index, page in enumerate(layout.get("pages") or []):
		for element in page.get("elements") or []:
			if element.get("kind") != FIELD_KIND:
				continue
			name = (element.get("field_name") or "").strip()
			if not name:
				continue
			fields.append(
				{
					"field_name": name,
					"field_type": _normalize_field_type(element.get("field_type")),
					"page": page_index,
					"x": float(element.get("x") or 0),
					"y": float(element.get("y") or 0),
					"width": float(element.get("width") or 0),
					"height": float(element.get("height") or 0),
					"font_size": float(element.get("font_size") or 10),
					"source_type": element.get("source_type") or "Field Path",
					"source_field": element.get("source_field") or "",
					"jinja_script": element.get("jinja_script") or "",
					"default_value": element.get("default_value") or "",
					"date_format": element.get("date_format") or "",
					"editable": int(element.get("editable") or 0),
					"options": element.get("options") or "",
					"repeat_table": (element.get("repeat_table") or "").strip(),
					"repeat_field": (element.get("repeat_field") or "").strip(),
					"repeat_slot": int(element.get("repeat_slot") or 0),
					"color": element.get("color") or "#000000",
				}
			)
	return fields


def merge_layout_with_mappings(layout: dict, design_doc) -> dict:
	mappings = {
		row.pdf_field_name: row
		for row in getattr(design_doc, "field_mappings", None) or []
		if getattr(row, "pdf_field_name", None)
	}
	for page in layout.get("pages") or []:
		for element in page.get("elements") or []:
			if element.get("kind") != FIELD_KIND:
				continue
			row = mappings.get(element.get("field_name"))
			if not row:
				continue
			element["field_type"] = getattr(row, "field_type", None) or element.get("field_type") or "Data"
			element["source_type"] = getattr(row, "source_type", None) or element.get("source_type") or "Field Path"
			element["source_field"] = getattr(row, "source_field", None) or ""
			element["jinja_script"] = getattr(row, "jinja_script", None) or ""
			element["default_value"] = getattr(row, "default_value", None) or ""
			element["date_format"] = getattr(row, "date_format", None) or ""
			element["editable"] = int(getattr(row, "editable", 0) or 0)
			element["repeat_table"] = (getattr(row, "repeat_table", None) or "").strip()
			element["repeat_field"] = (getattr(row, "repeat_field", None) or "").strip()
			element["repeat_slot"] = int(getattr(row, "repeat_slot", 0) or 0)
	return layout


def validate_layout(layout: dict) -> dict:
	layout = parse_layout(layout)
	if layout["page_width"] < 72 or layout["page_height"] < 72:
		frappe.throw(_("Page size is too small"))

	seen_names: set[str] = set()
	for page_index, page in enumerate(layout["pages"]):
		role = page.get("role") or "Once"
		if role not in PAGE_ROLES:
			frappe.throw(_("Invalid page role on page {0}").format(page_index + 1))
		for element in page.get("elements") or []:
			_validate_element(element, page_index, seen_names, layout)
	return layout


def parse_color(value: str | None) -> tuple[float, float, float]:
	value = (value or "#000000").strip()
	if value.startswith("#") and len(value) == 7:
		try:
			return (
				int(value[1:3], 16) / 255.0,
				int(value[3:5], 16) / 255.0,
				int(value[5:7], 16) / 255.0,
			)
		except ValueError:
			return (0.0, 0.0, 0.0)
	return (0.0, 0.0, 0.0)


def _normalize_element(element: Any) -> dict | None:
	if not isinstance(element, dict):
		return None
	kind = (element.get("kind") or "").strip()
	if kind not in ELEMENT_KINDS:
		return None
	normalized = {
		"id": (element.get("id") or "").strip() or _fallback_id(element),
		"kind": kind,
		"x": _as_float(element.get("x"), 0),
		"y": _as_float(element.get("y"), 0),
		"width": _as_float(element.get("width"), 0),
		"height": _as_float(element.get("height"), 0),
		"font_size": _as_float(element.get("font_size"), 10),
		"color": (element.get("color") or "#000000").strip() or "#000000",
		"stroke": (element.get("stroke") or "#000000").strip() or "#000000",
		"fill": (element.get("fill") or "").strip(),
		"line_width": _as_float(element.get("line_width"), 1),
		"line_style": (element.get("line_style") or "solid").strip() or "solid",
		"text": element.get("text") or "",
		"align": (element.get("align") or "left").strip() or "left",
		"image_url": (element.get("image_url") or "").strip(),
	}
	if kind == FIELD_KIND:
		normalized.update(
			{
				"field_name": (element.get("field_name") or "").strip(),
				"field_type": _normalize_field_type(element.get("field_type")),
				"source_type": element.get("source_type") or "Field Path",
				"source_field": element.get("source_field") or "",
				"jinja_script": element.get("jinja_script") or "",
				"default_value": element.get("default_value") or "",
				"date_format": element.get("date_format") or "",
				"editable": int(element.get("editable") or 0),
				"options": element.get("options") or "",
				"repeat_table": (element.get("repeat_table") or "").strip(),
				"repeat_field": (element.get("repeat_field") or "").strip(),
				"repeat_slot": int(element.get("repeat_slot") or 0),
			}
		)
	return normalized


def _validate_element(element: dict, page_index: int, seen_names: set[str], layout: dict) -> None:
	kind = element.get("kind")
	if kind not in ELEMENT_KINDS:
		frappe.throw(_("Unsupported element kind on page {0}").format(page_index + 1))

	width = float(element.get("width") or 0)
	height = float(element.get("height") or 0)
	if kind == "line":
		if abs(width) < 0.5 and abs(height) < 0.5:
			frappe.throw(_("Line on page {0} is too small").format(page_index + 1))
	elif width < 4 or height < 4:
		frappe.throw(_("Element on page {0} is too small").format(page_index + 1))

	if kind != FIELD_KIND:
		return

	field_name = (element.get("field_name") or "").strip()
	if not field_name:
		frappe.throw(_("Field name is required on page {0}").format(page_index + 1))
	if field_name in seen_names:
		frappe.throw(_("Duplicate field name: {0}").format(field_name))
	if not re.match(r"^[A-Za-z][A-Za-z0-9_]*$", field_name):
		frappe.throw(
			_(
				"Field name {0} must start with a letter and contain only letters, numbers, and underscores"
			).format(field_name)
		)
	seen_names.add(field_name)

	field_type = _normalize_field_type(element.get("field_type"))
	if field_type not in FRAPPE_FIELD_TYPES:
		frappe.throw(_("Unsupported field type: {0}").format(field_type))

	source_type = element.get("source_type") or "Field Path"
	if source_type not in SOURCE_TYPES:
		frappe.throw(_("Unsupported source type for field {0}").format(field_name))

	date_format = element.get("date_format") or ""
	if date_format and date_format not in DATE_FORMATS:
		frappe.throw(_("Unsupported date format for field {0}").format(field_name))


def _fallback_id(element: dict) -> str:
	kind = element.get("kind") or "el"
	name = (element.get("field_name") or element.get("text") or kind).strip()
	safe = re.sub(r"[^A-Za-z0-9_]+", "_", name)[:24] or kind
	return f"{safe}_{id(element) % 100000}"


def _as_float(value: Any, default: float) -> float:
	try:
		if value is None or value == "":
			return float(default)
		return float(value)
	except (TypeError, ValueError):
		return float(default)
