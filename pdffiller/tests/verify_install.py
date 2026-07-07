# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import os

import frappe

from pdffiller.api.forms import get_filled_pdf, get_templates, list_pdf_fields
from pdffiller.utils.pdf_filler import template_has_widgets


def run():
	template_path = (
		"/home/frappe/frappe-bench/apps/logistics/logistics/public/images/bdo_cheque_source.pdf"
	)
	if not os.path.isfile(template_path) or not template_has_widgets(template_path):
		print("SKIP: fillable logistics template not available")
		return

	template_name = "E2E BDO Cheque Test"
	if frappe.db.exists("PDF Form Template", template_name):
		frappe.delete_doc("PDF Form Template", template_name, force=1)

	with open(template_path, "rb") as handle:
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "e2e_bdo_cheque.pdf",
				"content": handle.read(),
				"is_private": 1,
			}
		)
		file_doc.save(ignore_permissions=True)

	doc = frappe.get_doc(
		{
			"doctype": "PDF Form Template",
			"title": template_name,
			"reference_doctype": "Payment Entry",
			"pdf_file": file_doc.file_url,
			"show_on_draft": 1,
			"field_mappings": [
				{"pdf_field_name": "Textbox3", "source_field": "party_name", "default_value": "Test Payee"},
			],
		}
	)
	doc.insert(ignore_permissions=True)

	fields = list_pdf_fields(doc.name)
	templates = get_templates("Payment Entry")
	assert any(row["name"] == template_name for row in templates), templates

	pe = frappe.db.get_value("Payment Entry", {}, "name")
	if pe:
		result = get_filled_pdf(doc.name, "Payment Entry", pe)
		assert result["data_uri"].startswith("data:application/pdf;base64,")
		print(f"OK: filled PDF generated for Payment Entry {pe}")
	else:
		print("OK: template created; no Payment Entry available for fill test")

	frappe.delete_doc("PDF Form Template", template_name, force=1)
	file_doc.delete(ignore_permissions=True)
	frappe.db.commit()
	print("OK: e2e verification complete")
