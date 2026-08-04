# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from typing import Any

import frappe
from frappe import _
from frappe.desk.utils import provide_binary_file
from frappe.utils import now_datetime

from pdffiller.utils.pdf_filler import get_pdf_path

FORMAT_VERSION = 1

TEMPLATE_FIELDS = (
	"title",
	"reference_doctype",
	"group",
	"disabled",
	"show_on_draft",
	"display_depends_on",
	"fields_only",
)

MAPPING_FIELDS = (
	"pdf_field_name",
	"field_type",
	"source_type",
	"source_field",
	"jinja_script",
	"default_value",
	"date_format",
	"editable",
)


def _ensure_permission(action: str = "write") -> None:
	if not frappe.has_permission("PDF Form Template", action):
		frappe.throw(_("Not permitted"), frappe.PermissionError)


def _parse_template_names(templates) -> list[str] | None:
	"""Return explicit names, or None to mean export all."""
	if templates is None or templates == "":
		return None
	if isinstance(templates, str):
		try:
			templates = json.loads(templates)
		except json.JSONDecodeError:
			return [templates]
	if isinstance(templates, (list, tuple)):
		names = [str(name).strip() for name in templates if str(name).strip()]
		return names or None
	frappe.throw(_("Invalid templates argument"))


def _safe_pdf_filename(title: str, used: set[str]) -> str:
	base = re.sub(r"[^\w\-]+", "_", (title or "template").strip(), flags=re.UNICODE)
	base = base.strip("_")[:80] or "template"
	name = f"{base}.pdf"
	if name not in used:
		used.add(name)
		return name
	index = 2
	while True:
		candidate = f"{base}_{index}.pdf"
		if candidate not in used:
			used.add(candidate)
			return candidate
		index += 1


def _serialize_mapping(row) -> dict[str, Any]:
	data = row.as_dict() if hasattr(row, "as_dict") else dict(row)
	return {field: data.get(field) for field in MAPPING_FIELDS}


def _serialize_template(doc) -> dict[str, Any]:
	payload = {field: doc.get(field) for field in TEMPLATE_FIELDS}
	payload["field_mappings"] = [_serialize_mapping(row) for row in doc.field_mappings or []]
	return payload


def _read_pdf_bytes(file_url: str) -> bytes:
	pdf_path = get_pdf_path(file_url)
	with open(pdf_path, "rb") as handle:
		return handle.read()


def build_export_zip(template_names: list[str] | None = None) -> tuple[bytes, str]:
	"""Build a portable ZIP pack. Returns (zip_bytes, download_filename_without_ext)."""
	filters = {}
	if template_names is not None:
		filters["name"] = ("in", template_names)

	names = frappe.get_all(
		"PDF Form Template",
		filters=filters,
		pluck="name",
		order_by="title asc",
	)
	if template_names is not None:
		missing = sorted(set(template_names) - set(names))
		if missing:
			frappe.throw(_("Template(s) not found: {0}").format(", ".join(missing)))

	if not names:
		frappe.throw(_("No PDF Form Templates to export"))

	manifest = {
		"format_version": FORMAT_VERSION,
		"exported_at": str(now_datetime()),
		"templates": [],
	}
	used_pdf_names: set[str] = set()
	buffer = io.BytesIO()

	with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
		for name in names:
			doc = frappe.get_doc("PDF Form Template", name)
			if not doc.pdf_file:
				frappe.throw(_("Template {0} has no PDF attached").format(name))

			pdf_filename = _safe_pdf_filename(doc.title, used_pdf_names)
			payload = _serialize_template(doc)
			payload["pdf_filename"] = pdf_filename
			manifest["templates"].append(payload)

			archive.writestr(f"pdfs/{pdf_filename}", _read_pdf_bytes(doc.pdf_file))

		archive.writestr(
			"manifest.json",
			json.dumps(manifest, indent=2, ensure_ascii=False),
		)

	if len(names) == 1:
		download_name = _safe_pdf_filename(names[0], set()).removesuffix(".pdf")
	else:
		download_name = f"pdffiller-templates-{now_datetime().strftime('%Y%m%d')}"

	return buffer.getvalue(), download_name


@frappe.whitelist()
def export_templates(templates=None):
	"""Download a ZIP pack of one or more PDF Form Templates."""
	_ensure_permission("read")
	names = _parse_template_names(templates)
	content, filename = build_export_zip(names)
	provide_binary_file(filename, "zip", content)


def _create_pdf_file(title: str, pdf_bytes: bytes) -> str:
	safe_name = re.sub(r"[^\w\-]+", "_", (title or "template").strip(), flags=re.UNICODE)
	safe_name = (safe_name.strip("_")[:60] or "template") + ".pdf"
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": safe_name,
			"content": pdf_bytes,
			"is_private": 1,
		}
	)
	file_doc.save(ignore_permissions=True)
	return file_doc.file_url


def _mapping_field_warnings(reference_doctype: str, mappings: list[dict]) -> list[str]:
	if not frappe.db.exists("DocType", reference_doctype):
		return []
	meta = frappe.get_meta(reference_doctype)
	warnings: list[str] = []
	for row in mappings:
		if (row.get("source_type") or "Field Path") != "Field Path":
			continue
		source = (row.get("source_field") or "").strip()
		if not source:
			continue
		# Skip Jinja-looking values left under Field Path.
		if "{{" in source or "{%" in source:
			continue
		root = source.split(".", 1)[0].strip()
		if root and not meta.has_field(root):
			warnings.append(
				_("Field path '{0}' not found on {1}").format(source, reference_doctype)
			)
	return warnings


