# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import os

import frappe
from frappe.utils.file_manager import get_file_path


def get_pdf_path(file_url: str) -> str:
	if not file_url:
		frappe.throw(frappe._("PDF file is not attached"))

	path = get_file_path(file_url)
	if not path or not os.path.exists(path):
		frappe.throw(frappe._("PDF file not found on disk"))
	return path


def template_has_widgets(pdf_path: str) -> bool:
	import fitz

	doc = fitz.open(pdf_path)
	try:
		for page in doc:
			if list(page.widgets() or []):
				return True
		return False
	finally:
		doc.close()


def list_acroform_fields(pdf_path: str) -> list[str]:
	import fitz

	fields: set[str] = set()
	doc = fitz.open(pdf_path)
	try:
		for page in doc:
			for widget in page.widgets() or []:
				if widget.field_name:
					fields.add(widget.field_name)
	finally:
		doc.close()
	return sorted(fields)


def _is_truthy_checkbox_value(value: str) -> bool:
	return (value or "").strip().lower() in ("yes", "true", "1", "on")


def _checkbox_is_checked(value) -> bool:
	if value is True:
		return True
	if value is False:
		return False
	return (str(value or "").strip().lower()) not in ("", "off", "no", "false", "0")


def _set_widget_value(widget, value: str) -> None:
	if widget.field_type_string in ("CheckBox", "Checkbox"):
		widget.field_value = _is_truthy_checkbox_value(value)
	else:
		widget.field_value = value or ""


def _commit_widget_flags(doc, widget, readonly: bool, *, update: bool = True) -> None:
	"""Persist the ReadOnly bit. ``widget.update()`` can put it back when flags are 0."""
	import fitz

	from pdffiller.utils.output_options import write_field_flags

	flags = int(widget.field_flags or 0)
	mask = int(fitz.PDF_FIELD_IS_READ_ONLY)
	if readonly:
		flags |= mask
	else:
		flags &= ~mask
	widget.field_flags = flags
	if update:
		try:
			widget.update()
		except Exception:
			pass
	write_field_flags(doc, widget, flags)


def _widget_matches_radio(widget, field_name: str, export_value: str) -> bool:
	if widget.field_name != field_name:
		return False
	states = (widget.button_states() or {}).get("normal", [])
	return bool(export_value) and export_value in states and export_value != "Off"


def _set_radio_field(page, field_name: str, export_value: str) -> bool:
	"""Select the radio widget whose on-state matches export_value."""
	export_value = (export_value or "").strip()
	if not export_value:
		return False
	for widget in page.widgets() or []:
		if not _widget_matches_radio(widget, field_name, export_value):
			continue
		widget.field_value = export_value
		widget.update()
		return True
	return False


FONT_FAMILIES = ("Helvetica", "Times", "Courier")
TEXT_ALIGNS = ("left", "center", "right")
_FONT_VARIANTS = {
	("Helvetica", 0, 0): ("Helv", "helv"),
	("Helvetica", 1, 0): ("HeBo", "hebo"),
	("Helvetica", 0, 1): ("HeIt", "heit"),
	("Helvetica", 1, 1): ("HeBI", "hebi"),
	("Times", 0, 0): ("TiRo", "tiro"),
	("Times", 1, 0): ("TiBo", "tibo"),
	("Times", 0, 1): ("TiIt", "tiit"),
	("Times", 1, 1): ("TiBI", "tibi"),
	("Courier", 0, 0): ("Cour", "cour"),
	("Courier", 1, 0): ("CoBo", "cobo"),
	("Courier", 0, 1): ("CoIt", "coit"),
	("Courier", 1, 1): ("CoBI", "cobi"),
}
_WIDGET_FONT_LOOKUP = {
	widget_name.lower(): (family, bold, italic, draw_name)
	for (family, bold, italic), (widget_name, draw_name) in _FONT_VARIANTS.items()
}


def default_word_wrap(field_type: str | None) -> int:
	return 1 if (field_type or "") in ("Small Text", "Long Text", "text") else 0


def normalize_color(value) -> str:
	text = str(value or "").strip()
	if len(text) == 7 and text.startswith("#"):
		try:
			int(text[1:], 16)
		except ValueError:
			return "#000000"
		return text.lower()
	return "#000000"


