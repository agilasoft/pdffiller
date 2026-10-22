# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import io
import re
import zipfile

# Looping fill renames widgets to ``name__pN`` so each output page is unique.
_LOOP_PAGE_SUFFIX = re.compile(r"__p\d+$")


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


def editable_field_names(template_doc) -> set[str]:
	"""Field names marked editable in the print review."""
	names: set[str] = set()
	for row in getattr(template_doc, "field_mappings", None) or []:
		field_name = getattr(row, "pdf_field_name", None)
		if field_name and coerce_flag(getattr(row, "editable", None)):
			names.add(str(field_name))
	return names


def apply_output_options(pdf_bytes: bytes, template_doc, source_doc, flatten=None) -> bytes:
	do_flatten = flatten_requested(template_doc, flatten)
	stamp = should_stamp_draft(template_doc, source_doc)
	if do_flatten:
		# Flatten still burns locked fields. Editable ones stay fillable in the review.
		pdf_bytes = flatten_pdf(pdf_bytes, keep_fields=editable_field_names(template_doc))
	if stamp:
		pdf_bytes = stamp_draft_watermark(pdf_bytes)
	return pdf_bytes


def _widget_is_kept(field_name: str | None, keep_fields: set[str]) -> bool:
	name = field_name or ""
	if not name or not keep_fields:
		return False
	if name in keep_fields:
		return True
	base = _LOOP_PAGE_SUFFIX.sub("", name)
	return base != name and base in keep_fields


def flatten_pdf(pdf_bytes: bytes, keep_fields: set[str] | None = None) -> bytes:
	"""Burn widget values into page content.

	Names in ``keep_fields`` stay interactive, including looping copies named
	``field__pN``. An empty keep set removes every widget.
	"""
	import fitz

	keep = {name for name in (keep_fields or set()) if name}
	doc = fitz.open(stream=pdf_bytes, filetype="pdf")
	try:
		if keep and _doc_has_kept_widget(doc, keep):
			_flatten_except(doc, keep)
		else:
			_flatten_all(doc)
		return doc.tobytes()
	finally:
		doc.close()


def _doc_has_kept_widget(doc, keep_fields: set[str]) -> bool:
	for page in doc:
		for widget in page.widgets() or []:
			if _widget_is_kept(widget.field_name, keep_fields):
				return True
	return False


def _flatten_all(doc) -> None:
	baked = False
	if hasattr(doc, "bake"):
		try:
			doc.bake(annots=True, widgets=True)
			baked = True
		except Exception:
			baked = False
	if baked:
		return
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


def _flatten_except(doc, keep_fields: set[str]) -> None:
	snapshots: list[tuple[int, dict]] = []
	for page in doc:
		for widget in list(page.widgets() or []):
			if not _widget_is_kept(widget.field_name, keep_fields):
				continue
			snapshots.append((page.number, _snapshot_widget(doc, widget)))
			page.delete_widget(widget)

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
				_burn_widget(page, widget)
				try:
					page.delete_widget(widget)
				except Exception:
					pass

	for page_no, spec in snapshots:
		if page_no < 0 or page_no >= doc.page_count:
			continue
		page = doc[page_no]
		try:
			_restore_widget(page, spec)
		except Exception:
			_burn_snapshot(page, spec)


def _snapshot_widget(doc, widget) -> dict:
	import fitz

	xref = int(getattr(widget, "xref", 0) or 0)
	flags = int(widget.field_flags or 0) & ~int(fitz.PDF_FIELD_IS_READ_ONLY)
	da = ("null", "null")
	quad = ("null", "null")
	if xref:
		try:
			da = doc.xref_get_key(xref, "DA")
		except Exception:
			da = ("null", "null")
		try:
			quad = doc.xref_get_key(xref, "Q")
		except Exception:
			quad = ("null", "null")
	return {
		"field_name": widget.field_name,
		"field_type": widget.field_type,
		"rect": fitz.Rect(widget.rect),
		"field_value": widget.field_value,
		"field_flags": flags,
		"text_fontsize": float(getattr(widget, "text_fontsize", 0) or 0),
		"text_font": getattr(widget, "text_font", None),
		"text_color": getattr(widget, "text_color", None),
		"text_maxlen": int(getattr(widget, "text_maxlen", 0) or 0),
		"choice_values": list(getattr(widget, "choice_values", None) or []),
		"field_label": getattr(widget, "field_label", None) or "",
		"da": da,
		"q": quad,
	}


