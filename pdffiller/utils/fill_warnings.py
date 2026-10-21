# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import contextvars
from contextlib import contextmanager

_warnings: contextvars.ContextVar[list[dict] | None] = contextvars.ContextVar(
	"pdffiller_fill_warnings",
	default=None,
)


def add_warning(field: str, message: str) -> None:
	bucket = _warnings.get()
	if bucket is None:
		return
	field_name = (field or "").strip()
	text = (message or "").strip()
	if not text:
		return
	entry = {"field": field_name, "message": text}
	if entry not in bucket:
		bucket.append(entry)


@contextmanager
def capture_warnings():
	bucket: list[dict] = []
	token = _warnings.set(bucket)
	try:
		yield bucket
	finally:
		_warnings.reset(token)
