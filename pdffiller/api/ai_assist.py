# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json
import re

import frappe
from frappe import _

from pdffiller.api.designer import _get_reference_fields, _get_template, _parse_fields, _require_template_write
from pdffiller.utils.pdf_designer import SOURCE_TYPES, merge_fields_with_mappings
from pdffiller.utils.pdf_designer import list_field_layout
from pdffiller.utils.pdf_filler import get_pdf_path


MAPPING_SYSTEM_PROMPT = """You are a PDF form field mapping assistant for Frappe PDF Filler.

Given PDF AcroForm fields and a reference DocType's fields, suggest how to map each PDF field to document data.

Return ONLY valid JSON with this shape:
{
  "suggestions": [
    {
      "pdf_field_name": "exact PDF field name from the input",
      "source_type": "Field Path",
      "source_field": "fieldname or jinja expression",
      "confidence": 0.85,
      "reason": "brief explanation"
    }
  ]
}

Rules:
- source_type must be one of: Field Path, Jinja Template, Jinja Script
- For Field Path, source_field must be an exact fieldname from the reference fields list (dot paths allowed for links, e.g. supplier.tax_id)
- For Jinja Template, use expressions like {{ doc.fieldname }}
- For Jinja Script, use multi-line Jinja when logic is needed
- Match by semantic similarity (e.g. cust_name -> customer_name, inv_date -> posting_date)
- Only include suggestions you are reasonably confident about
- Do not invent reference field names that are not in the provided list
- Return an empty suggestions array if nothing can be mapped reliably"""


ASSIST_SYSTEM_PROMPT = """You are an expert assistant for the Frappe PDF Filler field designer.

You help users:
- Map PDF AcroForm fields to reference DocType fields
- Choose between Field Path, Jinja Template, and Jinja Script source types
- Name PDF fields clearly and consistently
- Understand field types: Data, Link, Date, Int, Float, Currency, Check, Select, Small Text, Long Text
- Place and size fields on PDF pages (coordinates are in PDF points)

Answer concisely and practically. When suggesting mappings, only use field names from the context provided.
If you suggest specific mappings, format them as a JSON code block with key "suggestions" using the same structure as the mapping API."""


def _call_llm(system_prompt: str, user_prompt: str, history: list[dict] | None = None) -> tuple[str, dict | None]:
	from pdffiller.utils.ai_errors import format_llm_error
	from pdffiller.utils.ai_permissions import ensure_ai_access, record_ai_request
	from pdffiller.utils.ai_providers import get_provider

	ensure_ai_access()
	record_ai_request()

	messages = [{"role": "system", "content": system_prompt}]
	for row in history or []:
		role = row.get("role")
		content = (row.get("content") or "").strip()
		if role in ("user", "assistant") and content:
			messages.append({"role": role, "content": content})
	messages.append({"role": "user", "content": user_prompt})

	try:
		provider = get_provider()
		response = provider.chat(messages)
		return (response.content or "").strip(), response.token_usage
	except Exception as exc:
		return format_llm_error(exc), None


def _parse_json_from_content(content: str) -> dict:
	raw = (content or "").strip()
	if raw.startswith("```"):
		raw = re.sub(r"^```(?:json)?\s*", "", raw)
		raw = re.sub(r"\s*```$", "", raw)
	try:
		parsed = json.loads(raw)
	except json.JSONDecodeError as exc:
		frappe.throw(_("Could not parse AI response: {0}").format(exc))
	if not isinstance(parsed, dict):
		frappe.throw(_("AI response must be a JSON object"))
	return parsed


def _build_designer_context(template_doc, fields: list[dict] | None = None) -> str:
	reference_fields = _get_reference_fields(template_doc.reference_doctype)
	if fields is None and template_doc.pdf_file:
		pdf_path = get_pdf_path(template_doc.pdf_file)
		pdf_fields = list_field_layout(pdf_path)
		fields = merge_fields_with_mappings(pdf_fields, template_doc)

	field_rows = []
	for field in fields or []:
		field_rows.append(
			{
				"field_name": field.get("field_name"),
				"field_type": field.get("field_type"),
				"page": field.get("page"),
				"source_type": field.get("source_type"),
				"source_field": field.get("source_field"),
				"jinja_script": field.get("jinja_script"),
				"mapped": bool((field.get("source_field") or "").strip() or (field.get("jinja_script") or "").strip()),
			}
		)

	payload = {
		"template": template_doc.name,
		"title": template_doc.title,
		"reference_doctype": template_doc.reference_doctype,
		"source_types": list(SOURCE_TYPES),
		"pdf_fields": field_rows,
		"reference_fields": reference_fields,
	}
	return json.dumps(payload, indent=2, default=str)


