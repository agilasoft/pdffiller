# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe
from frappe import _

from pdffiller.utils.fill_warnings import capture_warnings
from pdffiller.utils.form_access import assert_user_can_use_form
from pdffiller.utils.output_options import apply_output_options, merge_pdfs
from pdffiller.utils.pdf_filler import fill_template_pdf


def fill_packet(packet_doc, source_doc, overrides: dict[str, str] | None = None, fields_only: bool = False):
	"""Merge each packet item into one PDF. Returns (pdf_bytes, warnings)."""
	items = list(getattr(packet_doc, "items", None) or [])
	if not items:
		frappe.throw(_("This packet has no forms"))

	parts: list[bytes] = []
	warnings: list[dict] = []
	for row in items:
		part_bytes, part_warnings = _fill_packet_item(
			row,
			source_doc,
			overrides=overrides,
			fields_only=fields_only,
		)
		parts.append(part_bytes)
		warnings.extend(part_warnings)

	return merge_pdfs(parts), warnings


def preview_packet_fields(packet_doc, source_doc) -> tuple[list[dict], list[dict]]:
	from pdffiller.utils.pdf_filler import build_field_preview

	fields: list[dict] = []
	warnings: list[dict] = []
	for row in getattr(packet_doc, "items", None) or []:
		child = _load_packet_item(row)
		assert_user_can_use_form(child)
		with capture_warnings() as part_warnings:
			preview = build_field_preview(child, source_doc)
		title = getattr(child, "title", None) or child.name
		for field in preview:
			field["form"] = title
			fields.append(field)
		warnings.extend(_prefix_warnings(title, part_warnings))
	return fields, warnings


def _fill_packet_item(row, source_doc, overrides, fields_only: bool):
	child = _load_packet_item(row)
	if getattr(child, "disabled", 0):
		frappe.throw(_("{0} is disabled").format(child.title or child.name))
	assert_user_can_use_form(child)

	title = getattr(child, "title", None) or child.name
	if row.form_source == "PDF Print Design":
		from pdffiller.utils.print_design_fill import fill_print_design

		with capture_warnings() as part_warnings:
			pdf_bytes = fill_print_design(child, source_doc, overrides=overrides)
	else:
		with capture_warnings() as part_warnings:
			pdf_bytes = fill_template_pdf(
				child,
				source_doc,
				overrides=overrides,
				fields_only=fields_only,
			)
	pdf_bytes = apply_output_options(pdf_bytes, child, source_doc)
	return pdf_bytes, _prefix_warnings(title, part_warnings)


def _load_packet_item(row):
	form_source = getattr(row, "form_source", None) or ""
	form_name = getattr(row, "form_name", None) or ""
	if form_source not in ("PDF Form Template", "PDF Print Design") or not form_name:
		frappe.throw(_("Packet item is missing a form"))
	if not frappe.db.exists(form_source, form_name):
		frappe.throw(_("{0} {1} was not found").format(form_source, form_name))
	return frappe.get_doc(form_source, form_name)


def _prefix_warnings(title: str, warnings: list[dict]) -> list[dict]:
	prefixed = []
	for warning in warnings:
		field = warning.get("field") or ""
		prefixed.append(
			{
				"field": f"{title}: {field}" if field else title,
				"message": warning.get("message") or "",
			}
		)
	return prefixed
