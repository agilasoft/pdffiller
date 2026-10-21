# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import cint


def get_settings():
	return frappe.get_single("PDF Filler AI Settings")


def has_ai_access(user=None):
	user = user or frappe.session.user
	if user == "Guest":
		return False
	try:
		settings = get_settings()
	except Exception:
		return False
	if not settings.enabled:
		return False
	allowed = {row.role for row in (settings.allowed_roles or []) if row.role}
	if not allowed:
		return False
	user_roles = set(frappe.get_roles(user))
	return bool(user_roles & allowed)


def ensure_ai_access():
	if not has_ai_access():
		frappe.throw(
			"You do not have access to PDF Filler AI. Check **PDF Filler AI Settings**.",
			frappe.PermissionError,
		)


def check_rate_limit(user=None):
	user = user or frappe.session.user
	settings = get_settings()
	limit = int(settings.messages_per_hour or 30)
	if limit <= 0:
		return

	key = f"pdffiller_ai_rate:{user}"
	count = cint(frappe.cache.get_value(key) or 0)
	if count >= limit:
		frappe.throw(f"Rate limit exceeded ({limit} requests per hour). Please try again later.")
	frappe.cache.set_value(key, count + 1, expires_in_sec=3600)


def record_ai_request(user=None):
	check_rate_limit(user=user)
