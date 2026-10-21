# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe
from frappe.utils import now_datetime


def log_generation(
	*,
	template_doc,
	source_doc,
	form_source: str,
	had_overrides: bool,
	action: str,
) -> None:
	"""Record who generated a form. The PDF itself is not stored."""
	try:
		if not frappe.db.exists("DocType", "PDF Form Generation Log"):
			return
		user = None
		try:
			user = frappe.session.user
		except Exception:
			user = None
		doc = frappe.get_doc(
			{
				"doctype": "PDF Form Generation Log",
				"user": user,
				"action": action or "Preview",
				"form_source": form_source or "",
				"template": getattr(template_doc, "name", None) or "",
				"template_title": getattr(template_doc, "title", None) or "",
				"reference_doctype": getattr(source_doc, "doctype", None)
				or getattr(template_doc, "reference_doctype", None)
				or "",
				"reference_name": getattr(source_doc, "name", None) or "",
				"had_overrides": 1 if had_overrides else 0,
				"generated_on": now_datetime(),
			}
		)
		doc.insert(ignore_permissions=True)
	except Exception:
		return
