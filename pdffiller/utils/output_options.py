# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import io
import zipfile


def coerce_flag(value, default: int = 0) -> bool:
	if value is None:
		return bool(default)
	try:
		return bool(int(value))
	except (TypeError, ValueError):
		return bool(value)


def flatten_requested(template_doc, flatten=None) -> bool:
	if flatten is not None:
		return coerce_flag(flatten, default=0)
	return coerce_flag(getattr(template_doc, "flatten", None), default=0)


def should_stamp_draft(template_doc, source_doc) -> bool:
	"""Stamp DRAFT on submittable documents that are still drafts."""
	if coerce_flag(getattr(template_doc, "skip_draft_watermark", None), default=0):
		return False
	meta = getattr(source_doc, "meta", None)
	if not meta or not coerce_flag(getattr(meta, "is_submittable", None), default=0):
		return False
	return int(getattr(source_doc, "docstatus", 0) or 0) == 0


def apply_output_options(pdf_bytes: bytes, template_doc, source_doc, flatten=None) -> bytes:
	do_flatten = flatten_requested(template_doc, flatten)
	stamp = should_stamp_draft(template_doc, source_doc)
	if do_flatten:
		pdf_bytes = flatten_pdf(pdf_bytes)
	if stamp:
		pdf_bytes = stamp_draft_watermark(pdf_bytes)
	return pdf_bytes


def flatten_pdf(pdf_bytes: bytes) -> bytes:
	"""Burn widget values into page content and remove the AcroForm."""
	import fitz

	doc = fitz.open(stream=pdf_bytes, filetype="pdf")
	try:
		baked = False
		if hasattr(doc, "bake"):
			try:
				doc.bake(annots=True, widgets=True)
				baked = True
			except Exception:
				baked = False
		if not baked:
			for page in doc:
				for widget in list(page.widgets() or []):
					try:
						widget.update()
					except Exception:
						pass
					try:
						page.delete_widget(widget)
					except Exception:
						pass
		return doc.tobytes()
	finally:
		doc.close()


def stamp_draft_watermark(pdf_bytes: bytes) -> bytes:
	import fitz

	doc = fitz.open(stream=pdf_bytes, filetype="pdf")
	try:
		for page in doc:
			rect = page.rect
			fontsize = max(28, min(rect.width, rect.height) / 8)
			point = fitz.Point(rect.width * 0.18, rect.height * 0.55)
			kwargs = {
				"fontsize": fontsize,
				"fontname": "helv",
				"color": (0.75, 0.12, 0.12),
			}
			try:
				page.insert_text(point, "DRAFT", fill_opacity=0.35, **kwargs)
			except Exception:
				page.insert_text(point, "DRAFT", **kwargs)
		return doc.tobytes()
	finally:
		doc.close()


def merge_pdfs(parts: list[bytes]) -> bytes:
	import fitz

	output = fitz.open()
	sources = []
	try:
		for part in parts:
			source = fitz.open(stream=part, filetype="pdf")
			sources.append(source)
			output.insert_pdf(source)
		return output.tobytes()
	finally:
		for source in sources:
			source.close()
		output.close()


def zip_pdfs(files: list[tuple[str, bytes]]) -> bytes:
	buffer = io.BytesIO()
	used: set[str] = set()
	with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
		for filename, content in files:
			name = filename or "form.pdf"
			if name in used:
				stem, dot, ext = name.rpartition(".")
				name = f"{stem}-{len(used)}.{ext}" if dot else f"{name}-{len(used)}"
			used.add(name)
			archive.writestr(name, content)
	return buffer.getvalue()