def _pdf_literal(value: str) -> str:
	escaped = value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
	return f"({escaped})"


def _restore_xref_style(doc, widget, spec: dict) -> None:
	xref = int(getattr(widget, "xref", 0) or 0)
	if doc is None or not xref:
		return
	kind, da = spec.get("da") or ("null", "null")
	if kind == "string" and da and str(da) not in ("null", "none"):
		doc.xref_set_key(xref, "DA", _pdf_literal(str(da)))
	kind_q, quad = spec.get("q") or ("null", "null")
	if quad and kind_q not in ("null", "none") and str(quad) not in ("null", "none"):
		doc.xref_set_key(xref, "Q", str(quad).split()[0])
	# update() can put the ReadOnly bit back when the flag value is 0, so write Ff directly.
	doc.xref_set_key(xref, "Ff", str(int(spec.get("field_flags") or 0)))


def _widget_by_name(page, field_name: str, index: int):
	matches = [item for item in page.widgets() or [] if item.field_name == field_name]
	if not matches:
		raise RuntimeError(f"Missing widget {field_name}")
	if index < len(matches):
		return matches[index]
	return matches[-1]


def _restore_widget(page, spec: dict) -> None:
	import fitz

	field_name = spec["field_name"]
	existing = sum(1 for item in page.widgets() or [] if item.field_name == field_name)
	widget = fitz.Widget()
	widget.field_name = field_name
	widget.field_type = spec["field_type"]
	widget.rect = spec["rect"]
	widget.field_value = spec["field_value"]
	widget.field_flags = int(spec.get("field_flags") or 0)
	if spec.get("text_fontsize"):
		widget.text_fontsize = spec["text_fontsize"]
	if spec.get("text_font"):
		widget.text_font = spec["text_font"]
	color = spec.get("text_color")
	if color:
		try:
			channels = [float(channel) for channel in list(color)]
		except (TypeError, ValueError):
			channels = []
		if len(channels) >= 3:
			widget.text_color = channels[:3]
	if spec.get("text_maxlen"):
		widget.text_maxlen = spec["text_maxlen"]
	if spec.get("choice_values"):
		widget.choice_values = list(spec["choice_values"])
	if spec.get("field_label"):
		widget.field_label = spec["field_label"]
	page.add_widget(widget)
	doc = page.parent
	stored = _widget_by_name(page, field_name, existing)
	_restore_xref_style(doc, stored, spec)
	try:
		stored.update()
	except Exception:
		pass
	stored = _widget_by_name(page, field_name, existing)
	_restore_xref_style(doc, stored, spec)


def _burn_widget(page, widget) -> None:
	_burn_snapshot(
		page,
		{
			"rect": widget.rect,
			"field_value": getattr(widget, "field_value", ""),
			"field_type": widget.field_type,
			"text_fontsize": float(getattr(widget, "text_fontsize", 0) or 10),
		},
	)


def _burn_snapshot(page, spec: dict) -> None:
	import fitz

	value = spec.get("field_value")
	if value is True:
		text = "X"
	elif value is False or value is None:
		text = ""
	else:
		text = str(value)
	if spec.get("field_type") == fitz.PDF_WIDGET_TYPE_CHECKBOX:
		text = "X" if text.strip().lower() not in ("", "off", "no", "false", "0") else ""
	if not text.strip() or text.strip().lower() in ("off", "false"):
		return
	fontsize = float(spec.get("text_fontsize") or 10) or 10
	try:
		page.insert_textbox(
			spec["rect"],
			text,
			fontsize=max(fontsize, 6),
			fontname="helv",
			align=fitz.TEXT_ALIGN_LEFT,
		)
	except Exception:
		pass


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