def _normalize_suggestions(raw_suggestions: list, reference_fieldnames: set[str]) -> list[dict]:
	valid_source_types = set(SOURCE_TYPES)
	out = []
	for row in raw_suggestions or []:
		if not isinstance(row, dict):
			continue
		pdf_field_name = (row.get("pdf_field_name") or row.get("field_name") or "").strip()
		if not pdf_field_name:
			continue
		source_type = (row.get("source_type") or "Field Path").strip()
		if source_type not in valid_source_types:
			source_type = "Field Path"
		source_field = (row.get("source_field") or "").strip()
		jinja_script = (row.get("jinja_script") or "").strip()
		if source_type == "Jinja Script":
			source_field = ""
		elif source_type == "Field Path" and source_field:
			base_field = source_field.split(".")[0]
			if base_field not in reference_fieldnames:
				continue
		confidence = row.get("confidence")
		try:
			confidence = float(confidence)
		except (TypeError, ValueError):
			confidence = None
		out.append(
			{
				"pdf_field_name": pdf_field_name,
				"source_type": source_type,
				"source_field": source_field,
				"jinja_script": jinja_script,
				"confidence": confidence,
				"reason": (row.get("reason") or "").strip(),
			}
		)
	return out


def _fields_for_template(template_doc, fields=None) -> list[dict]:
	parsed = _parse_fields(fields) if fields is not None else None
	if parsed is not None:
		return parsed
	if not template_doc.pdf_file:
		return []
	pdf_path = get_pdf_path(template_doc.pdf_file)
	return merge_fields_with_mappings(list_field_layout(pdf_path), template_doc)


@frappe.whitelist()
def get_ai_status() -> dict:
	from pdffiller.utils.ai_permissions import has_ai_access

	return {"enabled": bool(has_ai_access())}


@frappe.whitelist()
def suggest_mappings(template: str, fields=None, mode: str = "unmapped") -> dict:
	template_doc = _get_template(template)
	_require_template_write(template_doc)

	if not template_doc.reference_doctype:
		frappe.throw(_("Set a Reference DocType before using AI mapping suggestions"))

	field_rows = _fields_for_template(template_doc, fields)
	reference_fields = _get_reference_fields(template_doc.reference_doctype)
	reference_fieldnames = {row["fieldname"] for row in reference_fields}

	if mode == "unmapped":
		target_fields = [
			field
			for field in field_rows
			if not (field.get("source_field") or "").strip() and not (field.get("jinja_script") or "").strip()
		]
	else:
		target_fields = field_rows

	if not target_fields:
		return {"suggestions": [], "message": _("All fields are already mapped.")}

	context_json = _build_designer_context(template_doc, field_rows)
	user_prompt = (
		f"Suggest mappings for these PDF fields (mode: {mode}):\n"
		f"{json.dumps(target_fields, indent=2, default=str)}\n\n"
		f"Designer context:\n{context_json}"
	)

	content, token_usage = _call_llm(MAPPING_SYSTEM_PROMPT, user_prompt)
	parsed = _parse_json_from_content(content)
	suggestions = _normalize_suggestions(parsed.get("suggestions") or [], reference_fieldnames)

	return {
		"suggestions": suggestions,
		"message": parsed.get("message") or "",
		"token_usage": token_usage,
	}


@frappe.whitelist()
def assist_chat(template: str, message: str, fields=None, history=None) -> dict:
	template_doc = _get_template(template)
	_require_template_write(template_doc)

	message = (message or "").strip()
	if not message:
		frappe.throw(_("Message is required"))

	field_rows = _fields_for_template(template_doc, fields)
	context_json = _build_designer_context(template_doc, field_rows)
	system_prompt = f"{ASSIST_SYSTEM_PROMPT}\n\nCurrent designer context:\n{context_json}"

	parsed_history = []
	if history:
		if isinstance(history, str):
			try:
				parsed_history = json.loads(history)
			except json.JSONDecodeError:
				parsed_history = []
		elif isinstance(history, list):
			parsed_history = history

	content, token_usage = _call_llm(system_prompt, message, history=parsed_history)

	suggestions = []
	json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", content)
	if json_match:
		try:
			parsed = json.loads(json_match.group(1))
			reference_fieldnames = {row["fieldname"] for row in _get_reference_fields(template_doc.reference_doctype)}
			suggestions = _normalize_suggestions(parsed.get("suggestions") or [], reference_fieldnames)
		except (json.JSONDecodeError, TypeError):
			suggestions = []

	return {
		"message": content,
		"suggestions": suggestions,
		"token_usage": token_usage,
	}