def _apply_template_payload(doc, payload: dict, pdf_url: str) -> None:
	for field in TEMPLATE_FIELDS:
		if field == "title":
			continue
		doc.set(field, payload.get(field))
	doc.pdf_file = pdf_url
	doc.field_mappings = []
	for row in payload.get("field_mappings") or []:
		doc.append(
			"field_mappings",
			{field: row.get(field) for field in MAPPING_FIELDS},
		)


def _import_one_template(payload: dict, pdf_bytes: bytes) -> dict[str, Any]:
	title = (payload.get("title") or "").strip()
	if not title:
		return {"status": "error", "title": title or None, "message": _("Missing title")}

	reference_doctype = (payload.get("reference_doctype") or "").strip()
	if not reference_doctype:
		return {
			"status": "error",
			"title": title,
			"message": _("Missing reference_doctype"),
		}
	if not frappe.db.exists("DocType", reference_doctype):
		return {
			"status": "error",
			"title": title,
			"message": _("Reference DocType '{0}' does not exist").format(reference_doctype),
		}

	pdf_url = _create_pdf_file(title, pdf_bytes)
	warnings = _mapping_field_warnings(reference_doctype, payload.get("field_mappings") or [])
	exists = frappe.db.exists("PDF Form Template", title)

	if exists:
		doc = frappe.get_doc("PDF Form Template", title)
		_apply_template_payload(doc, payload, pdf_url)
		doc.save(ignore_permissions=True)
		status = "updated"
	else:
		doc = frappe.get_doc(
			{
				"doctype": "PDF Form Template",
				"title": title,
				"pdf_file": pdf_url,
			}
		)
		_apply_template_payload(doc, payload, pdf_url)
		doc.insert(ignore_permissions=True)
		status = "created"

	return {
		"status": status,
		"title": title,
		"name": doc.name,
		"warnings": warnings,
	}


def _load_zip_bytes(file_url: str | None = None, file_content=None) -> bytes:
	if file_content:
		if isinstance(file_content, str):
			# data URI or raw base64
			if "," in file_content and file_content.strip().startswith("data:"):
				file_content = file_content.split(",", 1)[1]
			import base64

			return base64.b64decode(file_content)
		if isinstance(file_content, (bytes, bytearray)):
			return bytes(file_content)

	if file_url:
		path = frappe.utils.file_manager.get_file_path(file_url)
		if not path or not os.path.exists(path):
			frappe.throw(_("Uploaded ZIP file not found on disk"))
		with open(path, "rb") as handle:
			return handle.read()

	uploaded = getattr(frappe.local, "uploaded_file", None)
	if uploaded:
		return uploaded if isinstance(uploaded, (bytes, bytearray)) else bytes(uploaded)

	frappe.throw(_("ZIP file is required"))


def import_templates_from_zip(zip_bytes: bytes) -> dict[str, Any]:
	try:
		archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
	except zipfile.BadZipFile:
		frappe.throw(_("Invalid ZIP file"))

	with archive:
		try:
			manifest_raw = archive.read("manifest.json")
		except KeyError:
			frappe.throw(_("ZIP is missing manifest.json"))

		try:
			manifest = json.loads(manifest_raw)
		except json.JSONDecodeError:
			frappe.throw(_("Invalid manifest.json"))

		if not isinstance(manifest, dict) or not isinstance(manifest.get("templates"), list):
			frappe.throw(_("Invalid manifest structure"))

		version = manifest.get("format_version")
		if version is not None and int(version) > FORMAT_VERSION:
			frappe.throw(
				_("Unsupported pack format version {0}. This site supports up to {1}.").format(
					version, FORMAT_VERSION
				)
			)

		results: list[dict[str, Any]] = []
		for payload in manifest["templates"]:
			if not isinstance(payload, dict):
				results.append(
					{"status": "error", "title": None, "message": _("Invalid template entry")}
				)
				continue

			pdf_filename = payload.get("pdf_filename")
			if not pdf_filename:
				results.append(
					{
						"status": "error",
						"title": payload.get("title"),
						"message": _("Missing pdf_filename"),
					}
				)
				continue

			# Prevent zip-slip: only allow basename under pdfs/
			pdf_filename = os.path.basename(str(pdf_filename))
			member = f"pdfs/{pdf_filename}"
			try:
				pdf_bytes = archive.read(member)
			except KeyError:
				results.append(
					{
						"status": "error",
						"title": payload.get("title"),
						"message": _("PDF file '{0}' missing from pack").format(pdf_filename),
					}
				)
				continue

			try:
				results.append(_import_one_template(payload, pdf_bytes))
			except Exception as exc:
				frappe.log_error(title="PDF Form Template import failed")
				results.append(
					{
						"status": "error",
						"title": payload.get("title"),
						"message": str(exc),
					}
				)

	summary = {
		"created": sum(1 for row in results if row.get("status") == "created"),
		"updated": sum(1 for row in results if row.get("status") == "updated"),
		"errors": sum(1 for row in results if row.get("status") == "error"),
		"results": results,
	}
	return summary


@frappe.whitelist()
def import_templates(file_url=None, file_content=None):
	"""Import PDF Form Templates from an exported ZIP pack."""
	_ensure_permission("write")
	zip_bytes = _load_zip_bytes(file_url=file_url, file_content=file_content)
	return import_templates_from_zip(zip_bytes)
