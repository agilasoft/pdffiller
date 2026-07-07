# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe


def should_display_template(template, source_doc) -> bool:
	condition = _get_display_depends_on(template)
	if not condition:
		return True
	return bool(evaluate_depends_on(source_doc, condition))


def evaluate_depends_on(doc, expression: str) -> bool:
	expression = (expression or "").strip()
	if not expression:
		return True

	if expression.startswith("eval:"):
		try:
			return bool(frappe.safe_eval(expression[5:], None, {"doc": doc}))
		except Exception:
			frappe.log_error(
				title="PDF Form Template Display Condition Error",
				message=frappe.get_traceback(),
			)
			return False

	if expression.startswith("!"):
		fieldname = expression[1:]
		return not bool(_get_doc_value(doc, fieldname))

	return bool(_get_doc_value(doc, expression))


def _get_display_depends_on(template) -> str:
	if isinstance(template, dict):
		return (template.get("display_depends_on") or "").strip()
	return (getattr(template, "display_depends_on", None) or "").strip()


def _get_doc_value(doc, fieldname: str):
	if hasattr(doc, "get"):
		return doc.get(fieldname)
	return getattr(doc, fieldname, None)