def color_to_rgb(value) -> tuple[float, float, float]:
	hex_color = normalize_color(value)
	return (
		int(hex_color[1:3], 16) / 255.0,
		int(hex_color[3:5], 16) / 255.0,
		int(hex_color[5:7], 16) / 255.0,
	)


def rgb_to_hex(color) -> str:
	if color is None:
		return "#000000"
	try:
		values = [float(channel) for channel in list(color)]
	except (TypeError, ValueError):
		return "#000000"
	if len(values) == 1:
		values = [values[0], values[0], values[0]]
	if len(values) < 3:
		return "#000000"
	parts = []
	for channel in values[:3]:
		if channel > 1:
			channel = channel / 255.0
		parts.append(max(0, min(255, round(channel * 255))))
	return "#{:02x}{:02x}{:02x}".format(*parts)


def normalize_text_style(source: dict | None, *, field_type: str | None = None) -> dict:
	source = source or {}
	family = str(source.get("font_family") or "Helvetica").strip()
	if family not in FONT_FAMILIES:
		family = "Helvetica"
	align = str(source.get("align") or "left").strip().lower()
	if align not in TEXT_ALIGNS:
		align = "left"
	raw_wrap = source.get("word_wrap") if "word_wrap" in source else None
	if raw_wrap is None or raw_wrap == "":
		word_wrap = default_word_wrap(field_type if field_type is not None else source.get("field_type"))
	else:
		word_wrap = 1 if int(raw_wrap) else 0
	return {
		"font_family": family,
		"bold": 1 if int(source.get("bold") or 0) else 0,
		"italic": 1 if int(source.get("italic") or 0) else 0,
		"color": normalize_color(source.get("color")),
		"align": align,
		"word_wrap": word_wrap,
	}


def widget_font_name(style: dict) -> str:
	key = (style["font_family"], int(style["bold"]), int(style["italic"]))
	return _FONT_VARIANTS.get(key, _FONT_VARIANTS[("Helvetica", 0, 0)])[0]


def draw_font_name(style: dict) -> str:
	key = (style["font_family"], int(style["bold"]), int(style["italic"]))
	return _FONT_VARIANTS.get(key, _FONT_VARIANTS[("Helvetica", 0, 0)])[1]


def style_from_widget_font(name: str | None) -> tuple[str, int, int]:
	found = _WIDGET_FONT_LOOKUP.get(str(name or "Helv").strip().lower())
	if not found:
		return ("Helvetica", 0, 0)
	return found[0], found[1], found[2]


def read_widget_align(doc, widget) -> str | None:
	"""Return left/center/right, or None when the widget has no /Q entry."""
	xref = int(getattr(widget, "xref", 0) or 0)
	if doc is None or not xref:
		return None
	try:
		kind, value = doc.xref_get_key(xref, "Q")
	except Exception:
		return None
	if not value or kind in ("null", "none") or str(value) in ("null", "none"):
		return None
	try:
		quad = int(str(value).split()[0])
	except (TypeError, ValueError):
		return None
	return {0: "left", 1: "center", 2: "right"}.get(quad)


def write_widget_align(doc, widget, align: str) -> None:
	xref = int(getattr(widget, "xref", 0) or 0)
	if doc is None or not xref:
		return
	quad = {"left": "0", "center": "1", "right": "2"}.get(align or "left", "0")
	doc.xref_set_key(xref, "Q", quad)


_BASE14_FONTS = {
	"Helv": "Helvetica",
	"HeBo": "Helvetica-Bold",
	"HeIt": "Helvetica-Oblique",
	"HeBI": "Helvetica-BoldOblique",
	"TiRo": "Times-Roman",
	"TiBo": "Times-Bold",
	"TiIt": "Times-Italic",
	"TiBI": "Times-BoldItalic",
	"Cour": "Courier",
	"CoBo": "Courier-Bold",
	"CoIt": "Courier-Oblique",
	"CoBI": "Courier-BoldOblique",
}


def ensure_form_font(doc, resource_name: str) -> None:
	"""Register a base-14 font on the AcroForm so widget /DA names resolve.

	PyMuPDF's widget API only accepts Helv, TiRo, and Cour. Bold and italic
	variants are written into /DA after the widget exists.
	"""
	resource_name = resource_name or "Helv"
	if resource_name in (doc.FormFonts or []):
		return
	base_font = _BASE14_FONTS.get(resource_name, "Helvetica")
	font_xref = doc.get_new_xref()
	doc.update_object(
		font_xref,
		f"<< /Type /Font /Subtype /Type1 /BaseFont /{base_font} /Encoding /WinAnsiEncoding /Name /{resource_name} >>",
	)
	doc.xref_set_key(doc.pdf_catalog(), f"AcroForm/DR/Font/{resource_name}", f"{font_xref} 0 R")


