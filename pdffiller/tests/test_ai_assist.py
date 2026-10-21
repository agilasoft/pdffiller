# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe

from pdffiller.utils.ai_permissions import has_ai_access
from pdffiller.utils.ai_providers.base import ProviderResponse


class TestAIAssist(unittest.TestCase):
	def test_normalize_suggestions_filters_unknown_fields(self):
		from pdffiller.api.ai_assist import _normalize_suggestions

		raw = [
			{
				"pdf_field_name": "customer_name",
				"source_type": "Field Path",
				"source_field": "supplier_name",
				"confidence": 0.9,
				"reason": "name match",
			},
			{
				"pdf_field_name": "bad_field",
				"source_type": "Field Path",
				"source_field": "does_not_exist",
			},
		]
		result = _normalize_suggestions(raw, {"supplier_name", "customer"})
		self.assertEqual(len(result), 1)
		self.assertEqual(result[0]["pdf_field_name"], "customer_name")
		self.assertEqual(result[0]["source_field"], "supplier_name")

	def test_parse_json_from_content_strips_code_fence(self):
		from pdffiller.api.ai_assist import _parse_json_from_content

		content = '```json\n{"suggestions": []}\n```'
		parsed = _parse_json_from_content(content)
		self.assertEqual(parsed["suggestions"], [])

	@patch("pdffiller.utils.ai_permissions.get_settings")
	def test_has_ai_access_requires_enabled_and_role(self, mock_get_settings):
		mock_get_settings.return_value = SimpleNamespace(
			enabled=1,
			allowed_roles=[SimpleNamespace(role="System Manager")],
		)
		with patch.object(frappe, "get_roles", return_value=["System Manager"]):
			self.assertTrue(has_ai_access("test@example.com"))
		with patch.object(frappe, "get_roles", return_value=["Guest"]):
			self.assertFalse(has_ai_access("test@example.com"))

	@patch("pdffiller.api.ai_assist._call_llm")
	@patch("pdffiller.api.ai_assist._fields_for_template")
	@patch("pdffiller.api.ai_assist._get_template")
	@patch("pdffiller.api.ai_assist._require_template_write")
	def test_suggest_mappings_returns_normalized_rows(
		self, mock_perm, mock_get_template, mock_fields, mock_llm
	):
		mock_get_template.return_value = SimpleNamespace(
			name="Invoice Template",
			title="Invoice",
			reference_doctype="Sales Invoice",
			pdf_file="/files/test.pdf",
		)
		mock_fields.return_value = [
			{
				"field_name": "customer_name",
				"field_type": "Data",
				"source_field": "",
				"jinja_script": "",
			}
		]
		mock_llm.return_value = (
			json.dumps(
				{
					"suggestions": [
						{
							"pdf_field_name": "customer_name",
							"source_type": "Field Path",
							"source_field": "customer_name",
							"reason": "exact match",
						}
					]
				}
			),
			{"total_tokens": 10},
		)

		with patch("pdffiller.api.ai_assist._get_reference_fields") as mock_ref:
			mock_ref.return_value = [{"fieldname": "customer_name", "label": "Customer", "fieldtype": "Link"}]
			from pdffiller.api.ai_assist import suggest_mappings

			result = suggest_mappings("Invoice Template", fields="[]", mode="unmapped")

		self.assertEqual(len(result["suggestions"]), 1)
		self.assertEqual(result["suggestions"][0]["source_field"], "customer_name")

	@patch("pdffiller.utils.ai_providers.get_provider")
	@patch("pdffiller.utils.ai_permissions.record_ai_request")
	@patch("pdffiller.utils.ai_permissions.ensure_ai_access")
	def test_call_llm_uses_pdffiller_provider(self, mock_access, mock_rate, mock_get_provider):
		mock_get_provider.return_value = MagicMock(
			chat=MagicMock(return_value=ProviderResponse(content='{"ok": true}', token_usage=None))
		)
		from pdffiller.api.ai_assist import _call_llm

		content, usage = _call_llm("system", "user")
		self.assertIn("ok", content)
		mock_access.assert_called_once()
		mock_rate.assert_called_once()


if __name__ == "__main__":
	unittest.main()
