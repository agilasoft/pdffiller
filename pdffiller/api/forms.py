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
from pdffiller.utils.fill_warnings import capture_warnings
from pdffiller.utils.form_access import assert_user_can_use_form
from pdffiller.utils.generation_log import log_generation
from pdffiller.utils.output_options import apply_output_options, merge_pdfs, zip_pdfs
from pdffiller.utils.pdf_filler import build_field_preview, fill_template_pdf, get_pdf_path, list_acroform_fields

SOURCE_FORM_TEMPLATE = "form_template"
SOURCE_PRINT_DESIGN = "print_design"
SOURCE_PACKET = "packet"
_TEMPLATE_LIST_FIELDS = ["name", "title", "show_on_draft", "group", "display_depends_on"]
_SOURCE_DOCTYPES = {
	SOURCE_FORM_TEMPLATE: "PDF Form Template",
	SOURCE_PRINT_DESIGN: "PDF Print Design",
	SOURCE_PACKET: "PDF Form Packet",
}
MAX_BULK_DOCUMENTS = 50


def _normalize_source(source: str | None) -> str:
	value = (source or "").strip()
	if value in (SOURCE_PRINT_DESIGN, SOURCE_PACKET):
		return value
	return SOURCE_FORM_TEMPLATE


def _get_template(template: str, source: str | None = None):
	if not template:
		frappe.throw(_("PDF form is required"))
	doctype = _SOURCE_DOCTYPES[_normalize_source(source)]
	return frappe.get_doc(doctype, template)


def _validate_source_access(doctype: str, name: str, action: str = "read"):
	if not doctype or not name:
		frappe.throw(_("DocType and document name are required"))
	if not frappe.has_permission(doctype, action, name):
		verb = "write" if action == "write" else "read"
		frappe.throw(_("Not permitted to {0} {1} {2}").format(verb, doctype, name), frappe.PermissionError)


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


def _parse_names(names) -> list[str]:
	if not names:
		return []
	if isinstance(names, str):
		try:
			parsed = json.loads(names)
		except json.JSONDecodeError:
			parsed = [part.strip() for part in names.split(",") if part.strip()]
		else:
			if isinstance(parsed, str):
				parsed = [parsed]
			if not isinstance(parsed, list):
				frappe.throw(_("Document names must be a list"))
		names = parsed
	if not isinstance(names, (list, tuple)):
		frappe.throw(_("Document names must be a list"))
	return [str(name).strip() for name in names if str(name).strip()]


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


def _safe_doctype_exists(doctype: str) -> bool:
	"""False when the site database is unavailable, unlike _doctype_available."""
	try:
		return bool(frappe.db.exists("DocType", doctype))
	except Exception:
		return False


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
	return _filter_rows_by_role(doctype, rows)


def _filter_rows_by_role(parenttype: str, rows: list[dict]) -> list[dict]:
	if not rows or not _safe_doctype_exists("PDF Form Allowed Role"):
		return rows
	names = [row.get("name") for row in rows if row.get("name")]
	if not names:
		return rows
	try:
		role_rows = frappe.get_all(
			"PDF Form Allowed Role",
			filters={"parenttype": parenttype, "parent": ["in", names]},
			fields=["parent", "role"],
		)
		user_roles = set(frappe.get_roles())
	except Exception:
		return rows

	by_parent: dict[str, set[str]] = {}
	for role_row in role_rows:
		parent = role_row.get("parent") if isinstance(role_row, dict) else getattr(role_row, "parent", None)
		role = role_row.get("role") if isinstance(role_row, dict) else getattr(role_row, "role", None)
		if parent and role:
			by_parent.setdefault(parent, set()).add(role)

	if not by_parent:
		return rows
	return [
		row
		for row in rows
		if not by_parent.get(row.get("name")) or by_parent[row.get("name")] & user_roles
	]


@frappe.whitelist()
def get_templates(reference_doctype: str, name: str | None = None) -> list[dict]:
	if not reference_doctype:
		return []

	templates = _list_source_docs("PDF Form Template", SOURCE_FORM_TEMPLATE, reference_doctype)
	templates.extend(_list_source_docs("PDF Print Design", SOURCE_PRINT_DESIGN, reference_doctype))
	if _safe_doctype_exists("PDF Form Packet"):
		templates.extend(_list_source_docs("PDF Form Packet", SOURCE_PACKET, reference_doctype))
	templates.sort(key=lambda row: ((row.get("group") or ""), (row.get("title") or row.get("name") or "")))
	return _filter_templates_for_doc(templates, reference_doctype, name)


def _validate_template_visible(template_doc, source_doc):
	if not should_display_template(template_doc, source_doc):
		frappe.throw(_("This PDF form is not available for this document"))
	assert_user_can_use_form(template_doc)


