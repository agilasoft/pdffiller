# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PDFFormPacket(Document):
	def validate(self):
		if not self.reference_doctype:
			frappe.throw(_("Reference DocType is required"))

		meta = frappe.get_meta(self.reference_doctype)
		if meta.issingle:
			frappe.throw(_("Reference DocType cannot be a Single DocType"))
		if meta.istable:
			frappe.throw(_("Reference DocType cannot be a child table"))

		if not self.items:
			frappe.throw(_("Add at least one form to the packet"))

		seen = set()
		for row in self.items:
			if row.form_source not in ("PDF Form Template", "PDF Print Design"):
				frappe.throw(_("Choose a PDF Form Template or PDF Print Design"))
			if not row.form_name:
				frappe.throw(_("Each packet row needs a form"))
			key = (row.form_source, row.form_name)
			if key in seen:
				frappe.throw(_("{0} is listed more than once").format(row.form_name))
			seen.add(key)
			if not frappe.db.exists(row.form_source, row.form_name):
				frappe.throw(_("{0} {1} was not found").format(row.form_source, row.form_name))
			reference = frappe.db.get_value(row.form_source, row.form_name, "reference_doctype")
			if reference != self.reference_doctype:
				frappe.throw(
					_("{0} is configured for {1}, not {2}").format(
						row.form_name, reference, self.reference_doctype
					)
				)
