# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import io


def generate_barcode_png(value: str) -> bytes:
	value = (value or "").strip()
	if not value:
		return b""

	from barcode import Code128
	from barcode.writer import ImageWriter

	stream = io.BytesIO()
	Code128(value, writer=ImageWriter()).write(stream, options={"write_text": False})
	return stream.getvalue()