def _mapping_rows_from_payload(fields) -> list:
	from types import SimpleNamespace

	if isinstance(fields, str):
		try:
			fields = json.loads(fields)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid field payload"))
	if not isinstance(fields, list):
		frappe.throw(_("Fields must be a list"))

	rows = []
	for field in fields:
		if not isinstance(field, dict):
			continue
		name = (field.get("field_name") or field.get("pdf_field_name") or "").strip()
		if not name:
			continue
		rows.append(
			SimpleNamespace(
				pdf_field_name=name,
				field_type=field.get("field_type") or "",
				source_type=field.get("source_type") or "Field Path",
				source_field=field.get("source_field") or "",
				jinja_script=field.get("jinja_script") or "",
				default_value=field.get("default_value") or "",
				date_format=field.get("date_format") or "",
				editable=field.get("editable") or 0,
				repeat_table=field.get("repeat_table") or "",
				repeat_field=field.get("repeat_field") or "",
				repeat_slot=field.get("repeat_slot") or 0,
			)
		)
	return rows


@frappe.whitelist()
def get_sample_values(template: str, doctype: str, name: str, fields=None, source: str | None = None) -> dict:
	"""Resolve the designer's current mappings against one document for the canvas."""
	form_source = _normalize_source(source)
	if form_source == SOURCE_PACKET:
		frappe.throw(_("Sample values are available for templates and print designs"))
	template_doc = _get_template(template, form_source)
	design_doctype = _SOURCE_DOCTYPES[form_source]
	if not frappe.has_permission(design_doctype, "write", template_doc.name):
		frappe.throw(_("Not permitted to edit this PDF form"), frappe.PermissionError)
	_validate_source_access(doctype, name)
	if template_doc.reference_doctype != doctype:
		frappe.throw(_("This PDF form is not configured for {0}").format(doctype))
	assert_user_can_use_form(template_doc)

	source_doc = frappe.get_doc(doctype, name)
	mapping_doc = template_doc
	if fields:
		from types import SimpleNamespace

		mapping_doc = SimpleNamespace(field_mappings=_mapping_rows_from_payload(fields))

	with capture_warnings() as warnings:
		preview = build_field_preview(mapping_doc, source_doc)
	return {
		"document": source_doc.name,
		"values": {row["pdf_field_name"]: row["value"] for row in preview},
		"warnings": warnings,
	}


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

	warnings: list[dict] = []
	if form_source == SOURCE_PACKET:
		from pdffiller.utils.packet_fill import preview_packet_fields

		fields, warnings = preview_packet_fields(template_doc, source_doc)
		fields_only = False
	else:
		with capture_warnings() as warnings:
			fields = build_field_preview(template_doc, source_doc)
		fields_only = False if form_source == SOURCE_PRINT_DESIGN else bool(getattr(template_doc, "fields_only", 0))

	return {
		"template": template_doc.name,
		"title": template_doc.title,
		"fields": fields,
		"fields_only": fields_only,
		"source": form_source,
		"warnings": warnings,
		"flatten": bool(getattr(template_doc, "flatten", 0)) if form_source == SOURCE_FORM_TEMPLATE else False,
	}


def _render_pdf(template_doc, source_doc, form_source: str, overrides: dict[str, str], fields_only: bool):
	warnings: list[dict] = []
	if form_source == SOURCE_PACKET:
		from pdffiller.utils.packet_fill import fill_packet

		pdf_bytes, warnings = fill_packet(
			template_doc,
			source_doc,
			overrides=overrides,
			fields_only=fields_only,
		)
		return pdf_bytes, warnings

	if form_source == SOURCE_PRINT_DESIGN:
		from pdffiller.utils.print_design_fill import fill_print_design

		with capture_warnings() as warnings:
			pdf_bytes = fill_print_design(template_doc, source_doc, overrides=overrides)
	else:
		with capture_warnings() as warnings:
			pdf_bytes = fill_template_pdf(
				template_doc,
				source_doc,
				overrides=overrides,
				fields_only=fields_only,
			)
	pdf_bytes = apply_output_options(pdf_bytes, template_doc, source_doc)
	return pdf_bytes, warnings


def _prepare_filled_pdf(
	template: str,
	doctype: str,
	name: str,
	field_overrides: str | dict | None = None,
	fields_only: int | bool | None = None,
	source: str | None = None,
	action: str = "Preview",
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

	use_fields_only = (
		bool(int(fields_only or 0))
		if fields_only is not None
		else bool(getattr(template_doc, "fields_only", 0))
	)
	if form_source != SOURCE_FORM_TEMPLATE and fields_only is None:
		use_fields_only = False

	pdf_bytes, warnings = _render_pdf(
		template_doc,
		source_doc,
		form_source,
		overrides,
		use_fields_only,
	)
	log_generation(
		template_doc=template_doc,
		source_doc=source_doc,
		form_source=form_source,
		had_overrides=bool(overrides),
		action="Packet" if form_source == SOURCE_PACKET and action == "Preview" else action,
	)
	filename = _safe_filename(template_doc.title, name)
	return {
		"pdf_bytes": pdf_bytes,
		"warnings": warnings,
		"filename": filename,
		"title": template_doc.title,
		"doctype": doctype,
		"name": name,
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
	prepared = _prepare_filled_pdf(
		template,
		doctype,
		name,
		field_overrides=field_overrides,
		fields_only=fields_only,
		source=source,
		action="Preview",
	)
	encoded = base64.b64encode(prepared["pdf_bytes"]).decode("ascii")
	return {
		"data_uri": f"data:application/pdf;base64,{encoded}",
		"filename": prepared["filename"],
		"warnings": prepared["warnings"],
	}


def _save_private_pdf(doctype: str, name: str, filename: str, pdf_bytes: bytes):
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": filename,
			"attached_to_doctype": doctype,
			"attached_to_name": name,
			"is_private": 1,
			"content": pdf_bytes,
		}
	)
	file_doc.validate_file_extension = lambda: None
	file_doc.check_content = lambda: None
	file_doc.save(ignore_permissions=True)
	return file_doc


