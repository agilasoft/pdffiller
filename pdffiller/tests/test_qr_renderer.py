# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import unittest

from pdffiller.utils.qr_renderer import generate_qr_png


class TestQrRenderer(unittest.TestCase):
	def test_generate_qr_png_returns_bytes(self):
		png_bytes = generate_qr_png("ITEM-001")
		self.assertIsInstance(png_bytes, bytes)
		self.assertTrue(png_bytes.startswith(b"\x89PNG"))

	def test_generate_qr_png_empty_value(self):
		self.assertEqual(generate_qr_png(""), b"")
		self.assertEqual(generate_qr_png("   "), b"")


if __name__ == "__main__":
	unittest.main()
