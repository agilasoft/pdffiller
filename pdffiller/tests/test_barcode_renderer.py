# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest

from pdffiller.utils.barcode_renderer import generate_barcode_png


class TestBarcodeRenderer(unittest.TestCase):
	def test_generate_barcode_png_returns_bytes(self):
		png_bytes = generate_barcode_png("ITEM-001")
		self.assertIsInstance(png_bytes, bytes)
		self.assertTrue(png_bytes.startswith(b"\x89PNG"))

	def test_generate_barcode_png_empty_value(self):
		self.assertEqual(generate_barcode_png(""), b"")
		self.assertEqual(generate_barcode_png("   "), b"")


if __name__ == "__main__":
	unittest.main()