def write_widget_text_appearance(doc, widget, field: dict) -> None:
	style = normalize_text_style(field, field_type=field.get("field_type"))
	font_name = widget_font_name(style)
	ensure_form_font(doc, font_name)
	red, green, blue = color_to_rgb(style["color"])
	size = float(field.get("font_size") or 10)
	doc.xref_set_key(
		widget.xref,
		"DA",
		f"({red:g} {green:g} {blue:g} rg /{font_name} {size:g} Tf)",
	)
	write_widget_align(doc, widget, style["align"])


def apply_widget_text_style(widget, field: dict) -> dict:
	import fitz

	style = normalize_text_style(field, field_type=field.get("field_type"))
	widget.text_font = widget_font_name(style)
	widget.text_fontsize = float(field.get("font_size") or 10)
	widget.text_color = list(color_to_rgb(style["color"]))
	flags = int(getattr(widget, "field_flags", 0) or 0)
	if style["word_wrap"]:
		flags |= fitz.PDF_TX_FIELD_IS_MULTILINE
		flags &= ~fitz.PDF_TX_FIELD_IS_COMB
	else:
		flags &= ~fitz.PDF_TX_FIELD_IS_MULTILINE
	widget.field_flags = flags
	return style


def text_draw_options_from_widget(widget, doc=None) -> dict:
	import fitz

	family, bold, italic = style_from_widget_font(getattr(widget, "text_font", None))
	flags = int(getattr(widget, "field_flags", 0) or 0)
	return {
		"fontname": draw_font_name({"font_family": family, "bold": bold, "italic": italic}),
		"color": color_to_rgb(rgb_to_hex(getattr(widget, "text_color", None))),
		"align": read_widget_align(doc, widget),
		"word_wrap": bool(flags & fitz.PDF_TX_FIELD_IS_MULTILINE),
	}


def _resolved_align_name(align: str | None, text: str) -> str:
	if not align:
		return "center" if len(text.strip()) <= 8 else "left"
	name = str(align).lower()
	if name in TEXT_ALIGNS:
		return name
	return "left"


def _fitz_align(fitz_mod, align_name: str):
	return {
		"center": fitz_mod.TEXT_ALIGN_CENTER,
		"right": fitz_mod.TEXT_ALIGN_RIGHT,
	}.get(align_name, fitz_mod.TEXT_ALIGN_LEFT)


def _text_width(text: str, fontname: str, fontsize: float) -> float:
	import fitz

	return float(fitz.get_text_length(text, fontname=fontname, fontsize=fontsize))


def _clip_single_line(text: str, fontname: str, fontsize: float, width: float, align_name: str) -> str:
	"""Keep the part of a single line that fits in width."""
	text = " ".join(text.replace("\n", " ").split())
	if not text or width <= 0:
		return text
	if _text_width(text, fontname, fontsize) <= width:
		return text

	def fits(sample: str) -> bool:
		return _text_width(sample, fontname, fontsize) <= width

	if align_name == "right":
		start = 0
		end = len(text)
		while start < end:
			mid = (start + end) // 2
			if fits(text[mid:]):
				end = mid
			else:
				start = mid + 1
		return text[start:]

	if align_name == "center":
		start = 0
		end = len(text)
		while start < end:
			mid = (start + end) // 2
			if fits(text[mid : len(text) - mid]):
				end = mid
			else:
				start = mid + 1
		return text[start : len(text) - start]

	end = len(text)
	start = 0
	while start < end:
		mid = (start + end + 1) // 2
		if fits(text[:mid]):
			start = mid
		else:
			end = mid - 1
	return text[:start]


def _draw_radio_selection(page, widgets, field_name: str, export_value: str) -> None:
	"""Stamp an X on the selected radio option (fields-only / flattened output)."""
	import fitz

	export_value = (export_value or "").strip()
	if not export_value:
		return
	for widget in widgets:
		if not _widget_matches_radio(widget, field_name, export_value):
			continue
		page.insert_textbox(
			widget.rect,
			"X",
			fontname="hebo",
			fontsize=max(min(widget.rect.height, widget.rect.width) - 1, 6),
			color=(0, 0, 0),
			align=fitz.TEXT_ALIGN_CENTER,
		)
		return


