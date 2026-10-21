# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from pdffiller.utils.pdf_designer import create_exclusive_template_pdf, is_template_pdf_shared
from pdffiller.utils.pdf_filler import get_pdf_path, list_acroform_fields, template_has_widgets


class PDFFormTemplate(Document):
	def validate(self):
		if not self.reference_doctype:
			frappe.throw(_("Reference DocType is required"))

		meta = frappe.get_meta(self.reference_doctype)
		if meta.issingle:
			frappe.throw(_("Reference DocType cannot be a Single DocType"))
		if meta.istable:
			frappe.throw(_("Reference DocType cannot be a child table"))

		if self.pdf_file:
			self._ensure_exclusive_pdf_file()
			pdf_path = get_pdf_path(self.pdf_file)
			if not template_has_widgets(pdf_path):
				frappe.msgprint(
					_(
						"The attached PDF has no fillable fields yet. "
						"Use Design Fields to add them, or attach a fillable PDF template."
					),
					indicator="orange",
					title=_("No Fillable Fields"),
				)

	def _ensure_exclusive_pdf_file(self) -> None:
		exclude = None if self.is_new() else self.name
		if not is_template_pdf_shared(self.pdf_file, exclude):
			return
		pdf_path = get_pdf_path(self.pdf_file)
		with open(pdf_path, "rb") as handle:
			create_exclusive_template_pdf(self, handle.read())

	def get_mapped_field_names(self) -> set[str]:
		return {row.pdf_field_name for row in self.field_mappings if row.pdf_field_name}

	def get_unmapped_pdf_fields(self) -> list[str]:
		if not self.pdf_file:
			return []
		pdf_path = get_pdf_path(self.pdf_file)
		mapped = self.get_mapped_field_names()
		return sorted(field for field in list_acroform_fields(pdf_path) if field not in mapped)
