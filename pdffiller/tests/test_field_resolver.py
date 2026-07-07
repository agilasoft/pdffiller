# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from pdffiller.utils.field_resolver import (
	format_date_value,
	get_source_type,
	is_jinja_template,
	render_jinja_template,
	resolve_mapping_value,
)


class FakeMeta:
	def __init__(self, fields):
		self._fields = {field.fieldname: field for field in fields}

	def get_field(self, fieldname):
		return self._fields.get(fieldname)


class FakeDoc:
	def __init__(self, values=None, fields=None):
		self.meta = FakeMeta(fields or [])
		for key, value in (values or {}).items():
			setattr(self, key, value)


class TestFieldResolver(unittest.TestCase):
	def test_resolve_default_value(self):
		doc = FakeDoc({"name": "DOC-001"})
		row = SimpleNamespace(
			source_type="Field Path",
			source_field="",
			jinja_script="",
			default_value="Fallback",
			date_format="",
		)
		self.assertEqual(resolve_mapping_value(doc, row), "Fallback")

	def test_resolve_top_level_field(self):
		doc = FakeDoc(
			{"party_name": "Acme Corp"},
			[SimpleNamespace(fieldname="party_name", fieldtype="Data")],
		)
		row = SimpleNamespace(
			source_type="Field Path",
			source_field="party_name",
			jinja_script="",
			default_value="",
			date_format="",
		)
		self.assertEqual(resolve_mapping_value(doc, row), "Acme Corp")

	def test_format_date_value(self):
		self.assertEqual(format_date_value("2026-07-07", "%m/%d/%Y"), "07/07/2026")
		self.assertEqual(format_date_value(date(2026, 7, 7), "%d-%m-%Y"), "07-07-2026")

	def test_resolve_with_date_format(self):
		doc = FakeDoc(
			{"posting_date": "2026-07-07"},
			[SimpleNamespace(fieldname="posting_date", fieldtype="Date")],
		)
		row = SimpleNamespace(
			source_type="Field Path",
			source_field="posting_date",
			jinja_script="",
			default_value="",
			date_format="%m/%d/%Y",
		)
		self.assertEqual(resolve_mapping_value(doc, row), "07/07/2026")

	def test_is_jinja_template(self):
		self.assertTrue(is_jinja_template("{{ doc.name }}"))
		self.assertTrue(is_jinja_template("{% if doc.name %}yes{% endif %}"))
		self.assertFalse(is_jinja_template("supplier.tax_id"))

	def test_get_source_type_auto_detect(self):
		row = SimpleNamespace(source_type="", source_field="{{ doc.name }}", jinja_script="")
		self.assertEqual(get_source_type(row), "Jinja Template")

		row = SimpleNamespace(source_type="", source_field="", jinja_script="{{ doc.name }}")
		self.assertEqual(get_source_type(row), "Jinja Script")

		row = SimpleNamespace(source_type="", source_field="party_name", jinja_script="")
		self.assertEqual(get_source_type(row), "Field Path")

	@patch("pdffiller.utils.field_resolver.frappe.render_template", return_value="Rendered")
	def test_resolve_jinja_template(self, _mock_render):
		doc = FakeDoc({"name": "DOC-001"})
		row = SimpleNamespace(
			source_type="Jinja Template",
			source_field="{{ doc.name }}",
			jinja_script="",
			default_value="",
			date_format="",
		)
		self.assertEqual(resolve_mapping_value(doc, row), "Rendered")

	@patch("pdffiller.utils.field_resolver.frappe.render_template", return_value="Script Value")
	def test_resolve_jinja_script(self, _mock_render):
		doc = FakeDoc({"name": "DOC-001"})
		row = SimpleNamespace(
			source_type="Jinja Script",
			source_field="",
			jinja_script="{% set x = doc.name %}{{ x }}",
			default_value="",
			date_format="",
		)
		self.assertEqual(resolve_mapping_value(doc, row), "Script Value")

	def test_render_jinja_template_empty(self):
		doc = FakeDoc({"name": "DOC-001"})
		self.assertEqual(render_jinja_template("", doc), "")


if __name__ == "__main__":
	unittest.main()
