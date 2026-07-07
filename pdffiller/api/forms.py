# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import base64
import re

import frappe
from frappe import _

from pdffiller.utils.pdf_filler import fill_template_pdf, get_pdf_path, list_acroform_fields


def _get_template(template: str):
	if not template:
		frappe.throw(_("PDF Form Template is required"))
	return frappe.get_doc("PDF Form Template", template)


def _validate_source_access(doctype: str, name: str):
	if not doctype or not name:
		frappe.throw(_("DocType and document name are required"))
	if not frappe.has_permission(doctype, "read", name):
		frappe.throw(_("Not permitted to read {0} {1}").format(doctype, name), frappe.PermissionError)


@frappe.whitelist()
def get_templates(reference_doctype: str) -> list[dict]:
	if not reference_doctype:
		return []

	return frappe.get_all(
		"PDF Form Template",
		filters={"reference_doctype": reference_doctype, "disabled": 0},
		fields=["name", "title", "show_on_draft"],
		order_by="title asc",
	)


@frappe.whitelist()
def get_filled_pdf(template: str, doctype: str, name: str) -> dict:
	template_doc = _get_template(template)
	_validate_source_access(doctype, name)

	if template_doc.reference_doctype != doctype:
		frappe.throw(_("This PDF form is not configured for {0}").format(doctype))

	if template_doc.disabled:
		frappe.throw(_("This PDF form template is disabled"))

	source_doc = frappe.get_doc(doctype, name)
	pdf_bytes = fill_template_pdf(template_doc, source_doc)
	encoded = base64.b64encode(pdf_bytes).decode("ascii")
	filename = _safe_filename(template_doc.title, name)

	return {
		"data_uri": f"data:application/pdf;base64,{encoded}",
		"filename": filename,
	}


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
