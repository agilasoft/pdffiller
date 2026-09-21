# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json

import frappe
from frappe import _

from pdffiller.api.designer import _get_child_tables, _get_reference_fields
from pdffiller.utils.page_planner import dump_page_roles
from pdffiller.utils.pdf_designer import DATE_FORMATS, SOURCE_TYPES, sync_field_mappings
from pdffiller.utils.print_layout import (
	PAPER_SIZES,
	field_elements_as_layout,
	merge_layout_with_mappings,
	parse_layout,
	roles_from_layout,
	validate_layout,
)


def _get_design(design: str):
	if not design:
		frappe.throw(_("PDF Print Design is required"))
	return frappe.get_doc("PDF Print Design", design)


def _require_design_write(design_doc):
	if not frappe.has_permission("PDF Print Design", "write", design_doc.name):
		frappe.throw(_("Not permitted to edit this PDF print design"), frappe.PermissionError)


def _parse_layout_payload(layout, design_doc) -> dict:
	if layout is None or layout == "":
		return parse_layout(design_doc.layout_json, design_doc.page_width, design_doc.page_height)
	if isinstance(layout, dict):
		return parse_layout(layout, design_doc.page_width, design_doc.page_height)
	if isinstance(layout, str):
		try:
			parsed = json.loads(layout)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid layout payload"))
		if not isinstance(parsed, dict):
			frappe.throw(_("Layout must be a JSON object"))
		return parse_layout(parsed, design_doc.page_width, design_doc.page_height)
	frappe.throw(_("Layout must be a JSON object"))


@frappe.whitelist()
def get_design_context(design: str) -> dict:
	design_doc = _get_design(design)
	_require_design_write(design_doc)

	layout = parse_layout(design_doc.layout_json, design_doc.page_width, design_doc.page_height)
	layout = merge_layout_with_mappings(layout, design_doc)
	return {
		"design": design_doc.name,
		"title": design_doc.title,
		"reference_doctype": design_doc.reference_doctype,
		"paper_size": design_doc.paper_size or "A4",
		"page_width": float(layout["page_width"]),
		"page_height": float(layout["page_height"]),
		"layout": layout,
		"paper_sizes": {name: {"width": size[0], "height": size[1]} for name, size in PAPER_SIZES.items()},
		"reference_fields": _get_reference_fields(design_doc.reference_doctype),
		"child_tables": _get_child_tables(design_doc.reference_doctype),
		"always_print_last": int(getattr(design_doc, "always_print_last", 0) or 0),
		"source_types": SOURCE_TYPES,
		"date_formats": DATE_FORMATS,
	}


@frappe.whitelist()
def save_design(
	design: str,
	layout: str | dict | None = None,
	always_print_last: int | bool | None = None,
	paper_size: str | None = None,
) -> dict:
	design_doc = _get_design(design)
	_require_design_write(design_doc)

	parsed = validate_layout(_parse_layout_payload(layout, design_doc))
	field_layout = field_elements_as_layout(parsed)
	added, removed = sync_field_mappings(design_doc, field_layout)

	if paper_size:
		design_doc.paper_size = paper_size
	design_doc.page_width = parsed["page_width"]
	design_doc.page_height = parsed["page_height"]
	design_doc.layout_json = json.dumps(parsed)
	design_doc.page_roles = json.dumps(dump_page_roles(roles_from_layout(parsed)))
	if always_print_last is not None:
		design_doc.always_print_last = 1 if int(always_print_last or 0) else 0
	design_doc.save(ignore_permissions=True)

	if design_doc.reference_doctype:
		frappe.clear_cache(doctype=design_doc.reference_doctype)

	return {
		"field_names": [field["field_name"] for field in field_layout],
		"added": added,
		"removed": removed,
		"page_count": len(parsed["pages"]),
	}