def _draw_text_field(
	page,
	rect,
	text: str,
	fontsize: float,
	*,
	comb_slots: int = 0,
	fontname: str = "helv",
	color: tuple[float, float, float] = (0, 0, 0),
	align: str | None = None,
	word_wrap: bool = True,
) -> None:
	import fitz

	text = str(text or "")
	if not text.strip():
		return

	fontsize = max(fontsize, 6)
	fontname = fontname or "helv"
	if comb_slots and comb_slots > 0:
		slot_w = rect.width / comb_slots
		chars = list(text[:comb_slots])
		for idx, char in enumerate(chars):
			if not str(char).strip():
				continue
			slot = fitz.Rect(rect.x0 + idx * slot_w, rect.y0, rect.x0 + (idx + 1) * slot_w, rect.y1)
			page.insert_textbox(
				slot,
				char,
				fontname=fontname,
				fontsize=min(fontsize, max(slot.height - 2, 6)),
				color=color,
				align=fitz.TEXT_ALIGN_CENTER,
			)
		return

	align_name = _resolved_align_name(align, text)
	resolved = _fitz_align(fitz, align_name)
	target = rect
	draw_text = text
	if not word_wrap:
		draw_text = _clip_single_line(text, fontname, fontsize, float(rect.width), align_name)
		if not draw_text:
			return
		# One line tall enough for base-14 metrics, and short enough that a second line cannot fit.
		line_height = min(float(rect.height), max(fontsize * 2.05, 8))
		top = rect.y0 + max((float(rect.height) - line_height) / 2, 0)
		target = fitz.Rect(rect.x0, top, rect.x1, min(rect.y1, top + line_height))
	page.insert_textbox(
		target,
		draw_text,
		fontname=fontname,
		fontsize=fontsize,
		color=color,
		align=resolved,
	)


def _widget_comb_slots(widget) -> int:
	import fitz

	flags = int(getattr(widget, "field_flags", 0) or 0)
	maxlen = int(getattr(widget, "text_maxlen", 0) or 0)
	if maxlen > 0 and flags & fitz.PDF_TX_FIELD_IS_COMB:
		return maxlen
	return 0


def _draw_checkbox(page, rect, checked: bool) -> None:
	import fitz

	size = min(rect.width, rect.height)
	if size <= 0:
		return
	center_x = (rect.x0 + rect.x1) / 2
	center_y = (rect.y0 + rect.y1) / 2
	half = size / 2
	box = fitz.Rect(center_x - half, center_y - half, center_x + half, center_y + half)
	page.draw_rect(box, color=(0, 0, 0), width=0.75)
	if checked:
		inset = size * 0.2
		page.draw_line(
			fitz.Point(box.x0 + inset, box.y0 + size * 0.5),
			fitz.Point(box.x0 + size * 0.4, box.y1 - inset),
			color=(0, 0, 0),
			width=1,
		)
		page.draw_line(
			fitz.Point(box.x0 + size * 0.4, box.y1 - inset),
			fitz.Point(box.x1 - inset, box.y0 + inset),
			color=(0, 0, 0),
			width=1,
		)


def _warn_draw_failure(field_name: str, message: str) -> None:
	from pdffiller.utils.fill_warnings import add_warning

	add_warning(field_name, message)


def _draw_barcode(page, rect, value: str, field_name: str = "") -> None:
	from pdffiller.utils.barcode_renderer import generate_barcode_png

	try:
		png_bytes = generate_barcode_png(value)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render barcode: {exc}")
		return
	if not png_bytes:
		if (value or "").strip():
			_warn_draw_failure(field_name, "Could not render barcode")
		return

	try:
		page.insert_image(rect, stream=png_bytes, keep_proportion=True)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render barcode: {exc}")


def _draw_qr(page, rect, value: str, field_name: str = "") -> None:
	from pdffiller.utils.qr_renderer import generate_qr_png

	try:
		png_bytes = generate_qr_png(value)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render QR code: {exc}")
		return
	if not png_bytes:
		if (value or "").strip():
			_warn_draw_failure(field_name, "Could not render QR code")
		return

	try:
		page.insert_image(rect, stream=png_bytes, keep_proportion=True)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render QR code: {exc}")


