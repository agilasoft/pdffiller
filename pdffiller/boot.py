# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe

from pdffiller.utils.ai_permissions import has_ai_access


def _reference_doctypes() -> list[str]:
	names: set[str] = set()
	for doctype in ("PDF Form Template", "PDF Print Design", "PDF Form Packet"):
		try:
			if not frappe.db.exists("DocType", doctype):
				continue
			for reference in frappe.get_all(doctype, filters={"disabled": 0}, pluck="reference_doctype"):
				if reference:
					names.add(reference)
		except Exception:
			continue
	return sorted(names)


def extend_bootinfo(bootinfo):
	bootinfo["pdffiller_ai_enabled"] = has_ai_access()
	try:
		bootinfo["pdffiller_reference_doctypes"] = _reference_doctypes()
	except Exception:
		bootinfo["pdffiller_reference_doctypes"] = None
