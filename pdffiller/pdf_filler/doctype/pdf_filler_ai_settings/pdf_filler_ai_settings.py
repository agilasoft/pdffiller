# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PDFFillerAISettings(Document):
	def validate(self):
		if self.enabled and not (self.allowed_roles or []):
			frappe.throw(_("Add at least one allowed role when PDF Filler AI is enabled."))
		if self.enabled and self.provider in ("OpenAI", "Anthropic", "Azure OpenAI"):
			if not self.get_password("api_key", raise_exception=False):
				frappe.throw(_("API Key is required when AI assistance is enabled."))
