# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import base64
import os
import re

DATA_URI_RE = re.compile(r"^data:image/[^;]+;base64,(.+)$", re.IGNORECASE | re.DOTALL)


def resolve_image_bytes(value: str) -> bytes:
	"""Resolve a file URL, filesystem path, or data URI to image bytes."""
	value = (value or "").strip()
	if not value:
		return b""

	match = DATA_URI_RE.match(value)
	if match:
		try:
			return base64.b64decode(match.group(1))
		except Exception:
			return b""

	if os.path.isfile(value):
		with open(value, "rb") as handle:
			return handle.read()

	try:
		from frappe.utils.file_manager import get_file_path

		path = get_file_path(value)
	except Exception:
		return b""

	if path and os.path.exists(path):
		with open(path, "rb") as handle:
			return handle.read()

	return b""
