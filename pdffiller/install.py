# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe

from pdffiller.utils.desk_setup import sync_desk_setup


def after_install():
	sync_desk_setup()
	if frappe.db.exists("PDF Filler AI Settings", "PDF Filler AI Settings"):
		settings = frappe.get_single("PDF Filler AI Settings")
		if not settings.allowed_roles:
			settings.append("allowed_roles", {"role": "System Manager"})
			settings.save(ignore_permissions=True)
		return

	doc = frappe.get_doc(
		{
			"doctype": "PDF Filler AI Settings",
			"enabled": 0,
			"provider": "OpenAI",
			"model": "gpt-4o-mini",
			"messages_per_hour": 30,
			"ollama_base_url": "http://localhost:11434",
		}
	)
	doc.append("allowed_roles", {"role": "System Manager"})
	doc.insert(ignore_permissions=True)