@frappe.whitelist()
def attach_filled_pdf(
	template: str,
	doctype: str,
	name: str,
	field_overrides: str | dict | None = None,
	fields_only: int | bool | None = None,
	source: str | None = None,
	purpose: str | None = None,
) -> dict:
	"""Save the filled PDF on the source document. purpose=email records an Email log."""
	_validate_source_access(doctype, name, action="write")
	action = "Email" if (purpose or "").strip().lower() == "email" else "Attach"
	prepared = _prepare_filled_pdf(
		template,
		doctype,
		name,
		field_overrides=field_overrides,
		fields_only=fields_only,
		source=source,
		action=action,
	)
	file_doc = _save_private_pdf(doctype, name, prepared["filename"], prepared["pdf_bytes"])
	return {
		"name": file_doc.name,
		"file_name": file_doc.file_name,
		"file_url": file_doc.file_url,
		"filename": prepared["filename"],
		"subject": f"{prepared['title']} - {name}",
		"warnings": prepared["warnings"],
	}


@frappe.whitelist()
def bulk_generate(
	reference_doctype: str,
	names,
	template: str,
	source: str | None = None,
	output: str = "merged",
) -> dict:
	docnames = _parse_names(names)
	if not docnames:
		frappe.throw(_("Select at least one document"))
	if len(docnames) > MAX_BULK_DOCUMENTS:
		frappe.throw(_("Select at most {0} documents at a time").format(MAX_BULK_DOCUMENTS))

	output_mode = (output or "merged").strip().lower()
	if output_mode not in ("merged", "zip"):
		frappe.throw(_("Output must be merged or zip"))

	files: list[tuple[str, bytes]] = []
	warnings: list[dict] = []
	for docname in docnames:
		prepared = _prepare_filled_pdf(
			template,
			reference_doctype,
			docname,
			source=source,
			action="Bulk",
		)
		files.append((prepared["filename"], prepared["pdf_bytes"]))
		for warning in prepared["warnings"]:
			warning = dict(warning)
			field = warning.get("field") or ""
			warning["field"] = f"{docname}: {field}" if field else docname
			warnings.append(warning)

	title = files[0][0].rsplit(".", 1)[0] if len(files) == 1 else template
	if output_mode == "zip":
		payload = zip_pdfs(files)
		filename = _safe_filename(title, "batch")
		if filename.endswith(".pdf"):
			filename = filename[:-4] + ".zip"
		mime = "application/zip"
	else:
		payload = merge_pdfs([content for _name, content in files]) if len(files) > 1 else files[0][1]
		filename = _safe_filename(title, "batch") if len(files) > 1 else files[0][0]
		mime = "application/pdf"

	encoded = base64.b64encode(payload).decode("ascii")
	return {
		"data_uri": f"data:{mime};base64,{encoded}",
		"filename": filename,
		"warnings": warnings,
		"count": len(files),
	}


def _validate_editable_overrides(template_doc, overrides: dict[str, str]):
	if not overrides:
		return

	editable_fields = {
		row.pdf_field_name
		for row in (getattr(template_doc, "field_mappings", None) or [])
		if row.pdf_field_name and row.editable
	}
	if getattr(template_doc, "doctype", None) == "PDF Form Packet":
		editable_fields = _packet_editable_fields(template_doc)

	for field_name in overrides:
		if field_name not in editable_fields:
			frappe.throw(_("Field {0} is not editable in this PDF form template").format(field_name))


def _packet_editable_fields(packet_doc) -> set[str]:
	names: set[str] = set()
	for row in getattr(packet_doc, "items", None) or []:
		try:
			child = frappe.get_doc(row.form_source, row.form_name)
		except Exception:
			continue
		for mapping in getattr(child, "field_mappings", None) or []:
			if mapping.pdf_field_name and mapping.editable:
				names.add(mapping.pdf_field_name)
	return names


@frappe.whitelist()
def list_pdf_fields(template: str) -> list[str]:
	if not frappe.has_permission("PDF Form Template", "read", template):
		frappe.throw(_("Not permitted to read this PDF form template"), frappe.PermissionError)

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
