# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import io
import json
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from pdffiller.api.transfer import (
	FORMAT_VERSION,
	_parse_template_names,
	_safe_pdf_filename,
	_serialize_template,
	import_templates_from_zip,
)


class TestTransferHelpers(unittest.TestCase):
	def test_parse_template_names_none_means_all(self):
		self.assertIsNone(_parse_template_names(None))
		self.assertIsNone(_parse_template_names(""))
		self.assertIsNone(_parse_template_names([]))

	def test_parse_template_names_list_and_json(self):
		self.assertEqual(_parse_template_names(["A", "B"]), ["A", "B"])
		self.assertEqual(_parse_template_names('["A"]'), ["A"])
		self.assertEqual(_parse_template_names("Single"), ["Single"])

	def test_safe_pdf_filename_unique(self):
		used = set()
		first = _safe_pdf_filename("BDO Cheque", used)
		second = _safe_pdf_filename("BDO Cheque", used)
		self.assertEqual(first, "BDO_Cheque.pdf")
		self.assertEqual(second, "BDO_Cheque_2.pdf")

	def test_serialize_template_strips_system_fields(self):
		row = SimpleNamespace(
			as_dict=lambda: {
				"pdf_field_name": "Payee",
				"field_type": "Data",
				"source_type": "Field Path",
				"source_field": "party_name",
				"jinja_script": None,
				"default_value": "",
				"date_format": "",
				"editable": 1,
				"name": "row-1",
				"parent": "Template",
			}
		)
		doc = SimpleNamespace(
			title="Cheque",
			reference_doctype="Payment Entry",
			group="Bank",
			disabled=0,
			show_on_draft=1,
			display_depends_on="",
			fields_only=0,
			field_mappings=[row],
		)
		doc.get = lambda key, default=None: getattr(doc, key, default)
		payload = _serialize_template(doc)
		self.assertEqual(payload["title"], "Cheque")
		self.assertNotIn("pdf_file", payload)
		self.assertEqual(payload["field_mappings"][0]["pdf_field_name"], "Payee")
		self.assertNotIn("name", payload["field_mappings"][0])
		self.assertNotIn("parent", payload["field_mappings"][0])


class TestImportZip(unittest.TestCase):
	def _make_zip(self, templates, pdfs: dict[str, bytes]) -> bytes:
		manifest = {"format_version": FORMAT_VERSION, "templates": templates}
		buffer = io.BytesIO()
		with zipfile.ZipFile(buffer, "w") as archive:
			archive.writestr("manifest.json", json.dumps(manifest))
			for name, content in pdfs.items():
				archive.writestr(f"pdfs/{name}", content)
		return buffer.getvalue()

	@patch("pdffiller.api.transfer._import_one_template")
	def test_import_calls_per_template(self, mock_import):
		mock_import.side_effect = [
			{"status": "created", "title": "A", "warnings": []},
			{"status": "updated", "title": "B", "warnings": []},
		]
		zip_bytes = self._make_zip(
			[
				{"title": "A", "pdf_filename": "A.pdf", "reference_doctype": "Payment Entry"},
				{"title": "B", "pdf_filename": "B.pdf", "reference_doctype": "Payment Entry"},
			],
			{"A.pdf": b"%PDF-A", "B.pdf": b"%PDF-B"},
		)
		summary = import_templates_from_zip(zip_bytes)
		self.assertEqual(summary["created"], 1)
		self.assertEqual(summary["updated"], 1)
		self.assertEqual(summary["errors"], 0)
		self.assertEqual(mock_import.call_count, 2)

	def test_missing_pdf_is_error(self):
		zip_bytes = self._make_zip(
			[{"title": "A", "pdf_filename": "missing.pdf", "reference_doctype": "Payment Entry"}],
			{},
		)
		summary = import_templates_from_zip(zip_bytes)
		self.assertEqual(summary["errors"], 1)
		self.assertIn("missing", summary["results"][0]["message"].lower())

	@patch("pdffiller.api.transfer.frappe")
	def test_missing_doctype_errors(self, mock_frappe):
		mock_frappe.db.exists.return_value = False
		mock_frappe._ = lambda value: value
		from pdffiller.api.transfer import _import_one_template

		result = _import_one_template(
			{"title": "A", "reference_doctype": "Missing Doctype", "field_mappings": []},
			b"%PDF",
		)
		self.assertEqual(result["status"], "error")
		self.assertIn("does not exist", result["message"])
