# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import base64
import json
import re

import frappe
from frappe import _
from frappe.utils import cstr

from pdffiller.utils.display_condition import should_display_template
from pdffiller.utils.pdf_filler import build_field_preview, fill_template_pdf, get_pdf_path, list_acroform_fields

SOURCE_FORM_TEMPLATE = "form_template"
SOURCE_PRINT_DESIGN = "print_design"
_TEMPLATE_LIST_FIELDS = ["name", "title", "show_on_draft", "group", "display_depends_on"]


def _normalize_source(source: str | None) -> str:
	value = (source or "").strip()
	if value == SOURCE_PRINT_DESIGN:
		return SOURCE_PRINT_DESIGN
	return SOURCE_FORM_TEMPLATE


def _get_template(template: str, source: str | None = None):
	if not template:
		frappe.throw(_("PDF form is required"))
	if _normalize_source(source) == SOURCE_PRINT_DESIGN:
		return frappe.get_doc("PDF Print Design", template)
	return frappe.get_doc("PDF Form Template", template)


def _validate_source_access(doctype: str, name: str):
	if not doctype or not name:
		frappe.throw(_("DocType and document name are required"))
	if not frappe.has_permission(doctype, "read", name):
		frappe.throw(_("Not permitted to read {0} {1}").format(doctype, name), frappe.PermissionError)


def _parse_overrides(overrides) -> dict[str, str]:
	if not overrides:
		return {}
	if isinstance(overrides, dict):
		return {str(key): cstr(value) for key, value in overrides.items()}
	if isinstance(overrides, str):
		try:
			parsed = json.loads(overrides)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid field overrides payload"))
		if not isinstance(parsed, dict):
			frappe.throw(_("Field overrides must be a JSON object"))
		return {str(key): cstr(value) for key, value in parsed.items()}
	frappe.throw(_("Field overrides must be a JSON object"))


def _filter_templates_for_doc(templates: list[dict], reference_doctype: str, name: str | None) -> list[dict]:
	if not templates:
		return []

	unconditional = [template for template in templates if not (template.get("display_depends_on") or "").strip()]
	if not name:
		return unconditional

	source_doc = frappe.get_doc(reference_doctype, name)
	return [template for template in templates if should_display_template(template, source_doc)]


def _doctype_available(doctype: str) -> bool:
	try:
		return bool(frappe.db.exists("DocType", doctype))
	except Exception:
		return True


def _list_source_docs(doctype: str, source: str, reference_doctype: str) -> list[dict]:
	if not _doctype_available(doctype):
		return []
	rows = frappe.get_all(
		doctype,
		filters={"reference_doctype": reference_doctype, "disabled": 0},
		fields=_TEMPLATE_LIST_FIELDS,
	)
	for row in rows:
		row["source"] = source
	return rows


@frappe.whitelist()
def get_templates(reference_doctype: str, name: str | None = None) -> list[dict]:
	if not reference_doctype:
		return []

	templates = _list_source_docs("PDF Form Template", SOURCE_FORM_TEMPLATE, reference_doctype)
	templates.extend(_list_source_docs("PDF Print Design", SOURCE_PRINT_DESIGN, reference_doctype))
	templates.sort(key=lambda row: ((row.get("group") or ""), (row.get("title") or row.get("name") or "")))
	return _filter_templates_for_doc(templates, reference_doctype, name)


def _validate_template_visible(template_doc, source_doc):
	if not should_display_template(template_doc, source_doc):
		frappe.throw(_("This PDF form is not available for this document"))


@frappe.whitelist()
def get_form_preview(template: str, doctype: str, name: str, source: str | None = None) -> dict:
	form_source = _normalize_source(source)
	template_doc = _get_template(template, form_source)
	_validate_source_access(doctype, name)

	if template_doc.reference_doctype != doctype:
		frappe.throw(_("This PDF form is not configured for {0}").format(doctype))

	if template_doc.disabled:
		frappe.throw(_("This PDF form template is disabled"))

	source_doc = frappe.get_doc(doctype, name)
	_validate_template_visible(template_doc, source_doc)

	is_print_design = form_source == SOURCE_PRINT_DESIGN
	return {
		"template": template_doc.name,
		"title": template_doc.title,
		"fields": build_field_preview(template_doc, source_doc),
		"fields_only": False if is_print_design else bool(getattr(template_doc, "fields_only", 0)),
		"source": form_source,
	}


@frappe.whitelist()
def get_filled_pdf(
	template: str,
	doctype: str,
	name: str,
	field_overrides: str | dict | None = None,
	fields_only: int | bool | None = None,
	source: str | None = None,
) -> dict:
	form_source = _normalize_source(source)
	template_doc = _get_template(template, form_source)
	_validate_source_access(doctype, name)

	if template_doc.reference_doctype != doctype:
		frappe.throw(_("This PDF form is not configured for {0}").format(doctype))

	if template_doc.disabled:
		frappe.throw(_("This PDF form template is disabled"))

	source_doc = frappe.get_doc(doctype, name)
	_validate_template_visible(template_doc, source_doc)

	overrides = _parse_overrides(field_overrides)
	_validate_editable_overrides(template_doc, overrides)

	if form_source == SOURCE_PRINT_DESIGN:
		from pdffiller.utils.print_design_fill import fill_print_design

		pdf_bytes = fill_print_design(template_doc, source_doc, overrides=overrides)
	else:
		use_fields_only = (
			bool(int(fields_only or 0))
			if fields_only is not None
			else bool(getattr(template_doc, "fields_only", 0))
		)
		pdf_bytes = fill_template_pdf(
			template_doc,
			source_doc,
			overrides=overrides,
			fields_only=use_fields_only,
		)
	encoded = base64.b64encode(pdf_bytes).decode("ascii")
	filename = _safe_filename(template_doc.title, name)

	return {
		"data_uri": f"data:application/pdf;base64,{encoded}",
		"filename": filename,
	}


def _validate_editable_overrides(template_doc, overrides: dict[str, str]):
	if not overrides:
		return

	editable_fields = {
		row.pdf_field_name
		for row in template_doc.field_mappings
		if row.pdf_field_name and row.editable
	}
	for field_name in overrides:
		if field_name not in editable_fields:
			frappe.throw(
				_("Field {0} is not editable in this PDF form template").format(field_name)
			)


@frappe.whitelist()
def list_pdf_fields(template: str) -> list[str]:
	template_doc = _get_template(template)
	if not template_doc.pdf_file:
		frappe.throw(_("Attach a PDF file first"))

	pdf_path = get_pdf_path(template_doc.pdf_file)
	return list_acroform_fields(pdf_path)


def _safe_filename(title: str, docname: str) -> str:
	base = f"{title}-{docname}"
	base = re.sub(r"[^\w\s\-_.]", "", base, flags=re.UNICODE)
	base = re.sub(r"\s+", "-", base.strip())
	return f"{base or 'form'}.pdf"
