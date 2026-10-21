/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.designer");

(function () {
	"use strict";

	const FIELD_TYPES = [
		{ type: "Data", icon: "text", label: __("Data"), width: 150, height: 20, font_size: 10 },
		{ type: "Link", icon: "link", label: __("Link"), width: 150, height: 20, font_size: 10 },
		{ type: "Date", icon: "calendar", label: __("Date"), width: 100, height: 20, font_size: 10, date_format: "%d-%m-%Y" },
		{ type: "Int", icon: "hash", label: __("Int"), width: 80, height: 20, font_size: 10 },
		{ type: "Float", icon: "hash", label: __("Float"), width: 90, height: 20, font_size: 10 },
		{ type: "Currency", icon: "money", label: __("Currency"), width: 100, height: 20, font_size: 10 },
		{ type: "Check", icon: "check", label: __("Check"), width: 14, height: 14, font_size: 10 },
		{ type: "Select", icon: "list", label: __("Select"), width: 120, height: 20, font_size: 10, options: "Option 1\nOption 2" },
		{ type: "Small Text", icon: "align-left", label: __("Small Text"), width: 200, height: 40, font_size: 10 },
		{ type: "Long Text", icon: "align-left", label: __("Long Text"), width: 200, height: 60, font_size: 10 },
		{ type: "Barcode", icon: "barcode", label: __("Barcode"), width: 180, height: 48, font_size: 10 },
		{ type: "QR Code", icon: "tag", label: __("QR Code"), width: 90, height: 90, font_size: 10 },
		{ type: "Image", icon: "image", label: __("Image"), width: 120, height: 120, font_size: 10 },
		{ type: "Signature", icon: "edit", label: __("Signature"), width: 180, height: 60, font_size: 10 },
	];

	const MIN_WIDTH_PT = 20;
	const MIN_HEIGHT_PT = 12;

	const PAGE_ROLES = ["Once", "First", "Loop", "Last"];
	const ROW_GAP_PT = 4;
	const TEXT_FONTS = ["Helvetica", "Times", "Courier"];
	const TEXT_ALIGNS = ["left", "center", "right"];
	const NO_TEXT_STYLE = ["Check", "Select", "Barcode", "QR Code", "Image", "Signature"];

	const MAX_UNDO = 80;
	const UNDO_COALESCE_MS = 500;

	let pageInstance = null;
	let dragState = null;
	let skipOverlayClick = false;
	let undoStack = [];
	let redoStack = [];
	let applyingHistory = false;

	let state = {
		templateName: null,
		sampleValues: null,
		sampleDoc: "",
		title: "",
		reference_doctype: "",
		pages: [],
		fields: [],
		reference_fields: [],
		source_types: ["Field Path", "Jinja Template", "Jinja Script"],
		date_formats: ["", "%d-%m-%Y", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"],
		currentPage: 0,
		selectedId: null,
		selectedIds: [],
		selectionAnchor: null,
		dirty: false,
		scale: 1,
		fieldCounter: 1,
		fieldFilter: "",
		refView: "fields",
		collapsedSections: {
			fieldTypes: false,
			referenceFields: false,
			childTables: false,
		},
		expandedGroups: {},
		page_roles: {},
		always_print_last: 0,
		child_tables: [],
	};

	function getTemplateName() {
		const route = frappe.get_route();
		if (route[0] !== "pdf-field-designer") return null;

		let name = null;
		if (route[1] && typeof route[1] === "string") {
			name = route[1];
		} else if (route[1] && typeof route[1] === "object" && route[1].name) {
			name = route[1].name;
		} else if (frappe.route_options && frappe.route_options.template) {
			name = frappe.route_options.template;
		}

		if (!name) return null;
		try {
			return decodeURIComponent(name);
		} catch (e) {
			return name;
		}
	}

	function getAppEl() {
		return document.getElementById("pdffiller-designer-app");
	}

	function getSelectedField() {
		return state.fields.find((field) => field.id === state.selectedId) || null;
	}

	function getCurrentPage() {
		return state.pages[state.currentPage] || null;
	}

	function getPageFields(pageNo) {
		return state.fields.filter((field) => field.page === pageNo);
	}

	function multiSelect() {
		const api = window.pdffiller && pdffiller.multi_select;
		return api && typeof api.preparePaste === "function" ? api : null;
	}

	function clipboardReady() {
		const api = multiSelect();
		return Boolean(api && typeof api.hasClipboard === "function" && api.hasClipboard());
	}

	function groupMembers(id) {
		const field = state.fields.find((item) => item.id === id);
		if (!field) return [];
		const groupId = multiSelect()?.cleanGroupId(field.group_id);
		if (!groupId) return [field.id];
		return state.fields
			.filter((item) => item.page === field.page && multiSelect().cleanGroupId(item.group_id) === groupId)
			.map((item) => item.id);
	}

	function currentSelection() {
		const valid = new Set(getPageFields(state.currentPage).map((field) => field.id));
		const ids = (state.selectedIds || []).filter((id) => valid.has(id));
		if (state.selectedId && valid.has(state.selectedId) && !ids.includes(state.selectedId)) {
			ids.push(state.selectedId);
		}
		return ids;
	}

	function commitSelection(ids, primary) {
		const unique = multiSelect() ? multiSelect().unique(ids) : [...new Set((ids || []).filter(Boolean))];
		state.selectedIds = unique;
		state.selectedId = primary && unique.includes(primary) ? primary : unique[unique.length - 1] || null;
	}

	function clearSelection() {
		commitSelection([], null);
		state.selectionAnchor = null;
	}

	function selectWithPointer(id, event, fromLayout) {
		const api = multiSelect();
		if (!api || !event) {
			commitSelection(groupMembers(id), id);
			state.selectionAnchor = id;
			return;
		}
		const ordered = fromLayout
			? [...document.querySelectorAll(".pfd-ref-body .pfd-layout-item")].map((item) => item.dataset.objectId)
			: getPageFields(state.currentPage).map((field) => field.id);
		const modifier = event.ctrlKey || event.metaKey;
		const result = api.applySelection({
			ids: currentSelection(),
			targetId: id,
			toggle: modifier,
			extend: event.shiftKey,
			range: Boolean(fromLayout && event.shiftKey),
			orderedIds: ordered,
			anchorId: state.selectionAnchor,
			keepIfSelected: !fromLayout && !event.shiftKey && !modifier,
			groupOf: groupMembers,
		});
		state.selectionAnchor = result.anchorId;
		commitSelection(result.ids, id);
	}

	function selectedObjects() {
		const ids = new Set(currentSelection());
		return getPageFields(state.currentPage).filter((field) => ids.has(field.id));
	}

	function applyObjectMove(starts, dx, dy) {
		const api = multiSelect();
		const page = getCurrentPage();
		if (!api || !page) return { dx: 0, dy: 0 };
		const moving = new Set(starts.map((item) => item.id));
		const others = getPageFields(state.currentPage).filter((field) => !moving.has(field.id));
		const fitted = api.fitDelta(starts, dx, dy, page.width_pt, page.height_pt, others);
		starts.forEach((start) => {
			const field = state.fields.find((item) => item.id === start.id);
			if (!field) return;
			field.x = start.x + fitted.dx;
			field.y = start.y + fitted.dy;
		});
		return fitted;
	}

	function resizeOverlaps(proposed, original, fieldId) {
		const api = multiSelect();
		if (!api) return false;
		const others = getPageFields(state.currentPage).filter((field) => field.id !== fieldId);
		const blockers = others.filter((field) => !api.intersects(api.bounds(original), api.bounds(field)));
		return blockers.some((field) => api.intersects(api.bounds(proposed), api.bounds(field)));
	}

	function renderSelectionBox() {
		const api = multiSelect();
		const objects = selectedObjects();
		if (!api || objects.length < 2) return "";
		const box = api.union(objects);
		if (!box) return "";
		return `<div class="pfd-selection-box" data-selection-box="1" style="left:${ptToPx(box.x)}px;top:${ptToPx(
			box.y
		)}px;width:${ptToPx(box.width)}px;height:${ptToPx(box.height)}px;"></div>`;
	}

	function renderSelectionActions() {
		const ids = currentSelection();
		const objects = selectedObjects();
		const grouped = objects.some((field) => multiSelect()?.cleanGroupId(field.group_id));
		const canPaste = clipboardReady();
		if (!ids.length && !canPaste) return "";
		const groupBtn =
			ids.length >= 2
				? `<button type="button" class="btn btn-default btn-sm pfd-group-btn">${__("Group")}</button>`
				: "";
		const ungroupBtn = grouped
			? `<button type="button" class="btn btn-default btn-sm pfd-ungroup-btn">${__("Ungroup")}</button>`
			: "";
		const copyBtn = ids.length
			? `<button type="button" class="btn btn-default btn-sm pfd-copy-btn">${__("Copy")}</button>`
			: "";
		const pasteBtn = `<button type="button" class="btn btn-default btn-sm pfd-paste-btn" ${
			canPaste ? "" : "disabled"
		}>${__("Paste")}</button>`;
		const title =
			ids.length > 1 || grouped
				? `<div class="pfd-panel-title">${__("{0} selected", [String(ids.length)])}</div>`
				: "";
		return `<div class="pfd-prop-section pfd-multi-bar">
			${title}
			<div class="pfd-multi-actions">${copyBtn}${pasteBtn}${groupBtn}${ungroupBtn}</div>
		</div>`;
	}

	function groupSelection() {
		const api = multiSelect();
		const ids = currentSelection();
		if (!api || ids.length < 2) return;
		pushUndo("group");
		const groupId = api.newGroupId();
		state.fields.forEach((field) => {
			if (ids.includes(field.id)) field.group_id = groupId;
		});
		markDirty();
		render();
	}

	function ungroupSelection() {
		const api = multiSelect();
		const ids = new Set(currentSelection());
		const groupIds = new Set(
			state.fields
				.filter((field) => ids.has(field.id) && api?.cleanGroupId(field.group_id))
				.map((field) => api.cleanGroupId(field.group_id))
		);
		if (!groupIds.size) return;
		pushUndo("ungroup");
		state.fields.forEach((field) => {
			if (groupIds.has(api.cleanGroupId(field.group_id))) field.group_id = "";
		});
		markDirty();
		render();
	}

	function nudgeSelection(dx, dy) {
		const objects = selectedObjects();
		if (!objects.length || (!dx && !dy)) return;
		const starts = objects.map((field) => ({
			id: field.id,
			x: field.x,
			y: field.y,
			width: field.width,
			height: field.height,
		}));
		const fitted = applyObjectMove(starts, dx, dy);
		if (!fitted.dx && !fitted.dy) return;
		objects.forEach((field) => {
			const start = starts.find((item) => item.id === field.id);
			field.x = start.x;
			field.y = start.y;
		});
		pushUndo("nudge", { coalesce: true });
		applyObjectMove(starts, dx, dy);
		markDirty();
		renderCanvasContainer();
		renderPropertiesPanel();
	}

	function copySelection() {
		const api = multiSelect();
		const objects = selectedObjects();
		if (!api || !objects.length) {
			frappe.show_alert({ message: __("Select an object to copy"), indicator: "orange" });
			return;
		}
		api.writeClipboard({
			source: {
				editor: "field",
				document: state.templateName || "",
				reference_doctype: state.reference_doctype || "",
				page: state.currentPage,
			},
			objects: objects.map((field) => ({ ...field, kind: "field" })),
		});
		frappe.show_alert({
			message: __("Copied {0} object(s)", [String(objects.length)]),
			indicator: "green",
		});
		renderPropertiesPanel();
	}

	function pasteClipboard() {
		const api = multiSelect();
		const clip = api && api.readClipboard();
		const page = getCurrentPage();
		if (!api || !clip || !page) {
			frappe.show_alert({ message: __("Nothing to paste"), indicator: "orange" });
			return;
		}
		const source = clip.source || {};
		const prepared = api.preparePaste(clip, {
			editor: "field",
			pageIndex: state.currentPage,
			pageWidth: page.width_pt,
			pageHeight: page.height_pt,
			obstacles: getPageFields(state.currentPage),
			existingNames: state.fields.map((field) => field.field_name),
			referenceFields: state.reference_fields,
			childTables: state.child_tables,
			sameDocument: source.editor === "field" && source.document === state.templateName,
			samePage: source.editor === "field" && source.document === state.templateName && source.page === state.currentPage,
		});
		if (!prepared.objects.length) {
			frappe.show_alert({
				message: __("Those objects cannot be pasted as form fields"),
				indicator: "orange",
			});
			return;
		}
		pushUndo("paste");
		const ids = [];
		prepared.objects.forEach((obj) => {
			const field = normalizeLoadedField({ ...obj, id: nextFieldId(), page: state.currentPage });
			delete field.kind;
			state.fields.push(field);
			ids.push(field.id);
		});
		commitSelection(ids, ids[ids.length - 1]);
		state.selectionAnchor = ids[0] || null;
		markDirty();
		render();
		reportPaste(prepared);
	}

	function reportPaste(prepared) {
		if (prepared.cleared.length) {
			frappe.show_alert({
				message: __(
					"Pasted {0} object(s). Cleared mappings that are not on this document: {1}",
					[String(prepared.objects.length), prepared.cleared.join(", ")]
				),
				indicator: "orange",
			});
		} else {
			frappe.show_alert({
				message: __("Pasted {0} object(s)", [String(prepared.objects.length)]),
				indicator: "green",
			});
		}
		if (prepared.skipped) {
			frappe.show_alert({
				message: __("{0} object(s) were skipped because this page only accepts fields", [
					String(prepared.skipped),
				]),
				indicator: "orange",
			});
		}
	}

	function openClipboardMenu(x, y) {
		const api = multiSelect();
		if (!api) return;
		api.openContextMenu(x, y, [
			{
				action: "copy",
				label: __("Copy"),
				shortcut: "Ctrl+C",
				disabled: !currentSelection().length,
				onSelect: copySelection,
			},
			{
				action: "paste",
				label: __("Paste"),
				shortcut: "Ctrl+V",
				disabled: !clipboardReady(),
				onSelect: pasteClipboard,
			},
		]);
	}

	function selectForClipboard(id, fromLayout) {
		if (!id || currentSelection().includes(id)) return;
		selectWithPointer(id, { ctrlKey: false, metaKey: false, shiftKey: false }, fromLayout);
		renderCanvasContainer();
		renderPropertiesPanel();
		highlightIds(currentSelection());
	}

	function getScale() {
		const page = getCurrentPage();
		const wrap = document.querySelector(".pfd-canvas-wrap");
		if (!page || !wrap) return 1;
		return wrap.clientWidth / page.width_pt;
	}

	function ptToPx(pt) {
		return pt * state.scale;
	}

	function pxToPt(px) {
		return px / state.scale;
	}

	function nextFieldId() {
		state.fieldCounter += 1;
		return `fld_${Date.now()}_${state.fieldCounter}`;
	}

	function fieldNamePrefix(type) {
		const map = {
			Check: "check",
			Select: "select",
			Date: "date",
			Link: "link",
			Int: "int",
			Float: "float",
			Currency: "amount",
			"Small Text": "text",
			"Long Text": "notes",
			Barcode: "barcode",
			Image: "image",
		};
		return map[type] || "field";
	}

	function nextFieldName(type) {
		const prefix = fieldNamePrefix(type);
		let index = state.fieldCounter;
		let name = `${prefix}_${index}`;
		const existing = new Set(state.fields.map((field) => field.field_name));
		while (existing.has(name)) {
			index += 1;
			name = `${prefix}_${index}`;
		}
		state.fieldCounter = index + 1;
		return name;
	}

	function defaultMappingForType(type, spec) {
		return {
			source_type: "Field Path",
			source_field: "",
			jinja_script: "",
			default_value: "",
			date_format: spec?.date_format || (type === "Date" ? "%d-%m-%Y" : ""),
			editable: 0,
			options: spec?.options || "",
			repeat_table: "",
			repeat_field: "",
			repeat_slot: 0,
		};
	}

	function defaultWordWrap(typeOrKind) {
		return typeOrKind === "Small Text" || typeOrKind === "Long Text" || typeOrKind === "text" ? 1 : 0;
	}

	function normalizeStyleFields(source, typeOrKind) {
		const family = TEXT_FONTS.includes(source.font_family) ? source.font_family : "Helvetica";
		const align = TEXT_ALIGNS.includes(source.align) ? source.align : "left";
		const color = /^#[0-9a-fA-F]{6}$/.test(source.color || "") ? source.color : "#000000";
		const hasWrap = source.word_wrap !== undefined && source.word_wrap !== null && source.word_wrap !== "";
		return {
			font_family: family,
			bold: source.bold ? 1 : 0,
			italic: source.italic ? 1 : 0,
			color,
			align,
			word_wrap: hasWrap ? (source.word_wrap ? 1 : 0) : defaultWordWrap(typeOrKind),
		};
	}

	function previewFontFamily(family) {
		if (family === "Times") return "Times, 'Times New Roman', serif";
		if (family === "Courier") return "'Courier New', Courier, monospace";
		return "Helvetica, Arial, sans-serif";
	}

	function textPreviewCss(item) {
		const wrap = item.word_wrap ? "normal" : "nowrap";
		return [
			`font-family:${previewFontFamily(item.font_family)}`,
			`font-weight:${item.bold ? 700 : 400}`,
			`font-style:${item.italic ? "italic" : "normal"}`,
			`color:${item.color || "#000000"}`,
			`text-align:${item.align || "left"}`,
			`font-size:${ptToPx(item.font_size || 10)}px`,
			`white-space:${wrap}`,
			"overflow:hidden",
			item.word_wrap ? "text-overflow:clip" : "text-overflow:ellipsis",
			"display:block",
		].join(";");
	}

	function renderTextStyleControls(item) {
		const familyOptions = TEXT_FONTS.map(
			(name) =>
				`<option value="${name}" ${item.font_family === name ? "selected" : ""}>${__(name)}</option>`
		).join("");
		const alignOptions = [
			["left", __("Left")],
			["center", __("Center")],
			["right", __("Right")],
		]
			.map(
				([value, label]) =>
					`<option value="${value}" ${(item.align || "left") === value ? "selected" : ""}>${label}</option>`
			)
			.join("");
		return `
			<div class="pfd-form-group">
				<label>${__("Font")}</label>
				<select class="pfd-prop-font-family">${familyOptions}</select>
			</div>
			<div class="pfd-form-row">
				<div class="pfd-form-group pfd-checkbox-group">
					<label>
						<input type="checkbox" class="pfd-prop-bold" ${item.bold ? "checked" : ""} />
						${__("Bold")}
					</label>
				</div>
				<div class="pfd-form-group pfd-checkbox-group">
					<label>
						<input type="checkbox" class="pfd-prop-italic" ${item.italic ? "checked" : ""} />
						${__("Italic")}
					</label>
				</div>
			</div>
			<div class="pfd-form-group">
				<label>${__("Font Size")}</label>
				<input type="number" class="pfd-prop-font" min="6" max="72" value="${item.font_size || 10}" />
			</div>
			<div class="pfd-form-group">
				<label>${__("Color")}</label>
				<div class="pfd-color-row">
					<input type="color" class="pfd-prop-text-color" value="${frappe.utils.escape_html(item.color || "#000000")}" />
					<input type="text" class="pfd-prop-text-color-hex" value="${frappe.utils.escape_html(item.color || "#000000")}" />
				</div>
			</div>
			<div class="pfd-form-group">
				<label>${__("Alignment")}</label>
				<select class="pfd-prop-align">${alignOptions}</select>
			</div>
			<div class="pfd-form-group pfd-checkbox-group">
				<label>
					<input type="checkbox" class="pfd-prop-word-wrap" ${item.word_wrap ? "checked" : ""} />
					${__("Word wrap")}
				</label>
			</div>
		`;
	}

	function bindTextStyleEvents(panel, update) {
		panel.querySelector(".pfd-prop-font-family")?.addEventListener("change", (e) => {
			update({ font_family: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-bold")?.addEventListener("change", (e) => {
			update({ bold: e.target.checked ? 1 : 0 }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-italic")?.addEventListener("change", (e) => {
			update({ italic: e.target.checked ? 1 : 0 }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-font")?.addEventListener("input", (e) => {
			update({ font_size: parseFloat(e.target.value) || 10 }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-text-color")?.addEventListener("input", (e) => {
			const hex = panel.querySelector(".pfd-prop-text-color-hex");
			if (hex) hex.value = e.target.value;
			update({ color: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-text-color-hex")?.addEventListener("change", (e) => {
			let value = (e.target.value || "").trim();
			if (value && !value.startsWith("#")) value = `#${value}`;
			update({ color: value }, { refreshCanvas: true, refreshProperties: true });
		});
		panel.querySelector(".pfd-prop-align")?.addEventListener("change", (e) => {
			update({ align: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-word-wrap")?.addEventListener("change", (e) => {
			update({ word_wrap: e.target.checked ? 1 : 0 }, { refreshCanvas: true });
		});
	}

	function normalizeLoadedField(field) {
		const aliases = { Text: "Data", Checkbox: "Check" };
		const field_type = aliases[field.field_type] || field.field_type || "Data";
		const normalized = {
			source_type: field.source_type || "Field Path",
			source_field: field.source_field || "",
			jinja_script: field.jinja_script || "",
			default_value: field.default_value || "",
			date_format: field.date_format || "",
			editable: field.editable ? 1 : 0,
			options: field.options || "",
			repeat_table: field.repeat_table || "",
			repeat_field: field.repeat_field || "",
			repeat_slot: Number(field.repeat_slot || 0),
			...field,
			field_type,
			id: field.id || nextFieldId(),
		};
		return { ...normalized, ...normalizeStyleFields(normalized, field_type) };
	}

	function markDirty() {
		state.dirty = true;
	}

	function cloneUndoableState() {
		return {
			fields: state.fields.map((field) => ({ ...field })),
			selectedId: state.selectedId,
			selectedIds: [...(state.selectedIds || [])],
			selectionAnchor: state.selectionAnchor,
			currentPage: state.currentPage,
			page_roles: { ...(state.page_roles || {}) },
			always_print_last: state.always_print_last,
			fieldCounter: state.fieldCounter,
			dirty: state.dirty,
		};
	}

	function restoreUndoableState(snapshot) {
		state.fields = (snapshot.fields || []).map((field) => ({ ...field }));
		state.selectedId = snapshot.selectedId;
		state.selectedIds = [...(snapshot.selectedIds || (snapshot.selectedId ? [snapshot.selectedId] : []))];
		state.selectionAnchor = snapshot.selectionAnchor || snapshot.selectedId || null;
		state.currentPage = snapshot.currentPage;
		state.page_roles = { ...(snapshot.page_roles || {}) };
		state.always_print_last = snapshot.always_print_last;
		state.fieldCounter = snapshot.fieldCounter;
		state.dirty = snapshot.dirty;
	}

	function clearHistory() {
		undoStack = [];
		redoStack = [];
	}

	function pushUndo(label, { coalesce = false } = {}) {
		if (applyingHistory) return;
		const now = Date.now();
		const last = undoStack[undoStack.length - 1];
		if (coalesce && last && last.label === label && now - last.time < UNDO_COALESCE_MS) {
			last.time = now;
			return;
		}
		undoStack.push({
			label,
			time: now,
			snapshot: cloneUndoableState(),
		});
		if (undoStack.length > MAX_UNDO) {
			undoStack.shift();
		}
		redoStack = [];
	}

	function undo() {
		if (!undoStack.length) return;
		const entry = undoStack.pop();
		redoStack.push({
			label: entry.label,
			time: Date.now(),
			snapshot: cloneUndoableState(),
		});
		applyingHistory = true;
		restoreUndoableState(entry.snapshot);
		applyingHistory = false;
		render();
	}

	function redo() {
		if (!redoStack.length) return;
		const entry = redoStack.pop();
		undoStack.push({
			label: entry.label,
			time: Date.now(),
			snapshot: cloneUndoableState(),
		});
		applyingHistory = true;
		restoreUndoableState(entry.snapshot);
		applyingHistory = false;
		render();
	}

	function isDesignerActive() {
		const route = frappe.get_route();
		if (!Array.isArray(route) || route[0] !== "pdf-field-designer") return false;
		return Boolean(getAppEl());
	}

	function isTypingTarget(target) {
		if (!target) return false;
		const tag = (target.tagName || "").toUpperCase();
		if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return true;
		if (target.isContentEditable) return true;
		if (typeof target.closest === "function" && target.closest(".modal")) return true;
		return false;
	}

	function loadContext(templateName) {
		return frappe.call({
			method: "pdffiller.api.designer.get_design_context",
			args: { template: templateName },
			freeze: true,
			freeze_message: __("Loading designer…"),
			callback(r) {
				const data = r.message;
				if (!data) {
					showMessage(__("Could not load the PDF template."));
					return;
				}
				state.templateName = data.template;
				state.title = data.title;
				state.reference_doctype = data.reference_doctype;
				state.pages = data.pages || [];
				state.reference_fields = data.reference_fields || [];
				state.source_types = data.source_types || state.source_types;
				state.date_formats = data.date_formats || state.date_formats;
				state.child_tables = data.child_tables || [];
				state.expandedGroups = {};
				state.page_roles = data.page_roles || {};
				state.always_print_last = data.always_print_last ? 1 : 0;
				state.fields = (data.fields || []).map(normalizeLoadedField);
				state.currentPage = 0;
				clearSelection();
				state.dirty = false;
				clearHistory();
				if (pageInstance) {
					pageInstance.set_title(state.title || __("PDF Field Designer"));
				}
				refreshAIStatus();
				render();
			},
			error() {
				showMessage(__("Failed to load the PDF designer."));
			},
		});
	}

	function showMessage(message) {
		const app = getAppEl();
		if (!app) return;
		app.innerHTML = `<div class="pfd-loading">${frappe.utils.escape_html(message)}</div>`;
	}

	function saveDesign() {
		if (!state.templateName) return;

		const invalid = state.fields.find((field) => !field.field_name || !field.field_name.trim());
		if (invalid) {
			frappe.msgprint({
				title: __("Invalid Field"),
				message: __("Every field must have a name."),
				indicator: "orange",
			});
			return;
		}

		const names = state.fields.map((field) => field.field_name.trim());
		if (new Set(names).size !== names.length) {
			frappe.msgprint({
				title: __("Duplicate Names"),
				message: __("Field names must be unique."),
				indicator: "orange",
			});
			return;
		}

		const payload = getFieldsPayload();

		frappe.call({
			method: "pdffiller.api.designer.save_design",
			args: {
				template: state.templateName,
				fields: JSON.stringify(payload),
				page_roles: JSON.stringify(state.page_roles || {}),
				always_print_last: state.always_print_last ? 1 : 0,
			},
			freeze: true,
			freeze_message: __("Saving design…"),
			callback(r) {
				const result = r.message || {};
				state.dirty = false;
				frappe.show_alert({
					message: __("Design saved ({0} field(s))", [result.field_names?.length || 0]),
					indicator: "green",
				});
				if (state.reference_doctype && pdffiller.forms && pdffiller.forms.clear_cache) {
					pdffiller.forms.clear_cache(state.reference_doctype);
				}
				// Reload from disk so the canvas matches what print will use.
				loadContext(state.templateName);
			},
		});
	}

	function round(value) {
		return Math.round(value * 100) / 100;
	}

	function getFieldsPayload() {
		return state.fields.map((field) => ({
			field_name: field.field_name.trim(),
			field_type: field.field_type,
			page: field.page,
			x: round(field.x),
			y: round(field.y),
			width: round(field.width),
			height: round(field.height),
			font_size: field.font_size || 10,
			font_family: field.font_family || "Helvetica",
			bold: field.bold ? 1 : 0,
			italic: field.italic ? 1 : 0,
			color: field.color || "#000000",
			align: field.align || "left",
			word_wrap: field.word_wrap ? 1 : 0,
			source_type: field.source_type || "Field Path",
			source_field: field.source_field || "",
			jinja_script: field.jinja_script || "",
			default_value: field.default_value || "",
			date_format: field.date_format || "",
			editable: field.editable ? 1 : 0,
			options: field.options || "",
			text_maxlen: field.text_maxlen || 0,
			comb: field.comb ? 1 : 0,
			repeat_table: field.repeat_table || "",
			repeat_field: field.repeat_field || "",
			repeat_slot: Number(field.repeat_slot || 0),
			...(multiSelect()?.cleanGroupId(field.group_id)
				? { group_id: multiSelect().cleanGroupId(field.group_id) }
				: {}),
		}));
	}

	function applyAISuggestions(suggestions) {
		if (!suggestions?.length) return;
		const applicable = suggestions.filter((suggestion) =>
			state.fields.some((item) => item.field_name === suggestion.pdf_field_name)
		);
		if (!applicable.length) {
			frappe.show_alert({ message: __("No matching fields to update."), indicator: "orange" });
			return;
		}
		pushUndo("ai-suggestions");
		for (const suggestion of applicable) {
			const field = state.fields.find((item) => item.field_name === suggestion.pdf_field_name);
			if (!field) continue;
			Object.assign(field, {
				source_type: suggestion.source_type || "Field Path",
				source_field: suggestion.source_field || "",
				jinja_script: suggestion.jinja_script || "",
			});
		}
		markDirty();
		render();
		frappe.show_alert({
			message: __("{0} mapping(s) applied", [applicable.length]),
			indicator: "green",
		});
	}

	function openAIAssist() {
		if (!pdffiller.designer.ai) return;
		pdffiller.designer.ai.open({
			templateName: state.templateName,
			referenceDoctype: state.reference_doctype,
			getFields: getFieldsPayload,
			applySuggestions: applyAISuggestions,
		});
	}

	let aiEnabled = false;

	function refreshAIStatus() {
		if (!pdffiller.designer.ai) return;
		if (pdffiller.designer.ai.isEnabled()) {
			aiEnabled = true;
			return;
		}
		pdffiller.designer.ai.refreshStatus((enabled) => {
			aiEnabled = enabled;
			const btn = document.querySelector(".pfd-ai-btn");
			if (btn) {
				btn.classList.toggle("hidden", !enabled);
			} else if (enabled && state.templateName) {
				render();
			}
		});
	}

	function deleteSelectedField() {
		const ids = new Set(currentSelection());
		if (!ids.size) return;
		pushUndo("delete-field");
		state.fields = state.fields.filter((field) => !ids.has(field.id));
		clearSelection();
		markDirty();
		render();
	}

	function addField(type, x, y, mappingOverrides = {}) {
		const spec = FIELD_TYPES.find((item) => item.type === type) || FIELD_TYPES[0];
		const page = getCurrentPage();
		if (!page) return;

		const width = spec.width;
		const height = spec.height;
		const maxX = Math.max(0, page.width_pt - width);
		const maxY = Math.max(0, page.height_pt - height);

		pushUndo("add-field");
		const field = {
			id: nextFieldId(),
			field_name: nextFieldName(type),
			field_type: type,
			page: state.currentPage,
			x: clamp(x, 0, maxX),
			y: clamp(y, 0, maxY),
			width,
			height,
			font_size: spec.font_size,
			...normalizeStyleFields({}, type),
			...defaultMappingForType(type, spec),
			...mappingOverrides,
		};

		state.fields.push(field);
		commitSelection([field.id], field.id);
		markDirty();
		render();
	}

	function mapReferenceField(refField) {
		const selected = getSelectedField();
		if (selected) {
			updateSelectedField(
				{
					source_type: "Field Path",
					source_field: refField.fieldname,
					field_type: mapFrappeFieldtype(refField.fieldtype, selected.field_type),
				},
				{ refreshCanvas: true }
			);
			return;
		}
		addField(mapFrappeFieldtype(refField.fieldtype, "Data"), 72, 72, {
			source_type: "Field Path",
			source_field: refField.fieldname,
			field_name: refField.fieldname.replace(/[^A-Za-z0-9_]/g, "_"),
		});
	}

	function mapFrappeFieldtype(fieldtype, fallback) {
		const supported = new Set(FIELD_TYPES.map((item) => item.type));
		if (supported.has(fieldtype)) return fieldtype;
		const map = {
			Data: "Data",
			Link: "Link",
			"Dynamic Link": "Link",
			Date: "Date",
			Datetime: "Date",
			Int: "Int",
			Float: "Float",
			Currency: "Currency",
			Check: "Check",
			Select: "Select",
			"Small Text": "Small Text",
			Text: "Long Text",
			"Text Editor": "Long Text",
			"Long Text": "Long Text",
			Barcode: "Barcode",
			Image: "Image",
			"Attach Image": "Image",
			Attach: "Image",
		};
		return map[fieldtype] || fallback || "Data";
	}

	function getPageRole(pageNo) {
		const roles = state.page_roles || {};
		return roles[pageNo] || roles[String(pageNo)] || "Once";
	}

	function setPageRole(pageNo, role) {
		state.page_roles = state.page_roles || {};
		pushUndo(`page-role:${pageNo}`, { coalesce: true });
		state.page_roles[pageNo] = role;
		state.page_roles[String(pageNo)] = role;
		markDirty();
	}

	function mapChildField(tableField, childField) {
		const selected = getSelectedField();
		const updates = {
			source_type: "Field Path",
			source_field: childField.fieldname,
			repeat_table: tableField.fieldname,
			repeat_field: childField.fieldname,
			repeat_slot: selected ? Number(selected.repeat_slot || 0) : 0,
			field_type: mapFrappeFieldtype(childField.fieldtype, selected?.field_type || "Data"),
		};
		if (selected) {
			updateSelectedField(updates, { refreshCanvas: true, refreshProperties: true });
			return;
		}
		addField(updates.field_type, 72, 72, {
			...updates,
			field_name: `${tableField.fieldname}_${childField.fieldname}`.replace(/[^A-Za-z0-9_]/g, "_"),
		});
	}

	function currentRepeatSlotCount(tableName, pageNo) {
		const slots = state.fields
			.filter(
				(field) =>
					field.page === pageNo &&
					field.repeat_table === tableName &&
					field.repeat_table
			)
			.map((field) => Number(field.repeat_slot || 0));
		if (!slots.length) return 0;
		return Math.max(...slots) + 1;
	}

	function tileRepeatRows(rowsPerPage) {
		const selected = getSelectedField();
		if (!selected || !selected.repeat_table) {
			frappe.msgprint({
				title: __("Repeating row"),
				message: __("Select a field mapped to a child table first."),
				indicator: "orange",
			});
			return;
		}

		const page = getCurrentPage();
		if (!page) return;
		const table = selected.repeat_table;
		const pageNo = state.currentPage;
		let prototypes = state.fields.filter(
			(field) =>
				field.page === pageNo &&
				field.repeat_table === table &&
				Number(field.repeat_slot || 0) === 0
		);
		const usingSelectedAsPrototype = !prototypes.length;
		if (usingSelectedAsPrototype) {
			prototypes = [selected];
		}

		const count = Math.max(1, parseInt(rowsPerPage, 10) || 1);
		const minY = Math.min(...prototypes.map((field) => field.y));
		const maxBottom = Math.max(...prototypes.map((field) => field.y + field.height));
		const rowHeight = maxBottom - minY + ROW_GAP_PT;
		const lastBottom = minY + rowHeight * count - ROW_GAP_PT;
		if (lastBottom > page.height_pt) {
			frappe.msgprint({
				title: __("Not enough space"),
				message: __("Those rows do not fit on this page. Use fewer rows or a Loop page."),
				indicator: "orange",
			});
			return;
		}

		pushUndo("tile-repeat-rows");
		if (usingSelectedAsPrototype) {
			selected.repeat_slot = 0;
		}

		state.fields = state.fields.filter(
			(field) =>
				!(
					field.page === pageNo &&
					field.repeat_table === table &&
					Number(field.repeat_slot || 0) >= count
				)
		);

		const existingSlots = new Set(
			state.fields
				.filter((field) => field.page === pageNo && field.repeat_table === table)
				.map((field) => Number(field.repeat_slot || 0))
		);

		for (let slot = 1; slot < count; slot += 1) {
			if (existingSlots.has(slot)) continue;
			prototypes.forEach((proto) => {
				const clone = {
					...proto,
					id: nextFieldId(),
					field_name: nextFieldName(proto.field_type),
					y: proto.y + slot * rowHeight,
					repeat_slot: slot,
					repeat_table: table,
					repeat_field: proto.repeat_field || proto.source_field || "",
					group_id: "",
				};
				state.fields.push(clone);
			});
		}

		markDirty();
		render();
	}

	function loadSampleDocument() {
		if (!state.reference_doctype || !state.templateName) return;
		if (state.sampleDoc) {
			state.sampleValues = null;
			state.sampleDoc = "";
			render();
			return;
		}
		const dialog = new frappe.ui.Dialog({
			title: __("Sample document"),
			fields: [
				{
					fieldtype: "Link",
					options: state.reference_doctype,
					fieldname: "name",
					label: __("Document"),
					reqd: 1,
				},
			],
			primary_action_label: __("Show values"),
			primary_action(values) {
				dialog.hide();
				frappe.call({
					method: "pdffiller.api.forms.get_sample_values",
					args: {
						template: state.templateName,
						doctype: state.reference_doctype,
						name: values.name,
						fields: JSON.stringify(getFieldsPayload()),
						source: "form_template",
					},
					freeze: true,
					callback(r) {
						const data = r.message || {};
						state.sampleValues = data.values || {};
						state.sampleDoc = values.name;
						if (data.warnings && data.warnings.length) {
							frappe.msgprint({
								title: __("Some values could not be filled"),
								indicator: "orange",
								message: data.warnings
									.map(
										(warning) =>
											`${frappe.utils.escape_html(warning.field || "")}: ${frappe.utils.escape_html(
												warning.message || ""
											)}`
									)
									.join("<br>"),
							});
						}
						render();
					},
				});
			},
		});
		dialog.show();
	}

	function previewWithDocument() {
		if (!state.reference_doctype || !state.templateName) return;
		if (state.dirty) {
			frappe.msgprint({
				title: __("Save first"),
				message: __("Save the design before previewing a document."),
				indicator: "orange",
			});
			return;
		}

		const dialog = new frappe.ui.Dialog({
			title: __("Preview with document"),
			fields: [
				{
					fieldtype: "Link",
					options: state.reference_doctype,
					fieldname: "name",
					label: __("Document"),
					reqd: 1,
				},
			],
			primary_action_label: __("Preview"),
			primary_action(values) {
				dialog.hide();
				frappe.call({
					method: "pdffiller.api.forms.get_filled_pdf",
					args: {
						template: state.templateName,
						doctype: state.reference_doctype,
						name: values.name,
					},
					freeze: true,
					freeze_message: __("Building preview…"),
					callback(r) {
						const uri = r.message && r.message.data_uri;
						if (!uri) return;
						const win = window.open("", "_blank");
						if (!win) return;
						win.document.write(
							`<!DOCTYPE html><title>${frappe.utils.escape_html(
								__("PDF Preview")
							)}</title><iframe src="${uri}" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>`
						);
					},
				});
			},
		});
		dialog.show();
	}

	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function updateSelectedField(updates, options = {}) {
		const field = getSelectedField();
		if (!field) return;
		pushUndo(`update:${field.id}:${Object.keys(updates).sort().join(",")}`, { coalesce: true });
		Object.assign(field, updates);
		markDirty();
		if (options.refreshCanvas) {
			renderCanvasContainer();
			if (state.refView === "layout") refreshRefBody();
		}
		if (options.refreshProperties) {
			renderPropertiesPanel();
		}
	}

	function filteredReferenceFields() {
		const q = (state.fieldFilter || "").trim().toLowerCase();
		if (!q) return state.reference_fields;
		return state.reference_fields.filter(
			(field) =>
				field.fieldname.toLowerCase().includes(q) ||
				(field.label || "").toLowerCase().includes(q) ||
				field.fieldtype.toLowerCase().includes(q)
		);
	}

	function renderCollapsibleSection(sectionId, title, bodyHtml) {
		const collapsed = state.collapsedSections[sectionId];
		return `
			<div class="pfd-collapsible-section${
				collapsed ? " pfd-collapsible-section--collapsed" : ""
			}" data-section="${sectionId}">
				<button type="button" class="pfd-panel-toggle" aria-expanded="${!collapsed}">
					<span class="pfd-panel-title">${title}</span>
					${frappe.utils.icon("down", "xs", "pfd-panel-toggle-icon")}
				</button>
				<div class="pfd-collapsible-body">
					${bodyHtml}
				</div>
			</div>
		`;
	}

	function renderPalette() {
		return FIELD_TYPES.map(
			(item) => `
			<div class="pfd-palette-item" draggable="true" data-type="${item.type}" title="${__(
				"Drag onto the PDF"
			)}">
				<span class="pfd-palette-item-icon">${frappe.utils.icon(item.icon, "sm")}</span>
				<span class="pfd-palette-item-label">${item.label}</span>
			</div>
		`
		).join("");
	}

	function filterQuery() {
		return (state.fieldFilter || "").trim().toLowerCase();
	}

	function renderGroup({ key, label, count, open, attrs, body }) {
		return `<div class="pfd-child-table${open ? " pfd-child-table--open" : ""}" data-group="${frappe.utils.escape_html(
			key
		)}" ${attrs || ""}>
			<button type="button" class="pfd-child-table-toggle" aria-expanded="${
				open ? "true" : "false"
			}" title="${__("Highlight matching objects on the page")}">
				${frappe.utils.icon("down", "xs", "", "", "pfd-child-table-chevron")}
				<span class="pfd-child-table-title">${frappe.utils.escape_html(label)}</span>
				<span class="pfd-child-table-count">${count}</span>
			</button>
			<div class="pfd-child-table-body">${body}</div>
		</div>`;
	}

	function renderChildFieldCard(table, field) {
		return `<div
			class="pfd-ref-field pfd-child-field"
			data-table="${frappe.utils.escape_html(table.fieldname)}"
			data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
			data-fieldtype="${frappe.utils.escape_html(field.fieldtype)}"
			title="${__("Click to map. Hover to highlight placed fields.")}"
		>
			<span class="pfd-ref-name">${frappe.utils.escape_html(field.label || field.fieldname)}</span>
			<span class="pfd-ref-meta">${frappe.utils.escape_html(table.fieldname)}.${frappe.utils.escape_html(
				field.fieldname
			)}</span>
		</div>`;
	}

	function renderChildTables() {
		if (!state.child_tables.length) {
			return `<div class="pfd-help-text">${__("No child tables on this DocType.")}</div>`;
		}
		const q = filterQuery();
		const html = state.child_tables
			.map((table) => {
				const visible = (table.fields || []).filter((field) => {
					if (!q) return true;
					return [table.fieldname, table.label, field.fieldname, field.label, field.fieldtype]
						.join(" ")
						.toLowerCase()
						.includes(q);
				});
				if (!visible.length) return "";
				const key = `child:${table.fieldname}`;
				return renderGroup({
					key,
					label: table.label || table.fieldname,
					count: visible.length,
					open: !!q || !!state.expandedGroups[key],
					attrs: `data-table="${frappe.utils.escape_html(table.fieldname)}"`,
					body: visible.map((field) => renderChildFieldCard(table, field)).join(""),
				});
			})
			.filter(Boolean)
			.join("");
		return html || `<div class="pfd-help-text">${__("No matching fields.")}</div>`;
	}

	function friendlyFieldLabel(field) {
		if (field.repeat_table) {
			const table = (state.child_tables || []).find((row) => row.fieldname === field.repeat_table);
			const col = ((table && table.fields) || []).find(
				(item) => item.fieldname === (field.repeat_field || field.source_field)
			);
			const name = (col && (col.label || col.fieldname)) || field.field_name || __("Field");
			return `${name} · ${__("Row {0}", [Number(field.repeat_slot || 0) + 1])}`;
		}
		const ref = (state.reference_fields || []).find((row) => row.fieldname === field.source_field);
		return (ref && (ref.label || ref.fieldname)) || field.field_name || __("Field");
	}

	function layoutItemFromField(field) {
		const mapping = field.repeat_table
			? `${field.repeat_table}[${Number(field.repeat_slot || 0)}].${
					field.repeat_field || field.source_field || ""
			  }`
			: field.source_field || __("Unmapped");
		return {
			id: field.id,
			label: friendlyFieldLabel(field),
			meta: `${field.field_type || "Data"} · ${mapping}`,
			grouped: multiSelect()?.cleanGroupId(field.group_id) ? 1 : 0,
		};
	}

	function layoutGroups() {
		const q = filterQuery();
		const objects = getPageFields(state.currentPage)
			.slice()
			.sort((a, b) => a.y - b.y || a.x - b.x);
		const groups = [];
		const pushGroup = (key, label, fields) => {
			const items = fields.map(layoutItemFromField).filter((item) => {
				if (!q) return true;
				if ((label || "").toLowerCase().includes(q)) return true;
				return item.label.toLowerCase().includes(q) || item.meta.toLowerCase().includes(q);
			});
			if (items.length) groups.push({ key, label, items });
		};
		pushGroup(
			"fields",
			__("Fields"),
			objects.filter((field) => !field.repeat_table)
		);
		const names = (state.child_tables || []).map((table) => table.fieldname);
		objects.forEach((field) => {
			if (field.repeat_table && !names.includes(field.repeat_table)) names.push(field.repeat_table);
		});
		names.forEach((name) => {
			const table = (state.child_tables || []).find((row) => row.fieldname === name);
			pushGroup(
				`table:${name}`,
				(table && (table.label || table.fieldname)) || name,
				objects.filter((field) => field.repeat_table === name)
			);
		});
		return groups;
	}

	function renderLayoutItem(item) {
		const selected = currentSelection().includes(item.id) ? " pfd-layout-item--selected" : "";
		const grouped = item.grouped ? " pfd-layout-item--grouped" : "";
		return `<button type="button" class="pfd-ref-field pfd-layout-item${selected}${grouped}" data-object-id="${frappe.utils.escape_html(
			item.id
		)}" title="${__("Select and highlight on the page")}">
			<span class="pfd-ref-name">${frappe.utils.escape_html(item.label)}</span>
			<span class="pfd-ref-meta">${frappe.utils.escape_html(item.meta)}</span>
		</button>`;
	}

	function renderLayout() {
		const groups = layoutGroups();
		if (!groups.length) {
			return `<div class="pfd-help-text">${
				filterQuery() ? __("No matching objects.") : __("Nothing on this page yet.")
			}</div>`;
		}
		const q = filterQuery();
		return groups
			.map((group) => {
				const key = `layout:${group.key}`;
				const containsSelected = group.items.some((item) => item.id === state.selectedId);
				return renderGroup({
					key,
					label: group.label,
					count: group.items.length,
					open: !!q || containsSelected || !!state.expandedGroups[key],
					attrs: `data-layout-group="${frappe.utils.escape_html(group.key)}"`,
					body: group.items.map(renderLayoutItem).join(""),
				});
			})
			.join("");
	}

	function renderReferencePanel() {
		const view = state.refView || "fields";
		return `<select class="pfd-ref-view" aria-label="${__("Sidebar view")}">
			<option value="fields" ${view === "fields" ? "selected" : ""}>${__("Fields")}</option>
			<option value="child" ${view === "child" ? "selected" : ""}>${__("Child Tables")}</option>
			<option value="layout" ${view === "layout" ? "selected" : ""}>${__("Layout")}</option>
		</select>
		<input type="text" class="pfd-field-filter" placeholder="${__("Search…")}" value="${frappe.utils.escape_html(
			state.fieldFilter || ""
		)}" />
		<div class="pfd-ref-body">${renderRefBody()}</div>`;
	}

	function renderRefBody() {
		if (state.refView === "child") return renderChildTables();
		if (state.refView === "layout") return renderLayout();
		return renderReferenceFields();
	}

	function renderReferenceFields() {
		const fields = filteredReferenceFields();
		if (!state.reference_doctype) {
			return `<div class="pfd-help-text">${__("No reference DocType configured.")}</div>`;
		}
		if (!fields.length) {
			return `<div class="pfd-help-text">${__("No matching fields.")}</div>`;
		}
		return fields
			.map(
				(field) => `
			<div
				class="pfd-ref-field"
				draggable="true"
				data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
				data-fieldtype="${frappe.utils.escape_html(field.fieldtype)}"
				title="${__("Click or drag to map")}
			">
				<span class="pfd-ref-name">${frappe.utils.escape_html(field.label || field.fieldname)}</span>
				<span class="pfd-ref-meta">${frappe.utils.escape_html(field.fieldname)} · ${frappe.utils.escape_html(
					field.fieldtype
				)}</span>
			</div>
		`
			)
			.join("");
	}

	function renderFieldOverlay(field) {
		const selected = currentSelection().includes(field.id) ? " pfd-selected" : "";
		const grouped = multiSelect()?.cleanGroupId(field.group_id) ? " pfd-grouped" : "";
		const repeatClass = field.repeat_table ? " pfd-field-overlay--repeat" : "";
		const left = ptToPx(field.x);
		const top = ptToPx(field.y);
		const width = ptToPx(field.width);
		const height = ptToPx(field.height);
		const sample = state.sampleValues && state.sampleValues[field.field_name];
		const label = frappe.utils.escape_html(sample || field.field_name);
		const typeLabel = frappe.utils.escape_html(field.field_type);
		const mapLabel = field.repeat_table
			? frappe.utils.escape_html(
					`${field.repeat_table}[${Number(field.repeat_slot || 0)}].${
						field.repeat_field || field.source_field || ""
					}`
			  )
			: field.source_field
				? frappe.utils.escape_html(field.source_field)
				: __("Unmapped");

		const specialClass =
			field.field_type === "Barcode" || field.field_type === "QR Code"
				? " pfd-field-overlay--barcode"
				: field.field_type === "Image" || field.field_type === "Signature"
					? " pfd-field-overlay--image"
					: "";
		const previewHtml =
			field.field_type === "Barcode"
				? `<svg class="pfd-barcode-preview" data-barcode-value="${frappe.utils.escape_html(
						field.default_value || field.source_field || "1234567890"
				  )}"></svg>`
				: field.field_type === "Image"
					? renderImagePreview(field)
					: "";

		const labelStyle = NO_TEXT_STYLE.includes(field.field_type)
			? ""
			: ` style="${textPreviewCss(field)}"`;
		return `
			<div
				class="pfd-field-overlay${selected}${grouped}${specialClass}${repeatClass}"
				data-field-id="${field.id}"
				style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;"
			>
				${previewHtml}
				<span class="pfd-field-label"${labelStyle}>${label}</span>
				<span class="pfd-field-meta">${typeLabel} · ${mapLabel}</span>
				<div class="pfd-resize-handle" data-resize="1"></div>
			</div>
		`;
	}

	function renderImagePreview(field) {
		const src = (field.default_value || "").trim();
		if (src) {
			return `<img class="pfd-image-preview" src="${frappe.utils.escape_html(
				src
			)}" alt="" draggable="false" />`;
		}
		return `<div class="pfd-image-placeholder">${frappe.utils.icon("image", "md")}</div>`;
	}

	function renderCanvas() {
		const page = getCurrentPage();
		if (!page) {
			return `<div class="pfd-loading">${__("No PDF pages found")}</div>`;
		}

		state.scale = getScale();
		const fieldsHtml = getPageFields(state.currentPage).map(renderFieldOverlay).join("");
		const pageRole = getPageRole(state.currentPage);
		const roleOptions = PAGE_ROLES.map(
			(role) =>
				`<option value="${role}" ${role === pageRole ? "selected" : ""}>${__(role)}</option>`
		).join("");

		return `
			<div class="pfd-page-nav">
				<button type="button" class="btn btn-default btn-sm pfd-prev-page" ${
					state.currentPage <= 0 ? "disabled" : ""
				}>${__("Previous")}</button>
				<span>${__("Page {0} of {1}", [state.currentPage + 1, state.pages.length])}</span>
				<button type="button" class="btn btn-default btn-sm pfd-next-page" ${
					state.currentPage >= state.pages.length - 1 ? "disabled" : ""
				}>${__("Next")}</button>
				<label class="pfd-page-role-label">${__("Role")}
					<select class="pfd-page-role">${roleOptions}</select>
				</label>
			</div>
			<div class="pfd-canvas-wrap" style="width:100%;max-width:${page.width_pt * 1.2}px;">
				<img class="pfd-canvas-image" src="${page.image_data_uri}" alt="${__(
					"PDF page"
				)} ${state.currentPage + 1}" draggable="false" />
				<div class="pfd-canvas-overlay">${fieldsHtml}${renderSelectionBox()}</div>
			</div>
		`;
	}

	function renderSelectOptions(options, selected) {
		return options
			.map(
				(value) =>
					`<option value="${frappe.utils.escape_html(value)}" ${
						value === selected ? "selected" : ""
					}>${frappe.utils.escape_html(value || __("Default"))}</option>`
			)
			.join("");
	}

	function renderProperties() {
		const field = getSelectedField();
		if (!field) {
			return `${renderSelectionActions()}<div class="pfd-empty-props">${__(
				"Select a field to edit layout and mapping"
			)}</div>`;
		}

		const showFont = !["Check", "Select", "Barcode", "QR Code", "Image", "Signature"].includes(
			field.field_type
		);
		const showDateFormat = field.field_type === "Date" || field.date_format;
		const showOptions = field.field_type === "Select";
		const showSourceField = field.source_type !== "Jinja Script";
		const showJinjaScript = field.source_type === "Jinja Script";

		return `
			${renderSelectionActions()}
			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Layout")}</div>
				<div class="pfd-form-group">
					<label>${__("Field Name")}</label>
					<input type="text" class="pfd-prop-name" value="${frappe.utils.escape_html(field.field_name)}" />
				</div>
				<div class="pfd-form-group">
					<label>${__("Field Type")}</label>
					<select class="pfd-prop-type">
						${renderSelectOptions(
							FIELD_TYPES.map((item) => item.type),
							field.field_type
						)}
					</select>
				</div>
				${showFont ? renderTextStyleControls(field) : ""}
				<div class="pfd-form-row">
					<div class="pfd-form-group">
						<label>${__("Width (pt)")}</label>
						<input type="number" class="pfd-prop-width" min="${MIN_WIDTH_PT}" value="${round(field.width)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Height (pt)")}</label>
						<input type="number" class="pfd-prop-height" min="${MIN_HEIGHT_PT}" value="${round(field.height)}" />
					</div>
				</div>
				<div class="pfd-form-row">
					<div class="pfd-form-group">
						<label>${__("X (pt)")}</label>
						<input type="number" class="pfd-prop-x" min="0" value="${round(field.x)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Y (pt)")}</label>
						<input type="number" class="pfd-prop-y" min="0" value="${round(field.y)}" />
					</div>
				</div>
			</div>

			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Mapping")}</div>
				<div class="pfd-form-group">
					<label>${__("Source Type")}</label>
					<select class="pfd-prop-source-type">
						${renderSelectOptions(state.source_types, field.source_type || "Field Path")}
					</select>
				</div>
				${
					showSourceField
						? `<div class="pfd-form-group">
							<label>${__("Source Field")}</label>
							<textarea class="pfd-prop-source-field" rows="2">${frappe.utils.escape_html(
								field.source_field || ""
							)}</textarea>
						</div>`
						: ""
				}
				${
					showJinjaScript
						? `<div class="pfd-form-group">
							<label>${__("Jinja Script")}</label>
							<textarea class="pfd-prop-jinja-script" rows="4">${frappe.utils.escape_html(
								field.jinja_script || ""
							)}</textarea>
						</div>`
						: ""
				}
				<div class="pfd-form-group">
					<label>${__("Default Value")}</label>
					<input type="text" class="pfd-prop-default-value" value="${frappe.utils.escape_html(
						field.default_value || ""
					)}" />
				</div>
				${
					showDateFormat
						? `<div class="pfd-form-group">
							<label>${__("Date Format")}</label>
							<select class="pfd-prop-date-format">
								${renderSelectOptions(state.date_formats, field.date_format || "")}
							</select>
						</div>`
						: ""
				}
				${
					showOptions
						? `<div class="pfd-form-group">
							<label>${__("Select Options")}</label>
							<textarea class="pfd-prop-options" rows="3" placeholder="${__(
								"One option per line"
							)}">${frappe.utils.escape_html(field.options || "")}</textarea>
						</div>`
						: ""
				}
				<div class="pfd-form-group pfd-checkbox-group">
					<label>
						<input type="checkbox" class="pfd-prop-editable" ${field.editable ? "checked" : ""} />
						${__("Editable in preview")}
					</label>
				</div>
			</div>

			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Repeating row")}</div>
				<div class="pfd-form-group">
					<label>${__("Child Table")}</label>
					<select class="pfd-prop-repeat-table">
						<option value="">${__("None")}</option>
						${(state.child_tables || [])
							.map(
								(table) =>
									`<option value="${frappe.utils.escape_html(table.fieldname)}" ${
										table.fieldname === (field.repeat_table || "") ? "selected" : ""
									}>${frappe.utils.escape_html(table.label || table.fieldname)}</option>`
							)
							.join("")}
					</select>
				</div>
				${
					field.repeat_table
						? `<div class="pfd-form-group">
							<label>${__("Child Field")}</label>
							<select class="pfd-prop-repeat-field">
								<option value="">${__("Select field")}</option>
								${((state.child_tables.find((table) => table.fieldname === field.repeat_table) || {}).fields || [])
									.map(
										(col) =>
											`<option value="${frappe.utils.escape_html(col.fieldname)}" ${
												col.fieldname === (field.repeat_field || field.source_field || "")
													? "selected"
													: ""
											}>${frappe.utils.escape_html(col.label || col.fieldname)}</option>`
									)
									.join("")}
							</select>
						</div>
						<div class="pfd-form-group">
							<label>${__("Rows on this page")}</label>
							<input type="number" class="pfd-prop-repeat-rows" min="1" max="80" value="${
								currentRepeatSlotCount(field.repeat_table, field.page) || 1
							}" />
						</div>
						<button type="button" class="btn btn-default btn-sm pfd-tile-rows">${__("Tile rows")}</button>
						<div class="pfd-help-text">${__("Slot {0} is this field’s row on the page.", [
							Number(field.repeat_slot || 0) + 1,
						])}</div>`
						: `<div class="pfd-help-text">${__(
								"Map a child table to print line items. Tile extra slots on this page; Loop clones the page when they overflow."
						  )}</div>`
				}
			</div>

			<button type="button" class="btn btn-danger btn-sm pfd-delete-field">${__("Delete Field")}</button>
		`;
	}

	function render() {
		const app = getAppEl();
		if (!app) return;

		app.innerHTML = `
			<div class="pfd-toolbar">
				<div class="pfd-toolbar-title">${frappe.utils.escape_html(state.title || __("PDF Field Designer"))}</div>
				<div class="pfd-toolbar-subtitle">${frappe.utils.escape_html(state.reference_doctype || "")}</div>
				<div class="pfd-toolbar-actions">
					<button type="button" class="btn btn-default btn-sm pfd-ai-btn${
						aiEnabled ? "" : " hidden"
					}" title="${__("AI field mapping assistant")}">
						${frappe.utils.icon("magic", "xs")}
						${__("AI Assist")}
					</button>
					<button type="button" class="btn btn-default btn-sm pfd-sample-btn">${
						state.sampleDoc ? __("Clear sample") : __("Sample")
					}</button>
					<button type="button" class="btn btn-default btn-sm pfd-preview-btn">${__("Preview")}</button>
					<button type="button" class="btn btn-default btn-sm pfd-cancel-btn">${__("Back")}</button>
					<button type="button" class="btn btn-primary btn-sm pfd-save-btn">${__("Save Design")}</button>
				</div>
			</div>
			<div class="pfd-main">
				<div class="pfd-left">
					${renderCollapsibleSection("fieldTypes", __("Field Types"), renderPalette())}
					${renderCollapsibleSection("referenceFields", __("Reference Fields"), renderReferencePanel())}
				</div>
				<div class="pfd-center pfd-canvas-container">${renderCanvas()}</div>
				<div class="pfd-right">
					<label class="pfd-always-last">
						<input type="checkbox" class="pfd-always-print-last" ${
							state.always_print_last ? "checked" : ""
						} />
						${__("Always print Last page")}
					</label>
					<div class="pfd-panel-title">${__("Properties")}</div>
					<div class="pfd-properties">${renderProperties()}</div>
				</div>
			</div>
		`;

		bindEvents(app);
		renderBarcodePreviews(app);
	}

	function renderCanvasContainer() {
		const container = document.querySelector(".pfd-canvas-container");
		if (!container) return;
		container.innerHTML = renderCanvas();
		bindCanvasEvents(container);
		renderBarcodePreviews(container);
		syncLayoutSelection();
		if (highlightHover) highlightIds(idsForHoverElement(highlightHover));
	}

	function renderBarcodePreviews(root = document) {
		const previews = root.querySelectorAll(".pfd-barcode-preview");
		if (!previews.length) return;

		const render = () => {
			previews.forEach((svg) => {
				const value = (svg.dataset.barcodeValue || "").trim() || "1234567890";
				try {
					JsBarcode(svg, value, {
						format: "CODE128",
						displayValue: false,
						margin: 0,
						height: 32,
					});
				} catch (err) {
					// ignore invalid preview values
				}
			});
		};

		if (typeof JsBarcode !== "undefined") {
			render();
			return;
		}

		frappe.require("/assets/frappe/js/lib/JsBarcode.all.min.js", render);
	}

	let highlightHover = null;

	function refreshRefBody() {
		const body = document.querySelector(".pfd-ref-body");
		if (!body) return;
		highlightHover = null;
		highlightIds([]);
		body.innerHTML = renderRefBody();
		bindRefBodyEvents(body);
	}

	function currentPageObjects() {
		return getPageFields(state.currentPage);
	}

	function idsForSourceField(fieldname) {
		return currentPageObjects()
			.filter((field) => !field.repeat_table && field.source_field === fieldname)
			.map((field) => field.id);
	}

	function idsForChild(table, fieldname) {
		return currentPageObjects()
			.filter((field) => {
				if (field.repeat_table !== table) return false;
				if (!fieldname) return true;
				return field.repeat_field === fieldname || field.source_field === fieldname;
			})
			.map((field) => field.id);
	}

	function hoverTarget(node) {
		if (!node || !node.closest) return null;
		return (
			node.closest(".pfd-layout-item") ||
			node.closest(".pfd-child-field") ||
			node.closest(".pfd-ref-field") ||
			node.closest(".pfd-child-table-toggle")
		);
	}

	function idsForHoverElement(el) {
		if (!el) return [];
		if (el.classList.contains("pfd-layout-item")) return groupMembers(el.dataset.objectId);
		if (el.classList.contains("pfd-child-table-toggle")) {
			const section = el.closest(".pfd-child-table");
			if (!section) return [];
			if (section.dataset.layoutGroup) {
				return [...section.querySelectorAll(".pfd-layout-item")].map((item) => item.dataset.objectId);
			}
			if (section.dataset.table) return idsForChild(section.dataset.table);
			return [];
		}
		if (el.classList.contains("pfd-child-field")) {
			return idsForChild(el.dataset.table, el.dataset.fieldname);
		}
		if (el.classList.contains("pfd-ref-field")) return idsForSourceField(el.dataset.fieldname);
		return [];
	}

	function findDeskObject(id) {
		if (!id) return null;
		const escaped = window.CSS && CSS.escape ? CSS.escape(id) : id;
		return document.querySelector(
			`.pfd-canvas-container [data-field-id="${escaped}"], .pfd-canvas-container [data-element-id="${escaped}"]`
		);
	}

	function revealOnDesk(el) {
		const scroller = el.closest(".ppd-canvas-scroll, .pfd-center");
		if (!scroller) return;
		const elRect = el.getBoundingClientRect();
		const scRect = scroller.getBoundingClientRect();
		const pad = 24;
		if (elRect.top < scRect.top + pad) scroller.scrollTop -= scRect.top + pad - elRect.top;
		else if (elRect.bottom > scRect.bottom - pad) scroller.scrollTop += elRect.bottom - (scRect.bottom - pad);
		if (elRect.left < scRect.left + pad) scroller.scrollLeft -= scRect.left + pad - elRect.left;
		else if (elRect.right > scRect.right - pad) scroller.scrollLeft += elRect.right - (scRect.right - pad);
	}

	function highlightIds(ids) {
		const set = new Set(ids || []);
		let first = null;
		document
			.querySelectorAll(".pfd-canvas-container .pfd-field-overlay, .pfd-canvas-container .ppd-element")
			.forEach((el) => {
				const id = el.dataset.fieldId || el.dataset.elementId;
				const on = !!id && set.has(id);
				el.classList.toggle("pfd-highlighted", on);
				if (!on) return;
				if (!first || el.getBoundingClientRect().top < first.getBoundingClientRect().top) first = el;
			});
		if (first) revealOnDesk(first);
	}

	function syncLayoutSelection() {
		const selected = new Set(currentSelection());
		document.querySelectorAll(".pfd-layout-item").forEach((item) => {
			const on = selected.has(item.dataset.objectId);
			item.classList.toggle("pfd-layout-item--selected", on);
			if (!on || item.dataset.objectId !== state.selectedId) return;
			const section = item.closest(".pfd-child-table");
			if (section && !section.classList.contains("pfd-child-table--open")) {
				section.classList.add("pfd-child-table--open");
				if (section.dataset.group) state.expandedGroups[section.dataset.group] = true;
				section.querySelector(".pfd-child-table-toggle")?.setAttribute("aria-expanded", "true");
				item.scrollIntoView({ block: "nearest" });
			}
		});
	}

	function selectObject(id) {
		if (!id) return;
		commitSelection(groupMembers(id), id);
		state.selectionAnchor = id;
		renderCanvasContainer();
		renderPropertiesPanel();
		highlightIds(currentSelection());
	}

	function renderPropertiesPanel() {
		const panel = document.querySelector(".pfd-properties");
		if (!panel) return;
		panel.innerHTML = renderProperties();
		bindPropertyEvents(panel);
	}

	function bindRefBodyEvents(body) {
		if (!body) return;
		body.querySelectorAll(".pfd-child-table-toggle").forEach((btn) => {
			btn.addEventListener("click", () => {
				const section = btn.closest(".pfd-child-table");
				if (!section) return;
				const key = section.dataset.group;
				const open = !state.expandedGroups[key];
				state.expandedGroups[key] = open;
				section.classList.toggle("pfd-child-table--open", open);
				btn.setAttribute("aria-expanded", open ? "true" : "false");
			});
		});
		body.querySelectorAll(".pfd-child-field").forEach((item) => {
			item.addEventListener("click", () => {
				const table = (state.child_tables || []).find((row) => row.fieldname === item.dataset.table);
				if (!table) return;
				mapChildField(table, {
					fieldname: item.dataset.fieldname,
					fieldtype: item.dataset.fieldtype,
				});
			});
		});
		body.querySelectorAll(".pfd-ref-field:not(.pfd-child-field):not(.pfd-layout-item)").forEach((item) => {
			item.addEventListener("click", () => {
				mapReferenceField({
					fieldname: item.dataset.fieldname,
					fieldtype: item.dataset.fieldtype,
				});
			});
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData(
					"text/pfd-ref-field",
					JSON.stringify({
						fieldname: item.dataset.fieldname,
						fieldtype: item.dataset.fieldtype,
					})
				);
				e.dataTransfer.effectAllowed = "copy";
			});
		});
		body.querySelectorAll(".pfd-layout-item").forEach((item) => {
			item.addEventListener("click", (e) => {
				selectWithPointer(item.dataset.objectId, e, true);
				renderCanvasContainer();
				renderPropertiesPanel();
				highlightIds(currentSelection());
			});
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				selectForClipboard(item.dataset.objectId, true);
				openClipboardMenu(e.clientX, e.clientY);
			});
		});
		body.addEventListener("mouseover", (e) => {
			const el = hoverTarget(e.target);
			if (!el || el === highlightHover) return;
			highlightHover = el;
			highlightIds(idsForHoverElement(el));
		});
		body.addEventListener("mouseleave", () => {
			highlightHover = null;
			highlightIds([]);
		});
	}

	function bindEvents(app) {
		app.querySelector(".pfd-ai-btn")?.addEventListener("click", openAIAssist);
		app.querySelector(".pfd-sample-btn")?.addEventListener("click", loadSampleDocument);
		app.querySelector(".pfd-save-btn")?.addEventListener("click", saveDesign);
		app.querySelector(".pfd-preview-btn")?.addEventListener("click", previewWithDocument);
		app.querySelector(".pfd-cancel-btn")?.addEventListener("click", () => {
			if (state.dirty && !confirm(__("Discard unsaved changes?"))) return;
			frappe.set_route("Form", "PDF Form Template", state.templateName);
		});

		app.querySelectorAll(".pfd-palette-item").forEach((item) => {
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData("text/pfd-field-type", item.dataset.type);
				e.dataTransfer.effectAllowed = "copy";
			});
		});

		app.querySelectorAll(".pfd-panel-toggle").forEach((btn) => {
			btn.addEventListener("click", () => {
				const section = btn.closest(".pfd-collapsible-section");
				if (!section) return;
				const sectionId = section.dataset.section;
				section.classList.toggle("pfd-collapsible-section--collapsed");
				state.collapsedSections[sectionId] = section.classList.contains(
					"pfd-collapsible-section--collapsed"
				);
				btn.setAttribute("aria-expanded", !state.collapsedSections[sectionId]);
			});
		});

		app.querySelector(".pfd-ref-view")?.addEventListener("change", (e) => {
			state.refView = e.target.value;
			refreshRefBody();
		});
		app.querySelector(".pfd-field-filter")?.addEventListener("input", (e) => {
			state.fieldFilter = e.target.value;
			refreshRefBody();
		});
		bindRefBodyEvents(app.querySelector(".pfd-ref-body"));
		bindCanvasEvents(app.querySelector(".pfd-canvas-container"));
		bindPropertyEvents(app.querySelector(".pfd-properties"));

		app.querySelector(".pfd-always-print-last")?.addEventListener("change", (e) => {
			pushUndo("always-print-last");
			state.always_print_last = e.target.checked ? 1 : 0;
			markDirty();
		});
	}

	function bindCanvasEvents(container) {
		if (!container) return;

		container.querySelector(".pfd-prev-page")?.addEventListener("click", () => {
			if (state.currentPage > 0) {
				state.currentPage -= 1;
				clearSelection();
				renderCanvasContainer();
				renderPropertiesPanel();
				if (state.refView === "layout") refreshRefBody();
			}
		});

		container.querySelector(".pfd-next-page")?.addEventListener("click", () => {
			if (state.currentPage < state.pages.length - 1) {
				state.currentPage += 1;
				clearSelection();
				renderCanvasContainer();
				renderPropertiesPanel();
				if (state.refView === "layout") refreshRefBody();
			}
		});

		container.querySelector(".pfd-page-role")?.addEventListener("change", (e) => {
			setPageRole(state.currentPage, e.target.value);
		});

		const overlay = container.querySelector(".pfd-canvas-overlay");
		if (!overlay) return;

		overlay.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			overlay.classList.add("pfd-drop-over");
		});

		overlay.addEventListener("dragleave", () => {
			overlay.classList.remove("pfd-drop-over");
		});

		overlay.addEventListener("drop", (e) => {
			e.preventDefault();
			overlay.classList.remove("pfd-drop-over");
			const rect = overlay.getBoundingClientRect();
			const x = pxToPt(e.clientX - rect.left);
			const y = pxToPt(e.clientY - rect.top);

			const refPayload = e.dataTransfer.getData("text/pfd-ref-field");
			if (refPayload) {
				try {
					mapReferenceField(JSON.parse(refPayload));
				} catch (err) {
					// ignore invalid payload
				}
				return;
			}

			const type = e.dataTransfer.getData("text/pfd-field-type");
			if (type) addField(type, x, y);
		});

		overlay.addEventListener("mousedown", onOverlayMouseDown);
		overlay.addEventListener("contextmenu", (e) => {
			if (e.target.closest("button, input, select, textarea")) return;
			e.preventDefault();
			const fieldEl = e.target.closest(".pfd-field-overlay");
			if (fieldEl) selectForClipboard(fieldEl.dataset.fieldId, false);
			openClipboardMenu(e.clientX, e.clientY);
		});
		overlay.addEventListener("click", (e) => {
			if (skipOverlayClick) {
				skipOverlayClick = false;
				return;
			}
			if (e.target === overlay) {
				clearSelection();
				renderPropertiesPanel();
				renderCanvasContainer();
			}
		});
	}

	function bindPropertyEvents(panel) {
		if (!panel) return;

		panel.querySelector(".pfd-prop-name")?.addEventListener("input", (e) => {
			updateSelectedField({ field_name: e.target.value }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-type")?.addEventListener("change", (e) => {
			const spec = FIELD_TYPES.find((item) => item.type === e.target.value);
			const updates = { field_type: e.target.value };
			if (spec && e.target.value === "Date") updates.date_format = spec.date_format || "%d-%m-%Y";
			if (spec && e.target.value === "Select" && !getSelectedField()?.options) {
				updates.options = spec.options || "";
			}
			updateSelectedField(updates, { refreshCanvas: true, refreshProperties: true });
		});

		bindTextStyleEvents(panel, updateSelectedField);

		panel.querySelector(".pfd-prop-width")?.addEventListener("change", (e) => {
			updateSelectedField(
				{ width: Math.max(MIN_WIDTH_PT, parseFloat(e.target.value) || MIN_WIDTH_PT) },
				{ refreshCanvas: true }
			);
		});

		panel.querySelector(".pfd-prop-height")?.addEventListener("change", (e) => {
			updateSelectedField(
				{ height: Math.max(MIN_HEIGHT_PT, parseFloat(e.target.value) || MIN_HEIGHT_PT) },
				{ refreshCanvas: true }
			);
		});

		panel.querySelector(".pfd-prop-x")?.addEventListener("change", (e) => {
			updateSelectedField({ x: Math.max(0, parseFloat(e.target.value) || 0) }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-y")?.addEventListener("change", (e) => {
			updateSelectedField({ y: Math.max(0, parseFloat(e.target.value) || 0) }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-source-type")?.addEventListener("change", (e) => {
			updateSelectedField({ source_type: e.target.value }, { refreshProperties: true });
		});

		panel.querySelector(".pfd-prop-source-field")?.addEventListener("input", (e) => {
			updateSelectedField({ source_field: e.target.value }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-jinja-script")?.addEventListener("input", (e) => {
			updateSelectedField({ jinja_script: e.target.value });
		});

		panel.querySelector(".pfd-prop-default-value")?.addEventListener("input", (e) => {
			updateSelectedField({ default_value: e.target.value }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-date-format")?.addEventListener("change", (e) => {
			updateSelectedField({ date_format: e.target.value });
		});

		panel.querySelector(".pfd-prop-options")?.addEventListener("input", (e) => {
			updateSelectedField({ options: e.target.value });
		});

		panel.querySelector(".pfd-prop-editable")?.addEventListener("change", (e) => {
			updateSelectedField({ editable: e.target.checked ? 1 : 0 });
		});

		panel.querySelector(".pfd-prop-repeat-table")?.addEventListener("change", (e) => {
			const table = e.target.value;
			updateSelectedField(
				{
					repeat_table: table,
					repeat_field: table ? getSelectedField()?.repeat_field || "" : "",
					repeat_slot: table ? Number(getSelectedField()?.repeat_slot || 0) : 0,
				},
				{ refreshCanvas: true, refreshProperties: true }
			);
		});

		panel.querySelector(".pfd-prop-repeat-field")?.addEventListener("change", (e) => {
			updateSelectedField(
				{
					repeat_field: e.target.value,
					source_field: e.target.value || getSelectedField()?.source_field || "",
				},
				{ refreshCanvas: true }
			);
		});

		panel.querySelector(".pfd-tile-rows")?.addEventListener("click", () => {
			const input = panel.querySelector(".pfd-prop-repeat-rows");
			tileRepeatRows(input ? input.value : 1);
		});

		panel.querySelector(".pfd-delete-field")?.addEventListener("click", deleteSelectedField);
		panel.querySelector(".pfd-group-btn")?.addEventListener("click", groupSelection);
		panel.querySelector(".pfd-ungroup-btn")?.addEventListener("click", ungroupSelection);
		panel.querySelector(".pfd-copy-btn")?.addEventListener("click", copySelection);
		panel.querySelector(".pfd-paste-btn")?.addEventListener("click", pasteClipboard);
	}

	function startMarquee(overlay, e) {
		const rect = overlay.getBoundingClientRect();
		const originX = e.clientX;
		const originY = e.clientY;
		const box = document.createElement("div");
		box.className = "pfd-marquee";
		overlay.appendChild(box);
		let moved = false;

		function onMove(ev) {
			const width = Math.abs(ev.clientX - originX);
			const height = Math.abs(ev.clientY - originY);
			box.style.left = `${Math.min(originX, ev.clientX) - rect.left}px`;
			box.style.top = `${Math.min(originY, ev.clientY) - rect.top}px`;
			box.style.width = `${width}px`;
			box.style.height = `${height}px`;
			if (width > 3 || height > 3) moved = true;
		}

		function onUp(ev) {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			box.remove();
			if (!moved) {
				clearSelection();
				renderPropertiesPanel();
				renderCanvasContainer();
				return;
			}
			skipOverlayClick = true;
			const api = multiSelect();
			const marquee = {
				x: pxToPt(Math.min(originX, ev.clientX) - rect.left),
				y: pxToPt(Math.min(originY, ev.clientY) - rect.top),
				width: pxToPt(Math.abs(ev.clientX - originX)),
				height: pxToPt(Math.abs(ev.clientY - originY)),
			};
			const hit = api
				? getPageFields(state.currentPage)
						.filter((field) => api.intersects(api.bounds(field), marquee))
						.map((field) => field.id)
				: [];
			const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
			const ids = additive ? currentSelection().concat(hit) : hit;
			commitSelection(ids, ids[ids.length - 1]);
			state.selectionAnchor = ids[0] || null;
			renderCanvasContainer();
			renderPropertiesPanel();
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}

	function onOverlayMouseDown(e) {
		if (e.button !== 0) return;
		const boxEl = e.target.closest("[data-selection-box]");
		const fieldEl = e.target.closest(".pfd-field-overlay");
		if (!fieldEl && !boxEl) {
			if (e.target.closest("button, input, select, textarea")) return;
			startMarquee(e.currentTarget, e);
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		const field = fieldEl
			? state.fields.find((item) => item.id === fieldEl.dataset.fieldId)
			: getSelectedField();
		if (!field) return;
		if (fieldEl) selectWithPointer(field.id, e, false);

		const selected = selectedObjects();
		const isResize = Boolean(fieldEl && e.target.dataset.resize === "1" && selected.length <= 1);
		const movers = isResize ? [field] : selected;
		dragState = {
			field,
			isResize,
			startX: e.clientX,
			startY: e.clientY,
			startField: { ...field },
			starts: movers.map((item) => ({
				id: item.id,
				x: item.x,
				y: item.y,
				width: item.width,
				height: item.height,
			})),
			historyPushed: false,
		};
		renderPropertiesPanel();
		renderCanvasContainer();

		document.addEventListener("mousemove", onDocumentMouseMove);
		document.addEventListener("mouseup", onDocumentMouseUp);

		function onDocumentMouseMove(moveEvent) {
			if (!dragState) return;
			const dx = pxToPt(moveEvent.clientX - dragState.startX);
			const dy = pxToPt(moveEvent.clientY - dragState.startY);
			const page = getCurrentPage();
			if (!page) return;
			if (!dx && !dy) return;

			if (dragState.isResize) {
				const width = Math.max(MIN_WIDTH_PT, dragState.startField.width + dx);
				const height = Math.max(MIN_HEIGHT_PT, dragState.startField.height + dy);
				const maxWidth = page.width_pt - dragState.startField.x;
				const maxHeight = page.height_pt - dragState.startField.y;
				const next = {
					x: dragState.startField.x,
					y: dragState.startField.y,
					width: Math.min(width, maxWidth),
					height: Math.min(height, maxHeight),
				};
				if (resizeOverlaps(next, dragState.startField, dragState.field.id)) return;
				if (!dragState.historyPushed) {
					pushUndo(`resize:${dragState.field.id}`);
					dragState.historyPushed = true;
				}
				dragState.field.width = next.width;
				dragState.field.height = next.height;
			} else {
				const before = dragState.starts.map((item) => {
					const current = state.fields.find((field) => field.id === item.id);
					return current ? { id: current.id, x: current.x, y: current.y } : null;
				});
				const fitted = applyObjectMove(dragState.starts, dx, dy);
				if (!fitted.dx && !fitted.dy) return;
				if (!dragState.historyPushed) {
					before.forEach((item) => {
						const current = item && state.fields.find((field) => field.id === item.id);
						if (current) {
							current.x = item.x;
							current.y = item.y;
						}
					});
					pushUndo("move-selection");
					dragState.historyPushed = true;
					applyObjectMove(dragState.starts, dx, dy);
				}
			}

			markDirty();
			renderCanvasContainer();
		}

		function onDocumentMouseUp() {
			document.removeEventListener("mousemove", onDocumentMouseMove);
			document.removeEventListener("mouseup", onDocumentMouseUp);
			if (dragState && dragState.historyPushed) skipOverlayClick = true;
			dragState = null;
		}
	}

	function onKeyDown(e) {
		if (!isDesignerActive()) return;
		if (isTypingTarget(e.target)) return;

		const key = (e.key || "").toLowerCase();
		const modifier = e.ctrlKey || e.metaKey;
		if (modifier && key === "z") {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
			return;
		}
		if (modifier && key === "y") {
			e.preventDefault();
			redo();
			return;
		}
		if (modifier && key === "g") {
			e.preventDefault();
			if (e.shiftKey) ungroupSelection();
			else groupSelection();
			return;
		}
		if (modifier && key === "c") {
			e.preventDefault();
			copySelection();
			return;
		}
		if (modifier && key === "v") {
			e.preventDefault();
			pasteClipboard();
			return;
		}
		if (!currentSelection().length) return;
		if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			const step = e.shiftKey ? 10 : 1;
			nudgeSelection(
				e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
				e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
			);
			return;
		}
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			deleteSelectedField();
		}
	}

	function refresh() {
		const app = getAppEl();
		if (!app) return;

		const templateName = getTemplateName();
		if (!templateName) {
			showMessage(__("Open a PDF Form Template and click Design Fields."));
			return;
		}

		if (state.templateName === templateName && state.pages.length) {
			state.scale = getScale();
			render();
			return;
		}

		showMessage(__("Loading designer…"));
		loadContext(templateName);
	}

	pdffiller.designer.setup_page = function (wrapper) {
		pageInstance = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("PDF Field Designer"),
			single_column: true,
		});

		pageInstance.main
			.addClass("pdffiller-designer-page")
			.html('<div id="pdffiller-designer-app" class="pdffiller-designer-root"></div>');

		refreshAIStatus();
		refresh();
	};

	pdffiller.designer.refresh = refresh;

	document.addEventListener("keydown", onKeyDown);

	window.addEventListener("beforeunload", (e) => {
		if (state.dirty) e.preventDefault();
	});
})();
