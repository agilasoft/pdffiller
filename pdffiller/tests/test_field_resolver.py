# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest
from datetime import date
from types import SimpleNamespace

from pdffiller.utils.field_resolver import format_date_value, resolve_mapping_value


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
		row = SimpleNamespace(source_field="", default_value="Fallback", date_format="")
		self.assertEqual(resolve_mapping_value(doc, row), "Fallback")

	def test_resolve_top_level_field(self):
		doc = FakeDoc(
			{"party_name": "Acme Corp"},
			[SimpleNamespace(fieldname="party_name", fieldtype="Data")],
		)
		row = SimpleNamespace(source_field="party_name", default_value="", date_format="")
		self.assertEqual(resolve_mapping_value(doc, row), "Acme Corp")

	def test_format_date_value(self):
		self.assertEqual(format_date_value("2026-07-07", "%m/%d/%Y"), "07/07/2026")
		self.assertEqual(format_date_value(date(2026, 7, 7), "%d-%m-%Y"), "07-07-2026")

	def test_resolve_with_date_format(self):
		doc = FakeDoc(
			{"posting_date": "2026-07-07"},
			[SimpleNamespace(fieldname="posting_date", fieldtype="Date")],
		)
		row = SimpleNamespace(source_field="posting_date", default_value="", date_format="%m/%d/%Y")
		self.assertEqual(resolve_mapping_value(doc, row), "07/07/2026")


if __name__ == "__main__":
	unittest.main()
