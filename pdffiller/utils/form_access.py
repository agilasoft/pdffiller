# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe
from frappe import _


def allowed_role_names(doc) -> set[str]:
	roles: set[str] = set()
	for row in getattr(doc, "allowed_roles", None) or []:
		role = row.get("role") if isinstance(row, dict) else getattr(row, "role", None)
		if role:
			roles.add(role)
	return roles


def user_can_use_form(doc) -> bool:
	"""Empty allowed roles means every reader of the source document may use the form."""
	roles = allowed_role_names(doc)
	if not roles:
		return True
	try:
		user_roles = set(frappe.get_roles())
	except Exception:
		return False
	return bool(roles & user_roles)


def assert_user_can_use_form(doc) -> None:
	if not user_can_use_form(doc):
		frappe.throw(_("You are not permitted to use this PDF form"), frappe.PermissionError)
