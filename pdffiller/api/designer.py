# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.model import no_value_fields

from pdffiller.utils.pdf_designer import (
	DATE_FORMATS,
	SOURCE_TYPES,
	apply_field_layout,
	get_page_previews,
	list_field_layout,
	merge_fields_with_mappings,
	save_template_pdf,
	sync_field_mappings,
)
from pdffiller.utils.page_planner import dump_page_roles, parse_page_roles
from pdffiller.utils.pdf_filler import get_pdf_path


def _get_template(template: str):
	if not template:
		frappe.throw(_("PDF Form Template is required"))
	return frappe.get_doc("PDF Form Template", template)


def _require_template_write(template_doc):
	if not frappe.has_permission("PDF Form Template", "write", template_doc.name):
		frappe.throw(_("Not permitted to edit this PDF form template"), frappe.PermissionError)


def _parse_fields(fields) -> list[dict]:
	if not fields:
		return []
	if isinstance(fields, list):
		return fields
	if isinstance(fields, str):
		try:
			parsed = json.loads(fields)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid field layout payload"))
		if not isinstance(parsed, list):
			frappe.throw(_("Field layout must be a JSON array"))
		return parsed
	frappe.throw(_("Field layout must be a JSON array"))


def _get_reference_fields(reference_doctype: str) -> list[dict]:
	if not reference_doctype:
		return []

	meta = frappe.get_meta(reference_doctype)
	fields = []
	for df in meta.fields:
		if df.fieldtype in no_value_fields:
			continue
		if df.fieldtype in ("Table", "HTML", "Button", "Fold", "Tab Break"):
			continue
		fields.append(
			{
				"fieldname": df.fieldname,
				"label": df.label or df.fieldname,
				"fieldtype": df.fieldtype,
			}
		)
	return fields


def _get_child_tables(reference_doctype: str) -> list[dict]:
	if not reference_doctype:
		return []

	meta = frappe.get_meta(reference_doctype)
	tables = []
	for df in meta.fields:
		if df.fieldtype != "Table" or not df.options:
			continue
		child_meta = frappe.get_meta(df.options)
		child_fields = []
		for child_df in child_meta.fields:
			if child_df.fieldtype in no_value_fields:
				continue
			if child_df.fieldtype in ("Table", "HTML", "Button", "Fold", "Tab Break"):
				continue
			child_fields.append(
				{
					"fieldname": child_df.fieldname,
					"label": child_df.label or child_df.fieldname,
					"fieldtype": child_df.fieldtype,
				}
			)
		tables.append(
			{
				"fieldname": df.fieldname,
				"label": df.label or df.fieldname,
				"options": df.options,
				"fields": child_fields,
			}
		)
	return tables


def _pdf_page_count(pdf_path: str) -> int:
	import fitz

	doc = fitz.open(pdf_path)
	try:
		return doc.page_count
	finally:
		doc.close()


def _parse_page_roles(page_roles, page_count: int) -> dict[str, str]:
	if isinstance(page_roles, str) and page_roles.strip():
		try:
			page_roles = json.loads(page_roles)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid page roles payload"))
	roles = parse_page_roles(page_roles, page_count)
	return dump_page_roles(roles)


@frappe.whitelist()
def get_design_context(template: str) -> dict:
	template_doc = _get_template(template)
	_require_template_write(template_doc)

	if not template_doc.pdf_file:
		frappe.throw(_("Attach a PDF file before designing fields"))

	pdf_path = get_pdf_path(template_doc.pdf_file)
	pdf_fields = list_field_layout(pdf_path)
	pages = get_page_previews(pdf_path)
	roles = parse_page_roles(getattr(template_doc, "page_roles", None), len(pages))
	return {
		"template": template_doc.name,
		"title": template_doc.title,
		"reference_doctype": template_doc.reference_doctype,
		"pages": pages,
		"fields": merge_fields_with_mappings(pdf_fields, template_doc),
		"reference_fields": _get_reference_fields(template_doc.reference_doctype),
		"child_tables": _get_child_tables(template_doc.reference_doctype),
		"page_roles": dump_page_roles(roles),
		"always_print_last": int(getattr(template_doc, "always_print_last", 0) or 0),
		"source_types": SOURCE_TYPES,
		"date_formats": DATE_FORMATS,
	}


@frappe.whitelist()
def get_doctype_fields(template: str) -> list[dict]:
	template_doc = _get_template(template)
	_require_template_write(template_doc)
	return _get_reference_fields(template_doc.reference_doctype)


@frappe.whitelist()
def save_design(
	template: str,
	fields: str | list | None = None,
	page_roles: str | dict | list | None = None,
	always_print_last: int | bool | None = None,
) -> dict:
	template_doc = _get_template(template)
	_require_template_write(template_doc)

	if not template_doc.pdf_file:
		frappe.throw(_("Attach a PDF file before saving the design"))

	field_layout = _parse_fields(fields)
	pdf_path = get_pdf_path(template_doc.pdf_file)
	page_count = _pdf_page_count(pdf_path)
	pdf_bytes = apply_field_layout(pdf_path, field_layout)
	save_template_pdf(template_doc, pdf_bytes)

	added, removed = sync_field_mappings(template_doc, field_layout)
	if page_roles is not None:
		template_doc.page_roles = _parse_page_roles(page_roles, page_count)
	if always_print_last is not None:
		template_doc.always_print_last = 1 if int(always_print_last or 0) else 0
	template_doc.save(ignore_permissions=True)

	if template_doc.reference_doctype:
		frappe.clear_cache(doctype=template_doc.reference_doctype)

	return {
		"field_names": [field["field_name"] for field in field_layout],
		"added": added,
		"removed": removed,
	}
