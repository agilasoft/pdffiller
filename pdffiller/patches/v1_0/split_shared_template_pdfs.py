# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import frappe

from pdffiller.utils.pdf_designer import create_exclusive_template_pdf
from pdffiller.utils.pdf_filler import get_pdf_path


def execute():
	shared_urls = frappe.db.sql(
		"""
		SELECT pdf_file
		FROM `tabPDF Form Template`
		WHERE IFNULL(pdf_file, '') != ''
		GROUP BY pdf_file
		HAVING COUNT(*) > 1
		""",
		pluck=True,
	)
	if not shared_urls:
		return

	for file_url in shared_urls:
		templates = frappe.get_all(
			"PDF Form Template",
			filters={"pdf_file": file_url},
			fields=["name", "creation"],
			order_by="creation asc",
		)
		pdf_path = get_pdf_path(file_url)
		with open(pdf_path, "rb") as handle:
			pdf_bytes = handle.read()

		# Oldest template keeps the original file; later ones get their own copy.
		for row in templates[1:]:
			doc = frappe.get_doc("PDF Form Template", row.name)
			create_exclusive_template_pdf(doc, pdf_bytes)
			doc.save(ignore_permissions=True)
