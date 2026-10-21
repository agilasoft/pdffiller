# Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
# For license information, please see license.txt

from __future__ import annotations

import json
import os

import frappe
from frappe.boot import get_bootinfo
from frappe.desk.doctype.desktop_icon.desktop_icon import get_desktop_icons
from frappe.modules.import_file import import_file_by_path
from frappe.modules.utils import get_app_level_directory_path

APP_NAME = "pdffiller"
WORKSPACE_NAME = "PDF Filler"
DESKTOP_ICON_LABEL = "PDF Filler"


def sync_desk_setup(show_message: bool = False) -> int:
	"""Import desk fixtures and add PDF Filler to saved desktop layouts."""
	_import_desk_assets()
	_ensure_workspace()
	updated = _add_pdf_filler_to_desktop_layouts()

	frappe.db.commit()
	frappe.cache.delete_key("desktop_icons")
	frappe.cache.delete_key("bootinfo")
	frappe.clear_cache()

	if show_message and updated:
		frappe.msgprint(f"Added PDF Filler to {updated} Desktop Layout(s).")

	return updated


def _import_desk_assets():
	for folder in ("workspace_sidebar", "desktop_icon"):
		directory = get_app_level_directory_path(folder, APP_NAME)
		if not os.path.exists(directory):
			continue
		for fname in os.listdir(directory):
			if fname.endswith(".json"):
				import_file_by_path(os.path.join(directory, fname), force=True)

	if frappe.db.exists("Desktop Icon", DESKTOP_ICON_LABEL):
		doc = frappe.get_doc("Desktop Icon", DESKTOP_ICON_LABEL)
		doc.label = DESKTOP_ICON_LABEL
		doc.link_to = DESKTOP_ICON_LABEL
		doc.link_type = "Workspace Sidebar"
		doc.icon = "pdf_filler"
		doc.hidden = 0
		doc.save(ignore_permissions=True)


def _ensure_workspace():
	workspace_path = os.path.join(
		frappe.get_app_path(APP_NAME),
		"pdf_filler",
		"workspace",
		"pdf_filler",
		"pdf_filler.json",
	)

	if not frappe.db.exists("Workspace", WORKSPACE_NAME):
		if os.path.exists(workspace_path):
			import_file_by_path(workspace_path, force=True)
		return

	with open(workspace_path, encoding="utf-8") as handle:
		workspace_data = json.load(handle)

	workspace = frappe.get_doc("Workspace", WORKSPACE_NAME)
	for field in ("icon", "content", "type", "shortcuts", "links", "title", "label", "module", "app"):
		if field in workspace_data:
			workspace.set(field, workspace_data[field])
	workspace.save(ignore_permissions=True)


def _get_pdf_filler_desktop_icon() -> dict | None:
	boot = get_bootinfo()
	for icon in get_desktop_icons(bootinfo=boot):
		if icon.get("label") == DESKTOP_ICON_LABEL:
			desktop_icon = dict(icon)
			desktop_icon["child_icons"] = []
			desktop_icon["hidden"] = 0
			return desktop_icon
	return None


def _insert_index(layout: list) -> int:
	preferred_after = (
		"Workflow Center",
		"GoConnect",
		"Form Designer",
		"Approval Center",
	)
	for label in preferred_after:
		for index, icon in enumerate(layout):
			if isinstance(icon, dict) and icon.get("label") == label:
				return index + 1
	return len(layout)


def _add_pdf_filler_to_desktop_layouts() -> int:
	pdf_filler_icon = _get_pdf_filler_desktop_icon()
	if not pdf_filler_icon:
		return 0

	updated = 0
	for row in frappe.get_all("Desktop Layout", fields=["name", "layout"]):
		if not row.layout:
			continue
		try:
			layout = json.loads(row.layout)
		except Exception:
			continue
		if not isinstance(layout, list):
			continue

		labels = {item.get("label") for item in layout if isinstance(item, dict)}
		if DESKTOP_ICON_LABEL in labels:
			continue

		insert_at = _insert_index(layout)
		if insert_at > 0:
			previous = layout[insert_at - 1]
			pdf_filler_icon["idx"] = (previous.get("idx") or insert_at) + 1
		layout.insert(insert_at, pdf_filler_icon)

		doc = frappe.get_doc("Desktop Layout", row.name)
		doc.layout = json.dumps(layout)
		doc.save(ignore_permissions=True)
		updated += 1

	return updated