def _draw_image(page, rect, value: str, field_name: str = "") -> None:
	from pdffiller.utils.image_renderer import resolve_image_bytes

	try:
		image_bytes = resolve_image_bytes(value)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render image: {exc}")
		return
	if not image_bytes:
		if (value or "").strip():
			_warn_draw_failure(field_name, "Could not render image")
		return

	try:
		page.insert_image(rect, stream=image_bytes, keep_proportion=True)
	except Exception as exc:
		_warn_draw_failure(field_name, f"Could not render image: {exc}")


def _get_fields_by_type(template_doc, field_type: str) -> set[str]:
	return {
		row.pdf_field_name
		for row in getattr(template_doc, "field_mappings", []) or []
		if row.pdf_field_name and (getattr(row, "field_type", None) or "") == field_type
	}


def _get_barcode_fields(template_doc) -> set[str]:
	return _get_fields_by_type(template_doc, "Barcode")


def _get_qr_fields(template_doc) -> set[str]:
	return _get_fields_by_type(template_doc, "QR Code")


def _get_image_fields(template_doc) -> set[str]:
	return _get_fields_by_type(template_doc, "Image")


def _get_image_like_fields(template_doc) -> set[str]:
	return _get_image_fields(template_doc) | _get_fields_by_type(template_doc, "Signature")


def _draw_special_field(
	page,
	rect,
	value: str,
	field_name: str,
	barcode_fields,
	image_fields,
	qr_fields=None,
) -> bool:
	qr_fields = qr_fields or set()
	if field_name in barcode_fields:
		if (value or "").strip():
			_draw_barcode(page, rect, value, field_name)
		return True
	if field_name in qr_fields:
		if (value or "").strip():
			_draw_qr(page, rect, value, field_name)
		return True
	if field_name in image_fields:
		if (value or "").strip():
			_draw_image(page, rect, value, field_name)
		return True
	return False


def fill_pdf_fields_only(
	template_path: str,
	form_data: dict[str, str],
	barcode_fields: set[str] | None = None,
	image_fields: set[str] | None = None,
	qr_fields: set[str] | None = None,
) -> bytes:
	import fitz

	barcode_fields = barcode_fields or set()
	image_fields = image_fields or set()
	qr_fields = qr_fields or set()
	template_doc = fitz.open(template_path)
	output_doc = fitz.open()
	try:
		for page_num in range(len(template_doc)):
			template_page = template_doc[page_num]
			rect = template_page.rect
			output_page = output_doc.new_page(width=rect.width, height=rect.height)

			page_widgets = list(template_page.widgets() or [])
			widgets = {widget.field_name: widget for widget in page_widgets}
			radio_done: set[str] = set()
			for field_name, value in form_data.items():
				if field_name in radio_done:
					continue
				# Radio groups share a field name across multiple widgets.
				radio_widgets = [w for w in page_widgets if w.field_name == field_name and w.field_type_string == "RadioButton"]
				if radio_widgets:
					_draw_radio_selection(output_page, radio_widgets, field_name, value)
					radio_done.add(field_name)
					continue

				widget = widgets.get(field_name)
				if not widget:
					continue

				widget_rect = widget.rect
				if _draw_special_field(
					output_page,
					widget_rect,
					value,
					field_name,
					barcode_fields,
					image_fields,
					qr_fields=qr_fields,
				):
					continue
				if widget.field_type_string in ("CheckBox", "Checkbox"):
					_draw_checkbox(output_page, widget_rect, _is_truthy_checkbox_value(value))
				elif (value or "").strip():
					fontsize = float(getattr(widget, "text_fontsize", 0) or 10)
					_draw_text_field(
						output_page,
						widget_rect,
						value,
						fontsize,
						comb_slots=_widget_comb_slots(widget),
						**text_draw_options_from_widget(widget, template_doc),
					)

		# Skip garbage=4: it takes seconds on BIR face PDFs and barely shrinks them.
		return output_doc.tobytes()
	finally:
		template_doc.close()
		output_doc.close()


