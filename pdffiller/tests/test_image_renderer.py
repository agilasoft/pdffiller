# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

import base64
import os
import tempfile
import unittest

from pdffiller.utils.image_renderer import resolve_image_bytes

# 1x1 PNG
TINY_PNG = base64.b64decode(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class TestImageRenderer(unittest.TestCase):
	def test_resolve_image_bytes_empty(self):
		self.assertEqual(resolve_image_bytes(""), b"")
		self.assertEqual(resolve_image_bytes("   "), b"")

	def test_resolve_image_bytes_from_path(self):
		with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
			tmp.write(TINY_PNG)
			path = tmp.name
		try:
			self.assertEqual(resolve_image_bytes(path), TINY_PNG)
		finally:
			os.unlink(path)

	def test_resolve_image_bytes_from_data_uri(self):
		encoded = base64.b64encode(TINY_PNG).decode("ascii")
		value = f"data:image/png;base64,{encoded}"
		self.assertEqual(resolve_image_bytes(value), TINY_PNG)

	def test_resolve_image_bytes_missing_file(self):
		self.assertEqual(resolve_image_bytes("/tmp/does-not-exist-pdffiller.png"), b"")


if __name__ == "__main__":
	unittest.main()
