# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import io


def generate_qr_png(value: str) -> bytes:
	value = (value or "").strip()
	if not value:
		return b""

	import qrcode

	image = qrcode.make(value)
	stream = io.BytesIO()
	image.save(stream, format="PNG")
	return stream.getvalue()