def fill_pdf(
	template_path: str,
	form_data: dict[str, str],
	readonly_fields: set[str] | None = None,
	barcode_fields: set[str] | None = None,
	image_fields: set[str] | None = None,
	qr_fields: set[str] | None = None,
) -> bytes:
	import fitz

	readonly_fields = readonly_fields or set()
	barcode_fields = barcode_fields or set()
	image_fields = image_fields or set()
	qr_fields = qr_fields or set()
	doc = fitz.open(template_path)
	try:
		for page in doc:
			page_widgets = list(page.widgets() or [])
			widgets = {widget.field_name: widget for widget in page_widgets}
			radio_done: set[str] = set()
			for field_name, value in form_data.items():
				if field_name in radio_done:
					continue

				radio_widgets = [
					w for w in page_widgets if w.field_name == field_name and w.field_type_string == "RadioButton"
				]
				if radio_widgets:
					_set_radio_field(page, field_name, value)
					if field_name in readonly_fields:
						# Set flags on the whole group, but only update() the selected
						# widget. Updating Off siblings can re-select them in PyMuPDF.
						export_value = (value or "").strip()
						selected = None
						for widget in radio_widgets:
							_commit_widget_flags(doc, widget, True, update=False)
							if _widget_matches_radio(widget, field_name, export_value):
								selected = widget
						if selected:
							selected.field_value = export_value
							selected.update()
							_commit_widget_flags(doc, selected, True, update=False)
					else:
						for widget in radio_widgets:
							_commit_widget_flags(doc, widget, False, update=False)
					radio_done.add(field_name)
					continue

				widget = widgets.get(field_name)
				if not widget:
					continue
				if field_name in barcode_fields or field_name in image_fields or field_name in qr_fields:
					_set_widget_value(widget, "")
					_draw_special_field(
						page,
						widget.rect,
						value,
						field_name,
						barcode_fields,
						image_fields,
						qr_fields=qr_fields,
					)
				else:
					_set_widget_value(widget, value)
				_commit_widget_flags(doc, widget, field_name in readonly_fields)
		# Skip garbage=4: it takes seconds on BIR face PDFs and barely shrinks them.
		return doc.tobytes()
	finally:
		doc.close()


def build_form_data(template_doc, source_doc, overrides: dict[str, str] | None = None) -> dict[str, str]:
	from pdffiller.utils.field_resolver import resolve_mapping_value

	overrides = overrides or {}
	form_data: dict[str, str] = {}
	for row in template_doc.field_mappings:
		if not row.pdf_field_name:
			continue
		if row.pdf_field_name in overrides:
			form_data[row.pdf_field_name] = overrides[row.pdf_field_name] or ""
		else:
			form_data[row.pdf_field_name] = resolve_mapping_value(source_doc, row)
	return form_data


def build_field_preview(template_doc, source_doc) -> list[dict]:
	from pdffiller.utils.field_resolver import resolve_mapping_value

	fields = []
	for row in template_doc.field_mappings:
		if not row.pdf_field_name:
			continue
		fields.append(
			{
				"pdf_field_name": row.pdf_field_name,
				"value": resolve_mapping_value(source_doc, row),
				"editable": bool(row.editable),
				"source_type": row.source_type or "Field Path",
				"field_type": getattr(row, "field_type", None) or "",
			}
		)
	return fields


def _get_readonly_fields(template_doc) -> set[str]:
	return {
		row.pdf_field_name
		for row in template_doc.field_mappings
		if row.pdf_field_name and not row.editable
	}


def fill_template_pdf(
	template_doc,
	source_doc,
	overrides: dict[str, str] | None = None,
	fields_only: bool = False,
) -> bytes:
	if not template_doc.pdf_file:
		frappe.throw(frappe._("PDF Form Template has no PDF file attached"))

	pdf_path = get_pdf_path(template_doc.pdf_file)
	from pdffiller.utils.looping_fill import fill_looping_template, should_use_looping_fill

	if should_use_looping_fill(template_doc, pdf_path):
		return fill_looping_template(
			template_doc,
			source_doc,
			pdf_path,
			overrides=overrides,
			fields_only=fields_only,
		)

	form_data = build_form_data(template_doc, source_doc, overrides=overrides)
	barcode_fields = _get_barcode_fields(template_doc)
	image_fields = _get_image_like_fields(template_doc)
	qr_fields = _get_qr_fields(template_doc)
	if fields_only:
		return fill_pdf_fields_only(
			pdf_path,
			form_data,
			barcode_fields=barcode_fields,
			image_fields=image_fields,
			qr_fields=qr_fields,
		)

	readonly_fields = _get_readonly_fields(template_doc)
	return fill_pdf(
		pdf_path,
		form_data,
		readonly_fields=readonly_fields,
		barcode_fields=barcode_fields,
		image_fields=image_fields,
		qr_fields=qr_fields,
	)
