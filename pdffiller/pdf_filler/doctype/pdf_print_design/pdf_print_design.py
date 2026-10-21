# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.model.document import Document

from pdffiller.utils.page_planner import dump_page_roles
from pdffiller.utils.print_layout import (
	apply_paper_size,
	default_layout,
	dump_layout,
	parse_layout,
	roles_from_layout,
)


class PDFPrintDesign(Document):
	def validate(self):
		if not self.reference_doctype:
			frappe.throw(_("Reference DocType is required"))

		meta = frappe.get_meta(self.reference_doctype)
		if meta.issingle:
			frappe.throw(_("Reference DocType cannot be a Single DocType"))
		if meta.istable:
			frappe.throw(_("Reference DocType cannot be a child table"))

		apply_paper_size(self)
		layout = parse_layout(self.layout_json, self.page_width, self.page_height)
		layout["page_width"] = float(self.page_width)
		layout["page_height"] = float(self.page_height)
		if not layout["pages"]:
			layout = default_layout(self.page_width, self.page_height)
		self.layout_json = dump_layout(layout)
		self.page_roles = json.dumps(dump_page_roles(roles_from_layout(layout)))

	def get_mapped_field_names(self) -> set[str]:
		return {row.pdf_field_name for row in self.field_mappings if row.pdf_field_name}
